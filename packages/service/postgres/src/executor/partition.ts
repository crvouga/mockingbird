import type {
  ColumnConstraint,
  ColumnDef,
  CreateTableStmt,
  Expr,
  PartitionBoundSpec,
  PartitionSpec,
  TableConstraint,
  TypeName,
} from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { hashAnyExtendedUint64 } from "../functions/hash-fns.ts";
import { type PartitionKey, tableExt, withTableExt } from "../storage/catalog-ext.ts";
import type { ColumnMeta, DatabaseState, TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumCompare } from "../types/compare.ts";
import { arrayElemType, type Datum, isArrayType, isCompositeType, isEnumType, type TypeId } from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult, RowScope } from "./relation.ts";
import { registerScanHooks } from "./scan.ts";
import { evalScalar } from "./select.ts";
import { withSystemValues } from "./system-columns.ts";

/**
 * Declarative partitioning (https://www.postgresql.org/docs/18/ddl-partitioning.html): a
 * partitioned table (`PARTITION BY RANGE | LIST | HASH`) holds no rows; its partitions do. Inserts
 * through the parent are routed to the partition whose bound accepts the row (or the DEFAULT one),
 * scans of the parent read every partition, and UPDATE / DELETE through the parent run on each
 * partition, moving a row whose new key belongs elsewhere. Partitions keep the parent's column order.
 */

// --- lookup ---------------------------------------------------------------------------------

export function partitionKeyOf(state: DatabaseState, table: TableData): PartitionKey | undefined {
  if (state.catalogExt.tables.size === 0) return undefined;
  return tableExt(state.catalogExt, table.oid).partitionKey;
}

export function isPartitioned(state: DatabaseState, table: TableData): boolean {
  return partitionKeyOf(state, table) !== undefined;
}

function tablesByOid(state: DatabaseState): Map<number, TableData> {
  const out = new Map<number, TableData>();
  for (const schema of state.schemas.values()) for (const t of schema.tables.values()) out.set(t.oid, t);
  return out;
}

/** The direct partitions of `parent` with their bounds, in creation (oid) order. */
export function partitionsOf(
  state: DatabaseState,
  parent: TableData,
): Array<{ table: TableData; bound: PartitionBoundSpec }> {
  const byOid = tablesByOid(state);
  const out: Array<{ table: TableData; bound: PartitionBoundSpec }> = [];
  for (const [oid, ext] of state.catalogExt.tables) {
    if (ext.partitionOf?.parent !== parent.oid) continue;
    const table = byOid.get(oid);
    if (table) out.push({ table, bound: ext.partitionOf.bound });
  }
  return out.sort((a, b) => a.table.oid - b.table.oid);
}

/** The partitions holding rows (leaves) under `parent`, recursively. */
export function leafPartitions(state: DatabaseState, parent: TableData): TableData[] {
  const out: TableData[] = [];
  for (const { table } of partitionsOf(state, parent)) {
    if (isPartitioned(state, table)) out.push(...leafPartitions(state, table));
    else out.push(table);
  }
  return out;
}

function parentOf(state: DatabaseState, table: TableData): TableData | null {
  const parentOid = tableExt(state.catalogExt, table.oid).partitionOf?.parent;
  if (parentOid === undefined) return null;
  return tablesByOid(state).get(parentOid) ?? null;
}

function qualified(table: TableData): string[] {
  return [table.schema, table.name];
}

// --- bounds -----------------------------------------------------------------------------------

interface KeyCol {
  readonly index: number | null;
  readonly expr: Expr | null;
  readonly type: TypeId;
}

function keyColumns(env: ExecEnv, table: TableData, key: PartitionKey): KeyCol[] {
  return key.keys.map((k) => {
    if (k.column !== null) {
      const index = table.columnIndex(k.column);
      return { index, expr: null, type: table.columns[index]!.type.id };
    }
    // an expression key: its type is that of its value on an all-NULL row
    const probe = evalScalar(
      env,
      rowScope(
        table,
        table.columns.map(() => null),
      ),
      k.expr!,
    );
    return { index: null, expr: k.expr, type: probe.t === "unknown" ? "text" : probe.t };
  });
}

