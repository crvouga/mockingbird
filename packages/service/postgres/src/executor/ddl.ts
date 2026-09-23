import type {
  AlterEnumStmt,
  AlterIndexStmt,
  AlterSchemaStmt,
  AlterSequenceStmt,
  AlterTableStmt,
  AlterViewStmt,
  ColumnDef,
  CreateDomainStmt,
  CreateEnumStmt,
  CreateFunctionStmt,
  CreateIndexStmt,
  CreateSchemaStmt,
  CreateSequenceStmt,
  CreateTableAsStmt,
  CreateTableStmt,
  CreateTriggerStmt,
  CreateViewStmt,
  DropStmt,
  Expr,
  RefAction,
  RefreshMaterializedViewStmt,
  SequenceOptions,
  TableConstraint,
  TruncateStmt,
} from "../ast/nodes.ts";
import { checkChecks, checkForeignKeys, checkUnique, referencingConstraints } from "../constraints/enforce.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { sequenceNextval } from "../functions/misc-fns.ts";
import { parse } from "../parser/index.ts";
import {
  type ColumnMeta,
  type ConstraintMeta,
  SchemaData,
  type SequenceData,
  TableData,
} from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { resolveTypeName } from "../types/resolve.ts";
import { type Datum, type TypeId, tv, UNKNOWN } from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult, RowScope } from "./relation.ts";
import { evalScalar, executeSelectStmt } from "./select.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function targetSchema(env: ExecEnv, parts: string[]): { schema: SchemaData; name: string } {
  const state = env.ctx.state;
  if (parts.length >= 2) {
    return { schema: state.getSchema(parts[parts.length - 2]!), name: parts[parts.length - 1]! };
  }
  return { schema: state.getSchema(state.currentSchema()), name: parts[0]! };
}

function refActionText(a: RefAction): string | null {
  return a;
}

function constraintNames(table: TableData): Set<string> {
  return new Set(table.constraints.map((c) => c.name));
}

function makeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const MAX_IDENT = 63;

function truncIdent(s: string): string {
  return s.length > MAX_IDENT ? s.slice(0, MAX_IDENT) : s;
}

// ---------------------------------------------------------------------------
// sequences
// ---------------------------------------------------------------------------

const SEQ_LIMITS: Record<string, { min: bigint; max: bigint }> = {
  int2: { min: -32768n, max: 32767n },
  int4: { min: -2147483648n, max: 2147483647n },
  int8: { min: -9223372036854775808n, max: 9223372036854775807n },
};

export function buildSequence(
  env: ExecEnv,
  schema: SchemaData,
  name: string,
  options: SequenceOptions,
  temp: boolean,
): SequenceData {
  const state = env.ctx.state;
  let dataType: TypeId = "int8";
  if (options.as) {
    const resolved = resolveTypeName(state, options.as);
    if (resolved.column.id !== "int2" && resolved.column.id !== "int4" && resolved.column.id !== "int8") {
      throw pgError("invalid_parameter_value", `sequence type must be smallint, integer, or bigint`, "22023");
    }
    dataType = resolved.column.id;
  }
  const limits = SEQ_LIMITS[dataType]!;
  const increment = options.increment ?? 1n;
  if (increment === 0n) {
    throw pgError("invalid_parameter_value", "INCREMENT must not be zero", "22023");
  }
  const ascending = increment > 0n;
  const minValue =
    options.minValue === "no" || options.minValue === undefined ? (ascending ? 1n : limits.min) : options.minValue;
  const maxValue =
    options.maxValue === "no" || options.maxValue === undefined ? (ascending ? limits.max : -1n) : options.maxValue;
  const startValue = options.start ?? (ascending ? minValue : maxValue);
  if (startValue < minValue || startValue > maxValue) {
    throw pgError(
      "invalid_parameter_value",
      `START value (${startValue}) cannot be ${startValue < minValue ? "less than MINVALUE" : "greater than MAXVALUE"} (${startValue < minValue ? minValue : maxValue})`,
      "22023",
    );
  }
  return {
    name,
    schema: schema.name,
    increment,
    minValue,
    maxValue,
    startValue,
    cache: options.cache ?? 1n,
    cycle: options.cycle ?? false,
    lastValue: startValue,
    isCalled: false,
    ownedBy:
      options.ownedBy && options.ownedBy !== "none"
        ? {
            table: options.ownedBy[options.ownedBy.length - 2] ?? "",
            column: options.ownedBy[options.ownedBy.length - 1]!,
          }
        : null,
    dataType,
    temp,
    oid: state.nextOid(),
  };
}

export function executeCreateSequence(env: ExecEnv, stmt: CreateSequenceStmt): ExecResult {
  const { schema, name } = targetSchema(env, stmt.name);
  if (schema.hasRelation(name)) {
    if (stmt.ifNotExists) return commandResult("CREATE SEQUENCE", 0);
    throw pgError("duplicate_table", `relation "${name}" already exists`, "42P07");
  }
  schema.sequences.set(name, buildSequence(env, schema, name, stmt.options, stmt.temp));
  return commandResult("CREATE SEQUENCE", 0);
}

export function executeAlterSequence(env: ExecEnv, stmt: AlterSequenceStmt): ExecResult {
  const state = env.ctx.state;
  const seq = state.findSequence(stmt.name);
  if (!seq) {
    if (stmt.ifExists) return commandResult("ALTER SEQUENCE", 0);
    throw pgError("undefined_table", `relation "${stmt.name.join(".")}" does not exist`, "42P01");
  }
  const o = stmt.options;
  if (o.increment !== undefined) seq.increment = o.increment;
  if (o.minValue !== undefined)
    seq.minValue = o.minValue === "no" ? (seq.increment > 0n ? 1n : SEQ_LIMITS[seq.dataType]!.min) : o.minValue;
  if (o.maxValue !== undefined)
    seq.maxValue = o.maxValue === "no" ? (seq.increment > 0n ? SEQ_LIMITS[seq.dataType]!.max : -1n) : o.maxValue;
  if (o.start !== undefined) seq.startValue = o.start;
  if (o.cache !== undefined) seq.cache = o.cache;
  if (o.cycle !== undefined) seq.cycle = o.cycle;
  if (o.ownedBy !== undefined) {
    seq.ownedBy =
      o.ownedBy === "none"
        ? null
        : { table: o.ownedBy[o.ownedBy.length - 2] ?? "", column: o.ownedBy[o.ownedBy.length - 1]! };
  }
  if (o.restart !== undefined) {
    seq.lastValue = o.restart === "default" ? seq.startValue : o.restart;
    seq.isCalled = false;
  }
  if (o.as) {
    const resolved = resolveTypeName(state, o.as);
    seq.dataType = resolved.column.id;
  }
  return commandResult("ALTER SEQUENCE", 0);
}

