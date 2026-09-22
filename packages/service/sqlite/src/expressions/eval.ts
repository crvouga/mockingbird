import type { BinaryOp, Expr, SelectStmt } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { jsonArrow } from "../functions/json.ts";
import { defaultFunctionRegistry } from "../functions/registry.ts";
import { castSqlValue } from "../functions/scalar.ts";
import { compareWithCollation } from "../types/collation.ts";
import {
  type Affinity,
  affinityFromTypeName,
  applyComparisonAffinity,
  asSqlReal,
  canonicalizeNumber,
  coerceToNumberPrefix,
  compareSql,
  isSqlReal,
  isTruthySql,
  type SqlValue,
  storageClassOf,
  utf8Decode,
} from "../types/value.ts";
import type { EvalContext } from "./context.ts";
import { globMatch, likeMatch } from "./like.ts";

function numberValue(value: SqlValue): number {
  return coerceToNumberPrefix(value);
}

function asNumber(value: number): number {
  return canonicalizeNumber(value);
}

function integerValue(value: SqlValue): bigint {
  if (value === null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (isSqlReal(value)) return BigInt(Math.trunc(value.value));
  return BigInt(Math.trunc(coerceToNumberPrefix(value)));
}

function isRealStorage(value: SqlValue): boolean {
  return storageClassOf(value) === "real" || isSqlReal(value);
}

function textValue(value: SqlValue): string {
  if (value instanceof Uint8Array) return utf8Decode(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof (value as { value: unknown }).value === "string"
  ) {
    return (value as { value: string }).value;
  }
  return String(value);
}

function booleanValue(value: boolean): SqlValue {
  return value ? 1 : 0;
}

function executeSelect(ctx: EvalContext, select: SelectStmt): { columns: string[]; rows: SqlValue[][] } {
  if (!ctx.executeSelect) throw new SqliteError("subqueries are not available in this evaluation context", "misuse");
  return ctx.executeSelect(select);
}

function resolveColumn(ctx: EvalContext, table: string | null, name: string): SqlValue {
  try {
    return ctx.resolveColumn(table, name);
  } catch (error) {
    if (ctx.parent && error instanceof SqliteError && error.category === "no_such_column") {
      return resolveColumn(ctx.parent, table, name);
    }
    throw error;
  }
}

function sqlAnd(left: SqlValue, right: () => SqlValue): SqlValue {
  const leftTruth = isTruthySql(left);
  if (leftTruth === false) return 0;
  const rightTruth = isTruthySql(right());
  if (rightTruth === false) return 0;
  if (leftTruth === null || rightTruth === null) return null;
  return 1;
}

function sqlOr(left: SqlValue, right: () => SqlValue): SqlValue {
  const leftTruth = isTruthySql(left);
  if (leftTruth === true) return 1;
  const rightTruth = isTruthySql(right());
  if (rightTruth === true) return 1;
  if (leftTruth === null || rightTruth === null) return null;
  return 0;
}

function compareResult(
  op: BinaryOp,
  left: SqlValue,
  right: SqlValue,
  collation?: string,
  leftAffinity: Affinity | null = null,
  rightAffinity: Affinity | null = null,
): SqlValue {
  [left, right] = applyComparisonAffinity(left, right, leftAffinity, rightAffinity);
  if (op === "IS" || op === "IS NOT" || op === "IS DISTINCT FROM" || op === "IS NOT DISTINCT FROM") {
    const equal =
      left === null || right === null
        ? left === right
        : (collation ? compareWithCollation(left, right, collation) : compareSql(left, right)) === 0;
    if (op === "IS" || op === "IS NOT DISTINCT FROM") return booleanValue(equal);
    return booleanValue(!equal);
  }
  const comparison = collation ? compareWithCollation(left, right, collation) : compareSql(left, right);
  if (comparison === null) return null;
  switch (op) {
    case "=":
    case "==":
      return booleanValue(comparison === 0);
    case "!=":
    case "<>":
      return booleanValue(comparison !== 0);
    case "<":
      return booleanValue(comparison < 0);
    case "<=":
      return booleanValue(comparison <= 0);
    case ">":
      return booleanValue(comparison > 0);
    case ">=":
      return booleanValue(comparison >= 0);
    default:
      throw new SqliteError(`unsupported comparison operator: ${op}`, "unsupported");
  }
}

function evalBinary(op: BinaryOp, leftExpr: Expr, rightExpr: Expr, ctx: EvalContext): SqlValue {
  if (op === "MATCH") {
    if (leftExpr.type !== "column") {
      throw new SqliteError("unable to use function MATCH in the requested context", "unsupported");
    }
    const query = textValue(evalExpr(rightExpr, ctx));
    if (!ctx.matchFts) {
      throw new SqliteError("unable to use function MATCH in the requested context", "unsupported");
    }
    return booleanValue(ctx.matchFts(leftExpr.table, leftExpr.name, query));
  }

  if (
    leftExpr.type === "row" &&
    rightExpr.type === "row" &&
    ["=", "==", "!=", "<>", "<", "<=", ">", ">=", "IS", "IS NOT", "IS DISTINCT FROM", "IS NOT DISTINCT FROM"].includes(
      op,
    )
  ) {
    return compareRowValues(op, leftExpr.values, rightExpr.values, ctx);
  }

  const left = evalExpr(leftExpr, ctx);
  if (op === "AND") return sqlAnd(left, () => evalExpr(rightExpr, ctx));
  if (op === "OR") return sqlOr(left, () => evalExpr(rightExpr, ctx));
  const right = evalExpr(rightExpr, ctx);

  if (op === "->" || op === "->>") {
    return jsonArrow(left, right, op);
  }

  if (
    ["=", "==", "!=", "<>", "<", "<=", ">", ">=", "IS", "IS NOT", "IS DISTINCT FROM", "IS NOT DISTINCT FROM"].includes(
      op,
    )
  ) {
    return compareResult(
      op,
      left,
      right,
      resolveComparisonCollation(leftExpr, rightExpr, ctx) ?? undefined,
      resolveComparisonAffinity(leftExpr, ctx),
      resolveComparisonAffinity(rightExpr, ctx),
    );
  }
  if (op === "LIKE" || op === "NOT LIKE" || op === "GLOB" || op === "NOT GLOB") {
    if (left === null || right === null) return null;
    const matches = op.includes("LIKE")
      ? likeMatch(textValue(left), textValue(right), null, ctx.functionContext?.caseSensitiveLike === true)
      : globMatch(textValue(left), textValue(right));
    return booleanValue(op.startsWith("NOT") ? !matches : matches);
  }
  if (left === null || right === null) return null;
  switch (op) {
    case "+":
      if (storageClassOf(left) === "integer" && storageClassOf(right) === "integer") {
        return integerArithmetic("+", left, right);
      }
      return asNumber(numberValue(left) + numberValue(right));
    case "-":
      if (storageClassOf(left) === "integer" && storageClassOf(right) === "integer") {
        return integerArithmetic("-", left, right);
      }
      return asNumber(numberValue(left) - numberValue(right));
    case "*":
      if (storageClassOf(left) === "integer" && storageClassOf(right) === "integer") {
        return integerArithmetic("*", left, right);
      }
      return asNumber(numberValue(left) * numberValue(right));
    case "/": {
      const divisor = numberValue(right);
      if (divisor === 0) return null;
      if (storageClassOf(left) === "integer" && storageClassOf(right) === "integer") {
        const quotient = integerValue(left) / integerValue(right);
        return quotient <= BigInt(Number.MAX_SAFE_INTEGER) && quotient >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(quotient)
          : quotient;
      }
      return asNumber(numberValue(left) / divisor);
    }
    case "%": {
      const divisor = integerValue(right);
      if (divisor === 0n) return null;
      const remainder = integerValue(left) % divisor;
      if (isRealStorage(left) || isRealStorage(right)) {
        return asSqlReal(Number(remainder));
      }
      return safeIntegerResult(remainder);
    }
    case "||":
      return textValue(left) + textValue(right);
    case "&":
      return safeIntegerResult(integerValue(left) & integerValue(right));
    case "|":
      return safeIntegerResult(integerValue(left) | integerValue(right));
    case "<<":
      return safeIntegerResult(integerValue(left) << integerValue(right));
    case ">>":
      return safeIntegerResult(integerValue(left) >> integerValue(right));
    case "IN":
    case "NOT IN":
      throw new SqliteError(`${op} requires an IN expression node`, "misuse");
    default:
      throw new SqliteError(`unsupported binary operator: ${op}`, "unsupported");
  }
}

function safeIntegerResult(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function integerArithmetic(op: "+" | "-" | "*", left: SqlValue, right: SqlValue): SqlValue {
  const a = integerValue(left);
  const b = integerValue(right);
  const result = op === "+" ? a + b : op === "-" ? a - b : a * b;
  if (result < I64_MIN || result > I64_MAX) {
    return asSqlReal(Number(result));
  }
  return safeIntegerResult(result);
}

function compareRowValues(op: BinaryOp, leftExprs: Expr[], rightExprs: Expr[], ctx: EvalContext): SqlValue {
  if (leftExprs.length !== rightExprs.length) {
    throw new SqliteError("row value misused", "misuse");
  }
  const isIsFamily = op === "IS" || op === "IS NOT" || op === "IS DISTINCT FROM" || op === "IS NOT DISTINCT FROM";
  let sawNull = false;
  for (let i = 0; i < leftExprs.length; i++) {
    const left = evalExpr(leftExprs[i]!, ctx);
    const right = evalExpr(rightExprs[i]!, ctx);
    if (isIsFamily) {
      const equal = left === null || right === null ? left === right : compareSql(left, right) === 0;
      if (!equal) {
        if (op === "IS" || op === "IS NOT DISTINCT FROM") return booleanValue(false);
        return booleanValue(true);
      }
      continue;
    }
    if (left === null || right === null) {
      sawNull = true;
      continue;
    }
    const cmp = compareSql(left, right);
    if (cmp === null) {
      sawNull = true;
      continue;
    }
    if (cmp !== 0) {
      switch (op) {
        case "=":
        case "==":
          return booleanValue(false);
        case "!=":
        case "<>":
          return booleanValue(true);
        case "<":
          return booleanValue(cmp < 0);
        case "<=":
          return booleanValue(cmp < 0);
        case ">":
          return booleanValue(cmp > 0);
        case ">=":
          return booleanValue(cmp > 0);
      }
    }
  }
  if (isIsFamily) {
    if (op === "IS" || op === "IS NOT DISTINCT FROM") return booleanValue(true);
    return booleanValue(false);
  }
  if (sawNull) return null;
  switch (op) {
    case "=":
    case "==":
    case "<=":
    case ">=":
      return booleanValue(true);
    case "!=":
    case "<>":
    case "<":
    case ">":
      return booleanValue(false);
    default:
      return null;
  }
}

function rowValuesEqual(left: SqlValue[], right: SqlValue[]): boolean | null {
  if (left.length !== right.length) return false;
  let sawNull = false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const b = right[i]!;
    if (a === null || b === null) {
      sawNull = true;
      continue;
    }
    const cmp = compareSql(a, b);
    if (cmp === null) {
      sawNull = true;
      continue;
    }
    if (cmp !== 0) return false;
  }
  return sawNull ? null : true;
}

/** COLLATE name on `expr`, if any (does not walk column inheritance). */
export function explicitCollation(expr: Expr): string | null {
  switch (expr.type) {
    case "collate":
      return expr.collation;
    case "unary":
    case "cast":
      return explicitCollation(expr.expr);
    case "is_bool":
      return explicitCollation(expr.expr);
    case "binary":
      return explicitCollation(expr.left) ?? explicitCollation(expr.right);
    case "between":
      return explicitCollation(expr.expr) ?? explicitCollation(expr.lower) ?? explicitCollation(expr.upper);
    case "in":
      return (
        explicitCollation(expr.expr) ??
        (Array.isArray(expr.values) ? (expr.values.map(explicitCollation).find((name) => name !== null) ?? null) : null)
      );
    case "like":
      return explicitCollation(expr.expr) ?? explicitCollation(expr.pattern);
    case "case":
      return (
        (expr.base && explicitCollation(expr.base)) ??
        expr.whens
          .flatMap((branch) => [branch.when, branch.then])
          .map(explicitCollation)
          .find((name) => name !== null) ??
        (expr.else && explicitCollation(expr.else)) ??
        null
      );
    case "row":
      return expr.values.map(explicitCollation).find((name) => name !== null) ?? null;
    default:
      return null;
  }
}

/** Explicit COLLATE wins; otherwise inherit declared column collation (left then right). */
function resolveComparisonCollation(leftExpr: Expr, rightExpr: Expr, ctx: EvalContext): string | null {
  const explicit = explicitCollation(leftExpr) ?? explicitCollation(rightExpr);
  if (explicit) return explicit;
  return inheritedCollation(leftExpr, ctx) ?? inheritedCollation(rightExpr, ctx);
}

function inheritedCollation(expr: Expr, ctx: EvalContext): string | null {
  switch (expr.type) {
    case "collate":
      return inheritedCollation(expr.expr, ctx);
    case "column":
      return (
        ctx.resolveCollation?.(expr.table, expr.name) ?? ctx.parent?.resolveCollation?.(expr.table, expr.name) ?? null
      );
    case "unary":
    case "cast":
      return inheritedCollation(expr.expr, ctx);
    case "is_bool":
      return inheritedCollation(expr.expr, ctx);
    default:
      return null;
  }
}

function resolveComparisonAffinity(expr: Expr, ctx: EvalContext): Affinity | null {
  switch (expr.type) {
    case "column":
      return (
        ctx.resolveAffinity?.(expr.table, expr.name) ?? ctx.parent?.resolveAffinity?.(expr.table, expr.name) ?? null
      );
    case "cast":
      return affinityFromTypeName(expr.typeName);
    case "collate":
      return resolveComparisonAffinity(expr.expr, ctx);
    default:
      return null;
  }
}

function evalIn(left: SqlValue, values: SqlValue[], not: boolean, leftAffinity: Affinity | null): SqlValue {
  if (values.length === 0) return booleanValue(not);
  if (left === null) return null;
  let sawNull = false;
  for (const value of values) {
    if (value === null) {
      sawNull = true;
    } else if (compareSql(...applyComparisonAffinity(left, value, leftAffinity, null)) === 0) {
      return booleanValue(!not);
    }
  }
  if (sawNull) return null;
  return booleanValue(not);
}

/**
 * Evaluate a parsed SQL expression against `ctx` (columns, parameters, functions).
 *
 * @param expr - Expression AST node from {@link parse}.
 * @param ctx - Column / parameter / function resolution.
 */
export function evalExpr(expr: Expr, ctx: EvalContext): SqlValue {
  switch (expr.type) {
    case "literal": {
      if (expr.forceReal && typeof expr.value === "number") {
        return asSqlReal(expr.value);
      }
      return expr.value;
    }
    case "null":
      return null;
    case "column":
      return resolveColumn(ctx, expr.table, expr.name);
    case "parameter":
      return ctx.getParameter(expr.name);
    case "collate":
      return evalExpr(expr.expr, ctx);
    case "unary": {
      const value = evalExpr(expr.expr, ctx);
      if (expr.op === "NOT") {
        const truth = isTruthySql(value);
        return truth === null ? null : booleanValue(!truth);
      }
      if (value === null) return null;
      if (expr.op === "+") {
        const n = asNumber(numberValue(value));
        return storageClassOf(value) === "real" ? asSqlReal(n) : n;
      }
      if (expr.op === "-") {
        const n = asNumber(-numberValue(value));
        return storageClassOf(value) === "real" ? asSqlReal(n) : n;
      }
      return ~integerValue(value);
    }
    case "is_bool": {
      const truth = isTruthySql(evalExpr(expr.expr, ctx));
      if (!expr.not && expr.sense) return booleanValue(truth === true);
      if (!expr.not && !expr.sense) return booleanValue(truth === false);
      if (expr.not && expr.sense) return booleanValue(truth !== true);
      return booleanValue(truth !== false);
    }
    case "binary":
      return evalBinary(expr.op, expr.left, expr.right, ctx);
    case "between": {
      const value = evalExpr(expr.expr, ctx);
      const collation =
        resolveComparisonCollation(expr.expr, expr.lower, ctx) ??
        resolveComparisonCollation(expr.expr, expr.upper, ctx) ??
        undefined;
      const affinity = resolveComparisonAffinity(expr.expr, ctx);
      const lower = compareResult(">=", value, evalExpr(expr.lower, ctx), collation, affinity);
      const result = sqlAnd(lower, () => compareResult("<=", value, evalExpr(expr.upper, ctx), collation, affinity));
      if (result === null) return null;
      return expr.not ? booleanValue(result === 0) : result;
    }
    case "in": {
      if (expr.expr.type === "row" && Array.isArray(expr.values)) {
        const left = expr.expr.values.map((value) => evalExpr(value, ctx));
        let sawNull = false;
        let found = false;
        for (const candidate of expr.values) {
          if (candidate.type !== "row") {
            throw new SqliteError("row value misused", "misuse");
          }
          const right = candidate.values.map((value) => evalExpr(value, ctx));
          const eq = rowValuesEqual(left, right);
          if (eq === true) {
            found = true;
            break;
          }
          if (eq === null) sawNull = true;
        }
        if (found) return booleanValue(!expr.not);
        if (sawNull) return null;
        return booleanValue(expr.not);
      }
      const left = evalExpr(expr.expr, ctx);
      const values = Array.isArray(expr.values)
        ? expr.values.map((value) => evalExpr(value, ctx))
        : executeSelect(ctx, expr.values).rows.map((row) => row[0] ?? null);
      return evalIn(left, values, expr.not, resolveComparisonAffinity(expr.expr, ctx));
    }
    case "like": {
      const value = evalExpr(expr.expr, ctx);
      const pattern = evalExpr(expr.pattern, ctx);
      const escape = expr.escape === null ? null : evalExpr(expr.escape, ctx);
      if (value === null || pattern === null || (escape === null && expr.escape !== null)) return null;
      const match =
        expr.op === "LIKE"
          ? likeMatch(
              textValue(value),
              textValue(pattern),
              escape === null ? null : textValue(escape),
              ctx.functionContext?.caseSensitiveLike === true,
            )
          : globMatch(textValue(value), textValue(pattern));
      return booleanValue(expr.not ? !match : match);
    }
    case "case": {
      if (expr.base === null) {
        for (const branch of expr.whens) {
          if (isTruthySql(evalExpr(branch.when, ctx)) === true) return evalExpr(branch.then, ctx);
        }
      } else {
        const base = evalExpr(expr.base, ctx);
        for (const branch of expr.whens) {
          if (compareSql(base, evalExpr(branch.when, ctx)) === 0) return evalExpr(branch.then, ctx);
        }
      }
      return expr.else === null ? null : evalExpr(expr.else, ctx);
    }
    case "cast":
      return castSqlValue(evalExpr(expr.expr, ctx), expr.typeName);
    case "function": {
      if (expr.args === "*") throw new SqliteError(`wrong number of arguments to function ${expr.name}()`, "misuse");
      if (expr.name.toLowerCase() === "raise") {
        evalRaiseFunction(expr.args, ctx);
        throw new SqliteError("RAISE() did not abort execution", "misuse");
      }
      if (
        expr.name.toLowerCase() === "typeof" &&
        expr.args.length === 1 &&
        expr.args[0]?.type === "column" &&
        ctx.resolveStorageClass
      ) {
        return ctx.resolveStorageClass(expr.args[0].table, expr.args[0].name);
      }
      const fn = (ctx.functions ?? defaultFunctionRegistry).lookupScalar(expr.name);
      if (!fn) throw new SqliteError(`no such function: ${expr.name}`, "other");
      return fn(
        expr.args.map((arg) => evalExpr(arg, ctx)),
        ctx.functionContext ?? {},
      );
    }
    case "exists": {
      const exists = executeSelect(ctx, expr.select).rows.length > 0;
      return booleanValue(expr.not ? !exists : exists);
    }
    case "subquery": {
      const result = executeSelect(ctx, expr.select);
      if (result.columns.length > 1) throw new SqliteError("sub-select returns more than 1 column", "other");
      return result.rows[0]?.[0] ?? null;
    }
    case "aggregate":
      throw new SqliteError("window expression requires window evaluation", "misuse");
    case "window":
      throw new SqliteError("misuse of window function", "misuse");
    case "row":
      throw new SqliteError("row value cannot be used as a scalar value", "misuse");
  }
}

function evalRaiseFunction(args: Expr[], ctx: EvalContext): never {
  if (!ctx.raise) throw new SqliteError("RAISE() may only be used within a trigger-program", "other");
  if (args.length < 1 || args.length > 2) {
    throw new SqliteError("wrong number of arguments to function RAISE()", "misuse");
  }
  const action = raiseActionName(args[0]!);
  if (!action) throw new SqliteError("bad argument to RAISE()", "other");
  let message: string | undefined;
  if (args.length === 2) {
    const value = evalExpr(args[1]!, ctx);
    message = value === null ? undefined : String(value);
  }
  ctx.raise(action, message);
  throw new SqliteError(message ?? "RAISE", "other");
}

function raiseActionName(expr: Expr): "IGNORE" | "ABORT" | "FAIL" | "ROLLBACK" | null {
  if (expr.type === "column" && expr.table === null) {
    const name = expr.name.toUpperCase();
    if (name === "IGNORE" || name === "ABORT" || name === "FAIL" || name === "ROLLBACK") return name;
  }
  if (expr.type === "literal" && typeof expr.value === "string") {
    const name = expr.value.toUpperCase();
    if (name === "IGNORE" || name === "ABORT" || name === "FAIL" || name === "ROLLBACK") return name;
  }
  return null;
}
