import { pgError } from "../errors/error.ts";
import { pgRegexToJs, regexFlags } from "../expressions/pattern.ts";
import { JSONB_NULL, type JsonbValue, jsonbBool, jsonbKeyCompare, jsonbNum, jsonbStr } from "./jsonb.ts";
import {
  type Numeric,
  numericAbs,
  numericAdd,
  numericCeil,
  numericCmp,
  numericDiv,
  numericFloor,
  numericFromBigInt,
  numericIsZero,
  numericMod,
  numericMul,
  numericNeg,
  numericSub,
  numericText,
  numericToBigInt,
  parseNumeric,
} from "./numeric.ts";

/**
 * SQL/JSON path (https://www.postgresql.org/docs/18/functions-json.html#FUNCTIONS-SQLJSON-PATH):
 * `lax` / `strict` modes, accessors (`.key`, `.*`, `[n]`, `[*]`, `[a to b]`, `last`), filters
 * (`? (@.a > 1)` with `&&`, `||`, `!`, `exists`, `like_regex`, `starts with`, `is unknown`),
 * arithmetic, `$var` variables and the item methods `type() size() double() ceiling() floor() abs()`.
 * Not modelled (refused with 0A000): `.**`, `.keyvalue()`, the datetime methods and `.bigint()`-style
 * conversions.
 */

// --- syntax tree -----------------------------------------------------------------

type Accessor =
  | { k: "member"; name: string }
  | { k: "wildcardMember" }
  | { k: "index"; subscripts: Array<{ from: Node; to: Node | null }> }
  | { k: "wildcardIndex" }
  | { k: "method"; name: string }
  | { k: "filter"; predicate: Node };

type Node =
  | { k: "root" }
  | { k: "cur" }
  | { k: "last" }
  | { k: "var"; name: string }
  | { k: "lit"; v: JsonbValue }
  | { k: "acc"; base: Node; acc: Accessor }
  | { k: "unary"; op: "+" | "-"; e: Node }
  | { k: "arith"; op: "+" | "-" | "*" | "/" | "%"; l: Node; r: Node }
  | { k: "cmp"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; l: Node; r: Node }
  | { k: "and" | "or"; l: Node; r: Node }
  | { k: "not"; e: Node }
  | { k: "isUnknown"; e: Node }
  | { k: "exists"; e: Node }
  | { k: "likeRegex"; e: Node; pattern: string; flags: string }
  | { k: "startsWith"; l: Node; r: Node };

export interface JsonPath {
  strict: boolean;
  expr: Node;
  /** a predicate at the top (`$.a > 1`) yields true, false or null instead of path items */
  predicate: boolean;
}

// --- errors -----------------------------------------------------------------

/** A run-time error of a path (`jsonb_path_*` raise it unless `silent`). */
export class JsonPathError extends Error {
  constructor(
    message: string,
    readonly sqlState: string,
  ) {
    super(message);
  }
}

const fail = (message: string, sqlState = "22023"): never => {
  throw new JsonPathError(message, sqlState);
};

// --- lexer ---------------------------------------------------------------------------

type Token =
  | { t: "num"; v: string; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "ident"; v: string; at: number }
  | { t: "var"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "eof"; v: ""; at: number };

