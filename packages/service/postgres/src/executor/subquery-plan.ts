import type { Expr, SelectStmt } from "../ast/nodes.ts";
import { isAggregateName } from "../functions/aggregates.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { currentUserName, sessionUserName } from "../storage/roles.ts";
import type { Datum, TypedValue, TypeId } from "../types/value.ts";
import { type Relation, RowScope } from "./relation.ts";

/**
 * Per-statement memo for subqueries and virtual catalogs (#765).
 *
 * A subquery in WHERE / SELECT / ON runs once per outer row. When it never reads the outer row
 * (and calls nothing volatile) its result is the same for every row, so it runs once. A correlated
 * EXISTS whose only link to the outer row is `inner = outer` equalities runs once without them and
 * becomes a hash probe per outer row (a hash semi / anti join). Catalog relations are built once per
 * statement for the role and search_path they were built under.
 *
 * The memo lives on the ExecEnv of one executed statement: every statement a function, trigger or DO
 * block runs starts its own, so DDL, ROLLBACK, SET ROLE and search_path changes made by an earlier
 * statement are always seen. Within one statement the memo matches PostgreSQL's statement snapshot.
 */
export interface StatementCache {
  plans: WeakMap<Map<string, Relation>, Map<SelectStmt, SubqueryPlan>>;
  readonly catalogs: Map<string, Relation>;
  /** the row arrays of memoized catalogs, which may carry hash indexes */
  catalogRows: WeakSet<Datum[][]>;
  /** per catalog row array: `colIdx:type` → key → row positions (ascending) */
  keyIndexes: WeakMap<Datum[][], Map<string, Map<string, number[]>>>;
  /** current_user / session_user / search_path everything memoized was computed under */
  fingerprint: string | null;
  /** set once the statement calls a volatile user function: from then on nothing is memoized */
  disabled: boolean;
}

export function newStatementCache(): StatementCache {
  return {
    plans: new WeakMap(),
    catalogs: new Map(),
    catalogRows: new WeakSet(),
    keyIndexes: new WeakMap(),
    fingerprint: null,
    disabled: false,
  };
}

function resetStatementCache(cache: StatementCache): void {
  cache.plans = new WeakMap();
  cache.catalogs.clear();
  cache.catalogRows = new WeakSet();
  cache.keyIndexes = new WeakMap();
}

/**
 * The statement's memo, or null when there is none or it is switched off. A SET ROLE /
 * search_path change made mid-statement (set_config) drops everything memoized before it.
 */
export function activeStatementCache(state: DatabaseState, cache: StatementCache | undefined): StatementCache | null {
  if (!cache || cache.disabled) return null;
  const fingerprint = `${currentUserName(state)}\u0000${sessionUserName(state)}\u0000${state.getSetting("search_path") ?? ""}`;
  if (cache.fingerprint !== fingerprint) {
    if (cache.fingerprint !== null) resetStatementCache(cache);
    cache.fingerprint = fingerprint;
  }
  return cache;
}

/**
 * A volatile user function may change any table or catalog: the rest of the statement reads them
 * afresh, as it did before the memo existed.
 */
export function noteUserFunctionCall(cache: StatementCache | undefined, volatility: string | null | undefined): void {
  if (!cache || cache.disabled || volatility === "immutable" || volatility === "stable") return;
  cache.disabled = true;
  resetStatementCache(cache);
}

export interface SemiJoinPlan {
  readonly kind: "semi";
  /** outer side of each correlating equality, evaluated per outer row */
  readonly outerExprs: Expr[];
  /** inner key tuples of the rows that pass the rest of WHERE; tuples with a NULL are dropped */
  readonly keys: TypedValue[][];
  readonly innerTypes: TypeId[];
  /** inner FROM shape, for the per-signature WHERE type check */
  readonly columns: Relation["columns"];
  readonly rangeVars: Set<string>;
  /** hashed key sets per outer type signature; null = these types fall back to the nested loop */
  readonly sigs: Map<string, { types: TypeId[]; set: Set<string> } | null>;
}

export type SubqueryPlan =
  | { readonly kind: "constant"; readonly rel: Relation }
  | { readonly kind: "correlated" }
  | { readonly kind: "uncached" }
  | SemiJoinPlan;

export function plansFor(cache: StatementCache, ctes: Map<string, Relation>): Map<SelectStmt, SubqueryPlan> {
  let plans = cache.plans.get(ctes);
  if (!plans) {
    plans = new Map();
    cache.plans.set(ctes, plans);
  }
  return plans;
}

/**
 * The outer row as a subquery sees it, recording whether the subquery read it. A subquery that
 * finished without reading it computed the same thing it would for any other outer row.
 */
export class OuterAccessTracker extends RowScope {
  touched = false;
  constructor(private readonly target: RowScope | null) {
    super([], [], null, new Set());
  }
  override lookup(parts: string[]): TypedValue | undefined {
    this.touched = true;
    return this.target?.lookup(parts);
  }
  override wholeRow(rangeVar: string): TypedValue | undefined {
    this.touched = true;
    return this.target?.wholeRow(rangeVar);
  }
  override hasRangeVar(name: string): boolean {
    this.touched = true;
    return this.target?.hasRangeVar(name) ?? false;
  }
}

