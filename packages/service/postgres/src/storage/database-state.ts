import type { CreateTriggerStmt, Expr, SelectStmt, Statement } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { Clock } from "../runtime/clock.ts";
import type { Prng } from "../runtime/prng.ts";
import { PG_CATALOG_RELATIONS } from "../schema/catalog.ts";
import type { ColumnarSlab } from "./columnar-slab.ts";
import { type ColumnType, type Datum, TYPE_OIDS, type TypeId, typeDisplayName } from "../types/value.ts";

// --- table / relation metadata ---------------------------------------------

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  notNull: boolean;
  defaultExpr: Expr | null;
  identity: { always: boolean; sequence: string } | null; // sequence = qualified seq key "schema.name"
  generated: Expr | null; // GENERATED ALWAYS AS (...) STORED
  collate: string | null;
  /** resolved domain name when column type came from a domain */
  domain: string | null; // "schema.name"
}

export type ConstraintMeta =
  | { kind: "primary_key"; name: string; columns: string[] }
  | { kind: "unique"; name: string; columns: string[]; nullsNotDistinct: boolean }
  | { kind: "check"; name: string; expr: Expr }
  | {
      kind: "foreign_key";
      name: string;
      columns: string[];
      refSchema: string;
      refTable: string;
      refColumns: string[];
      onDelete: string | null;
      onUpdate: string | null;
      match: "full" | "simple";
    };

export interface IndexMeta {
  name: string;
  schema: string;
  table: string;
  unique: boolean;
  /** simple column indexes store names; expression indexes store the AST */
  columns: Array<{ column: string | null; expr: Expr | null; dir: "asc" | "desc"; nulls: "first" | "last" }>;
  where: Expr | null;
  nullsNotDistinct: boolean;
  /** true when this index backs a constraint (pkey / unique constraint) */
  isConstraint: boolean;
}

export interface TriggerMeta {
  name: string;
  timing: "before" | "after" | "instead_of";
  events: CreateTriggerStmt["events"];
  forEachRow: boolean;
  when: Expr | null;
  funcSchema: string;
  funcName: string;
  funcArgs: string[];
}

export class TableData {
  name: string;
  schema: string;
  columns: ColumnMeta[];
  rows: Datum[][];
  /** Frozen columnar storage after snapshot hydrate; `rows` stays empty until materialized. */
  slab: ColumnarSlab | null = null;
  constraints: ConstraintMeta[];
  triggers: TriggerMeta[];
  temp: boolean;
  /** monotonically increasing oid-like id for catalog output */
  readonly oid: number;
  /** >0 while shared with a clone or transaction snapshot. */
  shareCount = 0;
  /** Derived unique/btree index maps; null until built or invalidated. */
  indexStores: Map<string, import("../indexes/index.ts").IndexStore> | null = null;

  constructor(schema: string, name: string, columns: ColumnMeta[], oid: number, temp = false) {
    this.schema = schema;
    this.name = name;
    this.columns = columns;
    this.rows = [];
    this.constraints = [];
    this.triggers = [];
    this.temp = temp;
    this.oid = oid;
  }

  rowCount(): number {
    return this.slab ? this.slab.rowCount : this.rows.length;
  }

  rowAt(index: number): Datum[] {
    if (this.slab) return this.slab.rowAt(index);
    return this.rows[index] ?? [];
  }

  /** All rows for scans; materializes slab once into `rows` when needed. */
  allRows(): Datum[][] {
    this.materializeSlab();
    return this.rows;
  }

  attachSlab(slab: ColumnarSlab): void {
    this.slab = slab;
    this.rows = [];
  }

  materializeSlab(): void {
    if (!this.slab) return;
    this.rows = this.slab.materialize();
    this.slab = null;
    this.indexStores = null;
  }

  /** Writable row storage; materializes slab if needed. */
  mutableRows(): Datum[][] {
    this.materializeSlab();
    return this.rows;
  }

  get frozen(): boolean {
    return this.shareCount > 0;
  }