// ---------------------------------------------------------------------------
// CREATE TABLE
// ---------------------------------------------------------------------------

interface BuiltColumns {
  columns: ColumnMeta[];
  constraints: ConstraintMeta[];
  /** sequences to create (serial / identity backing) */
  sequences: SequenceData[];
}

function buildColumn(
  env: ExecEnv,
  schema: SchemaData,
  tableName: string,
  def: ColumnDef,
  out: BuiltColumns,
  taken: Set<string>,
): ColumnMeta {
  const state = env.ctx.state;
  const resolved = resolveTypeName(state, def.typeName);
  const col: ColumnMeta = {
    name: def.name,
    type: resolved.column,
    notNull: false,
    defaultExpr: null,
    identity: null,
    generated: null,
    collate: null,
    domain: resolved.domain,
  };
  if (resolved.domain) {
    const domain = state.findDomain(resolved.domain.split("."));
    if (domain?.notNull) col.notNull = true;
    if (domain?.defaultExpr && !def.constraints.some((c) => c.kind === "default")) {
      col.defaultExpr = domain.defaultExpr;
    }
  }

  if (resolved.serial) {
    const seqName = truncIdent(`${tableName}_${def.name}_seq`);
    const seq = buildSequence(env, schema, seqName, {}, false);
    seq.dataType = resolved.serial;
    seq.maxValue = SEQ_LIMITS[resolved.serial]!.max;
    seq.ownedBy = { table: tableName, column: def.name };
    out.sequences.push(seq);
    col.notNull = true;
    col.defaultExpr = {
      type: "func",
      name: ["nextval"],
      args: [{ type: "string_lit", value: `${schema.name}.${seqName}` }],
    } as Expr;
  }

  for (const c of def.constraints) {
    switch (c.kind) {
      case "not_null":
        col.notNull = true;
        break;
      case "null":
        col.notNull = false;
        break;
      case "default":
        col.defaultExpr = c.expr;
        break;
      case "primary_key": {
        col.notNull = true;
        const name = makeName(truncIdent(`${tableName}_pkey`), taken);
        taken.add(name);
        out.constraints.push({ kind: "primary_key", name, columns: [def.name] });
        break;
      }
      case "unique": {
        const name = c.name ?? makeName(truncIdent(`${tableName}_${def.name}_key`), taken);
        taken.add(name);
        out.constraints.push({ kind: "unique", name, columns: [def.name], nullsNotDistinct: c.nullsNotDistinct });
        break;
      }
      case "check": {
        const name = c.name ?? makeName(truncIdent(`${tableName}_${def.name}_check`), taken);
        taken.add(name);
        out.constraints.push({ kind: "check", name, expr: c.expr });
        break;
      }
      case "references": {
        const refParts = c.table;
        const refTable = state.findTable(refParts);
        if (!refTable) {
          throw pgError("undefined_table", `relation "${refParts.join(".")}" does not exist`, "42P01");
        }
        const refColumns = c.columns ?? primaryKeyColumns(refTable);
        const name = c.name ?? makeName(truncIdent(`${tableName}_${def.name}_fkey`), taken);
        taken.add(name);
        out.constraints.push({
          kind: "foreign_key",
          name,
          columns: [def.name],
          refSchema: refTable.schema,
          refTable: refTable.name,
          refColumns,
          onDelete: refActionText(c.onDelete),
          onUpdate: refActionText(c.onUpdate),
          match: c.match === "full" ? "full" : "simple",
        });
        break;
      }
      case "generated_identity": {
        const seqName = truncIdent(`${tableName}_${def.name}_seq`);
        const seq = buildSequence(env, schema, seqName, c.options, false);
        if (!c.options.as) {
          seq.dataType =
            col.type.id === "int2" || col.type.id === "int4" || col.type.id === "int8" ? col.type.id : "int8";
          const limits = SEQ_LIMITS[seq.dataType]!;
          if (c.options.maxValue === undefined) seq.maxValue = seq.increment > 0n ? limits.max : -1n;
          if (c.options.minValue === undefined) seq.minValue = seq.increment > 0n ? 1n : limits.min;
        }
        seq.ownedBy = { table: tableName, column: def.name };
        out.sequences.push(seq);
        col.identity = { always: c.always, sequence: `${schema.name}.${seqName}` };
        col.notNull = true;
        break;
      }
      case "generated_stored":
        col.generated = c.expr;
        break;
      case "collate":
        col.collate = c.collation.join(".");
        break;
    }
  }
  return col;
}

function primaryKeyColumns(table: TableData): string[] {
  const pk = table.constraints.find((c) => c.kind === "primary_key");
  if (!pk) {
    throw pgError(
      "undefined_object",
      `there is no unique constraint matching given keys for referenced table "${table.name}"`,
      "42830",
    );
  }
  return pk.columns;
}

function buildTableConstraint(
  env: ExecEnv,
  tableName: string,
  columns: ColumnMeta[],
  con: TableConstraint,
  taken: Set<string>,
): ConstraintMeta {
  const state = env.ctx.state;
  const checkCols = (names: string[]) => {
    for (const n of names) {
      if (!columns.some((c) => c.name === n)) {
        throw pgError("undefined_column", `column "${n}" named in key does not exist`, "42703");
      }
    }
  };
  switch (con.kind) {
    case "primary_key": {
      checkCols(con.columns);
      const name = con.name ?? makeName(truncIdent(`${tableName}_pkey`), taken);
      taken.add(name);
      return { kind: "primary_key", name, columns: con.columns };
    }
    case "unique": {
      checkCols(con.columns);
      const name = con.name ?? makeName(truncIdent(`${tableName}_${con.columns.join("_")}_key`), taken);
      taken.add(name);
      return { kind: "unique", name, columns: con.columns, nullsNotDistinct: con.nullsNotDistinct };
    }
    case "check": {
      const name = con.name ?? makeName(truncIdent(`${tableName}_check`), taken);
      taken.add(name);
      return { kind: "check", name, expr: con.expr };
    }
    case "foreign_key": {
      checkCols(con.columns);
      const refTable = state.findTable(con.refTable);
      if (!refTable) {
        throw pgError("undefined_table", `relation "${con.refTable.join(".")}" does not exist`, "42P01");
      }
      const refColumns = con.refColumns ?? primaryKeyColumns(refTable);
      const name = con.name ?? makeName(truncIdent(`${tableName}_${con.columns.join("_")}_fkey`), taken);
      taken.add(name);
      return {
        kind: "foreign_key",
        name,
        columns: con.columns,
        refSchema: refTable.schema,
        refTable: refTable.name,
        refColumns,
        onDelete: refActionText(con.onDelete),
        onUpdate: refActionText(con.onUpdate),
        match: con.match === "full" ? "full" : "simple",
      };
    }
    case "exclude":
      throw unsupported("EXCLUDE constraints");
  }
}

