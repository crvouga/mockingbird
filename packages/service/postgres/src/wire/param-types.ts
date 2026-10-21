import type { Database } from "../api/database.ts";
import type { DeleteStmt, Expr, InsertStmt, SelectCore, SelectStmt, UpdateStmt } from "../ast/nodes.ts";
import { parse as parseSql } from "../parser/index.ts";
import type { TableData } from "../storage/database-state.ts";
import { resolveTypeName } from "../types/resolve.ts";
import { ARRAY_OIDS, arrayElemType, arrayTypeOf, isArrayType, TYPE_OIDS, type TypeId } from "../types/value.ts";

/**
 * Parameter types PostgreSQL infers for a statement parsed with `Parse` parameter OIDs left at
 * zero (what asyncpg and `psql \gdesc` send): a cast names the type, a comparison or an
 * assignment takes the other operand's or the column's, `LIMIT` / `OFFSET` are `bigint`, and
 * anything still unresolved is `text`.
 * https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY
 */

type Scope = { names: string[]; table: TableData }[];
type Types = Map<number, TypeId>;

const TEXT_OID = 25;
const COMPARISON = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "is_distinct"]);
const SAME_TYPE_ARITHMETIC = new Set(["+", "-", "*", "/", "%", "||", "&", "|", "#", "^"]);
const SAME_TYPE_OPERATORS = new Set(["@>", "<@", "&&", "@@"]);
const TEMPORAL = new Set(["date", "time", "timestamp", "timestamptz", "timetz", "interval"]);

/** The OID a parameter of this type is reported as; types without an OID of their own are `text`. */
export const paramOid = (type: TypeId): number => {
  if (isArrayType(type)) return ARRAY_OIDS[arrayElemType(type)] ?? TEXT_OID;
  const oid = TYPE_OIDS[type];
  return oid === undefined || type === "unknown" || type === "record" ? TEXT_OID : oid;
};

const isParam = (expr: unknown): expr is { type: "param"; index: number } =>
  typeof expr === "object" && expr !== null && (expr as { type?: string }).type === "param";

class Inference {
  readonly types: Types = new Map();
  highest = 0;

  constructor(private readonly db: Database) {}

  private set(expr: unknown, type: TypeId | undefined): void {
    if (!isParam(expr) || type === undefined || type === "unknown" || this.types.has(expr.index)) return;
    this.types.set(expr.index, type);
  }

  private column(scope: Scope, parts: string[]): TypeId | undefined {
    const name = parts.at(-1) as string;
    const qualifier = parts.length > 1 ? parts.at(-2) : undefined;
    for (const entry of scope) {
      if (qualifier !== undefined && !entry.names.includes(qualifier)) continue;
      const found = entry.table.columns.find((column) => column.name === name);
      if (found) return found.type.id;
    }
    return undefined;
  }

  private typeOf(expr: Expr | null | undefined, scope: Scope): TypeId | undefined {
    if (!expr) return undefined;
    switch (expr.type) {
      case "colref":
        return this.column(scope, expr.parts);
      case "cast":
        return this.castType(expr.target);
      case "param":
        return this.types.get(expr.index);
      case "bool_lit":
        return "bool";
      case "number_lit":
        return /^[0-9]+$/.test(expr.raw) ? (Number(expr.raw) > 2147483647 ? "int8" : "int4") : "numeric";
      case "collate":
        return this.typeOf(expr.expr, scope);
      case "binop":
        if (COMPARISON.has(expr.op) || expr.op === "and" || expr.op === "or") return "bool";
        return this.typeOf(expr.left, scope) ?? this.typeOf(expr.right, scope);
      default:
        return undefined;
    }
  }

  private castType(target: Parameters<typeof resolveTypeName>[1]): TypeId | undefined {
    try {
      return resolveTypeName(this.db.state, target).column.id;
    } catch {
      return undefined;
    }
  }

  private pair(left: Expr, right: Expr, scope: Scope): void {
    const l = this.typeOf(left, scope);
    const r = this.typeOf(right, scope);
    this.set(left, r);
    this.set(right, l);
  }

  private tableScope(name: string[], alias: string | null): Scope {
    const table = this.db.state.findTable(name);
    return table ? [{ names: alias ? [alias, table.name] : [table.name], table }] : [];
  }

  private fromScope(items: readonly unknown[]): Scope {
    const scope: Scope = [];
    for (const item of items) {
      const node = item as { type?: string; name?: string[]; alias?: string | null; left?: unknown; right?: unknown };
      if (node.type === "from_table" && node.name) scope.push(...this.tableScope(node.name, node.alias ?? null));
      else if (node.type === "from_join") scope.push(...this.fromScope([node.left, node.right]));
    }
    return scope;
  }

