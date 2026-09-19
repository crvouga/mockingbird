import { SqliteError } from "../errors/index.ts";
import { sqliteAtoF } from "../types/sqlite-atof.ts";

/** Lexer token kind: keywords, literals, operators, and punctuation. */
export type TokenKind =
  | "EOF"
  | "IDENT"
  | "STRING"
  | "NUMBER"
  | "BLOB"
  | "PARAM_POS"
  | "PARAM_NAMED"
  | "DOT"
  | "COMMA"
  | "SEMI"
  | "LPAREN"
  | "RPAREN"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "EQ"
  | "EQEQ"
  | "NE"
  | "LT"
  | "LE"
  | "GT"
  | "GE"
  | "CONCAT"
  | "AMP"
  | "PIPE"
  | "LSHIFT"
  | "RSHIFT"
  | "JSON_ARROW"
  | "JSON_ARROW2"
  | "TILDE"
  // keywords
  | "ABORT"
  | "ACTION"
  | "ADD"
  | "AFTER"
  | "ALL"
  | "ALTER"
  | "ANALYZE"
  | "AND"
  | "AS"
  | "ASC"
  | "ATTACH"
  | "AUTOINCREMENT"
  | "BEFORE"
  | "BEGIN"
  | "BETWEEN"
  | "BY"
  | "CASCADE"
  | "CASE"
  | "CAST"
  | "CHECK"
  | "COLLATE"
  | "COLUMN"
  | "COMMIT"
  | "CONFLICT"
  | "CONSTRAINT"
  | "CREATE"
  | "CROSS"
  | "CURRENT"
  | "CURRENT_DATE"
  | "CURRENT_TIME"
  | "CURRENT_TIMESTAMP"
  | "DATABASE"
  | "DEFAULT"
  | "DEFERRABLE"
  | "DEFERRED"
  | "DELETE"
  | "DESC"
  | "DETACH"
  | "DISTINCT"
  | "DO"
  | "DROP"
  | "EACH"
  | "ELSE"
  | "END"
  | "ESCAPE"
  | "EXCEPT"
  | "EXCLUDE"
  | "EXCLUSIVE"
  | "EXISTS"
  | "EXPLAIN"
  | "FAIL"
  | "FILTER"
  | "FIRST"
  | "FOLLOWING"
  | "FOR"
  | "FOREIGN"
  | "FROM"
  | "FULL"
  | "FALSE"
  | "GENERATED"
  | "GLOB"
  | "GROUP"
  | "GROUPS"
  | "HAVING"
  | "IF"
  | "IGNORE"
  | "IMMEDIATE"
  | "IN"
  | "INDEX"
  | "INDEXED"
  | "INITIALLY"
  | "INNER"
  | "INSERT"
  | "INSTEAD"
  | "INTERSECT"
  | "INTO"
  | "IS"
  | "ISNULL"
  | "JOIN"
  | "KEY"
  | "LAST"
  | "LEFT"
  | "LIKE"
  | "LIMIT"
  | "MATCH"
  | "MATERIALIZED"
  | "NATURAL"
  | "NO"
  | "NOT"
  | "NOTHING"
  | "NOTNULL"
  | "NULL"
  | "NULLS"
  | "OF"
  | "OFFSET"
  | "ON"
  | "OR"
  | "ORDER"
  | "OTHERS"
  | "OUTER"
  | "OVER"
  | "PARTITION"
  | "PLAN"
  | "PRAGMA"
  | "PRECEDING"
  | "PRIMARY"
  | "QUERY"
  | "RAISE"
  | "RANGE"
  | "RECURSIVE"
  | "REFERENCES"
  | "REGEXP"
  | "REINDEX"
  | "RELEASE"
  | "RENAME"
  | "REPLACE"
  | "RESTRICT"
  | "RESPECT"
  | "RETURNING"
  | "RIGHT"
  | "ROLLBACK"
  | "ROW"
  | "ROWS"
  | "SAVEPOINT"
  | "SELECT"
  | "SET"
  | "TABLE"
  | "TEMP"
  | "TEMPORARY"
  | "THEN"
  | "TIES"
  | "TO"
  | "TRANSACTION"
  | "TRIGGER"
  | "TRUE"
  | "UNBOUNDED"
  | "UNION"
  | "UNIQUE"
  | "UPDATE"
  | "USING"
  | "VACUUM"
  | "VALUES"
  | "VIEW"
  | "VIRTUAL"
  | "WHEN"
  | "WHERE"
  | "WINDOW"
  | "WITH"
  | "WITHOUT";

