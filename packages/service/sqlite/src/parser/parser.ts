import type {
  AlterTableStmt,
  AttachStmt,
  BeginStmt,
  BinaryOp,
  CaseExpr,
  ColumnConstraint,
  ColumnDef,
  CommitStmt,
  CompoundTail,
  ConflictAction,
  CreateIndexStmt,
  CreateTableStmt,
  CreateTriggerStmt,
  CreateViewStmt,
  CreateVirtualTableStmt,
  Cte,
  DeleteStmt,
  DetachStmt,
  DropIndexStmt,
  DropTableStmt,
  DropTriggerStmt,
  DropViewStmt,
  Expr,
  FkAction,
  FkMatch,
  FrameBound,
  FrameSpec,
  FromItem,
  IndexedColumn,
  InExpr,
  InsertStmt,
  JoinFrom,
  LikeExpr,
  LimitClause,
  OrderByItem,
  PragmaStmt,
  ReleaseStmt,
  ResultColumn,
  RollbackStmt,
  SavepointStmt,
  SelectStmt,
  SetItem,
  Statement,
  TableConstraint,
  TableRef,
  UpdateStmt,
  UpsertClause,
  WindowSpec,
  WithClause,
} from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { Token, TokenKind } from "../lexer/tokenize.ts";

/** Keywords that may appear as identifiers via {@link Parser.parseIdent}. */
const IDENT_KEYWORDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "ABORT",
  "ACTION",
  "ADD",
  "AFTER",
  "ALL",
  "ALTER",
  "ANALYZE",
  "AND",
  "AS",
  "ASC",
  "ATTACH",
  "AUTOINCREMENT",
  "BEFORE",
  "BEGIN",
  "BETWEEN",
  "BY",
  "CASCADE",
  "CASE",
  "CAST",
  "CHECK",
  "COLLATE",
  "COLUMN",
  "COMMIT",
  "CONFLICT",
  "CONSTRAINT",
  "CREATE",
  "CROSS",
  "CURRENT",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "DATABASE",
  "DEFAULT",
  "DEFERRABLE",
  "DEFERRED",
  "DELETE",
  "DESC",
  "DETACH",
  "DISTINCT",
  "DO",
  "DROP",
  "EACH",
  "ELSE",
  "END",
  "ESCAPE",
  "EXCEPT",
  "EXCLUDE",
  "EXCLUSIVE",
  "EXISTS",
  "EXPLAIN",
  "FAIL",
  "FILTER",
  "FIRST",
  "FOLLOWING",
  "FOR",
  "FOREIGN",
  "FROM",
  "FULL",
  "FALSE",
  "GENERATED",
  "GLOB",
  "GROUP",
  "GROUPS",
  "HAVING",
  "IF",
  "IGNORE",
  "IMMEDIATE",
  "IN",
  "INDEX",
  "INDEXED",
  "INITIALLY",
  "INNER",
  "INSERT",
  "INSTEAD",
  "INTERSECT",
  "INTO",
  "IS",
  "ISNULL",
  "JOIN",
  "KEY",
  "LAST",
  "LEFT",
  "LIKE",
  "LIMIT",
  "MATCH",
  "MATERIALIZED",
  "NATURAL",
  "NO",
  "NOT",
  "NOTHING",
  "NOTNULL",
  "NULL",
  "NULLS",
  "OF",
  "OFFSET",
  "ON",
  "OR",
  "ORDER",
  "OTHERS",
  "OUTER",
  "OVER",
  "PARTITION",
  "PLAN",
  "PRAGMA",
  "PRECEDING",
  "PRIMARY",
  "QUERY",
  "RAISE",
  "RANGE",
  "RECURSIVE",
  "REFERENCES",
  "REGEXP",
  "REINDEX",
  "RELEASE",
  "RENAME",
  "REPLACE",
  "RESTRICT",
  "RESPECT",
  "RETURNING",
  "RIGHT",
  "ROLLBACK",
  "ROW",
  "ROWS",
  "SAVEPOINT",
  "SELECT",
  "SET",
  "TABLE",
  "TEMP",
  "TEMPORARY",
  "THEN",
  "TIES",
  "TO",
  "TRANSACTION",
  "TRIGGER",
  "TRUE",
  "UNBOUNDED",
  "UNION",
  "UNIQUE",
  "UPDATE",
  "USING",
  "VACUUM",
  "VALUES",
  "VIEW",
  "VIRTUAL",
  "WHEN",
  "WHERE",
  "WINDOW",
  "WITH",
  "WITHOUT",
]);

const AGGREGATE_FUNCTIONS = new Set([
  "AVG",
  "COUNT",
  "GROUP_CONCAT",
  "STRING_AGG",
  "MAX",
  "MIN",
  "SUM",
  "TOTAL",
  "JSON_GROUP_ARRAY",
  "JSON_GROUP_OBJECT",
  "JSONB_GROUP_ARRAY",
  "JSONB_GROUP_OBJECT",
]);

/** SQLite binary operator precedence (higher binds tighter). */
const PREC = {
  OR: 10,
  AND: 20,
  NOT: 25,
  IS_IN_LIKE: 30,
  COMPARE: 40,
  BIT_OR: 45,
  BIT_AND: 46,
  SHIFT: 47,
  ADD: 50,
  MUL: 60,
  CONCAT: 70,
  JSON_ARROW: 80,
} as const;

export interface ParsedUnit {
  statement: Statement;
  /** Source slice for this statement (no trailing semicolon); used for sqlite_master.sql. */
  sql: string;
}

