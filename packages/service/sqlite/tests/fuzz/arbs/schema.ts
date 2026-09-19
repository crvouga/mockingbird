import * as fc from "fast-check";
import { intArb, textArb } from "../config.ts";

export type TableSchema = {
  name: string;
  strict: boolean;
  withoutRowid: boolean;
};

export const tableSchemaArb: fc.Arbitrary<TableSchema> = fc.record({
  name: fc.constantFrom("t", "u", "items"),
  strict: fc.boolean(),
  withoutRowid: fc.boolean(),
});

export type RowSeed = { id: number; a: number | null; b: string | null };

export const rowSeedArb: fc.Arbitrary<RowSeed> = fc.record({
  id: fc.integer({ min: 1, max: 30 }),
  a: fc.option(intArb, { nil: null }),
  b: fc.option(
    textArb.filter((s) => s.length <= 12),
    { nil: null },
  ),
});

export function createTableDdl(schema: TableSchema): string {
  const opts: string[] = [];
  if (schema.strict) opts.push("STRICT");
  if (schema.withoutRowid) opts.push("WITHOUT ROWID");
  const suffix = opts.length > 0 ? ` ${opts.join(", ")}` : "";
  return `CREATE TABLE ${schema.name} (id INTEGER PRIMARY KEY, a INT, b TEXT)${suffix}`;
}

export function insertRowSql(table: string, row: RowSeed, literal: (v: null | number | string) => string): string {
  return `INSERT OR IGNORE INTO ${table} VALUES (${row.id}, ${literal(row.a)}, ${literal(row.b)})`;
}