function rowScope(table: TableData, row: Datum[]): RowScope {
  return new RowScope(
    table.columns.map((c) => ({ name: c.name, type: c.type.id, table: table.name })),
    row,
    null,
    new Set([table.name]),
  );
}

function keyValues(env: ExecEnv, table: TableData, cols: KeyCol[], row: Datum[]): Datum[] {
  return cols.map((c) =>
    c.index !== null ? (row[c.index] ?? null) : evalScalar(env, rowScope(table, row), c.expr!).v,
  );
}

function boundValue(env: ExecEnv, expr: Expr, type: TypeId): Datum {
  return castTo(env.ctx, evalScalar(env, null, expr), type, { explicit: false, assignment: true }).v;
}

type RangeDatum = { kind: "value"; value: Datum } | { kind: "minvalue" | "maxvalue" };

function rangeDatums(
  env: ExecEnv,
  list: readonly import("../ast/nodes.ts").RangeBoundDatum[],
  cols: KeyCol[],
): RangeDatum[] {
  return list.map((d, i) =>
    d.kind === "value" ? { kind: "value", value: boundValue(env, d.expr, cols[i]!.type) } : { kind: d.kind },
  );
}

/** Compare a key tuple with a range bound tuple (partition_rbound_datum_cmp). */
function compareToBound(env: ExecEnv, cols: KeyCol[], key: Datum[], bound: RangeDatum[]): number {
  for (let i = 0; i < bound.length; i++) {
    const b = bound[i]!;
    if (b.kind === "minvalue") return 1;
    if (b.kind === "maxvalue") return -1;
    const c = datumCompare(cols[i]!.type, key[i]!, (b as { value: Datum }).value, env.ctx);
    if (c !== 0) return c;
  }
  return 0;
}

/** Compare two range bound tuples (for overlap checks and ordering). */
function compareBounds(env: ExecEnv, cols: KeyCol[], a: RangeDatum[], b: RangeDatum[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const rank = (d: RangeDatum) => (d.kind === "minvalue" ? -1 : d.kind === "maxvalue" ? 1 : 0);
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (x.kind !== "value" || y.kind !== "value") return 0;
    const c = datumCompare(cols[i]!.type, x.value, y.value, env.ctx);
    if (c !== 0) return c;
  }
  return 0;
}

const HASH_PARTITION_SEED = 0x7a5b22367996dcfdn;
const MASK64 = (1n << 64n) - 1n;

function uint32Bytes(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v >>> 0, true);
  return out;
}

/** The type's extended hash function (hashint4extended, hashtextextended, ...) with the partition seed. */
function hashKey(type: TypeId, value: Datum): bigint {
  const seed = HASH_PARTITION_SEED;
  switch (type) {
    case "int2":
    case "int4":
    case "date":
    case "oid":
      return hashAnyExtendedUint64(uint32Bytes(value as number), seed);
    case "bool":
      return hashAnyExtendedUint64(uint32Bytes(value ? 1 : 0), seed);
    case "int8":
    case "timestamp":
    case "timestamptz":
    case "time": {
      const v = BigInt.asIntN(64, value as bigint);
      const lo = Number(v & 0xffffffffn) >>> 0;
      const hi = Number((v >> 32n) & 0xffffffffn) >>> 0;
      return hashAnyExtendedUint64(uint32Bytes(v >= 0n ? lo ^ hi : lo ^ ~hi), seed);
    }
    case "text":
    case "varchar":
    case "name":
      return hashAnyExtendedUint64(new TextEncoder().encode(value as string), seed);
    case "bpchar":
      return hashAnyExtendedUint64(new TextEncoder().encode((value as string).replace(/ +$/, "")), seed);
    case "uuid": {
      const hex = (value as string).replaceAll("-", "");
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return hashAnyExtendedUint64(bytes, seed);
    }
    default:
      throw unsupported(`hash partitioning on type ${type}`);
  }
}