export class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source = "",
  ) {}

  private current(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1]!;
  }

  private peek(offset = 1): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1]!;
  }

  private at(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private check(...kinds: TokenKind[]): boolean {
    return kinds.includes(this.current().kind);
  }

  private advance(): Token {
    const t = this.current();
    if (t.kind !== "EOF") this.pos++;
    return t;
  }

  private match(...kinds: TokenKind[]): boolean {
    if (this.check(...kinds)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind, message?: string): Token {
    if (!this.at(kind)) {
      this.syntaxError(message ?? `expected ${kind}, got ${this.current().kind}`);
    }
    return this.advance();
  }

  syntaxError(message: string): never {
    const t = this.current();
    throw new SqliteError(`${message} at ${t.line}:${t.column}`, "syntax");
  }

  /** Accept IDENT or keyword tokens as identifier names. */
  parseIdent(): string {
    const t = this.current();
    if (t.kind === "IDENT") {
      this.advance();
      return t.value;
    }
    if (IDENT_KEYWORDS.has(t.kind)) {
      this.advance();
      return t.value;
    }
    this.syntaxError("expected identifier");
  }

  private parseQualifiedTableName(): { schema: string | null; name: string } {
    const first = this.parseIdent();
    if (this.match("DOT")) {
      const second = this.parseIdent();
      return { schema: first, name: second };
    }
    return { schema: null, name: first };
  }

  private parseTableName(): string {
    const qname = this.parseQualifiedTableName();
    return qname.schema ? `${qname.schema}.${qname.name}` : qname.name;
  }

  private parseAttachStmt(): AttachStmt {
    this.expect("ATTACH");
    this.match("DATABASE");
    const filename = this.parseExpr();
    this.expect("AS");
    const schema = this.parseIdent();
    return { type: "attach", filename, schema };
  }

  private parseDetachStmt(): DetachStmt {
    this.expect("DETACH");
    this.match("DATABASE");
    const schema = this.parseIdent();
    return { type: "detach", schema };
  }

  private optionalAlias(): string | null {
    if (this.match("AS")) return this.parseIdent();
    // Implicit aliases use only non-keyword IDENT tokens to avoid swallowing clause keywords.
    if (this.current().kind === "IDENT") {
      return this.parseIdent();
    }
    return null;
  }

  // ── Statements ──────────────────────────────────────────────────────────

  parseStatements(): Statement[] {
    return this.parseUnits().map((unit) => unit.statement);
  }

  /** Parse statements with per-statement source slices for catalog `sql` text. */
  parseUnits(): ParsedUnit[] {
    const units: ParsedUnit[] = [];
    while (!this.at("EOF")) {
      if (this.match("SEMI")) continue;
      const start = this.current().start;
      const statement = this.parseStatement();
      const end = this.pos > 0 ? this.tokens[this.pos - 1]!.end : this.current().end;
      this.match("SEMI");
      const sql = this.source ? this.source.slice(start, end).trimEnd() : "";
      units.push({ statement, sql });
    }
    return units;
  }

  parseStatement(): Statement {
    if (this.match("EXPLAIN")) {
      let queryPlan = false;
      if (this.match("QUERY")) {
        this.expect("PLAN");
        queryPlan = true;
      }
      const stmt = this.parseStatement();
      return { type: "explain", queryPlan, statement: stmt };
    }

    if (this.at("WITH")) {
      const withClause = this.parseWithClause();
      if (this.at("SELECT")) return this.parseSelectStmt(withClause);
      if (this.at("INSERT") || this.at("REPLACE")) return this.parseInsertStmt(withClause);
      if (this.at("UPDATE")) return this.parseUpdateStmt(withClause);
      if (this.at("DELETE")) return this.parseDeleteStmt(withClause);
      this.syntaxError("expected SELECT, INSERT, UPDATE, or DELETE after WITH clause");
    }
    if (this.at("SELECT")) return this.parseSelectStmt();

    if (this.at("INSERT") || this.at("REPLACE")) {
      return this.parseInsertStmt();
    }
    if (this.at("UPDATE")) return this.parseUpdateStmt();
    if (this.at("DELETE")) return this.parseDeleteStmt();

    if (this.at("CREATE")) return this.parseCreateStmt();
    if (this.at("DROP")) return this.parseDropStmt();
    if (this.at("ALTER")) return this.parseAlterTableStmt();

    if (this.at("BEGIN")) return this.parseBeginStmt();
    if (this.check("COMMIT", "END")) return this.parseCommitStmt();
    if (this.at("ROLLBACK")) return this.parseRollbackStmt();
    if (this.at("SAVEPOINT")) return this.parseSavepointStmt();
    if (this.at("RELEASE")) return this.parseReleaseStmt();
    if (this.at("PRAGMA")) return this.parsePragmaStmt();

    if (this.at("ATTACH")) return this.parseAttachStmt();
    if (this.at("DETACH")) return this.parseDetachStmt();

    if (this.at("ANALYZE")) return this.parseAnalyzeStmt();
    if (this.at("REINDEX")) return this.parseReindexStmt();
    if (this.at("VACUUM")) return this.parseVacuumStmt();

    this.syntaxError(`unexpected token ${this.current().kind}`);
  }

  private parseAnalyzeStmt(): import("../ast/nodes.ts").AnalyzeStmt {
    this.expect("ANALYZE");
    if (this.at("SEMI") || this.at("EOF")) return { type: "analyze", schema: null, name: null };
    const first = this.parseIdent();
    if (this.match("DOT")) {
      return { type: "analyze", schema: first, name: this.parseIdent() };
    }
    return { type: "analyze", schema: null, name: first };
  }

  private parseReindexStmt(): import("../ast/nodes.ts").ReindexStmt {
    this.expect("REINDEX");
    if (this.at("SEMI") || this.at("EOF")) return { type: "reindex", schema: null, name: null };
    const first = this.parseIdent();
    if (this.match("DOT")) {
      return { type: "reindex", schema: first, name: this.parseIdent() };
    }
    return { type: "reindex", schema: null, name: first };
  }

  private parseVacuumStmt(): import("../ast/nodes.ts").VacuumStmt {
    this.expect("VACUUM");
    let schema: string | null = null;
    if (this.at("IDENT") || this.at("STRING")) {
      // VACUUM schema_name — but INTO starts with keyword
      if (!this.at("INTO")) schema = this.parseIdent();
    }
    let into: string | null = null;
    if (this.match("INTO")) {
      into = this.at("STRING") ? String(this.advance().value) : this.parseIdent();
    }
    return { type: "vacuum", schema, into };
  }

  private parseWithClause(): WithClause {
    this.expect("WITH");
    const recursive = this.match("RECURSIVE");
    const ctes: Cte[] = [];
    do {
      const name = this.parseIdent();
      let columns: string[] | null = null;
      if (this.match("LPAREN")) {
        columns = [];
        do {
          columns.push(this.parseIdent());
        } while (this.match("COMMA"));
        this.expect("RPAREN");
      }
      this.expect("AS");
      let materialized: Cte["materialized"] = null;
      if (this.match("NOT")) {
        this.expect("MATERIALIZED", "expected MATERIALIZED after NOT");
        materialized = "not_materialized";
      } else if (this.match("MATERIALIZED")) materialized = "materialized";
      this.expect("LPAREN");
      const select = this.at("VALUES")
        ? this.parseValuesAsSelect()
        : this.at("WITH")
          ? this.parseSelectStmt()
          : this.parseSelectCore();
      this.expect("RPAREN");
      ctes.push({ name, columns, materialized, select });
    } while (this.match("COMMA"));
    return { recursive, ctes };
  }

  private parseOptionalWith(): WithClause | null {
    return this.at("WITH") ? this.parseWithClause() : null;
  }

  // ── SELECT ──────────────────────────────────────────────────────────────

  parseSelectStmt(withClause = this.parseOptionalWith()): SelectStmt {
    const select = this.parseSelectCore();
    select.with = withClause;
    return select;
  }

  private parseSelectCore(): SelectStmt {
    this.expect("SELECT");
    const distinct = this.match("DISTINCT");
    this.match("ALL");

    if (this.at("FROM")) {
      throw new SqliteError('near "FROM": syntax error', "syntax");
    }
    const columns = this.parseResultColumns();
    let from: FromItem | null = null;
    if (this.match("FROM")) {
      from = this.parseFromItem();
    }

    let where: Expr | null = null;
    if (this.match("WHERE")) where = this.parseExpr();

    const groupBy: Expr[] = [];
    if (this.match("GROUP")) {
      this.expect("BY");
      do {
        groupBy.push(this.parseExpr());
      } while (this.match("COMMA"));
    }

    let having: Expr | null = null;
    if (this.match("HAVING")) having = this.parseExpr();

    const windows: { name: string; spec: WindowSpec }[] = [];
    if (this.match("WINDOW")) {
      do {
        const name = this.parseIdent();
        this.expect("AS");
        this.expect("LPAREN");
        const spec = this.parseWindowSpec();
        this.expect("RPAREN");
        windows.push({ name, spec });
      } while (this.match("COMMA"));
    }

    const orderBy = this.parseOrderBy();
    const limit = this.parseLimit();

    const stmt: SelectStmt = {
      type: "select",
      with: null,
      distinct,
      columns,
      from,
      where,
      groupBy,
      having,
      windows,
      orderBy,
      limit,
      compound: null,
    };

    if (this.check("UNION", "INTERSECT", "EXCEPT")) {
      stmt.compound = this.parseCompoundTail();
      // ORDER BY and LIMIT following a compound SELECT apply to the entire
      // compound, even though the recursive parser initially attaches them
      // to its right-most arm.
      if (stmt.compound.select.orderBy.length > 0) {
        stmt.orderBy = stmt.compound.select.orderBy;
        stmt.compound.select.orderBy = [];
      }
      if (stmt.compound.select.limit) {
        stmt.limit = stmt.compound.select.limit;
        stmt.compound.select.limit = null;
      }
    }

    return stmt;
  }

  private parseCompoundTail(): CompoundTail {
    let op: CompoundTail["op"];
    if (this.match("UNION")) {
      op = this.match("ALL") ? "UNION ALL" : "UNION";
    } else if (this.match("INTERSECT")) {
      op = "INTERSECT";
    } else {
      this.expect("EXCEPT");
      op = "EXCEPT";
    }
    const select = this.parseSelectCore();
    return { op, select };
  }

  private parseResultColumns(): ResultColumn[] {
    const cols: ResultColumn[] = [];
    do {
      if (this.match("STAR")) {
        cols.push({ type: "star", table: null });
      } else if (this.check("IDENT") || IDENT_KEYWORDS.has(this.current().kind)) {
        const saved = this.pos;
        const first = this.parseIdent();
        if (this.match("DOT") && this.at("STAR")) {
          this.advance();
          cols.push({ type: "star", table: first });
        } else {
          this.pos = saved;
          const expr = this.parseExpr();
          let alias: string | null = null;
          if (this.match("AS")) alias = this.parseIdent();
          else if (
            this.current().kind === "IDENT" ||
            (IDENT_KEYWORDS.has(this.current().kind) && !this.isSelectClauseStart())
          ) {
            alias = this.parseIdent();
          }
          cols.push({ type: "expr", expr, alias });
        }
      } else {
        const expr = this.parseExpr();
        let alias: string | null = null;
        if (this.match("AS")) alias = this.parseIdent();
        else if (
          this.current().kind === "IDENT" ||
          (IDENT_KEYWORDS.has(this.current().kind) && !this.isSelectClauseStart())
        ) {
          alias = this.parseIdent();
        }
        cols.push({ type: "expr", expr, alias });
      }
    } while (this.match("COMMA"));
    return cols;
  }

  private isSelectClauseStart(): boolean {
    return this.check(
      "FROM",
      "WHERE",
      "GROUP",
      "HAVING",
      "WINDOW",
      "ORDER",
      "LIMIT",
      "UNION",
      "INTERSECT",
      "EXCEPT",
      "COMMA",
      "SEMI",
      "EOF",
      "RPAREN",
    );
  }

  private parseFromItem(): FromItem {
    let left = this.parseFromPrimary();
    while (true) {
      if (this.match("COMMA")) {
        const right = this.parseFromPrimary();
        left = this.makeJoin(left, right, "CROSS", null, null);
        continue;
      }
      const joinInfo = this.parseJoinOp();
      if (!joinInfo) break;
      const right = this.parseFromPrimary();
      let on: Expr | null = null;
      let using: string[] | null = null;
      if (joinInfo.natural) {
        using = [];
      } else if (this.match("ON")) {
        on = this.parseExpr();
      } else if (this.match("USING")) {
        this.expect("LPAREN");
        using = [];
        do {
          using.push(this.parseIdent());
        } while (this.match("COMMA"));
        this.expect("RPAREN");
      } else if (joinInfo.type !== "CROSS" && joinInfo.type !== "INNER") {
        this.syntaxError("expected ON or USING after JOIN");
      }
      left = this.makeJoin(left, right, joinInfo.type, on, using);
    }
    return left;
  }

  private makeJoin(
    left: FromItem,
    right: FromItem,
    joinType: JoinFrom["joinType"],
    on: Expr | null,
    using: string[] | null,
  ): JoinFrom {
    return { type: "join", left, right, joinType, on, using };
  }

  private parseJoinOp(): { type: JoinFrom["joinType"]; natural: boolean } | null {
    const natural = this.match("NATURAL");
    if (this.match("CROSS")) {
      this.expect("JOIN");
      return { type: "CROSS", natural: false };
    }
    let type: JoinFrom["joinType"] = "INNER";
    if (this.match("INNER")) type = "INNER";
    else if (this.match("LEFT")) type = "LEFT";
    else if (this.match("RIGHT")) type = "RIGHT";
    else if (this.match("FULL")) type = "FULL";
    if (type !== "INNER" || this.at("OUTER") || this.at("JOIN")) {
      this.match("OUTER");
      if (!this.match("JOIN")) return null;
      return { type, natural };
    }
    if (this.match("JOIN")) return { type: "INNER", natural };
    if (natural) this.syntaxError("expected JOIN after NATURAL");
    return null;
  }

  private parseFromPrimary(): FromItem {
    if (this.match("LPAREN")) {
      if (this.at("SELECT") || this.at("WITH") || this.at("VALUES")) {
        const select = this.at("SELECT") || this.at("WITH") ? this.parseSelectStmt() : this.parseValuesAsSelect();
        this.expect("RPAREN");
        // SQLite allows omitting the alias; invent one for the AST.
        const alias = this.optionalAlias() ?? `__subq_${this.pos}`;
        return { type: "subquery", select, alias };
      }
      const item = this.parseFromItem();
      this.expect("RPAREN");
      const alias = this.optionalAlias();
      if (alias && item.type === "table") item.alias = alias;
      return item;
    }

    const qname = this.parseQualifiedTableName();
    if (this.match("LPAREN")) {
      const name = qname.name;
      const args: Expr[] = [];
      if (!this.at("RPAREN")) {
        do {
          args.push(this.parseExpr());
        } while (this.match("COMMA"));
      }
      this.expect("RPAREN");
      const alias = this.optionalAlias();
      return { type: "table_func", name, args, alias };
    }

    const alias = this.optionalAlias();
    if (this.match("INDEXED")) {
      this.expect("BY");
      this.parseIdent(); // index hint — planner is a no-op
    } else if (this.match("NOT") && this.at("INDEXED")) {
      this.advance(); // INDEXED
    }
    return {
      type: "table",
      schema: qname.schema,
      name: qname.name,
      alias,
    } satisfies TableRef;
  }

  private parseValuesAsSelect(): SelectStmt {
    this.expect("VALUES");
    const rows: Expr[][] = [];
    do {
      this.expect("LPAREN");
      const row: Expr[] = [];
      do {
        row.push(this.parseExpr());
      } while (this.match("COMMA"));
      this.expect("RPAREN");
      rows.push(row);
    } while (this.match("COMMA"));

    const selectFor = (row: Expr[]): SelectStmt => ({
      type: "select",
      with: null,
      distinct: false,
      columns: row.map((expr) => ({ type: "expr" as const, expr, alias: null })),
      from: null,
      where: null,
      groupBy: [],
      having: null,
      windows: [],
      orderBy: [],
      limit: null,
      compound: null,
    });
    const result = selectFor(rows[0] ?? []);
    let current = result;
    for (const row of rows.slice(1)) {
      current.compound = { op: "UNION ALL", select: selectFor(row) };
      current = current.compound.select;
    }
    if (this.check("UNION", "INTERSECT", "EXCEPT")) {
      current.compound = this.parseCompoundTail();
    }
    return result;
  }

  private parseOrderBy(): OrderByItem[] {
    if (!this.match("ORDER")) return [];
    this.expect("BY");
    const items: OrderByItem[] = [];
    do {
      const expr = this.parseExpr();
      let dir: "ASC" | "DESC" = "ASC";
      if (this.match("ASC")) dir = "ASC";
      else if (this.match("DESC")) dir = "DESC";
      let nulls: "FIRST" | "LAST" | null = null;
      if (this.match("NULLS")) {
        if (this.match("FIRST")) nulls = "FIRST";
        else if (this.match("LAST")) nulls = "LAST";
        else this.syntaxError("expected FIRST or LAST after NULLS");
      }
      items.push({ expr, dir, nulls });
    } while (this.match("COMMA"));
    return items;
  }

  private parseLimit(): LimitClause | null {
    if (!this.match("LIMIT")) return null;
    const first = this.parseExpr();
    if (this.match("OFFSET")) {
      return { limit: first, offset: this.parseExpr() };
    }
    if (this.match("COMMA")) {
      const limit = this.parseExpr();
      return { limit, offset: first };
    }
    let offset: Expr | null = null;
    if (this.match("OFFSET")) offset = this.parseExpr();
    return { limit: first, offset };
  }

  // ── INSERT / REPLACE ────────────────────────────────────────────────────

  private parseInsertStmt(withClause = this.parseOptionalWith()): InsertStmt {
    let mode: InsertStmt["mode"] = "insert";

    if (this.match("REPLACE")) {
      mode = "replace";
    } else {
      this.expect("INSERT");
      const orAction = this.parseOrConflict();
      if (orAction === "REPLACE") mode = "insert_or_replace";
      else if (orAction === "IGNORE") mode = "insert_or_ignore";
      else if (orAction === "ABORT") mode = "insert_or_abort";
      else if (orAction === "ROLLBACK") mode = "insert_or_rollback";
      else if (orAction === "FAIL") mode = "insert_or_fail";
    }

    this.expect("INTO");
    const table = this.parseTableName();

    let columns: string[] | null = null;
    if (this.match("LPAREN")) {
      columns = [];
      do {
        columns.push(this.parseIdent());
      } while (this.match("COMMA"));
      this.expect("RPAREN");
    }

    let values: Expr[][] | null = null;
    let select: SelectStmt | null = null;

    if (this.match("VALUES")) {
      values = [];
      do {
        this.expect("LPAREN");
        const row: Expr[] = [];
        do {
          row.push(this.parseExpr());
        } while (this.match("COMMA"));
        this.expect("RPAREN");
        values.push(row);
      } while (this.match("COMMA"));
    } else if (this.at("SELECT") || this.at("WITH")) {
      select = this.parseSelectStmt();
    } else if (this.at("DEFAULT")) {
      this.advance();
      this.expect("VALUES");
      columns = [];
      values = [[]];
    } else {
      this.syntaxError("expected VALUES, SELECT, or DEFAULT");
    }

    const upsert = this.parseUpsertClause();
    const returning = this.parseReturning();

    return {
      type: "insert",
      with: withClause,
      mode,
      table,
      columns,
      values,
      select,
      upsert,
      returning,
    };
  }

  private parseUpsertClause(): UpsertClause | null {
    if (!this.match("ON")) return null;
    this.expect("CONFLICT");
    let targetColumns: string[] | null = null;
    let targetExprs: Expr[] | null = null;
    if (this.match("LPAREN")) {
      targetColumns = [];
      targetExprs = [];
      do {
        const expr = this.parseExprPrec(PREC.ADD);
        targetExprs.push(expr);
        targetColumns.push(expr.type === "column" ? expr.name : "");
      } while (this.match("COMMA"));
      this.expect("RPAREN");
    }
    let targetWhere: Expr | null = null;
    if (this.match("WHERE")) targetWhere = this.parseExpr();

    this.expect("DO");
    if (this.match("NOTHING")) {
      return { targetColumns, targetExprs, targetWhere, action: "nothing" };
    }
    this.expect("UPDATE");
    this.expect("SET");
    const set = this.parseSetItems();
    let where: Expr | null = null;
    if (this.match("WHERE")) where = this.parseExpr();
    return { targetColumns, targetExprs, targetWhere, action: { set, where } };
  }

  private parseSetItems(): SetItem[] {
    const items: SetItem[] = [];
    do {
      const columns = [this.parseIdent()];
      this.expect("EQ");
      const expr = this.parseExpr();
      items.push({ columns, expr });
    } while (this.match("COMMA"));
    return items;
  }

  private parseReturning(): ResultColumn[] {
    if (!this.match("RETURNING")) return [];
    return this.parseResultColumns();
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────

  private parseUpdateStmt(withClause = this.parseOptionalWith()): UpdateStmt {
    this.expect("UPDATE");
    const or = this.mapUpdateOr(this.parseOrConflict());
    const table = this.parseTableName();
    const alias = this.optionalAlias();
    this.expect("SET");
    const set = this.parseSetItems();
    let from: FromItem | null = null;
    if (this.match("FROM")) from = this.parseFromItem();
    let where: Expr | null = null;
    if (this.match("WHERE")) where = this.parseExpr();
    const returning = this.parseReturning();
    return { type: "update", with: withClause, or, table, alias, set, from, where, returning };
  }

  // ── DELETE ──────────────────────────────────────────────────────────────

  private parseDeleteStmt(withClause = this.parseOptionalWith()): DeleteStmt {
    this.expect("DELETE");
    const or = this.parseOrConflict();
    this.expect("FROM");
    const table = this.parseTableName();
    const alias = this.optionalAlias();
    let where: Expr | null = null;
    if (this.match("WHERE")) where = this.parseExpr();
    const returning = this.parseReturning();
    const orMode =
      or === null
        ? null
        : or === "REPLACE"
          ? "replace"
          : or === "IGNORE"
            ? "ignore"
            : or === "ABORT"
              ? "abort"
              : or === "ROLLBACK"
                ? "rollback"
                : "fail";
    return { type: "delete", with: withClause, or: orMode, table, alias, where, returning };
  }

  // ── CREATE ──────────────────────────────────────────────────────────────

  private parseCreateStmt(): Statement {
    this.expect("CREATE");
    const temp = this.match("TEMP") || this.match("TEMPORARY");
    if (this.match("VIRTUAL")) {
      this.expect("TABLE");
      return this.parseCreateVirtualTable();
    }
    if (this.match("TRIGGER")) return this.parseCreateTrigger(temp);
    if (this.match("UNIQUE")) {
      this.expect("INDEX");
      return this.parseCreateIndex(true, temp);
    }
    if (this.match("INDEX")) return this.parseCreateIndex(false, temp);
    if (this.match("VIEW")) return this.parseCreateView(temp);
    this.expect("TABLE");
    return this.parseCreateTable(temp);
  }

  private parseCreateVirtualTable(): CreateVirtualTableStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseTableName();
    this.expect("USING");
    const module = this.parseIdent();
    const moduleArgs: string[] = [];
    if (this.match("LPAREN")) {
      if (!this.at("RPAREN")) {
        do {
          moduleArgs.push(this.parseVirtualTableArg());
        } while (this.match("COMMA"));
      }
      this.expect("RPAREN");
    }
    return { type: "create_virtual_table", ifNotExists, name, module, moduleArgs };
  }

  /** One comma-separated CREATE VIRTUAL TABLE module argument (FTS options, columns, …). */
  private parseVirtualTableArg(): string {
    // STRING alone
    if (this.at("STRING")) {
      const value = String(this.current().literal);
      this.advance();
      return value;
    }

    // IDENT [UNINDEXED|NOTINDEXED] | IDENT = value
    const start = this.parseIdentOrQuoted();
    if (this.match("EQ") || this.match("EQEQ")) {
      const value = this.parseVirtualTableOptionValue();
      return `${start}=${value}`;
    }
    // Optional UNINDEXED / NOTINDEXED / type names
    const extras: string[] = [];
    while (this.at("IDENT") || this.at("STRING")) {
      // Stop before next comma-separated arg would need peek of COMMA/RPAREN — only consume trailing idents
      if (this.at("IDENT")) {
        const upper = this.current().value.toUpperCase();
        if (
          upper === "UNINDEXED" ||
          upper === "NOTINDEXED" ||
          upper === "TEXT" ||
          upper === "INTEGER" ||
          upper === "REAL" ||
          upper === "BLOB" ||
          upper === "NUMERIC"
        ) {
          extras.push(this.current().value);
          this.advance();
          continue;
        }
      }
      break;
    }
    return extras.length ? `${start} ${extras.join(" ")}` : start;
  }

  private parseIdentOrQuoted(): string {
    if (this.at("STRING")) {
      // quoted identifier written as string in some dialects
      const value = String(this.current().literal);
      this.advance();
      return `"${value.replaceAll('"', '""')}"`;
    }
    return this.parseIdent();
  }

  private parseVirtualTableOptionValue(): string {
    if (this.at("STRING")) {
      const value = String(this.current().literal);
      this.advance();
      return `'${value.replaceAll("'", "''")}'`;
    }
    if (this.at("NUMBER")) {
      const value = this.current().value;
      this.advance();
      return value;
    }
    if (this.at("IDENT")) {
      return this.parseIdent();
    }
    // Empty string after content=
    return "''";
  }

  private parseIfNotExists(): boolean {
    if (!this.match("IF")) return false;
    this.expect("NOT");
    this.expect("EXISTS");
    return true;
  }

  private parseIfExists(): boolean {
    if (!this.match("IF")) return false;
    this.expect("EXISTS");
    return true;
  }

  private mapUpdateOr(action: ConflictAction | null): UpdateStmt["or"] {
    if (!action) return null;
    switch (action) {
      case "ROLLBACK":
        return "rollback";
      case "ABORT":
        return "abort";
      case "FAIL":
        return "fail";
      case "IGNORE":
        return "ignore";
      case "REPLACE":
        return "replace";
    }
  }

  private parseCreateTable(temp: boolean): CreateTableStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseTableName();

    if (this.match("AS")) {
      const asSelect = this.parseSelectStmt();
      return {
        type: "create_table",
        ifNotExists,
        temp,
        name,
        columns: [],
        constraints: [],
        asSelect,
        withoutRowid: false,
        strict: false,
      };
    }

    this.expect("LPAREN");
    const columns: ColumnDef[] = [];
    const constraints: TableConstraint[] = [];
    do {
      if (this.at("PRIMARY") || this.at("UNIQUE") || this.at("CHECK") || this.at("FOREIGN") || this.at("CONSTRAINT")) {
        constraints.push(this.parseTableConstraint());
      } else {
        columns.push(this.parseColumnDef());
      }
    } while (this.match("COMMA"));
    this.expect("RPAREN");
    let withoutRowid = false;
    let strict = false;
    while (!this.at("SEMI") && !this.at("EOF")) {
      if (this.match("WITHOUT")) {
        const word = this.parseIdent();
        if (word.toUpperCase() !== "ROWID") this.syntaxError("expected ROWID after WITHOUT");
        withoutRowid = true;
      } else {
        const word = this.parseIdent();
        if (word.toUpperCase() !== "STRICT") this.syntaxError(`unexpected table option ${word}`);
        strict = true;
      }
      this.match("COMMA");
    }

    return {
      type: "create_table",
      ifNotExists,
      temp,
      name,
      columns,
      constraints,
      asSelect: null,
      withoutRowid,
      strict,
    };
  }

  private parseColumnDef(): ColumnDef {
    const name = this.parseIdent();
    let typeName: string | null = null;
    if (this.current().kind === "IDENT" || IDENT_KEYWORDS.has(this.current().kind)) {
      if (
        !this.at("CONSTRAINT") &&
        !this.at("PRIMARY") &&
        !this.at("NOT") &&
        !this.at("UNIQUE") &&
        !this.at("CHECK") &&
        !this.at("DEFAULT") &&
        !this.at("REFERENCES") &&
        !this.at("COLLATE") &&
        !this.at("GENERATED") &&
        !this.at("COMMA") &&
        !this.at("RPAREN")
      ) {
        typeName = this.parseTypeName();
      }
    }
    const constraints: ColumnConstraint[] = [];
    while (this.isColumnConstraintStart()) {
      constraints.push(this.parseColumnConstraint());
    }
    return { name, typeName, constraints };
  }

  /** Type names may include optional precision/scale: VARCHAR(10), DECIMAL(10,2). */
  private parseTypeName(): string {
    const base = this.parseIdent();
    if (!this.match("LPAREN")) return base;
    const parts: string[] = [];
    do {
      if (this.at("NUMBER") || this.at("PLUS") || this.at("MINUS")) {
        let sign = "";
        if (this.match("PLUS")) sign = "+";
        else if (this.match("MINUS")) sign = "-";
        const number = this.advance();
        parts.push(`${sign}${number.value}`);
      } else {
        parts.push(this.parseIdent());
      }
    } while (this.match("COMMA"));
    this.expect("RPAREN");
    return `${base}(${parts.join(",")})`;
  }

  private isColumnConstraintStart(): boolean {
    return this.check(
      "CONSTRAINT",
      "PRIMARY",
      "NOT",
      "UNIQUE",
      "CHECK",
      "DEFAULT",
      "COLLATE",
      "REFERENCES",
      "GENERATED",
    );
  }

  private parseColumnConstraint(): ColumnConstraint {
    this.match("CONSTRAINT");
    if (this.current().kind === "IDENT" || IDENT_KEYWORDS.has(this.current().kind)) {
      const next = this.peek();
      if (
        next.kind === "PRIMARY" ||
        next.kind === "UNIQUE" ||
        next.kind === "CHECK" ||
        next.kind === "DEFAULT" ||
        next.kind === "NOT" ||
        next.kind === "REFERENCES"
      ) {
        this.parseIdent(); // constraint name, discarded for column level
      }
    }
    if (this.match("PRIMARY")) {
      this.expect("KEY");
      let order: "ASC" | "DESC" | null = null;
      if (this.match("ASC")) order = "ASC";
      else if (this.match("DESC")) order = "DESC";
      const autoincrement = this.match("AUTOINCREMENT");
      const conflict = this.parseOnConflict();
      return { type: "primary_key", order, autoincrement, conflict };
    }
    if (this.match("NOT")) {
      this.expect("NULL");
      const conflict = this.parseOnConflict();
      return { type: "not_null", conflict };
    }
    if (this.match("UNIQUE")) {
      const conflict = this.parseOnConflict();
      return { type: "unique", conflict };
    }
    if (this.match("CHECK")) {
      this.expect("LPAREN");
      const expr = this.parseExpr();
      this.expect("RPAREN");
      return { type: "check", expr };
    }
    if (this.match("DEFAULT")) {
      const expr = this.parseExpr();
      return { type: "default", expr };
    }
    if (this.match("COLLATE")) {
      const name = this.parseIdent();
      return { type: "collate", name };
    }
    if (this.match("REFERENCES")) {
      return this.parseReferencesConstraint();
    }
    if (this.match("GENERATED")) {
      const always = this.parseIdent();
      if (always.toUpperCase() !== "ALWAYS") this.syntaxError("expected ALWAYS after GENERATED");
      this.expect("AS");
      return this.parseGeneratedConstraint();
    }
    if (this.match("AS") && this.at("LPAREN")) {
      return this.parseGeneratedConstraint();
    }
    this.syntaxError("expected column constraint");
  }

  private parseGeneratedConstraint(): ColumnConstraint {
    this.expect("LPAREN");
    const expr = this.parseExpr();
    this.expect("RPAREN");
    let stored = false;
    if (this.current().kind === "IDENT" || this.at("VIRTUAL")) {
      const word = this.parseIdent().toUpperCase();
      if (word === "STORED") stored = true;
      else if (word === "VIRTUAL") stored = false;
      else this.syntaxError("expected STORED or VIRTUAL after generated column expression");
    }
    return { type: "generated", expr, stored };
  }

  private parseReferencesConstraint(): ColumnConstraint {
    const table = this.parseTableName();
    let columns: string[] | null = null;
    if (this.match("LPAREN")) {
      columns = [];
      do {
        columns.push(this.parseIdent());
      } while (this.match("COMMA"));
      this.expect("RPAREN");
    }
    const { onDelete, onUpdate, match } = this.parseFkActions();
    const { deferrable, initiallyDeferred } = this.parseDeferrable();
    return { type: "references", table, columns, onDelete, onUpdate, match, deferrable, initiallyDeferred };
  }

  private parseTableConstraint(): TableConstraint {
    let name: string | null = null;
    if (this.match("CONSTRAINT")) {
      name = this.parseIdent();
    }
    if (this.match("PRIMARY")) {
      this.expect("KEY");
      this.expect("LPAREN");
      const columns = this.parseIndexedColumns();
      this.expect("RPAREN");
      const conflict = this.parseOnConflict();
      return { type: "primary_key", columns, conflict };
    }
    if (this.match("UNIQUE")) {
      this.expect("LPAREN");
      const columns = this.parseIndexedColumns();
      this.expect("RPAREN");
      const conflict = this.parseOnConflict();
      return { type: "unique", columns, conflict, name };
    }
    if (this.match("CHECK")) {
      this.expect("LPAREN");
      const expr = this.parseExpr();
      this.expect("RPAREN");
      return { type: "check", expr, name };
    }
    if (this.match("FOREIGN")) {
      this.expect("KEY");
      this.expect("LPAREN");
      const columns: string[] = [];
      do {
        columns.push(this.parseIdent());
      } while (this.match("COMMA"));
      this.expect("RPAREN");
      this.expect("REFERENCES");
      const refTable = this.parseTableName();
      let refColumns: string[] | null = null;
      if (this.match("LPAREN")) {
        refColumns = [];
        do {
          refColumns.push(this.parseIdent());
        } while (this.match("COMMA"));
        this.expect("RPAREN");
      }
      const { onDelete, onUpdate, match } = this.parseFkActions();
      const { deferrable, initiallyDeferred } = this.parseDeferrable();
      return {
        type: "foreign_key",
        columns,
        refTable,
        refColumns,
        onDelete,
        onUpdate,
        match,
        name,
        deferrable,
        initiallyDeferred,
      };
    }
    this.syntaxError("expected table constraint");
  }

  private parseIndexedColumns(): IndexedColumn[] {
    const cols: IndexedColumn[] = [];
    do {
      const expr = this.parseExprPrec(PREC.ADD);
      let collate: string | null = null;
      let inner = expr;
      if (inner.type === "collate") {
        collate = inner.collation;
        inner = inner.expr;
      }
      if (this.match("COLLATE")) collate = this.parseIdent();
      let order: "ASC" | "DESC" | null = null;
      if (this.match("ASC")) order = "ASC";
      else if (this.match("DESC")) order = "DESC";
      if (inner.type === "column" && inner.table === null) {
        cols.push({ name: inner.name, collate, order });
      } else {
        cols.push({ name: "", collate, order, expr: inner });
      }
    } while (this.match("COMMA"));
    return cols;
  }

  private parseOnConflict(): ConflictAction | null {
    if (!this.match("ON")) return null;
    this.expect("CONFLICT");
    return this.parseConflictAction();
  }

  private parseConflictAction(): ConflictAction {
    if (this.match("ROLLBACK")) return "ROLLBACK";
    if (this.match("ABORT")) return "ABORT";
    if (this.match("FAIL")) return "FAIL";
    if (this.match("IGNORE")) return "IGNORE";
    if (this.match("REPLACE")) return "REPLACE";
    this.syntaxError("expected conflict action");
  }

  private parseFkAction(kind: "DELETE" | "UPDATE"): FkAction | null {
    if (!this.match("ON")) return null;
    this.expect(kind);
    if (this.match("SET")) {
      if (this.match("NULL")) return "SET NULL";
      this.expect("DEFAULT");
      return "SET DEFAULT";
    }
    if (this.match("CASCADE")) return "CASCADE";
    if (this.match("RESTRICT")) return "RESTRICT";
    if (this.match("NO")) {
      this.expect("ACTION");
      return "NO ACTION";
    }
    this.syntaxError(`expected ON ${kind} action`);
  }

  private parseFkActions(): { onDelete: FkAction | null; onUpdate: FkAction | null; match: FkMatch } {
    let onDelete: FkAction | null = null;
    let onUpdate: FkAction | null = null;
    let match: FkMatch = "SIMPLE";
    const readMatch = (): void => {
      while (this.match("MATCH")) {
        const word = this.parseIdent().toUpperCase();
        if (word === "FULL") match = "FULL";
        else if (word === "PARTIAL") match = "PARTIAL";
        else match = "SIMPLE";
      }
    };
    // MATCH is accepted (SQLite grammar); SIMPLE is the default. FULL rejects partial-NULL keys.
    readMatch();
    while (this.at("ON")) {
      if (this.peek().kind === "DELETE") onDelete = this.parseFkAction("DELETE");
      else if (this.peek().kind === "UPDATE") onUpdate = this.parseFkAction("UPDATE");
      else this.syntaxError("expected ON DELETE or ON UPDATE");
      readMatch();
    }
    readMatch();
    return { onDelete, onUpdate, match };
  }

  private parseDeferrable(): { deferrable: boolean; initiallyDeferred: boolean } {
    let deferrable = false;
    let initiallyDeferred = false;
    if (this.match("NOT")) {
      this.expect("DEFERRABLE");
    } else if (this.match("DEFERRABLE")) {
      deferrable = true;
    }
    if (this.match("INITIALLY")) {
      if (this.match("DEFERRED")) initiallyDeferred = true;
      else {
        this.expect("IMMEDIATE");
        initiallyDeferred = false;
      }
    }
    return { deferrable, initiallyDeferred: deferrable && initiallyDeferred };
  }

  private parseOrConflict(): ConflictAction | null {
    if (!this.match("OR")) return null;
    return this.parseConflictAction();
  }

  private parseCreateIndex(unique: boolean, _temp: boolean): CreateIndexStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseIdent();
    this.expect("ON");
    const table = this.parseTableName();
    this.expect("LPAREN");
    const columns = this.parseIndexedColumns();
    this.expect("RPAREN");
    let where: Expr | null = null;
    if (this.match("WHERE")) where = this.parseExpr();
    return { type: "create_index", unique, ifNotExists, name, table, columns, where };
  }

  private parseCreateView(temp: boolean): CreateViewStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseIdent();
    let columns: string[] | null = null;
    if (this.match("LPAREN")) {
      columns = [];
      do {
        columns.push(this.parseIdent());
      } while (this.match("COMMA"));
      this.expect("RPAREN");
    }
    this.expect("AS");
    const select = this.parseSelectStmt();
    return { type: "create_view", ifNotExists, temp, name, columns, select };
  }

  private parseCreateTrigger(temp: boolean): CreateTriggerStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseTableName();
    let timing: CreateTriggerStmt["timing"];
    if (this.match("BEFORE")) timing = "BEFORE";
    else if (this.match("AFTER")) timing = "AFTER";
    else if (this.match("INSTEAD")) {
      this.expect("OF");
      timing = "INSTEAD";
    } else {
      this.syntaxError("expected BEFORE, AFTER, or INSTEAD OF");
    }

    let event: CreateTriggerStmt["event"];
    if (this.match("INSERT")) event = "INSERT";
    else if (this.match("DELETE")) event = "DELETE";
    else if (this.match("UPDATE")) event = "UPDATE";
    else this.syntaxError("expected INSERT, DELETE, or UPDATE");

    let updateColumns: string[] | null = null;
    if (event === "UPDATE" && this.match("OF")) {
      updateColumns = [];
      do {
        updateColumns.push(this.parseIdent());
      } while (this.match("COMMA"));
    }

    this.expect("ON");
    const table = this.parseTableName();

    let forEachRow = false;
    if (this.match("FOR")) {
      this.expect("EACH");
      this.expect("ROW");
      forEachRow = true;
    }

    let when: Expr | null = null;
    if (this.match("WHEN")) when = this.parseExpr();

    this.expect("BEGIN");
    const body = this.parseTriggerBody();

    return {
      type: "create_trigger",
      ifNotExists,
      temp,
      name,
      timing,
      event,
      table,
      updateColumns,
      forEachRow,
      when,
      body,
    };
  }

  private parseTriggerBody(): Statement[] {
    const body: Statement[] = [];
    while (!this.at("END") && !this.at("EOF")) {
      if (this.match("SEMI")) continue;
      body.push(this.parseStatement());
      this.match("SEMI");
    }
    this.expect("END");
    return body;
  }

  // ── DROP ────────────────────────────────────────────────────────────────

  private parseDropStmt(): Statement {
    this.expect("DROP");
    if (this.match("TABLE")) return this.parseDropTable();
    if (this.match("INDEX")) return this.parseDropIndex();
    if (this.match("VIEW")) return this.parseDropView();
    if (this.match("TRIGGER")) return this.parseDropTrigger();
    this.syntaxError("expected TABLE, INDEX, or VIEW after DROP");
  }

  private parseDropTable(): DropTableStmt {
    const ifExists = this.parseIfExists();
    const name = this.parseTableName();
    return { type: "drop_table", ifExists, name };
  }

  private parseDropIndex(): DropIndexStmt {
    const ifExists = this.parseIfExists();
    const name = this.parseIdent();
    return { type: "drop_index", ifExists, name };
  }

  private parseDropView(): DropViewStmt {
    const ifExists = this.parseIfExists();
    const name = this.parseIdent();
    return { type: "drop_view", ifExists, name };
  }

  private parseDropTrigger(): DropTriggerStmt {
    const ifExists = this.parseIfExists();
    const name = this.parseTableName();
    return { type: "drop_trigger", ifExists, name };
  }

  // ── ALTER TABLE ─────────────────────────────────────────────────────────

  private parseAlterTableStmt(): AlterTableStmt {
    this.expect("ALTER");
    this.expect("TABLE");
    const table = this.parseTableName();
    if (this.match("RENAME")) {
      if (this.match("TO")) {
        const newName = this.parseTableName();
        return { type: "alter_table", table, action: { kind: "rename_table", newName } };
      }
      if (this.match("COLUMN")) {
        const oldName = this.parseIdent();
        this.expect("TO");
        const newName = this.parseIdent();
        return { type: "alter_table", table, action: { kind: "rename_column", oldName, newName } };
      }
      this.syntaxError("expected TO or COLUMN after RENAME");
    }
    if (this.match("ADD")) {
      this.match("COLUMN");
      const column = this.parseColumnDef();
      return { type: "alter_table", table, action: { kind: "add_column", column } };
    }
    if (this.match("DROP")) {
      this.match("COLUMN");
      const name = this.parseIdent();
      return { type: "alter_table", table, action: { kind: "drop_column", name } };
    }
    this.syntaxError("expected RENAME, ADD, or DROP after ALTER TABLE");
  }

  // ── Transactions ────────────────────────────────────────────────────────

  private parseBeginStmt(): BeginStmt {
    this.expect("BEGIN");
    let mode: BeginStmt["mode"] = null;
    if (this.match("DEFERRED")) mode = "DEFERRED";
    else if (this.match("IMMEDIATE")) mode = "IMMEDIATE";
    else if (this.match("EXCLUSIVE")) mode = "EXCLUSIVE";
    this.match("TRANSACTION");
    return { type: "begin", mode };
  }

  private parseCommitStmt(): CommitStmt {
    if (this.at("END")) this.advance();
    else this.expect("COMMIT");
    this.match("TRANSACTION");
    return { type: "commit" };
  }

  private parseRollbackStmt(): RollbackStmt {
    this.expect("ROLLBACK");
    this.match("TRANSACTION");
    let savepoint: string | null = null;
    if (this.match("TO")) {
      this.match("SAVEPOINT");
      savepoint = this.parseIdent();
    }
    return { type: "rollback", savepoint };
  }

  private parseSavepointStmt(): SavepointStmt {
    this.expect("SAVEPOINT");
    const name = this.parseIdent();
    return { type: "savepoint", name };
  }

  private parseReleaseStmt(): ReleaseStmt {
    this.expect("RELEASE");
    this.match("SAVEPOINT");
    const name = this.parseIdent();
    return { type: "release", name };
  }

  // ── PRAGMA ──────────────────────────────────────────────────────────────

  private parsePragmaStmt(): PragmaStmt {
    this.expect("PRAGMA");
    const name = this.parseIdent();
    if (this.match("EQ")) {
      return { type: "pragma", name, value: this.parseExpr() };
    }
    if (this.match("LPAREN")) {
      let value: Expr | null = null;
      if (!this.at("RPAREN")) value = this.parseExpr();
      this.expect("RPAREN");
      return { type: "pragma", name, value };
    }
    return { type: "pragma", name, value: null };
  }

  // ── Expressions (Pratt / precedence climbing) ───────────────────────────

  parseExpr(): Expr {
    return this.parseExprPrec(PREC.OR);
  }

  private parseExprPrec(minPrec: number): Expr {
    let left: Expr;
    if (this.at("NOT") && PREC.NOT >= minPrec && !this.isNotKeywordCompound()) {
      this.advance();
      left = { type: "unary", op: "NOT", expr: this.parseExprPrec(PREC.NOT + 1) };
    } else {
      left = this.parseUnaryExpr();
    }

    while (true) {
      left = this.parsePostfix(left);

      if (this.at("NOT") && PREC.IS_IN_LIKE >= minPrec) {
        const n = this.peek();
        if (n.kind === "IN") {
          this.advance();
          this.advance();
          left = this.parseInRhs(left, true);
          continue;
        }
        if (n.kind === "LIKE") {
          this.advance();
          this.advance();
          left = this.parseLikeRhs(left, true, "LIKE");
          continue;
        }
        if (n.kind === "GLOB") {
          this.advance();
          this.advance();
          left = this.parseLikeRhs(left, true, "GLOB");
          continue;
        }
        if (n.kind === "REGEXP") {
          this.advance();
          this.advance();
          const pattern = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
          left = {
            type: "unary",
            op: "NOT",
            expr: {
              type: "function",
              name: "REGEXP",
              distinct: false,
              args: [pattern, left],
              orderBy: [],
              filter: null,
            },
          };
          continue;
        }
        if (n.kind === "BETWEEN") {
          this.advance();
          this.advance();
          const lower = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
          this.expect("AND");
          const upper = this.parseExprPrec(PREC.AND + 1);
          left = { type: "between", not: true, expr: left, lower, upper };
          continue;
        }
      }

      if (this.at("IS") && PREC.IS_IN_LIKE >= minPrec) {
        this.advance();
        if (this.at("NOT") && this.peek().kind === "DISTINCT") {
          this.advance();
          this.advance();
          this.expect("FROM");
          const right = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
          left = { type: "binary", op: "IS NOT DISTINCT FROM", left, right };
          continue;
        }
        if (this.at("DISTINCT")) {
          this.advance();
          this.expect("FROM");
          const right = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
          left = { type: "binary", op: "IS DISTINCT FROM", left, right };
          continue;
        }
        const not = this.match("NOT");
        if (this.match("TRUE")) {
          left = { type: "is_bool", expr: left, not, sense: true };
          continue;
        }
        if (this.match("FALSE")) {
          left = { type: "is_bool", expr: left, not, sense: false };
          continue;
        }
        const right = this.parseIsRhs();
        left = { type: "binary", op: not ? "IS NOT" : "IS", left, right };
        continue;
      }

      if (this.at("IN") && PREC.IS_IN_LIKE >= minPrec) {
        this.advance();
        left = this.parseInRhs(left, false);
        continue;
      }
      if (this.at("LIKE") && PREC.IS_IN_LIKE >= minPrec) {
        this.advance();
        left = this.parseLikeRhs(left, false, "LIKE");
        continue;
      }
      if (this.at("GLOB") && PREC.IS_IN_LIKE >= minPrec) {
        this.advance();
        left = this.parseLikeRhs(left, false, "GLOB");
        continue;
      }
      if (this.at("REGEXP") && PREC.IS_IN_LIKE >= minPrec) {
        this.advance();
        const pattern = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
        left = { type: "function", name: "REGEXP", distinct: false, args: [pattern, left], orderBy: [], filter: null };
        continue;
      }
      if (this.at("MATCH") && PREC.IS_IN_LIKE >= minPrec) {
        this.advance();
        const right = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
        left = { type: "binary", op: "MATCH", left, right };
        continue;
      }
      if (this.at("BETWEEN") && PREC.IS_IN_LIKE >= minPrec) {
        this.advance();
        const lower = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
        this.expect("AND");
        const upper = this.parseExprPrec(PREC.AND + 1);
        left = { type: "between", not: false, expr: left, lower, upper };
        continue;
      }

      const bin = this.peekBinaryOp();
      if (!bin || bin.prec < minPrec) break;
      this.advance();
      const right = this.parseExprPrec(bin.prec + 1);
      left = { type: "binary", op: bin.op, left, right };
    }

    return left;
  }

  private peekBinaryOp(): { op: BinaryOp; prec: number } | null {
    const t = this.current();
    switch (t.kind) {
      case "OR":
        return { op: "OR", prec: PREC.OR };
      case "AND":
        return { op: "AND", prec: PREC.AND };
      case "CONCAT":
        return { op: "||", prec: PREC.CONCAT };
      case "JSON_ARROW":
        return { op: "->", prec: PREC.JSON_ARROW };
      case "JSON_ARROW2":
        return { op: "->>", prec: PREC.JSON_ARROW };
      case "PLUS":
        return { op: "+", prec: PREC.ADD };
      case "MINUS":
        return { op: "-", prec: PREC.ADD };
      case "STAR":
        return { op: "*", prec: PREC.MUL };
      case "SLASH":
        return { op: "/", prec: PREC.MUL };
      case "PERCENT":
        return { op: "%", prec: PREC.MUL };
      case "LT":
        return { op: "<", prec: PREC.COMPARE };
      case "LE":
        return { op: "<=", prec: PREC.COMPARE };
      case "GT":
        return { op: ">", prec: PREC.COMPARE };
      case "GE":
        return { op: ">=", prec: PREC.COMPARE };
      case "EQ":
        return { op: "=", prec: PREC.COMPARE };
      case "EQEQ":
        return { op: "==", prec: PREC.COMPARE };
      case "NE":
        return { op: t.value as "<>" | "!=", prec: PREC.COMPARE };
      case "AMP":
        return { op: "&", prec: PREC.BIT_AND };
      case "PIPE":
        return { op: "|", prec: PREC.BIT_OR };
      case "LSHIFT":
        return { op: "<<", prec: PREC.SHIFT };
      case "RSHIFT":
        return { op: ">>", prec: PREC.SHIFT };
      default:
        return null;
    }
  }

  private parseIsRhs(): Expr {
    if (this.match("NULL")) return { type: "null" };
    return this.parseExprPrec(PREC.IS_IN_LIKE + 1);
  }

  private parseInRhs(left: Expr, not: boolean): InExpr {
    if (this.match("LPAREN")) {
      if (this.at("SELECT") || this.at("WITH")) {
        const select = this.parseSelectStmt();
        this.expect("RPAREN");
        return { type: "in", not, expr: left, values: select };
      }
      const values: Expr[] = [];
      if (!this.at("RPAREN")) {
        do {
          values.push(this.parseExpr());
        } while (this.match("COMMA"));
      }
      this.expect("RPAREN");
      return { type: "in", not, expr: left, values };
    }
    this.syntaxError("expected ( after IN");
  }

  private parseLikeRhs(left: Expr, not: boolean, op: "LIKE" | "GLOB"): LikeExpr {
    const pattern = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
    let escapeExpr: Expr | null = null;
    if (this.match("ESCAPE")) escapeExpr = this.parseExprPrec(PREC.IS_IN_LIKE + 1);
    return { type: "like", not, op, expr: left, pattern, escape: escapeExpr };
  }

  private parsePostfix(expr: Expr): Expr {
    let result = expr;
    while (true) {
      if (this.match("COLLATE")) {
        const collation = this.parseIdent();
        result = { type: "collate", expr: result, collation };
        continue;
      }
      if (this.match("ISNULL")) {
        result = { type: "binary", op: "IS", left: result, right: { type: "null" } };
        continue;
      }
      if (this.match("NOTNULL")) {
        result = { type: "binary", op: "IS NOT", left: result, right: { type: "null" } };
        continue;
      }
      break;
    }
    return result;
  }

  private isNotKeywordCompound(): boolean {
    const n = this.peek();
    return n.kind === "IN" || n.kind === "LIKE" || n.kind === "GLOB" || n.kind === "BETWEEN" || n.kind === "REGEXP";
  }

  private parseUnaryExpr(): Expr {
    if (this.match("PLUS")) return { type: "unary", op: "+", expr: this.parseUnaryExpr() };
    if (this.match("MINUS")) return { type: "unary", op: "-", expr: this.parseUnaryExpr() };
    if (this.match("TILDE")) return { type: "unary", op: "~", expr: this.parseUnaryExpr() };
    if (this.match("EXISTS")) {
      this.expect("LPAREN");
      const select = this.parseSelectStmt();
      this.expect("RPAREN");
      return { type: "exists", not: false, select };
    }
    return this.parsePrimaryExpr();
  }

  private parsePrimaryExpr(): Expr {
    const t = this.current();

    if (this.match("NULL")) return { type: "null" };

    if (this.match("CASE")) {
      let base: Expr | null = null;
      if (!this.at("WHEN")) {
        base = this.parseExpr();
      }
      return this.parseCaseExpr(base);
    }

    if (this.match("CAST")) {
      this.expect("LPAREN");
      const expr = this.parseExpr();
      this.expect("AS");
      const typeName = this.parseTypeName();
      this.expect("RPAREN");
      return { type: "cast", expr, typeName };
    }

    if (this.at("CURRENT_DATE") || this.at("CURRENT_TIME") || this.at("CURRENT_TIMESTAMP")) {
      const tok = this.advance();
      return { type: "function", name: tok.value, distinct: false, args: [], orderBy: [], filter: null };
    }

    if (this.at("NUMBER")) {
      const tok = this.advance();
      return {
        type: "literal",
        value: tok.literal as number | bigint,
        forceReal: tok.forceReal || undefined,
      };
    }
    if (this.at("STRING")) {
      const tok = this.advance();
      return { type: "literal", value: tok.literal as string };
    }
    if (this.at("BLOB")) {
      const tok = this.advance();
      return { type: "literal", value: tok.literal as Uint8Array };
    }

    if (this.at("PARAM_POS")) {
      const tok = this.advance();
      const name = tok.index ?? 1;
      return { type: "parameter", name };
    }
    if (this.at("PARAM_NAMED")) {
      const tok = this.advance();
      return { type: "parameter", name: tok.value };
    }

    if (this.match("LPAREN")) {
      if (this.at("SELECT") || this.at("WITH")) {
        const select = this.parseSelectStmt();
        this.expect("RPAREN");
        return { type: "subquery", select };
      }
      if (this.at("RPAREN")) {
        this.syntaxError("empty expression");
      }
      const first = this.parseExpr();
      if (this.match("COMMA")) {
        const values = [first];
        do {
          values.push(this.parseExpr());
        } while (this.match("COMMA"));
        this.expect("RPAREN");
        return { type: "row", values };
      }
      this.expect("RPAREN");
      return first;
    }

    if (this.match("STAR")) {
      return { type: "column", table: null, name: "*" };
    }

    if (t.kind === "IDENT" || IDENT_KEYWORDS.has(t.kind)) {
      return this.parseIdentOrFunction();
    }

    this.syntaxError(`unexpected token ${t.kind} in expression`);
  }

  private parseIdentOrFunction(): Expr {
    const name = this.parseIdent();
    if (this.match("LPAREN")) {
      return this.finishCall(name);
    }
    if (this.match("DOT")) {
      const col = this.parseIdent();
      return { type: "column", table: name, name: col };
    }
    return { type: "column", table: null, name };
  }

  private finishCall(name: string): Expr {
    let distinct = false;
    if (this.match("DISTINCT")) distinct = true;
    else this.match("ALL");

    let args: Expr[] | "*";
    let filter: Expr | null = null;

    if (this.match("STAR")) {
      args = "*";
    } else {
      args = [];
      if (!this.at("RPAREN")) {
        do {
          (args as Expr[]).push(this.parseExpr());
        } while (this.match("COMMA"));
      }
    }
    const orderBy = this.parseOrderBy();
    this.expect("RPAREN");

    if (this.check("IGNORE", "RESPECT")) {
      this.advance();
      this.match("NULLS");
      throw new SqliteError('near "NULLS": syntax error', "syntax");
    }

    if (this.match("FILTER")) {
      this.expect("LPAREN");
      this.expect("WHERE");
      filter = this.parseExpr();
      this.expect("RPAREN");
    }

    const upper = name.toUpperCase();
    const argCount = args === "*" ? 1 : args.length;
    // min()/max() with 2+ args are scalar; single-arg (or *) forms are aggregates.
    const isAgg = AGGREGATE_FUNCTIONS.has(upper) && !(argCount >= 2 && (upper === "MIN" || upper === "MAX"));

    if (this.match("OVER")) {
      let window: WindowSpec;
      if (this.at("IDENT") || IDENT_KEYWORDS.has(this.current().kind)) {
        const winName = this.parseIdent();
        window = { partitionBy: [], orderBy: [], frame: null, ref: winName };
      } else {
        this.expect("LPAREN");
        window = this.parseWindowSpec();
        this.expect("RPAREN");
      }
      const func = isAgg
        ? { type: "aggregate" as const, name: upper, distinct, args, orderBy, filter }
        : { type: "function" as const, name, distinct, args, orderBy, filter };
      return { type: "window", func, window };
    }

    if (isAgg) {
      return { type: "aggregate", name: upper, distinct, args, orderBy, filter };
    }
    return { type: "function", name, distinct, args, orderBy, filter };
  }

  private parseCaseExpr(base: Expr | null): CaseExpr {
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.match("WHEN")) {
      const when = this.parseExpr();
      this.expect("THEN");
      const then = this.parseExpr();
      whens.push({ when, then });
    }
    let elseExpr: Expr | null = null;
    if (this.match("ELSE")) elseExpr = this.parseExpr();
    this.expect("END");
    return { type: "case", base, whens, else: elseExpr };
  }

  private parseWindowSpec(): WindowSpec {
    const partitionBy: Expr[] = [];
    const orderBy: OrderByItem[] = [];
    let frame: FrameSpec | null = null;

    if (this.match("PARTITION")) {
      this.expect("BY");
      do {
        partitionBy.push(this.parseExpr());
      } while (this.match("COMMA"));
    }

    if (this.match("ORDER")) {
      this.expect("BY");
      do {
        const expr = this.parseExpr();
        let dir: "ASC" | "DESC" = "ASC";
        if (this.match("ASC")) dir = "ASC";
        else if (this.match("DESC")) dir = "DESC";
        let nulls: "FIRST" | "LAST" | null = null;
        if (this.match("NULLS")) {
          if (this.match("FIRST")) nulls = "FIRST";
          else if (this.match("LAST")) nulls = "LAST";
        }
        orderBy.push({ expr, dir, nulls });
      } while (this.match("COMMA"));
    }

    if (this.check("IGNORE", "RESPECT")) {
      const keyword = this.advance().value.toUpperCase();
      this.match("NULLS");
      throw new SqliteError(`near "${keyword}": syntax error`, "syntax");
    }

    if (this.check("ROWS", "RANGE", "GROUPS")) {
      frame = this.parseFrameSpec();
    }

    return { partitionBy, orderBy, frame };
  }

  private parseFrameSpec(): FrameSpec {
    let type: FrameSpec["type"] = "ROWS";
    if (this.match("RANGE")) type = "RANGE";
    else if (this.match("GROUPS")) type = "GROUPS";
    else this.expect("ROWS");

    let start: FrameBound;
    let end: FrameBound;

    if (this.match("BETWEEN")) {
      start = this.parseFrameBound(true);
      this.expect("AND");
      end = this.parseFrameBound(false);
    } else {
      start = this.parseFrameBound(true);
      end = { kind: "current_row" };
    }

    let exclude: FrameSpec["exclude"] = null;
    if (this.match("EXCLUDE")) {
      if (this.match("NO")) {
        this.expect("OTHERS");
        exclude = "no_others";
      } else if (this.match("CURRENT")) {
        this.expect("ROW");
        exclude = "current_row";
      } else if (this.match("GROUP")) exclude = "group";
      else if (this.match("TIES")) exclude = "ties";
      else this.syntaxError("expected EXCLUDE CURRENT ROW, GROUP, TIES, or NO OTHERS");
    }

    return { type, start, end, exclude };
  }

  private parseFrameBound(precedingSide: boolean): FrameBound {
    if (this.match("UNBOUNDED")) {
      if (this.match("PRECEDING")) return { kind: "unbounded_preceding" };
      this.expect("FOLLOWING");
      return { kind: "unbounded_following" };
    }
    if (this.match("CURRENT")) {
      this.expect("ROW");
      return { kind: "current_row" };
    }
    const expr = this.parseExpr();
    if (this.match("PRECEDING")) return { kind: "preceding", expr };
    if (this.match("FOLLOWING")) return { kind: "following", expr };
    if (precedingSide) return { kind: "preceding", expr };
    return { kind: "following", expr };
  }
}

export function parseTokens(tokens: Token[], source = ""): Statement[] {
  return new Parser(tokens, source).parseStatements();
}

/** Parse SQL into AST statements paired with source slices. */
export function parseTokenUnits(tokens: Token[], source: string): ParsedUnit[] {
  return new Parser(tokens, source).parseUnits();
}