/** Builtins whose result or side effects differ between calls (PostgreSQL `provolatile = 'v'`). */
const VOLATILE_BUILTINS: ReadonlySet<string> = new Set([
  "random",
  "random_normal",
  "setseed",
  "gen_random_uuid",
  "uuidv4",
  "uuidv7",
  "uuid_generate_v1",
  "uuid_generate_v1mc",
  "uuid_generate_v4",
  "gen_random_bytes",
  "gen_salt",
  "array_shuffle",
  "array_sample",
  "clock_timestamp",
  "timeofday",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "set_config",
  "nextval",
  "setval",
  "currval",
  "lastval",
  "pg_notify",
  "txid_current",
  "txid_current_if_assigned",
  "pg_current_xact_id",
  "pg_current_xact_id_if_assigned",
  "pg_cancel_backend",
  "pg_terminate_backend",
  "pg_reload_conf",
  "pg_logical_emit_message",
]);

const VOLATILE_PREFIXES = ["pg_advisory", "pg_try_advisory", "lo_", "pg_stat_reset", "dblink"];

function isVolatileFunction(state: DatabaseState, name: string[]): boolean {
  const user = state.findFunctions(name);
  if (user.some((fn) => fn.volatility !== "immutable" && fn.volatility !== "stable")) return true;
  const bare = name[name.length - 1]!;
  return VOLATILE_BUILTINS.has(bare) || VOLATILE_PREFIXES.some((p) => bare.startsWith(p));
}

/**
 * Whether evaluating `node` could call a volatile function: directly, through a view it reads, or
 * a TABLESAMPLE without REPEATABLE. Conservative: anything unrecognised counts as volatile.
 */
export function mayBeVolatile(state: DatabaseState, node: unknown): boolean {
  const seen = new Set<object>();
  const walk = (n: unknown): boolean => {
    if (n === null || typeof n !== "object") return false;
    if (seen.has(n)) return false;
    seen.add(n);
    if (Array.isArray(n)) return n.some(walk);
    const o = n as Record<string, unknown>;
    // FOR UPDATE / FOR SHARE takes row locks each time it runs
    if (o.type === "select" && o.lockingClause) return true;
    if (o.type === "func" && Array.isArray(o.name) && isVolatileFunction(state, o.name as string[])) return true;
    if (o.type === "from_table" && Array.isArray(o.name)) {
      const sample = o.tablesample as { repeatable: unknown } | undefined;
      if (sample && !sample.repeatable) return true;
      let view: ReturnType<DatabaseState["findView"]> = null;
      try {
        view = state.findView(o.name as string[]);
      } catch {
        return true;
      }
      if (view && !view.materialized && walk(view.query)) return true;
    }
    for (const key in o) {
      if (walk(o[key])) return true;
    }
    return false;
  };
  return walk(node);
}

/** Catalogs whose rows change while a statement runs (counters, locks, settings, sequence state). */
const LIVE_CATALOG =
  /^pg_(stat|statio|locks|cursors|settings|sequences?$|prepared|largeobject|backend|replication|subscription|wal|archiver|bgwriter|checkpointer|io|slru|progress|file_settings|hba|ident|shmem|memory|config|timezone)/;

/** The memo key of a catalog relation, or null when it must be built afresh on every scan. */
export function catalogCacheKey(schema: string, name: string): string | null {
  if (schema === "pg_catalog" && LIVE_CATALOG.test(name)) return null;
  if (schema === "information_schema" && name === "sequences") return null;
  return `${schema}.${name}`;
}

/** Equality-comparable type families whose `=` is exactly key equality after casting both sides to the common type. */
const NUMERIC_FAMILY: ReadonlySet<TypeId> = new Set(["int2", "int4", "int8", "numeric"]);
const TEXT_FAMILY: ReadonlySet<TypeId> = new Set(["text", "varchar", "name"]);
const SAME_TYPE_HASHABLE: ReadonlySet<TypeId> = new Set(["bool", "uuid", "date", "oid"]);

export function hashableEquality(a: TypeId, b: TypeId): boolean {
  if (NUMERIC_FAMILY.has(a) && NUMERIC_FAMILY.has(b)) return true;
  if (TEXT_FAMILY.has(a) && TEXT_FAMILY.has(b)) return true;
  return a === b && SAME_TYPE_HASHABLE.has(a);
}

/** Collect column references of an expression; null when it holds anything a hash key cannot stand for. */
export function keyColumnRefs(e: Expr): string[][] | null {
  const refs: string[][] = [];
  let ok = true;
  const walk = (n: unknown): void => {
    if (!ok || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const o = n as Record<string, unknown>;
    switch (o.type) {
      case "colref":
        refs.push(o.parts as string[]);
        return;
      case "subquery_expr":
      case "array_query":
      case "collate":
      case "star":
        ok = false;
        return;
      case "in_expr":
        if (o.query) {
          ok = false;
          return;
        }
        break;
      case "func":
        // aggregates and window calls belong to an enclosing query level
        if (o.over || o.filter || isAggregateName((o.name as string[])[(o.name as string[]).length - 1]!)) {
          ok = false;
          return;
        }
        break;
    }
    for (const key in o) walk(o[key]);
  };
  walk(e);
  return ok ? refs : null;
}
