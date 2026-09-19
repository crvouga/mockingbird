import * as fc from "fast-check";
import { type SqlPred, renderSqlPred, sqlPredArb } from "./pred.ts";

export type SelectShape = {
  distinct: boolean;
  where: SqlPred | null;
  groupBy: "a" | "b" | null;
  having: SqlPred | null;
  orderBy: "a" | "b" | "id" | null;
  limit: number | null;
  setOp: "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT" | null;
};

export const selectShapeArb: fc.Arbitrary<SelectShape> = fc.record({
  distinct: fc.boolean(),
  where: fc.option(sqlPredArb, { nil: null }),
  groupBy: fc.constantFrom("a" as const, "b" as const, null),
  having: fc.option(sqlPredArb, { nil: null }),
  orderBy: fc.constantFrom("a" as const, "b" as const, "id" as const, null),
  limit: fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
  setOp: fc.constantFrom("UNION" as const, "UNION ALL" as const, "INTERSECT" as const, "EXCEPT" as const, null),
});

export function buildSelectSql(shape: SelectShape, table: string, opts?: { grouped?: boolean }): string {
  const distinct = shape.distinct ? "DISTINCT " : "";
  const groupCol = shape.groupBy ?? "a";
  const projection = opts?.grouped ? `${groupCol}, count(*) AS c` : "id, a, b";
  let sql = `SELECT ${distinct}${projection} FROM ${table}`;
  if (shape.where) sql += ` WHERE ${renderSqlPred(shape.where)}`;
  if (shape.groupBy) {
    sql += ` GROUP BY ${shape.groupBy}`;
    if (shape.having) sql += ` HAVING ${renderSqlPred(shape.having)}`;
  }
  if (shape.orderBy) {
    const orderParts: string[] = [shape.orderBy];
    // Pin tie-breakers whenever ORDER BY is non-total (differential fuzz stability).
    if (!opts?.grouped) {
      for (const col of ["id", "a", "b"] as const) {
        if (col !== shape.orderBy) orderParts.push(col);
      }
    }
    sql += ` ORDER BY ${orderParts.join(", ")}`;
  } else if (shape.distinct && !opts?.grouped) {
    // Plain DISTINCT without ORDER BY: PG still emits HashAggregate order; pin both sides.
    sql += " ORDER BY id, a, b";
  }
  if (shape.limit !== null) sql += ` LIMIT ${shape.limit}`;

  if (shape.setOp) {
    const right = `SELECT a FROM ${table}`;
    sql = `(${sql}) ${shape.setOp} (${right}) ORDER BY 1`;
  }
  return sql;
}

export const grammarProductionArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant("select_where" as const) },
  { weight: 3, arbitrary: fc.constant("select_group" as const) },
  { weight: 2, arbitrary: fc.constant("select_setop" as const) },
  { weight: 2, arbitrary: fc.constant("insert_values" as const) },
  { weight: 2, arbitrary: fc.constant("update_where" as const) },
  { weight: 1, arbitrary: fc.constant("delete_where" as const) },
);

export type GrammarProduction = fc.InferValue<typeof grammarProductionArb>;
