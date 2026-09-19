import * as fc from "fast-check";
import { intArb } from "../config.ts";

export function intVal(v: number | null): string {
  if (v === null) return "NULL::int4";
  return v < 0 ? `(${v})` : String(v);
}

export function textVal(v: string | null): string {
  if (v === null) return "NULL::text";
  return `'${v.replaceAll("'", "''")}'`;
}

export const intOrNullArb = fc.oneof(fc.constant(null), intArb);
export const wordArb = fc.constantFrom("alpha", "beta", "gamma", "", "zeta");
export const textOrNullArb = fc.oneof(fc.constant(null), wordArb);

export type SqlExpr =
  | { kind: "lit_int"; value: number | null }
  | { kind: "lit_text"; value: string | null }
  | { kind: "unary"; op: "-" | "NOT"; inner: SqlExpr }
  | { kind: "binary"; op: string; left: SqlExpr; right: SqlExpr }
  | { kind: "case"; when: SqlExpr; then: SqlExpr; else: SqlExpr }
  | { kind: "cast"; value: SqlExpr; as: "int4" | "text" | "float8" };

export const sqlExprArb: fc.Arbitrary<SqlExpr> = fc.letrec<{ expr: SqlExpr }>((tie) => ({
  expr: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    fc.record({ kind: fc.constant("lit_int" as const), value: intOrNullArb }),
    fc.record({ kind: fc.constant("lit_text" as const), value: textOrNullArb }),
    fc.record({
      kind: fc.constant("unary" as const),
      op: fc.constantFrom("-" as const, "NOT" as const),
      inner: tie("expr"),
    }),
    fc.record({
      kind: fc.constant("binary" as const),
      op: fc.constantFrom("+", "-", "*", "=", "<>", "<", "<=", ">", ">="),
      left: tie("expr"),
      right: tie("expr"),
    }),
    fc.record({
      kind: fc.constant("case" as const),
      when: tie("expr"),
      // biome-ignore lint/suspicious/noThenProperty: CASE WHEN … THEN … SQL shape
      then: tie("expr"),
      else: tie("expr"),
    }),
    fc.record({
      kind: fc.constant("cast" as const),
      value: tie("expr"),
      as: fc.constantFrom("int4" as const, "text" as const, "float8" as const),
    }),
  ),
})).expr;

export function renderSqlExpr(expr: SqlExpr): string {
  switch (expr.kind) {
    case "lit_int":
      return intVal(expr.value);
    case "lit_text":
      return textVal(expr.value);
    case "unary":
      return `(${expr.op} ${renderSqlExpr(expr.inner)})`;
    case "binary":
      return `(${renderSqlExpr(expr.left)} ${expr.op} ${renderSqlExpr(expr.right)})`;
    case "case":
      return `(CASE WHEN ${renderSqlExpr(expr.when)} THEN ${renderSqlExpr(expr.then)} ELSE ${renderSqlExpr(expr.else)} END)`;
    case "cast":
      return `CAST(${renderSqlExpr(expr.value)} AS ${expr.as})`;
  }
}