/** A single lexer token from {@link tokenize}. */
export interface Token {
  kind: TokenKind;
  value: string;
  /** For NUMBER/BLOB/STRING, the parsed value */
  literal?: string | number | bigint | Uint8Array | null;
  /** True when a NUMBER token used float/scientific syntax. */
  forceReal?: boolean;
  index?: number; // for PARAM_POS
  line: number;
  column: number;
  start: number;
  end: number;
}

const KEYWORDS: Record<string, TokenKind> = {
  ABORT: "ABORT",
  ACTION: "ACTION",
  ADD: "ADD",
  AFTER: "AFTER",
  ALL: "ALL",
  ALTER: "ALTER",
  ANALYZE: "ANALYZE",
  AND: "AND",
  AS: "AS",
  ASC: "ASC",
  ATTACH: "ATTACH",
  AUTOINCREMENT: "AUTOINCREMENT",
  BEFORE: "BEFORE",
  BEGIN: "BEGIN",
  BETWEEN: "BETWEEN",
  BY: "BY",
  CASCADE: "CASCADE",
  CASE: "CASE",
  CAST: "CAST",
  CHECK: "CHECK",
  COLLATE: "COLLATE",
  COLUMN: "COLUMN",
  COMMIT: "COMMIT",
  CONFLICT: "CONFLICT",
  CONSTRAINT: "CONSTRAINT",
  CREATE: "CREATE",
  CROSS: "CROSS",
  CURRENT: "CURRENT",
  CURRENT_DATE: "CURRENT_DATE",
  CURRENT_TIME: "CURRENT_TIME",
  CURRENT_TIMESTAMP: "CURRENT_TIMESTAMP",
  DATABASE: "DATABASE",
  DEFAULT: "DEFAULT",
  DEFERRABLE: "DEFERRABLE",
  DEFERRED: "DEFERRED",
  DELETE: "DELETE",
  DESC: "DESC",
  DETACH: "DETACH",
  DISTINCT: "DISTINCT",
  DO: "DO",
  DROP: "DROP",
  EACH: "EACH",
  ELSE: "ELSE",
  END: "END",
  ESCAPE: "ESCAPE",
  EXCEPT: "EXCEPT",
  EXCLUDE: "EXCLUDE",
  EXCLUSIVE: "EXCLUSIVE",
  EXISTS: "EXISTS",
  EXPLAIN: "EXPLAIN",
  FAIL: "FAIL",
  FILTER: "FILTER",
  FIRST: "FIRST",
  FOLLOWING: "FOLLOWING",
  FOR: "FOR",
  FOREIGN: "FOREIGN",
  FROM: "FROM",
  FULL: "FULL",
  FALSE: "FALSE",
  GENERATED: "GENERATED",
  GLOB: "GLOB",
  GROUP: "GROUP",
  GROUPS: "GROUPS",
  HAVING: "HAVING",
  IF: "IF",
  IGNORE: "IGNORE",
  IMMEDIATE: "IMMEDIATE",
  IN: "IN",
  INDEX: "INDEX",
  INDEXED: "INDEXED",
  INITIALLY: "INITIALLY",
  INNER: "INNER",
  INSERT: "INSERT",
  INSTEAD: "INSTEAD",
  INTERSECT: "INTERSECT",
  INTO: "INTO",
  IS: "IS",
  ISNULL: "ISNULL",
  JOIN: "JOIN",
  KEY: "KEY",
  LAST: "LAST",
  LEFT: "LEFT",
  LIKE: "LIKE",
  LIMIT: "LIMIT",
  MATCH: "MATCH",
  MATERIALIZED: "MATERIALIZED",
  NATURAL: "NATURAL",
  NO: "NO",
  NOT: "NOT",
  NOTHING: "NOTHING",
  NOTNULL: "NOTNULL",
  NULL: "NULL",
  NULLS: "NULLS",
  OF: "OF",
  OFFSET: "OFFSET",
  ON: "ON",
  OR: "OR",
  ORDER: "ORDER",
  OTHERS: "OTHERS",
  OUTER: "OUTER",
  OVER: "OVER",
  PARTITION: "PARTITION",
  PLAN: "PLAN",
  PRAGMA: "PRAGMA",
  PRECEDING: "PRECEDING",
  PRIMARY: "PRIMARY",
  QUERY: "QUERY",
  RAISE: "RAISE",
  RANGE: "RANGE",
  RECURSIVE: "RECURSIVE",
  REFERENCES: "REFERENCES",
  REGEXP: "REGEXP",
  REINDEX: "REINDEX",
  RELEASE: "RELEASE",
  RENAME: "RENAME",
  REPLACE: "REPLACE",
  RESTRICT: "RESTRICT",
  RESPECT: "RESPECT",
  RETURNING: "RETURNING",
  RIGHT: "RIGHT",
  ROLLBACK: "ROLLBACK",
  ROW: "ROW",
  ROWS: "ROWS",
  SAVEPOINT: "SAVEPOINT",
  SELECT: "SELECT",
  SET: "SET",
  TABLE: "TABLE",
  TEMP: "TEMP",
  TEMPORARY: "TEMPORARY",
  THEN: "THEN",
  TIES: "TIES",
  TO: "TO",
  TRANSACTION: "TRANSACTION",
  TRIGGER: "TRIGGER",
  TRUE: "TRUE",
  UNBOUNDED: "UNBOUNDED",
  UNION: "UNION",
  UNIQUE: "UNIQUE",
  UPDATE: "UPDATE",
  USING: "USING",
  VACUUM: "VACUUM",
  VALUES: "VALUES",
  VIEW: "VIEW",
  VIRTUAL: "VIRTUAL",
  WHEN: "WHEN",
  WHERE: "WHERE",
  WINDOW: "WINDOW",
  WITH: "WITH",
  WITHOUT: "WITHOUT",
};