const syntaxError = (at: number | null, near: string | null): never => {
  const where = near === null || at === null ? "at end of jsonpath input" : `at or near "${near}" of jsonpath input`;
  throw pgError("syntax", `syntax error ${where}`, "42601");
};

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const bad = (at: number, near: string): never => syntaxError(at, near);
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (c === '"') {
      let out = "";
      i++;
      for (;;) {
        if (i >= input.length) return syntaxError(null, null);
        const d = input[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\") {
          const e = input[i + 1];
          const simple: Record<string, string> = {
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
            v: "\v",
            '"': '"',
            "\\": "\\",
            "/": "/",
          };
          if (e !== undefined && e in simple) {
            out += simple[e];
            i += 2;
          } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(input.slice(i + 2, i + 6))) {
            out += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16));
            i += 6;
          } else if (e !== undefined) {
            out += e;
            i += 2;
          } else return syntaxError(null, null);
        } else {
          out += d;
          i++;
        }
      }
      tokens.push({ t: "str", v: out, at });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(i))!;
      i += m[0].length;
      if (/[A-Za-z_]/.test(input[i] ?? "")) return bad(at, input.slice(at, i + 1));
      tokens.push({ t: "num", v: m[0], at });
      continue;
    }
    if (c === "$" || c === "@") {
      // `$name` / `$"name"` is a variable; a bare `$` is the root item
      if (c === "$" && /[A-Za-z_]/.test(input[i + 1] ?? "")) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i + 1))!;
        i += 1 + m[0].length;
        tokens.push({ t: "var", v: m[0], at });
      } else if (c === "$" && input[i + 1] === '"') {
        const sub = lex(input.slice(i + 1).replace(/^("(?:[^"\\]|\\.)*").*$/s, "$1"));
        const name = sub[0]!;
        if (name.t !== "str") return bad(at, "$");
        i += 1 + input.slice(i + 1).replace(/^("(?:[^"\\]|\\.)*").*$/s, "$1").length;
        tokens.push({ t: "var", v: name.v, at });
      } else {
        i++;
        tokens.push({ t: "op", v: c, at });
      }
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i))!;
      i += m[0].length;
      tokens.push({ t: "ident", v: m[0], at });
      continue;
    }
    const two = input.slice(i, i + 2);
    if (["==", "!=", "<>", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ t: "op", v: two === "<>" ? "!=" : two, at });
      i += 2;
      continue;
    }
    if ("+-*/%()[],.?<>!".includes(c)) {
      tokens.push({ t: "op", v: c, at });
      i++;
      continue;
    }
    return bad(at, c);
  }
  tokens.push({ t: "eof", v: "", at: input.length });
  return tokens;
}

// --- parser ---------------------------------------------------------------------------

const KEYWORD_METHODS = new Set(["type", "size", "double", "ceiling", "floor", "abs"]);
const UNSUPPORTED_METHODS = new Set([
  "keyvalue",
  "datetime",
  "date",
  "time",
  "time_tz",
  "timestamp",
  "timestamp_tz",
  "bigint",
  "integer",
  "number",
  "string",
  "boolean",
  "decimal",
]);

class PathParser {
  private pos = 0;
  /** how many array subscripts enclose the token being parsed (`last` needs one) */
  private subscripts = 0;
  private readonly tokens: Token[];
  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private fail(): never {
    const token = this.peek();
    // PostgreSQL's scanner reports a bare word as the end of the input
    return token.t === "eof" || token.t === "ident"
      ? syntaxError(null, null)
      : syntaxError(token.at, token.t === "str" ? `"${token.v}"` : token.v);
  }

  private atOp(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.t === "op" && token.v === value;
  }

  private atWord(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.t === "ident" && token.v === value;
  }

  private eatOp(value: string): boolean {
    if (!this.atOp(value)) return false;
    this.pos++;
    return true;
  }

  private expectOp(value: string): void {
    if (!this.eatOp(value)) this.fail();
  }

