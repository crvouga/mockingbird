import { pgError } from "../errors/error.ts";

export type TokenType =
  | "ident" // unquoted identifier / keyword, value lowercased
  | "quoted_ident" // "Quoted" identifier, value as written (unescaped)
  | "string" // string literal, value unescaped
  | "bitstring" // B'...' or X'...' literal, value with leading b/x
  | "number" // numeric literal, raw text (underscores stripped)
  | "param" // $n positional parameter, value is n as string
  | "op" // operator, e.g. + - * / < <= <> = ~~ ::
  | "punct" // ( ) [ ] , ; .
  | "eof";

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  /** byte offset in the source (for error positions) */
  readonly pos: number;
}

const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_CONT = /[A-Za-z0-9_$\u0080-\uffff]/;

/** Characters that can form multi-char operators (PG lexer op charset). */
const OP_CHARS = new Set(["+", "-", "*", "/", "<", ">", "=", "~", "!", "@", "#", "%", "^", "&", "|", "`", "?"]);

function syntaxError(message: string): never {
  throw pgError("syntax", message);
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;

  const push = (type: TokenType, value: string, pos: number): void => {
    tokens.push({ type, value, pos });
  };

  while (i < n) {
    const c = sql[i]!;

    // whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }

    // line comment
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    // block comment (nested)
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) syntaxError("unterminated /* comment");
      continue;
    }

    // dollar-quoted string: $$...$$ or $tag$...$tag$
    if (c === "$") {
      const m = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(i));
      if (m) {
        const open = m[0];
        const start = i + open.length;
        const end = sql.indexOf(open, start);
        if (end === -1) syntaxError("unterminated dollar-quoted string");
        push("string", sql.slice(start, end), i);
        i = end + open.length;
        continue;
      }
      // positional parameter $1
      const pm = /^\$(\d+)/.exec(sql.slice(i));
      if (pm) {
        push("param", pm[1]!, i);
        i += pm[0].length;
        continue;
      }
      syntaxError(`syntax error at or near "$"`);
    }

    // quoted identifier
    if (c === '"') {
      let out = "";
      let j = i + 1;
      for (;;) {
        if (j >= n) syntaxError("unterminated quoted identifier");
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            out += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        out += sql[j];
        j++;
      }
      if (out.length === 0) syntaxError('zero-length delimited identifier at or near """"');
      push("quoted_ident", out, i);
      i = j;
      continue;
    }

    // string literals: '...', E'...', B'...', X'...'
    if (c === "'") {
      const { value, next } = scanStandardString(sql, i);
      push("string", value, i);
      i = next;
      continue;
    }
    if ((c === "e" || c === "E") && sql[i + 1] === "'") {
      const { value, next } = scanEscapeString(sql, i + 1);
      push("string", value, i);
      i = next;
      continue;
    }
    if ((c === "b" || c === "B") && sql[i + 1] === "'") {
      const { value, next } = scanStandardString(sql, i + 1);
      if (!/^[01]*$/.test(value)) syntaxError(`"${value}" is not a valid binary digit string`);
      push("bitstring", `b${value}`, i);
      i = next;
      continue;
    }
    if ((c === "x" || c === "X") && sql[i + 1] === "'") {
      const { value, next } = scanStandardString(sql, i + 1);
      if (!/^[0-9a-fA-F]*$/.test(value)) syntaxError(`"${value}" is not a valid hexadecimal digit string`);
      push("bitstring", `x${value}`, i);
      i = next;
      continue;
    }
    // U&'...' unicode strings
    if ((c === "u" || c === "U") && sql[i + 1] === "&" && sql[i + 2] === "'") {
      const { value, next } = scanStandardString(sql, i + 2);
      push("string", decodeUnicodeEscapes(value), i);
      i = next;
      continue;
    }

    // numbers
    if (/\d/.test(c) || (c === "." && /\d/.test(sql[i + 1] ?? ""))) {
      const start = i;
      // 0x / 0o / 0b integer literals (PG16+)
      const radix = /^0[xX][0-9a-fA-F_]+|^0[oO][0-7_]+|^0[bB][01_]+/.exec(sql.slice(i));
      if (radix) {
        const raw = radix[0];
        i += raw.length;
        const clean = raw.replaceAll("_", "");
        const v = BigInt(clean);
        push("number", v.toString(), start);
        continue;
      }
      let j = i;
      while (j < n && /[\d_]/.test(sql[j]!)) j++;
      if (sql[j] === ".") {
        // avoid consuming `..` (not PG) or `.` followed by ident? In PG, 1.e5 valid.
        j++;
        while (j < n && /[\d_]/.test(sql[j]!)) j++;
      }
      if (sql[j] === "e" || sql[j] === "E") {
        let k = j + 1;
        if (sql[k] === "+" || sql[k] === "-") k++;
        if (/\d/.test(sql[k] ?? "")) {
          k++;
          while (k < n && /[\d_]/.test(sql[k]!)) k++;
          j = k;
        }
      }
      const raw = sql.slice(i, j).replaceAll("_", "");
      // trailing identifier chars directly after number are a syntax error in PG
      if (j < n && IDENT_START.test(sql[j]!)) {
        syntaxError(`trailing junk after numeric literal at or near "${sql.slice(i, j + 1)}"`);
      }
      push("number", raw, start);
      i = j;
      continue;
    }

    // identifiers / keywords
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_CONT.test(sql[j]!)) j++;
      push("ident", sql.slice(i, j).toLowerCase(), i);
      i = j;
      continue;
    }

    // punctuation
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === "," || c === ";") {
      push("punct", c, i);
      i++;
      continue;
    }
    if (c === ".") {
      push("punct", ".", i);
      i++;
      continue;
    }
    if (c === ":") {
      if (sql[i + 1] === ":") {
        push("op", "::", i);
        i += 2;
        continue;
      }
      if (sql[i + 1] === "=") {
        push("op", ":=", i);
        i += 2;
        continue;
      }
      // array slice bound separator: a[1:3]
      push("op", ":", i);
      i++;
      continue;
    }

    // operators (PG rule: multi-char ops ending in + or - must contain ~!@#%^&|`?)
    if (OP_CHARS.has(c)) {
      let j = i;
      while (j < n && OP_CHARS.has(sql[j]!)) {
        // stop at comment starts
        if (sql[j] === "-" && sql[j + 1] === "-") break;
        if (sql[j] === "/" && sql[j + 1] === "*") break;
        j++;
      }
      let opText = sql.slice(i, j);
      // PG trims trailing +/- unless the op contains a "special" char
      const special = /[~!@#%^&|`?]/;
      while (opText.length > 1 && (opText.endsWith("+") || opText.endsWith("-")) && !special.test(opText)) {
        opText = opText.slice(0, -1);
      }
      if (opText.length === 0) syntaxError(`syntax error at or near "${c}"`);
      // split into known compound tokens greedily
      push("op", opText, i);
      i += opText.length;
      continue;
    }

    syntaxError(`syntax error at or near "${c}"`);
  }

  push("eof", "", i);
  return tokens;
}

