import type { Expr, FuncCall, SelectStmt, Statement, SubscriptExpr, TypeName } from "../ast/nodes.ts";
import { isPostgresError, pgError, unsupported } from "../errors/error.ts";
import { tokenize } from "../lexer/tokenize.ts";
import { parse } from "../parser/index.ts";
import type { FunctionData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumEquals } from "../types/compare.ts";
import { resolveTypeName } from "../types/resolve.ts";
import type { Datum, TypedValue, TypeId } from "../types/value.ts";
import {
  arrayElemType,
  arrayTypeOf,
  isArrayType,
  isPgArray,
  isPgRecord,
  makeArray,
  typeDisplayName,
  tv,
} from "../types/value.ts";
import { type AssignSubscript, assignArraySubscripts } from "../types/array-assign.ts";
import {
  atomicFunctionContext,
  bindCall,
  currentTxFrame,
  invokeProcedure,
  runRoutine,
  transactionControl,
  writableTarget,
} from "./call.ts";
import { addPortal, findPortal, removePortal, unnamedPortalName } from "./portals.ts";
import { commandResult, type ExecEnv, type ExecResult, type Relation, RowScope } from "./relation.ts";
import { evalPredicate, evalScalar, runStatement } from "./select.ts";

/**
 * The PL/pgSQL interpreter behind `LANGUAGE plpgsql` functions, trigger functions and `DO` blocks:
 * DECLARE (scalars, `record`, `%ROWTYPE`, `%TYPE`, nested blocks), assignment (also to record
 * fields such as `NEW.col`), IF / CASE, LOOP / WHILE / integer FOR / FOR over a query or EXECUTE /
 * FOREACH, EXIT / CONTINUE with labels, RETURN / RETURN NEXT / RETURN QUERY [EXECUTE], PERFORM,
 * SELECT / INSERT / UPDATE / DELETE ... INTO [STRICT], EXECUTE ... INTO ... USING, GET [STACKED]
 * DIAGNOSTICS, FOUND, RAISE, ASSERT and EXCEPTION blocks. Cursors and transaction control are not
 * modelled and fail with 0A000 when the body is compiled.
 */

/** Exception condition names a handler can list (`WHEN duplicate_object`), with their SQLSTATE. */
const CONDITION_NAMES: Record<string, string> = {
  integrity_constraint_violation: "23000",
  restrict_violation: "23001",
  not_null_violation: "23502",
  foreign_key_violation: "23503",
  unique_violation: "23505",
  check_violation: "23514",
  exclusion_violation: "23P01",
  data_exception: "22000",
  string_data_right_truncation: "22001",
  null_value_not_allowed: "22004",
  numeric_value_out_of_range: "22003",
  invalid_datetime_format: "22007",
  datetime_field_overflow: "22008",
  division_by_zero: "22012",
  invalid_parameter_value: "22023",
  invalid_text_representation: "22P02",
  invalid_binary_representation: "22P03",
  bad_copy_file_format: "22P04",
  untranslatable_character: "22P05",
  invalid_escape_sequence: "22025",
  invalid_regular_expression: "2201B",
  invalid_json_text: "22032",
  array_subscript_error: "2202E",
  feature_not_supported: "0A000",
  invalid_transaction_state: "25000",
  active_sql_transaction: "25001",
  no_active_sql_transaction: "25P01",
  in_failed_sql_transaction: "25P02",
  invalid_schema_name: "3F000",
  invalid_savepoint_specification: "3B001",
  dependent_objects_still_exist: "2BP01",
  invalid_cursor_name: "34000",
  invalid_catalog_name: "3D000",
  serialization_failure: "40001",
  deadlock_detected: "40P01",
  transaction_rollback: "40000",
  syntax_error_or_access_rule_violation: "42000",
  syntax_error: "42601",
  insufficient_privilege: "42501",
  cannot_coerce: "42846",
  grouping_error: "42803",
  windowing_error: "42P20",
  invalid_recursion: "42P19",
  invalid_foreign_key: "42830",
  invalid_name: "42602",
  name_too_long: "42622",
  reserved_name: "42939",
  datatype_mismatch: "42804",
  indeterminate_datatype: "42P18",
  collation_mismatch: "42P21",
  indeterminate_collation: "42P22",
  wrong_object_type: "42809",
  generated_always: "428C9",
  undefined_column: "42703",
  undefined_function: "42883",
  undefined_table: "42P01",
  undefined_parameter: "42P02",
  undefined_object: "42704",
  duplicate_column: "42701",
  duplicate_cursor: "42P03",
  duplicate_database: "42P04",
  duplicate_function: "42723",
  duplicate_prepared_statement: "42P05",
  duplicate_schema: "42P06",
  duplicate_table: "42P07",
  duplicate_alias: "42712",
  duplicate_object: "42710",
  ambiguous_column: "42702",
  ambiguous_function: "42725",
  ambiguous_parameter: "42P08",
  ambiguous_alias: "42P09",
  invalid_column_reference: "42P10",
  invalid_column_definition: "42611",
  invalid_cursor_definition: "42P11",
  invalid_database_definition: "42P12",
  invalid_function_definition: "42P13",
  invalid_prepared_statement_definition: "42P14",
  invalid_schema_definition: "42P15",
  invalid_table_definition: "42P16",
  invalid_object_definition: "42P17",
  with_check_option_violation: "44000",
  object_not_in_prerequisite_state: "55000",
  object_in_use: "55006",
  lock_not_available: "55P03",
  insufficient_resources: "53000",
  disk_full: "53100",
  out_of_memory: "53200",
  too_many_connections: "53300",
  program_limit_exceeded: "54000",
  statement_too_complex: "54001",
  too_many_columns: "54011",
  too_many_arguments: "54023",
  query_canceled: "57014",
  internal_error: "XX000",
  data_corrupted: "XX001",
  index_corrupted: "XX002",
  raise_exception: "P0001",
  no_data_found: "P0002",
  too_many_rows: "P0003",
  assert_failure: "P0004",
  case_not_found: "20000",
};

/** A handler condition as stored: `others`, a five-character SQLSTATE, or a class (`23000` matches `23xxx`). */
function resolveCondition(name: string): string {
  if (name === "others") return name;
  const sqlState = CONDITION_NAMES[name];
  if (sqlState === undefined) throw pgError("undefined_object", `unrecognized exception condition "${name}"`, "42704");
  return sqlState;
}

function conditionMatches(condition: string, sqlState: string): boolean {
  if (condition === "others") return true;
  if (condition === sqlState) return true;
  // a class-level condition (`integrity_constraint_violation`) matches every code in its class
  return condition.endsWith("000") && sqlState.startsWith(condition.slice(0, 2));
}

/** Statements that start a plain SQL command run through the engine's executor. */
const SQL_STATEMENT_KEYWORDS = new Set([
  "select",
  "values",
  "insert",
  "update",
  "delete",
  "with",
  "create",
  "alter",
  "drop",
  "truncate",
  "comment",
  "grant",
  "revoke",
  "refresh",
  "reindex",
  "lock",
  "set",
  "reset",
  "analyze",
  "vacuum",
  "notify",
  "listen",
  "unlisten",
  "explain",
  "discard",
  "cluster",
  "call",
  "merge",
  "import",
  "security",
]);

/** Cursor statements and transaction control, which PL/pgSQL handles itself. */
const PL_STATEMENTS = new Set(["open", "fetch", "move", "close", "commit", "rollback"]);

/** `FETCH` / `MOVE` direction keywords. */
const DIRECTIONS = new Set(["next", "prior", "first", "last", "absolute", "relative", "forward", "backward", "all"]);

const RAISE_LEVELS = new Set(["debug", "log", "info", "notice", "warning", "exception"]);

/** `x`, or `rec.field` */
type Target = string[];

interface Into {
  targets: Target[];
  strict: boolean;
}

type Handler = { conditions: string[]; body: PlStmt[] };

/** Where a FETCH / MOVE goes: `count` null means ALL (FORWARD ALL / BACKWARD ALL / ALL). */
export type FetchDirection =
  | { kind: "next" | "prior" | "first" | "last" }
  | { kind: "absolute" | "relative"; count: Expr }
  | { kind: "forward" | "backward"; count: Expr | null };

/** Arguments of `OPEN bound(args)` / `FOR r IN bound(args)`: positional, or `name := expr`. */
type CursorArgs = Array<{ name: string | null; expr: Expr }>;

export type PlStmt =
  | { kind: "assign"; target: Target; expr: Expr }
  | { kind: "return"; expr: Expr | null }
  | { kind: "return_next"; expr: Expr | null }
  | { kind: "return_query"; query: Statement | null; dynamic: Expr | null; using: Expr[] }
  | { kind: "if"; branches: Array<{ cond: Expr; body: PlStmt[] }>; elseBody: PlStmt[] }
  | {
      kind: "case";
      expr: Expr | null;
      branches: Array<{ cond: Expr; body: PlStmt[] }>;
      /** null: no ELSE, so an unmatched CASE raises case_not_found */
      elseBody: PlStmt[] | null;
    }
  | { kind: "null" }
  | {
      kind: "raise";
      level: string;
      format: string | null;
      args: Expr[];
      errcode: string | null;
      options: Array<{ name: string; expr: Expr }>;
    }
  | { kind: "reraise" }
  | { kind: "assert"; cond: Expr; message: Expr | null }
  | { kind: "execute"; expr: Expr; into: Into | null; using: Expr[] }
  | { kind: "perform"; query: Statement }
  | { kind: "sql"; stmt: Statement; into: Into | null }
  | { kind: "diagnostics"; stacked: boolean; items: Array<{ target: Target; item: string }> }
  | { kind: "block"; label: string | null; decls: PlDecl[]; body: PlStmt[]; handlers: Handler[] | null }
  | { kind: "loop"; label: string | null; body: PlStmt[] }
  | { kind: "while"; label: string | null; cond: Expr; body: PlStmt[] }
  | {
      kind: "for_int";
      label: string | null;
      variable: string;
      reverse: boolean;
      lower: Expr;
      upper: Expr;
      step: Expr | null;
      body: PlStmt[];
    }
  | {
      kind: "for_query";
      label: string | null;
      targets: Target[];
      query: Statement | null;
      dynamic: Expr | null;
      using: Expr[];
      body: PlStmt[];
    }
  | { kind: "foreach"; label: string | null; targets: Target[]; slice: number; array: Expr; body: PlStmt[] }
  | { kind: "exit"; isContinue: boolean; label: string | null; cond: Expr | null }
  | { kind: "assign_subscript"; target: Target; subscripts: SubscriptExpr["indexes"]; expr: Expr }
  | { kind: "call"; call: FuncCall }
  | { kind: "transaction"; action: "commit" | "rollback" }
  | {
      kind: "open";
      cursor: string;
      /** unbound `OPEN c [[NO] SCROLL] FOR ...`: the query, or EXECUTE's command */
      query: Statement | null;
      dynamic: Expr | null;
      using: Expr[];
      scroll: boolean | null;
      /** bound `OPEN c(args)` */
      args: CursorArgs | null;
    }
  | { kind: "fetch"; move: boolean; direction: FetchDirection; cursor: string; into: Target[] | null }
  | { kind: "close"; cursor: string }
  | { kind: "for_cursor"; label: string | null; variable: string; cursor: string; args: CursorArgs; body: PlStmt[] };

export type PlDeclType =
  | { kind: "type"; typeName: TypeName }
  | { kind: "record" }
  | { kind: "rowtype"; table: string[] }
  | { kind: "copytype"; ref: string[] }
  /** `name ALIAS FOR target` (a variable name or `$n`) */
  | { kind: "alias"; target: string }
  /** an unbound cursor variable (`refcursor`) */
  | { kind: "refcursor" }
  /** `name [NO] SCROLL CURSOR [(args)] FOR query` */
  | { kind: "cursor"; scroll: boolean | null; params: Array<{ name: string; typeName: TypeName }>; query: Statement };

export interface PlDecl {
  name: string;
  type: PlDeclType;
  init: Expr | null;
  notNull: boolean;
}

export interface PlProgram {
  body: PlStmt[];
}

interface Tok {
  type: string;
  value: string;
  pos: number;
}

const isPunct = (t: Tok, value: string): boolean => t.type === "punct" && t.value === value;
const isAssignOp = (t: Tok): boolean => t.type === "op" && (t.value === ":=" || t.value === "=");
const isName = (t: Tok): boolean => t.type === "ident" || t.type === "quoted_ident";
const syntaxError = (near: string): Error =>
  pgError(
    "syntax",
    near === "end of input" ? "syntax error at end of input" : `syntax error at or near "${near}"`,
    "42601",
  );