export function executeCreateTable(env: ExecEnv, stmt: CreateTableStmt): ExecResult {
  const state = env.ctx.state;
  const { schema, name } = targetSchema(env, stmt.name);
  if (schema.hasRelation(name)) {
    if (stmt.ifNotExists) return commandResult("CREATE TABLE", 0);
    throw pgError("duplicate_table", `relation "${name}" already exists`, "42P07");
  }

  const built: BuiltColumns = { columns: [], constraints: [], sequences: [] };
  const taken = new Set<string>();

  // LIKE clauses first (columns come in order)
  for (const like of stmt.likeClauses) {
    const src = state.findTable(like.table);
    if (!src) {
      throw pgError("undefined_table", `relation "${like.table.join(".")}" does not exist`, "42P01");
    }
    const all = like.options.includes("all");
    const withDefaults = all || like.options.includes("defaults");
    const withConstraints = all || like.options.includes("constraints");
    for (const c of src.columns) {
      built.columns.push({
        ...c,
        defaultExpr: withDefaults ? c.defaultExpr : null,
        identity: null,
        generated: like.options.includes("generated") || all ? c.generated : null,
      });
    }
    if (withConstraints) {
      for (const con of src.constraints) {
        if (con.kind === "check") {
          const cname = makeName(con.name, taken);
          taken.add(cname);
          built.constraints.push({ ...con, name: cname });
        }
      }
    }
  }

  const seen = new Set(built.columns.map((c) => c.name));
  for (const def of stmt.columns) {
    if (seen.has(def.name)) {
      throw pgError("duplicate_column", `column "${def.name}" specified more than once`, "42701");
    }
    seen.add(def.name);
    built.columns.push(buildColumn(env, schema, name, def, built, taken));
  }
  for (const con of stmt.constraints) {
    built.constraints.push(buildTableConstraint(env, name, built.columns, con, taken));
  }

  // PK columns are NOT NULL
  for (const con of built.constraints) {
    if (con.kind === "primary_key") {
      for (const cn of con.columns) {
        const col = built.columns.find((c) => c.name === cn);
        if (col) col.notNull = true;
      }
    }
  }
  const pkCount = built.constraints.filter((c) => c.kind === "primary_key").length;
  if (pkCount > 1) {
    throw pgError("invalid_table_definition", `multiple primary keys for table "${name}" are not allowed`, "42P16");
  }

  for (const seq of built.sequences) {
    if (schema.hasRelation(seq.name)) {
      throw pgError("duplicate_table", `relation "${seq.name}" already exists`, "42P07");
    }
    schema.sequences.set(seq.name, seq);
  }
  const table = new TableData(schema.name, name, built.columns, state.nextOid(), stmt.temp);
  table.constraints = built.constraints;
  schema.tables.set(name, table);
  return commandResult("CREATE TABLE", 0);
}

export function executeCreateTableAs(env: ExecEnv, stmt: CreateTableAsStmt): ExecResult {
  const state = env.ctx.state;
  const { schema, name } = targetSchema(env, stmt.name);
  if (schema.hasRelation(name)) {
    if (stmt.ifNotExists) return commandResult("CREATE TABLE AS", 0);
    throw pgError("duplicate_table", `relation "${name}" already exists`, "42P07");
  }
  const rel = executeSelectStmt(env, stmt.query);
  const columns: ColumnMeta[] = rel.columns.map((c, i) => ({
    name: stmt.columns?.[i] ?? c.name,
    type: { id: c.type === UNKNOWN ? "text" : c.type, mod: null },
    notNull: false,
    defaultExpr: null,
    identity: null,
    generated: null,
    collate: null,
    domain: null,
  }));
  const table = new TableData(schema.name, name, columns, state.nextOid(), stmt.temp);
  if (stmt.withData) {
    for (const row of rel.rows) table.mutableRows().push(row.slice());
  }
  schema.tables.set(name, table);
  const count = stmt.withData ? table.rowCount() : 0;
  return { columns: [], rows: [], command: `SELECT ${count}`, rowCount: count };
}

// ---------------------------------------------------------------------------
// CREATE INDEX / VIEW / SCHEMA / ENUM / DOMAIN / FUNCTION / TRIGGER
// ---------------------------------------------------------------------------

export function executeCreateIndex(env: ExecEnv, stmt: CreateIndexStmt): ExecResult {
  const state = env.ctx.state;
  const table = state.findTable(stmt.table);
  if (!table) {
    throw pgError("undefined_table", `relation "${stmt.table.join(".")}" does not exist`, "42P01");
  }
  const schema = state.getSchema(table.schema);
  const taken = new Set<string>([...schema.indexes.keys(), ...constraintNames(table)]);
  const colPart = stmt.columns
    .map((c) => (c.expr.type === "colref" ? c.expr.parts[c.expr.parts.length - 1]! : "expr"))
    .join("_");
  const name = stmt.name ?? makeName(truncIdent(`${table.name}_${colPart}_idx`), taken);
  if (schema.indexes.has(name) || schema.hasRelation(name)) {
    if (stmt.ifNotExists) return commandResult("CREATE INDEX", 0);
    throw pgError("duplicate_table", `relation "${name}" already exists`, "42P07");
  }
  for (const c of stmt.columns) {
    if (c.expr.type === "colref" && c.expr.parts.length === 1) {
      if (table.columnIndex(c.expr.parts[0]!) === -1) {
        throw pgError("undefined_column", `column "${c.expr.parts[0]}" does not exist`, "42703");
      }
    }
  }
  schema.indexes.set(name, {
    name,
    schema: schema.name,
    table: table.name,
    unique: stmt.unique,
    columns: stmt.columns.map((c) => ({
      column: c.expr.type === "colref" && c.expr.parts.length === 1 ? c.expr.parts[0]! : null,
      expr: c.expr.type === "colref" && c.expr.parts.length === 1 ? null : c.expr,
      dir: c.dir ?? "asc",
      nulls: c.nulls ?? ((c.dir ?? "asc") === "desc" ? "first" : "last"),
    })),
    where: stmt.where,
    nullsNotDistinct: stmt.nullsNotDistinct,
    isConstraint: false,
  });
  // unique index: validate existing rows
  if (stmt.unique) {
    try {
      for (let i = 0; i < table.rowCount(); i++) {
        checkUnique(env, table, table.rowAt(i), i);
      }
    } catch (err) {
      schema.indexes.delete(name);
      throw err;
    }
  }
  return commandResult("CREATE INDEX", 0);
}

