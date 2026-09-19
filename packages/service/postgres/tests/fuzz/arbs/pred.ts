import * as fc from "fast-check";
import { intArb } from "../config.ts";
import { intOrNullArb, intVal, textOrNullArb, textVal, type SqlExpr, renderSqlExpr, sqlExprArb } from "./expr.ts";

export type SqlPred =
  | { kind: "cmp"; col: "a" | "b"; op: string; value: number | null; text?: never }
  | { kind: "cmp_text"; col: "b"; op: string; value: string | null }
  | { kind: "expr"; expr: SqlExpr }
  | { kind: "in"; col: "a" | "b"; values: (number | null)[] }
  | { kind: "between"; col: "a" | "b"; lo: number; hi: number }
  | { kind: "like"; col: "b"; pattern: string }
  | { kind: "isnull"; col: "a" | "b"; neg: boolean }
  | { kind: "bin"; op: "AND" | "OR"; left: SqlPred; right: SqlPred }
  | { kind: "not"; inner: SqlPred };

export const sqlPredArb: fc.Arbitrary<SqlPred> = fc.letrec<{ pred: SqlPred }>((tie) => ({
  pred: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    fc.record({
      kind: fc.constant("cmp" as const),
      col: fc.constant("a" as const),
      op: fc.constantFrom("=", "<>", "<", "<=", ">", ">="),
      value: intOrNullArb,
    }),
    fc.record({
      kind: fc.constant("cmp_text" as const),
      col: fc.constant("b" as const),
      op: fc.constantFrom("=", "<>"),
      value: textOrNullArb,
    }),
    fc.record({ kind: fc.constant("expr" as const), expr: sqlExprArb }),
    fc.record({
      kind: fc.constant("in" as const),
      col: fc.constant("a" as const),
      values: fc.array(intOrNullArb, { minLength: 0, maxLength: 4 }),
    }),
    fc.record({
      kind: fc.constant("between" as const),
      col: fc.constant("a" as const),
      lo: intArb,
      hi: intArb,
    }),
    fc.record({
      kind: fc.constant("like" as const),
      col: fc.constant("b" as const),
      pattern: fc.constantFrom("%", "a%", "%a", "_"),
    }),
    fc.record({
      kind: fc.constant("isnull" as const),
      col: fc.constantFrom("a" as const, "b" as const),
      neg: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant("bin" as const),
      op: fc.constantFrom("AND" as const, "OR" as const),
      left: tie("pred"),
      right: tie("pred"),
    }),
    fc.record({ kind: fc.constant("not" as const), inner: tie("pred") }),
  ),
})).pred;

/** WHERE on UPDATE/DELETE — no free-form expr (error ordering vs PGlite is not stable). */
export const sqlTablePredArb: fc.Arbitrary<SqlPred> = fc.letrec<{ pred: SqlPred }>((tie) => ({
  pred: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    fc.record({
      kind: fc.constant("cmp" as const),
      col: fc.constant("a" as const),
      op: fc.constantFrom("=", "<>", "<", "<=", ">", ">="),
      value: intOrNullArb,
    }),
    fc.record({
      kind: fc.constant("cmp_text" as const),
      col: fc.constant("b" as const),
      op: fc.constantFrom("=", "<>"),
      value: textOrNullArb,
    }),
    fc.record({
      kind: fc.constant("in" as const),
      col: fc.constant("a" as const),
      values: fc.array(intOrNullArb, { minLength: 0, maxLength: 4 }),
    }),
    fc.record({
      kind: fc.constant("between" as const),
      col: fc.constant("a" as const),
      lo: intArb,
      hi: intArb,
    }),
    fc.record({
      kind: fc.constant("like" as const),
      col: fc.constant("b" as const),
      pattern: fc.constantFrom("%", "a%", "%a", "_"),
    }),
    fc.record({
      kind: fc.constant("isnull" as const),
      col: fc.constantFrom("a" as const, "b" as const),
      neg: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant("bin" as const),
      op: fc.constantFrom("AND" as const, "OR" as const),
      left: tie("pred"),
      right: tie("pred"),
    }),
    fc.record({ kind: fc.constant("not" as const), inner: tie("pred") }),
  ),
})).pred;

export function renderSqlPred(pred: SqlPred): string {
  switch (pred.kind) {
    case "cmp":
      return `${pred.col} ${pred.op} ${intVal(pred.value)}`;
    case "cmp_text":
      return `${pred.col} ${pred.op} ${textVal(pred.value)}`;
    case "expr":
      return renderSqlExpr(pred.expr);
    case "in": {
      const list = pred.values.map(intVal).join(", ");
      return `${pred.col} IN (${list})`;
    }
    case "between": {
      const lo = Math.min(pred.lo, pred.hi);
      const hi = Math.max(pred.lo, pred.hi);
      return `${pred.col} BETWEEN ${lo} AND ${hi}`;
    }
    case "like":
      return `${pred.col} LIKE '${pred.pattern.replaceAll("'", "''")}'`;
    case "isnull":
      return pred.neg ? `${pred.col} IS NOT NULL` : `${pred.col} IS NULL`;
    case "bin":
      return `(${renderSqlPred(pred.left)} ${pred.op} ${renderSqlPred(pred.right)})`;
    case "not":
      return `(NOT ${renderSqlPred(pred.inner)})`;
  }
}