/** What the parser knows about a declared name: a bound cursor (with its parameter count), an unbound one, or neither. */
type DeclInfo = { cursor: "bound"; nargs: number } | { cursor: "unbound" } | { cursor: null };

class PlParser {
  private tokens: Tok[];
  private pos = 0;
  /** declarations in scope, innermost block last */
  private scopes: Array<Map<string, DeclInfo>> = [];
  constructor(private readonly src: string) {
    this.tokens = tokenize(src);
  }

  private peek(offset = 0): Tok {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }
  private next(): Tok {
    const t = this.peek();
    if (t.type !== "eof") this.pos++;
    return t;
  }
  private atKw(kw: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === "ident" && t.value === kw;
  }
  private atSemi(): boolean {
    return isPunct(this.peek(), ";");
  }
  private expectKw(kw: string): void {
    if (!this.atKw(kw)) throw syntaxError(this.peek().type === "eof" ? "end of input" : this.peek().value);
    this.pos++;
  }
  private expectSemi(): void {
    const t = this.next();
    if (!isPunct(t, ";")) throw syntaxError(t.type === "eof" ? "end of input" : t.value);
  }

  parseProgram(): PlProgram {
    const block = this.parseLabeledBlock();
    if (this.peek().type !== "eof") throw syntaxError(this.peek().value);
    return { body: [block] };
  }

  private parseLabel(): string | null {
    if (!(this.peek().type === "op" && this.peek().value === "<<")) return null;
    this.pos++;
    const name = this.next();
    if (!isName(name)) throw syntaxError(name.value);
    const close = this.next();
    if (!(close.type === "op" && close.value === ">>")) throw syntaxError(close.value);
    return name.value;
  }

  private parseLabeledBlock(): Extract<PlStmt, { kind: "block" }> {
    const label = this.parseLabel();
    return this.parseBlock(label);
  }