function scanStandardString(sql: string, start: number): { value: string; next: number } {
  // start points at the opening quote
  let out = "";
  let i = start + 1;
  const n = sql.length;
  for (;;) {
    if (i >= n) syntaxError("unterminated quoted string");
    const c = sql[i]!;
    if (c === "'") {
      if (sql[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      i++;
      // literal continuation across newline: '...'   '...'
      let j = i;
      let sawNewline = false;
      while (j < n && /[ \t\r\n\f\v]/.test(sql[j]!)) {
        if (sql[j] === "\n") sawNewline = true;
        j++;
      }
      if (sawNewline && sql[j] === "'") {
        i = j + 1;
        continue;
      }
      return { value: out, next: i };
    }
    out += c;
    i++;
  }
}

function scanEscapeString(sql: string, start: number): { value: string; next: number } {
  let out = "";
  let i = start + 1;
  const n = sql.length;
  for (;;) {
    if (i >= n) syntaxError("unterminated quoted string");
    const c = sql[i]!;
    if (c === "'") {
      if (sql[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, next: i + 1 };
    }
    if (c === "\\") {
      const e = sql[i + 1];
      i += 2;
      switch (e) {
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "'":
          out += "'";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "x": {
          const m = /^[0-9a-fA-F]{1,2}/.exec(sql.slice(i));
          if (m) {
            out += String.fromCharCode(Number.parseInt(m[0], 16));
            i += m[0].length;
          } else out += "x";
          break;
        }
        case "u": {
          const m = /^[0-9a-fA-F]{4}/.exec(sql.slice(i));
          if (!m) syntaxError("invalid Unicode escape");
          out += String.fromCharCode(Number.parseInt(m[0], 16));
          i += 4;
          break;
        }
        case "U": {
          const m = /^[0-9a-fA-F]{8}/.exec(sql.slice(i));
          if (!m) syntaxError("invalid Unicode escape");
          out += String.fromCodePoint(Number.parseInt(m[0], 16));
          i += 8;
          break;
        }
        default:
          if (e !== undefined && /[0-7]/.test(e)) {
            const m = /^[0-7]{1,3}/.exec(sql.slice(i - 1))!;
            out += String.fromCharCode(Number.parseInt(m[0], 8));
            i = i - 1 + m[0].length;
          } else {
            out += e ?? "";
          }
      }
      continue;
    }
    out += c;
    i++;
  }
}

function decodeUnicodeEscapes(value: string): string {
  return value.replaceAll(/\\(?:([0-9a-fA-F]{4})|\+([0-9a-fA-F]{6})|\\)/g, (m, four, six) => {
    if (m === "\\\\") return "\\";
    const code = Number.parseInt(four ?? six, 16);
    return String.fromCodePoint(code);
  });
}