export function executeCreateView(env: ExecEnv, stmt: CreateViewStmt): ExecResult {
  const state = env.ctx.state;
  const { schema, name } = targetSchema(env, stmt.name);
  const existing = schema.views.get(name);
  if (schema.hasRelation(name) && !(existing && stmt.orReplace && !stmt.materialized)) {
    throw pgError("duplicate_table", `relation "${name}" already exists`, "42P07");
  }
  if (existing && stmt.orReplace) {
    // OR REPLACE must keep the original column names/count prefix
    const oldRel = executeSelectStmt({ ctx: env.ctx, params: null, ctes: new Map(), outer: null }, existing.query);
    const newRel = executeSelectStmt({ ctx: env.ctx, params: null, ctes: new Map(), outer: null }, stmt.query);
    if (newRel.columns.length < oldRel.columns.length) {
      throw pgError("invalid_table_definition", `cannot drop columns from view`, "42P16");
    }
  }
  let matRows: Datum[][] | null = null;
  let matColumns: Array<{ name: string; type: TypeId }> | null = null;
  if (stmt.materialized) {
    const rel = executeSelectStmt({ ctx: env.ctx, params: null, ctes: new Map(), outer: null }, stmt.query);
    matColumns = rel.columns.map((c, i) => ({
      name: stmt.columns?.[i] ?? c.name,
      type: c.type === UNKNOWN ? "text" : c.type,
    }));
    matRows = stmt.withData ? rel.rows : null;
  }
  schema.views.set(name, {
    name,
    schema: schema.name,
    query: stmt.query,
    columns: stmt.columns,
    materialized: stmt.materialized,
    matRows,
    matColumns,
    temp: stmt.temp,
    oid: existing?.oid ?? state.nextOid(),
  });
  return commandResult(stmt.materialized ? "CREATE MATERIALIZED VIEW" : "CREATE VIEW", 0);
}

export function executeRefreshMatView(env: ExecEnv, stmt: RefreshMaterializedViewStmt): ExecResult {
  const found = env.ctx.state.findView(stmt.name);
  if (!found?.materialized) {
    throw pgError("undefined_table", `materialized view "${stmt.name.join(".")}" does not exist`, "42P01");
  }
  const view = env.ctx.state.ensureWritableView(found);
  const rel = executeSelectStmt({ ctx: env.ctx, params: null, ctes: new Map(), outer: null }, view.query);
  view.matColumns = rel.columns.map((c, i) => ({
    name: view.columns?.[i] ?? c.name,
    type: c.type === UNKNOWN ? "text" : c.type,
  }));
  view.matRows = stmt.withData ? rel.rows : null;
  return commandResult("REFRESH MATERIALIZED VIEW", 0);
}

export function executeCreateSchema(env: ExecEnv, stmt: CreateSchemaStmt): ExecResult {
  const state = env.ctx.state;
  if (state.schemas.has(stmt.name)) {
    if (stmt.ifNotExists) return commandResult("CREATE SCHEMA", 0);
    throw pgError("duplicate_schema", `schema "${stmt.name}" already exists`, "42P06");
  }
  state.schemas.set(stmt.name, new SchemaData(stmt.name, state.nextOid()));
  return commandResult("CREATE SCHEMA", 0);
}

export function executeCreateEnum(env: ExecEnv, stmt: CreateEnumStmt): ExecResult {
  const state = env.ctx.state;
  const { schema, name } = targetSchema(env, stmt.name);
  if (schema.enums.has(name) || schema.domains.has(name)) {
    throw pgError("duplicate_object", `type "${name}" already exists`, "42710");
  }
  schema.enums.set(name, { name, schema: schema.name, labels: [...stmt.labels], oid: state.nextOid() });
  return commandResult("CREATE TYPE", 0);
}

export function executeAlterEnum(env: ExecEnv, stmt: AlterEnumStmt): ExecResult {
  const found = env.ctx.state.findEnum(stmt.name);
  if (!found) {
    throw pgError("undefined_object", `type "${stmt.name.join(".")}" does not exist`, "42704");
  }
  const e = env.ctx.state.ensureWritableEnum(found);
  const a = stmt.action;
  if (a.kind === "add_value") {
    if (e.labels.includes(a.label)) {
      if (a.ifNotExists) return commandResult("ALTER TYPE", 0);
      throw pgError("duplicate_object", `enum label "${a.label}" already exists`, "42710");
    }
    if (a.before) {
      const i = e.labels.indexOf(a.before);
      if (i === -1) throw pgError("undefined_object", `"${a.before}" is not an existing enum label`, "42704");
      e.labels.splice(i, 0, a.label);
    } else if (a.after) {
      const i = e.labels.indexOf(a.after);
      if (i === -1) throw pgError("undefined_object", `"${a.after}" is not an existing enum label`, "42704");
      e.labels.splice(i + 1, 0, a.label);
    } else {
      e.labels.push(a.label);
    }
  } else {
    const i = e.labels.indexOf(a.from);
    if (i === -1) throw pgError("undefined_object", `"${a.from}" is not an existing enum label`, "42704");
    if (e.labels.includes(a.to)) {
      throw pgError("duplicate_object", `enum label "${a.to}" already exists`, "42710");
    }
    e.labels[i] = a.to;
  }
  return commandResult("ALTER TYPE", 0);
}

export function executeCreateDomain(env: ExecEnv, stmt: CreateDomainStmt): ExecResult {
  const state = env.ctx.state;
  const { schema, name } = targetSchema(env, stmt.name);
  if (schema.domains.has(name) || schema.enums.has(name)) {
    throw pgError("duplicate_object", `type "${name}" already exists`, "42710");
  }
  const resolved = resolveTypeName(state, stmt.baseType);
  let checkIdx = 0;
  schema.domains.set(name, {
    name,
    schema: schema.name,
    baseType: resolved.column,
    notNull: stmt.notNull,
    defaultExpr: stmt.defaultExpr,
    checks: stmt.checks.map((c) => ({
      name: c.name ?? `${name}_check${checkIdx++ === 0 ? "" : checkIdx - 1}`,
      expr: c.expr,
    })),
    oid: state.nextOid(),
  });
  return commandResult("CREATE DOMAIN", 0);
}

