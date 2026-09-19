import * as fc from "fast-check";
import { intArb, nullArb, realArb, valueArb } from "../config.ts";

export const numericArb = fc.oneof(nullArb, intArb, realArb);

export type SqlExpr =
  | { kind: "lit"; value: null | number | string }
  | { kind: "unary"; op: "-" | "NOT"; inner: SqlExpr }
  | { kind: "binary"; op: string; left: SqlExpr; right: SqlExpr }
  | { kind: "case"; when: SqlExpr; thenExpr: SqlExpr; else: SqlExpr }
  | { kind: "cast"; value: SqlExpr; as: "INTEGER" | "TEXT" | "REAL" };

export const sqlExprArb: fc.Arbitrary<SqlExpr> = fc.letrec<{ expr: SqlExpr }>((tie) => ({
  expr: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    fc.record({ kind: fc.constant("lit" as const), value: valueArb }),
    fc.record({
      kind: fc.constant("unary" as const),
      op: fc.constantFrom("-" as const, "NOT" as const),
      inner: tie("expr"),
    }),
    fc.record({
      kind: fc.constant("binary" as const),
      op: fc.constantFrom("+", "-", "*", "%", "=", "!=", "<", "<=", ">", ">="),
      left: tie("expr"),
      right: tie("expr"),
    }),
    fc.record({
      kind: fc.constant("case" as const),
      when: tie("expr"),
      thenExpr: tie("expr"),
      else: tie("expr"),
    }),
    fc.record({
      kind: fc.constant("cast" as const),
      value: tie("expr"),
      as: fc.constantFrom("INTEGER" as const, "TEXT" as const, "REAL" as const),
    }),
  ),
})).expr;

export function renderSqlExpr(expr: SqlExpr, literal: (v: null | number | string) => string): string {
  switch (expr.kind) {
    case "lit":
      return literal(expr.value);
    case "unary":
      return `(${expr.op} ${renderSqlExpr(expr.inner, literal)})`;
    case "binary":
      return `(${renderSqlExpr(expr.left, literal)} ${expr.op} ${renderSqlExpr(expr.right, literal)})`;
    case "case":
      return `(CASE WHEN ${renderSqlExpr(expr.when, literal)} THEN ${renderSqlExpr(expr.thenExpr, literal)} ELSE ${renderSqlExpr(expr.else, literal)} END)`;
    case "cast":
      return `CAST(${renderSqlExpr(expr.value, literal)} AS ${expr.as})`;
  }
}