  freeze(): void {
    this.shareCount++;
  }

  thaw(): void {
    if (this.shareCount > 0) this.shareCount--;
  }

  columnIndex(name: string): number {
    return this.columns.findIndex((c) => c.name === name);
  }

  clone(): TableData {
    const t = new TableData(
      this.schema,
      this.name,
      this.columns.map((c) => ({ ...c })),
      this.oid,
      this.temp,
    );
    if (this.slab) {
      t.rows = this.slab.materialize().map((r) => r.slice());
    } else {
      t.rows = this.rows.map((r) => r.slice());
    }
    t.constraints = this.constraints.map((c) => ({ ...c }));
    t.triggers = this.triggers.map((tr) => ({ ...tr }));
    t.indexStores = this.indexStores ? new Map([...this.indexStores].map(([k, v]) => [k, v.clone()])) : null;
    return t;
  }

  /** Independent writable copy (row tuples copied so ALTER COLUMN is isolated). */
  cloneForWrite(): TableData {
    const t = this.clone();
    t.materializeSlab();
    return t;
  }
}

export interface ViewData {
  name: string;
  schema: string;
  query: SelectStmt;
  columns: string[] | null;
  materialized: boolean;
  /** materialized contents; null = WITH NO DATA (not populated) */
  matRows: Datum[][] | null;
  matColumns: Array<{ name: string; type: TypeId }> | null;
  temp: boolean;
  oid: number;
  shareCount?: number;
}

export interface SequenceData {
  name: string;
  schema: string;
  increment: bigint;
  minValue: bigint;
  maxValue: bigint;
  startValue: bigint;
  cache: bigint;
  cycle: boolean;
  lastValue: bigint;
  isCalled: boolean;
  ownedBy: { table: string; column: string } | null;
  dataType: TypeId;
  temp: boolean;
  oid: number;
  shareCount?: number;
}

export interface EnumData {
  name: string;
  schema: string;
  labels: string[];
  oid: number;
  shareCount?: number;
}

export interface DomainData {
  name: string;
  schema: string;
  baseType: ColumnType;
  notNull: boolean;
  defaultExpr: Expr | null;
  checks: Array<{ name: string; expr: Expr }>;
  oid: number;
  shareCount?: number;
}

export interface FunctionData {
  name: string;
  schema: string;
  argNames: (string | null)[];
  argTypes: TypeId[];
  argDefaults: (Expr | null)[];
  returns: TypeId | null;
  returnsSet: boolean;
  returnsTable: Array<{ name: string; type: TypeId }> | null;
  language: string;
  body: Statement[] | null;
  rawBody: string | null;
  strict: boolean;
  oid: number;
  jsImpl?: (
    ...args: Array<null | boolean | number | bigint | string | Uint8Array>
  ) => null | boolean | number | bigint | string | Uint8Array;
}

export class SchemaData {
  name: string;
  tables = new Map<string, TableData>();
  views = new Map<string, ViewData>();
  sequences = new Map<string, SequenceData>();
  enums = new Map<string, EnumData>();
  domains = new Map<string, DomainData>();
  functions = new Map<string, FunctionData[]>();
  indexes = new Map<string, IndexMeta>();
  oid: number;

  constructor(name: string, oid: number) {
    this.name = name;
    this.oid = oid;
  }

  /** all relation names (tables, views, sequences, indexes share pg_class namespace) */
  hasRelation(name: string): boolean {
    return this.tables.has(name) || this.views.has(name) || this.sequences.has(name) || this.indexes.has(name);
  }

