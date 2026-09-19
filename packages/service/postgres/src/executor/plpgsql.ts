import type { Expr, SelectStmt, Statement, TypeName } from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { tokenize } from "../lexer/tokenize.ts";
import { parse } from "../parser/index.ts";
import type { FunctionData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumEquals } from "../types/compare.ts";
import { resolveTypeName } from "../types/resolve.ts";
import type { Datum, TypedValue, TypeId } from "../types/value.ts";
import { tv } from "../types/value.ts";
import { type ExecEnv, type Relation, RowScope } from "./relation.ts";
import { evalPredicate, evalScalar, executeSelectStmt, runStatement } from "./select.ts";

/**
 * plpgsql-lite: DECLARE, nested BEGIN/EXCEPTION WHEN others, IF, CASE,
 * assignment, RETURN / RETURN NEXT, PERFORM, FOR-IN-SELECT.
 */

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
  | { kind: "raise"; message: string }
  | { kind: "perform"; expr: Expr }
  | { kind: "block"; body: PlStmt[]; handler: PlStmt[] | null }
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
    return block.kind === "block" && block.handler === null ? block.body : [block];
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
    let handler: PlStmt[] | null = null;
    if (this.atKw("exception")) {
      this.pos++;
      this.expectKw("when");
      if (!this.atKw("others")) throw unsupported(`plpgsql EXCEPTION WHEN ${this.peek().value}`);
      this.pos++;
      this.expectKw("then");
      handler = this.parseStmts(new Set(["end", "when"]));
      while (this.atKw("when")) {
        throw unsupported("plpgsql EXCEPTION WHEN (only OTHERS is implemented)");
      }
    }
    this.expectKw("end");
    if (this.peek().type === "punct" && this.peek().value === ";") this.pos++;
    return { kind: "block", body, handler };
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
    if (this.atKw("raise")) {
      this.pos++;
      if (this.peek().type === "ident") this.pos++;
      let message = "";
      while (!(this.peek().type === "punct" && this.peek().value === ";") && this.peek().type !== "eof") {
        const t = this.next();
        if (t.type === "string" && message === "") message = t.value;
      }
      this.expectSemi();
      return { kind: "raise", message: message || "raised exception" };
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
    if (this.atKw("update") || this.atKw("insert") || this.atKw("delete")) {
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
        const stmts = parse(text);
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
  readonly names: string[] = [];
  readonly types: TypeId[] = [];
  readonly values: Datum[] = [];

  declare(name: string, type: TypeId, value: Datum): void {
    const i = this.names.indexOf(name);
    if (i === -1) {
      this.names.push(name);
      this.types.push(type);
      this.values.push(value);
    } else {
      this.types[i] = type;
      this.values[i] = value;
    }
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
    const cols = this.names.map((n, i) => ({ name: n, type: this.types[i]!, table: null as string | null }));
    return new RowScope(cols, this.values, null);
  }
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
      throw pgError("raise_exception", stmt.message, "P0001");
    case "perform":
      evalScalar(env, scope(), stmt.expr);
      return;
    case "block": {
      try {
        runStmts(env, stmt.body, vars, emit, tableNames);
      } catch (e) {
        if (e instanceof PlReturn) throw e;
        if (stmt.handler === null) throw e;
        runStmts(env, stmt.handler, vars, emit, tableNames);
      }
      return;
    }
    case "for": {
      const forEnv: ExecEnv = { ctx: env.ctx, params: env.params, ctes: env.ctes, outer: vars.scope() };
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

function initVars(env: ExecEnv, fn: FunctionData, bound: TypedValue[], program: PlProgram): PlVars {
  const vars = new PlVars();
  for (let i = 0; i < fn.argNames.length; i++) {
    const n = fn.argNames[i];
    if (n == null) continue;
    vars.declare(n, fn.argTypes[i]!, bound[i]?.v ?? null);
  }
  if (fn.returnsTable) {
    for (const c of fn.returnsTable) vars.declare(c.name, c.type, null);
  }
  const seed = (): ExecEnv => ({ ctx: env.ctx, params: bound, ctes: new Map(), outer: vars.scope() });
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
  return { ctx: env.ctx, params: bound, ctes: new Map(), outer: vars.scope() };
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
