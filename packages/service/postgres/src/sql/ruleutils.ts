import type { Expr, TypeName } from "../ast/nodes.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { evalExpr } from "../expressions/eval.ts";
import type { TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { resolveTypeName } from "../types/resolve.ts";
import {
  arrayElemType,
  type ColumnType,
  datumText,
  isArrayType,
  isEnumType,
  type TypeId,
  tv,
  typeDisplayName,
  UNKNOWN,
} from "../types/value.ts";
import { deparseExpr } from "./deparse.ts";
import { quoteIdentifier } from "./keywords.ts";
import { unsupported } from "../errors/error.ts";
import { SQLJSON_INTERNAL } from "../parser/sqljson.ts";

/**
 * Expression deparsing the way PostgreSQL's ruleutils.c prints a stored expression
 * (pg_get_indexdef, pg_get_expr): constants carry their resolved type, the implicit
 * casts operator resolution added are visible, and parentheses follow the node tree
 * rather than the text the user wrote.
 *
 * PostgreSQL deparses the analyzed tree; this engine keeps the parsed one, so the
 * first half of this file redoes the part of analysis that shows in the output:
 * what type an untyped literal took and where a cast was inserted. It covers the
 * operators, predicates and functions index definitions are written with; anything
 * else falls back to `deparseExpr` and is not claimed to match.
 */

export interface RuleScope {
  ctx: EngineCtx;
  /** table the expression's columns belong to */
  table: TableData | null;
  /** print a column's relation as written (`t.a`): the query reads more than one relation */
  qualify?: boolean;
}

type Typed = TypeId | null;

type Node =
  /** `qualifier`: the OLD / NEW of a trigger's WHEN condition, which ruleutils prints */
  | { k: "var"; name: string; type: Typed; qualifier?: string }
  /** `text` null is SQL NULL; `type` null is an untyped literal nothing has claimed yet */
  | { k: "const"; type: Typed; mod: ColumnType["mod"]; text: string | null }
  | { k: "op"; op: string; args: Node[]; type: Typed }
  | { k: "bool"; op: "AND" | "OR" | "NOT"; args: Node[] }
  | { k: "cast"; arg: Node; type: TypeId; mod: ColumnType["mod"]; implicit: boolean }
  | { k: "func"; name: string; args: Node[]; type: Typed }
  /** function-like syntax with its own keywords: COALESCE(...), EXTRACT(x FROM y), ... */
  | { k: "form"; parts: Array<string | Node>; type: Typed }
  | { k: "nulltest"; arg: Node; not: boolean }
  | { k: "booltest"; arg: Node; test: string }
  | { k: "distinct"; left: Node; right: Node }
  | { k: "saop"; op: string; any: boolean; left: Node; right: Node }
  | { k: "array"; items: Node[]; type: Typed }
  | { k: "case"; arg: Node | null; whens: Array<{ when: Node; result: Node }>; otherwise: Node; type: Typed }
  | { k: "collate"; arg: Node; collation: string }
  | { k: "subscript"; base: Node; indexes: Array<string | Node>; type: Typed }
  | { k: "raw"; text: string; type: Typed };

const BOOL: TypeId = "bool";
const TEXT: TypeId = "text";
const INTEGERS = new Set<Typed>(["int2", "int4", "int8"]);
const FLOATS = new Set<Typed>(["float4", "float8"]);
const NUMBERS = new Set<Typed>(["int2", "int4", "int8", "numeric", "float4", "float8"]);
const STRINGS = new Set<Typed>(["text", "varchar", "bpchar", "name"]);
const COMPARISONS = new Set(["=", "<>", "<", "<=", ">", ">="]);
const PATTERN_OPS = new Set(["~~", "~~*", "!~~", "!~~*", "~", "~*", "!~", "!~*"]);

/** format_type(): the SQL name of a type with its modifier. */
export function formatType(scope: RuleScope, type: TypeId, mod: ColumnType["mod"] = null): string {
  if (isArrayType(type)) return `${formatType(scope, arrayElemType(type), mod)}[]`;
  if (isEnumType(type)) {
    const [schema, name] = type.slice(5).split(".") as [string, string | undefined];
    if (name === undefined) return quoteIdentifier(schema);
    const visible = scope.ctx.state.effectiveSearchPath().includes(schema);
    return visible ? quoteIdentifier(name) : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  }
  const base = typeDisplayName(type);
  // `character` is how char(n) prints; without a length the type goes by its internal name
  if (!mod || mod.a === undefined) return type === "bpchar" ? "bpchar" : base;
  if (type === "numeric") return mod.b === undefined ? `${base}(${mod.a})` : `${base}(${mod.a},${mod.b})`;
  if (type === "varchar" || type === "bpchar" || type === "bit" || type === "varbit") return `${base}(${mod.a})`;
  if (type === "timestamp" || type === "time") return `${base.replace(" ", `(${mod.a}) `)}`;
  if (type === "timestamptz" || type === "timetz") return `${base.replace(" ", `(${mod.a}) `)}`;
  return base;
}

function typeOf(node: Node): Typed {
  switch (node.k) {
    case "bool":
    case "nulltest":
    case "booltest":
    case "distinct":
    case "saop":
      return BOOL;
    case "collate":
      return typeOf(node.arg);
    default:
      return node.type;
  }
}

const isUntyped = (node: Node): node is Extract<Node, { k: "const" }> => node.k === "const" && node.type === null;

class Analyzer {
  private readonly probed = new WeakMap<Expr, Typed>();

  constructor(private readonly scope: RuleScope) {}

  /** Result type of a subexpression, by evaluating it over a row of NULLs. */
  private probe(expr: Expr): Typed {
    if (this.probed.has(expr)) return this.probed.get(expr)!;
    let type: Typed = null;
    const table = this.scope.table;
    try {
      const value = evalExpr(
        this.scope.ctx,
        {
          lookupColumn: (parts) => {
            const column = table?.columns.find((c) => c.name === parts[parts.length - 1]);
            return column ? tv(column.type.id, null) : undefined;
          },
        },
        expr,
      );
      type = value.t === UNKNOWN ? null : value.t;
    } catch {
      type = null;
    }
    this.probed.set(expr, type);
    return type;
  }

  /** Give an untyped literal the type its context resolved it to, in that type's output form. */
  private settle(node: Node, type: TypeId, mod: ColumnType["mod"] = null): Node {
    if (!isUntyped(node)) return node;
    if (node.text === null) return { ...node, type, mod };
    let text = node.text;
    if (!STRINGS.has(type)) {
      try {
        const value = castTo(this.scope.ctx, tv(UNKNOWN, node.text), type, { explicit: true, mod });
        if (value.v !== null) text = datumText(type, value.v, this.scope.ctx);
      } catch {
        // keep the literal as written; the statement that created the index accepted it
      }
    }
    return { k: "const", type, mod, text };
  }

  /** An implicit cast, as operator or function resolution inserts one. */
  private coerce(node: Node, type: TypeId): Node {
    if (isUntyped(node)) return this.settle(node, type);
    const from = typeOf(node);
    if (from === null || from === type) return node;
    return { k: "cast", arg: node, type, mod: null, implicit: true };
  }

  private number(raw: string, negative: boolean): Node {
    const signed = negative ? `-${raw}` : raw;
    if (/^\d+$/.test(raw)) {
      const value = BigInt(signed);
      if (value >= -2147483648n && value <= 2147483647n) return { k: "const", type: "int4", mod: null, text: signed };
      if (value >= -9223372036854775808n && value <= 9223372036854775807n) {
        return { k: "const", type: "int8", mod: null, text: signed };
      }
    }
    return this.settle({ k: "const", type: null, mod: null, text: signed }, "numeric");
  }

  private operator(op: string, left: Node, right: Node, source: Expr): Node {
    let l = left;
    let r = right;
    const lt = typeOf(l);
    const rt = typeOf(r);
    const jsonLeft = lt === "json" || lt === "jsonb";
    if (jsonLeft && (op === "->" || op === "->>")) r = this.settle(r, TEXT);
    else if (jsonLeft && (op === "#>" || op === "#>>")) r = this.settle(r, "text[]");
    else if (lt === "jsonb" && (op === "?|" || op === "?&")) r = this.settle(r, "text[]");
    else if (lt === "jsonb" && op === "?") r = this.settle(r, TEXT);
    else if (PATTERN_OPS.has(op)) {
      // every pattern operator takes the pattern as text; a varchar subject is relabeled to text
      r = this.settle(r, TEXT);
      l = lt === "varchar" ? this.coerce(l, TEXT) : this.settle(l, TEXT);
    } else if (isUntyped(l) || isUntyped(r)) {
      const known = isUntyped(l) ? rt : lt;
      // varchar has no operators of its own: both sides resolve to the text ones
      const target = known === "varchar" || known === null ? TEXT : known;
      l = this.coerce(l, target);
      r = this.coerce(r, target);
    } else if (lt !== null && rt !== null && (COMPARISONS.has(op) || op === "||" || NUMBERS.has(lt))) {
      [l, r] = this.reconcile(l, r);
    }
    return { k: "op", op, args: [l, r], type: COMPARISONS.has(op) || PATTERN_OPS.has(op) ? BOOL : this.probe(source) };
  }

  /** Insert the implicit casts that let one operator take both operands. */
  private reconcile(left: Node, right: Node): [Node, Node] {
    const lt = typeOf(left);
    const rt = typeOf(right);
    if (lt === null || rt === null) return [left, right];
    const both = (type: TypeId): [Node, Node] => [this.coerce(left, type), this.coerce(right, type)];
    if (lt === "varchar" || rt === "varchar") return STRINGS.has(lt) && STRINGS.has(rt) ? both(TEXT) : [left, right];
    if (lt === rt) return [left, right];
    if (STRINGS.has(lt) && STRINGS.has(rt)) return lt === "name" || rt === "name" ? [left, right] : both(TEXT);
    if (!NUMBERS.has(lt) || !NUMBERS.has(rt)) return [left, right];
    // the integer types have operators for every pairing of themselves
    if (INTEGERS.has(lt) && INTEGERS.has(rt)) return [left, right];
    // so do the two float types: only an integer or numeric operand is brought up to float8
    if (FLOATS.has(lt) || FLOATS.has(rt)) {
      return [
        FLOATS.has(lt) ? left : this.coerce(left, "float8"),
        FLOATS.has(rt) ? right : this.coerce(right, "float8"),
      ];
    }
    return both("numeric");
  }

  private boolean(op: "AND" | "OR", left: Expr, right: Expr): Node {
    const first = this.analyze(left);
    // the grammar flattens `a AND b AND c` into one node; a parenthesized right operand stays nested
    const args = first.k === "bool" && first.op === op ? [...first.args] : [first];
    args.push(this.analyze(right));
    return { k: "bool", op, args };
  }

  private typeName(target: TypeName): ColumnType | null {
    try {
      return resolveTypeName(this.scope.ctx.state, target).column;
    } catch {
      return null;
    }
  }

  private functionName(parts: readonly string[]): string {
    const name = parts[parts.length - 1]!;
    const state = this.scope.ctx.state;
    const schema = parts.length >= 2 ? parts[parts.length - 2]! : state.findFunctions([...parts])[0]?.schema;
    if (schema === undefined || schema === "pg_catalog" || state.effectiveSearchPath().includes(schema)) {
      return quoteIdentifier(name);
    }
    return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  }

  /** Arguments of a function call: untyped literals become text, varchar and char values are cast to it. */
  private argument(node: Node, literal: TypeId = TEXT): Node {
    if (isUntyped(node)) return this.settle(node, literal);
    const type = typeOf(node);
    return type === "varchar" || type === "bpchar" ? this.coerce(node, TEXT) : node;
  }

  private form(parts: Array<string | Node>, source: Expr): Node {
    return { k: "form", parts, type: this.probe(source) };
  }

  /** Bring the branches of CASE / COALESCE to one type, as select_common_type does. */
  private unify(nodes: Node[]): Node[] {
    const known = nodes.map(typeOf).filter((type): type is TypeId => type !== null);
    let target: TypeId = known[0] ?? TEXT;
    for (const type of known) {
      if (type === target) continue;
      if (STRINGS.has(type) && STRINGS.has(target)) target = TEXT;
      else if (NUMBERS.has(type) && NUMBERS.has(target)) {
        const order = ["int2", "int4", "int8", "numeric", "float4", "float8"];
        if (order.indexOf(type) > order.indexOf(target)) target = type;
      }
    }
    return nodes.map((node) => this.coerce(node, target));
  }

  analyze(e: Expr): Node {
    switch (e.type) {
      case "colref": {
        const name = e.parts[e.parts.length - 1]!;
        const column = this.scope.table?.columns.find((c) => c.name === name);
        const relation = e.parts.length >= 2 ? e.parts[e.parts.length - 2] : undefined;
        const qualifier = relation === "old" || relation === "new" || this.scope.qualify ? relation : undefined;
        return { k: "var", name, type: column?.type.id ?? null, ...(qualifier ? { qualifier } : {}) };
      }
      case "string_lit":
        return { k: "const", type: null, mod: null, text: e.value };
      case "null_lit":
        return { k: "const", type: null, mod: null, text: null };
      case "bool_lit":
        return { k: "const", type: BOOL, mod: null, text: e.value ? "true" : "false" };
      case "number_lit":
        // the parser folds a leading sign into the literal
        return e.raw.startsWith("-") ? this.number(e.raw.slice(1), true) : this.number(e.raw, false);
      case "unop": {
        if (e.op === "not") return { k: "bool", op: "NOT", args: [this.analyze(e.operand)] };
        // the grammar folds a sign into the numeric literal it precedes
        if (e.op === "-" && e.operand.type === "number_lit") return this.number(e.operand.raw, true);
        if (e.op === "+" && e.operand.type === "number_lit") return this.number(e.operand.raw, false);
        return { k: "op", op: e.op, args: [this.analyze(e.operand)], type: this.probe(e) };
      }
      case "binop": {
        if (e.op === "and") return this.boolean("AND", e.left, e.right);
        if (e.op === "or") return this.boolean("OR", e.left, e.right);
        return this.operator(e.op, this.analyze(e.left), this.analyze(e.right), e);
      }
      case "cast": {
        const target = this.typeName(e.target);
        if (!target) return { k: "raw", text: deparseExpr(e), type: null };
        const arg = this.analyze(e.expr);
        // a literal cast is a constant of the target type, not a cast node
        if (isUntyped(arg)) return this.settle(arg, target.id, target.mod);
        // casting a value to the type it already has is not kept
        if (typeOf(arg) === target.id && target.mod === null) return arg;
        return { k: "cast", arg, type: target.id, mod: target.mod, implicit: false };
      }
      case "collate":
        return { k: "collate", arg: this.analyze(e.expr), collation: e.collation[e.collation.length - 1]! };
      case "is_null":
        return { k: "nulltest", arg: this.analyze(e.expr), not: e.not };
      case "bool_test": {
        const test = `IS ${e.not ? "NOT " : ""}${e.test.toUpperCase()}`;
        return { k: "booltest", arg: this.analyze(e.expr), test };
      }
      case "is_distinct": {
        const op = this.operator("=", this.analyze(e.left), this.analyze(e.right), e);
        const [left, right] = (op as Extract<Node, { k: "op" }>).args as [Node, Node];
        const distinct: Node = { k: "distinct", left, right };
        return e.not ? { k: "bool", op: "NOT", args: [distinct] } : distinct;
      }
      case "between": {
        if (e.symmetric) break;
        const low = this.operator(e.not ? "<" : ">=", this.analyze(e.left), this.analyze(e.low), e);
        const high = this.operator(e.not ? ">" : "<=", this.analyze(e.left), this.analyze(e.high), e);
        return { k: "bool", op: e.not ? "OR" : "AND", args: [low, high] };
      }
      case "like": {
        if (e.kind === "similar") break;
        const base = e.kind === "ilike" ? "~~*" : "~~";
        let pattern = this.settle(this.analyze(e.pattern), TEXT);
        if (e.escape) {
          const escape = this.settle(this.analyze(e.escape), TEXT);
          pattern = { k: "func", name: "like_escape", args: [pattern, escape], type: TEXT };
        }
        return this.operator(e.not ? `!${base}` : base, this.analyze(e.left), pattern, e);
      }
      case "in_expr": {
        if (!e.list) break;
        const left = this.analyze(e.left);
        const items = e.list.map((item) => this.analyze(item));
        const op = e.not ? "<>" : "=";
        if (items.length === 1) return this.operator(op, left, items[0]!, e);
        // a list with a non-constant item is expanded into OR'd comparisons instead
        if (!items.every((item) => item.k === "const")) {
          const args = items.map((item) => this.operator(op, left, item, e));
          return { k: "bool", op: e.not ? "AND" : "OR", args };
        }
        const subject = typeOf(left);
        // varchar: the list keeps its type and the array as a whole is cast to text[]
        if (subject === "varchar") {
          const array: Node = {
            k: "array",
            items: items.map((item) => this.coerce(item, "varchar")),
            type: "varchar[]",
          };
          return {
            k: "saop",
            op,
            any: !e.not,
            left: this.coerce(left, TEXT),
            right: { k: "cast", arg: array, type: "text[]", mod: null, implicit: true },
          };
        }
        // the list takes the widest type among the subject and its items; the subject is only
        // cast when no operator pairs its own type with that one
        const typed = this.unify([{ k: "var", name: "", type: subject ?? TEXT }, ...items]);
        const element = typeOf(typed[1]!) ?? TEXT;
        const array: Node = { k: "array", items: typed.slice(1), type: `${element}[]` };
        const [subjectNode] = this.reconcile(left, { k: "var", name: "", type: element });
        return { k: "saop", op, any: !e.not, left: subjectNode, right: array };
      }
      case "array_ctor": {
        const items = this.unify(e.items.map((item) => this.analyze(item)));
        const element = items.length > 0 ? typeOf(items[0]!) : null;
        return { k: "array", items, type: element ? `${element}[]` : null };
      }
      case "case": {
        const arg = e.operand ? this.analyze(e.operand) : null;
        const results = this.unify([
          ...e.whens.map((arm) => this.analyze(arm.then)),
          e.elseExpr ? this.analyze(e.elseExpr) : ({ k: "const", type: null, mod: null, text: null } as Node),
        ]);
        const whens = e.whens.map((arm, position) => {
          const test = this.analyze(arm.when);
          // CASE x WHEN v: the comparison is implied, only v is printed
          const when = arg ? (this.operator("=", arg, test, arm.when) as Extract<Node, { k: "op" }>).args[1]! : test;
          return { when, result: results[position]! };
        });
        return { k: "case", arg, whens, otherwise: results[results.length - 1]!, type: typeOf(results[0]!) };
      }
      case "func": {
        if (e.star && !e.distinct && !e.over && !e.filter && !e.orderBy && !e.withinGroupOrderBy) {
          return { k: "form", parts: [`${e.name.map(quoteIdentifier).join(".")}(*)`], type: "int8" };
        }
        if (e.star || e.distinct || e.over || e.filter || e.orderBy || e.withinGroupOrderBy) break;
        const name = e.name[e.name.length - 1]!;
        // SQL value functions (CURRENT_USER, SESSION_USER, ...) print back as their keyword
        if (e.name.length === 2 && e.name[0] === "pg_catalog" && e.args.length === 0 && SQL_VALUE_KEYWORDS.has(name)) {
          return { k: "form", parts: [name.toUpperCase()], type: "name" };
        }
        // `x IS JSON ...` reaches here as an internal call; JSON_VALUE / JSON_QUERY / JSON_EXISTS are not deparsed
        if (e.name.length === 1 && name === "__is_json" && e.args[1]?.type === "string_lit") {
          const [kind, unique] = e.args[1].value.split(":");
          const test = `IS JSON${kind === "value" ? "" : ` ${kind!.toUpperCase()}`}${unique === "unique" ? " WITH UNIQUE KEYS" : ""}`;
          return { k: "booltest", arg: this.coerce(this.analyze(e.args[0]!), TEXT), test };
        }
        if (e.name.length === 1 && name in SQLJSON_INTERNAL) {
          throw unsupported(`the definition of an expression using ${SQLJSON_INTERNAL[name]!.toUpperCase()}`);
        }
        const args = e.args.map((arg) => this.analyze(arg));
        // `x op ANY (array)` / `x op ALL (array)` reach here as an internal call
        if ((name === "__any_array" || name === "__all_array") && args.length === 3 && isUntyped(args[2]!)) {
          const array = args[1]!;
          const elementType = typeOf(array);
          const element = elementType && isArrayType(elementType) ? arrayElemType(elementType) : null;
          const left = element ? this.coerce(args[0]!, element) : args[0]!;
          return { k: "saop", op: args[2]!.text ?? "=", any: name === "__any_array", left, right: array };
        }
        if (e.name.length === 1 && (name === "coalesce" || name === "greatest" || name === "least")) {
          const parts: Array<string | Node> = [`${name.toUpperCase()}(`];
          this.unify(args).forEach((arg, position) => {
            if (position > 0) parts.push(", ");
            parts.push(arg);
          });
          return this.form([...parts, ")"], e);
        }
        if (e.name.length === 1 && name === "nullif" && args.length === 2) {
          const [left, right] = (this.operator("=", args[0]!, args[1]!, e) as Extract<Node, { k: "op" }>).args;
          return this.form(["NULLIF(", left!, ", ", right!, ")"], e);
        }
        const literals = LITERAL_ARGUMENTS[name] ?? [];
        return {
          k: "func",
          name: this.functionName(e.name),
          args: args.map((arg, position) => this.argument(arg, literals[position])),
          type: this.probe(e),
        };
      }
      case "extract":
        return this.form(["EXTRACT(", e.field.toLowerCase(), " FROM ", this.argument(this.analyze(e.source)), ")"], e);
      case "trim": {
        const parts: Array<string | Node> = [`TRIM(${e.side.toUpperCase()} `];
        if (e.chars) parts.push(this.argument(this.analyze(e.chars)), " ");
        return this.form([...parts, "FROM ", this.argument(this.analyze(e.source)), ")"], e);
      }
      case "substring_sql": {
        if (e.similar || e.escape) break;
        if (e.call) {
          const args = [e.source, e.from, e.forLen].filter((arg): arg is Expr => arg !== null);
          return {
            k: "func",
            name: quoteIdentifier("substring"),
            args: args.map((arg) => this.argument(this.analyze(arg))),
            type: this.probe(e),
          };
        }
        const parts: Array<string | Node> = ["SUBSTRING(", this.argument(this.analyze(e.source))];
        // SUBSTRING(x FOR n) is stored as SUBSTRING(x FROM 1 FOR n)
        if (e.from || e.forLen) parts.push(" FROM ", e.from ? this.analyze(e.from) : this.number("1", false));
        if (e.forLen) parts.push(" FOR ", this.analyze(e.forLen));
        return this.form([...parts, ")"], e);
      }
      case "position":
        return this.form(
          [
            "POSITION((",
            this.argument(this.analyze(e.needle)),
            ") IN (",
            this.argument(this.analyze(e.haystack)),
            "))",
          ],
          e,
        );
      case "at_time_zone":
        return this.form(
          ["(", this.analyze(e.expr), " AT TIME ZONE ", this.settle(this.analyze(e.zone), TEXT), ")"],
          e,
        );
      case "subscript": {
        if (e.indexes.some((index) => index.slice)) break;
        const base = this.analyze(e.base);
        const indexes = e.indexes.map((index) => {
          const position = index.lower ?? index.upper;
          return position ? this.analyze(position) : "";
        });
        return { k: "subscript", base, indexes, type: this.probe(e) };
      }
      default:
        break;
    }
    return { k: "raw", text: deparseExpr(e), type: this.probe(e) };
  }
}

/** Functions whose untyped literal arguments resolve to something other than text, by position. */
const LITERAL_ARGUMENTS: Record<string, TypeId[]> = {
  to_tsvector: ["regconfig"],
  to_tsquery: ["regconfig"],
  plainto_tsquery: ["regconfig"],
  phraseto_tsquery: ["regconfig"],
  websearch_to_tsquery: ["regconfig"],
};

// --- printing ---------------------------------------------------------------

interface Printer {
  scope: RuleScope;
  /** PRETTYFLAG_PAREN: only the parentheses precedence needs */
  pretty: boolean;
  indent: number;
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function printConst(p: Printer, node: Extract<Node, { k: "const" }>, label: boolean): string {
  const type = node.type;
  if (node.text === null) return type && label ? `NULL::${formatType(p.scope, type, node.mod)}` : "NULL";
  if (type === null) return literal(node.text);
  if (type === "bool") return node.text === "t" || node.text === "true" ? "true" : "false";
  let needsLabel = true;
  let out = literal(node.text);
  if (type === "int4" && !node.text.startsWith("-")) {
    out = node.text;
    needsLabel = false;
  } else if (type === "numeric" && /^\d/.test(node.text) && /[eE.]/.test(node.text)) {
    out = node.text;
    needsLabel = node.mod !== null;
  }
  return needsLabel && label ? `${out}::${formatType(p.scope, type, node.mod)}` : out;
}

const ARITHMETIC = "+-*/%";

/** isSimpleNode(): may `node` be printed inside `parent` without parentheses (pretty mode only). */
function isSimple(node: Node, parent: Node | null): boolean {
  switch (node.k) {
    case "var":
    case "const":
    case "func":
    case "form":
    case "array":
    case "case":
    case "subscript":
      return true;
    case "cast":
    case "collate":
      return isSimple(node.arg, node);
    case "op": {
      if (parent?.k === "op") {
        if (node.args.length !== 2 || parent.args.length !== 2) return false;
        if (!ARITHMETIC.includes(node.op) || !ARITHMETIC.includes(parent.op)) return false;
        const tight = "*/%".includes(node.op);
        const parentTight = "*/%".includes(parent.op);
        if (tight !== parentTight) return tight;
        // same priority: only (a - b) - c may drop its parentheses, not a - (b - c)
        return parent.args[0] === node;
      }
      return isSeparated(parent);
    }
    case "nulltest":
    case "booltest":
    case "distinct":
    case "saop":
      return isSeparated(parent);
    case "bool":
      if (parent?.k === "bool") {
        if (node.op === "OR") return parent.op === "OR";
        return parent.op === "AND" || parent.op === "OR";
      }
      return parent?.k === "func" || parent?.k === "subscript";
    default:
      return false;
  }
}

/** Parents that already delimit their children: lower-precedence AND/OR/NOT, or their own brackets. */
function isSeparated(parent: Node | null): boolean {
  return (
    parent?.k === "bool" ||
    parent?.k === "func" ||
    parent?.k === "form" ||
    parent?.k === "array" ||
    parent?.k === "case" ||
    parent?.k === "subscript"
  );
}

function printIn(p: Printer, node: Node, parent: Node, showImplicit: boolean): string {
  const text = print(p, node, showImplicit, parent);
  return p.pretty && !isSimple(node, parent) ? `(${text})` : text;
}

/** Wrap in the parentheses every operator-like node carries when not pretty-printing. */
function own(p: Printer, text: string): string {
  return p.pretty ? text : `(${text})`;
}

function keyword(p: Printer, word: string, before: number, after: number): string {
  p.indent = Math.max(p.indent + before, 0);
  const out = `\n${" ".repeat(p.indent)}${word}`;
  p.indent = Math.max(p.indent + after, 0);
  return out;
}

function print(p: Printer, node: Node, showImplicit: boolean, parent: Node | null = null): string {
  switch (node.k) {
    case "var":
      if (!node.qualifier) return quoteIdentifier(node.name);
      // a trigger condition's OLD / NEW print as written
      return `${node.qualifier === "old" || node.qualifier === "new" ? node.qualifier : quoteIdentifier(node.qualifier)}.${quoteIdentifier(node.name)}`;
    case "const":
      return printConst(p, node, true);
    case "raw":
      return node.text;
    case "op": {
      if (node.args.length === 1) return own(p, `${node.op} ${printIn(p, node.args[0]!, node, true)}`);
      const [left, right] = node.args as [Node, Node];
      return own(p, `${printIn(p, left, node, true)} ${node.op} ${printIn(p, right, node, true)}`);
    }
    case "bool": {
      if (node.op === "NOT") return own(p, `NOT ${printIn(p, node.args[0]!, node, false)}`);
      return own(p, node.args.map((arg) => printIn(p, arg, node, false)).join(` ${node.op} `));
    }
    case "cast": {
      if (node.implicit && !showImplicit) return printIn(p, node.arg, parent ?? node, false);
      const type = formatType(p.scope, node.type, node.mod);
      // a constant already of the target type is shown once, not as a cast of itself
      if (node.arg.k === "const" && node.arg.type === node.type && node.arg.mod === null) {
        return `${printConst(p, node.arg, false)}::${type}`;
      }
      return `${own(p, printIn(p, node.arg, node, false))}::${type}`;
    }
    case "func":
      return `${node.name}(${node.args.map((arg) => print(p, arg, true, node)).join(", ")})`;
    case "form":
      return node.parts.map((part) => (typeof part === "string" ? part : print(p, part, true, node))).join("");
    case "nulltest":
      return own(p, `${printIn(p, node.arg, node, true)} IS ${node.not ? "NOT " : ""}NULL`);
    case "booltest":
      return own(p, `${printIn(p, node.arg, node, false)} ${node.test}`);
    case "distinct":
      return own(p, `${printIn(p, node.left, node, true)} IS DISTINCT FROM ${printIn(p, node.right, node, true)}`);
    case "saop": {
      const quantifier = node.any ? "ANY" : "ALL";
      const right = printIn(p, node.right, node, true);
      return own(p, `${printIn(p, node.left, node, true)} ${node.op} ${quantifier} (${right})`);
    }
    case "array":
      return `ARRAY[${node.items.map((item) => print(p, item, true, node)).join(", ")}]`;
    case "collate":
      return own(p, `${printIn(p, node.arg, node, showImplicit)} COLLATE ${quoteIdentifier(node.collation)}`);
    case "subscript": {
      const base = print(p, node.base, showImplicit, node);
      const indexes = node.indexes.map(
        (index) => `[${typeof index === "string" ? index : print(p, index, false, node)}]`,
      );
      return `${node.base.k === "var" ? base : `(${base})`}${indexes.join("")}`;
    }
    case "case": {
      // CASE always breaks onto its own lines (PRETTYFLAG_INDENT is on in both modes)
      let out = keyword(p, "CASE", 0, 4);
      if (node.arg) out += ` ${print(p, node.arg, true, node)}`;
      for (const arm of node.whens) {
        out += `${keyword(p, "WHEN ", 0, 0)}${print(p, arm.when, false, node)} THEN ${print(p, arm.result, true, node)}`;
      }
      out += `${keyword(p, "ELSE ", 0, 0)}${print(p, node.otherwise, true, node)}`;
      return out + keyword(p, "END", -4, 0);
    }
  }
}

/** Does pg_get_indexdef print this index expression bare (a function call) rather than parenthesized? */
function looksLikeFunction(node: Node): boolean {
  return node.k === "func" || node.k === "form";
}

/** A stored expression as PostgreSQL prints it: a predicate, CHECK body or default. */
const SQL_VALUE_KEYWORDS: ReadonlySet<string> = new Set(["current_user", "session_user", "current_role", "user"]);

export function deparseRuleExpr(scope: RuleScope, expr: Expr, pretty = false): string {
  const node = new Analyzer(scope).analyze(expr);
  return print({ scope, pretty, indent: 0 }, node, false);
}

/** An index key expression: parenthesized unless it is a bare function call. */
export function deparseIndexExpr(scope: RuleScope, expr: Expr, pretty = false): string {
  const node = new Analyzer(scope).analyze(expr);
  const text = print({ scope, pretty, indent: 0 }, node, false);
  return looksLikeFunction(node) ? text : `(${text})`;
}