  private declInfo(name: string): DeclInfo | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const info = this.scopes[i]!.get(name);
      if (info !== undefined) return info;
    }
    return undefined;
  }

  /** `[DECLARE decls] BEGIN stmts [EXCEPTION handlers] END [label]` */
  private parseBlock(label: string | null): Extract<PlStmt, { kind: "block" }> {
    const scope = new Map<string, DeclInfo>();
    this.scopes.push(scope);
    try {
      return this.parseBlockIn(label, scope);
    } finally {
      this.scopes.pop();
    }
  }

  private parseBlockIn(label: string | null, scope: Map<string, DeclInfo>): Extract<PlStmt, { kind: "block" }> {
    const decls: PlDecl[] = [];
    if (this.atKw("declare")) {
      this.pos++;
      while (!this.atKw("begin") && this.peek().type !== "eof") {
        if (this.atKw("declare")) {
          this.pos++;
          continue;
        }
        const decl = this.parseDecl();
        decls.push(decl);
        const type = decl.type;
        scope.set(
          decl.name,
          type.kind === "cursor"
            ? { cursor: "bound", nargs: type.params.length }
            : type.kind === "refcursor"
              ? { cursor: "unbound" }
              : type.kind === "alias"
                ? (this.declInfo(type.target) ?? { cursor: null })
                : { cursor: null },
        );
      }
    }
    this.expectKw("begin");
    const body = this.parseStmts(new Set(["end", "exception"]));
    let handlers: Handler[] | null = null;
    if (this.atKw("exception")) {
      this.pos++;
      handlers = [];
      this.expectKw("when");
      for (;;) {
        const conditions: string[] = [];
        for (;;) {
          if (this.atKw("sqlstate")) {
            this.pos++;
            const code = this.next();
            if (code.type !== "string" || !/^[0-9A-Z]{5}$/.test(code.value)) {
              throw pgError("syntax", `invalid SQLSTATE code "${code.value}"`, "42601");
            }
            conditions.push(code.value);
          } else {
            const name = this.next();
            if (name.type !== "ident") throw syntaxError(name.value);
            conditions.push(resolveCondition(name.value));
          }
          if (!this.atKw("or")) break;
          this.pos++;
        }
        this.expectKw("then");
        handlers.push({ conditions, body: this.parseStmts(new Set(["end", "when"])) });
        if (!this.atKw("when")) break;
        this.pos++;
      }
    }
    this.expectKw("end");
    this.parseEndLabel(label);
    if (this.atSemi()) this.pos++;
    return { kind: "block", label, decls, body, handlers };
  }

  /** The optional label after `END` / `END LOOP`; it must name the statement's own label. */
  private parseEndLabel(label: string | null): void {
    if (!isName(this.peek())) return;
    const name = this.next().value;
    if (name !== label) throw syntaxError(name);
  }

  private parseDecl(): PlDecl {
    const nameTok = this.next();
    if (!isName(nameTok)) throw syntaxError(nameTok.value);
    const name = nameTok.value;
    if (this.atKw("alias")) {
      this.pos++;
      this.expectKw("for");
      const target = this.next();
      if (target.type !== "param" && !isName(target)) throw syntaxError(target.value);
      this.expectSemi();
      return {
        name,
        type: { kind: "alias", target: target.type === "param" ? `$${target.value}` : target.value },
        init: null,
        notNull: false,
      };
    }
    if (this.atKw("constant")) this.pos++;
    if (this.atKw("cursor") || (this.atKw("no") && this.atKw("scroll", 1)) || this.atKw("scroll")) {
      return { name, type: this.parseCursorDecl(), init: null, notNull: false };
    }
    const typeStart = this.pos;
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw syntaxError("end of input");
      if (isPunct(t, "(") || isPunct(t, "[")) depth++;
      if (isPunct(t, ")") || isPunct(t, "]")) depth--;
      if (
        depth === 0 &&
        (isPunct(t, ";") ||
          isAssignOp(t) ||
          (t.type === "ident" && (t.value === "default" || t.value === "collate")) ||
          (t.type === "ident" && t.value === "not" && this.atKw("null", 1)))
      ) {
        break;
      }
      this.pos++;
    }
    const typeToks = this.tokens.slice(typeStart, this.pos);
    if (typeToks.length === 0) throw syntaxError(this.peek().value);
    if (this.atKw("collate")) {
      this.pos++;
      this.next();
    }
    let notNull = false;
    if (this.atKw("not")) {
      this.pos += 2;
      notNull = true;
    }
    let init: Expr | null = null;
    if (isAssignOp(this.peek()) || this.atKw("default")) {
      this.pos++;
      init = this.parseExprUntilSemi();
    } else {
      this.expectSemi();
    }
    return { name, type: this.declType(typeToks), init, notNull };
  }

  /** `[NO] SCROLL CURSOR [(name type, ...)] {FOR | IS} query;` */
  private parseCursorDecl(): PlDeclType {
    let scroll: boolean | null = null;
    if (this.atKw("no")) {
      this.pos += 2;
      scroll = false;
    } else if (this.atKw("scroll")) {
      this.pos++;
      scroll = true;
    }
    this.expectKw("cursor");
    const params: Array<{ name: string; typeName: TypeName }> = [];
    if (isPunct(this.peek(), "(")) {
      this.pos++;
      for (;;) {
        const pname = this.next();
        if (!isName(pname)) throw syntaxError(pname.value);
        const start = this.peek();
        let depth = 0;
        while (this.peek().type !== "eof") {
          const t = this.peek();
          if (isPunct(t, "(")) depth++;
          if (isPunct(t, ")")) {
            if (depth === 0) break;
            depth--;
          }
          if (depth === 0 && isPunct(t, ",")) break;
          this.pos++;
        }
        const end = this.peek();
        if (end === start) throw syntaxError(end.value);
        params.push({ name: pname.value, typeName: parseTypeNameText(this.src.slice(start.pos, end.pos)) });
        if (isPunct(this.next(), ")")) break;
      }
    }
    if (!(this.atKw("for") || this.atKw("is"))) throw syntaxError(this.peek().value);
    this.pos++;
    return { kind: "cursor", scroll, params, query: parseOne(this.sqlTextUntilSemi()) };
  }

  private declType(toks: Tok[]): PlDeclType {
    const last = toks[toks.length - 1]!;
    const pct = toks[toks.length - 2];
    if (pct?.type === "op" && pct.value === "%" && (last.value === "rowtype" || last.value === "type")) {
      const ref = dottedName(toks.slice(0, -2));
      return last.value === "rowtype" ? { kind: "rowtype", table: ref } : { kind: "copytype", ref };
    }
    if (toks.length === 1 && toks[0]!.type === "ident" && toks[0]!.value === "record") return { kind: "record" };
    if (toks.length === 1 && toks[0]!.type === "ident" && toks[0]!.value === "refcursor") return { kind: "refcursor" };
    const text = this.src.slice(toks[0]!.pos, last.pos + last.value.length + (last.type === "quoted_ident" ? 2 : 0));
    return { kind: "type", typeName: parseTypeNameText(text) };
  }

  private parseStmts(stop: Set<string>): PlStmt[] {
    const out: PlStmt[] = [];
    while (this.peek().type !== "eof") {
      if (this.peek().type === "ident" && stop.has(this.peek().value)) break;
      out.push(this.parseStmt());
    }
    return out;
  }

  private parseStmt(): PlStmt {
    const label = this.parseLabel();
    if (this.atKw("begin") || this.atKw("declare")) return this.parseBlock(label);
    if (this.atKw("loop")) {
      this.pos++;
      return { kind: "loop", label, body: this.parseLoopBody(label) };
    }
    if (this.atKw("while")) {
      this.pos++;
      const cond = this.parseExprUntilKw("loop");
      return { kind: "while", label, cond, body: this.parseLoopBody(label) };
    }
    if (this.atKw("for")) {
      this.pos++;
      return this.parseFor(label);
    }
    if (this.atKw("foreach")) {
      this.pos++;
      const targets = this.parseTargets();
      let slice = 0;
      if (this.atKw("slice")) {
        this.pos++;
        const n = this.next();
        if (n.type !== "number" || !/^\d+$/.test(n.value)) throw syntaxError(n.value);
        slice = Number(n.value);
      }
      this.expectKw("in");
      this.expectKw("array");
      const array = this.parseExprUntilKw("loop");
      return { kind: "foreach", label, targets, slice, array, body: this.parseLoopBody(label) };
    }
    if (label !== null) throw syntaxError(this.peek().value);
    if (this.atKw("exit") || this.atKw("continue")) {
      const isContinue = this.next().value === "continue";
      let target: string | null = null;
      if (isName(this.peek()) && !this.atKw("when")) target = this.next().value;
      let cond: Expr | null = null;
      if (this.atKw("when")) {
        this.pos++;
        cond = this.parseExprUntilSemi();
      } else {
        this.expectSemi();
      }
      return { kind: "exit", isContinue, label: target, cond };
    }
    if (this.atKw("return")) return this.parseReturn();
    if (this.atKw("if")) {
      this.pos++;
      const branches: Array<{ cond: Expr; body: PlStmt[] }> = [];
      let elseBody: PlStmt[] = [];
      const stops = new Set(["end", "elsif", "elseif", "else"]);
      const cond = this.parseExprUntilKw("then");
      branches.push({ cond, body: this.parseStmts(stops) });
      while (this.atKw("elsif") || this.atKw("elseif")) {
        this.pos++;
        const c = this.parseExprUntilKw("then");
        branches.push({ cond: c, body: this.parseStmts(stops) });
      }
      if (this.atKw("else")) {
        this.pos++;
        elseBody = this.parseStmts(new Set(["end"]));
      }
      this.expectKw("end");
      this.expectKw("if");
      this.expectSemi();
      return { kind: "if", branches, elseBody };
    }
    if (this.atKw("case")) {
      this.pos++;
      let expr: Expr | null = null;
      const branches: Array<{ cond: Expr; body: PlStmt[] }> = [];
      let elseBody: PlStmt[] | null = null;
      if (!this.atKw("when")) expr = this.parseExprUntilKw("when");
      else this.pos++;
      for (;;) {
        const cond = this.parseExprUntilKw("then");
        branches.push({ cond, body: this.parseStmts(new Set(["when", "else", "end"])) });
        if (!this.atKw("when")) break;
        this.pos++;
      }
      if (this.atKw("else")) {
        this.pos++;
        elseBody = this.parseStmts(new Set(["end"]));
      }
      this.expectKw("end");
      this.expectKw("case");
      this.expectSemi();
      return { kind: "case", expr, branches, elseBody };
    }
    if (this.atKw("null") && isPunct(this.peek(1), ";")) {
      this.pos += 2;
      return { kind: "null" };
    }
    if (this.atKw("raise")) return this.parseRaise();
    if (this.atKw("assert")) {
      this.pos++;
      const cond = this.parseExprUntilAny((t) => isPunct(t, ";") || isPunct(t, ","));
      let message: Expr | null = null;
      if (isPunct(this.peek(), ",")) {
        this.pos++;
        message = this.parseExprUntilAny((t) => isPunct(t, ";"));
      }
      this.expectSemi();
      return { kind: "assert", cond, message };
    }
    if (this.atKw("execute") && !isAssignOp(this.peek(1))) {
      this.pos++;
      const { expr, into, using } = this.parseDynamic(new Set(["into", "using"]), (t) => isPunct(t, ";"));
      this.expectSemi();
      return { kind: "execute", expr, into, using };
    }
    if (this.atKw("perform")) {
      this.pos++;
      const text = this.sqlTextUntilSemi();
      return { kind: "perform", query: parseOne(`SELECT ${text}`) };
    }
    if (this.atKw("get") && !isAssignOp(this.peek(1))) return this.parseDiagnostics();
    const head = this.peek();
    const assigns = isAssignOp(this.peek(1)) || isPunct(this.peek(1), ".") || isPunct(this.peek(1), "[");
    if (head.type === "ident" && !assigns && PL_STATEMENTS.has(head.value)) return this.parsePlStatement();
    if (head.type === "ident" && SQL_STATEMENT_KEYWORDS.has(head.value) && !isAssignOp(this.peek(1))) {
      return this.parseSql();
    }
    const targetStart = this.peek().pos;
    const target = this.parseTarget();
    if (isPunct(this.peek(), "[")) return this.parseSubscriptAssign(target, targetStart);
    const opTok = this.next();
    if (!isAssignOp(opTok)) throw syntaxError(opTok.type === "eof" ? "end of input" : opTok.value);
    return { kind: "assign", target, expr: this.parseExprUntilSemi() };
  }

  /** `a[i] := v`, `a[i][j] := v`, `a[lo:hi] := arr`, `rec.f[i] := v` */
  private parseSubscriptAssign(target: Target, start: number): PlStmt {
    let depth = 0;
    let at = this.pos;
    for (; ; at++) {
      const t = this.tokens[at]!;
      if (t.type === "eof") throw syntaxError("end of input");
      if (isPunct(t, "(") || isPunct(t, "[")) depth++;
      if (isPunct(t, ")") || isPunct(t, "]")) depth--;
      if (depth === 0 && isAssignOp(t)) break;
      if (depth === 0 && isPunct(t, ";")) throw syntaxError(";");
    }
    const lhs = parseSqlExpr(this.src.slice(start, this.tokens[at]!.pos));
    const subscripts: SubscriptExpr["indexes"][number][] = [];
    let node: Expr = lhs;
    while (node.type === "subscript") {
      subscripts.unshift(...node.indexes);
      node = node.base;
    }
    if (subscripts.length === 0) throw syntaxError("[");
    this.pos = at + 1;
    return { kind: "assign_subscript", target, subscripts, expr: this.parseExprUntilSemi() };
  }

  /** OPEN / FETCH / MOVE / CLOSE and COMMIT / ROLLBACK. */
  private parsePlStatement(): PlStmt {
    const keyword = this.next().value;
    if (keyword === "commit" || keyword === "rollback") {
      if (this.atKw("and")) {
        this.pos++;
        if (this.atKw("no")) this.pos++;
        this.expectKw("chain");
      }
      this.expectSemi();
      return { kind: "transaction", action: keyword };
    }
    if (keyword === "close") {
      const cursor = this.cursorName();
      this.expectSemi();
      return { kind: "close", cursor };
    }
    if (keyword === "open") return this.parseOpen();
    const move = keyword === "move";
    const direction = this.parseDirection(move);
    if (this.atKw("from") || this.atKw("in")) this.pos++;
    const cursor = this.cursorName();
    let into: Target[] | null = null;
    if (!move) {
      this.expectKw("into");
      into = this.parseTargets();
    }
    this.expectSemi();
    return { kind: "fetch", move, direction, cursor, into };
  }

  private cursorName(): string {
    const t = this.next();
    if (!isName(t)) throw syntaxError(t.type === "eof" ? "end of input" : t.value);
    return t.value;
  }

  /** The direction of FETCH / MOVE (NEXT when none is given). */
  private parseDirection(move: boolean): FetchDirection {
    const t = this.peek();
    const next = this.peek(1);
    if (
      !(t.type === "ident" && DIRECTIONS.has(t.value)) ||
      isPunct(next, ";") ||
      (next.type === "ident" && next.value === "into")
    ) {
      return { kind: "next" };
    }
    this.pos++;
    const countUntilFrom = () =>
      this.parseExprUntilAny((x) => x.type === "ident" && (x.value === "from" || x.value === "in"));
    let direction: FetchDirection;
    switch (t.value) {
      case "next":
      case "prior":
      case "first":
      case "last":
        direction = { kind: t.value };
        break;
      case "absolute":
      case "relative":
        direction = { kind: t.value, count: countUntilFrom() };
        break;
      case "all":
        direction = { kind: "forward", count: null };
        break;
      default: {
        const kind = t.value as "forward" | "backward";
        if (this.atKw("all")) {
          this.pos++;
          direction = { kind, count: null };
        } else if (this.atKw("from") || this.atKw("in") || isName(this.peek())) {
          direction = { kind, count: { type: "number_lit", raw: "1" } };
        } else {
          direction = { kind, count: countUntilFrom() };
        }
      }
    }
    if (!move && (direction.kind === "forward" || direction.kind === "backward")) {
      const count = direction.count;
      if (count === null || (count.type === "number_lit" && Number(count.raw) !== 1)) {
        throw pgError("unsupported", "FETCH statement cannot return multiple rows", "0A000");
      }
    }
    return direction;
  }

  /** `OPEN c [[NO] SCROLL] FOR query | FOR EXECUTE cmd [USING ...]` or `OPEN bound [(args)]` */
  private parseOpen(): PlStmt {
    const cursor = this.cursorName();
    const info = this.declInfo(cursor);
    if (this.atKw("no") || this.atKw("scroll") || this.atKw("for")) {
      if (info?.cursor === "bound") throw syntaxError(this.peek().value.toUpperCase());
      let scroll: boolean | null = null;
      if (this.atKw("no")) {
        this.pos++;
        this.expectKw("scroll");
        scroll = false;
      } else if (this.atKw("scroll")) {
        this.pos++;
        scroll = true;
      }
      this.expectKw("for");
      if (this.atKw("execute")) {
        this.pos++;
        const { expr, into, using } = this.parseDynamic(new Set(["using"]), (t) => isPunct(t, ";"));
        if (into) throw syntaxError("into");
        this.expectSemi();
        return { kind: "open", cursor, query: null, dynamic: expr, using, scroll, args: null };
      }
      return {
        kind: "open",
        cursor,
        query: parseOne(this.sqlTextUntilSemi()),
        dynamic: null,
        using: [],
        scroll,
        args: null,
      };
    }
    if (info?.cursor === "unbound") throw syntaxError(this.peek().type === "eof" ? "end of input" : this.peek().value);
    const args = isPunct(this.peek(), "(") ? this.parseCursorArgs() : null;
    this.checkCursorArgs(cursor, info, args);
    this.expectSemi();
    return { kind: "open", cursor, query: null, dynamic: null, using: [], scroll: null, args };
  }

  /** `(expr, ...)` or `(name := expr, ...)` after a bound cursor. */
  private parseCursorArgs(): CursorArgs {
    this.pos++;
    const args: CursorArgs = [];
    for (;;) {
      let name: string | null = null;
      if (
        isName(this.peek()) &&
        this.peek(1).type === "op" &&
        (this.peek(1).value === ":=" || this.peek(1).value === "=>")
      ) {
        name = this.next().value;
        this.pos++;
      }
      const start = this.peek().pos;
      let depth = 0;
      for (;;) {
        const t = this.peek();
        if (t.type === "eof") throw syntaxError("end of input");
        if (depth === 0 && (isPunct(t, ",") || isPunct(t, ")"))) break;
        if (isPunct(t, "(") || isPunct(t, "[")) depth++;
        if (isPunct(t, ")") || isPunct(t, "]")) depth--;
        this.pos++;
      }
      args.push({ name, expr: parseSqlExpr(this.src.slice(start, this.peek().pos)) });
      if (isPunct(this.next(), ")")) return args;
    }
  }

  private checkCursorArgs(cursor: string, info: DeclInfo | undefined, args: CursorArgs | null): void {
    if (info?.cursor !== "bound") return;
    if (info.nargs > 0 && args === null) throw pgError("syntax", `cursor "${cursor}" has arguments`, "42601");
    if (info.nargs === 0 && args !== null) throw pgError("syntax", `cursor "${cursor}" has no arguments`, "42601");
    if (args !== null && args.length !== info.nargs) {
      throw pgError(
        "syntax",
        `${args.length < info.nargs ? "not enough" : "too many"} arguments for cursor "${cursor}"`,
        "42601",
      );
    }
  }

  private parseReturn(): PlStmt {
    this.pos++;
    if (this.atKw("next")) {
      this.pos++;
      if (this.atSemi()) {
        this.pos++;
        return { kind: "return_next", expr: null };
      }
      return { kind: "return_next", expr: this.parseExprUntilSemi() };
    }
    if (this.atKw("query")) {
      this.pos++;
      if (this.atKw("execute")) {
        this.pos++;
        const { expr, into, using } = this.parseDynamic(new Set(["using"]), (t) => isPunct(t, ";"));
        if (into) throw syntaxError("into");
        this.expectSemi();
        return { kind: "return_query", query: null, dynamic: expr, using };
      }
      return { kind: "return_query", query: parseOne(this.sqlTextUntilSemi()), dynamic: null, using: [] };
    }
    if (this.atSemi()) {
      this.pos++;
      return { kind: "return", expr: null };
    }
    return { kind: "return", expr: this.parseExprUntilSemi() };
  }

  private parseFor(label: string | null): PlStmt {
    const targets = this.parseTargets();
    this.expectKw("in");
    if (this.atKw("execute")) {
      this.pos++;
      const { expr, into, using } = this.parseDynamic(
        new Set(["using"]),
        (t) => t.type === "ident" && t.value === "loop",
      );
      if (into) throw syntaxError("into");
      this.expectKw("loop");
      return { kind: "for_query", label, targets, query: null, dynamic: expr, using, body: this.parseLoopBody(label) };
    }
    // find the LOOP keyword and a top-level `..` before it
    const start = this.pos;
    let depth = 0;
    let range = -1;
    let by = -1;
    let end = this.pos;
    for (; ; end++) {
      const t = this.tokens[end]!;
      if (t.type === "eof") throw syntaxError("end of input");
      if (isPunct(t, "(") || isPunct(t, "[")) depth++;
      if (isPunct(t, ")") || isPunct(t, "]")) depth--;
      if (depth !== 0) continue;
      if (t.type === "ident" && t.value === "loop") break;
      if (range === -1 && (t.type === "number" || isPunct(t, "."))) {
        // `1..n` lexes as `1.` `.` `n` and `1..3` as `1.` `.3`: look at the source between tokens
        const following = this.tokens[end + 1]!;
        const at = this.src.slice(t.pos, following.pos + 1).indexOf("..");
        if (at !== -1) range = t.pos + at;
      }
      if (range !== -1 && t.type === "ident" && t.value === "by") by = end;
    }
    const loopTok = this.tokens[end]!;
    const first = this.tokens[start]!;
    const info = isName(first) ? this.declInfo(first.value) : undefined;
    if (range === -1 && info !== undefined && info.cursor !== null) {
      if (info.cursor === "unbound") {
        throw pgError("syntax", "cursor FOR loop must use a bound cursor variable", "42601");
      }
      if (targets.length !== 1 || targets[0]!.length !== 1) {
        throw pgError("syntax", "cursor FOR loop must have only one target variable", "42601");
      }
      this.pos = start + 1;
      const args = isPunct(this.peek(), "(") ? this.parseCursorArgs() : null;
      this.checkCursorArgs(first.value, info, args);
      this.expectKw("loop");
      return {
        kind: "for_cursor",
        label,
        variable: targets[0]![0]!,
        cursor: first.value,
        args: args ?? [],
        body: this.parseLoopBody(label),
      };
    }
    if (range === -1) {
      const text = this.src.slice(this.tokens[start]!.pos, loopTok.pos).trim();
      this.pos = end + 1;
      return {
        kind: "for_query",
        label,
        targets,
        query: parseOne(text),
        dynamic: null,
        using: [],
        body: this.parseLoopBody(label),
      };
    }
    if (targets.length !== 1 || targets[0]!.length !== 1) throw syntaxError(".");
    let lowStart = this.tokens[start]!.pos;
    let reverse = false;
    if (this.atKw("reverse")) {
      reverse = true;
      lowStart = this.peek(1).pos;
    }
    const upperEnd = by === -1 ? loopTok.pos : this.tokens[by]!.pos;
    const lower = parseSqlExpr(this.src.slice(lowStart, range));
    const upper = parseSqlExpr(this.src.slice(range + 2, upperEnd));
    const step = by === -1 ? null : parseSqlExpr(this.src.slice(this.tokens[by + 1]!.pos, loopTok.pos));
    this.pos = end + 1;
    return {
      kind: "for_int",
      label,
      variable: targets[0]![0]!,
      reverse,
      lower,
      upper,
      step,
      body: this.parseLoopBody(label),
    };
  }

  /** `stmts END LOOP [label];` */
  private parseLoopBody(label: string | null): PlStmt[] {
    const body = this.parseStmts(new Set(["end"]));
    this.expectKw("end");
    this.expectKw("loop");
    this.parseEndLabel(label);
    this.expectSemi();
    return body;
  }

  private parseTarget(): Target {
    const first = this.next();
    if (!isName(first)) throw syntaxError(first.type === "eof" ? "end of input" : first.value);
    const target = [first.value];
    while (isPunct(this.peek(), ".")) {
      this.pos++;
      const f = this.next();
      if (!isName(f)) throw syntaxError(f.value);
      target.push(f.value);
    }
    return target;
  }

  private parseTargets(): Target[] {
    const targets = [this.parseTarget()];
    while (isPunct(this.peek(), ",")) {
      this.pos++;
      targets.push(this.parseTarget());
    }
    return targets;
  }

  /**
   * The command expression of `EXECUTE` / `RETURN QUERY EXECUTE` / `FOR ... IN EXECUTE`, then its
   * `INTO [STRICT] targets` and `USING expr, ...` clauses in either order, up to `stop` (not consumed).
   */
  private parseDynamic(
    clauses: Set<string>,
    stop: (t: Tok) => boolean,
  ): { expr: Expr; into: Into | null; using: Expr[] } {
    const atClause = (t: Tok) => stop(t) || (t.type === "ident" && clauses.has(t.value));
    const expr = this.parseExprUntilAny(atClause);
    let into: Into | null = null;
    const using: Expr[] = [];
    while (!stop(this.peek())) {
      const kw = this.next();
      if (kw.value === "into") {
        if (into) throw syntaxError("into");
        const strict = this.atKw("strict");
        if (strict) this.pos++;
        into = { targets: this.parseTargets(), strict };
      } else if (kw.value === "using") {
        for (;;) {
          using.push(this.parseExprUntilAny((t) => atClause(t) || isPunct(t, ",")));
          if (!isPunct(this.peek(), ",")) break;
          this.pos++;
        }
      } else {
        throw syntaxError(kw.type === "eof" ? "end of input" : kw.value);
      }
    }
    return { expr, into, using };
  }

  /** `GET [CURRENT | STACKED] DIAGNOSTICS target {= | :=} item [, ...];` */
  private parseDiagnostics(): PlStmt {
    this.pos++;
    let stacked = false;
    if (this.atKw("stacked")) {
      stacked = true;
      this.pos++;
    } else if (this.atKw("current")) {
      this.pos++;
    }
    this.expectKw("diagnostics");
    const items: Array<{ target: Target; item: string }> = [];
    for (;;) {
      const target = this.parseTarget();
      if (!isAssignOp(this.next())) throw syntaxError(this.peek().value);
      const item = this.next();
      if (item.type !== "ident") throw syntaxError(item.value);
      items.push({ target, item: item.value });
      if (!isPunct(this.peek(), ",")) break;
      this.pos++;
    }
    this.expectSemi();
    return { kind: "diagnostics", stacked, items };
  }

  /** A SQL command, with its PL/pgSQL `INTO [STRICT] targets` clause taken out. */
  private parseSql(): PlStmt {
    const start = this.pos;
    let depth = 0;
    let intoAt = -1;
    let end = this.pos;
    for (; ; end++) {
      const t = this.tokens[end]!;
      if (t.type === "eof") throw syntaxError("end of input");
      if (isPunct(t, "(") || isPunct(t, "[")) depth++;
      if (isPunct(t, ")") || isPunct(t, "]")) depth--;
      if (depth === 0 && isPunct(t, ";")) break;
      if (depth === 0 && intoAt === -1 && t.type === "ident" && t.value === "into") {
        const prev = this.tokens[end - 1];
        if (!(prev?.type === "ident" && (prev.value === "insert" || prev.value === "merge"))) intoAt = end;
      }
    }
    const semi = this.tokens[end]!;
    let text: string;
    let into: Into | null = null;
    if (intoAt === -1) {
      text = this.src.slice(this.tokens[start]!.pos, semi.pos);
    } else {
      this.pos = intoAt + 1;
      const strict = this.atKw("strict");
      if (strict) this.pos++;
      into = { targets: this.parseTargets(), strict };
      text = `${this.src.slice(this.tokens[start]!.pos, this.tokens[intoAt]!.pos)} ${this.src.slice(this.peek().pos, semi.pos)}`;
    }
    this.pos = end + 1;
    const stmt = parseOne(text);
    if (stmt.type === "call") {
      if (into) throw syntaxError("into");
      return { kind: "call", call: stmt.call };
    }
    return { kind: "sql", stmt, into };
  }

  /**
   * `RAISE [level] ['format', arg, ...] [USING option = expr, ...]`, `RAISE level condition` /
   * `RAISE level SQLSTATE 'code'`, and the bare `RAISE` that re-raises the handled error.
   */
  private parseRaise(): PlStmt {
    this.pos++;
    let level = "exception";
    const first = this.peek();
    if (first.type === "ident" && RAISE_LEVELS.has(first.value)) {
      level = first.value;
      this.pos++;
    } else if (isPunct(first, ";")) {
      this.pos++;
      return { kind: "reraise" };
    }
    let format: string | null = null;
    let errcode: string | null = null;
    const args: Expr[] = [];
    const options: Array<{ name: string; expr: Expr }> = [];
    const atClauseEnd = (t: Tok): boolean =>
      t.type === "eof" || isPunct(t, ";") || (t.type === "ident" && t.value === "using");
    if (this.peek().type === "string") {
      format = this.next().value;
      while (isPunct(this.peek(), ",")) {
        this.pos++;
        args.push(this.parseExprUntilAny((t) => atClauseEnd(t) || isPunct(t, ",")));
      }
    } else if (this.atKw("sqlstate")) {
      this.pos++;
      const code = this.next();
      if (code.type !== "string" || !/^[0-9A-Z]{5}$/.test(code.value)) {
        throw pgError("syntax", `invalid SQLSTATE code "${code.value}"`, "42601");
      }
      errcode = code.value;
    } else if (this.peek().type === "ident" && !atClauseEnd(this.peek())) {
      errcode = resolveCondition(this.next().value);
    }
    if (this.atKw("using")) {
      this.pos++;
      for (;;) {
        const name = this.next();
        if (name.type !== "ident") throw syntaxError(name.value);
        const eq = this.next();
        if (!isAssignOp(eq)) throw syntaxError(eq.value);
        const bareCondition =
          name.value === "errcode" &&
          this.peek().type === "ident" &&
          (atClauseEnd(this.peek(1)) || isPunct(this.peek(1), ","));
        if (bareCondition) {
          // `ERRCODE = unique_violation` names the condition without quotes
          options.push({ name: name.value, expr: { type: "string_lit", value: this.next().value } });
        } else {
          options.push({
            name: name.value,
            expr: this.parseExprUntilAny((t) => atClauseEnd(t) || isPunct(t, ",")),
          });
        }
        if (isPunct(this.peek(), ",")) {
          this.pos++;
          continue;
        }
        break;
      }
    }
    this.expectSemi();
    return { kind: "raise", level, format, args, errcode, options };
  }

  private parseExprUntilAny(stop: (t: Tok) => boolean): Expr {
    const start = this.peek().pos;
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw syntaxError("end of input");
      if (isPunct(t, "(") || isPunct(t, "[")) depth++;
      if (isPunct(t, ")") || isPunct(t, "]")) depth--;
      if (depth === 0 && stop(t)) return parseSqlExpr(this.src.slice(start, t.pos));
      this.pos++;
    }
  }

  private sqlTextUntilSemi(): string {
    const start = this.peek().pos;
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw syntaxError("end of input");
      if (isPunct(t, "(")) depth++;
      if (isPunct(t, ")")) depth--;
      if (isPunct(t, ";") && depth === 0) {
        const text = this.src.slice(start, t.pos).trim();
        this.pos++;
        return text;
      }
      this.pos++;
    }
  }

  private parseExprUntilSemi(): Expr {
    const expr = this.parseExprUntilAny((t) => isPunct(t, ";"));
    this.pos++;
    return expr;
  }

  /** An expression up to `kw` (consumed), skipping `kw` inside CASE ... END. */
  private parseExprUntilKw(kw: string): Expr {
    const start = this.peek().pos;
    let depth = 0;
    let caseDepth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw syntaxError("end of input");
      if (isPunct(t, "(") || isPunct(t, "[")) depth++;
      if (isPunct(t, ")") || isPunct(t, "]")) depth--;
      if (t.type === "ident" && t.value === "case" && depth === 0) caseDepth++;
      if (t.type === "ident" && t.value === "end" && depth === 0 && caseDepth > 0) caseDepth--;
      if (t.type === "ident" && t.value === kw && depth === 0 && caseDepth === 0) {
        const text = this.src.slice(start, t.pos);
        this.pos++;
        return parseSqlExpr(text);
      }
      this.pos++;
    }
  }
}