  parse(): JsonPath {
    let strict = false;
    if (this.atWord("strict") || this.atWord("lax")) {
      strict = this.peek().v === "strict";
      this.pos++;
    }
    const expr = this.parseOr();
    if (this.peek().t !== "eof") this.fail();
    return { strict, expr, predicate: isPredicate(expr) };
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.eatOp("||")) left = { k: "or", l: left, r: this.parseAnd() };
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseUnaryPredicate();
    while (this.eatOp("&&")) left = { k: "and", l: left, r: this.parseUnaryPredicate() };
    return left;
  }

  private parseUnaryPredicate(): Node {
    if (this.atOp("!")) {
      this.pos++;
      // `!` negates a predicate: `!(...)` or `!exists(...)`
      return { k: "not", e: this.parseUnaryPredicate() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Node {
    const left = this.parseAdditive();
    const token = this.peek();
    if (token.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(token.v)) {
      this.pos++;
      return { k: "cmp", op: token.v as "==", l: left, r: this.parseAdditive() };
    }
    if (this.atWord("like_regex")) {
      this.pos++;
      const pattern = this.peek();
      if (pattern.t !== "str") return this.fail();
      this.pos++;
      let flags = "";
      if (this.atWord("flag")) {
        this.pos++;
        const flagToken = this.peek();
        if (flagToken.t !== "str") return this.fail();
        this.pos++;
        flags = flagToken.v;
      }
      return { k: "likeRegex", e: left, pattern: pattern.v, flags };
    }
    if (this.atWord("starts") && this.atWord("with", 1)) {
      this.pos += 2;
      return { k: "startsWith", l: left, r: this.parseAdditive() };
    }
    if (this.atWord("is") && this.atWord("unknown", 1)) {
      this.pos += 2;
      return { k: "isUnknown", e: left };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.atOp("+") || this.atOp("-")) {
        const op = this.peek().v as "+" | "-";
        this.pos++;
        left = { k: "arith", op, l: left, r: this.parseMultiplicative() };
      } else return left;
    }
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    for (;;) {
      if (this.atOp("*") || this.atOp("/") || this.atOp("%")) {
        const op = this.peek().v as "*" | "/" | "%";
        this.pos++;
        left = { k: "arith", op, l: left, r: this.parseUnary() };
      } else return left;
    }
  }

  private parseUnary(): Node {
    if (this.atOp("+") || this.atOp("-")) {
      const op = this.peek().v as "+" | "-";
      this.pos++;
      return { k: "unary", op, e: this.parseUnary() };
    }
    return this.parseAccessors(this.parsePrimary());
  }

  private parsePrimary(): Node {
    const token = this.peek();
    if (token.t === "num") {
      this.pos++;
      return { k: "lit", v: jsonbNum(parseNumeric(token.v.startsWith(".") ? `0${token.v}` : token.v)) };
    }
    if (token.t === "str") {
      this.pos++;
      return { k: "lit", v: jsonbStr(token.v) };
    }
    if (token.t === "var") {
      this.pos++;
      return { k: "var", name: token.v };
    }
    if (token.t === "op") {
      if (token.v === "$") {
        this.pos++;
        return { k: "root" };
      }
      if (token.v === "@") {
        this.pos++;
        return { k: "cur" };
      }
      if (token.v === "(") {
        this.pos++;
        const inner = this.parseOr();
        this.expectOp(")");
        return inner;
      }
    }
    if (token.t === "ident") {
      if (token.v === "true" || token.v === "false") {
        this.pos++;
        return { k: "lit", v: jsonbBool(token.v === "true") };
      }
      if (token.v === "null") {
        this.pos++;
        return { k: "lit", v: JSONB_NULL };
      }
      if (token.v === "last") {
        if (this.subscripts === 0) throw pgError("syntax", "LAST is allowed only in array subscripts", "42601");
        this.pos++;
        return { k: "last" };
      }
      if (token.v === "exists" && this.atOp("(", 1)) {
        this.pos += 2;
        const inner = this.parseOr();
        this.expectOp(")");
        return { k: "exists", e: inner };
      }
    }
    return this.fail();
  }

  private parseAccessors(base: Node): Node {
    let node = base;
    for (;;) {
      if (this.atOp(".")) {
        this.pos++;
        const token = this.peek();
        if (token.t === "op" && token.v === "*") {
          this.pos++;
          if (this.atOp("*")) {
            throw pgError(
              "feature_not_supported",
              "jsonpath recursive wildcard accessor .** is not supported",
              "0A000",
            );
          }
          node = { k: "acc", base: node, acc: { k: "wildcardMember" } };
        } else if (token.t === "op" && token.v === "**") {
          throw pgError("feature_not_supported", "jsonpath recursive wildcard accessor .** is not supported", "0A000");
        } else if (token.t === "str") {
          this.pos++;
          node = { k: "acc", base: node, acc: { k: "member", name: token.v } };
        } else if (token.t === "ident") {
          this.pos++;
          if (this.atOp("(")) {
            if (UNSUPPORTED_METHODS.has(token.v)) {
              throw pgError("feature_not_supported", `jsonpath item method .${token.v}() is not supported`, "0A000");
            }
            if (!KEYWORD_METHODS.has(token.v)) this.fail();
            this.pos++;
            this.expectOp(")");
            node = { k: "acc", base: node, acc: { k: "method", name: token.v } };
          } else node = { k: "acc", base: node, acc: { k: "member", name: token.v } };
        } else this.fail();
      } else if (this.atOp("[")) {
        this.pos++;
        if (this.atOp("*")) {
          this.pos++;
          this.expectOp("]");
          node = { k: "acc", base: node, acc: { k: "wildcardIndex" } };
          continue;
        }
        const subscripts: Array<{ from: Node; to: Node | null }> = [];
        this.subscripts++;
        do {
          const from = this.parseAdditive();
          let to: Node | null = null;
          if (this.atWord("to")) {
            this.pos++;
            to = this.parseAdditive();
          }
          subscripts.push({ from, to });
        } while (this.eatOp(","));
        this.subscripts--;
        this.expectOp("]");
        node = { k: "acc", base: node, acc: { k: "index", subscripts } };
      } else if (this.atOp("?")) {
        this.pos++;
        this.expectOp("(");
        const predicate = this.parseOr();
        this.expectOp(")");
        node = { k: "acc", base: node, acc: { k: "filter", predicate } };
      } else return node;
    }
  }
}

function isPredicate(node: Node): boolean {
  switch (node.k) {
    case "cmp":
    case "and":
    case "or":
    case "not":
    case "isUnknown":
    case "exists":
    case "likeRegex":
    case "startsWith":
      return true;
    default:
      return false;
  }
}

/** Parse a jsonpath, raising 42601 as PostgreSQL's jsonpath input function does. */
export function parseJsonpath(text: string): JsonPath {
  if (text.trim() === "") {
    throw pgError("invalid_text_representation", `invalid input syntax for type jsonpath: "${text}"`, "22P02");
  }
  return new PathParser(text).parse();
}

// --- output -------------------------------------------------------------------------------

const quote = (text: string): string => JSON.stringify(text);

const PRIORITY: Record<string, number> = {
  or: 0,
  and: 1,
  cmp: 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "%": 4,
  unary: 5,
};

const priorityOf = (node: Node): number => {
  switch (node.k) {
    case "or":
    case "and":
      return PRIORITY[node.k]!;
    case "cmp":
      return PRIORITY.cmp!;
    case "arith":
      return PRIORITY[node.op]!;
    case "unary":
      return PRIORITY.unary!;
    default:
      return 6;
  }
};

function printNode(node: Node, brackets: boolean): string {
  const operand = (child: Node, parent: Node): string => printNode(child, priorityOf(child) <= priorityOf(parent));
  const wrap = (text: string): string => (brackets ? `(${text})` : text);
  switch (node.k) {
    case "root":
      return "$";
    case "cur":
      return "@";
    case "last":
      return "last";
    case "var":
      return `$${quote(node.name)}`;
    case "lit":
      return node.v.j === "str"
        ? quote(node.v.v)
        : node.v.j === "num"
          ? numericText(node.v.v)
          : node.v.j === "bool"
            ? String(node.v.v)
            : "null";
    case "acc": {
      const base = printNode(node.base, true);
      const acc = node.acc;
      switch (acc.k) {
        case "member":
          return `${base}.${quote(acc.name)}`;
        case "wildcardMember":
          return `${base}.*`;
        case "wildcardIndex":
          return `${base}[*]`;
        case "method":
          return `${base}.${acc.name}()`;
        case "filter":
          return `${base}?(${printNode(acc.predicate, false)})`;
        case "index": {
          const subs = acc.subscripts.map(({ from, to }) => {
            const f = printNode(from, false);
            return to === null ? f : `${f} to ${printNode(to, false)}`;
          });
          return `${base}[${subs.join(",")}]`;
        }
      }
      return base;
    }
    case "unary":
      return wrap(`${node.op}${operand(node.e, node)}`);
    case "arith":
      return wrap(`${operand(node.l, node)} ${node.op} ${operand(node.r, node)}`);
    case "cmp":
      return wrap(`${operand(node.l, node)} ${node.op} ${operand(node.r, node)}`);
    case "and":
      return wrap(`${operand(node.l, node)} && ${operand(node.r, node)}`);
    case "or":
      return wrap(`${operand(node.l, node)} || ${operand(node.r, node)}`);
    case "not":
      return `!(${printNode(node.e, false)})`;
    case "exists":
      return `exists (${printNode(node.e, false)})`;
    case "isUnknown":
      return `(${printNode(node.e, false)}) is unknown`;
    case "likeRegex":
      return wrap(
        `${printNode(node.e, priorityOf(node.e) <= PRIORITY.cmp!)} like_regex ${quote(node.pattern)}${node.flags ? ` flag ${quote(node.flags)}` : ""}`,
      );
    case "startsWith":
      return wrap(
        `${printNode(node.l, priorityOf(node.l) <= PRIORITY.cmp!)} starts with ${printNode(node.r, priorityOf(node.r) <= PRIORITY.cmp!)}`,
      );
  }
}

/** The text output of a `jsonpath`: PostgreSQL's canonical spelling (`$."a"?(@ > 1)`), whatever the input spelling was. */
export function jsonpathText(text: string): string {
  const path = parseJsonpath(text);
  return `${path.strict ? "strict " : ""}${printNode(path.expr, true)}`;
}

// --- evaluation --------------------------------------------------------------------------

type Truth = boolean | null;

interface Run {
  root: JsonbValue;
  vars: Map<string, JsonbValue>;
  strict: boolean;
  /** the item `@` stands for inside a filter */
  cur: JsonbValue | null;
  /** the length of the array a subscript is evaluated against (for `last`) */
  last: number | null;
}

const isNum = (v: JsonbValue): v is Extract<JsonbValue, { j: "num" }> => v.j === "num";

function typeName(v: JsonbValue): string {
  return { null: "null", bool: "boolean", num: "number", str: "string", arr: "array", obj: "object" }[v.j];
}

/** Lax mode flattens an array operand one level: its elements stand in for it. */
function unwrap(run: Run, items: JsonbValue[]): JsonbValue[] {
  if (run.strict) return items;
  return items.flatMap((item) => (item.j === "arr" ? item.v : [item]));
}

function evalNode(run: Run, node: Node): JsonbValue[] {
  switch (node.k) {
    case "root":
      return [run.root];
    case "cur":
      return run.cur === null ? [] : [run.cur];
    case "last":
      if (run.last === null) return fail("evaluating jsonpath LAST outside of array subscript", "42P20");
      return [jsonbNum(numericFromBigInt(BigInt(run.last - 1)))];
    case "var": {
      const value = run.vars.get(node.name);
      // not a path error: it is raised even in silent mode and inside filters
      if (value === undefined)
        throw pgError("undefined_object", `could not find jsonpath variable "${node.name}"`, "42704");
      return [value];
    }
    case "lit":
      return [node.v];
    case "acc":
      return evalAccessor(run, evalNode(run, node.base), node.acc);
    case "unary": {
      const items = unwrap(run, evalNode(run, node.e));
      return items.map((item) => {
        if (!isNum(item)) {
          return fail(`operand of unary jsonpath operator ${node.op} is not a numeric value`, "2203B");
        }
        return node.op === "-" ? jsonbNum(numericNeg(item.v)) : item;
      });
    }
    case "arith":
      return [evalArith(run, node)];
    case "cmp":
    case "and":
    case "or":
    case "not":
    case "isUnknown":
    case "exists":
    case "likeRegex":
    case "startsWith": {
      const truth = evalPredicate(run, node);
      return [truth === null ? JSONB_NULL : jsonbBool(truth)];
    }
  }
}

function single(run: Run, node: Node, what: string): JsonbValue {
  const items = evalNode(run, node);
  if (items.length !== 1) return fail(`${what} is not a single numeric value`, "22038");
  return items[0]!;
}

function evalArith(run: Run, node: Extract<Node, { k: "arith" }>): JsonbValue {
  const operand = (side: Node, label: string): Numeric => {
    const items = unwrap(run, evalNode(run, side));
    if (items.length !== 1 || !isNum(items[0]!)) {
      return fail(`${label} operand of jsonpath operator ${node.op} is not a single numeric value`, "22038");
    }
    return items[0]!.v;
  };
  const l = operand(node.l, "left");
  const r = operand(node.r, "right");
  switch (node.op) {
    case "+":
      return jsonbNum(numericAdd(l, r));
    case "-":
      return jsonbNum(numericSub(l, r));
    case "*":
      return jsonbNum(numericMul(l, r));
    case "/":
      if (numericIsZero(r)) return fail("division by zero", "22012");
      return jsonbNum(numericDiv(l, r));
    case "%":
      if (numericIsZero(r)) return fail("division by zero", "22012");
      return jsonbNum(numericMod(l, r));
  }
}

function evalAccessor(run: Run, items: JsonbValue[], acc: Accessor): JsonbValue[] {
  const out: JsonbValue[] = [];
  for (const item of items) {
    switch (acc.k) {
      case "member": {
        const apply = (v: JsonbValue) => {
          if (v.j === "obj") {
            const found = v.v.get(acc.name);
            if (found !== undefined) out.push(found);
            else if (run.strict) fail(`JSON object does not contain key "${acc.name}"`, "2203A");
          } else if (run.strict) fail("jsonpath member accessor can only be applied to an object", "2203A");
        };
        if (item.j === "arr" && !run.strict) for (const element of item.v) apply(element);
        else apply(item);
        break;
      }
      case "wildcardMember": {
        const apply = (v: JsonbValue) => {
          if (v.j === "obj")
            out.push(
              ...[...v.v.entries()]
                .sort(([a], [b]) => a.length - b.length || jsonbKeyCompare(a, b))
                .map(([, value]) => value),
            );
          else if (run.strict) fail("jsonpath wildcard member accessor can only be applied to an object", "2203A");
        };
        if (item.j === "arr" && !run.strict) for (const element of item.v) apply(element);
        else apply(item);
        break;
      }
      case "wildcardIndex":
      case "index": {
        let array: JsonbValue[];
        if (item.j === "arr") array = item.v;
        else if (run.strict) return fail("jsonpath array accessor can only be applied to an array", "22039");
        else array = [item];
        if (acc.k === "wildcardIndex") {
          out.push(...array);
          break;
        }
        const inner: Run = { ...run, last: array.length };
        const toIndex = (node: Node): number => {
          const v = single(inner, node, "jsonpath array subscript");
          if (!isNum(v)) return fail("jsonpath array subscript is not a single numeric value", "22033");
          return Number(numericToBigInt(numericFloorToward(v.v)));
        };
        for (const { from, to } of acc.subscripts) {
          const lo = toIndex(from);
          const hi = to === null ? lo : toIndex(to);
          if (run.strict && (lo < 0 || hi >= array.length || lo > hi)) {
            return fail("jsonpath array subscript is out of bounds", "22033");
          }
          for (let i = Math.max(lo, 0); i <= Math.min(hi, array.length - 1); i++) out.push(array[i]!);
        }
        break;
      }
      case "method":
        out.push(...evalMethod(run, item, acc.name));
        break;
      case "filter": {
        const candidates = item.j === "arr" && !run.strict ? item.v : [item];
        for (const candidate of candidates) {
          if (evalPredicate({ ...run, cur: candidate }, acc.predicate) === true) out.push(candidate);
        }
        break;
      }
    }
  }
  return out;
}

/** Truncation toward zero, which is how a numeric subscript becomes an index. */
function numericFloorToward(n: Numeric): Numeric {
  return numericCmp(n, numericFromBigInt(0n)) < 0 ? numericCeil(n) : numericFloor(n);
}

function evalMethod(run: Run, item: JsonbValue, name: string): JsonbValue[] {
  switch (name) {
    case "type":
      return [jsonbStr(typeName(item))];
    case "size":
      if (item.j === "arr") return [jsonbNum(numericFromBigInt(BigInt(item.v.length)))];
      if (run.strict) return fail("jsonpath item method .size() can only be applied to an array", "22039");
      return [jsonbNum(numericFromBigInt(1n))];
    default: {
      // the numeric methods look through an array in lax mode
      if (item.j === "arr" && !run.strict) return item.v.flatMap((element) => evalMethod(run, element, name));
      if (name === "double") {
        if (isNum(item)) return [item];
        if (item.j === "str") {
          const text = item.v.trim();
          if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
            return fail(
              `argument "${item.v}" of jsonpath item method .double() is invalid for type double precision`,
              "22036",
            );
          }
          return [jsonbNum(parseNumeric(text))];
        }
        return fail("jsonpath item method .double() can only be applied to a string or numeric value", "22036");
      }
      if (!isNum(item)) {
        return fail(`jsonpath item method .${name}() can only be applied to a numeric value`, "22036");
      }
      const apply = { ceiling: numericCeil, floor: numericFloor, abs: numericAbs }[name]!;
      return [jsonbNum(apply(item.v))];
    }
  }
}

