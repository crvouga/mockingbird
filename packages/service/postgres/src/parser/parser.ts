import type {
  AlterEnumStmt,
  AlterTableAction,
  AlterTableStmt,
  ColumnConstraint,
  ColumnDef,
  CommonTableExpr,
  CopyStmt,
  CreateFunctionStmt,
  CreateIndexStmt,
  CreateTriggerStmt,
  DeleteStmt,
  Expr,
  FrameBound,
  FrameSpec,
  FromItem,
  GroupItem,
  InsertStmt,
  OnConflictClause,
  OrderByItem,
  RefAction,
  SelectBody,
  SelectCore,
  SelectStmt,
  SelectTarget,
  SequenceOptions,
  SetOp,
  Statement,
  SubscriptExpr,
  TableConstraint,
  TypeName,
  UpdateSet,
  UpdateStmt,
  WindowSpec,
  WithClause,
} from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { type Token, tokenize } from "../lexer/tokenize.ts";

/** Fully reserved words: cannot be a bare identifier / alias. */
const RESERVED = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "current_catalog",
  "current_date",
  "current_role",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
]);

/** Additionally cannot start a bare FROM alias (they continue the join syntax). */
const NO_ALIAS = new Set([
  ...RESERVED,
  "cross",
  "full",
  "inner",
  "is",
  "isnull",
  "join",
  "left",
  "like",
  "ilike",
  "natural",
  "notnull",
  "outer",
  "overlaps",
  "right",
  "similar",
  "tablesample",
  "returning",
]);

const COMPARE_OPS = new Set(["<", ">", "=", "<=", ">=", "<>", "!="]);
const ADDITIVE_OPS = new Set(["+", "-"]);
const MULTIPLICATIVE_OPS = new Set(["*", "/", "%"]);

/** Known single-word type names usable in `TYPENAME 'literal'` syntax. */
const TYPE_LITERAL_NAMES = new Set([
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "interval",
  "numeric",
  "decimal",
  "boolean",
  "bool",
  "int2",
  "int4",
  "int8",
  "smallint",
  "integer",
  "int",
  "bigint",
  "real",
  "float4",
  "float8",
  "text",
  "varchar",
  "char",
  "bpchar",
  "bytea",
  "uuid",
  "json",
  "jsonb",
  "jsonpath",
  "money",
  "name",
  "oid",
  "regclass",
  "regtype",
  "tsvector",
  "tsquery",
  "double",
  "character",
  "bit",
]);

/** Second word of multi-word type names for TYPENAME 'literal' detection. */
const MULTIWORD_TYPE_SECOND = new Set(["precision", "varying", "with", "without"]);

