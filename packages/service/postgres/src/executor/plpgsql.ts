import type { Expr, SelectStmt, Statement, TypeName } from "../ast/nodes.ts";
import { isPostgresError, pgError, unsupported } from "../errors/error.ts";
import { tokenize } from "../lexer/tokenize.ts";
import { parse } from "../parser/index.ts";
import type { FunctionData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumEquals } from "../types/compare.ts";
import { resolveTypeName } from "../types/resolve.ts";
import type { Datum, TypedValue, TypeId } from "../types/value.ts";
import { tv } from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult, type Relation, type RelColumn, RowScope } from "./relation.ts";
import { evalPredicate, evalScalar, executeSelectStmt, runStatement } from "./select.ts";

/**
 * plpgsql-lite: DECLARE, nested BEGIN/EXCEPTION WHEN <condition>, IF, CASE,
 * assignment, RETURN / RETURN NEXT, PERFORM, FOR-IN-SELECT, RAISE, EXECUTE of
 * a dynamic command, and DDL / DML statements. Also runs anonymous DO blocks.
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
]);

const RAISE_LEVELS = new Set(["debug", "log", "info", "notice", "warning", "exception"]);

export type PlStmt =
  | { kind: "assign"; target: string[]; expr: Expr }
  | { kind: "return_new" }
  | { kind: "return_old" }
  | { kind: "return_expr"; expr: Expr }
  | { kind: "return_empty" }
  | { kind: "return_next" }
  | { kind: "if"; branches: Array<{ cond: Expr; body: PlStmt[] }>; elseBody: PlStmt[] }
  | {
      kind: "case";
      expr: Expr | null;
      branches: Array<{ cond: Expr; body: PlStmt[] }>;
      elseBody: PlStmt[];
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
  | { kind: "execute"; expr: Expr }
  | { kind: "perform"; expr: Expr }
  | { kind: "block"; body: PlStmt[]; handlers: Array<{ conditions: string[]; body: PlStmt[] }> | null }
  | { kind: "for"; targets: string[]; query: SelectStmt; body: PlStmt[] }
  | { kind: "sql"; text: string };

export interface PlDecl {
  name: string;
  typeName: TypeName;
  init: Expr | null;
}

export interface PlProgram {
  decls: PlDecl[];
  body: PlStmt[];
}

interface Tok {
  type: string;
  value: string;
  pos: number;
}

class PlParser {
  private tokens: Tok[];
  private pos = 0;
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
  private expectKw(kw: string): void {
    if (!this.atKw(kw)) throw unsupported(`plpgsql: expected "${kw.toUpperCase()}" near "${this.peek().value}"`);
    this.pos++;
  }
  private expectSemi(): void {
    const t = this.next();
    if (t.type !== "punct" || t.value !== ";") throw unsupported(`plpgsql: expected ";" near "${t.value}"`);
  }

  parseProgram(): PlProgram {
    const decls: PlDecl[] = [];
    if (this.atKw("declare")) {
      this.pos++;
      while (!this.atKw("begin") && this.peek().type !== "eof") {
        decls.push(this.parseDecl());
      }
    }
    const block = this.parseBlock();
    if (this.peek().type !== "eof") throw unsupported(`plpgsql: trailing content near "${this.peek().value}"`);
    return { decls, body: [block] };
  }

  /** Trigger bodies are a BEGIN block (no DECLARE). */
  parseTriggerBody(): PlStmt[] {
    if (this.atKw("declare")) throw unsupported("trigger body: DECLARE section");
    const block = this.parseBlock();
    if (this.peek().type !== "eof") throw unsupported(`trigger body: trailing content near "${this.peek().value}"`);
    return block.kind === "block" && block.handlers === null ? block.body : [block];
  }

  private parseDecl(): PlDecl {
    const nameTok = this.next();
    if (nameTok.type !== "ident" && nameTok.type !== "quoted_ident") {
      throw unsupported(`plpgsql DECLARE near "${nameTok.value}"`);
    }
    const name = nameTok.value;
    const typeStart = this.peek().pos;
    while (
      !(this.peek().type === "punct" && this.peek().value === ";") &&
      !(this.peek().type === "op" && (this.peek().value === ":=" || this.peek().value === "=")) &&
      this.peek().type !== "eof"
    ) {
      this.pos++;
    }
    const typeText = this.src.slice(typeStart, this.peek().pos);
    const typeName = parseTypeNameText(typeText);
    let init: Expr | null = null;
    if (this.peek().type === "op" && (this.peek().value === ":=" || this.peek().value === "=")) {
      this.pos++;
      init = this.parseExprUntilSemi();
    } else {
      this.expectSemi();
    }
    return { name, typeName, init };
  }

  private parseBlock(): Extract<PlStmt, { kind: "block" }> {
    this.expectKw("begin");
    const body = this.parseStmts(new Set(["end", "exception"]));
    let handlers: Array<{ conditions: string[]; body: PlStmt[] }> | null = null;
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
            if (name.type !== "ident") throw unsupported(`plpgsql EXCEPTION WHEN near "${name.value}"`);
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
    if (this.peek().type === "punct" && this.peek().value === ";") this.pos++;
    return { kind: "block", body, handlers };
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
    if (this.atKw("begin")) return this.parseBlock();
    if (this.atKw("return")) {
      this.pos++;
      if (this.atKw("next")) {
        this.pos++;
        this.expectSemi();
        return { kind: "return_next" };
      }
      if (this.peek().type === "punct" && this.peek().value === ";") {
        this.pos++;
        return { kind: "return_empty" };
      }
      if (
        this.peek().type === "ident" &&
        (this.peek().value === "new" || this.peek().value === "old") &&
        this.peek(1).type === "punct" &&
        this.peek(1).value === ";"
      ) {
        const what = this.peek().value === "new" ? "return_new" : "return_old";
        this.pos += 2;
        return { kind: what };
      }
      return { kind: "return_expr", expr: this.parseExprUntilSemi() };
    }
    if (this.atKw("if")) {
      this.pos++;
      const branches: Array<{ cond: Expr; body: PlStmt[] }> = [];
      let elseBody: PlStmt[] = [];
      const cond = this.parseExprUntilKw("then");
      branches.push({ cond, body: this.parseStmts(new Set(["end", "elsif", "else"])) });
      while (this.atKw("elsif")) {
        this.pos++;
        const c = this.parseExprUntilKw("then");
        branches.push({ cond: c, body: this.parseStmts(new Set(["end", "elsif", "else"])) });
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
      let elseBody: PlStmt[] = [];
      if (!this.atKw("when")) {
        expr = this.parseExprUntilKw("when");
        const cond = this.parseExprUntilKw("then");
        branches.push({ cond, body: this.parseStmts(new Set(["when", "else", "end"])) });
      }
      while (this.atKw("when")) {
        this.pos++;
        const cond = this.parseExprUntilKw("then");
        branches.push({ cond, body: this.parseStmts(new Set(["when", "else", "end"])) });
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
    if (this.atKw("null")) {
      this.pos++;
      this.expectSemi();
      return { kind: "null" };
    }
    if (this.atKw("raise")) return this.parseRaise();
    if (this.atKw("execute")) {
      this.pos++;
      const text = this.parseSqlTextUntilSemi();
      // EXECUTE ... INTO / USING bind a result or parameters; only the plain dynamic command is run
      for (const t of tokenize(text)) {
        if (t.type === "ident" && (t.value === "into" || t.value === "using")) {
          throw unsupported(`plpgsql EXECUTE ... ${t.value.toUpperCase()}`);
        }
      }
      return { kind: "execute", expr: parseSqlExpr(text) };
    }
    if (this.atKw("perform")) {
      this.pos++;
      return { kind: "perform", expr: this.parseExprUntilSemi() };
    }
    if (this.atKw("for")) {
      this.pos++;
      const targets: string[] = [];
      for (;;) {
        const t = this.next();
        if (t.type !== "ident" && t.type !== "quoted_ident") throw unsupported(`plpgsql FOR target near "${t.value}"`);
        targets.push(t.value);
        if (this.peek().type === "punct" && this.peek().value === ",") {
          this.pos++;
          continue;
        }
        break;
      }
      this.expectKw("in");
      const query = this.parseQueryUntilKw("loop");
      const body = this.parseStmts(new Set(["end"]));
      this.expectKw("end");
      this.expectKw("loop");
      this.expectSemi();
      return { kind: "for", targets, query, body };
    }
    const head = this.peek();
    const assigns = this.peek(1).type === "op" && (this.peek(1).value === ":=" || this.peek(1).value === "=");
    if (head.type === "ident" && SQL_STATEMENT_KEYWORDS.has(head.value) && !assigns) {
      return { kind: "sql", text: this.parseSqlTextUntilSemi() };
    }
    const target: string[] = [];
    const first = this.next();
    if (first.type !== "ident" && first.type !== "quoted_ident") {
      throw unsupported(`plpgsql statement near "${first.value}"`);
    }
    target.push(first.value);
    while (this.peek().type === "punct" && this.peek().value === ".") {
      this.pos++;
      const f = this.next();
      target.push(f.value);
    }
    const opTok = this.next();
    if (!(opTok.type === "op" && (opTok.value === ":=" || opTok.value === "="))) {
      throw unsupported(`plpgsql: expected assignment near "${opTok.value}"`);
    }
    return { kind: "assign", target, expr: this.parseExprUntilSemi() };
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
    } else if (first.type === "punct" && first.value === ";") {
      this.pos++;
      return { kind: "reraise" };
    }
    let format: string | null = null;
    let errcode: string | null = null;
    const args: Expr[] = [];
    const options: Array<{ name: string; expr: Expr }> = [];
    const atClauseEnd = (t: Tok): boolean =>
      t.type === "eof" || (t.type === "punct" && t.value === ";") || (t.type === "ident" && t.value === "using");
    if (this.peek().type === "string") {
      format = this.next().value;
      while (this.peek().type === "punct" && this.peek().value === ",") {
        this.pos++;
        args.push(this.parseExprUntilAny((t) => atClauseEnd(t) || (t.type === "punct" && t.value === ",")));
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
        if (name.type !== "ident") throw unsupported(`plpgsql RAISE USING near "${name.value}"`);
        const eq = this.next();
        if (!(eq.type === "op" && (eq.value === "=" || eq.value === ":="))) {
          throw pgError("syntax", `syntax error at or near "${eq.value}"`, "42601");
        }
        const bareCondition =
          name.value === "errcode" &&
          this.peek().type === "ident" &&
          (atClauseEnd(this.peek(1)) || (this.peek(1).type === "punct" && this.peek(1).value === ","));
        if (bareCondition) {
          // `ERRCODE = unique_violation` names the condition without quotes
          options.push({ name: name.value, expr: { type: "string_lit", value: this.next().value } });
        } else {
          options.push({
            name: name.value,
            expr: this.parseExprUntilAny((t) => atClauseEnd(t) || (t.type === "punct" && t.value === ",")),
          });
        }
        if (this.peek().type === "punct" && this.peek().value === ",") {
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
      if (t.type === "eof") throw unsupported("plpgsql: unterminated statement");
      if (t.type === "punct" && (t.value === "(" || t.value === "[")) depth++;
      if (t.type === "punct" && (t.value === ")" || t.value === "]")) depth--;
      if (depth === 0 && stop(t)) return parseSqlExpr(this.src.slice(start, t.pos));
      this.pos++;
    }
  }

  private parseSqlTextUntilSemi(): string {
    const start = this.peek().pos;
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw unsupported("plpgsql: unterminated statement");
      if (t.type === "punct" && t.value === "(") depth++;
      if (t.type === "punct" && t.value === ")") depth--;
      if (t.type === "punct" && t.value === ";" && depth === 0) {
        const text = this.src.slice(start, t.pos).trim();
        this.pos++;
        return text;
      }
      this.pos++;
    }
  }

  private parseExprUntilSemi(): Expr {
    const start = this.peek().pos;
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw unsupported("plpgsql: unterminated statement");
      if (t.type === "punct" && t.value === "(") depth++;
      if (t.type === "punct" && t.value === ")") depth--;
      if (t.type === "punct" && t.value === ";" && depth === 0) {
        const text = this.src.slice(start, t.pos);
        this.pos++;
        return parseSqlExpr(text);
      }
      this.pos++;
    }
  }

  private parseExprUntilKw(kw: string): Expr {
    const start = this.peek().pos;
    let depth = 0;
    let caseDepth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw unsupported(`plpgsql: expected "${kw.toUpperCase()}"`);
      if (t.type === "punct" && t.value === "(") depth++;
      if (t.type === "punct" && t.value === ")") depth--;
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

  private parseQueryUntilKw(kw: string): SelectStmt {
    const start = this.peek().pos;
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") throw unsupported(`plpgsql: expected "${kw.toUpperCase()}"`);
      if (t.type === "punct" && t.value === "(") depth++;
      if (t.type === "punct" && t.value === ")") depth--;
      if (t.type === "ident" && t.value === kw && depth === 0) {
        const text = this.src.slice(start, t.pos).trim();
        this.pos++;
        let stmts: Statement[];
        try {
          stmts = parse(text);
        } catch {
          // `FOR i IN 1..3` and cursor loops are not queries
          throw unsupported("plpgsql FOR loop over anything but a query");
        }
        const q = stmts[0];
        if (q?.type !== "select") throw unsupported(`plpgsql FOR query: expected SELECT`);
        return q;
      }
      this.pos++;
    }
  }
}

function parseSqlExpr(text: string): Expr {
  const stmts = parse(`SELECT ${text}`);
  const sel = stmts[0] as SelectStmt;
  const body = sel.body as { targets?: Array<{ expr: Expr }> };
  const target = body.targets?.[0];
  if (!target) throw unsupported(`plpgsql expression "${text}"`);
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
const triggerCache = new Map<string, PlStmt[]>();

export function compilePlpgsql(raw: string): PlProgram {
  let cached = programCache.get(raw);
  if (cached === undefined) {
    cached = new PlParser(raw).parseProgram();
    programCache.set(raw, cached);
  }
  return cached;
}

export function compileTriggerBody(raw: string): PlStmt[] {
  let cached = triggerCache.get(raw);
  if (cached === undefined) {
    cached = new PlParser(raw).parseTriggerBody();
    triggerCache.set(raw, cached);
  }
  return cached;
}

class PlReturn {
  constructor(
    readonly mode: "value" | "empty" | "next",
    readonly value: TypedValue | null,
  ) {}
}

class PlVars {
  /** Run EXCEPTION blocks as subtransactions (DO blocks); a function body keeps its writes. */
  subtransactions = false;
  /** Errors being handled, innermost last (what a bare RAISE re-raises). */
  readonly caught: unknown[] = [];
  readonly names: string[] = [];
  readonly types: TypeId[] = [];
  readonly values: Datum[] = [];
  /** The scope's columns, kept in step with the names so a scope taken earlier sees later variables. */
  private readonly columns: RelColumn[] = [];

  declare(name: string, type: TypeId, value: Datum): void {
    const i = this.names.indexOf(name);
    if (i === -1) {
      this.names.push(name);
      this.types.push(type);
      this.values.push(value);
      this.columns.push({ name, type, table: null });
    } else {
      this.types[i] = type;
      this.values[i] = value;
      this.columns[i] = { name, type, table: null };
    }
  }

  drop(name: string): void {
    const i = this.names.indexOf(name);
    if (i === -1) return;
    this.names.splice(i, 1);
    this.types.splice(i, 1);
    this.values.splice(i, 1);
    this.columns.splice(i, 1);
  }

  set(name: string, v: TypedValue, env: ExecEnv): void {
    const i = this.names.indexOf(name);
    if (i === -1) throw pgError("undefined_column", `"${name}" is not a known variable`, "42703");
    const casted = v.v === null ? tv(this.types[i]!, null) : castTo(env.ctx, v, this.types[i]!, { assignment: true });
    this.values[i] = casted.v;
  }

  get(name: string): TypedValue | undefined {
    const i = this.names.indexOf(name);
    if (i === -1) return undefined;
    return tv(this.types[i]!, this.values[i] ?? null);
  }

  scope(): RowScope {
    return new RowScope(this.columns, this.values, null);
  }
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

interface Subtransaction {
  release(): void;
  rollback(): void;
}

/** An EXCEPTION block's implicit savepoint: what its body wrote is taken back when a handler catches an error. */
function beginSubtransaction(env: ExecEnv): Subtransaction {
  const state = env.ctx.state;
  state.freezeShared();
  const snapshot = state.cloneShallow();
  const prng = state.prng.getState();
  return {
    release: () => state.thawShared(),
    rollback: () => {
      state.restoreFrom(snapshot);
      state.prng.setState(prng);
      state.thawShared();
    },
  };
}

function runStmts(
  env: ExecEnv,
  stmts: PlStmt[],
  vars: PlVars,
  emit: Datum[][] | null,
  tableNames: string[] | null,
): void {
  for (const stmt of stmts) runStmt(env, stmt, vars, emit, tableNames);
}

function runStmt(env: ExecEnv, stmt: PlStmt, vars: PlVars, emit: Datum[][] | null, tableNames: string[] | null): void {
  const scope = () => vars.scope();
  switch (stmt.kind) {
    case "assign": {
      if (stmt.target.length !== 1) throw unsupported(`plpgsql assignment to "${stmt.target.join(".")}"`);
      const v = evalScalar(env, scope(), stmt.expr);
      vars.set(stmt.target[0]!, v, env);
      return;
    }
    case "return_new":
    case "return_old":
      throw unsupported(`plpgsql RETURN ${stmt.kind === "return_new" ? "NEW" : "OLD"} in a non-trigger function`);
    case "return_expr":
      throw new PlReturn("value", evalScalar(env, scope(), stmt.expr));
    case "return_empty":
      throw new PlReturn("empty", null);
    case "return_next": {
      if (emit === null) throw pgError("syntax", "RETURN NEXT cannot be used in a non-SETOF function", "42601");
      if (tableNames) emit.push(tableNames.map((n) => vars.get(n)?.v ?? null));
      else emit.push([vars.values[0] ?? null]);
      return;
    }
    case "if": {
      for (const b of stmt.branches) {
        if (evalPredicate(env, scope(), b.cond)) {
          runStmts(env, b.body, vars, emit, tableNames);
          return;
        }
      }
      runStmts(env, stmt.elseBody, vars, emit, tableNames);
      return;
    }
    case "case": {
      if (stmt.expr === null) {
        for (const b of stmt.branches) {
          if (evalPredicate(env, scope(), b.cond)) {
            runStmts(env, b.body, vars, emit, tableNames);
            return;
          }
        }
        runStmts(env, stmt.elseBody, vars, emit, tableNames);
        return;
      }
      const head = evalScalar(env, scope(), stmt.expr);
      for (const b of stmt.branches) {
        const when = evalScalar(env, scope(), b.cond);
        if (head.v !== null && when.v !== null) {
          const rhs = when.t === head.t ? when : castTo(env.ctx, when, head.t, {});
          if (datumEquals(head.t, head.v, rhs.v)) {
            runStmts(env, b.body, vars, emit, tableNames);
            return;
          }
        }
      }
      runStmts(env, stmt.elseBody, vars, emit, tableNames);
      return;
    }
    case "null":
      return;
    case "raise":
      runRaise(env, stmt, scope());
      return;
    case "reraise": {
      const error = vars.caught.at(-1);
      if (error === undefined) {
        throw pgError("internal", "RAISE without parameters cannot be used outside an exception handler", "0Z002");
      }
      throw error;
    }
    case "execute": {
      const command = evalScalar(env, scope(), stmt.expr);
      if (command.v === null) {
        throw pgError("null_value_not_allowed", "query string argument of EXECUTE is null", "22004");
      }
      for (const dynamic of parse(castTo(env.ctx, command, "text", {}).v as string)) {
        runStatement(env, dynamic as Statement);
      }
      return;
    }
    case "perform":
      evalScalar(env, scope(), stmt.expr);
      return;
    case "block": {
      if (stmt.handlers === null) {
        runStmts(env, stmt.body, vars, emit, tableNames);
        return;
      }
      const subtransaction = vars.subtransactions ? beginSubtransaction(env) : null;
      try {
        runStmts(env, stmt.body, vars, emit, tableNames);
        subtransaction?.release();
      } catch (e) {
        if (e instanceof PlReturn) {
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
        const hadErrm = vars.names.includes("sqlerrm");
        const hadState = vars.names.includes("sqlstate");
        vars.declare("sqlerrm", "text", e instanceof Error ? e.message : String(e));
        vars.declare("sqlstate", "text", sqlState);
        vars.caught.push(e);
        try {
          runStmts(env, handler.body, vars, emit, tableNames);
        } finally {
          vars.caught.pop();
          if (!hadErrm) vars.drop("sqlerrm");
          if (!hadState) vars.drop("sqlstate");
        }
      }
      return;
    }
    case "for": {
      const forEnv: ExecEnv = {
        ctx: env.ctx,
        params: env.params,
        ctes: env.ctes,
        outer: vars.scope(),
        allowUnpopulatedMatviews: env.allowUnpopulatedMatviews,
      };
      const rel = executeSelectStmt(forEnv, stmt.query);
      for (const row of rel.rows) {
        for (let i = 0; i < stmt.targets.length; i++) {
          const colT = rel.columns[i]?.type ?? "text";
          vars.set(stmt.targets[i]!, tv(colT, row[i] ?? null), env);
        }
        runStmts(env, stmt.body, vars, emit, tableNames);
      }
      return;
    }
    case "sql": {
      const stmts = parse(stmt.text);
      if (stmts.length !== 1) throw unsupported(`plpgsql SQL statement: ${stmt.text}`);
      runStatement(env, stmts[0]! as Statement);
      return;
    }
  }
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

function initVars(env: ExecEnv, fn: FunctionData | null, bound: TypedValue[], program: PlProgram): PlVars {
  const vars = new PlVars();
  for (let i = 0; i < (fn?.argNames.length ?? 0); i++) {
    const n = fn!.argNames[i];
    if (n == null) continue;
    vars.declare(n, fn!.argTypes[i]!, bound[i]?.v ?? null);
  }
  if (fn?.returnsTable) {
    for (const c of fn.returnsTable) vars.declare(c.name, c.type, null);
  }
  const seed = (): ExecEnv => ({
    ctx: env.ctx,
    params: bound,
    ctes: new Map(),
    outer: vars.scope(),
    allowUnpopulatedMatviews: env.allowUnpopulatedMatviews,
  });
  for (const d of program.decls) {
    const id = resolveTypeName(env.ctx.state, d.typeName).column.id;
    let val: Datum = null;
    if (d.init) {
      const v = evalScalar(seed(), vars.scope(), d.init);
      val = v.v === null ? null : castTo(env.ctx, v, id, { assignment: true }).v;
    }
    vars.declare(d.name, id, val);
  }
  return vars;
}

function plpgsqlEnv(env: ExecEnv, bound: TypedValue[], vars: PlVars): ExecEnv {
  return {
    ctx: env.ctx,
    params: bound,
    ctes: new Map(),
    outer: vars.scope(),
    allowUnpopulatedMatviews: env.allowUnpopulatedMatviews,
  };
}

export function callPlpgsqlScalar(env: ExecEnv, fn: FunctionData, args: TypedValue[]): TypedValue {
  const retT = fn.returns ?? "text";
  if (fn.strict && args.some((a) => a.v === null)) return tv(retT, null);
  const raw = fn.rawBody;
  if (raw === null) throw pgError("unsupported", `function ${fn.name} has no executable body`);
  const program = compilePlpgsql(raw);
  const bound = bindArgs(env, fn, args);
  const vars = initVars(env, fn, bound, program);
  const fnEnv = plpgsqlEnv(env, bound, vars);
  try {
    runStmts(fnEnv, program.body, vars, null, null);
  } catch (e) {
    if (e instanceof PlReturn) {
      if (e.mode === "next") {
        throw pgError("feature_not_supported", `set-returning function ${fn.name} called in scalar context`, "0A000");
      }
      if (e.mode === "empty" || e.value === null || e.value.v === null) return tv(retT, null);
      return castTo(env.ctx, e.value, retT, {});
    }
    throw e;
  }
  return tv(retT, null);
}

export function callPlpgsqlSet(env: ExecEnv, fn: FunctionData, args: TypedValue[]): Relation {
  const cols = fn.returnsTable
    ? fn.returnsTable.map((c) => ({ name: c.name, type: c.type, table: null as string | null }))
    : [{ name: fn.name, type: fn.returns ?? "text", table: null as string | null }];
  if (fn.strict && args.some((a) => a.v === null)) return { columns: cols, rows: [] };
  const raw = fn.rawBody;
  if (raw === null) throw pgError("unsupported", `function ${fn.name} has no executable body`);
  const program = compilePlpgsql(raw);
  const bound = bindArgs(env, fn, args);
  const vars = initVars(env, fn, bound, program);
  const fnEnv = plpgsqlEnv(env, bound, vars);
  const emit: Datum[][] = [];
  const tableNames = fn.returnsTable?.map((c) => c.name) ?? null;
  try {
    runStmts(fnEnv, program.body, vars, emit, tableNames);
  } catch (e) {
    if (!(e instanceof PlReturn)) throw e;
  }
  if (fn.returnsTable) {
    const rows = emit.map((r) =>
      fn.returnsTable!.map((c, i) => {
        const raw = r[i] ?? null;
        if (raw === null) return null;
        const src = vars.get(c.name);
        return castTo(env.ctx, tv(src?.t ?? c.type, raw), c.type, {}).v;
      }),
    );
    return { columns: cols, rows };
  }
  return { columns: cols, rows: emit };
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
  const vars = initVars(env, null, [], program);
  vars.subtransactions = true;
  const doEnv = plpgsqlEnv(env, [], vars);
  const subtransaction = beginSubtransaction(env);
  try {
    runStmts(doEnv, program.body, vars, null, null);
  } catch (e) {
    if (!(e instanceof PlReturn)) {
      subtransaction.rollback();
      throw e;
    }
  }
  subtransaction.release();
  // the block's own INSERT / UPDATE / DELETE are not the DO command's row count
  env.ctx.state.changes = 0;
  return commandResult("DO", 0);
}