export function executeCreateFunction(env: ExecEnv, stmt: CreateFunctionStmt): ExecResult {
  const state = env.ctx.state;
  const { schema, name } = targetSchema(env, stmt.name);
  const lang = stmt.language.toLowerCase();
  if (lang !== "sql" && lang !== "plpgsql") {
    throw unsupported(`LANGUAGE ${stmt.language} functions`);
  }
  const argTypes = stmt.args
    .filter((a) => a.mode === "in" || a.mode === "inout" || a.mode === "variadic")
    .map((a) => resolveTypeName(state, a.typeName).column.id);
  const argNames = stmt.args
    .filter((a) => a.mode === "in" || a.mode === "inout" || a.mode === "variadic")
    .map((a) => a.name);
  const argDefaults = stmt.args
    .filter((a) => a.mode === "in" || a.mode === "inout" || a.mode === "variadic")
    .map((a) => a.defaultExpr);

  let returns: TypeId | null = null;
  let returnsSet = false;
  let returnsTable: Array<{ name: string; type: TypeId }> | null = null;
  if (stmt.returnsTable) {
    returnsTable = stmt.returnsTable.map((c) => ({ name: c.name, type: resolveTypeName(state, c.typeName).column.id }));
    returnsSet = true;
  } else if (stmt.returns) {
    const parts = stmt.returns.parts;
    const bare = parts.length === 1 ? parts[0]! : null;
    if (bare === "trigger") {
      returns = "trigger" as TypeId;
    } else if (bare === "void") {
      returns = "void";
    } else if (bare === "setof") {
      // handled by parser as setof flag — should not occur
      throw unsupported("RETURNS SETOF parse form");
    } else {
      // RETURNS [SETOF] <table> — a table name is a composite row type
      const compositeTable = state.findTable(stmt.returns.parts);
      if (compositeTable) {
        returnsTable = compositeTable.columns.map((c) => ({ name: c.name, type: c.type.id }));
        returnsSet = stmt.returns.setof === true;
      } else {
        returns = resolveTypeName(state, stmt.returns).column.id;
        returnsSet = stmt.returns.setof === true;
      }
    }
  }

  let body: import("../ast/nodes.ts").Statement[] | null = stmt.sqlBody;
  if (body === null && stmt.body !== null && lang === "sql") {
    body = parse(stmt.body);
  }

  const existing = schema.functions.get(name) ?? [];
  const sameSig = existing.findIndex((f) => f.argTypes.length === argTypes.length);
  if (sameSig !== -1 && !stmt.orReplace) {
    throw pgError("duplicate_function", `function "${name}" already exists with same argument types`, "42723");
  }
  const fn = {
    name,
    schema: schema.name,
    argNames,
    argTypes,
    argDefaults,
    returns,
    returnsSet,
    returnsTable,
    language: lang,
    body,
    rawBody: stmt.body,
    strict: stmt.strict,
    oid: state.nextOid(),
  };
  if (sameSig !== -1) existing[sameSig] = fn;
  else existing.push(fn);
  schema.functions.set(name, existing);
  return commandResult("CREATE FUNCTION", 0);
}

export function executeCreateTrigger(env: ExecEnv, stmt: CreateTriggerStmt): ExecResult {
  const state = env.ctx.state;
  const found = state.findTable(stmt.table);
  if (!found) {
    throw pgError("undefined_table", `relation "${stmt.table.join(".")}" does not exist`, "42P01");
  }
  const table = state.ensureWritableTable(found);
  const fnSchema = stmt.funcName.length >= 2 ? stmt.funcName[stmt.funcName.length - 2]! : null;
  const fnName = stmt.funcName[stmt.funcName.length - 1]!;
  const fns = state.findFunctions(stmt.funcName);
  if (fns.length === 0) {
    throw pgError("undefined_function", `function ${stmt.funcName.join(".")}() does not exist`, "42883");
  }
  const existing = table.triggers.findIndex((t) => t.name === stmt.name);
  if (existing !== -1 && !stmt.orReplace) {
    throw pgError("duplicate_object", `trigger "${stmt.name}" for relation "${table.name}" already exists`, "42710");
  }
  const meta = {
    name: stmt.name,
    timing: stmt.timing,
    events: stmt.events,
    forEachRow: stmt.forEachRow,
    when: stmt.when,
    funcSchema: fnSchema ?? fns[0]!.schema,
    funcName: fnName,
    funcArgs: stmt.funcArgs,
  };
  if (existing !== -1) table.triggers[existing] = meta;
  else table.triggers.push(meta);
  return commandResult("CREATE TRIGGER", 0);
}

// ---------------------------------------------------------------------------
// ALTER TABLE
// ---------------------------------------------------------------------------