export class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(sql: string) {
    this.tokens = tokenize(sql);
  }

  // --- token helpers -------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.tokens[this.pos]!;
    if (t.type !== "eof") this.pos++;
    return t;
  }

  private atKw(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === "ident" && t.value === word;
  }

  private eatKw(word: string): boolean {
    if (this.atKw(word)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectKw(word: string): void {
    if (!this.eatKw(word)) this.errorAt(this.peek(), `expected ${word.toUpperCase()}`);
  }

  private atPunct(p: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === "punct" && t.value === p;
  }

  private eatPunct(p: string): boolean {
    if (this.atPunct(p)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectPunct(p: string): void {
    if (!this.eatPunct(p)) this.errorAt(this.peek(), `expected "${p}"`);
  }

  private atOp(op: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === "op" && t.value === op;
  }

  private eatOp(op: string): boolean {
    if (this.atOp(op)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private errorAt(token: Token, message: string): never {
    const near = token.type === "eof" ? "end of input" : `"${token.value}"`;
    throw pgError("syntax", `syntax error at or near ${near} (${message})`);
  }

  /** identifier (unquoted non-reserved or quoted) */
  private ident(allowReserved = false): string {
    const t = this.peek();
    if (t.type === "quoted_ident") {
      this.pos++;
      return t.value;
    }
    if (t.type === "ident" && (allowReserved || !RESERVED.has(t.value))) {
      this.pos++;
      return t.value;
    }
    this.errorAt(t, "expected identifier");
  }

  private qualifiedName(): string[] {
    const parts = [this.ident()];
    while (this.atPunct(".")) {
      this.pos++;
      parts.push(this.ident(true));
    }
    return parts;
  }

  // --- entry ---------------------------------------------------------------

  parseStatements(): Statement[] {
    const out: Statement[] = [];
    while (this.peek().type !== "eof") {
      if (this.eatPunct(";")) continue;
      out.push(this.parseStatement());
      if (this.peek().type !== "eof" && !this.atPunct(";")) {
        this.errorAt(this.peek(), "expected end of statement");
      }
    }
    return out;
  }

  parseStatement(): Statement {
    const t = this.peek();
    if (t.type !== "ident" && !this.atPunct("(")) {
      this.errorAt(t, "expected statement");
    }
    if (this.atPunct("(")) return this.parseSelectStmt();
    switch (t.value) {
      case "select":
      case "values":
      case "with":
        return this.parseWithableStatement();
      case "table": {
        // TABLE name
        this.pos++;
        const name = this.qualifiedName();
        const core: SelectCore = {
          type: "select_core",
          distinct: null,
          targets: [{ expr: { type: "star" }, alias: null }],
          from: [{ type: "from_table", name, only: false, alias: null, colAliases: null }],
          where: null,
          groupBy: null,
          groupDistinct: false,
          having: null,
          windows: [],
        };
        const orderBy = this.parseOrderByClause();
        const { limit, offset, limitWithTies } = this.parseLimitOffset();
        return { type: "select", with: null, body: core, orderBy, limit, limitWithTies, offset, lockingClause: null };
      }
      case "insert":
        return this.parseInsert(null);
      case "update":
        return this.parseUpdate(null);
      case "delete":
        return this.parseDelete(null);
      case "merge":
        throw unsupported("MERGE");
      case "create":
        return this.parseCreate();
      case "alter":
        return this.parseAlter();
      case "drop":
        return this.parseDrop();
      case "truncate":
        return this.parseTruncate();
      case "refresh": {
        this.pos++;
        this.expectKw("materialized");
        this.expectKw("view");
        this.eatKw("concurrently");
        const name = this.qualifiedName();
        let withData = true;
        if (this.eatKw("with")) {
          if (this.eatKw("no")) withData = false;
          this.expectKw("data");
        }
        return { type: "refresh_materialized_view", name, withData };
      }
      case "begin":
      case "start": {
        this.pos++;
        if (t.value === "start") this.expectKw("transaction");
        else {
          this.eatKw("work") || this.eatKw("transaction");
        }
        const modes: string[] = [];
        for (;;) {
          if (this.eatKw("isolation")) {
            this.expectKw("level");
            let mode = "isolation level " + this.ident(true);
            if (this.atKw("read") || this.atKw("committed") || this.atKw("uncommitted")) {
              mode += " " + this.ident(true);
            }
            modes.push(mode);
          } else if (this.eatKw("read")) {
            if (this.eatKw("only")) modes.push("read only");
            else {
              this.expectKw("write");
              modes.push("read write");
            }
          } else if (this.eatKw("deferrable")) {
            modes.push("deferrable");
          } else if (this.atKw("not")) {
            this.pos++;
            this.expectKw("deferrable");
            modes.push("not deferrable");
          } else break;
          this.eatPunct(",");
        }
        return { type: "transaction", action: "begin", modes };
      }
      case "commit":
      case "end": {
        this.pos++;
        this.eatKw("work") || this.eatKw("transaction");
        let chain = false;
        if (this.eatKw("and")) {
          if (this.eatKw("no")) {
            this.expectKw("chain");
          } else {
            this.expectKw("chain");
            chain = true;
          }
        }
        return { type: "transaction", action: "commit", chain };
      }
      case "rollback":
      case "abort": {
        this.pos++;
        this.eatKw("work") || this.eatKw("transaction");
        if (this.eatKw("to")) {
          this.eatKw("savepoint");
          const name = this.ident();
          return { type: "transaction", action: "rollback_to", savepointName: name };
        }
        let chain = false;
        if (this.eatKw("and")) {
          if (this.eatKw("no")) {
            this.expectKw("chain");
          } else {
            this.expectKw("chain");
            chain = true;
          }
        }
        return { type: "transaction", action: "rollback", chain };
      }
      case "savepoint": {
        this.pos++;
        const name = this.ident();
        return { type: "transaction", action: "savepoint", savepointName: name };
      }
      case "release": {
        this.pos++;
        this.eatKw("savepoint");
        const name = this.ident();
        return { type: "transaction", action: "release", savepointName: name };
      }
      case "set":
        return this.parseSet();
      case "show": {
        this.pos++;
        if (this.eatKw("all")) return { type: "show", name: "all" };
        const parts = [this.ident(true)];
        while (this.atPunct(".")) {
          this.pos++;
          parts.push(this.ident(true));
        }
        // SHOW TIME ZONE
        if (parts[0] === "time" && this.atKw("zone")) {
          this.pos++;
          return { type: "show", name: "timezone" };
        }
        if (parts[0] === "transaction" && this.atKw("isolation")) {
          this.pos++;
          this.expectKw("level");
          return { type: "show", name: "transaction_isolation" };
        }
        return { type: "show", name: parts.join(".") };
      }
      case "reset": {
        this.pos++;
        if (this.eatKw("all")) return { type: "reset", name: "all" };
        if (this.atKw("time") && this.atKw("zone", 1)) {
          this.pos += 2;
          return { type: "reset", name: "timezone" };
        }
        const parts = [this.ident(true)];
        while (this.atPunct(".")) {
          this.pos++;
          parts.push(this.ident(true));
        }
        return { type: "reset", name: parts.join(".") };
      }
      case "prepare": {
        this.pos++;
        const name = this.ident();
        let argTypes: TypeName[] | null = null;
        if (this.eatPunct("(")) {
          argTypes = [];
          if (!this.atPunct(")")) {
            do {
              argTypes.push(this.parseTypeName());
            } while (this.eatPunct(","));
          }
          this.expectPunct(")");
        }
        this.expectKw("as");
        const query = this.parseStatement();
        return { type: "prepare", name, argTypes, query };
      }
      case "execute": {
        this.pos++;
        const name = this.ident();
        const params: Expr[] = [];
        if (this.eatPunct("(")) {
          if (!this.atPunct(")")) {
            do {
              params.push(this.parseExpr());
            } while (this.eatPunct(","));
          }
          this.expectPunct(")");
        }
        return { type: "execute", name, params };
      }
      case "deallocate": {
        this.pos++;
        this.eatKw("prepare");
        if (this.eatKw("all")) return { type: "deallocate", name: null };
        return { type: "deallocate", name: this.ident() };
      }
      case "explain":
        return this.parseExplain();
      case "copy":
        return this.parseCopy();
      case "comment": {
        this.pos++;
        this.expectKw("on");
        const kind = this.ident(true);
        if (kind === "column" || kind === "constraint" || kind === "trigger") {
          // COLUMN t.c / CONSTRAINT c ON t
          const objectName = this.qualifiedName();
          if (this.eatKw("on")) this.qualifiedName();
          this.expectKw("is");
          let comment: string | null = null;
          if (this.peek().type === "string") comment = this.next().value;
          else this.expectKw("null");
          return { type: "comment", objectKind: kind, objectName, comment };
        }
        // TABLE / VIEW / SCHEMA / etc.
        let extra = "";
        if (kind === "materialized") {
          this.expectKw("view");
          extra = " view";
        }
        const objectName = this.qualifiedName();
        this.expectKw("is");
        let comment: string | null = null;
        if (this.peek().type === "string") comment = this.next().value;
        else this.expectKw("null");
        return { type: "comment", objectKind: kind + extra, objectName, comment };
      }
      case "grant":
      case "revoke": {
        // parse loosely to end of statement; execution is a no-op
        const what = t.value.toUpperCase();
        this.skipToStatementEnd();
        return { type: "no_op", what };
      }
      case "vacuum":
      case "analyze":
      case "analyse":
      case "checkpoint":
      case "cluster":
      case "reindex": {
        const what = t.value.toUpperCase();
        this.skipToStatementEnd();
        return { type: "no_op", what };
      }
      case "listen":
      case "notify":
      case "unlisten":
        throw unsupported(t.value.toUpperCase());
      case "declare":
      case "fetch":
      case "move":
      case "close":
        throw unsupported("cursors");
      case "lock": {
        this.skipToStatementEnd();
        return { type: "no_op", what: "LOCK" };
      }
      case "do": {
        this.pos++;
        let language = "plpgsql";
        let body = "";
        if (this.eatKw("language")) {
          language = this.ident(true);
        }
        if (this.peek().type === "string") {
          body = this.next().value;
        }
        if (this.eatKw("language")) {
          language = this.ident(true);
        }
        return { type: "do", language, body };
      }
      case "call":
        throw unsupported("CALL");
      case "import":
        throw unsupported("IMPORT FOREIGN SCHEMA");
      case "security":
      case "discard": {
        this.skipToStatementEnd();
        return { type: "no_op", what: t.value.toUpperCase() };
      }
      default:
        this.errorAt(t, "unrecognized statement");
    }
  }

  private skipToStatementEnd(): void {
    while (this.peek().type !== "eof" && !this.atPunct(";")) this.pos++;
  }

  /** Consume tokens until the matching `)` after an opening `(` already eaten. */
  private skipBalancedCloseParen(): void {
    let depth = 1;
    while (depth > 0) {
      const t = this.peek();
      if (t.type === "eof") throw pgError("syntax", 'unterminated "(" in ALTER TABLE SET', "42601");
      if (this.eatPunct("(")) {
        depth++;
        continue;
      }
      if (this.eatPunct(")")) {
        depth--;
        continue;
      }
      this.pos++;
    }
  }

  // --- WITH-able statements --------------------------------------------------

  private parseWithableStatement(): Statement {
    if (this.atKw("with")) {
      const withClause = this.parseWithClause();
      const t = this.peek();
      if (t.type === "ident") {
        if (t.value === "insert") return this.parseInsert(withClause);
        if (t.value === "update") return this.parseUpdate(withClause);
        if (t.value === "delete") return this.parseDelete(withClause);
      }
      return this.parseSelectStmt(withClause);
    }
    const t = this.peek();
    if (t.type === "ident") {
      // data-modifying CTE bodies: WITH x AS (INSERT ... RETURNING ...)
      if (t.value === "insert") return this.parseInsert(null);
      if (t.value === "update") return this.parseUpdate(null);
      if (t.value === "delete") return this.parseDelete(null);
    }
    return this.parseSelectStmt();
  }

  private parseWithClause(): WithClause {
    this.expectKw("with");
    const recursive = this.eatKw("recursive");
    const ctes: CommonTableExpr[] = [];
    do {
      const name = this.ident();
      let columns: string[] | null = null;
      if (this.eatPunct("(")) {
        columns = [];
        do {
          columns.push(this.ident());
        } while (this.eatPunct(","));
        this.expectPunct(")");
      }
      this.expectKw("as");
      let materialized: boolean | null = null;
      if (this.eatKw("materialized")) materialized = true;
      else if (this.atKw("not") && this.atKw("materialized", 1)) {
        this.pos += 2;
        materialized = false;
      }
      this.expectPunct("(");
      const query = this.parseWithableStatement();
      this.expectPunct(")");
      if (this.atKw("search") || this.atKw("cycle")) throw unsupported("WITH ... SEARCH/CYCLE");
      ctes.push({ name, columns, query, materialized });
    } while (this.eatPunct(","));
    return { recursive, ctes };
  }

  // --- SELECT ------------------------------------------------------------------

  parseSelectStmt(withClause: WithClause | null = null): SelectStmt {
    let w = withClause;
    if (w === null && this.atKw("with")) w = this.parseWithClause();
    const body = this.parseSelectBody();
    const orderBy = this.parseOrderByClause();
    const { limit, offset, limitWithTies } = this.parseLimitOffset();
    let lockingClause: string | null = null;
    while (this.atKw("for")) {
      this.pos++;
      if (this.eatKw("update")) lockingClause = "update";
      else if (this.eatKw("share")) lockingClause = "share";
      else if (this.eatKw("no")) {
        this.expectKw("key");
        this.expectKw("update");
        lockingClause = "no key update";
      } else if (this.eatKw("key")) {
        this.expectKw("share");
        lockingClause = "key share";
      } else this.errorAt(this.peek(), "expected locking strength");
      if (this.eatKw("of")) {
        do {
          this.qualifiedName();
        } while (this.eatPunct(","));
      }
      this.eatKw("nowait");
      if (this.eatKw("skip")) this.expectKw("locked");
    }
    return { type: "select", with: w, body, orderBy, limit, limitWithTies, offset, lockingClause };
  }

  private parseSelectBody(): SelectBody {
    let left = this.parseSelectTerm();
    for (;;) {
      let op: SetOp["op"] | null = null;
      if (this.atKw("union")) op = "union";
      else if (this.atKw("except")) op = "except";
      if (op === null) break;
      this.pos++;
      const all = this.eatKw("all");
      if (!all) this.eatKw("distinct");
      const right = this.parseSelectTerm();
      left = { type: "setop", op, all, left, right };
    }
    return left;
  }

  private parseSelectTerm(): SelectBody {
    let left = this.parseSelectPrimary();
    while (this.atKw("intersect")) {
      this.pos++;
      const all = this.eatKw("all");
      if (!all) this.eatKw("distinct");
      const right = this.parseSelectPrimary();
      left = { type: "setop", op: "intersect", all, left, right };
    }
    return left;
  }

  private parseSelectPrimary(): SelectBody {
    if (this.atPunct("(")) {
      this.pos++;
      // parenthesized select possibly with own order/limit — wrap as subquery core
      const inner = this.parseSelectStmt();
      this.expectPunct(")");
      if (inner.orderBy.length === 0 && inner.limit === null && inner.offset === null && inner.with === null) {
        return inner.body;
      }
      // keep ordering: represent as SELECT * FROM (inner) sub
      const core: SelectCore = {
        type: "select_core",
        distinct: null,
        targets: [{ expr: { type: "star" }, alias: null }],
        from: [{ type: "from_subquery", query: inner, lateral: false, alias: "__paren", colAliases: null }],
        where: null,
        groupBy: null,
        groupDistinct: false,
        having: null,
        windows: [],
      };
      return core;
    }
    if (this.atKw("values")) {
      this.pos++;
      const rows: Expr[][] = [];
      do {
        this.expectPunct("(");
        const row: Expr[] = [];
        do {
          if (this.atKw("default")) {
            this.pos++;
            row.push({ type: "default_expr" });
          } else {
            row.push(this.parseExpr());
          }
        } while (this.eatPunct(","));
        this.expectPunct(")");
        rows.push(row);
      } while (this.eatPunct(","));
      return { type: "values", rows };
    }
    return this.parseSelectCore();
  }

  private parseSelectCore(): SelectCore {
    this.expectKw("select");
    let distinct: SelectCore["distinct"] = null;
    if (this.eatKw("all")) {
      // no-op
    } else if (this.eatKw("distinct")) {
      if (this.eatKw("on")) {
        this.expectPunct("(");
        const on: Expr[] = [];
        do {
          on.push(this.parseExpr());
        } while (this.eatPunct(","));
        this.expectPunct(")");
        distinct = { on };
      } else {
        distinct = { on: null };
      }
    }
    const targets: SelectTarget[] = [];
    if (!this.atKw("from") && !this.atPunct(";") && this.peek().type !== "eof" && !this.atKw("where")) {
      do {
        targets.push(this.parseSelectTarget());
      } while (this.eatPunct(","));
    }
    if (this.eatKw("into")) throw unsupported("SELECT INTO");
    const from: FromItem[] = [];
    if (this.eatKw("from")) {
      do {
        from.push(this.parseFromItem());
      } while (this.eatPunct(","));
    }
    const where = this.eatKw("where") ? this.parseExpr() : null;
    let groupBy: GroupItem[] | null = null;
    let groupDistinct = false;
    if (this.eatKw("group")) {
      this.expectKw("by");
      if (this.eatKw("distinct")) groupDistinct = true;
      else this.eatKw("all");
      groupBy = [];
      do {
        groupBy.push(this.parseGroupItem());
      } while (this.eatPunct(","));
    }
    const having = this.eatKw("having") ? this.parseExpr() : null;
    const windows: Array<{ name: string; spec: WindowSpec }> = [];
    if (this.eatKw("window")) {
      do {
        const name = this.ident();
        this.expectKw("as");
        this.expectPunct("(");
        const spec = this.parseWindowSpec();
        this.expectPunct(")");
        windows.push({ name, spec });
      } while (this.eatPunct(","));
    }
    return { type: "select_core", distinct, targets, from, where, groupBy, groupDistinct, having, windows };
  }

  private parseGroupItem(): GroupItem {
    if (this.atKw("rollup") || this.atKw("cube")) {
      const kind = this.next().value as "rollup" | "cube";
      this.expectPunct("(");
      const items: Expr[][] = [];
      do {
        if (this.atPunct("(")) {
          this.pos++;
          const grp: Expr[] = [];
          if (!this.atPunct(")")) {
            do {
              grp.push(this.parseExpr());
            } while (this.eatPunct(","));
          }
          this.expectPunct(")");
          items.push(grp);
        } else {
          items.push([this.parseExpr()]);
        }
      } while (this.eatPunct(","));
      this.expectPunct(")");
      return { kind, items };
    }
    if (this.atKw("grouping") && this.atKw("sets", 1)) {
      this.pos += 2;
      this.expectPunct("(");
      const sets: GroupItem[][] = [];
      do {
        if (this.atPunct("(") && this.atPunct(")", 1)) {
          this.pos += 2;
          sets.push([{ kind: "empty" }]);
        } else if (this.atPunct("(")) {
          this.pos++;
          const grp: GroupItem[] = [];
          do {
            grp.push(this.parseGroupItem());
          } while (this.eatPunct(","));
          this.expectPunct(")");
          sets.push(grp);
        } else {
          sets.push([this.parseGroupItem()]);
        }
      } while (this.eatPunct(","));
      this.expectPunct(")");
      return { kind: "grouping_sets", sets };
    }
    if (this.atPunct("(") && this.atPunct(")", 1)) {
      this.pos += 2;
      return { kind: "empty" };
    }
    return { kind: "expr", expr: this.parseExpr() };
  }

  private parseSelectTarget(): SelectTarget {
    if (this.atOp("*")) {
      this.pos++;
      return { expr: { type: "star" }, alias: null };
    }
    const expr = this.parseExpr();
    let alias: string | null = null;
    if (this.eatKw("as")) {
      alias = this.ident(true);
      if (this.peek(-1)!.type === "ident" && RESERVED.has(alias)) {
        // AS allows any keyword
      }
    } else {
      const t = this.peek();
      if (t.type === "quoted_ident" || (t.type === "ident" && !NO_ALIAS.has(t.value))) {
        alias = this.ident();
      }
    }
    return { expr, alias };
  }

  private parseOrderByClause(): OrderByItem[] {
    if (!this.atKw("order")) return [];
    this.pos++;
    this.expectKw("by");
    const items: OrderByItem[] = [];
    do {
      items.push(this.parseOrderByItem());
    } while (this.eatPunct(","));
    return items;
  }

  private parseOrderByItem(): OrderByItem {
    const expr = this.parseExpr();
    let dir: "asc" | "desc" | null = null;
    let using: string | undefined;
    if (this.eatKw("asc")) dir = "asc";
    else if (this.eatKw("desc")) dir = "desc";
    else if (this.eatKw("using")) {
      const t = this.next();
      using = t.value;
      dir = t.value === ">" ? "desc" : "asc";
    }
    let nulls: "first" | "last" | null = null;
    if (this.eatKw("nulls")) {
      if (this.eatKw("first")) nulls = "first";
      else {
        this.expectKw("last");
        nulls = "last";
      }
    }
    return { expr, dir, nulls, using };
  }

  private parseLimitOffset(): { limit: Expr | null; offset: Expr | null; limitWithTies: boolean } {
    let limit: Expr | null = null;
    let offset: Expr | null = null;
    let limitWithTies = false;
    for (;;) {
      if (this.eatKw("limit")) {
        if (this.eatKw("all")) limit = null;
        else limit = this.parseExpr();
        continue;
      }
      if (this.eatKw("offset")) {
        offset = this.parseExpr();
        this.eatKw("row") || this.eatKw("rows");
        continue;
      }
      if (this.atKw("fetch")) {
        this.pos++;
        if (!this.eatKw("first")) this.expectKw("next");
        if (this.atKw("row") || this.atKw("rows")) {
          limit = { type: "number_lit", raw: "1" };
        } else {
          limit = this.parseExpr();
        }
        this.eatKw("row") || this.eatKw("rows");
        if (this.eatKw("with")) {
          this.expectKw("ties");
          limitWithTies = true;
        } else {
          this.expectKw("only");
        }
        continue;
      }
      break;
    }
    return { limit, offset, limitWithTies };
  }

  // --- FROM ------------------------------------------------------------------

  private parseFromItem(): FromItem {
    let item = this.parseFromPrimary();
    for (;;) {
      const join = this.tryParseJoin(item);
      if (join === null) break;
      item = join;
    }
    return item;
  }

  private tryParseJoin(left: FromItem): FromItem | null {
    let natural = false;
    let kind: "inner" | "left" | "right" | "full" | "cross" | null = null;
    const save = this.pos;
    if (this.eatKw("natural")) natural = true;
    if (this.eatKw("cross")) {
      this.expectKw("join");
      kind = "cross";
    } else if (this.eatKw("inner")) {
      this.expectKw("join");
      kind = "inner";
    } else if (this.eatKw("left")) {
      this.eatKw("outer");
      this.expectKw("join");
      kind = "left";
    } else if (this.eatKw("right")) {
      this.eatKw("outer");
      this.expectKw("join");
      kind = "right";
    } else if (this.eatKw("full")) {
      this.eatKw("outer");
      this.expectKw("join");
      kind = "full";
    } else if (this.eatKw("join")) {
      kind = "inner";
    } else {
      this.pos = save;
      return null;
    }
    const right = this.parseFromPrimary();
    let on: Expr | null = null;
    let using: string[] | null = null;
    let usingAlias: string | null = null;
    if (kind !== "cross" && !natural) {
      if (this.eatKw("on")) {
        on = this.parseExpr();
      } else if (this.eatKw("using")) {
        this.expectPunct("(");
        using = [];
        do {
          using.push(this.ident());
        } while (this.eatPunct(","));
        this.expectPunct(")");
        if (this.eatKw("as")) usingAlias = this.ident();
      } else {
        this.errorAt(this.peek(), "expected ON or USING");
      }
    }
    return { type: "from_join", kind, left, right, on, using, usingAlias, natural };
  }

  private parseFromPrimary(): FromItem {
    const lateral = this.eatKw("lateral");
    if (this.atPunct("(")) {
      // subquery or parenthesized join
      const save = this.pos;
      this.pos++;
      if (this.atKw("select") || this.atKw("with") || this.atKw("values") || this.atPunct("(")) {
        // could be subquery — try
        try {
          const query = this.parseSelectStmt();
          this.expectPunct(")");
          const { alias, colAliases } = this.parseAliasClause();
          return { type: "from_subquery", query, lateral, alias, colAliases };
        } catch {
          this.pos = save;
        }
      } else {
        this.pos = save;
      }
      // parenthesized join
      this.expectPunct("(");
      const inner = this.parseFromItem();
      this.expectPunct(")");
      const { alias, colAliases } = this.parseAliasClause();
      if (alias !== null && inner.type !== "from_join") {
        return { ...inner, alias, colAliases } as FromItem;
      }
      return inner;
    }
    if (this.atKw("rows") && this.atKw("from", 1)) {
      this.pos += 2;
      this.expectPunct("(");
      const funcs: Expr[] = [];
      do {
        funcs.push(this.parseExpr());
      } while (this.eatPunct(","));
      this.expectPunct(")");
      const withOrdinality = this.parseWithOrdinality();
      const { alias, colAliases } = this.parseAliasClause();
      return { type: "from_func", call: funcs[0]!, lateral, withOrdinality, alias, colAliases, rowsFrom: funcs };
    }
    const only = this.eatKw("only");
    // function call in FROM?
    const save = this.pos;
    const name = this.qualifiedName();
    if (this.atPunct("(")) {
      // table function
      this.pos = save;
      const call = this.parseExpr();
      const withOrdinality = this.parseWithOrdinality();
      const { alias, colAliases } = this.parseAliasClause();
      return { type: "from_func", call, lateral, withOrdinality, alias, colAliases, rowsFrom: null };
    }
    if (this.eatOp("*")) {
      // trailing * (inheritance marker) — accept and ignore
    }
    const { alias, colAliases } = this.parseAliasClause();
    if (this.atKw("tablesample")) throw unsupported("TABLESAMPLE");
    return { type: "from_table", name, only, alias, colAliases };
  }

  private parseWithOrdinality(): boolean {
    if (this.atKw("with") && this.atKw("ordinality", 1)) {
      this.pos += 2;
      return true;
    }
    return false;
  }

  private parseAliasClause(): { alias: string | null; colAliases: string[] | null } {
    let alias: string | null = null;
    if (this.eatKw("as")) {
      alias = this.ident(true);
    } else {
      const t = this.peek();
      if (t.type === "quoted_ident" || (t.type === "ident" && !NO_ALIAS.has(t.value))) {
        alias = this.ident();
      }
    }
    let colAliases: string[] | null = null;
    if (alias !== null && this.atPunct("(")) {
      // could be column aliases t(a, b) — only idents inside
      const save = this.pos;
      this.pos++;
      const cols: string[] = [];
      let ok = true;
      for (;;) {
        const t = this.peek();
        if (t.type === "ident" && !RESERVED.has(t.value)) {
          cols.push(t.value);
          this.pos++;
        } else if (t.type === "quoted_ident") {
          cols.push(t.value);
          this.pos++;
        } else {
          ok = false;
          break;
        }
        // optional type spec for record-returning fn aliases: name type
        if (this.peek().type === "ident" && !this.atPunct(",") && !this.atPunct(")")) {
          try {
            this.parseTypeName();
          } catch {
            ok = false;
            break;
          }
        }
        if (this.eatPunct(",")) continue;
        if (this.eatPunct(")")) break;
        ok = false;
        break;
      }
      if (ok) colAliases = cols;
      else this.pos = save;
    }
    return { alias, colAliases };
  }

  // --- INSERT / UPDATE / DELETE -----------------------------------------------

  private parseInsert(withClause: WithClause | null): InsertStmt {
    this.expectKw("insert");
    this.expectKw("into");
    const table = this.qualifiedName();
    let alias: string | null = null;
    if (this.eatKw("as")) alias = this.ident();
    let columns: string[] | null = null;
    // Try to parse a column list; "(" could also start VALUES/(SELECT
    if (this.atPunct("(")) {
      const save = this.pos;
      this.pos++;
      const cols: string[] = [];
      let ok = true;
      for (;;) {
        const t = this.peek();
        if (t.type === "quoted_ident" || (t.type === "ident" && !RESERVED.has(t.value))) {
          cols.push(this.ident());
        } else {
          ok = false;
          break;
        }
        if (this.eatPunct(",")) continue;
        if (this.eatPunct(")")) break;
        ok = false;
        break;
      }
      // must be followed by VALUES/SELECT/( to be a column list
      if (
        !ok ||
        !(
          this.atKw("values") ||
          this.atKw("select") ||
          this.atKw("with") ||
          this.atPunct("(") ||
          this.atKw("default") ||
          this.atKw("overriding") ||
          this.atKw("table")
        )
      ) {
        this.pos = save;
      } else {
        columns = cols;
      }
    }
    let overriding: "system" | "user" | null = null;
    if (this.eatKw("overriding")) {
      if (this.eatKw("system")) overriding = "system";
      else {
        this.expectKw("user");
        overriding = "user";
      }
      this.expectKw("value");
    }
    let source: SelectStmt | "default_values";
    if (this.atKw("default") && this.atKw("values", 1)) {
      this.pos += 2;
      source = "default_values";
    } else {
      source = this.parseSelectStmt();
    }
    let onConflict: OnConflictClause | null = null;
    if (this.atKw("on")) {
      this.pos++;
      this.expectKw("conflict");
      let target: OnConflictClause["target"] = null;
      if (this.atPunct("(")) {
        this.pos++;
        const cols: Expr[] = [];
        do {
          cols.push(this.parseExpr());
        } while (this.eatPunct(","));
        this.expectPunct(")");
        const where = this.eatKw("where") ? this.parseExpr() : null;
        target = { columns: cols, where };
      } else if (this.eatKw("on")) {
        this.expectKw("constraint");
        target = { constraint: this.ident() };
      }
      this.expectKw("do");
      if (this.eatKw("nothing")) {
        onConflict = { target, action: "nothing" };
      } else {
        this.expectKw("update");
        this.expectKw("set");
        const sets = this.parseUpdateSets();
        const where = this.eatKw("where") ? this.parseExpr() : null;
        onConflict = { target, action: { sets, where } };
      }
    }
    const returning = this.parseReturning();
    return { type: "insert", with: withClause, table, alias, columns, overriding, source, onConflict, returning };
  }

  private parseReturning(): SelectTarget[] | null {
    if (!this.eatKw("returning")) return null;
    const targets: SelectTarget[] = [];
    do {
      targets.push(this.parseSelectTarget());
    } while (this.eatPunct(","));
    return targets;
  }

  private parseUpdateSets(): UpdateSet[] {
    const sets: UpdateSet[] = [];
    do {
      if (this.atPunct("(")) {
        // multi-column: (a, b) = ROW(...) | (a, b) = (subquery)
        this.pos++;
        const cols: UpdateSet["columns"][number][] = [];
        do {
          cols.push(this.parseSetColumn());
        } while (this.eatPunct(","));
        this.expectPunct(")");
        if (!this.eatOp("=")) this.errorAt(this.peek(), "expected =");
        if (this.atPunct("(") && (this.atKw("select", 1) || this.atKw("with", 1))) {
          this.pos++;
          const query = this.parseSelectStmt();
          this.expectPunct(")");
          sets.push({ columns: cols, value: { kind: "row_subquery", query } });
        } else if (this.eatKw("row")) {
          this.expectPunct("(");
          const items: Expr[] = [];
          do {
            if (this.atKw("default")) {
              this.pos++;
              items.push({ type: "default_expr" });
            } else {
              items.push(this.parseExpr());
            }
          } while (this.eatPunct(","));
          this.expectPunct(")");
          sets.push({ columns: cols, value: { kind: "row_values", items } });
        } else {
          this.expectPunct("(");
          const items: Expr[] = [];
          do {
            if (this.atKw("default")) {
              this.pos++;
              items.push({ type: "default_expr" });
            } else {
              items.push(this.parseExpr());
            }
          } while (this.eatPunct(","));
          this.expectPunct(")");
          sets.push({ columns: cols, value: { kind: "row_values", items } });
        }
      } else {
        const col = this.parseSetColumn();
        if (!this.eatOp("=")) this.errorAt(this.peek(), "expected =");
        let value: UpdateSet["value"];
        if (this.atKw("default")) {
          this.pos++;
          value = { type: "default_expr" };
        } else {
          value = this.parseExpr();
        }
        sets.push({ columns: [col], value });
      }
    } while (this.eatPunct(","));
    return sets;
  }

  private parseSetColumn(): UpdateSet["columns"][number] {
    const name = this.ident();
    let subscripts: SubscriptExpr["indexes"] | null = null;
    const fields: string[] = [];
    while (this.atPunct("[") || this.atPunct(".")) {
      if (this.atPunct("[")) {
        this.pos++;
        let lower: Expr | null = null;
        let upper: Expr | null = null;
        let slice = false;
        if (!this.atOp(":")) lower = this.parseExpr();
        if (this.eatOp(":")) {
          slice = true;
          if (!this.atPunct("]")) upper = this.parseExpr();
        }
        this.expectPunct("]");
        subscripts = [...(subscripts ?? []), { lower, upper, slice }] as SubscriptExpr["indexes"];
      } else {
        this.pos++;
        fields.push(this.ident(true));
      }
    }
    return { name, subscripts, fields };
  }

  private parseUpdate(withClause: WithClause | null): UpdateStmt {
    this.expectKw("update");
    const only = this.eatKw("only");
    const table = this.qualifiedName();
    let alias: string | null = null;
    if (this.eatKw("as")) alias = this.ident();
    else {
      const t = this.peek();
      if (t.type === "quoted_ident" || (t.type === "ident" && !NO_ALIAS.has(t.value) && t.value !== "set")) {
        alias = this.ident();
      }
    }
    this.expectKw("set");
    const sets = this.parseUpdateSets();
    const from: FromItem[] = [];
    if (this.eatKw("from")) {
      do {
        from.push(this.parseFromItem());
      } while (this.eatPunct(","));
    }
    let where: Expr | null = null;
    let whereCurrentOf: string | null = null;
    if (this.eatKw("where")) {
      if (this.atKw("current") && this.atKw("of", 1)) {
        this.pos += 2;
        whereCurrentOf = this.ident();
      } else {
        where = this.parseExpr();
      }
    }
    const returning = this.parseReturning();
    return { type: "update", with: withClause, table, only, alias, sets, from, where, whereCurrentOf, returning };
  }

  private parseDelete(withClause: WithClause | null): DeleteStmt {
    this.expectKw("delete");
    this.expectKw("from");
    const only = this.eatKw("only");
    const table = this.qualifiedName();
    let alias: string | null = null;
    if (this.eatKw("as")) alias = this.ident();
    else {
      const t = this.peek();
      if (t.type === "quoted_ident" || (t.type === "ident" && !NO_ALIAS.has(t.value))) {
        alias = this.ident();
      }
    }
    const using: FromItem[] = [];
    if (this.eatKw("using")) {
      do {
        using.push(this.parseFromItem());
      } while (this.eatPunct(","));
    }
    const where = this.eatKw("where") ? this.parseExpr() : null;
    const returning = this.parseReturning();
    return { type: "delete", with: withClause, table, only, alias, using, where, returning };
  }

  // --- CREATE -------------------------------------------------------------------

  private parseCreate(): Statement {
    this.expectKw("create");
    let orReplace = false;
    if (this.atKw("or") && this.atKw("replace", 1)) {
      this.pos += 2;
      orReplace = true;
    }
    let temp = false;
    if (this.eatKw("temp") || this.eatKw("temporary")) temp = true;
    if (this.eatKw("global") || this.eatKw("local")) {
      this.eatKw("temp") || this.eatKw("temporary");
      temp = true;
    }
    const unlogged = this.eatKw("unlogged");
    if (this.atKw("table")) {
      this.pos++;
      return this.parseCreateTable(temp, unlogged);
    }
    if (this.atKw("unique") || this.atKw("index")) {
      const unique = this.eatKw("unique");
      this.expectKw("index");
      return this.parseCreateIndex(unique);
    }
    if (this.atKw("materialized")) {
      this.pos++;
      this.expectKw("view");
      return this.parseCreateView(orReplace, temp, true);
    }
    if (this.atKw("view")) {
      this.pos++;
      return this.parseCreateView(orReplace, temp, false);
    }
    if (this.atKw("recursive")) throw unsupported("CREATE RECURSIVE VIEW");
    if (this.atKw("sequence")) {
      this.pos++;
      const ifNotExists = this.parseIfNotExists();
      const name = this.qualifiedName();
      const options = this.parseSequenceOptions();
      return { type: "create_sequence", name, ifNotExists, temp, options };
    }
    if (this.atKw("schema")) {
      this.pos++;
      const ifNotExists = this.parseIfNotExists();
      if (this.atKw("authorization")) throw unsupported("CREATE SCHEMA AUTHORIZATION");
      const name = this.ident();
      if (!this.atPunct(";") && this.peek().type !== "eof") throw unsupported("CREATE SCHEMA with elements");
      return { type: "create_schema", name, ifNotExists };
    }
    if (this.atKw("type")) {
      this.pos++;
      const name = this.qualifiedName();
      this.expectKw("as");
      if (this.eatKw("enum")) {
        this.expectPunct("(");
        const labels: string[] = [];
        if (!this.atPunct(")")) {
          do {
            const t = this.next();
            if (t.type !== "string") this.errorAt(t, "expected string literal");
            labels.push(t.value);
          } while (this.eatPunct(","));
        }
        this.expectPunct(")");
        return { type: "create_enum", name, labels };
      }
      throw unsupported("CREATE TYPE (non-enum)");
    }
    if (this.atKw("domain")) {
      this.pos++;
      const name = this.qualifiedName();
      this.eatKw("as");
      const baseType = this.parseTypeName();
      let notNull = false;
      let defaultExpr: Expr | null = null;
      const checks: Array<{ name: string | null; expr: Expr }> = [];
      let collate: string[] | null = null;
      for (;;) {
        let cname: string | null = null;
        if (this.eatKw("constraint")) cname = this.ident();
        if (this.eatKw("collate")) {
          collate = this.qualifiedName();
        } else if (this.atKw("not") && this.atKw("null", 1)) {
          this.pos += 2;
          notNull = true;
        } else if (this.eatKw("null")) {
          notNull = false;
        } else if (this.eatKw("default")) {
          defaultExpr = this.parseExpr();
        } else if (this.eatKw("check")) {
          this.expectPunct("(");
          checks.push({ name: cname, expr: this.parseExpr() });
          this.expectPunct(")");
        } else {
          if (cname !== null) this.errorAt(this.peek(), "expected domain constraint");
          break;
        }
      }
      return { type: "create_domain", name, baseType, notNull, defaultExpr, checks, collate };
    }
    if (this.atKw("function") || this.atKw("procedure")) {
      const isProc = this.atKw("procedure");
      this.pos++;
      if (isProc) throw unsupported("CREATE PROCEDURE");
      return this.parseCreateFunction(orReplace);
    }
    if (this.atKw("trigger") || (this.atKw("constraint") && this.atKw("trigger", 1))) {
      if (this.eatKw("constraint")) {
        // constraint triggers behave like AFTER triggers here
      }
      this.expectKw("trigger");
      return this.parseCreateTrigger(orReplace);
    }
    if (this.atKw("extension")) {
      this.pos++;
      this.parseIfNotExists();
      const name = this.ident(true);
      while (!this.atPunct(";") && this.peek().type !== "eof") this.pos++;
      throw unsupported(`extension "${name}"`);
    }
    if (this.atKw("database")) throw unsupported("CREATE DATABASE");
    if (this.atKw("role") || this.atKw("user") || this.atKw("group")) throw unsupported("roles");
    if (this.atKw("rule")) throw unsupported("CREATE RULE");
    if (this.atKw("policy")) throw unsupported("CREATE POLICY");
    if (this.atKw("collation")) throw unsupported("CREATE COLLATION");
    if (this.atKw("cast")) throw unsupported("CREATE CAST");
    if (this.atKw("operator")) throw unsupported("CREATE OPERATOR");
    if (this.atKw("aggregate")) throw unsupported("CREATE AGGREGATE");
    if (this.atKw("publication") || this.atKw("subscription")) throw unsupported("replication");
    if (this.atKw("server") || this.atKw("foreign")) throw unsupported("foreign data wrappers");
    if (this.atKw("tablespace")) throw unsupported("CREATE TABLESPACE");
    if (this.atKw("statistics")) throw unsupported("CREATE STATISTICS");
    this.errorAt(this.peek(), "unrecognized CREATE");
  }

  private parseIfNotExists(): boolean {
    if (this.atKw("if") && this.atKw("not", 1) && this.atKw("exists", 2)) {
      this.pos += 3;
      return true;
    }
    return false;
  }

  private parseIfExists(): boolean {
    if (this.atKw("if") && this.atKw("exists", 1)) {
      this.pos += 2;
      return true;
    }
    return false;
  }

  private parseCreateTable(temp: boolean, unlogged: boolean): Statement {
    const ifNotExists = this.parseIfNotExists();
    const name = this.qualifiedName();
    // CREATE TABLE AS
    if (this.atKw("as") || (this.atPunct("(") === false && this.atKw("as"))) {
      this.pos++;
      const query = this.parseSelectStmt();
      let withData = true;
      if (this.eatKw("with")) {
        if (this.eatKw("no")) withData = false;
        this.expectKw("data");
      }
      return { type: "create_table_as", name, ifNotExists, temp, columns: null, query, withData, materialized: false };
    }
    let ctasColumns: string[] | null = null;
    if (this.atPunct("(")) {
      // could be column defs or CTAS column list — look ahead for ") AS"
      const save = this.pos;
      this.pos++;
      const cols: string[] = [];
      let simpleList = true;
      for (;;) {
        const t = this.peek();
        if (t.type === "quoted_ident" || (t.type === "ident" && !RESERVED.has(t.value))) {
          cols.push(this.ident());
        } else {
          simpleList = false;
          break;
        }
        if (this.eatPunct(",")) continue;
        if (this.eatPunct(")")) break;
        simpleList = false;
        break;
      }
      if (simpleList && this.atKw("as")) {
        ctasColumns = cols;
        this.pos++;
        const query = this.parseSelectStmt();
        let withData = true;
        if (this.eatKw("with")) {
          if (this.eatKw("no")) withData = false;
          this.expectKw("data");
        }
        return {
          type: "create_table_as",
          name,
          ifNotExists,
          temp,
          columns: ctasColumns,
          query,
          withData,
          materialized: false,
        };
      }
      this.pos = save;
    }
    this.expectPunct("(");
    const columns: ColumnDef[] = [];
    const constraints: TableConstraint[] = [];
    const likeClauses: Array<{ table: string[]; options: string[] }> = [];
    if (!this.atPunct(")")) {
      do {
        if (this.atKw("like")) {
          this.pos++;
          const likeTable = this.qualifiedName();
          const options: string[] = [];
          while (this.atKw("including") || this.atKw("excluding")) {
            const mode = this.next().value;
            const what = this.ident(true);
            options.push(`${mode} ${what}`);
          }
          likeClauses.push({ table: likeTable, options });
          continue;
        }
        const tc = this.tryParseTableConstraint();
        if (tc) {
          constraints.push(tc);
          continue;
        }
        columns.push(this.parseColumnDef());
      } while (this.eatPunct(","));
    }
    this.expectPunct(")");
    // storage/partition options
    if (this.eatKw("inherits")) throw unsupported("table inheritance");
    if (this.eatKw("partition")) throw unsupported("table partitioning");
    if (this.eatKw("using")) this.ident(true);
    if (this.eatKw("with")) {
      this.expectPunct("(");
      let depth = 1;
      while (depth > 0 && this.peek().type !== "eof") {
        if (this.atPunct("(")) depth++;
        if (this.atPunct(")")) depth--;
        this.pos++;
      }
    }
    if (this.eatKw("on")) {
      this.expectKw("commit");
      this.ident(true); // preserve / delete / drop → rows behavior: accept, treat as preserve
      if (this.peek(-1)!.value === "delete") this.expectKw("rows");
    }
    if (this.eatKw("tablespace")) this.ident(true);
    return { type: "create_table", name, ifNotExists, temp, unlogged, columns, constraints, likeClauses };
  }

  private tryParseTableConstraint(): TableConstraint | null {
    let name: string | null = null;
    const save = this.pos;
    if (this.eatKw("constraint")) name = this.ident();
    if (this.atKw("primary") && this.atKw("key", 1)) {
      this.pos += 2;
      this.expectPunct("(");
      const columns: string[] = [];
      do {
        columns.push(this.ident());
      } while (this.eatPunct(","));
      this.expectPunct(")");
      this.skipConstraintTail();
      return { kind: "primary_key", name, columns };
    }
    if (this.atKw("unique") && (this.atPunct("(", 1) || this.atKw("nulls", 1))) {
      this.pos++;
      let nullsNotDistinct = false;
      if (this.eatKw("nulls")) {
        this.expectKw("not");
        this.expectKw("distinct");
        nullsNotDistinct = true;
      }
      this.expectPunct("(");
      const columns: string[] = [];
      do {
        columns.push(this.ident());
      } while (this.eatPunct(","));
      this.expectPunct(")");
      this.skipConstraintTail();
      return { kind: "unique", name, columns, nullsNotDistinct };
    }
    if (this.atKw("check") && this.atPunct("(", 1)) {
      this.pos++;
      this.expectPunct("(");
      const expr = this.parseExpr();
      this.expectPunct(")");
      let noInherit = false;
      if (this.atKw("no") && this.atKw("inherit", 1)) {
        this.pos += 2;
        noInherit = true;
      }
      this.skipConstraintTail();
      return { kind: "check", name, expr, noInherit };
    }
    if (this.atKw("foreign") && this.atKw("key", 1)) {
      this.pos += 2;
      this.expectPunct("(");
      const columns: string[] = [];
      do {
        columns.push(this.ident());
      } while (this.eatPunct(","));
      this.expectPunct(")");
      this.expectKw("references");
      const refTable = this.qualifiedName();
      let refColumns: string[] | null = null;
      if (this.eatPunct("(")) {
        refColumns = [];
        do {
          refColumns.push(this.ident());
        } while (this.eatPunct(","));
        this.expectPunct(")");
      }
      const { onDelete, onUpdate, match } = this.parseRefActions();
      this.skipConstraintTail();
      return { kind: "foreign_key", name, columns, refTable, refColumns, onDelete, onUpdate, match };
    }
    if (this.atKw("exclude")) throw unsupported("EXCLUDE constraints");
    this.pos = save;
    return null;
  }

  private skipConstraintTail(): void {
    for (;;) {
      if (this.eatKw("deferrable")) continue;
      if (this.atKw("not") && this.atKw("deferrable", 1)) {
        this.pos += 2;
        continue;
      }
      if (this.eatKw("initially")) {
        if (!this.eatKw("deferred")) this.expectKw("immediate");
        continue;
      }
      if (this.eatKw("using")) {
        this.expectKw("index");
        this.expectKw("tablespace");
        this.ident(true);
        continue;
      }
      break;
    }
  }

  private parseRefActions(): { onDelete: RefAction; onUpdate: RefAction; match: "full" | "partial" | "simple" | null } {
    let onDelete: RefAction = null;
    let onUpdate: RefAction = null;
    let match: "full" | "partial" | "simple" | null = null;
    for (;;) {
      if (this.eatKw("match")) {
        const m = this.ident(true);
        if (m !== "full" && m !== "partial" && m !== "simple") this.errorAt(this.peek(), "bad MATCH type");
        if (m === "partial") throw unsupported("MATCH PARTIAL");
        match = m;
        continue;
      }
      if (this.atKw("on") && this.atKw("delete", 1)) {
        this.pos += 2;
        onDelete = this.parseRefAction();
        continue;
      }
      if (this.atKw("on") && this.atKw("update", 1)) {
        this.pos += 2;
        onUpdate = this.parseRefAction();
        continue;
      }
      break;
    }
    return { onDelete, onUpdate, match };
  }

  private parseRefAction(): RefAction {
    if (this.eatKw("cascade")) return "cascade";
    if (this.eatKw("restrict")) return "restrict";
    if (this.atKw("no") && this.atKw("action", 1)) {
      this.pos += 2;
      return "no_action";
    }
    if (this.atKw("set") && this.atKw("null", 1)) {
      this.pos += 2;
      return "set_null";
    }
    if (this.atKw("set") && this.atKw("default", 1)) {
      this.pos += 2;
      return "set_default";
    }
    this.errorAt(this.peek(), "expected referential action");
  }

  private parseColumnDef(): ColumnDef {
    const name = this.ident();
    const typeName = this.parseTypeName();
    const constraints: ColumnConstraint[] = [];
    for (;;) {
      let cname: string | null = null;
      if (this.eatKw("constraint")) cname = this.ident();
      if (this.atKw("not") && this.atKw("null", 1)) {
        this.pos += 2;
        constraints.push({ kind: "not_null", name: cname });
        continue;
      }
      if (this.eatKw("null")) {
        constraints.push({ kind: "null", name: cname });
        continue;
      }
      if (this.eatKw("default")) {
        constraints.push({ kind: "default", expr: this.parseExpr(), name: cname });
        continue;
      }
      if (this.atKw("primary") && this.atKw("key", 1)) {
        this.pos += 2;
        this.skipConstraintTail();
        constraints.push({ kind: "primary_key", name: cname });
        continue;
      }
      if (this.eatKw("unique")) {
        let nullsNotDistinct = false;
        if (this.eatKw("nulls")) {
          this.expectKw("not");
          this.expectKw("distinct");
          nullsNotDistinct = true;
        }
        this.skipConstraintTail();
        constraints.push({ kind: "unique", name: cname, nullsNotDistinct });
        continue;
      }
      if (this.eatKw("check")) {
        this.expectPunct("(");
        const expr = this.parseExpr();
        this.expectPunct(")");
        let noInherit = false;
        if (this.atKw("no") && this.atKw("inherit", 1)) {
          this.pos += 2;
          noInherit = true;
        }
        constraints.push({ kind: "check", expr, name: cname, noInherit });
        continue;
      }
      if (this.eatKw("references")) {
        const table = this.qualifiedName();
        let columns: string[] | null = null;
        if (this.eatPunct("(")) {
          columns = [];
          do {
            columns.push(this.ident());
          } while (this.eatPunct(","));
          this.expectPunct(")");
        }
        const { onDelete, onUpdate, match } = this.parseRefActions();
        this.skipConstraintTail();
        constraints.push({ kind: "references", name: cname, table, columns, onDelete, onUpdate, match });
        continue;
      }
      if (this.eatKw("generated")) {
        if (this.eatKw("always")) {
          this.expectKw("as");
          if (this.eatKw("identity")) {
            const options = this.parseIdentityOptions();
            constraints.push({ kind: "generated_identity", always: true, name: cname, options });
          } else {
            this.expectPunct("(");
            const expr = this.parseExpr();
            this.expectPunct(")");
            this.expectKw("stored");
            constraints.push({ kind: "generated_stored", expr, name: cname });
          }
        } else {
          this.expectKw("by");
          this.expectKw("default");
          this.expectKw("as");
          this.expectKw("identity");
          const options = this.parseIdentityOptions();
          constraints.push({ kind: "generated_identity", always: false, name: cname, options });
        }
        continue;
      }
      if (this.eatKw("collate")) {
        constraints.push({ kind: "collate", collation: this.qualifiedName() });
        continue;
      }
      if (
        this.eatKw("deferrable") ||
        (this.atKw("initially") && (this.atKw("deferred", 1) || this.atKw("immediate", 1)))
      ) {
        this.skipConstraintTail();
        continue;
      }
      if (this.eatKw("storage")) {
        this.ident(true);
        continue;
      }
      if (this.eatKw("compression")) {
        this.ident(true);
        continue;
      }
      if (cname !== null) this.errorAt(this.peek(), "expected column constraint");
      break;
    }
    return { name, typeName, constraints };
  }

  private parseIdentityOptions(): SequenceOptions {
    const options: SequenceOptions = {};
    if (this.eatPunct("(")) {
      Object.assign(options, this.parseSequenceOptions());
      this.expectPunct(")");
    }
    return options;
  }

  private parseSequenceOptions(): SequenceOptions {
    const options: SequenceOptions = {};
    for (;;) {
      if (this.eatKw("increment")) {
        this.eatKw("by");
        options.increment = this.parseSignedBigInt();
        continue;
      }
      if (this.eatKw("minvalue")) {
        options.minValue = this.parseSignedBigInt();
        continue;
      }
      if (this.eatKw("maxvalue")) {
        options.maxValue = this.parseSignedBigInt();
        continue;
      }
      if (this.atKw("no")) {
        if (this.atKw("minvalue", 1)) {
          this.pos += 2;
          options.minValue = "no";
          continue;
        }
        if (this.atKw("maxvalue", 1)) {
          this.pos += 2;
          options.maxValue = "no";
          continue;
        }
        if (this.atKw("cycle", 1)) {
          this.pos += 2;
          options.cycle = false;
          continue;
        }
        break;
      }
      if (this.eatKw("start")) {
        this.eatKw("with");
        options.start = this.parseSignedBigInt();
        continue;
      }
      if (this.eatKw("restart")) {
        if (this.eatKw("with")) options.restart = this.parseSignedBigInt();
        else if (this.peek().type === "number" || this.atOp("-")) options.restart = this.parseSignedBigInt();
        else options.restart = "default";
        continue;
      }
      if (this.eatKw("cache")) {
        options.cache = this.parseSignedBigInt();
        continue;
      }
      if (this.eatKw("cycle")) {
        options.cycle = true;
        continue;
      }
      if (this.eatKw("owned")) {
        this.expectKw("by");
        if (this.eatKw("none")) options.ownedBy = "none";
        else options.ownedBy = this.qualifiedName();
        continue;
      }
      if (this.eatKw("as")) {
        options.as = this.parseTypeName();
        continue;
      }
      break;
    }
    return options;
  }

  private parseSignedBigInt(): bigint {
    let neg = false;
    if (this.eatOp("-")) neg = true;
    else this.eatOp("+");
    const t = this.next();
    if (t.type !== "number") this.errorAt(t, "expected number");
    const v = BigInt(t.value);
    return neg ? -v : v;
  }

  private parseCreateIndex(unique: boolean): CreateIndexStmt {
    const concurrently = this.eatKw("concurrently");
    let name: string | null = null;
    let ifNotExists = false;
    if (!this.atKw("on")) {
      ifNotExists = this.parseIfNotExists();
      if (!this.atKw("on")) name = this.ident();
    }
    this.expectKw("on");
    this.eatKw("only");
    const table = this.qualifiedName();
    let using: string | null = null;
    if (this.eatKw("using")) using = this.ident(true);
    this.expectPunct("(");
    const columns: CreateIndexStmt["columns"][number][] = [];
    do {
      const expr = this.parseExpr();
      let opclass: string | null = null;
      const t = this.peek();
      if (
        t.type === "ident" &&
        !RESERVED.has(t.value) &&
        !["asc", "desc", "nulls", "with", "where", "include"].includes(t.value)
      ) {
        opclass = this.ident();
      }
      let dir: "asc" | "desc" | null = null;
      if (this.eatKw("asc")) dir = "asc";
      else if (this.eatKw("desc")) dir = "desc";
      let nulls: "first" | "last" | null = null;
      if (this.eatKw("nulls")) {
        if (this.eatKw("first")) nulls = "first";
        else {
          this.expectKw("last");
          nulls = "last";
        }
      }
      columns.push({ expr, dir, nulls, opclass });
    } while (this.eatPunct(","));
    this.expectPunct(")");
    const include: string[] = [];
    if (this.eatKw("include")) {
      this.expectPunct("(");
      do {
        include.push(this.ident());
      } while (this.eatPunct(","));
      this.expectPunct(")");
    }
    let nullsNotDistinct = false;
    if (this.eatKw("nulls")) {
      this.expectKw("not");
      this.expectKw("distinct");
      nullsNotDistinct = true;
    }
    if (this.eatKw("with")) {
      this.expectPunct("(");
      let depth = 1;
      while (depth > 0 && this.peek().type !== "eof") {
        if (this.atPunct("(")) depth++;
        if (this.atPunct(")")) depth--;
        this.pos++;
      }
    }
    if (this.eatKw("tablespace")) this.ident(true);
    const where = this.eatKw("where") ? this.parseExpr() : null;
    return {
      type: "create_index",
      unique,
      name,
      ifNotExists,
      table,
      using,
      columns,
      include,
      where,
      nullsNotDistinct,
      concurrently,
    };
  }

  private parseCreateView(orReplace: boolean, temp: boolean, materialized: boolean): Statement {
    const ifNotExists = materialized ? this.parseIfNotExists() : false;
    void ifNotExists;
    const name = this.qualifiedName();
    let columns: string[] | null = null;
    if (this.eatPunct("(")) {
      columns = [];
      do {
        columns.push(this.ident());
      } while (this.eatPunct(","));
      this.expectPunct(")");
    }
    if (this.eatKw("with")) {
      this.expectPunct("(");
      let depth = 1;
      while (depth > 0 && this.peek().type !== "eof") {
        if (this.atPunct("(")) depth++;
        if (this.atPunct(")")) depth--;
        this.pos++;
      }
    }
    if (this.eatKw("using")) this.ident(true);
    if (this.eatKw("tablespace")) this.ident(true);
    this.expectKw("as");
    const query = this.parseSelectStmt();
    let withData = true;
    if (this.eatKw("with")) {
      if (this.eatKw("no")) {
        withData = false;
        this.expectKw("data");
      } else if (this.eatKw("data")) {
        withData = true;
      } else {
        // WITH CHECK OPTION
        this.eatKw("cascaded") || this.eatKw("local");
        this.expectKw("check");
        this.expectKw("option");
      }
    }
    return { type: "create_view", name, orReplace, temp, columns, query, materialized, withData };
  }

  private parseCreateFunction(orReplace: boolean): CreateFunctionStmt {
    const name = this.qualifiedName();
    this.expectPunct("(");
    const args: CreateFunctionStmt["args"][number][] = [];
    if (!this.atPunct(")")) {
      do {
        let mode: "in" | "out" | "inout" | "variadic" = "in";
        if (this.eatKw("in")) mode = "in";
        else if (this.eatKw("out")) mode = "out";
        else if (this.eatKw("inout")) mode = "inout";
        else if (this.eatKw("variadic")) mode = "variadic";
        // optional arg name then type
        let argName: string | null = null;
        const save = this.pos;
        const t = this.peek();
        if ((t.type === "ident" && !RESERVED.has(t.value)) || t.type === "quoted_ident") {
          const candidate = this.ident();
          // if next token starts a type, candidate was the name
          const nt = this.peek();
          if (nt.type === "ident" || nt.type === "quoted_ident") {
            argName = candidate;
          } else {
            this.pos = save;
          }
        }
        const typeName = this.parseTypeName();
        let defaultExpr: Expr | null = null;
        if (this.eatKw("default") || this.eatOp("=")) {
          defaultExpr = this.parseExpr();
        }
        args.push({ name: argName, typeName, mode, defaultExpr });
      } while (this.eatPunct(","));
    }
    this.expectPunct(")");
    let returns: TypeName | null = null;
    let returnsTable: CreateFunctionStmt["returnsTable"] = null;
    if (this.eatKw("returns")) {
      if (this.eatKw("table")) {
        this.expectPunct("(");
        const cols: Array<{ name: string; typeName: TypeName }> = [];
        do {
          const cn = this.ident();
          const ct = this.parseTypeName();
          cols.push({ name: cn, typeName: ct });
        } while (this.eatPunct(","));
        this.expectPunct(")");
        returnsTable = cols;
      } else {
        returns = this.parseTypeName();
      }
    }
    let language = "sql";
    let body: string | null = null;
    let sqlBody: Statement[] | null = null;
    let volatility: "immutable" | "stable" | "volatile" | null = null;
    let strict = false;
    for (;;) {
      if (this.eatKw("language")) {
        language = this.peek().type === "string" ? this.next().value : this.ident(true);
        continue;
      }
      if (this.eatKw("as")) {
        const t = this.next();
        if (t.type !== "string") this.errorAt(t, "expected function body string");
        body = t.value;
        if (this.eatPunct(",")) {
          // C-style AS 'obj', 'link' — unsupported
          throw unsupported("C functions");
        }
        continue;
      }
      if (this.eatKw("immutable")) {
        volatility = "immutable";
        continue;
      }
      if (this.eatKw("stable")) {
        volatility = "stable";
        continue;
      }
      if (this.eatKw("volatile")) {
        volatility = "volatile";
        continue;
      }
      if (this.eatKw("strict")) {
        strict = true;
        continue;
      }
      if (this.eatKw("called")) {
        this.expectKw("on");
        this.expectKw("null");
        this.expectKw("input");
        continue;
      }
      if (this.eatKw("returns")) {
        this.expectKw("null");
        this.expectKw("on");
        this.expectKw("null");
        this.expectKw("input");
        strict = true;
        continue;
      }
      if (this.eatKw("parallel")) {
        this.ident(true);
        continue;
      }
      if (this.eatKw("cost") || this.eatKw("rows")) {
        this.next();
        continue;
      }
      if (this.eatKw("security")) {
        this.ident(true);
        continue;
      }
      if (this.eatKw("set")) {
        // SET config = value
        this.ident(true);
        if (this.eatOp("=") || this.eatKw("to")) this.next();
        continue;
      }
      if (this.eatKw("window")) throw unsupported("window functions via CREATE FUNCTION");
      if (this.eatKw("return")) {
        // SQL-standard body: RETURN expr
        const expr = this.parseExpr();
        const core: SelectCore = {
          type: "select_core",
          distinct: null,
          targets: [{ expr, alias: null }],
          from: [],
          where: null,
          groupBy: null,
          groupDistinct: false,
          having: null,
          windows: [],
        };
        sqlBody = [
          {
            type: "select",
            with: null,
            body: core,
            orderBy: [],
            limit: null,
            limitWithTies: false,
            offset: null,
            lockingClause: null,
          },
        ];
        continue;
      }
      if (this.eatKw("begin")) {
        this.expectKw("atomic");
        const stmts: Statement[] = [];
        while (!this.atKw("end")) {
          if (this.eatPunct(";")) continue;
          if (this.eatKw("return")) {
            const expr = this.parseExpr();
            const core: SelectCore = {
              type: "select_core",
              distinct: null,
              targets: [{ expr, alias: null }],
              from: [],
              where: null,
              groupBy: null,
              groupDistinct: false,
              having: null,
              windows: [],
            };
            stmts.push({
              type: "select",
              with: null,
              body: core,
              orderBy: [],
              limit: null,
              limitWithTies: false,
              offset: null,
              lockingClause: null,
            });
          } else {
            stmts.push(this.parseStatement());
          }
        }
        this.expectKw("end");
        sqlBody = stmts;
        continue;
      }
      break;
    }
    return {
      type: "create_function",
      orReplace,
      name,
      args,
      returns,
      returnsTable,
      language,
      body,
      sqlBody,
      volatility,
      strict,
    };
  }

  private parseCreateTrigger(orReplace: boolean): CreateTriggerStmt {
    const name = this.ident();
    let timing: "before" | "after" | "instead_of";
    if (this.eatKw("before")) timing = "before";
    else if (this.eatKw("after")) timing = "after";
    else {
      this.expectKw("instead");
      this.expectKw("of");
      timing = "instead_of";
    }
    const events: CreateTriggerStmt["events"][number][] = [];
    do {
      if (this.eatKw("insert")) events.push({ event: "insert", columns: null });
      else if (this.eatKw("delete")) events.push({ event: "delete", columns: null });
      else if (this.eatKw("truncate")) events.push({ event: "truncate", columns: null });
      else {
        this.expectKw("update");
        let columns: string[] | null = null;
        if (this.eatKw("of")) {
          columns = [];
          do {
            columns.push(this.ident());
          } while (this.eatPunct(","));
        }
        events.push({ event: "update", columns });
      }
    } while (this.eatKw("or"));
    this.expectKw("on");
    const table = this.qualifiedName();
    // referencing / deferrable clauses
    if (this.eatKw("referencing")) throw unsupported("trigger transition tables");
    while (this.atKw("not") || this.atKw("deferrable") || this.atKw("initially")) {
      this.pos++;
    }
    let forEachRow = false;
    if (this.eatKw("for")) {
      this.eatKw("each");
      if (this.eatKw("row")) forEachRow = true;
      else this.expectKw("statement");
    }
    let when: Expr | null = null;
    if (this.eatKw("when")) {
      this.expectPunct("(");
      when = this.parseExpr();
      this.expectPunct(")");
    }
    this.expectKw("execute");
    if (!this.eatKw("function")) this.expectKw("procedure");
    const funcName = this.qualifiedName();
    this.expectPunct("(");
    const funcArgs: string[] = [];
    if (!this.atPunct(")")) {
      do {
        const t = this.next();
        funcArgs.push(t.value);
      } while (this.eatPunct(","));
    }
    this.expectPunct(")");
    return { type: "create_trigger", orReplace, name, timing, events, table, forEachRow, when, funcName, funcArgs };
  }

  // --- ALTER --------------------------------------------------------------------

  private parseAlter(): Statement {
    this.expectKw("alter");
    if (this.eatKw("table")) {
      const ifExists = this.parseIfExists();
      const only = this.eatKw("only");
      const table = this.qualifiedName();
      const actions: AlterTableAction[] = [];
      do {
        actions.push(this.parseAlterTableAction());
      } while (this.eatPunct(","));
      return { type: "alter_table", table, ifExists, only, actions } satisfies AlterTableStmt;
    }
    if (this.eatKw("sequence")) {
      const ifExists = this.parseIfExists();
      const name = this.qualifiedName();
      if (this.atKw("rename")) {
        this.pos++;
        this.expectKw("to");
        const to = this.ident();
        return {
          type: "alter_sequence",
          name,
          ifExists,
          options: { ownedBy: undefined } as SequenceOptions & { renameTo?: string },
          ...({ renameTo: to } as any),
        } as any;
      }
      const options = this.parseSequenceOptions();
      return { type: "alter_sequence", name, ifExists, options };
    }
    let isMatView = false;
    if (!this.atKw("view") && this.atKw("materialized") && this.atKw("view", 1)) {
      this.pos += 2;
      isMatView = true;
    }
    if (isMatView || this.eatKw("view")) {
      const ifExists = this.parseIfExists();
      const name = this.qualifiedName();
      if (this.eatKw("rename")) {
        this.expectKw("to");
        return { type: "alter_view", name, ifExists, action: { kind: "rename_table", to: this.ident() } };
      }
      if (this.eatKw("set")) {
        this.expectKw("schema");
        return { type: "alter_view", name, ifExists, action: { kind: "set_schema", to: this.ident() } };
      }
      if (this.eatKw("owner")) {
        this.expectKw("to");
        this.ident(true);
        return { type: "no_op", what: "ALTER VIEW OWNER" };
      }
      throw unsupported("this ALTER VIEW form");
    }
    if (this.eatKw("index")) {
      const ifExists = this.parseIfExists();
      const name = this.qualifiedName();
      if (this.eatKw("rename")) {
        this.expectKw("to");
        return { type: "alter_index", name, ifExists, action: { kind: "rename_table", to: this.ident() } };
      }
      throw unsupported("this ALTER INDEX form");
    }
    if (this.eatKw("schema")) {
      const name = this.ident();
      if (this.eatKw("rename")) {
        this.expectKw("to");
        return { type: "alter_schema", name, action: { kind: "rename", to: this.ident() } };
      }
      throw unsupported("this ALTER SCHEMA form");
    }
    if (this.eatKw("type")) {
      const name = this.qualifiedName();
      if (this.eatKw("add")) {
        this.expectKw("value");
        const ifNotExists = this.parseIfNotExists();
        const t = this.next();
        if (t.type !== "string") this.errorAt(t, "expected string");
        let before: string | null = null;
        let after: string | null = null;
        if (this.eatKw("before")) {
          const b = this.next();
          before = b.value;
        } else if (this.eatKw("after")) {
          const a = this.next();
          after = a.value;
        }
        return {
          type: "alter_enum",
          name,
          action: { kind: "add_value", label: t.value, ifNotExists, before, after },
        } satisfies AlterEnumStmt;
      }
      if (this.eatKw("rename")) {
        this.expectKw("value");
        const from = this.next();
        this.expectKw("to");
        const to = this.next();
        return { type: "alter_enum", name, action: { kind: "rename_value", from: from.value, to: to.value } };
      }
      throw unsupported("this ALTER TYPE form");
    }
    if (this.eatKw("function")) {
      this.skipToStatementEnd();
      return { type: "no_op", what: "ALTER FUNCTION" };
    }
    if (
      this.eatKw("database") ||
      this.eatKw("role") ||
      this.eatKw("user") ||
      this.eatKw("system") ||
      this.eatKw("default")
    ) {
      this.skipToStatementEnd();
      return { type: "no_op", what: "ALTER (other)" };
    }
    throw unsupported("this ALTER form");
  }

  private parseAlterTableAction(): AlterTableAction {
    if (this.eatKw("add")) {
      if (this.eatKw("column")) {
        const ifNotExists = this.parseIfNotExists();
        return { kind: "add_column", column: this.parseColumnDef(), ifNotExists };
      }
      const constraint = this.tryParseTableConstraint();
      if (constraint) {
        let skipValidation = false;
        if (this.atKw("not") && this.atKw("valid", 1)) {
          this.pos += 2;
          skipValidation = true;
        }
        return { kind: "add_constraint", constraint, skipValidation };
      }
      // ADD colname type
      const ifNotExists = this.parseIfNotExists();
      return { kind: "add_column", column: this.parseColumnDef(), ifNotExists };
    }
    if (this.eatKw("drop")) {
      if (this.eatKw("constraint")) {
        const ifExists = this.parseIfExists();
        const name = this.ident();
        const cascade = this.eatKw("cascade");
        if (!cascade) this.eatKw("restrict");
        return { kind: "drop_constraint", name, ifExists, cascade };
      }
      this.eatKw("column");
      const ifExists = this.parseIfExists();
      const name = this.ident();
      const cascade = this.eatKw("cascade");
      if (!cascade) this.eatKw("restrict");
      return { kind: "drop_column", name, ifExists, cascade };
    }
    if (this.eatKw("alter")) {
      this.eatKw("column");
      const column = this.ident();
      let alterType = this.eatKw("type");
      if (!alterType && this.eatKw("set") && this.atKw("data")) {
        this.pos += 1;
        this.expectKw("type");
        alterType = true;
      }
      if (alterType) {
        const typeName = this.parseTypeName();
        const using = this.eatKw("using") ? this.parseExpr() : null;
        return { kind: "alter_type", column, typeName, using };
      }
      if (this.atKw("set")) {
        // we already consumed SET in the branch above only when followed by DATA
        // handle here: SET DEFAULT / SET NOT NULL
      }
      if (this.eatKw("set")) {
        if (this.eatKw("default")) return { kind: "set_default", column, expr: this.parseExpr() };
        if (this.atKw("not") && this.atKw("null", 1)) {
          this.pos += 2;
          return { kind: "set_not_null", column };
        }
        if (this.eatKw("statistics")) {
          this.next();
          return { kind: "rename_column", from: column, to: column }; // no-op-ish
        }
        throw unsupported("this ALTER COLUMN SET form");
      }
      if (this.eatKw("drop")) {
        if (this.eatKw("default")) return { kind: "drop_default", column };
        if (this.atKw("not") && this.atKw("null", 1)) {
          this.pos += 2;
          return { kind: "drop_not_null", column };
        }
        if (this.eatKw("identity")) {
          const ifExists = this.parseIfExists();
          return { kind: "drop_identity", column, ifExists };
        }
        if (this.eatKw("expression")) {
          this.parseIfExists();
          throw unsupported("ALTER COLUMN DROP EXPRESSION");
        }
        throw unsupported("this ALTER COLUMN DROP form");
      }
      if (this.eatKw("add")) {
        this.expectKw("generated");
        const always = this.eatKw("always");
        if (!always) {
          this.expectKw("by");
          this.expectKw("default");
        }
        this.expectKw("as");
        this.expectKw("identity");
        const options = this.parseIdentityOptions();
        return { kind: "add_identity", column, always, options };
      }
      throw unsupported("this ALTER COLUMN form");
    }
    if (this.eatKw("rename")) {
      if (this.eatKw("constraint")) {
        const from = this.ident();
        this.expectKw("to");
        return { kind: "rename_constraint", from, to: this.ident() };
      }
      if (this.eatKw("to")) {
        return { kind: "rename_table", to: this.ident() };
      }
      this.eatKw("column");
      const from = this.ident();
      this.expectKw("to");
      return { kind: "rename_column", from, to: this.ident() };
    }
    if (this.eatKw("set")) {
      if (this.eatKw("schema")) return { kind: "set_schema", to: this.ident() };
      if (this.eatPunct("(")) {
        this.skipBalancedCloseParen();
        return { kind: "reloptions" };
      }
      throw unsupported("this ALTER TABLE SET form");
    }
    if (this.eatKw("owner")) {
      this.expectKw("to");
      return { kind: "owner_to", role: this.ident(true) };
    }
    if (this.eatKw("validate")) {
      this.expectKw("constraint");
      return { kind: "validate_constraint", name: this.ident() };
    }
    if (this.eatKw("enable") || this.eatKw("disable")) {
      this.skipToStatementEnd();
      return { kind: "rename_table", to: "" } as never; // unreachable in practice
    }
    throw unsupported("this ALTER TABLE action");
  }

  // --- DROP / TRUNCATE ------------------------------------------------------------

  private parseDrop(): Statement {
    this.expectKw("drop");
    let kind: Statement extends never ? never : import("../ast/nodes.ts").DropStmt["kind"];
    if (this.eatKw("table")) kind = "table";
    else if (this.atKw("materialized") && this.atKw("view", 1)) {
      this.pos += 2;
      kind = "materialized_view";
    } else if (this.eatKw("view")) kind = "view";
    else if (this.eatKw("index")) {
      this.eatKw("concurrently");
      kind = "index";
    } else if (this.eatKw("sequence")) kind = "sequence";
    else if (this.eatKw("schema")) kind = "schema";
    else if (this.eatKw("type")) kind = "type";
    else if (this.eatKw("domain")) kind = "domain";
    else if (this.eatKw("function")) kind = "function";
    else if (this.eatKw("trigger")) kind = "trigger";
    else if (this.eatKw("extension")) kind = "extension";
    else if (this.eatKw("database")) throw unsupported("DROP DATABASE");
    else if (this.eatKw("role") || this.eatKw("user")) throw unsupported("roles");
    else if (this.eatKw("rule")) throw unsupported("DROP RULE");
    else if (this.eatKw("policy")) throw unsupported("DROP POLICY");
    else if (this.eatKw("owned")) throw unsupported("DROP OWNED");
    else this.errorAt(this.peek(), "unrecognized DROP");
    const ifExists = this.parseIfExists();
    const names: string[][] = [];
    const funcArgs: TypeName[][] | null = kind === "function" ? [] : null;
    do {
      names.push(this.qualifiedName());
      if (kind === "function" && this.eatPunct("(")) {
        const types: TypeName[] = [];
        if (!this.atPunct(")")) {
          do {
            // allow optional arg name
            const save = this.pos;
            try {
              const t = this.peek();
              if ((t.type === "ident" && !RESERVED.has(t.value)) || t.type === "quoted_ident") {
                this.ident();
                if (this.atPunct(",") || this.atPunct(")")) {
                  this.pos = save;
                }
              }
            } catch {
              this.pos = save;
            }
            types.push(this.parseTypeName());
          } while (this.eatPunct(","));
        }
        this.expectPunct(")");
        funcArgs!.push(types);
      } else if (funcArgs) {
        funcArgs.push([]);
      }
    } while (this.eatPunct(","));
    let onTable: string[] | null = null;
    if (kind === "trigger") {
      this.expectKw("on");
      onTable = this.qualifiedName();
    }
    let cascade = false;
    if (this.eatKw("cascade")) cascade = true;
    else this.eatKw("restrict");
    return { type: "drop", kind, names, onTable, funcArgs, ifExists, cascade };
  }

  private parseTruncate(): Statement {
    this.expectKw("truncate");
    this.eatKw("table");
    const tables: string[][] = [];
    do {
      this.eatKw("only");
      tables.push(this.qualifiedName());
      this.eatOp("*");
    } while (this.eatPunct(","));
    let restartIdentity = false;
    if (this.eatKw("restart")) {
      this.expectKw("identity");
      restartIdentity = true;
    } else if (this.eatKw("continue")) {
      this.expectKw("identity");
    }
    let cascade = false;
    if (this.eatKw("cascade")) cascade = true;
    else this.eatKw("restrict");
    return { type: "truncate", tables, restartIdentity, cascade };
  }

  // --- SET / EXPLAIN / COPY -----------------------------------------------------

  private parseSet(): Statement {
    this.expectKw("set");
    let local = false;
    if (this.eatKw("local")) local = true;
    else this.eatKw("session");
    if (this.atKw("transaction")) {
      this.skipToStatementEnd();
      return { type: "no_op", what: "SET TRANSACTION" };
    }
    if (this.atKw("constraints")) {
      this.skipToStatementEnd();
      return { type: "no_op", what: "SET CONSTRAINTS" };
    }
    if (this.atKw("role") || (this.atKw("session", 0) && this.atKw("authorization", 1))) {
      this.skipToStatementEnd();
      return { type: "no_op", what: "SET ROLE" };
    }
    if (this.atKw("time") && this.atKw("zone", 1)) {
      this.pos += 2;
      if (this.eatKw("local") || this.eatKw("default")) {
        return { type: "set", name: "timezone", value: null, local };
      }
      const t = this.next();
      if (t.type === "string") return { type: "set", name: "timezone", value: t.value, local };
      if (t.type === "ident") return { type: "set", name: "timezone", value: t.value, local };
      if (t.type === "number") return { type: "set", name: "timezone", value: t.value, local };
      if (t.type === "op" && (t.value === "-" || t.value === "+")) {
        const n = this.next();
        return { type: "set", name: "timezone", value: `${t.value}${n.value}`, local };
      }
      this.errorAt(t, "expected time zone");
    }
    const parts = [this.ident(true)];
    while (this.atPunct(".")) {
      this.pos++;
      parts.push(this.ident(true));
    }
    const name = parts.join(".");
    if (!this.eatKw("to") && !this.eatOp("=")) this.errorAt(this.peek(), "expected TO or =");
    if (this.eatKw("default")) return { type: "set", name, value: null, local };
    const values: string[] = [];
    do {
      const t = this.next();
      if (t.type === "string" || t.type === "ident" || t.type === "number" || t.type === "quoted_ident") {
        values.push(t.value);
      } else if (t.type === "op" && (t.value === "-" || t.value === "+") && this.peek().type === "number") {
        values.push(`${t.value}${this.next().value}`);
      } else {
        this.errorAt(t, "expected value");
      }
    } while (this.eatPunct(","));
    return { type: "set", name, value: values.join(", "), local };
  }

  private parseExplain(): Statement {
    this.expectKw("explain");
    let analyze = false;
    let verbose = false;
    if (this.atPunct("(")) {
      this.pos++;
      let depth = 1;
      const opts: string[] = [];
      while (depth > 0 && this.peek().type !== "eof") {
        if (this.atPunct("(")) depth++;
        if (this.atPunct(")")) depth--;
        if (depth > 0) opts.push(this.next().value);
        else this.pos++;
      }
      const joined = opts.join(" ").toLowerCase();
      analyze = /\banalyze\b(?! (off|false|0))/.test(joined);
      verbose = /\bverbose\b(?! (off|false|0))/.test(joined);
    } else {
      if (this.eatKw("analyze") || this.eatKw("analyse")) analyze = true;
      if (this.eatKw("verbose")) verbose = true;
    }
    const query = this.parseStatement();
    return { type: "explain", analyze, verbose, query };
  }

  private parseCopy(): CopyStmt {
    this.expectKw("copy");
    let table: string[] | null = null;
    let columns: string[] | null = null;
    let query: Statement | null = null;
    if (this.atPunct("(")) {
      this.pos++;
      query = this.parseWithableStatement();
      this.expectPunct(")");
    } else {
      table = this.qualifiedName();
      if (this.eatPunct("(")) {
        columns = [];
        do {
          columns.push(this.ident());
        } while (this.eatPunct(","));
        this.expectPunct(")");
      }
    }
    let direction: "from" | "to";
    if (this.eatKw("from")) direction = "from";
    else {
      this.expectKw("to");
      direction = "to";
    }
    let target: "stdin" | "stdout";
    if (this.eatKw("stdin")) target = "stdin";
    else if (this.eatKw("stdout")) target = "stdout";
    else if (this.eatKw("program")) throw unsupported("COPY PROGRAM");
    else throw unsupported("COPY to/from files");
    const options: Record<string, string | boolean> = {};
    if (this.eatKw("with")) {
      // WITH (...) or legacy
    }
    if (this.atPunct("(")) {
      this.pos++;
      if (!this.atPunct(")")) {
        do {
          const key = this.ident(true);
          if (this.atPunct(",") || this.atPunct(")")) {
            options[key] = true;
          } else {
            const v = this.next();
            options[key] = v.value;
          }
        } while (this.eatPunct(","));
      }
      this.expectPunct(")");
    } else {
      // legacy options
      for (;;) {
        if (this.eatKw("csv")) {
          options.format = "csv";
          continue;
        }
        if (this.eatKw("binary")) {
          options.format = "binary";
          continue;
        }
        if (this.eatKw("delimiter")) {
          this.eatKw("as");
          options.delimiter = this.next().value;
          continue;
        }
        if (this.eatKw("null")) {
          this.eatKw("as");
          options.null = this.next().value;
          continue;
        }
        if (this.eatKw("header")) {
          options.header = true;
          continue;
        }
        if (this.eatKw("quote")) {
          this.eatKw("as");
          options.quote = this.next().value;
          continue;
        }
        if (this.eatKw("escape")) {
          this.eatKw("as");
          options.escape = this.next().value;
          continue;
        }
        break;
      }
    }
    return { type: "copy", table, columns, query, direction, target, options };
  }

  // --- type names ------------------------------------------------------------------

  parseTypeName(): TypeName {
    const setof = this.eatKw("setof");
    const t = this.peek();
    let parts: string[];
    let mods: number[] = [];
    if (t.type === "ident") {
      // multi-word types
      if (t.value === "double" && this.atKw("precision", 1)) {
        this.pos += 2;
        parts = ["double precision"];
      } else if (t.value === "character" && this.atKw("varying", 1)) {
        this.pos += 2;
        parts = ["character varying"];
      } else if (t.value === "bit" && this.atKw("varying", 1)) {
        this.pos += 2;
        parts = ["bit varying"];
      } else if (
        (t.value === "timestamp" || t.value === "time") &&
        (this.atKw("with", 1) || this.atKw("without", 1) || this.atPunct("(", 1))
      ) {
        this.pos++;
        // optional precision
        if (this.eatPunct("(")) {
          const num = this.next();
          if (num.type !== "number") this.errorAt(num, "expected precision");
          mods.push(Number(num.value));
          this.expectPunct(")");
        }
        let withTz = false;
        if (this.eatKw("with")) {
          this.expectKw("time");
          this.expectKw("zone");
          withTz = true;
        } else if (this.eatKw("without")) {
          this.expectKw("time");
          this.expectKw("zone");
        }
        parts = [withTz ? `${t.value}tz` : t.value];
        // array suffix below
        let arrayDims = 0;
        while (this.atPunct("[")) {
          this.pos++;
          if (this.peek().type === "number") this.next();
          this.expectPunct("]");
          arrayDims++;
        }
        return { parts, mods, arrayDims, setof };
      } else if (t.value === "interval") {
        this.pos++;
        parts = ["interval"];
        // interval field qualifiers: YEAR TO MONTH etc. — accept and ignore fields
        const fieldWords = ["year", "month", "day", "hour", "minute", "second"];
        if (this.peek().type === "ident" && fieldWords.includes(this.peek().value)) {
          this.pos++;
          if (this.eatKw("to")) {
            this.pos++;
          }
        }
        if (this.eatPunct("(")) {
          const num = this.next();
          if (num.type !== "number") this.errorAt(num, "expected precision");
          mods.push(Number(num.value));
          this.expectPunct(")");
        }
        return { parts, mods, arrayDims: 0, setof };
      } else {
        parts = this.qualifiedName();
      }
    } else if (t.type === "quoted_ident") {
      parts = this.qualifiedName();
    } else {
      this.errorAt(t, "expected type name");
    }
    if (this.atPunct("(")) {
      this.pos++;
      mods = [];
      do {
        let neg = false;
        if (this.eatOp("-")) neg = true;
        const num = this.next();
        if (num.type !== "number") this.errorAt(num, "expected typmod");
        mods.push(neg ? -Number(num.value) : Number(num.value));
      } while (this.eatPunct(","));
      this.expectPunct(")");
    }
    let arrayDims = 0;
    if (this.atKw("array")) {
      this.pos++;
      arrayDims = 1;
      if (this.atPunct("[")) {
        this.pos++;
        if (this.peek().type === "number") this.next();
        this.expectPunct("]");
      }
    }
    while (this.atPunct("[")) {
      this.pos++;
      if (this.peek().type === "number") this.next();
      this.expectPunct("]");
      arrayDims++;
    }
    return { parts, mods, arrayDims, setof };
  }

  // --- expressions ------------------------------------------------------------------

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.eatKw("or")) {
      const right = this.parseAnd();
      left = { type: "binop", op: "or", left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.eatKw("and")) {
      const right = this.parseNot();
      left = { type: "binop", op: "and", left, right };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.eatKw("not")) {
      const operand = this.parseNot();
      return { type: "unop", op: "not", operand };
    }
    return this.parseIs();
  }

  private parseIs(): Expr {
    let left = this.parseComparison();
    for (;;) {
      if (this.atKw("is")) {
        this.pos++;
        const not = this.eatKw("not");
        if (this.eatKw("null")) {
          left = { type: "is_null", expr: left, not };
          continue;
        }
        if (this.eatKw("true")) {
          left = { type: "bool_test", expr: left, test: "true", not };
          continue;
        }
        if (this.eatKw("false")) {
          left = { type: "bool_test", expr: left, test: "false", not };
          continue;
        }
        if (this.eatKw("unknown")) {
          left = { type: "bool_test", expr: left, test: "unknown", not };
          continue;
        }
        if (this.eatKw("distinct")) {
          this.expectKw("from");
          const right = this.parseComparison();
          left = { type: "is_distinct", left, right, not };
          continue;
        }
        if (this.eatKw("normalized")) {
          left = { type: "func", name: ["pg_catalog", "is_normalized"], args: [left] };
          if (not) left = { type: "unop", op: "not", operand: left };
          continue;
        }
        if (this.eatKw("json")) {
          throw unsupported("IS JSON");
        }
        if (this.eatKw("document")) throw unsupported("IS DOCUMENT");
        this.errorAt(this.peek(), "expected NULL/TRUE/FALSE/UNKNOWN/DISTINCT after IS");
      }
      if (this.atKw("isnull")) {
        this.pos++;
        left = { type: "is_null", expr: left, not: false };
        continue;
      }
      if (this.atKw("notnull")) {
        this.pos++;
        left = { type: "is_null", expr: left, not: true };
        continue;
      }
      break;
    }
    return left;
  }

  private parseComparison(): Expr {
    const left = this.parseLikeBetweenIn();
    if (this.atKw("overlaps")) {
      this.pos++;
      const right = this.parseLikeBetweenIn();
      return { type: "func", name: ["__overlaps"], args: [left, right] };
    }
    const t = this.peek();
    if (t.type === "op" && COMPARE_OPS.has(t.value)) {
      const op = t.value === "!=" ? "<>" : t.value;
      this.pos++;
      // ANY / ALL / SOME
      const sub = this.tryParseAnyAll(op, left);
      if (sub) return sub;
      const right = this.parseLikeBetweenIn();
      return { type: "binop", op, left, right };
    }
    return left;
  }

  private tryParseAnyAll(op: string, left: Expr): Expr | null {
    let kind: "any" | "all" | null = null;
    if (this.atKw("any") || this.atKw("some")) kind = "any";
    else if (this.atKw("all")) kind = "all";
    if (kind === null) return null;
    this.pos++;
    this.expectPunct("(");
    if (this.atKw("select") || this.atKw("with") || this.atKw("values")) {
      const query = this.parseSelectStmt();
      this.expectPunct(")");
      return { type: "subquery_expr", kind, op, left, query };
    }
    // array form: op ANY(array_expr)
    const arr = this.parseExpr();
    this.expectPunct(")");
    return { type: "func", name: [`__${kind}_array`], args: [left, arr, { type: "string_lit", value: op }] };
  }

  private parseLikeBetweenIn(): Expr {
    let left = this.parseGenericOps();
    for (;;) {
      const not =
        this.atKw("not") &&
        (this.atKw("like", 1) ||
          this.atKw("ilike", 1) ||
          this.atKw("in", 1) ||
          this.atKw("between", 1) ||
          this.atKw("similar", 1));
      if (not) this.pos++;
      if (this.eatKw("like") || (this.peek(-1)?.value === "like" && false)) {
        const pattern = this.parseGenericOps();
        const escape = this.eatKw("escape") ? this.parseGenericOps() : null;
        left = { type: "like", kind: "like", left, pattern, escape, not };
        continue;
      }
      if (this.eatKw("ilike")) {
        const pattern = this.parseGenericOps();
        const escape = this.eatKw("escape") ? this.parseGenericOps() : null;
        left = { type: "like", kind: "ilike", left, pattern, escape, not };
        continue;
      }
      if (this.atKw("similar") && this.atKw("to", 1)) {
        this.pos += 2;
        const pattern = this.parseGenericOps();
        const escape = this.eatKw("escape") ? this.parseGenericOps() : null;
        left = { type: "like", kind: "similar", left, pattern, escape, not };
        continue;
      }
      if (this.eatKw("between")) {
        const symmetric = this.eatKw("symmetric");
        if (!symmetric) this.eatKw("asymmetric");
        const low = this.parseGenericOps();
        this.expectKw("and");
        const high = this.parseGenericOps();
        left = { type: "between", left, low, high, not, symmetric };
        continue;
      }
      if (this.eatKw("in")) {
        this.expectPunct("(");
        if (this.atKw("select") || this.atKw("with") || this.atKw("values")) {
          const query = this.parseSelectStmt();
          this.expectPunct(")");
          left = { type: "in_expr", left, not, query };
        } else {
          const list: Expr[] = [];
          do {
            list.push(this.parseExpr());
          } while (this.eatPunct(","));
          this.expectPunct(")");
          left = { type: "in_expr", left, not, list };
        }
        continue;
      }
      if (not) this.errorAt(this.peek(), "expected LIKE/ILIKE/IN/BETWEEN/SIMILAR after NOT");
      break;
    }
    return left;
  }

  /** all other binary operators: ||, &, |, #, <<, >>, @>, <@, ->, ->>, etc. */
  private parseGenericOps(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (this.atKw("at")) {
        // AT TIME ZONE / AT LOCAL
        const save = this.pos;
        this.pos++;
        if (this.eatKw("time")) {
          this.expectKw("zone");
          const zone = this.parseAdditive();
          left = { type: "at_time_zone", expr: left, zone };
          continue;
        }
        if (this.eatKw("local")) {
          left = { type: "at_time_zone", expr: left, zone: { type: "func", name: ["__session_timezone"], args: [] } };
          continue;
        }
        this.pos = save;
        break;
      }
      if (this.atKw("collate")) {
        this.pos++;
        const collation = this.qualifiedName();
        left = { type: "collate", expr: left, collation };
        continue;
      }
      if (this.atKw("operator")) {
        this.pos++;
        this.expectPunct("(");
        const parts: string[] = [];
        for (;;) {
          const nt = this.next();
          if (nt.type === "punct" && nt.value === ")") break;
          if (nt.type === "punct" && nt.value === ".") continue;
          parts.push(nt.value);
        }
        const op = parts[parts.length - 1]!;
        const sub = this.tryParseAnyAll(op, left);
        if (sub) return sub;
        const right = this.parseAdditive();
        left = { type: "binop", op, left, right };
        continue;
      }
      if (
        t.type === "op" &&
        !COMPARE_OPS.has(t.value) &&
        !ADDITIVE_OPS.has(t.value) &&
        !MULTIPLICATIVE_OPS.has(t.value) &&
        t.value !== "^" &&
        t.value !== "::" &&
        t.value !== ":" // `:` is only valid inside array slice subscripts
      ) {
        this.pos++;
        const sub = this.tryParseAnyAll(t.value, left);
        if (sub) {
          left = sub;
          continue;
        }
        const right = this.parseAdditive();
        left = { type: "binop", op: t.value, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t.type === "op" && ADDITIVE_OPS.has(t.value)) {
        this.pos++;
        const sub = this.tryParseAnyAll(t.value, left);
        if (sub) {
          left = sub;
          continue;
        }
        const right = this.parseMultiplicative();
        left = { type: "binop", op: t.value, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseExponent();
    for (;;) {
      const t = this.peek();
      if (t.type === "op" && MULTIPLICATIVE_OPS.has(t.value)) {
        this.pos++;
        const right = this.parseExponent();
        left = { type: "binop", op: t.value, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseExponent(): Expr {
    let left = this.parseUnary();
    while (this.atOp("^")) {
      this.pos++;
      const right = this.parseUnary();
      left = { type: "binop", op: "^", left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === "op") {
      if (t.value === "-" || t.value === "+") {
        this.pos++;
        const operand = this.parseUnary();
        if (operand.type === "number_lit") {
          if (t.value === "+") return operand;
          const raw = operand.raw;
          if (raw.startsWith("-")) return { type: "number_lit", raw: raw.slice(1) };
          return { type: "number_lit", raw: `-${raw}` };
        }
        return { type: "unop", op: t.value, operand };
      }
      // prefix operators: ~ @ |/ ||/ !!
      if (["~", "@", "|/", "||/", "!!", "@-@", "?-", "#"].includes(t.value)) {
        this.pos++;
        const operand = this.parseUnary();
        return { type: "unop", op: t.value, operand };
      }
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.atOp("::")) {
        this.pos++;
        const target = this.parseTypeName();
        expr = { type: "cast", expr, target };
        continue;
      }
      if (this.atPunct("[")) {
        const indexes: Array<{ lower: Expr | null; upper: Expr | null; slice: boolean }> = [];
        while (this.atPunct("[")) {
          this.pos++;
          let lower: Expr | null = null;
          let upper: Expr | null = null;
          let slice = false;
          if (this.atOp(":")) {
            // [:x] or [:]
            this.pos++;
            slice = true;
            if (!this.atPunct("]")) upper = this.parseExpr();
          } else {
            lower = this.parseExpr();
            if (this.eatOp(":")) {
              slice = true;
              if (!this.atPunct("]")) upper = this.parseExpr();
            }
          }
          this.expectPunct("]");
          indexes.push({ lower, upper, slice });
        }
        expr = { type: "subscript", base: expr, indexes };
        continue;
      }
      if (
        this.atPunct(".") &&
        (expr.type === "row" ||
          expr.type === "field_select" ||
          expr.type === "func" ||
          expr.type === "subscript" ||
          (expr.type === "cast" && true))
      ) {
        // (composite).field — only after parenthesized/func expressions.
        this.pos++;
        if (this.atOp("*")) {
          this.pos++;
          expr = { type: "field_select", base: expr, field: "*" };
        } else {
          expr = { type: "field_select", base: expr, field: this.ident(true) };
        }
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.type === "number") {
      this.pos++;
      return { type: "number_lit", raw: t.value };
    }
    if (t.type === "string") {
      this.pos++;
      return { type: "string_lit", value: t.value };
    }
    if (t.type === "bitstring") {
      this.pos++;
      return { type: "bitstring_lit", value: t.value };
    }
    if (t.type === "param") {
      this.pos++;
      return { type: "param", index: Number(t.value) };
    }

    if (this.atPunct("(")) {
      this.pos++;
      if (this.atKw("select") || this.atKw("with") || this.atKw("values")) {
        const query = this.parseSelectStmt();
        this.expectPunct(")");
        return { type: "subquery_expr", kind: "scalar", query };
      }
      const first = this.parseExpr();
      if (this.atPunct(",")) {
        const items = [first];
        while (this.eatPunct(",")) items.push(this.parseExpr());
        this.expectPunct(")");
        return { type: "row", items, explicit: false };
      }
      this.expectPunct(")");
      // mark rows/parens for field selection
      if (first.type === "colref" || first.type === "field_select" || first.type === "subquery_expr") {
        // allow (t).field
        if (this.atPunct(".")) {
          let expr: Expr = { type: "row", items: [first], explicit: false };
          // treat as parenthesized reference: (t).f handled by field_select on base colref
          this.pos++;
          if (this.atOp("*")) {
            this.pos++;
            expr = { type: "field_select", base: first, field: "*" };
          } else {
            expr = { type: "field_select", base: first, field: this.ident(true) };
          }
          return expr;
        }
      }
      return first;
    }

    if (t.type !== "ident" && t.type !== "quoted_ident") {
      this.errorAt(t, "expected expression");
    }

    if (t.type === "ident") {
      switch (t.value) {
        case "null":
          this.pos++;
          return { type: "null_lit" };
        case "true":
          this.pos++;
          return { type: "bool_lit", value: true };
        case "false":
          this.pos++;
          return { type: "bool_lit", value: false };
        case "default":
          this.pos++;
          return { type: "default_expr" };
        case "case":
          return this.parseCase();
        case "cast": {
          this.pos++;
          this.expectPunct("(");
          const expr = this.parseExpr();
          this.expectKw("as");
          const target = this.parseTypeName();
          this.expectPunct(")");
          return { type: "cast", expr, target };
        }
        case "exists": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          const query = this.parseSelectStmt();
          this.expectPunct(")");
          return { type: "subquery_expr", kind: "exists", query };
        }
        case "array": {
          this.pos++;
          if (this.atPunct("(")) {
            this.pos++;
            const query = this.parseSelectStmt();
            this.expectPunct(")");
            return { type: "array_query", query };
          }
          this.expectPunct("[");
          const items: Expr[] = [];
          if (!this.atPunct("]")) {
            do {
              if (this.atPunct("[")) {
                // nested array literal — parse as nested ARRAY
                items.push(this.parseNestedArrayLiteral());
              } else {
                items.push(this.parseExpr());
              }
            } while (this.eatPunct(","));
          }
          this.expectPunct("]");
          return { type: "array_ctor", items };
        }
        case "row": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          const items: Expr[] = [];
          if (!this.atPunct(")")) {
            do {
              items.push(this.parseExpr());
            } while (this.eatPunct(","));
          }
          this.expectPunct(")");
          return { type: "row", items, explicit: true };
        }
        case "grouping": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          const args: Expr[] = [];
          do {
            args.push(this.parseExpr());
          } while (this.eatPunct(","));
          this.expectPunct(")");
          return { type: "grouping_func", args };
        }
        case "position": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          const needle = this.parseGenericOps();
          this.expectKw("in");
          const haystack = this.parseGenericOps();
          this.expectPunct(")");
          return { type: "position", needle, haystack };
        }
        case "substring": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          const source = this.parseExpr();
          let from: Expr | null = null;
          let forLen: Expr | null = null;
          let similar: Expr | null = null;
          let escape: Expr | null = null;
          if (this.eatPunct(",")) {
            from = this.parseExpr();
            if (this.eatPunct(",")) forLen = this.parseExpr();
          } else {
            if (this.eatKw("from")) from = this.parseExpr();
            if (this.eatKw("for")) forLen = this.parseExpr();
            if (this.eatKw("similar")) {
              similar = this.parseExpr();
              this.expectKw("escape");
              escape = this.parseExpr();
            }
          }
          this.expectPunct(")");
          return { type: "substring_sql", source, from, forLen, similar, escape };
        }
        case "overlay": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          const source = this.parseExpr();
          this.expectKw("placing");
          const placing = this.parseExpr();
          this.expectKw("from");
          const from = this.parseExpr();
          const forLen = this.eatKw("for") ? this.parseExpr() : null;
          this.expectPunct(")");
          return { type: "overlay", source, placing, from, forLen };
        }
        case "trim": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          let side: "both" | "leading" | "trailing" = "both";
          if (this.eatKw("leading")) side = "leading";
          else if (this.eatKw("trailing")) side = "trailing";
          else this.eatKw("both");
          let chars: Expr | null = null;
          let source: Expr;
          if (this.atKw("from")) {
            this.pos++;
            source = this.parseExpr();
          } else {
            const first = this.parseExpr();
            if (this.eatKw("from")) {
              chars = first;
              source = this.parseExpr();
            } else if (this.eatPunct(",")) {
              source = first;
              chars = this.parseExpr();
            } else {
              source = first;
            }
          }
          this.expectPunct(")");
          return { type: "trim", side, chars, source };
        }
        case "extract": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          const ft = this.next();
          let field: string;
          if (ft.type === "ident" || ft.type === "string") field = ft.value.toLowerCase();
          else this.errorAt(ft, "expected extract field");
          this.expectKw("from");
          const source = this.parseExpr();
          this.expectPunct(")");
          return { type: "extract", field, source };
        }
        case "current_date":
          this.pos++;
          return { type: "func", name: ["pg_catalog", "current_date"], args: [] };
        case "current_time":
          this.pos++;
          this.maybePrecision();
          return { type: "func", name: ["pg_catalog", "current_time"], args: [] };
        case "current_timestamp":
          this.pos++;
          this.maybePrecision();
          return { type: "func", name: ["pg_catalog", "current_timestamp"], args: [] };
        case "localtime":
          this.pos++;
          this.maybePrecision();
          return { type: "func", name: ["pg_catalog", "localtime"], args: [] };
        case "localtimestamp":
          this.pos++;
          this.maybePrecision();
          return { type: "func", name: ["pg_catalog", "localtimestamp"], args: [] };
        case "current_user":
        case "user":
          this.pos++;
          return { type: "func", name: ["pg_catalog", "current_user"], args: [] };
        case "session_user":
          this.pos++;
          return { type: "func", name: ["pg_catalog", "session_user"], args: [] };
        case "current_role":
          this.pos++;
          return { type: "func", name: ["pg_catalog", "current_user"], args: [] };
        case "current_catalog":
          this.pos++;
          return { type: "func", name: ["pg_catalog", "current_catalog"], args: [] };
        case "current_schema":
          this.pos++;
          if (this.atPunct("(")) {
            this.pos++;
            this.expectPunct(")");
          }
          return { type: "func", name: ["pg_catalog", "current_schema"], args: [] };
        case "collation": {
          if (this.atKw("for", 1)) {
            this.pos += 2;
            this.expectPunct("(");
            const arg = this.parseExpr();
            this.expectPunct(")");
            return { type: "func", name: ["pg_catalog", "pg_collation_for"], args: [arg] };
          }
          break;
        }
        case "normalize": {
          if (!this.atPunct("(", 1)) break;
          this.pos++;
          this.expectPunct("(");
          const arg = this.parseExpr();
          let form: Expr = { type: "string_lit", value: "NFC" };
          if (this.eatPunct(",")) {
            form = { type: "string_lit", value: this.ident(true).toUpperCase() };
          }
          this.expectPunct(")");
          return { type: "func", name: ["pg_catalog", "normalize"], args: [arg, form] };
        }
        case "xmlelement":
        case "xmlforest":
        case "xmlparse":
        case "xmlpi":
        case "xmlroot":
        case "xmlserialize":
        case "xmlexists":
          throw unsupported("XML functions");
        case "json_table":
          throw unsupported("JSON_TABLE");
        default:
          break;
      }
    }

    // TYPENAME 'literal'
    if (t.type === "ident" && TYPE_LITERAL_NAMES.has(t.value)) {
      // interval 'x' hour etc.
      if (this.peek(1).type === "string") {
        const typeName = this.parseTypeName();
        const st = this.next();
        if (st.type !== "string") this.errorAt(st, "expected string");
        return { type: "cast", expr: { type: "string_lit", value: st.value }, target: typeName };
      }
      // varchar(10) 'abc' / timestamp(3) '...' / timestamp with time zone '...' /
      // double precision '...' / character varying '...'
      const next1 = this.peek(1);
      if (this.atPunct("(", 1) || (next1.type === "ident" && MULTIWORD_TYPE_SECOND.has(next1.value))) {
        const save = this.pos;
        try {
          const typeName = this.parseTypeName();
          if (this.peek().type === "string") {
            const st = this.next();
            return { type: "cast", expr: { type: "string_lit", value: st.value }, target: typeName };
          }
        } catch {
          // fall through
        }
        this.pos = save;
      }
    }

    // qualified name: column reference or function call
    const parts: string[] = [this.ident(true)];
    if (t.type === "ident" && RESERVED.has(t.value)) {
      this.errorAt(t, "unexpected keyword");
    }
    for (;;) {
      if (this.atPunct(".")) {
        if (this.atOp("*", 1)) {
          this.pos += 2;
          return { type: "star", table: parts };
        }
        this.pos++;
        parts.push(this.ident(true));
        continue;
      }
      break;
    }
    if (this.atPunct("(")) {
      return this.parseFuncCall(parts);
    }
    return { type: "colref", parts };
  }

  private parseCase(): Expr {
    this.expectKw("case");
    let operand: Expr | null = null;
    if (!this.atKw("when")) {
      operand = this.parseExpr();
    }
    const whens: Array<{ when: Expr; then: Expr }> = [];
    while (this.eatKw("when")) {
      const when = this.parseExpr();
      this.expectKw("then");
      const then = this.parseExpr();
      whens.push({ when, then });
    }
    if (whens.length === 0) this.errorAt(this.peek(), "expected WHEN");
    let elseExpr: Expr | null = null;
    if (this.eatKw("else")) elseExpr = this.parseExpr();
    this.expectKw("end");
    return { type: "case", operand, whens, elseExpr };
  }

  private maybePrecision(): void {
    if (this.atPunct("(")) {
      this.pos++;
      this.next();
      this.expectPunct(")");
    }
  }

  private parseNestedArrayLiteral(): Expr {
    this.expectPunct("[");
    const items: Expr[] = [];
    if (!this.atPunct("]")) {
      do {
        if (this.atPunct("[")) items.push(this.parseNestedArrayLiteral());
        else items.push(this.parseExpr());
      } while (this.eatPunct(","));
    }
    this.expectPunct("]");
    return { type: "array_ctor", items };
  }

  private parseFuncCall(name: string[]): Expr {
    this.expectPunct("(");
    let star = false;
    let distinct = false;
    let variadic = false;
    const args: Expr[] = [];
    const argNames: Record<number, string> = {};
    let orderBy: OrderByItem[] | undefined;
    if (this.atOp("*") && this.atPunct(")", 1)) {
      this.pos += 2;
      star = true;
    } else {
      if (this.eatKw("distinct")) distinct = true;
      else this.eatKw("all");
      if (!this.atPunct(")")) {
        do {
          if (this.eatKw("variadic")) variadic = true;
          // named notation f(a => 1)
          const save = this.pos;
          const pt = this.peek();
          if ((pt.type === "ident" && !RESERVED.has(pt.value)) || pt.type === "quoted_ident") {
            const argName = pt.value.toLowerCase();
            this.pos++;
            if (this.atOp("=>") || this.atOp(":=")) {
              this.pos++;
              argNames[args.length] = argName;
              args.push(this.parseExpr());
              continue;
            }
            this.pos = save;
          }
          args.push(this.parseExpr());
        } while (this.eatPunct(","));
      }
      if (this.atKw("order")) {
        orderBy = this.parseOrderByClause();
      }
      this.expectPunct(")");
    }
    if (star) {
      // already consumed ")"
    }
    let withinGroupOrderBy: OrderByItem[] | undefined;
    if (this.atKw("within")) {
      this.pos++;
      this.expectKw("group");
      this.expectPunct("(");
      withinGroupOrderBy = this.parseOrderByClause();
      this.expectPunct(")");
    }
    let filter: Expr | undefined;
    if (this.atKw("filter")) {
      this.pos++;
      this.expectPunct("(");
      this.expectKw("where");
      filter = this.parseExpr();
      this.expectPunct(")");
    }
    let over: WindowSpec | null | undefined;
    if (this.atKw("over")) {
      this.pos++;
      if (this.atPunct("(")) {
        this.pos++;
        over = this.parseWindowSpec();
        this.expectPunct(")");
      } else {
        over = { name: this.ident(), partitionBy: [], orderBy: [], frame: null };
      }
    }
    const names = Object.keys(argNames).length > 0 ? args.map((_, i) => argNames[i] ?? null) : undefined;
    return {
      type: "func",
      name,
      args,
      star,
      distinct,
      orderBy,
      filter,
      withinGroupOrderBy,
      over: over ?? null,
      variadic,
      argNames: names,
    };
  }

  private parseWindowSpec(): WindowSpec {
    let name: string | undefined;
    const t = this.peek();
    if (
      (t.type === "ident" &&
        !RESERVED.has(t.value) &&
        !["partition", "order", "range", "rows", "groups"].includes(t.value)) ||
      t.type === "quoted_ident"
    ) {
      name = this.ident();
    }
    const partitionBy: Expr[] = [];
    if (this.eatKw("partition")) {
      this.expectKw("by");
      do {
        partitionBy.push(this.parseExpr());
      } while (this.eatPunct(","));
    }
    const orderBy = this.parseOrderByClause();
    let frame: FrameSpec | null = null;
    if (this.atKw("range") || this.atKw("rows") || this.atKw("groups")) {
      const mode = this.next().value as "range" | "rows" | "groups";
      let start: FrameBound;
      let end: FrameBound | null = null;
      if (this.eatKw("between")) {
        start = this.parseFrameBound();
        this.expectKw("and");
        end = this.parseFrameBound();
      } else {
        start = this.parseFrameBound();
      }
      let exclusion: FrameSpec["exclusion"] = null;
      if (this.eatKw("exclude")) {
        if (this.eatKw("current")) {
          this.expectKw("row");
          exclusion = "current_row";
        } else if (this.eatKw("group")) {
          exclusion = "group";
        } else if (this.eatKw("ties")) {
          exclusion = "ties";
        } else {
          this.expectKw("no");
          this.expectKw("others");
          exclusion = "no_others";
        }
      }
      frame = { mode, start, end, exclusion };
    }
    return { name, partitionBy, orderBy, frame };
  }

  private parseFrameBound(): FrameBound {
    if (this.eatKw("unbounded")) {
      if (this.eatKw("preceding")) return { kind: "unbounded_preceding" };
      this.expectKw("following");
      return { kind: "unbounded_following" };
    }
    if (this.eatKw("current")) {
      this.expectKw("row");
      return { kind: "current_row" };
    }
    const offset = this.parseExpr();
    if (this.eatKw("preceding")) return { kind: "preceding", offset };
    this.expectKw("following");
    return { kind: "following", offset };
  }
}

/** Parse SQL text into a list of statements. */
export function parse(sql: string): Statement[] {
  return new Parser(sql).parseStatements();
}

/** Parse exactly one statement; throws `misuse`-style errors handled by API layer. */
export function parseSingle(sql: string): Statement {
  const statements = parse(sql);
  if (statements.length === 0) {
    throw pgError("misuse", "empty statement");
  }
  if (statements.length > 1) {
    throw pgError("misuse", "cannot prepare multiple statements at once");
  }
  return statements[0]!;
}