// --- predicates ------------------------------------------------------------------------------

const and3 = (a: Truth, b: Truth): Truth =>
  a === false || b === false ? false : a === null || b === null ? null : true;
const or3 = (a: Truth, b: Truth): Truth => (a === true || b === true ? true : a === null || b === null ? null : false);

function compareItems(op: string, a: JsonbValue, b: JsonbValue): Truth {
  if (a.j !== b.j) {
    // null is comparable with everything: equal only to null
    if (a.j === "null" || b.j === "null") return op === "!=";
    return null;
  }
  let c: number;
  switch (a.j) {
    case "null":
      c = 0;
      break;
    case "bool":
      c = a.v === (b as typeof a).v ? 0 : a.v ? 1 : -1;
      break;
    case "num":
      c = numericCmp(a.v, (b as typeof a).v);
      break;
    case "str":
      c = a.v < (b as typeof a).v ? -1 : a.v > (b as typeof a).v ? 1 : 0;
      break;
    default:
      // arrays and objects are not comparable
      return null;
  }
  switch (op) {
    case "==":
      return c === 0;
    case "!=":
      return c !== 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    default:
      return c >= 0;
  }
}

/** Run an operand; an error in it makes the predicate unknown instead of failing the path. */
function quietly<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof JsonPathError) return { ok: false };
    throw error;
  }
}