function dottedName(toks: Tok[]): string[] {
  const parts: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (i % 2 === 1) {
      if (!isPunct(t, ".")) throw syntaxError(t.value);
    } else {
      if (!isName(t)) throw syntaxError(t.value);
      parts.push(t.value);
    }
  }
  if (parts.length === 0) throw syntaxError("%");
  return parts;
}

function parseOne(text: string): Statement {
  const stmts = parse(text);
  if (stmts.length !== 1) throw syntaxError(";");
  return stmts[0]!;
}

function parseSqlExpr(text: string): Expr {
  if (text.trim() === "") throw syntaxError("end of input");
  const stmts = parse(`SELECT ${text}`);
  const sel = stmts[0] as SelectStmt;
  const body = sel.body as { targets?: Array<{ expr: Expr }>; from?: unknown[] };
  const target = body.targets?.[0];
  if (!target || stmts.length !== 1 || body.targets!.length !== 1 || (body.from?.length ?? 0) > 0) {
    throw pgError("syntax", `syntax error in PL/pgSQL expression "${text.trim()}"`, "42601");
  }
  return target.expr;
}

function parseTypeNameText(text: string): TypeName {
  const stmts = parse(`SELECT NULL::${text.trim()}`);
  const sel = stmts[0] as SelectStmt;
  const body = sel.body as { targets?: Array<{ expr: Expr }> };
  const expr = body.targets?.[0]?.expr;
  if (expr?.type !== "cast") throw unsupported(`plpgsql type "${text}"`);
  return expr.target;
}

const programCache = new Map<string, PlProgram>();