  clone(): SchemaData {
    const s = new SchemaData(this.name, this.oid);
    for (const [k, v] of this.tables) s.tables.set(k, v.clone());
    for (const [k, v] of this.views) {
      s.views.set(k, {
        ...v,
        matRows: v.matRows ? v.matRows.map((r) => r.slice()) : null,
        matColumns: v.matColumns ? v.matColumns.map((c) => ({ ...c })) : null,
      });
    }
    for (const [k, v] of this.sequences) s.sequences.set(k, { ...v });
    for (const [k, v] of this.enums) s.enums.set(k, { ...v, labels: v.labels.slice() });
    for (const [k, v] of this.domains) s.domains.set(k, { ...v, checks: v.checks.map((c) => ({ ...c })) });
    for (const [k, v] of this.functions)
      s.functions.set(
        k,
        v.map((f) => ({ ...f })),
      );
    for (const [k, v] of this.indexes) s.indexes.set(k, { ...v, columns: v.columns.map((c) => ({ ...c })) });
    return s;
  }

  /** Share table/sequence objects; copy maps so CREATE/DROP is isolated. */
  cloneShallow(): SchemaData {
    const s = new SchemaData(this.name, this.oid);
    s.tables = new Map(this.tables);
    s.views = new Map(this.views);
    s.sequences = new Map(this.sequences);
    s.enums = new Map(this.enums);
    s.domains = new Map(this.domains);
    for (const [k, v] of this.functions) s.functions.set(k, v.slice());
    s.indexes = new Map(this.indexes);
    return s;
  }
}

export interface PreparedStatement {
  name: string;
  argTypes: TypeId[] | null;
  stmt: Statement;
}

// --- database state -----------------------------------------------------------

export class DatabaseState {
  schemas = new Map<string, SchemaData>();
  settings = new Map<string, string>();
  /** SET LOCAL values, cleared on COMMIT/ROLLBACK */
  localSettings = new Map<string, string>();
  prepared = new Map<string, PreparedStatement>();
  prng: Prng;
  clock: Clock;
  changes = 0;
  private oidCounter = 16384;
  inTransaction = false;
  /** most recent sequence touched by nextval/setval, for lastval() */
  lastSequence: { schema: string; name: string } | null = null;
  /** Session currval per sequence; absent entry means currval is undefined. */
  sequenceCurrval = new Map<string, bigint>();

  constructor(prng: Prng, clock: Clock) {
    this.prng = prng;
    this.clock = clock;
    this.schemas.set("public", new SchemaData("public", this.nextOid()));
    this.settings.set("timezone", "UTC");
    this.settings.set("search_path", '"$user", public');
    this.settings.set("datestyle", "ISO, MDY");
    this.settings.set("intervalstyle", "postgres");
    this.settings.set("bytea_output", "hex");
    this.settings.set("standard_conforming_strings", "on");
    this.settings.set("client_encoding", "UTF8");
    this.settings.set("server_encoding", "UTF8");
    this.settings.set("integer_datetimes", "on");
    this.settings.set("transaction_isolation", "read committed");
    this.settings.set("application_name", "");
    this.settings.set("extra_float_digits", "1");
    this.settings.set("client_min_messages", "notice");
    this.settings.set("max_identifier_length", "63");
    this.settings.set("server_version", "18.3");
    this.settings.set("server_version_num", "180003");
    this.settings.set("lc_messages", "C");
    this.settings.set("lc_monetary", "C");
    this.settings.set("lc_numeric", "C");
    this.settings.set("lc_time", "C");
    this.settings.set("default_transaction_isolation", "read committed");
    this.settings.set("statement_timeout", "0");
    this.settings.set("array_nulls", "on");
    this.settings.set("backslash_quote", "safe_encoding");
  }

  nextOid(): number {
    return this.oidCounter++;
  }

  getSetting(name: string): string | undefined {
    return this.localSettings.get(name) ?? this.settings.get(name);
  }

  /** effective search path: existing schemas from search_path setting */
  effectiveSearchPath(): string[] {
    const raw = this.getSetting("search_path") ?? "public";
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
      .filter((p) => p.length > 0);
    const out: string[] = [];
    for (const p of parts) {
      const name = p === "$user" ? "postgres" : p;
      if (this.schemas.has(name)) out.push(name);
    }
    return out;
  }

  currentSchema(): string {
    const path = this.effectiveSearchPath();
    return path[0] ?? "public";
  }