function evalPredicate(run: Run, node: Node): Truth {
  switch (node.k) {
    case "and":
      return and3(evalPredicate(run, node.l), evalPredicate(run, node.r));
    case "or":
      return or3(evalPredicate(run, node.l), evalPredicate(run, node.r));
    case "not": {
      const inner = evalPredicate(run, node.e);
      return inner === null ? null : !inner;
    }
    case "isUnknown":
      return evalPredicate(run, node.e) === null;
    case "exists": {
      const items = quietly(() => evalNode(run, node.e));
      return items.ok ? items.value.length > 0 : null;
    }
    case "cmp": {
      const left = quietly(() => unwrap(run, evalNode(run, node.l)));
      const right = quietly(() => unwrap(run, evalNode(run, node.r)));
      if (!left.ok || !right.ok) return null;
      let unknown = false;
      let found = false;
      for (const a of left.value) {
        for (const b of right.value) {
          const truth = compareItems(node.op, a, b);
          if (truth === null) {
            unknown = true;
            if (run.strict) return null;
          } else if (truth) {
            if (!run.strict) return true;
            found = true;
          }
        }
      }
      return found ? true : unknown ? null : false;
    }
    case "startsWith": {
      const left = quietly(() => unwrap(run, evalNode(run, node.l)));
      const right = quietly(() => evalNode(run, node.r));
      if (!left.ok || !right.ok) return null;
      if (right.value.length !== 1 || right.value[0]!.j !== "str") return null;
      const prefix = (right.value[0] as { v: string }).v;
      let unknown = false;
      for (const a of left.value) {
        if (a.j !== "str") unknown = true;
        else if (a.v.startsWith(prefix)) return true;
      }
      return unknown ? null : false;
    }
    case "likeRegex": {
      const left = quietly(() => unwrap(run, evalNode(run, node.e)));
      if (!left.ok) return null;
      let re: RegExp;
      try {
        re = new RegExp(pgRegexToJs(node.pattern), regexFlags(node.flags.replaceAll("q", ""), true));
      } catch {
        return fail(`invalid regular expression: ${node.pattern}`, "2201B");
      }
      let unknown = false;
      for (const a of left.value) {
        if (a.j !== "str") unknown = true;
        else if (re.test(a.v)) return true;
      }
      return unknown ? null : false;
    }
    default: {
      // a non-predicate operand: its single boolean value
      const items = quietly(() => evalNode(run, node));
      if (!items.ok || items.value.length !== 1) return null;
      const item = items.value[0]!;
      return item.j === "bool" ? item.v : null;
    }
  }
}

