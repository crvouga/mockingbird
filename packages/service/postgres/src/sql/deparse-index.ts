import type { Expr } from "../ast/nodes.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { pgvectorDefaultOpclass } from "../functions/pgvector.ts";
import { indexMethod } from "../schema/index-catalog.ts";
import type { IndexMeta, TableData } from "../storage/database-state.ts";
import { isArrayType, isEnumType, type TypeId } from "../types/value.ts";
import { quoteIdentifier } from "./keywords.ts";
import { deparseIndexExpr, deparseRuleExpr, type RuleScope } from "./ruleutils.ts";

/** pg_get_indexdef(): an index definition printed the way PostgreSQL reconstructs it. */

type IndexColumn = IndexMeta["columns"][number];

function scopeOf(ctx: EngineCtx, index: IndexMeta): RuleScope {
  return { ctx, table: ctx.state.schemas.get(index.schema)?.tables.get(index.table) ?? null };
}

/** `c COLLATE "x"` parses as an expression; in an index it is column `c` with a collation. */
function splitCollation(column: IndexColumn): { column: string | null; expr: Expr | null; collation: string | null } {
  if (column.expr?.type !== "collate") return { column: column.column, expr: column.expr, collation: null };
  const inner = column.expr.expr;
  const collation = column.expr.collation[column.expr.collation.length - 1]!;
  if (inner.type === "colref" && inner.parts.length === 1) return { column: inner.parts[0]!, expr: null, collation };
  return { column: null, expr: inner, collation };
}

/** The key column or expression alone, as `pg_get_indexdef(oid, n, pretty)` returns it. */
function keyText(scope: RuleScope, column: IndexColumn, pretty: boolean): string {
  const key = splitCollation(column);
  return key.column !== null ? quoteIdentifier(key.column) : deparseIndexExpr(scope, key.expr!, pretty);
}

/** The opclass PostgreSQL picks for a column type when none is named, which it does not print. */
function defaultOpclass(type: TypeId | null, method: string): string | null {
  if (type === null) return null;
  if (type === "vector") return pgvectorDefaultOpclass(method);
  if (isArrayType(type)) return "array_ops";
  if (isEnumType(type)) return "enum_ops";
  return type === "varchar" ? "text_ops" : `${type}_ops`;
}

function columnType(table: TableData | null, column: IndexColumn): TypeId | null {
  const key = splitCollation(column);
  return key.column === null ? null : (table?.columns.find((c) => c.name === key.column)?.type.id ?? null);
}

function keyDefinition(scope: RuleScope, index: IndexMeta, column: IndexColumn, pretty: boolean): string {
  let out = keyText(scope, column, pretty);
  const key = splitCollation(column);
  const declared = key.column === null ? null : scope.table?.columns.find((c) => c.name === key.column)?.collate;
  if (key.collation !== null && key.collation !== (declared ?? null)) {
    out += ` COLLATE ${quoteIdentifier(key.collation)}`;
  }
  const opclass = column.opclass;
  if (opclass && opclass[opclass.length - 1] !== defaultOpclass(columnType(scope.table, column), indexMethod(index))) {
    out += ` ${quoteIdentifier(opclass[opclass.length - 1]!)}`;
  }
  // only an ordered access method has a sort direction to report
  if (indexMethod(index) !== "btree") return out;
  if (column.dir === "desc") return column.nulls === "first" ? `${out} DESC` : `${out} DESC NULLS LAST`;
  return column.nulls === "first" ? `${out} NULLS FIRST` : out;
}

function tableName(scope: RuleScope, index: IndexMeta, pretty: boolean): string {
  const qualified = `${quoteIdentifier(index.schema)}.${quoteIdentifier(index.table)}`;
  if (!pretty) return qualified;
  // pretty-printing drops the schema when the bare name resolves to this table
  const found = scope.ctx.state.resolveRelationSchema([index.table]);
  return found?.schema === index.schema ? quoteIdentifier(index.table) : qualified;
}

/** `name=value`, the value bare when it reads as a plain identifier (flatten_reloptions). */
function storageParameters(index: IndexMeta): string {
  return (index.options ?? [])
    .map(({ name, value }) => {
      const bare = quoteIdentifier(value) === value;
      return `${quoteIdentifier(name)}=${bare ? value : `'${value.replaceAll("'", "''")}'`}`;
    })
    .join(", ");
}

/** The WHERE predicate of a partial index, or null. */
export function deparseIndexPredicate(ctx: EngineCtx, index: IndexMeta, pretty = false): string | null {
  return index.where ? deparseRuleExpr(scopeOf(ctx, index), index.where, pretty) : null;
}

/** The expression keys of an index, comma-separated (`pg_get_expr(indexprs, indrelid)`), or null. */
export function deparseIndexExpressions(ctx: EngineCtx, index: IndexMeta): string | null {
  const scope = scopeOf(ctx, index);
  const expressions = index.columns
    .map(splitCollation)
    .filter((key) => key.expr !== null)
    .map((key) => deparseRuleExpr(scope, key.expr!));
  return expressions.length > 0 ? expressions.join(", ") : null;
}

/** `pg_get_indexdef(oid)` / `pg_get_indexdef(oid, 0, pretty)`: the whole CREATE INDEX command. */
export function deparseIndex(ctx: EngineCtx, index: IndexMeta, pretty = false): string {
  const scope = scopeOf(ctx, index);
  const keys = index.columns.map((column) => keyDefinition(scope, index, column, pretty)).join(", ");
  let out = `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(index.name)}`;
  out += ` ON ${tableName(scope, index, pretty)} USING ${indexMethod(index)} (${keys})`;
  if (index.include && index.include.length > 0) out += ` INCLUDE (${index.include.map(quoteIdentifier).join(", ")})`;
  if (index.nullsNotDistinct) out += " NULLS NOT DISTINCT";
  if (index.options && index.options.length > 0) out += ` WITH (${storageParameters(index)})`;
  const predicate = deparseIndexPredicate(ctx, index, pretty);
  return predicate === null ? out : `${out} WHERE ${predicate}`;
}

/**
 * `pg_get_indexdef(oid, n, pretty)` for n >= 1: the n-th index column, key columns first
 * and INCLUDE columns after them, without ordering or opclass. Empty when there is no such column.
 */
export function deparseIndexColumn(ctx: EngineCtx, index: IndexMeta, position: number, pretty = false): string {
  const key = index.columns[position - 1];
  if (key) return keyText(scopeOf(ctx, index), key, pretty);
  const included = index.include?.[position - 1 - index.columns.length];
  return included === undefined ? "" : quoteIdentifier(included);
}