function hashCombine64(a: bigint, b: bigint): bigint {
  const mixed = (b + 0x49a0f4dd15e5a8e3n + ((a << 54n) & MASK64) + (a >> 7n)) & MASK64;
  return (a ^ mixed) & MASK64;
}

/** compute_partition_hash_value: NULL keys contribute nothing. */
function rowHash(cols: KeyCol[], key: Datum[]): bigint {
  let h = 0n;
  key.forEach((v, i) => {
    if (v !== null) h = hashCombine64(h, hashKey(cols[i]!.type, v));
  });
  return h;
}

function boundAccepts(env: ExecEnv, cols: KeyCol[], key: Datum[], bound: PartitionBoundSpec): boolean {
  switch (bound.kind) {
    case "default":
      return false;
    case "list": {
      const v = key[0] ?? null;
      return bound.values.some((expr) => {
        const b = boundValue(env, expr, cols[0]!.type);
        if (v === null || b === null) return v === null && b === null;
        return datumCompare(cols[0]!.type, v, b, env.ctx) === 0;
      });
    }
    case "range": {
      if (key.some((v) => v === null)) return false;
      const from = rangeDatums(env, bound.from, cols);
      const to = rangeDatums(env, bound.to, cols);
      return compareToBound(env, cols, key, from) >= 0 && compareToBound(env, cols, key, to) < 0;
    }
    case "hash":
      return rowHash(cols, key) % BigInt(bound.modulus) === BigInt(bound.remainder);
  }
}

/** The direct partition of `parent` that takes `row` (null when none does). */
function choosePartition(env: ExecEnv, parent: TableData, row: Datum[]): TableData | null {
  const state = env.ctx.state;
  const key = partitionKeyOf(state, parent)!;
  const cols = keyColumns(env, parent, key);
  const values = keyValues(env, parent, cols, row);
  let fallback: TableData | null = null;
  for (const { table, bound } of partitionsOf(state, parent)) {
    if (bound.kind === "default") fallback = table;
    else if (boundAccepts(env, cols, values, bound)) return table;
  }
  return fallback;
}

/** The leaf partition an insert of `row` (in the parent's column order) through `parent` goes to. */
export function routeRow(env: ExecEnv, parent: TableData, row: Datum[]): TableData {
  let current = parent;
  while (isPartitioned(env.ctx.state, current)) {
    const next = choosePartition(env, current, row);
    if (!next) {
      throw pgError("constraint_check", `no partition of relation "${current.name}" found for row`, "23514");
    }
    current = next;
  }
  return current;
}

/** Whether `row` satisfies `table`'s partition constraint (its bound and every ancestor's). */
export function satisfiesPartitionConstraint(env: ExecEnv, table: TableData, row: Datum[]): boolean {
  const state = env.ctx.state;
  let child = table;
  let parent = parentOf(state, child);
  while (parent) {
    if (choosePartition(env, parent, row) !== child) return false;
    child = parent;
    parent = parentOf(state, child);
  }
  return true;
}

/** INSERT / UPDATE straight into a partition: the row must belong there. */
export function checkPartitionConstraint(env: ExecEnv, table: TableData, row: Datum[]): void {
  if (env.ctx.state.catalogExt.tables.size === 0) return;
  if (!tableExt(env.ctx.state.catalogExt, table.oid).partitionOf) return;
  if (!satisfiesPartitionConstraint(env, table, row)) {
    throw pgError("constraint_check", `new row for relation "${table.name}" violates partition constraint`, "23514");
  }
}

// --- DDL ---------------------------------------------------------------------------------------

function keyColumnNames(spec: PartitionSpec | PartitionKey): string[] {
  return spec.keys.flatMap((k) => (k.column === null ? [] : [k.column]));
}

