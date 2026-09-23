import * as fc from "fast-check";
import { intArb } from "../config.ts";
import { intVal, textVal, wordArb } from "./expr.ts";

export type TableSchema = {
  name: string;
};

export const tableSchemaArb: fc.Arbitrary<TableSchema> = fc.record({
  name: fc.constantFrom("t", "u", "items"),
});

export type RowSeed = { id: number; a: number | null; b: string | null };

export const rowSeedArb: fc.Arbitrary<RowSeed> = fc.record({
  id: fc.integer({ min: 1, max: 30 }),
  a: fc.option(intArb, { nil: null }),
  b: fc.option(wordArb, { nil: null }),
});

export function createTableDdl(schema: TableSchema): string {
  return `CREATE TABLE ${schema.name} (id int PRIMARY KEY, a int, b text)`;
}

export function insertRowSql(table: string, row: RowSeed): string {
  return `INSERT INTO ${table} VALUES (${row.id}, ${intVal(row.a)}, ${textVal(row.b)}) ON CONFLICT DO NOTHING`;
}