  private insert(stmt: InsertStmt, scope: Scope): void {
    const table = this.db.state.findTable(stmt.table);
    if (!table || stmt.source === "default_values") return;
    const body = stmt.source.body;
    if (body.type !== "values") return;
    const names = stmt.columns ?? table.columns.map((column) => column.name);
    for (const row of body.rows) {
      row.forEach((item, i) => {
        this.set(item, table.columns.find((column) => column.name === names[i])?.type.id);
      });
    }
    this.assign(stmt.onConflict?.action, scope);
  }

  private assign(action: unknown, scope: Scope): void {
    const sets = (action as { sets?: UpdateStmt["sets"] } | undefined)?.sets;
    for (const set of sets ?? []) {
      const column = set.columns[0];
      if (set.columns.length !== 1 || !column || column.subscripts || column.fields.length > 0) continue;
      this.set(set.value, this.column(scope, [column.name]));
    }
  }

  walk(node: unknown, scope: Scope): void {
    if (Array.isArray(node)) {
      for (const item of node) this.walk(item, scope);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const n = node as Expr | SelectCore | SelectStmt | InsertStmt | UpdateStmt | DeleteStmt;
    let inner = scope;
    switch (n.type) {
      case "param":
        this.highest = Math.max(this.highest, n.index);
        return;
      case "select_core":
        inner = [...this.fromScope(n.from), ...scope];
        break;
      case "select":
        this.set(n.limit, "int8");
        this.set(n.offset, "int8");
        break;
      case "insert":
        inner = [...this.tableScope(n.table, n.alias), ...scope];
        this.insert(n, inner);
        break;
      case "update":
        inner = [...this.tableScope(n.table, n.alias), ...this.fromScope(n.from), ...scope];
        this.assign(n, inner);
        break;
      case "delete":
        inner = [...this.tableScope(n.table, n.alias), ...this.fromScope(n.using), ...scope];
        break;
      case "cast":
        if (isParam(n.expr)) this.setCast(n.expr, n.target);
        break;
      case "binop":
        if (COMPARISON.has(n.op) || SAME_TYPE_OPERATORS.has(n.op)) this.pair(n.left, n.right, scope);
        else if (SAME_TYPE_ARITHMETIC.has(n.op)) {
          const other = isParam(n.left) ? this.typeOf(n.right, scope) : this.typeOf(n.left, scope);
          if (other !== undefined && !TEMPORAL.has(other)) this.pair(n.left, n.right, scope);
        }
        break;
      case "is_distinct":
        this.pair(n.left, n.right, scope);
        break;
      case "in_expr": {
        const left = this.typeOf(n.left, scope);
        for (const item of n.list ?? []) this.set(item, left);
        if (isParam(n.left) && n.list?.length) this.set(n.left, this.typeOf(n.list[0], scope));
        break;
      }
      case "between": {
        const subject = this.typeOf(n.left, scope) ?? this.typeOf(n.low, scope) ?? this.typeOf(n.high, scope);
        this.set(n.left, subject);
        this.set(n.low, subject);
        this.set(n.high, subject);
        break;
      }
      case "like":
        this.set(n.left, "text");
        this.set(n.pattern, "text");
        this.set(n.escape, "text");
        break;
      case "func": {
        // `col = ANY($1)` is parsed as `__any_array(col, $1, '=')`: the parameter is an array of col.
        const any = /^__(any|all)_array$/.test(n.name.at(-1) ?? "");
        if (any && n.args.length >= 2) {
          const element = this.typeOf(n.args[0], scope);
          this.set(n.args[1], element === undefined ? undefined : arrayTypeOf(element));
        }
        break;
      }
      default:
        break;
    }
    for (const child of Object.values(node)) this.walk(child, inner);
  }

  private setCast(param: { type: "param"; index: number }, target: Parameters<typeof resolveTypeName>[1]): void {
    this.set(param, this.castType(target));
  }
}

/**
 * One OID per `$n` up to the highest, in order: the OID `Parse` declared when it is not zero,
 * else the inferred type's, else `text`. `db` supplies the catalog the columns come from.
 */
export function inferParamOids(db: Database, sql: string, declared: readonly number[]): number[] {
  const inference = new Inference(db);
  try {
    inference.walk(parseSql(sql), []);
  } catch {
    // A statement the engine cannot parse is Parse's error to report; keep what the client declared.
  }
  const count = Math.max(declared.length, inference.highest);
  return Array.from({ length: count }, (_, i) => {
    const given = declared[i];
    if (given) return given;
    const inferred = inference.types.get(i + 1);
    return inferred === undefined ? TEXT_OID : paramOid(inferred);
  });
}