// --- entry points --------------------------------------------------------------------------------

/**
 * Every item `path` selects in `doc`. `vars` are the `$name` variables; `silent` suppresses
 * the errors a path raises (a lax-mode miss is always silent), giving an empty sequence.
 */
export function jsonpathQuery(
  doc: JsonbValue,
  pathText: string,
  vars: Map<string, JsonbValue> = new Map(),
  silent = false,
): JsonbValue[] {
  const path = parseJsonpath(pathText);
  const run: Run = { root: doc, vars, strict: path.strict, cur: null, last: null };
  try {
    return evalNode(run, path.expr);
  } catch (error) {
    if (error instanceof JsonPathError) {
      if (silent) return [];
      throw pgError("invalid_parameter_value", error.message, error.sqlState);
    }
    throw error;
  }
}

/**
 * First match of a jsonpath against a jsonb document, or null when there is none.
 * JSON null is `{ j: "null" }`.
 */
export function jsonpathQueryFirst(doc: JsonbValue, pathText: string): JsonbValue | null {
  return jsonpathQuery(doc, pathText)[0] ?? null;
}

/** `jsonb_path_exists`: true when the path selects anything; a path that errors raises unless `silent` (then null). */
export function jsonpathExists(
  doc: JsonbValue,
  pathText: string,
  vars: Map<string, JsonbValue> = new Map(),
  silent = false,
): boolean | null {
  const path = parseJsonpath(pathText);
  const run: Run = { root: doc, vars, strict: path.strict, cur: null, last: null };
  try {
    const items = evalNode(run, path.expr);
    // a predicate path exists when it is not unknown
    if (path.predicate) return items[0]?.j === "null" ? null : items.length > 0;
    return items.length > 0;
  } catch (error) {
    if (error instanceof JsonPathError) {
      if (silent) return null;
      throw pgError("invalid_parameter_value", error.message, error.sqlState);
    }
    throw error;
  }
}

/** `jsonb_path_match`: the single boolean a predicate path yields (null for unknown). */
export function jsonpathMatch(
  doc: JsonbValue,
  pathText: string,
  vars: Map<string, JsonbValue> = new Map(),
  silent = false,
): boolean | null {
  const items = jsonpathQuery(doc, pathText, vars, silent);
  const only = items.length === 1 ? items[0] : undefined;
  if (only?.j === "bool") return only.v;
  if (only?.j === "null") return null;
  if (silent) return null;
  throw pgError("invalid_parameter_value", "single boolean result is expected", "22038");
}