/** `PARTITION BY` on a new table: check the key, record it. */
export function setPartitionKey(env: ExecEnv, table: TableData, spec: PartitionSpec): void {
  const state = env.ctx.state;
  for (const k of spec.keys) {
    if (k.column !== null && table.columnIndex(k.column) === -1) {
      throw pgError("undefined_column", `column "${k.column}" named in partition key does not exist`, "42703");
    }
  }
  const keyCols = keyColumnNames(spec);
  for (const con of table.constraints) {
    if (con.kind !== "primary_key" && con.kind !== "unique") continue;
    if (spec.keys.some((k) => k.column === null) || !keyCols.every((c) => con.columns.includes(c))) {
      throw pgError(
        "feature_not_supported",
        "unique constraint on partitioned table must include all partitioning columns",
        "0A000",
      );
    }
  }
  if (spec.strategy === "hash") {
    const probe = keyColumns(env, table, spec);
    for (const c of probe) hashKey(c.type, defaultProbe(c.type));
  }
  state.catalogExt = withTableExt(state.catalogExt, table.oid, (ext) => ({ ...ext, partitionKey: { ...spec } }));
}

/** A value of `type` to check that the hash function exists for it. */
function defaultProbe(type: TypeId): Datum {
  switch (type) {
    case "int8":
    case "timestamp":
    case "timestamptz":
    case "time":
      return 0n;
    case "text":
    case "varchar":
    case "name":
    case "bpchar":
      return "";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "bool":
      return false;
    default:
      return 0;
  }
}

function boundKindName(kind: string): string {
  return kind;
}

/** Check a new partition's bound against the parent's strategy and its siblings. */
function validateBound(
  env: ExecEnv,
  parent: TableData,
  name: string,
  bound: PartitionBoundSpec,
  self?: TableData,
): void {
  const state = env.ctx.state;
  const key = partitionKeyOf(state, parent)!;
  if (bound.kind !== "default" && bound.kind !== key.strategy) {
    throw pgError(
      "invalid_table_definition",
      `invalid bound specification for a ${boundKindName(key.strategy)} partition`,
      "42P16",
    );
  }
  const cols = keyColumns(env, parent, key);
  const siblings = partitionsOf(state, parent).filter((p) => p.table !== self);
  const overlap = (other: string) =>
    pgError("invalid_table_definition", `partition "${name}" would overlap partition "${other}"`, "42P17");
  switch (bound.kind) {
    case "default": {
      const existing = siblings.find((s) => s.bound.kind === "default");
      if (existing) {
        throw pgError(
          "invalid_table_definition",
          `partition "${name}" conflicts with existing default partition "${existing.table.name}"`,
          "42P17",
        );
      }
      return;
    }
    case "list": {
      const values = bound.values.map((e) => boundValue(env, e, cols[0]!.type));
      for (const s of siblings) {
        if (s.bound.kind !== "list") continue;
        for (const e of s.bound.values) {
          const other = boundValue(env, e, cols[0]!.type);
          if (
            values.some((v) =>
              v === null || other === null ? v === other : datumCompare(cols[0]!.type, v, other, env.ctx) === 0,
            )
          ) {
            throw overlap(s.table.name);
          }
        }
      }
      return;
    }
    case "range": {
      if (bound.from.length !== cols.length || bound.to.length !== cols.length) {
        throw pgError(
          "invalid_table_definition",
          "FROM must specify exactly one value per partitioning column",
          "42P16",
        );
      }
      const from = rangeDatums(env, bound.from, cols);
      const to = rangeDatums(env, bound.to, cols);
      for (const d of [...from, ...to]) {
        if (d.kind === "value" && d.value === null) {
          throw pgError("invalid_table_definition", "cannot specify NULL in range bound", "42P16");
        }
      }
      if (compareBounds(env, cols, from, to) >= 0) {
        throw pgError("invalid_table_definition", `empty range bound specified for partition "${name}"`, "42P17");
      }
      for (const s of siblings) {
        if (s.bound.kind !== "range") continue;
        const otherFrom = rangeDatums(env, s.bound.from, cols);
        const otherTo = rangeDatums(env, s.bound.to, cols);
        if (compareBounds(env, cols, from, otherTo) < 0 && compareBounds(env, cols, otherFrom, to) < 0) {
          throw overlap(s.table.name);
        }
      }
      return;
    }
    case "hash": {
      if (bound.modulus <= 0) {
        throw pgError(
          "invalid_parameter_value",
          "modulus for hash partition must be an integer value greater than zero",
          "42P16",
        );
      }
      if (bound.remainder < 0 || bound.remainder >= bound.modulus) {
        throw pgError("invalid_parameter_value", "remainder for hash partition must be less than modulus", "42P16");
      }
      for (const s of siblings) {
        if (s.bound.kind !== "hash") continue;
        const small = Math.min(bound.modulus, s.bound.modulus);
        const large = Math.max(bound.modulus, s.bound.modulus);
        if (large % small !== 0) {
          throw pgError(
            "invalid_table_definition",
            "every hash partition modulus must be a factor of the next larger modulus",
            "42P17",
          );
        }
        if (bound.remainder % small === s.bound.remainder % small) throw overlap(s.table.name);
      }
      return;
    }
  }
}