export function executeAlterTable(env: ExecEnv, stmt: AlterTableStmt): ExecResult {
  const state = env.ctx.state;
  const found = state.findTable(stmt.table);
  if (!found) {
    if (stmt.ifExists) return commandResult("ALTER TABLE", 0);
    // maybe it's a view rename etc.
    throw pgError("undefined_table", `relation "${stmt.table.join(".")}" does not exist`, "42P01");
  }
  const table = state.ensureWritableTable(found);
  const schema = state.getSchema(table.schema);

  for (const action of stmt.actions) {
    const rows = table.mutableRows();
    switch (action.kind) {
      case "add_column": {
        if (table.columnIndex(action.column.name) !== -1) {
          if (action.ifNotExists) break;
          throw pgError(
            "duplicate_column",
            `column "${action.column.name}" of relation "${table.name}" already exists`,
            "42701",
          );
        }
        const built: BuiltColumns = { columns: [], constraints: [], sequences: [] };
        const taken = constraintNames(table);
        const col = buildColumn(env, schema, table.name, action.column, built, taken);
        for (const seq of built.sequences) schema.sequences.set(seq.name, seq);
        table.columns.push(col);
        table.constraints.push(...built.constraints);
        // fill the new column for existing rows
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          let v: Datum = null;
          if (col.identity) {
            const seq = state.findSequence(col.identity.sequence.split("."));
            if (seq) v = castTo(env.ctx, tv("int8", seqNext(env, seq)), col.type.id, {}).v;
          } else if (col.defaultExpr) {
            v = castTo(env.ctx, evalScalar(env, null, col.defaultExpr), col.type.id, {
              assignment: true,
              mod: col.type.mod,
            }).v;
          }
          row.push(v);
        }
        if (col.generated) {
          for (const row of rows) {
            const idx = table.columnIndex(col.name);
            const scope = tableScopeFor(env, table, row);
            row[idx] = castTo(env.ctx, evalScalar(env, scope, col.generated), col.type.id, { assignment: true }).v;
          }
        }
        if (col.notNull) {
          for (const row of rows) {
            if ((row[table.columnIndex(col.name)] ?? null) === null) {
              throw pgError(
                "not_null_violation",
                `column "${col.name}" of relation "${table.name}" contains null values`,
                "23502",
              );
            }
          }
        }
        break;
      }
      case "drop_column": {
        const idx = table.columnIndex(action.name);
        if (idx === -1) {
          if (action.ifExists) break;
          throw pgError(
            "undefined_column",
            `column "${action.name}" of relation "${table.name}" does not exist`,
            "42703",
          );
        }
        const used = table.constraints.filter(
          (c) =>
            (c.kind === "primary_key" || c.kind === "unique" || c.kind === "foreign_key") &&
            c.columns.includes(action.name),
        );
        if (used.length > 0 && !action.cascade) {
          // PG drops single-column constraints silently; multi-column requires cascade
          const multi = used.filter((c) => (c as { columns: string[] }).columns.length > 1);
          if (multi.length > 0) {
            throw pgError(
              "dependent_objects",
              `cannot drop column ${action.name} of table ${table.name} because other objects depend on it`,
              "2BP01",
            );
          }
        }
        table.constraints = table.constraints.filter((c) => {
          if (
            (c.kind === "primary_key" || c.kind === "unique" || c.kind === "foreign_key") &&
            c.columns.includes(action.name)
          ) {
            return false;
          }
          return true;
        });
        table.columns.splice(idx, 1);
        for (const row of rows) row.splice(idx, 1);
        // drop indexes referencing the column
        for (const [iname, idxMeta] of [...schema.indexes]) {
          if (idxMeta.table === table.name && idxMeta.columns.some((c) => c.column === action.name)) {
            schema.indexes.delete(iname);
          }
        }
        break;
      }
      case "alter_type": {
        const idx = table.columnIndex(action.column);
        if (idx === -1) {
          throw pgError(
            "undefined_column",
            `column "${action.column}" of relation "${table.name}" does not exist`,
            "42703",
          );
        }
        const resolved = resolveTypeName(state, action.typeName);
        const col = table.columns[idx]!;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const old = row[idx] ?? null;
          let nv: Datum;
          if (action.using) {
            const scope = tableScopeFor(env, table, row);
            nv = castTo(env.ctx, evalScalar(env, scope, action.using), resolved.column.id, {
              explicit: true,
              mod: resolved.column.mod,
            }).v;
          } else if (old === null) {
            nv = null;
          } else {
            nv = castTo(env.ctx, tv(col.type.id, old), resolved.column.id, {
              explicit: false,
              assignment: true,
              mod: resolved.column.mod,
            }).v;
          }
          const next = row.slice();
          next[idx] = nv;
          rows[i] = next;
        }
        col.type = resolved.column;
        col.domain = resolved.domain;
        break;
      }
      case "set_default": {
        const idx = table.columnIndex(action.column);
        if (idx === -1) {
          throw pgError(
            "undefined_column",
            `column "${action.column}" of relation "${table.name}" does not exist`,
            "42703",
          );
        }
        table.columns[idx]!.defaultExpr = action.expr;
        break;
      }
      case "drop_default": {
        const idx = table.columnIndex(action.column);
        if (idx === -1) {
          throw pgError(
            "undefined_column",
            `column "${action.column}" of relation "${table.name}" does not exist`,
            "42703",
          );
        }
        table.columns[idx]!.defaultExpr = null;
        break;
      }
      case "set_not_null": {
        const idx = table.columnIndex(action.column);
        if (idx === -1) {
          throw pgError(
            "undefined_column",
            `column "${action.column}" of relation "${table.name}" does not exist`,
            "42703",
          );
        }
        for (const row of rows) {
          if ((row[idx] ?? null) === null) {
            throw pgError(
              "not_null_violation",
              `column "${action.column}" of relation "${table.name}" contains null values`,
              "23502",
            );
          }
        }
        table.columns[idx]!.notNull = true;
        break;
      }
      case "drop_not_null": {
        const idx = table.columnIndex(action.column);
        if (idx === -1) {
          throw pgError(
            "undefined_column",
            `column "${action.column}" of relation "${table.name}" does not exist`,
            "42703",
          );
        }
        table.columns[idx]!.notNull = false;
        break;
      }
      case "add_constraint": {
        const taken = constraintNames(table);
        const con = buildTableConstraint(env, table.name, table.columns, action.constraint, taken);
        if (con.kind === "primary_key") {
          if (table.constraints.some((c) => c.kind === "primary_key")) {
            throw pgError(
              "invalid_table_definition",
              `multiple primary keys for table "${table.name}" are not allowed`,
              "42P16",
            );
          }
          for (const cn of con.columns) {
            const col = table.columns[table.columnIndex(cn)]!;
            for (const row of rows) {
              if ((row[table.columnIndex(cn)] ?? null) === null) {
                throw pgError(
                  "not_null_violation",
                  `column "${cn}" of relation "${table.name}" contains null values`,
                  "23502",
                );
              }
            }
            col.notNull = true;
          }
        }
        table.constraints.push(con);
        if (!action.skipValidation) {
          try {
            validateConstraint(env, table, con);
          } catch (err) {
            table.constraints.pop();
            throw err;
          }
        }
        break;
      }
      case "drop_constraint": {
        const idx = table.constraints.findIndex((c) => c.name === action.name);
        if (idx === -1) {
          if (action.ifExists) break;
          throw pgError(
            "undefined_object",
            `constraint "${action.name}" of relation "${table.name}" does not exist`,
            "42704",
          );
        }
        table.constraints.splice(idx, 1);
        break;
      }
      case "rename_column": {
        const idx = table.columnIndex(action.from);
        if (idx === -1) {
          throw pgError("undefined_column", `column "${action.from}" does not exist`, "42703");
        }
        if (table.columnIndex(action.to) !== -1) {
          throw pgError(
            "duplicate_column",
            `column "${action.to}" of relation "${table.name}" already exists`,
            "42701",
          );
        }
        table.columns[idx]!.name = action.to;
        // update constraint column lists
        for (const con of table.constraints) {
          if (con.kind === "primary_key" || con.kind === "unique" || con.kind === "foreign_key") {
            con.columns = con.columns.map((c) => (c === action.from ? action.to : c));
          }
        }
        for (const idxMeta of schema.indexes.values()) {
          if (idxMeta.table === table.name) {
            for (const c of idxMeta.columns) {
              if (c.column === action.from) c.column = action.to;
            }
          }
        }
        break;
      }
      case "rename_constraint": {
        const con = table.constraints.find((c) => c.name === action.from);
        if (!con) {
          throw pgError(
            "undefined_object",
            `constraint "${action.from}" for table "${table.name}" does not exist`,
            "42704",
          );
        }
        con.name = action.to;
        break;
      }
      case "rename_table": {
        if (schema.hasRelation(action.to)) {
          throw pgError("duplicate_table", `relation "${action.to}" already exists`, "42P07");
        }
        const oldName = table.name;
        schema.tables.delete(table.name);
        table.name = action.to;
        schema.tables.set(action.to, table);
        // update FK references
        for (const s of state.schemas.values()) {
          for (const t of s.tables.values()) {
            for (const con of t.constraints) {
              if (con.kind === "foreign_key" && con.refSchema === schema.name && con.refTable === oldName) {
                con.refTable = action.to;
              }
            }
          }
        }
        for (const idxMeta of schema.indexes.values()) {
          if (idxMeta.table === oldName) idxMeta.table = action.to;
        }
        break;
      }
      case "set_schema": {
        const dest = state.getSchema(action.to);
        if (dest.hasRelation(table.name)) {
          throw pgError("duplicate_table", `relation "${table.name}" already exists in schema "${action.to}"`, "42P07");
        }
        schema.tables.delete(table.name);
        const oldSchema = table.schema;
        table.schema = action.to;
        dest.tables.set(table.name, table);
        for (const s of state.schemas.values()) {
          for (const t of s.tables.values()) {
            for (const con of t.constraints) {
              if (con.kind === "foreign_key" && con.refSchema === oldSchema && con.refTable === table.name) {
                con.refSchema = action.to;
              }
            }
          }
        }
        break;
      }
      case "owner_to":
        break; // no-op
      case "add_identity": {
        const idx = table.columnIndex(action.column);
        if (idx === -1) {
          throw pgError(
            "undefined_column",
            `column "${action.column}" of relation "${table.name}" does not exist`,
            "42703",
          );
        }
        const col = table.columns[idx]!;
        if (col.identity) {
          throw pgError(
            "invalid_table_definition",
            `column "${action.column}" of relation "${table.name}" is already an identity column`,
            "42P16",
          );
        }
        const seqName = truncIdent(`${table.name}_${action.column}_seq`);
        const seq = buildSequence(env, schema, seqName, action.options, false);
        seq.ownedBy = { table: table.name, column: action.column };
        schema.sequences.set(seqName, seq);
        col.identity = { always: true, sequence: `${schema.name}.${seqName}` };
        col.notNull = true;
        break;
      }
      case "drop_identity": {
        const idx = table.columnIndex(action.column);
        if (idx === -1) {
          throw pgError(
            "undefined_column",
            `column "${action.column}" of relation "${table.name}" does not exist`,
            "42703",
          );
        }
        const col = table.columns[idx]!;
        if (!col.identity) {
          if (action.ifExists) break;
          throw pgError(
            "invalid_table_definition",
            `column "${action.column}" of relation "${table.name}" is not an identity column`,
            "42P16",
          );
        }
        const seqParts = col.identity.sequence.split(".");
        state.schemas.get(seqParts[0]!)?.sequences.delete(seqParts[1]!);
        col.identity = null;
        break;
      }
      case "validate_constraint": {
        const con = table.constraints.find((c) => c.name === action.name);
        if (!con) {
          throw pgError(
            "undefined_object",
            `constraint "${action.name}" for table "${table.name}" does not exist`,
            "42704",
          );
        }
        validateConstraint(env, table, con);
        break;
      }
      case "reloptions":
        break;
    }
  }
  return commandResult("ALTER TABLE", 0);
}