/** Parse a PL/pgSQL body (function, trigger function or DO block); syntax errors surface here. */
export function compilePlpgsql(raw: string): PlProgram {
  let cached = programCache.get(raw);
  if (cached === undefined) {
    cached = new PlParser(raw).parseProgram();
    programCache.set(raw, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

class PlReturn {
  constructor(readonly value: TypedValue | null) {}
}

class LoopSignal {
  constructor(
    readonly isContinue: boolean,
    readonly label: string | null,
  ) {}
}

interface ScalarVar {
  kind: "scalar";
  type: TypeId;
  value: Datum;
  notNull: boolean;
  /** a cursor variable: its portal name is the value; a bound one carries its query */
  cursor?: { bound: Extract<PlDeclType, { kind: "cursor" }> | null };
  /** a routine parameter: `$n` reads this variable (index n - 1) */
  param?: number;
}

interface RecordVar {
  kind: "record";
  /** null: a `record` variable that has not been assigned yet */
  fields: Array<{ name: string; type: TypeId }> | null;
  /** null: the row itself is NULL (every field reads NULL) */
  values: Datum[] | null;
  /** a `%ROWTYPE` / table-typed variable keeps its declared fields */
  fixed: boolean;
}

type PlVar = ScalarVar | RecordVar;

/** The variables in scope, as a row scope SQL statements in the body resolve names against. */
class PlScope extends RowScope {
  constructor(private readonly vars: PlVars) {
    super([], [], null);
  }
  override lookup(parts: string[]): TypedValue | undefined {
    return this.vars.lookup(parts);
  }
  override wholeRow(name: string): TypedValue | undefined {
    const v = this.vars.find(name);
    return v?.kind === "record" ? recordValue(name, v) : undefined;
  }
  override hasRangeVar(name: string): boolean {
    return this.vars.find(name)?.kind === "record";
  }
}

function recordValue(name: string, v: RecordVar): TypedValue {
  if (v.fields === null) {
    throw pgError("object_not_in_prerequisite_state", `record "${name}" is not assigned yet`, "55000");
  }
  if (v.values === null) return tv("record", null);
  return tv("record", {
    kind: "pgrecord",
    types: v.fields.map((f) => f.type),
    values: v.values.slice(),
    names: v.fields.map((f) => f.name),
  });
}

export class PlVars {
  /** Run EXCEPTION blocks as subtransactions (DO blocks); a function body keeps its writes. */
  subtransactions = false;
  /** Errors being handled, innermost last (what a bare RAISE re-raises). */
  readonly caught: unknown[] = [];
  /** ROW_COUNT of the most recent SQL command */
  rowCount = 0;
  private readonly frames: Array<Map<string, PlVar>> = [new Map()];
  readonly scope: RowScope = new PlScope(this);

  push(): void {
    this.frames.push(new Map());
  }
  pop(): void {
    this.frames.pop();
  }

  find(name: string): PlVar | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const v = this.frames[i]!.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  declareScalar(name: string, type: TypeId, value: Datum, notNull = false): void {
    this.frames[this.frames.length - 1]!.set(name, { kind: "scalar", type, value, notNull });
  }

  declareRecord(name: string, fields: RecordVar["fields"], values: Datum[] | null, fixed: boolean): void {
    this.frames[this.frames.length - 1]!.set(name, { kind: "record", fields, values, fixed });
  }

  /** `name ALIAS FOR target`: the same variable under another name. */
  alias(name: string, target: string): void {
    const v = this.find(target);
    if (v === undefined) throw pgError("undefined_object", `variable "${target}" does not exist`, "42704");
    this.frames[this.frames.length - 1]!.set(name, v);
  }

  /** A scalar variable declared in the innermost frame. */
  declared(name: string): ScalarVar {
    return this.frames[this.frames.length - 1]!.get(name) as ScalarVar;
  }

  get(name: string): TypedValue | undefined {
    const v = this.find(name);
    if (v === undefined) return undefined;
    return v.kind === "scalar" ? tv(v.type, v.value) : recordValue(name, v);
  }

  lookup(parts: string[]): TypedValue | undefined {
    if (parts.length === 1) return this.get(parts[0]!);
    if (parts.length !== 2) return undefined;
    const v = this.find(parts[0]!);
    if (v?.kind !== "record") return undefined;
    const field = recordField(parts[0]!, v, parts[1]!);
    return tv(v.fields![field]!.type, v.values?.[field] ?? null);
  }

  setFound(found: boolean): void {
    const v = this.find("found");
    if (v?.kind === "scalar") v.value = found;
  }

  assign(env: ExecEnv, target: Target, value: TypedValue): void {
    const v = this.find(target[0]!);
    if (v === undefined || target.length > 2) {
      throw pgError("syntax", `"${target.join(".")}" is not a known variable`, "42601");
    }
    if (target.length === 2) {
      if (v.kind !== "record") throw pgError("syntax", `"${target.join(".")}" is not a known variable`, "42601");
      const field = recordField(target[0]!, v, target[1]!);
      if (v.values === null) v.values = v.fields!.map(() => null);
      v.values[field] = assignCast(env, value, v.fields![field]!.type);
      return;
    }
    if (v.kind === "scalar") {
      const cast = assignCast(env, value, v.type);
      if (cast === null && v.notNull) {
        throw pgError(
          "null_value_not_allowed",
          `null value cannot be assigned to variable "${target[0]}" declared NOT NULL`,
          "22004",
        );
      }
      v.value = cast;
      if (v.param !== undefined && env.params) env.params[v.param] = tv(v.type, cast);
      return;
    }
    assignRecord(env, v, value);
  }

  /** Assign one result row (null: no row) to `INTO` / `FOR` targets. */
  assignRow(
    env: ExecEnv,
    targets: Target[],
    columns: Array<{ name: string; type: TypeId }>,
    row: Datum[] | null,
  ): void {
    const only = targets.length === 1 && targets[0]!.length === 1 ? this.find(targets[0]![0]!) : undefined;
    if (only?.kind === "record") {
      if (only.fixed) {
        only.values =
          row === null
            ? null
            : only.fields!.map((f, i) => assignCast(env, tv(columns[i]?.type ?? f.type, row[i] ?? null), f.type));
      } else {
        only.fields = columns.map((c) => ({ name: c.name, type: c.type }));
        only.values = row === null ? null : row.slice();
      }
      return;
    }
    for (let i = 0; i < targets.length; i++) {
      this.assign(env, targets[i]!, tv(columns[i]?.type ?? "text", row?.[i] ?? null));
    }
  }
}

function recordField(name: string, v: RecordVar, field: string): number {
  if (v.fields === null) {
    throw pgError("object_not_in_prerequisite_state", `record "${name}" is not assigned yet`, "55000");
  }
  const i = v.fields.findIndex((f) => f.name === field);
  if (i === -1) throw pgError("undefined_column", `record "${name}" has no field "${field}"`, "42703");
  return i;
}

function assignCast(env: ExecEnv, value: TypedValue, type: TypeId): Datum {
  if (value.v === null) return null;
  if (value.t === type) return value.v;
  return castTo(env.ctx, value, type, { assignment: true }).v;
}

function assignRecord(env: ExecEnv, v: RecordVar, value: TypedValue): void {
  if (value.v === null) {
    v.values = null;
    return;
  }
  if (!isPgRecord(value.v)) {
    throw pgError("datatype_mismatch", "cannot assign non-composite value to a record variable", "42804");
  }
  const rec = value.v;
  if (v.fixed) {
    v.values = v.fields!.map((f, i) => assignCast(env, tv(rec.types[i] ?? f.type, rec.values[i] ?? null), f.type));
    return;
  }
  v.fields = rec.types.map((t, i) => ({ name: rec.names?.[i] ?? `f${i + 1}`, type: t }));
  v.values = rec.values.slice();
}

const errorSqlState = (e: unknown): string => (isPostgresError(e) ? e.sqlState : "XX000");

/** The EXCEPTION clause that catches `e`, if any. */
export function findHandler<H extends { conditions: string[] }>(handlers: H[], e: unknown): H | undefined {
  const sqlState = errorSqlState(e);
  return handlers.find((h) => h.conditions.some((c) => conditionMatches(c, sqlState)));
}

/** The text RAISE prints for a value; NULL prints as `<NULL>`. */
function raiseText(env: ExecEnv, v: TypedValue): string {
  return v.v === null ? "<NULL>" : (castTo(env.ctx, v, "text", {}).v as string);
}

export function runRaise(env: ExecEnv, stmt: Extract<PlStmt, { kind: "raise" }>, scope: RowScope): void {
  const values = stmt.args.map((arg) => raiseText(env, evalScalar(env, scope, arg)));
  const options = new Map<string, string>();
  for (const option of stmt.options) {
    const value = evalScalar(env, scope, option.expr);
    options.set(option.name, value.v === null ? "" : (castTo(env.ctx, value, "text", {}).v as string));
  }
  let message: string | undefined;
  if (stmt.format !== null) {
    let used = 0;
    message = stmt.format.replace(/%%|%/g, (token) => {
      if (token === "%%") return "%";
      if (used >= values.length) throw pgError("syntax", "too few parameters specified for RAISE", "42601");
      return values[used++]!;
    });
    if (used < values.length) throw pgError("syntax", "too many parameters specified for RAISE", "42601");
  }
  // notices, warnings and log lines are not delivered to the client: only EXCEPTION does anything
  if (stmt.level !== "exception") return;
  const code = options.has("errcode") ? resolveErrcode(options.get("errcode")!) : (stmt.errcode ?? "P0001");
  message ??= options.get("message");
  message ??= Object.entries(CONDITION_NAMES).find(([, sqlState]) => sqlState === code)?.[0] ?? code;
  throw pgError("raise_exception", message, code);
}

/** `ERRCODE = 'unique_violation'` or `ERRCODE = '23505'`. */
function resolveErrcode(value: string): string {
  return /^[0-9A-Z]{5}$/.test(value) ? value : resolveCondition(value);
}

export interface Subtransaction {
  release(): void;
  rollback(): void;
}

/** An EXCEPTION block's implicit savepoint: what its body wrote is taken back when a handler catches an error. */
export function beginSubtransaction(env: ExecEnv): Subtransaction {
  const state = env.ctx.state;
  const prng = state.prng.getState();
  const hold = state.holdForRollback();
  return {
    release: () => state.releaseHold(hold.epoch),
    rollback: () => {
      state.restoreFrom(hold.state, true);
      state.prng.setState(prng);
      state.releaseHold(hold.epoch);
    },
  };
}

/** One running invocation: the SQL environment its statements run in, its variables and its result rows. */
interface Run {
  env: ExecEnv;
  vars: PlVars;
  /** rows of a set-returning function; null outside one */
  emit: Datum[][] | null;
  /** the result row shape RETURN NEXT / RETURN QUERY build */
  outCols: Array<{ name: string; type: TypeId }>;
  /** names of the OUT / TABLE variables a bare RETURN NEXT emits */
  outVars: string[] | null;
}

const DML_TYPES = new Set(["insert", "update", "delete", "merge"]);

function runStmts(run: Run, stmts: PlStmt[]): void {
  for (const stmt of stmts) runStmt(run, stmt);
}

function evalIn(run: Run, e: Expr): TypedValue {
  return evalScalar(run.env, run.vars.scope, e);
}

function predicate(run: Run, e: Expr): boolean {
  return evalPredicate(run.env, run.vars.scope, e);
}

/** Run `body` once as a loop iteration; false when an EXIT left the loop. */
function iterate(run: Run, label: string | null, body: PlStmt[]): boolean {
  try {
    runStmts(run, body);
    return true;
  } catch (e) {
    if (e instanceof LoopSignal && (e.label === null || e.label === label)) return e.isContinue;
    throw e;
  }
}

/** Run a dynamic command (`EXECUTE`): it sees its USING values as $n, never the function's variables. */
function runDynamic(run: Run, expr: Expr, using: Expr[]): ExecResult {
  const command = evalIn(run, expr);
  if (command.v === null) {
    throw pgError("null_value_not_allowed", "query string argument of EXECUTE is null", "22004");
  }
  const params = using.map((u) => evalIn(run, u));
  const env: ExecEnv = {
    ctx: run.env.ctx,
    params,
    ctes: run.env.ctes,
    outer: null,
    allowUnpopulatedMatviews: run.env.allowUnpopulatedMatviews,
  };
  let last: ExecResult = commandResult("EXECUTE", 0);
  const stmts = parse(castTo(run.env.ctx, command, "text", {}).v as string);
  if (stmts.length === 0) throw pgError("syntax", "cannot execute an empty query", "42601");
  for (const stmt of stmts) last = runStatement(env, stmt);
  return last;
}

function assignInto(run: Run, into: Into, result: ExecResult, dml: boolean): void {
  if (result.rows.length === 0 && into.strict) throw pgError("raise_exception", "query returned no rows", "P0002");
  if (result.rows.length > 1 && (into.strict || dml)) {
    throw pgError("raise_exception", "query returned more than one row", "P0003");
  }
  run.vars.assignRow(run.env, into.targets, result.columns, result.rows[0] ?? null);
}

/** One result row of a set-returning function, from RETURN NEXT's value. */
function emitValue(run: Run, value: TypedValue): void {
  const cols = run.outCols;
  if (value.t === "record" && (cols.length > 1 || isPgRecord(value.v) || value.v === null)) {
    if (value.v === null) {
      run.emit!.push(cols.map(() => null));
      return;
    }
    const rec = value.v;
    if (!isPgRecord(rec) || rec.values.length !== cols.length) {
      throw pgError("datatype_mismatch", "wrong record type supplied in RETURN NEXT", "42804");
    }
    run.emit!.push(cols.map((c, i) => assignCast(run.env, tv(rec.types[i]!, rec.values[i] ?? null), c.type)));
    return;
  }
  if (cols.length !== 1) throw pgError("datatype_mismatch", "wrong record type supplied in RETURN NEXT", "42804");
  run.emit!.push([assignCast(run.env, value, cols[0]!.type)]);
}

function emitRows(run: Run, result: ExecResult): void {
  const cols = run.outCols;
  if (result.columns.length !== cols.length) {
    throw pgError("datatype_mismatch", "structure of query does not match function result type", "42804");
  }
  for (const row of result.rows) {
    run.emit!.push(cols.map((c, i) => assignCast(run.env, tv(result.columns[i]!.type, row[i] ?? null), c.type)));
  }
  run.vars.rowCount = result.rows.length;
  run.vars.setFound(result.rows.length > 0);
}

function declare(run: Run, d: PlDecl): void {
  const state = run.env.ctx.state;
  const vars = run.vars;
  const tableFields = (parts: string[]) => {
    const table = state.findTable(parts);
    if (!table) throw pgError("undefined_table", `relation "${parts.join(".")}" does not exist`, "42P01");
    return table.columns.map((c) => ({ name: c.name, type: c.type.id }));
  };
  switch (d.type.kind) {
    case "alias":
      vars.alias(d.name, d.type.target);
      return;
    case "refcursor":
      vars.declareScalar(d.name, "text", null, d.notNull);
      vars.declared(d.name).cursor = { bound: null };
      break;
    case "cursor":
      vars.declareScalar(d.name, "text", null);
      vars.declared(d.name).cursor = { bound: d.type };
      return;
    case "record":
      vars.declareRecord(d.name, null, null, false);
      break;
    case "rowtype":
      vars.declareRecord(d.name, tableFields(d.type.table), null, true);
      break;
    case "copytype": {
      const ref = d.type.ref;
      let type: TypeId | undefined;
      if (ref.length === 1) {
        const v = vars.find(ref[0]!);
        if (v?.kind === "scalar") type = v.type;
        else if (v?.kind === "record") {
          vars.declareRecord(d.name, v.fields, null, v.fixed);
          break;
        }
      } else {
        const v = vars.find(ref[0]!);
        if (ref.length === 2 && v?.kind === "record") {
          type = v.fields![recordField(ref[0]!, v, ref[1]!)]!.type;
        } else {
          const fields = tableFields(ref.slice(0, -1));
          type = fields.find((f) => f.name === ref[ref.length - 1])?.type;
          if (type === undefined) {
            throw pgError(
              "undefined_column",
              `column "${ref[ref.length - 1]}" of relation "${ref[ref.length - 2]}" does not exist`,
              "42703",
            );
          }
        }
      }
      if (type === undefined) throw pgError("undefined_object", `variable "${ref.join(".")}" does not exist`, "42704");
      vars.declareScalar(d.name, type, null, d.notNull);
      break;
    }
    case "type": {
      const tn = d.type.typeName;
      const table = tn.parts.length <= 2 && tn.arrayDims === 0 ? state.findTable(tn.parts) : null;
      if (table) {
        vars.declareRecord(d.name, tableFields(tn.parts), null, true);
      } else {
        vars.declareScalar(d.name, resolveTypeName(state, tn).column.id, null, d.notNull);
      }
      break;
    }
  }
  if (d.init !== null) vars.assign(run.env, [d.name], evalIn(run, d.init));
  else if (d.notNull) {
    throw pgError(
      "null_value_not_allowed",
      `variable "${d.name}" must have a default value, since it's declared NOT NULL`,
      "22004",
    );
  }
}

function runBlock(run: Run, stmt: Extract<PlStmt, { kind: "block" }>): void {
  const vars = run.vars;
  vars.push();
  try {
    for (const d of stmt.decls) declare(run, d);
    if (stmt.handlers === null) {
      runStmts(run, stmt.body);
      return;
    }
    const subtransaction = vars.subtransactions ? beginSubtransaction(run.env) : null;
    // COMMIT / ROLLBACK cannot end the transaction while this block's subtransaction is open
    const ctl = currentTxFrame()?.ctl ?? null;
    try {
      if (ctl) ctl.subtransactions++;
      try {
        runStmts(run, stmt.body);
      } finally {
        if (ctl) ctl.subtransactions--;
      }
      subtransaction?.release();
    } catch (e) {
      if (e instanceof PlReturn || e instanceof LoopSignal) {
        subtransaction?.release();
        throw e;
      }
      const sqlState = errorSqlState(e);
      const handler = findHandler(stmt.handlers, e);
      if (handler === undefined) {
        subtransaction?.release();
        throw e;
      }
      // the failed block's writes are undone, as PostgreSQL's implicit savepoint does
      subtransaction?.rollback();
      vars.push();
      vars.declareScalar("sqlerrm", "text", e instanceof Error ? e.message : String(e));
      vars.declareScalar("sqlstate", "text", sqlState);
      vars.caught.push(e);
      try {
        runStmts(run, handler.body);
      } finally {
        vars.caught.pop();
        vars.pop();
      }
    }
  } catch (e) {
    if (e instanceof LoopSignal && !e.isContinue && e.label !== null && e.label === stmt.label) return;
    throw e;
  } finally {
    vars.pop();
  }
}

/** GET STACKED DIAGNOSTICS items, from the error being handled. */
function stackedItem(e: unknown, item: string): string {
  const err = (isPostgresError(e) ? e : null) as (Error & Record<string, unknown>) | null;
  const field = (name: string): string => {
    const v = err?.[name];
    return typeof v === "string" ? v : "";
  };
  switch (item) {
    case "returned_sqlstate":
      return errorSqlState(e);
    case "message_text":
      return e instanceof Error ? e.message : String(e);
    case "pg_exception_detail":
      return field("detail");
    case "pg_exception_hint":
      return field("hint");
    case "pg_exception_context":
      return "";
    case "column_name":
      return field("column");
    case "constraint_name":
      return field("constraint");
    case "pg_datatype_name":
      return field("dataType");
    case "table_name":
      return field("table");
    case "schema_name":
      return field("schema");
    default:
      throw pgError("syntax", `unrecognized GET STACKED DIAGNOSTICS item "${item}"`, "42601");
  }
}

function runStmt(run: Run, stmt: PlStmt): void {
  const { env, vars } = run;
  switch (stmt.kind) {
    case "assign":
      vars.assign(env, stmt.target, evalIn(run, stmt.expr));
      return;
    case "return":
      throw new PlReturn(stmt.expr === null ? null : evalIn(run, stmt.expr));
    case "return_next": {
      if (run.emit === null) throw pgError("syntax", "cannot use RETURN NEXT in a non-SETOF function", "42804");
      if (stmt.expr !== null) {
        emitValue(run, evalIn(run, stmt.expr));
      } else if (run.outVars !== null) {
        run.emit.push(
          run.outVars.map((n, i) => assignCast(env, vars.get(n) ?? tv("text", null), run.outCols[i]!.type)),
        );
      } else {
        throw pgError("syntax", "RETURN NEXT must have a parameter", "42601");
      }
      return;
    }
    case "return_query": {
      if (run.emit === null) throw pgError("syntax", "cannot use RETURN QUERY in a non-SETOF function", "42804");
      const result = stmt.query !== null ? runStatement(env, stmt.query) : runDynamic(run, stmt.dynamic!, stmt.using);
      emitRows(run, result);
      return;
    }
    case "if": {
      for (const b of stmt.branches) {
        if (predicate(run, b.cond)) {
          runStmts(run, b.body);
          return;
        }
      }
      runStmts(run, stmt.elseBody);
      return;
    }
    case "case": {
      const head = stmt.expr === null ? null : evalIn(run, stmt.expr);
      for (const b of stmt.branches) {
        let hit: boolean;
        if (head === null) {
          hit = predicate(run, b.cond);
        } else {
          const when = evalIn(run, b.cond);
          hit = false;
          if (head.v !== null && when.v !== null) {
            const rhs = when.t === head.t ? when : castTo(env.ctx, when, head.t, {});
            hit = datumEquals(head.t, head.v, rhs.v);
          }
        }
        if (hit) {
          runStmts(run, b.body);
          return;
        }
      }
      if (stmt.elseBody === null) throw pgError("case_not_found", "case not found", "20000");
      runStmts(run, stmt.elseBody);
      return;
    }
    case "null":
      return;
    case "raise":
      runRaise(env, stmt, vars.scope);
      return;
    case "reraise": {
      const error = vars.caught.at(-1);
      if (error === undefined) {
        throw pgError("internal", "RAISE without parameters cannot be used outside an exception handler", "0Z002");
      }
      throw error;
    }
    case "assert": {
      const ok = evalIn(run, stmt.cond);
      if (ok.v === true) return;
      let message = "assertion failed";
      if (stmt.message !== null) {
        const m = evalIn(run, stmt.message);
        if (m.v !== null) message = castTo(env.ctx, m, "text", {}).v as string;
      }
      throw pgError("raise_exception", message, "P0004");
    }
    case "execute": {
      const result = runDynamic(run, stmt.expr, stmt.using);
      vars.rowCount = result.rowCount;
      if (stmt.into !== null) assignInto(run, stmt.into, result, false);
      return;
    }
    case "perform": {
      const result = runStatement(env, stmt.query);
      vars.rowCount = result.rows.length;
      vars.setFound(result.rows.length > 0);
      return;
    }
    case "sql": {
      const isQuery = stmt.stmt.type === "select" || (stmt.stmt.type as string) === "values";
      if (isQuery && stmt.into === null) {
        throw pgError("syntax", "query has no destination for result data", "42601");
      }
      const result = runStatement(env, stmt.stmt);
      const dml = DML_TYPES.has(stmt.stmt.type);
      if (stmt.into !== null) {
        assignInto(run, stmt.into, result, dml);
        vars.rowCount = Math.min(result.rows.length, 1);
        if (dml) vars.rowCount = result.rowCount;
        vars.setFound(result.rows.length > 0);
        return;
      }
      vars.rowCount = result.rowCount;
      if (dml) vars.setFound(result.rowCount > 0);
      return;
    }
    case "diagnostics": {
      for (const { target, item } of stmt.items) {
        if (stmt.stacked) {
          const error = vars.caught.at(-1);
          if (error === undefined) {
            throw pgError("internal", "GET STACKED DIAGNOSTICS cannot be used outside an exception handler", "0Z002");
          }
          vars.assign(env, target, tv("text", stackedItem(error, item)));
        } else if (item === "row_count") {
          vars.assign(env, target, tv("int8", BigInt(vars.rowCount)));
        } else if (item === "pg_context") {
          vars.assign(env, target, tv("text", ""));
        } else {
          throw unsupported(`GET DIAGNOSTICS ${item.toUpperCase()}`);
        }
      }
      return;
    }
    case "block":
      runBlock(run, stmt);
      return;
    case "loop":
      while (iterate(run, stmt.label, stmt.body));
      return;
    case "while":
      while (predicate(run, stmt.cond) && iterate(run, stmt.label, stmt.body));
      return;
    case "for_int": {
      const bound = (e: Expr, what: string): number => {
        const v = evalIn(run, e);
        if (v.v === null) throw pgError("null_value_not_allowed", `${what} of FOR loop cannot be null`, "22004");
        return Number(castTo(env.ctx, v, "int4", { assignment: true }).v);
      };
      const lower = bound(stmt.lower, "lower bound");
      const upper = bound(stmt.upper, "upper bound");
      const step = stmt.step === null ? 1 : bound(stmt.step, "BY value");
      if (step <= 0) {
        throw pgError("invalid_parameter_value", "BY value of FOR loop must be greater than zero", "22023");
      }
      vars.push();
      let found = false;
      try {
        vars.declareScalar(stmt.variable, "int4", null);
        for (let i = lower; stmt.reverse ? i >= upper : i <= upper; i += stmt.reverse ? -step : step) {
          found = true;
          vars.assign(env, [stmt.variable], tv("int4", i));
          if (!iterate(run, stmt.label, stmt.body)) break;
        }
      } finally {
        vars.pop();
      }
      vars.setFound(found);
      return;
    }
    case "for_query": {
      const result = stmt.query !== null ? runStatement(env, stmt.query) : runDynamic(run, stmt.dynamic!, stmt.using);
      for (const row of result.rows) {
        vars.assignRow(env, stmt.targets, result.columns, row);
        if (!iterate(run, stmt.label, stmt.body)) break;
      }
      vars.setFound(result.rows.length > 0);
      return;
    }
    case "foreach": {
      const array = evalIn(run, stmt.array);
      if (array.v === null) throw pgError("null_value_not_allowed", "FOREACH expression must not be null", "22004");
      if (!isPgArray(array.v)) throw pgError("datatype_mismatch", "FOREACH expression must yield an array", "42804");
      if (stmt.targets.length !== 1) throw unsupported("plpgsql FOREACH with several targets");
      const arr = array.v;
      const elem = arr.elem;
      const target = stmt.targets[0]!;
      const loopVar = target.length === 1 ? vars.find(target[0]!) : undefined;
      const varIsArray = loopVar?.kind === "scalar" && isArrayType(loopVar.type);
      if (stmt.slice === 0) {
        if (varIsArray) {
          throw pgError("datatype_mismatch", "FOREACH loop variable must not be of an array type", "42804");
        }
        for (const item of arr.items) {
          vars.assign(env, target, tv(elem, item));
          if (!iterate(run, stmt.label, stmt.body)) break;
        }
        return;
      }
      if (!varIsArray) {
        throw pgError("datatype_mismatch", "FOREACH ... SLICE loop variable must be of an array type", "42804");
      }
      const ndims = arr.dims.length;
      if (stmt.slice > ndims) {
        throw pgError(
          "array_subscript_error",
          `slice dimension (${stmt.slice}) is out of the valid range 0..${ndims}`,
          "2202E",
        );
      }
      const dims = arr.dims.slice(ndims - stmt.slice);
      const lbs = arr.lbs.slice(ndims - stmt.slice);
      const size = dims.reduce((a, b) => a * b, 1);
      for (let at = 0; at + size <= arr.items.length && size > 0; at += size) {
        const part = makeArray(elem, arr.items.slice(at, at + size), dims.slice(), lbs.slice());
        vars.assign(env, target, tv(arrayTypeOf(elem), part));
        if (!iterate(run, stmt.label, stmt.body)) break;
      }
      return;
    }
    case "exit":
      if (stmt.cond !== null && !predicate(run, stmt.cond)) return;
      throw new LoopSignal(stmt.isContinue, stmt.label);
    case "assign_subscript":
      assignSubscript(run, stmt);
      return;
    case "call":
      runCall(run, stmt.call);
      return;
    case "transaction":
      transactionControl(stmt.action);
      return;
    case "open":
      openCursor(run, stmt);
      return;
    case "fetch":
      fetchCursor(run, stmt);
      return;
    case "close": {
      const name = portalNameOf(run, stmt.cursor);
      if (findPortal(env.ctx, name) === undefined) {
        throw pgError("invalid_cursor", `cursor "${name}" does not exist`, "34000");
      }
      removePortal(env.ctx, name);
      return;
    }
    case "for_cursor": {
      const name = openBoundCursor(run, stmt.cursor, stmt.args);
      const portal = findPortal(env.ctx, name)!;
      vars.push();
      let found = false;
      try {
        vars.declareRecord(stmt.variable, null, null, false);
        while (portal.pos < portal.rows.length) {
          const row = portal.rows[portal.pos++]!;
          found = true;
          vars.assignRow(env, [[stmt.variable]], portal.columns, row);
          if (!iterate(run, stmt.label, stmt.body)) break;
        }
      } finally {
        vars.pop();
        removePortal(env.ctx, name);
      }
      vars.setFound(found);
      return;
    }
  }
}

/** `a[i] := v` on a variable or record field holding an array. */
function assignSubscript(run: Run, stmt: Extract<PlStmt, { kind: "assign_subscript" }>): void {
  const { env, vars } = run;
  const current = vars.lookup(stmt.target);
  if (current === undefined) {
    throw pgError("syntax", `"${stmt.target.join(".")}" is not a known variable`, "42601");
  }
  const v = stmt.target.length === 1 ? vars.find(stmt.target[0]!) : undefined;
  const type = v?.kind === "scalar" ? v.type : current.t;
  if (!isArrayType(type)) {
    throw pgError(
      "datatype_mismatch",
      `cannot subscript type ${typeDisplayName(type)} because it does not support subscripting`,
      "42804",
    );
  }
  const bound = (e: Expr | null): number | null => {
    if (e === null) return null;
    const value = evalIn(run, e);
    if (value.v === null) {
      throw pgError("null_value_not_allowed", "array subscript in assignment must not be null", "22004");
    }
    return Number(castTo(env.ctx, value, "int4", { assignment: true }).v);
  };
  const subscripts: AssignSubscript[] = stmt.subscripts.map((s) => ({
    lower: bound(s.lower),
    upper: bound(s.upper),
    slice: s.slice,
  }));
  const elem = arrayElemType(type);
  const raw = evalIn(run, stmt.expr);
  const slice = subscripts.some((s) => s.slice);
  const value = assignCast(env, raw, slice ? type : elem);
  vars.assign(env, stmt.target, tv(type, assignArraySubscripts(current.v, elem, subscripts, value)));
}

/** `CALL p(args)` from PL/pgSQL: OUT / INOUT results are written back to the variables passed for them. */
function runCall(run: Run, call: FuncCall): void {
  const bound = bindCall(run.env, call);
  const fn = bound.fn;
  const writes: Target[] = [];
  (fn.argModes ?? []).forEach((mode, i) => {
    if (mode !== "out" && mode !== "inout") return;
    const source = bound.sources[i]!;
    const target = source === -1 ? null : writableTarget(call.args[source]);
    if (target === null || run.vars.lookup(target) === undefined) {
      throw pgError(
        "syntax",
        `procedure parameter "${fn.argNames[i] ?? `$${i + 1}`}" is an output parameter but corresponding argument is not writable`,
        "42601",
      );
    }
    writes.push(target);
  });
  const out = invokeProcedure(run.env, bound);
  if (out === null) return;
  const outs = fn.outArgs ?? [];
  writes.forEach((target, i) => {
    run.vars.assign(run.env, target, tv(outs[i]?.type ?? "text", out[i] ?? null));
  });
}

/** The cursor variable called `name`. */
function cursorVar(run: Run, name: string): ScalarVar {
  const v = run.vars.find(name);
  if (v?.kind !== "scalar" || v.cursor === undefined) {
    throw pgError("datatype_mismatch", `variable "${name}" must be of type cursor or refcursor`, "42804");
  }
  return v;
}

/** The portal name a cursor variable holds (22004 when it holds none). */
function portalNameOf(run: Run, name: string): string {
  const v = cursorVar(run, name);
  if (v.value === null) throw pgError("null_value_not_allowed", `cursor variable "${name}" is null`, "22004");
  return String(v.value);
}

/** Open a portal on `result` under the variable's name (or a fresh unnamed one). */
function openPortal(run: Run, v: ScalarVar, result: ExecResult, noScroll: boolean): string {
  const ctx = run.env.ctx;
  const name = v.value === null ? unnamedPortalName(ctx) : String(v.value);
  if (findPortal(ctx, name) !== undefined) {
    throw pgError("duplicate_object", `cursor "${name}" already in use`, "42P03");
  }
  addPortal(ctx, name, result, !noScroll, "");
  v.value = name;
  return name;
}

/** Open a bound cursor with its arguments; the portal's name. */
function openBoundCursor(run: Run, name: string, args: CursorArgs | null): string {
  const v = cursorVar(run, name);
  const decl = v.cursor!.bound;
  if (decl === null) throw pgError("syntax", `cursor "${name}" is not a bound cursor`, "42601");
  const given = args ?? [];
  const values: Array<TypedValue | undefined> = decl.params.map(() => undefined);
  given.forEach((arg, i) => {
    const at = arg.name === null ? i : decl.params.findIndex((p) => p.name === arg.name);
    if (at < 0) throw pgError("syntax", `cursor "${name}" has no argument named "${arg.name}"`, "42601");
    if (values[at] !== undefined) {
      throw pgError(
        "syntax",
        `value for parameter "${decl.params[at]!.name}" of cursor "${name}" specified more than once`,
        "42601",
      );
    }
    values[at] = evalIn(run, arg.expr);
  });
  if (values.some((x) => x === undefined)) {
    throw pgError("syntax", `not enough arguments for cursor "${name}"`, "42601");
  }
  const state = run.env.ctx.state;
  run.vars.push();
  let result: ExecResult;
  try {
    decl.params.forEach((p, i) => {
      const type = resolveTypeName(state, p.typeName).column.id;
      run.vars.declareScalar(p.name, type, assignCast(run.env, values[i]!, type));
    });
    result = runStatement(run.env, decl.query);
  } finally {
    run.vars.pop();
  }
  return openPortal(run, v, result, decl.scroll === false);
}

function openCursor(run: Run, stmt: Extract<PlStmt, { kind: "open" }>): void {
  if (stmt.query === null && stmt.dynamic === null) {
    openBoundCursor(run, stmt.cursor, stmt.args);
    return;
  }
  const v = cursorVar(run, stmt.cursor);
  if (v.cursor!.bound !== null) throw syntaxError("FOR");
  const result = stmt.query !== null ? runStatement(run.env, stmt.query) : runDynamic(run, stmt.dynamic!, stmt.using);
  openPortal(run, v, result, stmt.scroll === false);
}

/** FETCH / MOVE: reposition the portal and, for FETCH, assign the row landed on. */
function fetchCursor(run: Run, stmt: Extract<PlStmt, { kind: "fetch" }>): void {
  const { env, vars } = run;
  const name = portalNameOf(run, stmt.cursor);
  const portal = findPortal(env.ctx, name);
  if (portal === undefined) throw pgError("invalid_cursor", `cursor "${name}" does not exist`, "34000");
  const n = portal.rows.length;
  const from = portal.pos;
  const count = (e: Expr): number => {
    const value = evalIn(run, e);
    if (value.v === null) throw pgError("null_value_not_allowed", "FETCH / MOVE count must not be null", "22004");
    return Number(castTo(env.ctx, value, "int8", { assignment: true }).v);
  };
  const clamp = (p: number) => Math.max(0, Math.min(n + 1, p));
  const dir = stmt.direction;
  let to: number;
  let moved: number | null = null;
  switch (dir.kind) {
    case "next":
      to = clamp(from + 1);
      break;
    case "prior":
      to = clamp(from - 1);
      break;
    case "first":
      to = clamp(1);
      break;
    case "last":
      to = n;
      break;
    case "absolute": {
      const k = count(dir.count);
      to = k >= 0 ? clamp(k) : clamp(n + 1 + k);
      break;
    }
    case "relative":
      to = clamp(from + count(dir.count));
      break;
    case "forward": {
      const k = dir.count === null ? n + 1 : count(dir.count);
      if (!stmt.move && k !== 1) throw pgError("unsupported", "FETCH statement cannot return multiple rows", "0A000");
      to = clamp(from + k);
      if (stmt.move) moved = Math.max(0, Math.min(from + k, n) - from);
      break;
    }
    case "backward": {
      const k = dir.count === null ? n + 1 : count(dir.count);
      if (!stmt.move && k !== 1) throw pgError("unsupported", "FETCH statement cannot return multiple rows", "0A000");
      to = clamp(from - k);
      if (stmt.move) moved = Math.max(0, Math.min(from - 1, n) - Math.max(from - k, 1) + 1);
      break;
    }
  }
  if (!portal.scrollable && to < from) {
    throw pgError("object_not_in_prerequisite_state", "cursor can only scan forward", "55000");
  }
  portal.pos = to;
  const row = to >= 1 && to <= n ? portal.rows[to - 1]! : null;
  const rows = moved ?? (row === null ? 0 : 1);
  vars.rowCount = rows;
  vars.setFound(rows > 0);
  if (!stmt.move) vars.assignRow(env, stmt.into!, portal.columns, row);
}

/** Run a body to its end, a RETURN, or an error; the RETURN's value (null when none). */
function runBody(run: Run, program: PlProgram): { returned: boolean; value: TypedValue | null } {
  try {
    runStmts(run, program.body);
  } catch (e) {
    if (e instanceof PlReturn) return { returned: true, value: e.value };
    if (e instanceof LoopSignal) {
      throw pgError("syntax", `${e.isContinue ? "CONTINUE" : "EXIT"} cannot be used outside a loop`, "42601");
    }
    throw e;
  }
  return { returned: false, value: null };
}

function bindArgs(env: ExecEnv, fn: FunctionData, args: TypedValue[]): TypedValue[] {
  const bound: TypedValue[] = [];
  for (let i = 0; i < fn.argTypes.length; i++) {
    if (i < args.length) {
      bound.push(castTo(env.ctx, args[i]!, fn.argTypes[i]!, {}));
    } else {
      const dflt = fn.argDefaults[i];
      if (!dflt) throw pgError("undefined_function", `function ${fn.name} argument ${i + 1} missing`, "42883");
      bound.push(castTo(env.ctx, evalScalar(env, null, dflt), fn.argTypes[i]!, {}));
    }
  }
  return bound;
}

/** The OUT / INOUT / TABLE columns of `fn`, which are variables of its body. */
function outColumns(fn: FunctionData): Array<{ name: string; type: TypeId }> | null {
  if (fn.outArgs && fn.outArgs.length > 0) return fn.outArgs;
  return fn.returnsTable;
}

function startRun(
  env: ExecEnv,
  fn: FunctionData | null,
  bound: TypedValue[],
  emit: Datum[][] | null,
  ctes?: Map<string, Relation>,
): Run {
  const vars = new PlVars();
  const runEnv: ExecEnv = {
    ctx: env.ctx,
    params: bound,
    ctes: ctes ?? new Map(),
    outer: vars.scope,
    allowUnpopulatedMatviews: env.allowUnpopulatedMatviews,
  };
  vars.declareScalar("found", "bool", false);
  for (let i = 0; i < (fn?.argTypes.length ?? 0); i++) {
    // `$n` and the parameter's name are one variable: assigning either changes what both read
    const positional = `$${i + 1}`;
    const n = fn!.argNames[i] ?? positional;
    vars.declareScalar(n, fn!.argTypes[i]!, bound[i]?.v ?? null);
    vars.declared(n).param = i;
    if (n !== positional) vars.alias(positional, n);
  }
  const outs = fn ? outColumns(fn) : null;
  if (outs) for (const c of outs) if (vars.find(c.name) === undefined) vars.declareScalar(c.name, c.type, null);
  const outCols = fn?.returnsTable ?? [{ name: fn?.name ?? "?column?", type: fn?.returns ?? "text" }];
  return { env: runEnv, vars, emit, outCols, outVars: outs?.map((c) => c.name) ?? null };
}

/** The single row a non-set function with OUT parameters (or a composite result) produces. */
function outRow(run: Run, fn: FunctionData, value: TypedValue | null): Datum[] {
  if (value !== null) {
    if (value.v === null) return run.outCols.map(() => null);
    if (isPgRecord(value.v)) {
      const rec = value.v;
      return run.outCols.map((c, i) => assignCast(run.env, tv(rec.types[i] ?? c.type, rec.values[i] ?? null), c.type));
    }
    return [assignCast(run.env, value, run.outCols[0]!.type)];
  }
  if (fn.outArgs && fn.outArgs.length > 0) {
    return run.outCols.map((c) => assignCast(run.env, run.vars.get(c.name) ?? tv("text", null), c.type));
  }
  return run.outCols.map(() => null);
}

export function callPlpgsqlScalar(env: ExecEnv, fn: FunctionData, args: TypedValue[]): TypedValue {
  const retT = fn.returns ?? "record";
  if (fn.strict && args.some((a) => a.v === null)) return tv(retT, null);
  const raw = fn.rawBody;
  if (raw === null) throw pgError("unsupported", `function ${fn.name} has no executable body`);
  const program = compilePlpgsql(raw);
  const bound = bindArgs(env, fn, args);
  const run = startRun(env, fn, bound, null);
  const { returned, value } = runBody(run, program);
  const outs = fn.outArgs ?? [];
  if (outs.length === 1 && value === null) return tv(retT, assignCast(run.env, run.vars.get(outs[0]!.name)!, retT));
  if (outs.length > 1 || (fn.returnsTable && !fn.returnsSet)) {
    const row = outRow(run, fn, value);
    return tv("record", {
      kind: "pgrecord",
      types: run.outCols.map((c) => c.type),
      values: row,
      names: run.outCols.map((c) => c.name),
    });
  }
  if (!returned && retT !== "void" && outs.length === 0) {
    throw pgError("invalid_function_definition", "control reached end of function without RETURN", "2F005");
  }
  if (value === null || value.v === null) return tv(retT, null);
  return castTo(env.ctx, value, retT, {});
}

export function callPlpgsqlSet(env: ExecEnv, fn: FunctionData, args: TypedValue[]): Relation {
  const cols = (fn.returnsTable ?? [{ name: fn.name, type: fn.returns ?? "text" }]).map((c) => ({
    name: c.name,
    type: c.type,
    table: null as string | null,
  }));
  if (fn.strict && args.some((a) => a.v === null)) return { columns: cols, rows: [] };
  const raw = fn.rawBody;
  if (raw === null) throw pgError("unsupported", `function ${fn.name} has no executable body`);
  const program = compilePlpgsql(raw);
  const bound = bindArgs(env, fn, args);
  if (!fn.returnsSet) {
    // a non-set function in FROM: its one value (or OUT row) is the one row
    const run = startRun(env, fn, bound, null);
    const { value } = runBody(run, program);
    if (fn.returnsTable || (fn.outArgs?.length ?? 0) > 0) return { columns: cols, rows: [outRow(run, fn, value)] };
    return { columns: cols, rows: [[value === null ? null : assignCast(run.env, value, cols[0]!.type)]] };
  }
  const emit: Datum[][] = [];
  const run = startRun(env, fn, bound, emit);
  runBody(run, program);
  return { columns: cols, rows: emit };
}

/** What a trigger function runs with: the row(s) and the `TG_*` variables. */
export interface TriggerCall {
  table: { name: string; schema: string; oid: number; columns: Array<{ name: string; type: TypeId }> };
  name: string;
  when: "BEFORE" | "AFTER" | "INSTEAD OF";
  level: "ROW" | "STATEMENT";
  op: "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";
  args: string[];
  oldRow: Datum[] | null;
  newRow: Datum[] | null;
  /** transition tables of a statement trigger */
  ctes: Map<string, Relation>;
}

/**
 * Run a plpgsql trigger function. Returns the row it returned (null for `RETURN NULL`), positionally
 * matched to the table's columns.
 */
/** Run a plpgsql event trigger function (`RETURNS event_trigger`) with `TG_EVENT` and `TG_TAG` (issue #692). */
export function callPlpgsqlEventTrigger(env: ExecEnv, fn: FunctionData, event: string, tag: string): void {
  if (fn.language !== "plpgsql")
    throw pgError("unsupported", `event trigger functions in LANGUAGE ${fn.language}`, "0A000");
  const raw = fn.rawBody;
  if (raw === null) throw pgError("unsupported", `function ${fn.name} has no executable body`);
  atomicFunctionContext(() => {
    const program = compilePlpgsql(raw);
    const run = startRun(env, null, [], null);
    run.vars.declareScalar("tg_event", "text", event);
    run.vars.declareScalar("tg_tag", "text", tag);
    runBody(run, program);
  });
}

export function callPlpgsqlTrigger(env: ExecEnv, fn: FunctionData, call: TriggerCall): Datum[] | null {
  return atomicFunctionContext(() => runTrigger(env, fn, call));
}

function runTrigger(env: ExecEnv, fn: FunctionData, call: TriggerCall): Datum[] | null {
  const raw = fn.rawBody;
  if (raw === null) throw pgError("unsupported", `function ${fn.name} has no executable body`);
  const program = compilePlpgsql(raw);
  const run = startRun(env, null, [], null, call.ctes);
  const vars = run.vars;
  const fields = call.table.columns;
  vars.declareRecord("new", fields, call.newRow ? call.newRow.slice() : null, true);
  vars.declareRecord("old", fields, call.oldRow ? call.oldRow.slice() : null, true);
  vars.declareScalar("tg_name", "name", call.name);
  vars.declareScalar("tg_when", "text", call.when);
  vars.declareScalar("tg_level", "text", call.level);
  vars.declareScalar("tg_op", "text", call.op);
  vars.declareScalar("tg_relid", "oid", call.table.oid);
  vars.declareScalar("tg_relname", "name", call.table.name);
  vars.declareScalar("tg_table_name", "name", call.table.name);
  vars.declareScalar("tg_table_schema", "name", call.table.schema);
  vars.declareScalar("tg_nargs", "int4", call.args.length);
  vars.declareScalar("tg_argv", "text[]", {
    kind: "pgarray",
    elem: "text",
    dims: call.args.length === 0 ? [] : [call.args.length],
    lbs: call.args.length === 0 ? [] : [0],
    items: call.args.slice(),
  });
  const { returned, value } = runBody(run, program);
  if (!returned) {
    throw pgError("invalid_function_definition", "control reached end of trigger procedure without RETURN", "2F005");
  }
  if (value === null || value.v === null) return null;
  if (!isPgRecord(value.v)) {
    throw pgError(
      "datatype_mismatch",
      "cannot return non-composite value from function returning composite type",
      "42804",
    );
  }
  const rec = value.v;
  if (rec.values.length !== fields.length) {
    throw pgError(
      "datatype_mismatch",
      "returned row structure does not match the structure of the triggering table",
      "42804",
    );
  }
  return fields.map((f, i) => assignCast(run.env, tv(rec.types[i] ?? f.type, rec.values[i] ?? null), f.type));
}

/**
 * `DO [LANGUAGE plpgsql] $$ ... $$`: the anonymous block runs once, atomically (an error leaves none
 * of its writes), and its EXCEPTION blocks undo what their bodies wrote before a handler runs.
 */
export function executeDo(env: ExecEnv, language: string, body: string): ExecResult {
  const lang = language.toLowerCase();
  if (lang !== "plpgsql") {
    if (lang === "sql" || lang === "c" || lang === "internal") {
      throw pgError("unsupported", `language "${lang}" does not support inline code execution`, "0A000");
    }
    throw pgError("undefined_object", `language "${lang}" does not exist`, "42704");
  }
  const program = compilePlpgsql(body);
  const run = startRun(env, null, [], null);
  runRoutine(env, false, (frame) => {
    run.vars.subtransactions = !frame.inFunction;
    runBody(run, program);
  });
  // the block's own INSERT / UPDATE / DELETE are not the DO command's row count
  env.ctx.state.changes = 0;
  return commandResult("DO", 0);
}

/** Names a trigger function's body sees without declaring them. */
const TRIGGER_VARIABLES = [
  "new",
  "old",
  "tg_name",
  "tg_when",
  "tg_level",
  "tg_op",
  "tg_relid",
  "tg_relname",
  "tg_table_name",
  "tg_table_schema",
  "tg_nargs",
  "tg_argv",
];

/**
 * Checks PostgreSQL makes when it compiles a routine's body: an `ALIAS FOR` must name a variable
 * (or `$n` parameter) in scope, and a procedure's RETURN takes no value.
 */
export function checkRoutineBody(
  program: PlProgram,
  routine: { procedure: boolean; params: Array<string | null>; trigger: boolean },
): void {
  const scopes: Array<Set<string>> = [
    new Set([
      "found",
      ...routine.params.filter((p): p is string => p !== null),
      ...routine.params.map((_, i) => `$${i + 1}`),
      ...(routine.trigger ? TRIGGER_VARIABLES : []),
    ]),
  ];
  const known = (name: string) => scopes.some((scope) => scope.has(name));
  const visit = (stmts: PlStmt[]): void => {
    for (const stmt of stmts) {
      if (stmt.kind === "return" && stmt.expr !== null && routine.procedure) {
        throw pgError("syntax", "RETURN cannot have a parameter in a procedure", "42601");
      }
      if (stmt.kind === "block") {
        const scope = new Set<string>();
        scopes.push(scope);
        for (const d of stmt.decls) {
          if (d.type.kind === "alias" && !known(d.type.target) && !scope.has(d.type.target)) {
            throw pgError("undefined_object", `variable "${d.type.target}" does not exist`, "42704");
          }
          scope.add(d.name);
        }
        visit(stmt.body);
        for (const h of stmt.handlers ?? []) visit(h.body);
        scopes.pop();
        continue;
      }
      // loop variables are in scope in the loop body
      const loopScope = new Set<string>();
      if (stmt.kind === "for_int") loopScope.add(stmt.variable);
      if (stmt.kind === "for_cursor") loopScope.add(stmt.variable);
      scopes.push(loopScope);
      switch (stmt.kind) {
        case "if":
          for (const b of stmt.branches) visit(b.body);
          visit(stmt.elseBody);
          break;
        case "case":
          for (const b of stmt.branches) visit(b.body);
          if (stmt.elseBody) visit(stmt.elseBody);
          break;
        case "loop":
        case "while":
        case "for_int":
        case "for_query":
        case "for_cursor":
        case "foreach":
          visit(stmt.body);
          break;
        default:
          break;
      }
      scopes.pop();
    }
  };
  visit(program.body);
}

/**
 * Run a PL/pgSQL procedure for CALL; the OUT / INOUT parameters' final values (null when it has
 * none). `subtransactions`: EXCEPTION blocks undo their writes (not when called from a function).
 */
export function callPlpgsqlProcedure(
  env: ExecEnv,
  fn: FunctionData,
  args: TypedValue[],
  subtransactions: boolean,
): Datum[] | null {
  const raw = fn.rawBody;
  if (raw === null) throw pgError("unsupported", `procedure ${fn.name} has no executable body`);
  const program = compilePlpgsql(raw);
  const run = startRun(env, fn, args, null);
  run.vars.subtransactions = subtransactions;
  // OUT parameters start NULL whatever the call passed for them
  (fn.argModes ?? []).forEach((mode, i) => {
    const name = fn.argNames[i];
    if (mode === "out" && name != null) run.vars.assign(run.env, [name], tv(fn.argTypes[i]!, null));
  });
  runBody(run, program);
  const outs = fn.outArgs ?? [];
  if (outs.length === 0) return null;
  return outs.map((c) => assignCast(run.env, run.vars.get(c.name) ?? tv(c.type, null), c.type));
}