  getSchema(name: string): SchemaData {
    const s = this.schemas.get(name);
    if (!s) throw pgError("undefined_object", `schema "${name}" does not exist`, "3F000");
    return s;
  }

  /** Resolve a possibly-qualified relation name to its schema. */
  resolveRelationSchema(parts: string[]): { schema: string; name: string } | null {
    if (parts.length === 2) {
      const [schema, name] = parts as [string, string];
      return { schema, name };
    }
    if (parts.length === 3) {
      // database.schema.name — database must match
      const [, schema, name] = parts as [string, string, string];
      return { schema, name };
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      if (schema === "pg_catalog" && PG_CATALOG_RELATIONS.has(name)) return { schema, name };
      const s = this.schemas.get(schema);
      if (s?.hasRelation(name)) return { schema, name };
    }
    return null;
  }

  findTable(parts: string[]): TableData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.tables.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const t = this.schemas.get(schema)?.tables.get(name);
      if (t) return t;
    }
    return null;
  }

  requireTable(parts: string[]): TableData {
    const t = this.findTable(parts);
    if (!t) {
      throw pgError("undefined_table", `relation "${parts.join(".")}" does not exist`);
    }
    return t;
  }

  findView(parts: string[]): ViewData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.views.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const v = this.schemas.get(schema)?.views.get(name);
      if (v) return v;
    }
    return null;
  }

  findSequence(parts: string[]): SequenceData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.sequences.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const s = this.schemas.get(schema)?.sequences.get(name);
      if (s) return s;
    }
    return null;
  }

  findEnum(parts: string[]): EnumData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.enums.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      const e = this.schemas.get(schema)?.enums.get(name);
      if (e) return e;
    }
    return null;
  }

  findDomain(parts: string[]): DomainData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.domains.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      const d = this.schemas.get(schema)?.domains.get(name);
      if (d) return d;
    }
    return null;
  }

  findFunctions(parts: string[]): FunctionData[] {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      if (schema === "pg_catalog") return [];
      return this.schemas.get(schema)?.functions.get(name) ?? [];
    }
    const name = parts[0]!;
    const out: FunctionData[] = [];
    for (const schema of this.effectiveSearchPath()) {
      const fns = this.schemas.get(schema)?.functions.get(name);
      if (fns) out.push(...fns);
    }
    return out;
  }

  findEnumByKey(key: string): EnumData | null {
    const dot = key.indexOf(".");
    if (dot === -1) return this.findEnum([key]);
    return this.schemas.get(key.slice(0, dot))?.enums.get(key.slice(dot + 1)) ?? null;
  }

  /** format_type()-style display name for a type OID (builtin or enum). */
  typeNameForOid(oid: number): string | null {
    for (const [name, o] of Object.entries(TYPE_OIDS)) {
      if (o === oid) return typeDisplayName(name);
    }
    for (const schema of this.schemas.values()) {
      for (const e of schema.enums.values()) {
        if (e.oid === oid) return e.name;
      }
    }
    return null;
  }

  /** deep clone (datums are immutable; rows copied) */
  clone(): DatabaseState {
    const s = new DatabaseState(this.prng, this.clock);
    s.schemas = new Map();
    for (const [k, v] of this.schemas) s.schemas.set(k, v.clone());
    s.settings = new Map(this.settings);
    s.localSettings = new Map(this.localSettings);
    s.prepared = new Map(this.prepared);
    s.changes = this.changes;
    s.inTransaction = this.inTransaction;
    s.lastSequence = this.lastSequence ? { ...this.lastSequence } : null;
    s.sequenceCurrval = new Map(this.sequenceCurrval);
    s.oidCounter = this.oidCounter;
    return s;
  }

  /** Share frozen catalog objects; copy maps so CREATE/DROP is isolated. */
  cloneShallow(): DatabaseState {
    const s = new DatabaseState(this.prng, this.clock);
    s.schemas = new Map();
    for (const [k, v] of this.schemas) s.schemas.set(k, v.cloneShallow());
    s.settings = new Map(this.settings);
    s.localSettings = new Map(this.localSettings);
    s.prepared = new Map(this.prepared);
    s.changes = this.changes;
    s.inTransaction = this.inTransaction;
    s.lastSequence = this.lastSequence ? { ...this.lastSequence } : null;
    s.sequenceCurrval = new Map(this.sequenceCurrval);
    s.oidCounter = this.oidCounter;
    return s;
  }

  freezeShared(): void {
    for (const schema of this.schemas.values()) {
      for (const table of schema.tables.values()) table.freeze();
      for (const seq of schema.sequences.values()) seq.shareCount = (seq.shareCount ?? 0) + 1;
      for (const view of schema.views.values()) view.shareCount = (view.shareCount ?? 0) + 1;
      for (const en of schema.enums.values()) en.shareCount = (en.shareCount ?? 0) + 1;
      for (const domain of schema.domains.values()) domain.shareCount = (domain.shareCount ?? 0) + 1;
    }
  }

  thawShared(): void {
    for (const schema of this.schemas.values()) {
      for (const table of schema.tables.values()) table.thaw();
      for (const seq of schema.sequences.values()) {
        if ((seq.shareCount ?? 0) > 0) seq.shareCount = (seq.shareCount ?? 1) - 1;
      }
      for (const view of schema.views.values()) {
        if ((view.shareCount ?? 0) > 0) view.shareCount = (view.shareCount ?? 1) - 1;
      }
      for (const en of schema.enums.values()) {
        if ((en.shareCount ?? 0) > 0) en.shareCount = (en.shareCount ?? 1) - 1;
      }
      for (const domain of schema.domains.values()) {
        if ((domain.shareCount ?? 0) > 0) domain.shareCount = (domain.shareCount ?? 1) - 1;
      }
    }
  }

  ensureWritableTable(table: TableData): TableData {
    if (!table.frozen) return table;
    const schema = this.schemas.get(table.schema);
    const copy = table.cloneForWrite();
    schema?.tables.set(table.name, copy);
    return copy;
  }

  ensureWritableSequence(seq: SequenceData): SequenceData {
    if ((seq.shareCount ?? 0) === 0) return seq;
    const schema = this.schemas.get(seq.schema);
    const copy: SequenceData = { ...seq, shareCount: 0 };
    schema?.sequences.set(seq.name, copy);
    return copy;
  }

  ensureWritableView(view: ViewData): ViewData {
    if ((view.shareCount ?? 0) === 0) return view;
    const schema = this.schemas.get(view.schema);
    const copy: ViewData = {
      ...view,
      shareCount: 0,
      matRows: view.matRows ? view.matRows.map((r) => r.slice()) : null,
      matColumns: view.matColumns ? view.matColumns.map((c) => ({ ...c })) : null,
    };
    schema?.views.set(view.name, copy);
    return copy;
  }

  ensureWritableEnum(en: EnumData): EnumData {
    if ((en.shareCount ?? 0) === 0) return en;
    const schema = this.schemas.get(en.schema);
    const copy: EnumData = { ...en, labels: en.labels.slice(), shareCount: 0 };
    schema?.enums.set(en.name, copy);
    return copy;
  }

  /** copy the contents of `other` into this state (rollback restore) */
  restoreFrom(other: DatabaseState): void {
    this.schemas = other.schemas;
    this.settings = other.settings;
    this.localSettings = other.localSettings;
    this.prepared = other.prepared;
    this.changes = other.changes;
    this.lastSequence = other.lastSequence;
    this.sequenceCurrval = other.sequenceCurrval;
    this.oidCounter = other.oidCounter;
  }

  /** @internal Snapshot codec access to the oid allocator. */
  snapshotOidCounter(): number {
    return this.oidCounter;
  }

  /** @internal Snapshot codec restore of the oid allocator. */
  restoreOidCounter(value: number): void {
    this.oidCounter = value;
  }
}