function tableScopeFor(env: ExecEnv, table: TableData, row: Datum[]): RowScope {
  void env;
  const cols = table.columns.map((c) => ({ name: c.name, type: c.type.id, table: table.name }));
  return new RowScope(cols, row, null, new Set([table.name]));
}

function seqNext(env: ExecEnv, seq: SequenceData): bigint {
  return sequenceNextval(env.ctx, seq);
}

function validateConstraint(env: ExecEnv, table: TableData, con: ConstraintMeta): void {
  void con;
  for (let i = 0; i < table.rowCount(); i++) {
    const row = table.rowAt(i);
    checkChecks(env, table, row);
    checkUnique(env, table, row, i);
    checkForeignKeys(env, table, row);
  }
}

// ---------------------------------------------------------------------------
// ALTER VIEW / INDEX / SCHEMA
// ---------------------------------------------------------------------------

export function executeAlterView(env: ExecEnv, stmt: AlterViewStmt): ExecResult {
  const state = env.ctx.state;
  const view = state.findView(stmt.name);
  if (!view) {
    if (stmt.ifExists) return commandResult("ALTER VIEW", 0);
    throw pgError("undefined_table", `relation "${stmt.name.join(".")}" does not exist`, "42P01");
  }
  const schema = state.getSchema(view.schema);
  if (stmt.action.kind === "rename_table") {
    if (schema.hasRelation(stmt.action.to)) {
      throw pgError("duplicate_table", `relation "${stmt.action.to}" already exists`, "42P07");
    }
    schema.views.delete(view.name);
    view.name = stmt.action.to;
    schema.views.set(view.name, view);
  } else {
    const dest = state.getSchema(stmt.action.to);
    schema.views.delete(view.name);
    view.schema = stmt.action.to;
    dest.views.set(view.name, view);
  }
  return commandResult("ALTER VIEW", 0);
}

export function executeAlterIndex(env: ExecEnv, stmt: AlterIndexStmt): ExecResult {
  const state = env.ctx.state;
  const parts = stmt.name;
  const schemaName = parts.length >= 2 ? parts[parts.length - 2]! : null;
  const idxName = parts[parts.length - 1]!;
  let schema: SchemaData | null = null;
  if (schemaName) {
    schema = state.schemas.get(schemaName) ?? null;
  } else {
    for (const s of state.effectiveSearchPath()) {
      if (state.schemas.get(s)?.indexes.has(idxName)) {
        schema = state.schemas.get(s)!;
        break;
      }
    }
  }
  const idx = schema?.indexes.get(idxName);
  if (!schema || !idx) {
    if (stmt.ifExists) return commandResult("ALTER INDEX", 0);
    throw pgError("undefined_table", `relation "${stmt.name.join(".")}" does not exist`, "42P01");
  }
  schema.indexes.delete(idxName);
  idx.name = stmt.action.to;
  schema.indexes.set(idx.name, idx);
  return commandResult("ALTER INDEX", 0);
}

export function executeAlterSchema(env: ExecEnv, stmt: AlterSchemaStmt): ExecResult {
  const state = env.ctx.state;
  const schema = state.schemas.get(stmt.name);
  if (!schema) {
    throw pgError("undefined_object", `schema "${stmt.name}" does not exist`, "3F000");
  }
  if (state.schemas.has(stmt.action.to)) {
    throw pgError("duplicate_schema", `schema "${stmt.action.to}" already exists`, "42P06");
  }
  state.schemas.delete(stmt.name);
  schema.name = stmt.action.to;
  for (const t of schema.tables.values()) t.schema = stmt.action.to;
  for (const v of schema.views.values()) v.schema = stmt.action.to;
  for (const s of schema.sequences.values()) s.schema = stmt.action.to;
  state.schemas.set(stmt.action.to, schema);
  return commandResult("ALTER SCHEMA", 0);
}

// ---------------------------------------------------------------------------
// DROP / TRUNCATE
// ---------------------------------------------------------------------------