/** A column's type as a type name, for the partition's own CREATE TABLE. */
function typeNameOf(col: ColumnMeta): TypeName {
  const id = col.type.id;
  const array = isArrayType(id);
  const elem = array ? arrayElemType(id) : id;
  const parts =
    col.domain !== null
      ? col.domain.split(".")
      : isEnumType(elem) || isCompositeType(elem)
        ? elem.slice(5).split(".")
        : [elem];
  const mod = col.type.mod;
  const mods = mod
    ? mod.b !== undefined && elem === "numeric"
      ? [mod.a ?? 0, mod.b]
      : mod.a !== undefined
        ? [mod.a]
        : []
    : [];
  return { parts, mods, arrayDims: array && col.domain === null ? 1 : 0 };
}

/**
 * `CREATE TABLE name PARTITION OF parent ...`: the parent's columns (with the partition's own column
 * options), its CHECK, key and foreign key constraints and its row triggers; then the bound.
 */
export function createPartition(
  env: ExecEnv,
  stmt: CreateTableStmt,
  createTable: (stmt: CreateTableStmt) => ExecResult,
): ExecResult {
  const state = env.ctx.state;
  const of = stmt.partitionOf!;
  const parent = state.findTable(of.parent);
  if (!parent) throw pgError("undefined_table", `relation "${of.parent.join(".")}" does not exist`, "42P01");
  if (!isPartitioned(state, parent)) {
    throw pgError("invalid_table_definition", `"${parent.name}" is not partitioned`, "42P17");
  }
  const name = stmt.name[stmt.name.length - 1]!;
  validateBound(env, parent, name, of.bound);
  for (const def of stmt.columns) {
    if (parent.columnIndex(def.name) === -1) {
      throw pgError("undefined_column", `column "${def.name}" does not exist`, "42703");
    }
  }
  const columns: ColumnDef[] = parent.columns.map((col) => {
    const constraints: ColumnConstraint[] = [];
    if (col.notNull) constraints.push({ kind: "not_null", name: null });
    if (col.defaultExpr && !col.identity) constraints.push({ kind: "default", expr: col.defaultExpr, name: null });
    if (col.generated) {
      constraints.push({
        kind: "generated_stored",
        expr: col.generated,
        name: null,
        ...(col.virtual ? { virtual: true } : {}),
      });
    }
    if (col.collate) constraints.push({ kind: "collate", collation: col.collate.split(".") });
    const own = stmt.columns.find((d) => d.name === col.name);
    return { name: col.name, typeName: typeNameOf(col), constraints: [...constraints, ...(own?.constraints ?? [])] };
  });
  const inherited: TableConstraint[] = [];
  for (const con of parent.constraints) {
    switch (con.kind) {
      case "check":
        inherited.push({ kind: "check", name: con.name, expr: con.expr, noInherit: false });
        break;
      case "primary_key":
        inherited.push({ kind: "primary_key", name: null, columns: con.columns.slice() });
        break;
      case "unique":
        inherited.push({
          kind: "unique",
          name: null,
          columns: con.columns.slice(),
          nullsNotDistinct: con.nullsNotDistinct,
        });
        break;
      case "foreign_key":
        inherited.push({
          kind: "foreign_key",
          name: con.name,
          columns: con.columns.slice(),
          refTable: [con.refSchema, con.refTable],
          refColumns: con.refColumns.slice(),
          onDelete: (con.onDelete as "cascade") ?? null,
          onUpdate: (con.onUpdate as "cascade") ?? null,
          match: con.match,
          ...(con.onDeleteColumns ? { onDeleteColumns: con.onDeleteColumns } : {}),
        });
        break;
    }
  }
  const { partitionOf: _of, ...rest } = stmt;
  const result = createTable({ ...rest, columns, constraints: [...inherited, ...stmt.constraints] });
  const child = state.findTable(stmt.name);
  if (!child) return result;
  // row triggers are cloned onto each partition
  child.triggers = [...child.triggers, ...parent.triggers.filter((t) => t.forEachRow).map((t) => ({ ...t }))];
  // rows of the default partition that the new bound takes would move: PostgreSQL refuses
  checkDefaultPartition(env, parent, child, of.bound);
  state.catalogExt = withTableExt(state.catalogExt, child.oid, (ext) => ({
    ...ext,
    partitionOf: { parent: parent.oid, bound: of.bound },
  }));
  return result;
}

