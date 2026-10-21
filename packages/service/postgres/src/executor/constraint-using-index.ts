import { pgError, unsupported } from "../errors/error.ts";
import { indexMethod } from "../schema/index-catalog.ts";
import type { ConstraintMeta, DatabaseState, IndexMeta, TableData } from "../storage/database-state.ts";

/**
 * `ALTER TABLE t ADD [CONSTRAINT name] { UNIQUE | PRIMARY KEY } USING INDEX idx`: promote an existing
 * unique index to the constraint. The index keeps its identity (oid, so `pg_constraint.conindid`
 * points at it) and takes the constraint's name; no second scan of the table is needed for UNIQUE.
 * The checks and their SQLSTATEs follow PostgreSQL's `transformIndexConstraintUsingIndex`.
 */
export function addConstraintUsingIndex(
  state: DatabaseState,
  table: TableData,
  kind: "primary_key" | "unique",
  name: string | null,
  indexName: string,
): void {
  const schema = state.getSchema(table.schema);
  // the index is looked up in the table's own schema, whatever the search path says
  const index = schema.indexes.get(indexName);
  if (!index) throw pgError("undefined_object", `index "${indexName}" does not exist`, "42704");
  if (index.tableOid !== undefined ? index.tableOid !== table.oid : index.table !== table.name) {
    throw pgError(
      "object_not_in_prerequisite_state",
      `index "${indexName}" does not belong to table "${table.name}"`,
      "55000",
    );
  }
  if (index.valid === false) throw pgError("wrong_object_type", `index "${indexName}" is not valid`, "42809");
  if (!index.unique) throw pgError("wrong_object_type", `"${indexName}" is not a unique index`, "42809");
  if (index.columns.some((column) => column.expr !== null)) {
    throw pgError("wrong_object_type", `index "${indexName}" contains expressions`, "42809");
  }
  if (index.where !== null) throw pgError("wrong_object_type", `"${indexName}" is a partial index`, "42809");
  if (index.isConstraint) {
    throw pgError(
      "object_not_in_prerequisite_state",
      `index "${indexName}" is already associated with a constraint`,
      "55000",
    );
  }
  if (indexMethod(index) !== "btree") throw unsupported(`ADD CONSTRAINT USING INDEX on a ${indexMethod(index)} index`);
  const unorderedAt = index.columns.findIndex((column) => column.dir !== "asc" || column.nulls !== "last");
  if (unorderedAt !== -1) {
    throw pgError(
      "wrong_object_type",
      `index "${indexName}" column number ${unorderedAt + 1} does not have default sorting behavior`,
      "42809",
    );
  }

  const columns = index.columns.map((column) => column.column as string);
  const constraintName = name ?? indexName;
  if (kind === "primary_key" && table.constraints.some((c) => c.kind === "primary_key")) {
    throw pgError(
      "invalid_table_definition",
      `multiple primary keys for table "${table.name}" are not allowed`,
      "42P16",
    );
  }
  // the index is renamed to the constraint: the name must be free as a relation (and a constraint)
  if (constraintName !== indexName && schema.hasRelation(constraintName)) {
    throw pgError("duplicate_table", `relation "${constraintName}" already exists`, "42P07");
  }
  if (table.constraints.some((c) => c.name === constraintName && c.kind !== "primary_key" && c.kind !== "unique")) {
    throw pgError(
      "duplicate_object",
      `constraint "${constraintName}" for relation "${table.name}" already exists`,
      "42710",
    );
  }
  if (kind === "primary_key") {
    // the key columns become NOT NULL, which is refused while a row holds a null
    const rows = table.mutableRows();
    for (const columnName of columns) {
      const at = table.columnIndex(columnName);
      if (rows.some((row) => (row[at] ?? null) === null)) {
        throw pgError(
          "not_null_violation",
          `column "${columnName}" of relation "${table.name}" contains null values`,
          "23502",
        );
      }
    }
    for (const columnName of columns) table.columns[table.columnIndex(columnName)]!.notNull = true;
  }

  const oid = index.oid ?? state.nextOid();
  const constraint: ConstraintMeta =
    kind === "primary_key"
      ? { kind, name: constraintName, columns, indexOid: oid }
      : { kind, name: constraintName, columns, nullsNotDistinct: index.nullsNotDistinct, indexOid: oid };
  table.constraints.push(constraint);
  // index objects are shared with transaction snapshots: replace the entry rather than mutate it
  const promoted: IndexMeta = { ...index, oid, name: constraintName, isConstraint: true };
  schema.indexes.delete(indexName);
  schema.indexes.set(constraintName, promoted);
}
