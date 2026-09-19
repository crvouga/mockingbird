import * as fc from "fast-check";
import { intArb, nullArb, textArb } from "../config.ts";
import { type SqlExpr, renderSqlExpr, sqlExprArb } from "./expr.ts";

export type SqlPred =
  | { kind: "cmp"; col: "a" | "b"; op: string; value: null | number | string }
  | { kind: "expr"; expr: SqlExpr }
  | { kind: "in"; col: "a" | "b"; values: (null | number | string)[] }
  | { kind: "between"; col: "a" | "b"; lo: number; hi: number }
  | { kind: "like"; col: "b"; pattern: string }
  | { kind: "isnull"; col: "a" | "b"; neg: boolean }
  | { kind: "bin"; op: "AND" | "OR"; left: SqlPred; right: SqlPred }
  | { kind: "not"; inner: SqlPred };

const colValueArb = fc.oneof(
  nullArb,
  intArb,
  textArb.filter((s) => s.length <= 8),
);

export const sqlPredArb: fc.Arbitrary<SqlPred> = fc.letrec<{ pred: SqlPred }>((tie) => ({
  pred: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    fc.record({
      kind: fc.constant("cmp" as const),
      col: fc.constantFrom("a" as const, "b" as const),
      op: fc.constantFrom("=", "!=", "<", "<=", ">", ">="),
      value: colValueArb,
    }),
    fc.record({ kind: fc.constant("expr" as const), expr: sqlExprArb }),
    fc.record({
      kind: fc.constant("in" as const),
      col: fc.constantFrom("a" as const, "b" as const),
      values: fc.array(colValueArb, { minLength: 0, maxLength: 4 }),
    }),
    fc.record({
      kind: fc.constant("between" as const),
      col: fc.constantFrom("a" as const, "b" as const),
      lo: intArb,
      hi: intArb,
    }),
    fc.record({
      kind: fc.constant("like" as const),
      col: fc.constant("b" as const),
      pattern: fc.constantFrom("%", "a%", "%z", "_", "%a%"),
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

export function renderSqlPred(
  pred: SqlPred,
  literal: (v: null | number | string) => string,
  renderExpr: (e: SqlExpr) => string = (e) => renderSqlExpr(e, literal),
): string {
  switch (pred.kind) {
    case "cmp":
      return `${pred.col} ${pred.op} ${literal(pred.value)}`;
    case "expr":
      return renderExpr(pred.expr);
    case "in": {
      const list = pred.values.map(literal).join(", ");
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
      return `(${renderSqlPred(pred.left, literal, renderExpr)} ${pred.op} ${renderSqlPred(pred.right, literal, renderExpr)})`;
    case "not":
      return `(NOT ${renderSqlPred(pred.inner, literal, renderExpr)})`;
  }
}