function checkDefaultPartition(env: ExecEnv, parent: TableData, child: TableData, bound: PartitionBoundSpec): void {
  if (bound.kind === "default") return;
  const state = env.ctx.state;
  const fallback = partitionsOf(state, parent).find((p) => p.bound.kind === "default" && p.table !== child);
  if (!fallback) return;
  const key = partitionKeyOf(state, parent)!;
  const cols = keyColumns(env, parent, key);
  for (const leaf of isPartitioned(state, fallback.table) ? leafPartitions(state, fallback.table) : [fallback.table]) {
    for (let i = 0; i < leaf.rowCount(); i++) {
      if (boundAccepts(env, cols, keyValues(env, parent, cols, leaf.rowAt(i)), bound)) {
        throw pgError(
          "constraint_check",
          `updated partition constraint for default partition "${fallback.table.name}" would be violated by some row`,
          "23514",
        );
      }
    }
  }
}

export function attachPartition(env: ExecEnv, parent: TableData, name: string[], bound: PartitionBoundSpec): void {
  const state = env.ctx.state;
  if (!isPartitioned(state, parent)) {
    throw pgError("wrong_object_type", `table "${parent.name}" is not partitioned`, "42809");
  }
  const child = state.findTable(name);
  if (!child) throw pgError("undefined_table", `relation "${name.join(".")}" does not exist`, "42P01");
  if (tableExt(state.catalogExt, child.oid).partitionOf) {
    throw pgError("invalid_table_definition", `"${child.name}" is already a partition`, "42P17");
  }
  if (child === parent) {
    throw pgError("duplicate_table", `circular inheritance not allowed`, "42P07");
  }
  for (const col of child.columns) {
    if (parent.columnIndex(col.name) === -1) {
      throw pgError(
        "datatype_mismatch",
        `table "${child.name}" contains column "${col.name}" not found in parent "${parent.name}"`,
        "42804",
      );
    }
  }
  for (const col of parent.columns) {
    const mine = child.columns[child.columnIndex(col.name)];
    if (!mine) {
      throw pgError("datatype_mismatch", `child table is missing column "${col.name}"`, "42804");
    }
    if (mine.type.id !== col.type.id) {
      throw pgError(
        "datatype_mismatch",
        `child table "${child.name}" has different type for column "${col.name}"`,
        "42804",
      );
    }
  }
  if (child.columns.some((c, i) => c.name !== parent.columns[i]?.name)) {
    throw unsupported("ATTACH PARTITION of a table whose columns are in a different order than the parent's");
  }
  validateBound(env, parent, child.name, bound);
  const key = partitionKeyOf(state, parent)!;
  const cols = keyColumns(env, parent, key);
  const siblings = partitionsOf(state, parent);
  for (const leaf of isPartitioned(state, child) ? leafPartitions(state, child) : [child]) {
    for (let i = 0; i < leaf.rowCount(); i++) {
      const values = keyValues(env, parent, cols, leaf.rowAt(i));
      const ok =
        bound.kind === "default"
          ? !siblings.some((s) => s.bound.kind !== "default" && boundAccepts(env, cols, values, s.bound))
          : boundAccepts(env, cols, values, bound);
      if (!ok) {
        throw pgError(
          "constraint_check",
          `partition constraint of relation "${child.name}" is violated by some row`,
          "23514",
        );
      }
    }
  }
  checkDefaultPartition(env, parent, child, bound);
  // the parent's key constraints reach the new partition
  const writable = state.ensureWritableTable(child);
  for (const con of parent.constraints) {
    if (con.kind !== "primary_key" && con.kind !== "unique") continue;
    const same = writable.constraints.some(
      (c) =>
        c.kind === con.kind &&
        c.columns.length === con.columns.length &&
        c.columns.every((x, i) => x === con.columns[i]),
    );
    if (!same) {
      const suffix = con.kind === "primary_key" ? "pkey" : `${con.columns.join("_")}_key`;
      writable.constraints.push({ ...con, name: `${writable.name}_${suffix}`, indexOid: undefined } as typeof con);
    }
  }
  state.catalogExt = withTableExt(state.catalogExt, child.oid, (ext) => ({
    ...ext,
    partitionOf: { parent: parent.oid, bound },
  }));
}