export function executeDrop(env: ExecEnv, stmt: DropStmt): ExecResult {
  const state = env.ctx.state;
  for (const parts of stmt.names) {
    switch (stmt.kind) {
      case "table": {
        const table = state.findTable(parts);
        if (!table) {
          if (stmt.ifExists) break;
          throw pgError("undefined_table", `table "${parts.join(".")}" does not exist`, "42P01");
        }
        const refs = referencingConstraints(env, table).filter((r) => r.table !== table);
        if (refs.length > 0 && !stmt.cascade) {
          throw pgError(
            "dependent_objects",
            `cannot drop table ${table.name} because other objects depend on it`,
            "2BP01",
          );
        }
        if (stmt.cascade) {
          for (const r of refs) {
            r.table.constraints = r.table.constraints.filter((c) => c !== r.constraint);
          }
        }
        const schema = state.getSchema(table.schema);
        schema.tables.delete(table.name);
        // drop owned sequences and indexes
        for (const [sname, seq] of [...schema.sequences]) {
          if (seq.ownedBy?.table === table.name) schema.sequences.delete(sname);
        }
        for (const [iname, idx] of [...schema.indexes]) {
          if (idx.table === table.name) schema.indexes.delete(iname);
        }
        break;
      }
      case "view":
      case "materialized_view": {
        const view = state.findView(parts);
        const wantMat = stmt.kind === "materialized_view";
        if (!view || view.materialized !== wantMat) {
          if (stmt.ifExists) break;
          throw pgError(
            "undefined_table",
            `${wantMat ? "materialized view" : "view"} "${parts.join(".")}" does not exist`,
            "42P01",
          );
        }
        state.getSchema(view.schema).views.delete(view.name);
        break;
      }
      case "index": {
        const idxName = parts[parts.length - 1]!;
        const schemaName = parts.length >= 2 ? parts[parts.length - 2]! : null;
        let found = false;
        const candidates = schemaName ? [schemaName] : state.effectiveSearchPath();
        for (const sn of candidates) {
          const s = state.schemas.get(sn);
          if (s?.indexes.has(idxName)) {
            s.indexes.delete(idxName);
            found = true;
            break;
          }
        }
        if (!found && !stmt.ifExists) {
          throw pgError("undefined_table", `index "${parts.join(".")}" does not exist`, "42P01");
        }
        break;
      }
      case "sequence": {
        const seq = state.findSequence(parts);
        if (!seq) {
          if (stmt.ifExists) break;
          throw pgError("undefined_table", `sequence "${parts.join(".")}" does not exist`, "42P01");
        }
        state.getSchema(seq.schema).sequences.delete(seq.name);
        break;
      }
      case "schema": {
        const name = parts[parts.length - 1]!;
        const schema = state.schemas.get(name);
        if (!schema) {
          if (stmt.ifExists) break;
          throw pgError("undefined_object", `schema "${name}" does not exist`, "3F000");
        }
        const nonEmpty =
          schema.tables.size > 0 ||
          schema.views.size > 0 ||
          schema.sequences.size > 0 ||
          schema.enums.size > 0 ||
          schema.domains.size > 0 ||
          schema.functions.size > 0;
        if (nonEmpty && !stmt.cascade) {
          throw pgError("dependent_objects", `cannot drop schema ${name} because other objects depend on it`, "2BP01");
        }
        state.schemas.delete(name);
        break;
      }
      case "type": {
        const e = state.findEnum(parts);
        if (e) {
          state.getSchema(e.schema).enums.delete(e.name);
          break;
        }
        const d = state.findDomain(parts);
        if (d) {
          state.getSchema(d.schema).domains.delete(d.name);
          break;
        }
        if (!stmt.ifExists) {
          throw pgError("undefined_object", `type "${parts.join(".")}" does not exist`, "42704");
        }
        break;
      }
      case "domain": {
        const d = state.findDomain(parts);
        if (!d) {
          if (stmt.ifExists) break;
          throw pgError("undefined_object", `type "${parts.join(".")}" does not exist`, "42704");
        }
        state.getSchema(d.schema).domains.delete(d.name);
        break;
      }
      case "function": {
        const fns = state.findFunctions(parts);
        if (fns.length === 0) {
          if (stmt.ifExists) break;
          throw pgError("undefined_function", `function ${parts.join(".")} does not exist`, "42883");
        }
        const fn = fns[0]!;
        const schema = state.getSchema(fn.schema);
        const list = schema.functions.get(fn.name) ?? [];
        if (list.length <= 1) schema.functions.delete(fn.name);
        else schema.functions.set(fn.name, list.slice(1));
        break;
      }
      case "trigger": {
        if (!stmt.onTable) throw pgError("syntax", "DROP TRIGGER requires ON table", "42601");
        const table = state.findTable(stmt.onTable);
        if (!table) {
          if (stmt.ifExists) break;
          throw pgError("undefined_table", `relation "${stmt.onTable.join(".")}" does not exist`, "42P01");
        }
        const tname = parts[parts.length - 1]!;
        const idx = table.triggers.findIndex((t) => t.name === tname);
        if (idx === -1) {
          if (stmt.ifExists) break;
          throw pgError("undefined_object", `trigger "${tname}" for table "${table.name}" does not exist`, "42704");
        }
        table.triggers.splice(idx, 1);
        break;
      }
      case "extension":
        break; // accepted no-op
    }
  }
  const label = stmt.kind === "materialized_view" ? "MATERIALIZED VIEW" : stmt.kind.toUpperCase();
  return commandResult(`DROP ${label.replaceAll("_", " ")}`, 0);
}

export function executeTruncate(env: ExecEnv, stmt: TruncateStmt): ExecResult {
  const state = env.ctx.state;
  const tables: TableData[] = stmt.tables.map((parts) => {
    const t = state.findTable(parts);
    if (!t) throw pgError("undefined_table", `relation "${parts.join(".")}" does not exist`, "42P01");
    return state.ensureWritableTable(t);
  });
  const set = new Set(tables);
  if (stmt.cascade) {
    // add referencing tables transitively
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of [...set]) {
        for (const r of referencingConstraints(env, t)) {
          if (!set.has(r.table)) {
            set.add(r.table);
            grew = true;
          }
        }
      }
    }
  } else {
    for (const t of set) {
      for (const r of referencingConstraints(env, t)) {
        if (!set.has(r.table) && r.table.rowCount() >= 0) {
          throw pgError(
            "feature_not_supported",
            `cannot truncate a table referenced in a foreign key constraint`,
            "0A000",
          );
        }
      }
    }
  }
  for (const t of set) {
    const writable = state.ensureWritableTable(t);
    writable.mutableRows().length = 0;
    if (stmt.restartIdentity) {
      const schema = state.getSchema(writable.schema);
      for (const seq of [...schema.sequences.values()]) {
        if (seq.ownedBy?.table === writable.name) {
          const wseq = state.ensureWritableSequence(seq);
          wseq.lastValue = wseq.startValue;
          wseq.isCalled = false;
        }
      }
    }
  }
  return commandResult("TRUNCATE TABLE", 0);
}
