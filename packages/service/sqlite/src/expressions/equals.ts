import type { Expr } from "../ast/nodes.ts";

/** Structural equality for matching WHERE expressions to index expressions. */
export function exprEquals(left: Expr, right: Expr): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "null":
      return true;
    case "literal":
      return right.type === "literal" && valuesEqual(left.value, right.value);
    case "column":
      return (
        right.type === "column" &&
        (left.table ?? "").toLowerCase() === (right.table ?? "").toLowerCase() &&
        left.name.toLowerCase() === right.name.toLowerCase()
      );
    case "unary":
      return right.type === "unary" && left.op === right.op && exprEquals(left.expr, right.expr);
    case "is_bool":
      return (
        right.type === "is_bool" &&
        left.not === right.not &&
        left.sense === right.sense &&
        exprEquals(left.expr, right.expr)
      );
    case "binary":
      return (
        right.type === "binary" &&
        left.op === right.op &&
        exprEquals(left.left, right.left) &&
        exprEquals(left.right, right.right)
      );
    case "function":
      return (
        right.type === "function" &&
        left.name.toLowerCase() === right.name.toLowerCase() &&
        left.distinct === right.distinct &&
        argsEqual(left.args, right.args)
      );
    case "collate":
      return (
        right.type === "collate" &&
        left.collation.toLowerCase() === right.collation.toLowerCase() &&
        exprEquals(left.expr, right.expr)
      );
    case "cast":
      return (
        right.type === "cast" &&
        (left.typeName ?? "").toUpperCase() === (right.typeName ?? "").toUpperCase() &&
        exprEquals(left.expr, right.expr)
      );
    default:
      return JSON.stringify(left) === JSON.stringify(right);
  }
}

function argsEqual(left: Expr[] | "*", right: Expr[] | "*"): boolean {
  if (left === "*" || right === "*") return left === right;
  if (left.length !== right.length) return false;
  return left.every((expr, index) => exprEquals(expr, right[index]!));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) return false;
    return left.every((byte, index) => byte === right[index]);
  }
  return false;
}