export function detachPartition(env: ExecEnv, parent: TableData, name: string[]): void {
  const state = env.ctx.state;
  const child = state.findTable(name);
  if (!child) throw pgError("undefined_table", `relation "${name.join(".")}" does not exist`, "42P01");
  if (tableExt(state.catalogExt, child.oid).partitionOf?.parent !== parent.oid) {
    throw pgError(
      "undefined_table",
      `relation "${child.name}" is not a partition of relation "${parent.name}"`,
      "42P01",
    );
  }
  state.catalogExt = withTableExt(state.catalogExt, child.oid, (ext) => {
    const { partitionOf: _of, ...rest } = ext;
    return rest;
  });
}

/** DROP TABLE of a partitioned table drops its partitions; returns them, deepest first. */
export function partitionsToDrop(state: DatabaseState, table: TableData): TableData[] {
  if (!isPartitioned(state, table)) return [];
  const out: TableData[] = [];
  for (const { table: child } of partitionsOf(state, table)) out.push(...partitionsToDrop(state, child), child);
  return out;
}

/** `pg_get_partkeydef(oid)` */
export function partitionKeyDefinition(
  state: DatabaseState,
  table: TableData,
  deparse: (e: Expr) => string,
): string | null {
  const key = partitionKeyOf(state, table);
  if (!key) return null;
  const keys = key.keys.map((k) => (k.column !== null ? quoteName(k.column) : `(${deparse(k.expr!)})`));
  return `${key.strategy.toUpperCase()} (${keys.join(", ")})`;
}

function quoteName(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

// --- scans -----------------------------------------------------------------------------------

registerScanHooks({
  rows(env, table) {
    if (!isPartitioned(env.ctx.state, table)) return null;
    const out: Datum[][] = [];
    for (const leaf of leafPartitions(env.ctx.state, table)) {
      leaf.materializeSlab();
      const rows = leaf.serializationRows();
      for (let i = 0; i < rows.length; i++) out.push(withSystemValues(leaf, rows[i]!, i));
    }
    return out;
  },
  plain(env, table) {
    return !isPartitioned(env.ctx.state, table);
  },
});

export function partitionedCommand(what: string): ExecResult {
  return commandResult(what, 0);
}

export { qualified };