/**
 * Lex `input` into SQLite tokens (keywords, literals, operators, parameters).
 *
 * @param input - SQL source text.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  let nextParameterIndex = 1;
  const namedParameterIndexes = new Map<string, number>();

  const peek = (n = 0) => input[i + n] ?? "";
  const advance = () => {
    const ch = input[i++] ?? "";
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return ch;
  };

  const push = (
    kind: TokenKind,
    start: number,
    startLine: number,
    startCol: number,
    value: string,
    extra?: Partial<Token>,
  ) => {
    tokens.push({
      kind,
      value,
      line: startLine,
      column: startCol,
      start,
      end: i,
      ...extra,
    });
  };

  while (i < input.length) {
    const start = i;
    const startLine = line;
    const startCol = column;
    const ch = peek();

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      advance();
      continue;
    }

    // comments
    if (ch === "-" && peek(1) === "-") {
      while (i < input.length && peek() !== "\n") advance();
      continue;
    }
    if (ch === "/" && peek(1) === "*") {
      advance();
      advance();
      while (i < input.length && !(peek() === "*" && peek(1) === "/")) advance();
      if (i >= input.length) throw new SqliteError("unterminated comment", "syntax");
      advance();
      advance();
      continue;
    }

    // string
    if (ch === "'") {
      advance();
      let s = "";
      while (i < input.length) {
        const c = advance();
        if (c === "'") {
          if (peek() === "'") {
            advance();
            s += "'";
            continue;
          }
          push("STRING", start, startLine, startCol, s, { literal: s });
          break;
        }
        s += c;
      }
      if (tokens.at(-1)?.kind !== "STRING" || tokens.at(-1)?.start !== start) {
        throw new SqliteError("unrecognized token: incomplete string literal", "syntax");
      }
      continue;
    }

    // quoted identifier
    if (ch === '"' || ch === "[" || ch === "`") {
      const closer = ch === "[" ? "]" : ch;
      advance();
      let s = "";
      while (i < input.length) {
        const c = advance();
        if (c === closer) {
          if (ch === '"' && peek() === '"') {
            advance();
            s += '"';
            continue;
          }
          push("IDENT", start, startLine, startCol, s);
          break;
        }
        s += c;
      }
      if (tokens.at(-1)?.kind !== "IDENT" || tokens.at(-1)?.start !== start) {
        throw new SqliteError("unrecognized token: incomplete identifier", "syntax");
      }
      continue;
    }

    // blob X'ABCD'
    if ((ch === "x" || ch === "X") && peek(1) === "'") {
      advance();
      advance();
      let hex = "";
      while (i < input.length) {
        const c = advance();
        if (c === "'") break;
        if (!/[0-9a-fA-F]/.test(c)) {
          throw new SqliteError("unrecognized token: invalid blob literal", "syntax");
        }
        hex += c;
      }
      if (hex.length % 2 !== 0) {
        throw new SqliteError("unrecognized token: invalid blob literal", "syntax");
      }
      const bytes = new Uint8Array(hex.length / 2);
      for (let j = 0; j < bytes.length; j++) {
        bytes[j] = Number.parseInt(hex.slice(j * 2, j * 2 + 2), 16);
      }
      push("BLOB", start, startLine, startCol, hex, { literal: bytes });
      continue;
    }

    // parameters
    if (ch === "?") {
      advance();
      let num = "";
      while (/[0-9]/.test(peek())) num += advance();
      const index = num ? Number(num) : nextParameterIndex;
      nextParameterIndex = Math.max(nextParameterIndex, index + 1);
      push("PARAM_POS", start, startLine, startCol, num ? `?${num}` : "?", { index });
      continue;
    }
    if (ch === ":" || ch === "@" || ch === "$") {
      const prefix = advance();
      let name = "";
      while (/[A-Za-z0-9_]/.test(peek())) name += advance();
      if (!name) throw new SqliteError("unrecognized token near parameter", "syntax");
      const parameter = `${prefix}${name}`;
      if (!namedParameterIndexes.has(parameter.toLowerCase())) {
        namedParameterIndexes.set(parameter.toLowerCase(), nextParameterIndex++);
      }
      push("PARAM_NAMED", start, startLine, startCol, parameter);
      continue;
    }

    // numbers
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(peek(1)))) {
      let raw = "";
      let isFloat = false;
      if (ch === ".") {
        isFloat = true;
        raw += advance();
        while (/[0-9]/.test(peek())) raw += advance();
      } else {
        while (/[0-9]/.test(peek())) raw += advance();
        if (peek() === ".") {
          isFloat = true;
          raw += advance();
          while (/[0-9]/.test(peek())) raw += advance();
        }
      }
      if (peek() === "e" || peek() === "E") {
        isFloat = true;
        raw += advance();
        if (peek() === "+" || peek() === "-") raw += advance();
        if (!/[0-9]/.test(peek())) throw new SqliteError("unrecognized token near number", "syntax");
        while (/[0-9]/.test(peek())) raw += advance();
      }
      let literal: number | bigint;
      if (!isFloat && raw.length > 15) {
        try {
          literal = BigInt(raw);
        } catch {
          literal = Number(raw);
        }
      } else if (!isFloat) {
        const n = Number(raw);
        literal = Number.isSafeInteger(n) ? n : BigInt(raw);
      } else {
        literal = sqliteAtoF(raw);
      }
      push("NUMBER", start, startLine, startCol, raw, { literal, forceReal: isFloat || undefined });
      continue;
    }

    // operators / punctuation
    const two = ch + peek(1);
    const three = two + peek(2);
    if (three === "<<" || three === ">>") {
      // not three char; handle below
    }
    if (two === "||") {
      advance();
      advance();
      push("CONCAT", start, startLine, startCol, "||");
      continue;
    }
    if (three === "->>") {
      advance();
      advance();
      advance();
      push("JSON_ARROW2", start, startLine, startCol, "->>");
      continue;
    }
    if (two === "->") {
      advance();
      advance();
      push("JSON_ARROW", start, startLine, startCol, "->");
      continue;
    }
    if (two === "<<") {
      advance();
      advance();
      push("LSHIFT", start, startLine, startCol, "<<");
      continue;
    }
    if (two === ">>") {
      advance();
      advance();
      push("RSHIFT", start, startLine, startCol, ">>");
      continue;
    }
    if (two === "==") {
      advance();
      advance();
      push("EQEQ", start, startLine, startCol, "==");
      continue;
    }
    if (two === "!=" || two === "<>") {
      advance();
      advance();
      push("NE", start, startLine, startCol, two);
      continue;
    }
    if (two === "<=") {
      advance();
      advance();
      push("LE", start, startLine, startCol, "<=");
      continue;
    }
    if (two === ">=") {
      advance();
      advance();
      push("GE", start, startLine, startCol, ">=");
      continue;
    }

    const singles: Record<string, TokenKind> = {
      ".": "DOT",
      ",": "COMMA",
      ";": "SEMI",
      "(": "LPAREN",
      ")": "RPAREN",
      "+": "PLUS",
      "-": "MINUS",
      "*": "STAR",
      "/": "SLASH",
      "%": "PERCENT",
      "=": "EQ",
      "<": "LT",
      ">": "GT",
      "&": "AMP",
      "|": "PIPE",
      "~": "TILDE",
    };
    if (singles[ch]) {
      advance();
      push(singles[ch]!, start, startLine, startCol, ch);
      continue;
    }

    // identifier / keyword
    if (/[A-Za-z_]/.test(ch)) {
      let s = "";
      while (/[A-Za-z0-9_$]/.test(peek())) s += advance();
      const upper = s.toUpperCase();
      const kw = KEYWORDS[upper];
      if (kw) push(kw, start, startLine, startCol, s);
      else push("IDENT", start, startLine, startCol, s);
      continue;
    }

    throw new SqliteError(`unrecognized token: "${ch}"`, "syntax");
  }

  tokens.push({
    kind: "EOF",
    value: "",
    line,
    column,
    start: i,
    end: i,
  });
  return tokens;
}

export function isKeyword(kind: TokenKind): boolean {
  return (
    kind !== "EOF" &&
    kind !== "IDENT" &&
    kind !== "STRING" &&
    kind !== "NUMBER" &&
    kind !== "BLOB" &&
    kind !== "PARAM_POS" &&
    kind !== "PARAM_NAMED" &&
    ![
      "DOT",
      "COMMA",
      "SEMI",
      "LPAREN",
      "RPAREN",
      "PLUS",
      "MINUS",
      "STAR",
      "SLASH",
      "PERCENT",
      "EQ",
      "EQEQ",
      "NE",
      "LT",
      "LE",
      "GT",
      "GE",
      "CONCAT",
      "AMP",
      "PIPE",
      "LSHIFT",
      "RSHIFT",
      "JSON_ARROW",
      "JSON_ARROW2",
      "TILDE",
    ].includes(kind)
  );
}
