import { SqliteError } from "../../errors/index.ts";

export type FtsQueryNode =
  | { type: "term"; value: string; prefix: boolean; column: string | null; columns: string[] | null }
  | {
      type: "phrase";
      terms: Array<{ value: string; prefix: boolean }>;
      column: string | null;
      columns: string[] | null;
    }
  | { type: "near"; children: FtsQueryNode[]; distance: number; column: string | null; columns: string[] | null }
  | { type: "and"; children: FtsQueryNode[] }
  | { type: "or"; children: FtsQueryNode[] }
  | { type: "not"; child: FtsQueryNode }
  | { type: "true" };

type Tok =
  | { kind: "TERM"; value: string; prefix: boolean }
  | { kind: "STRING"; value: string }
  | { kind: "AND" }
  | { kind: "OR" }
  | { kind: "NOT" }
  | { kind: "NEAR" }
  | { kind: "LPAREN" }
  | { kind: "RPAREN" }
  | { kind: "COLON" }
  | { kind: "COMMA" }
  | { kind: "LBRACE" }
  | { kind: "RBRACE" }
  | { kind: "EOF" };

/**
 * Parse an FTS5 MATCH expression.
 * Implicit AND between adjacent terms; OR binds looser than AND; NOT is binary (a NOT b).
 */
export function parseFts5Query(input: string): FtsQueryNode {
  const tokens = lexFts5(input);
  let i = 0;

  function peek(): Tok {
    return tokens[i] ?? { kind: "EOF" };
  }
  function next(): Tok {
    return tokens[i++] ?? { kind: "EOF" };
  }
  function expect(kind: Tok["kind"]): Tok {
    const t = next();
    if (t.kind !== kind) throw new SqliteError(`fts5: syntax error near "${displayTok(t)}"`, "syntax");
    return t;
  }

  function parseExpr(): FtsQueryNode {
    return parseOr();
  }

  function parseOr(): FtsQueryNode {
    let left = parseAnd();
    while (peek().kind === "OR") {
      next();
      const right = parseAnd();
      if (left.type === "or") left = { type: "or", children: [...left.children, right] };
      else left = { type: "or", children: [left, right] };
    }
    return left;
  }

  function parseAnd(): FtsQueryNode {
    let left = parseUnary();
    while (true) {
      const p = peek();
      if (p.kind === "EOF" || p.kind === "RPAREN" || p.kind === "OR" || p.kind === "COMMA" || p.kind === "RBRACE")
        break;
      if (p.kind === "AND") {
        next();
        const right = parseUnary();
        if (left.type === "and") left = { type: "and", children: [...left.children, right] };
        else left = { type: "and", children: [left, right] };
        continue;
      }
      if (p.kind === "NOT") {
        next();
        const right = parseUnary();
        left = { type: "and", children: [left, { type: "not", child: right }] };
        continue;
      }
      // implicit AND
      if (
        p.kind === "TERM" ||
        p.kind === "STRING" ||
        p.kind === "LPAREN" ||
        p.kind === "NEAR" ||
        p.kind === "LBRACE" ||
        p.kind === "COLON"
      ) {
        // COLON alone is invalid here — column filter starts with TERM or LBRACE
        if (p.kind === "COLON") break;
        const right = parseUnary();
        if (left.type === "and") left = { type: "and", children: [...left.children, right] };
        else left = { type: "and", children: [left, right] };
        continue;
      }
      break;
    }
    return left;
  }

  function parseUnary(): FtsQueryNode {
    // column filter: {a b} : expr   or   col : expr
    const filtered = tryParseColumnFilter();
    if (filtered) return filtered;

    const p = peek();
    if (p.kind === "LPAREN") {
      next();
      const inner = parseExpr();
      expect("RPAREN");
      return inner;
    }
    if (p.kind === "NEAR") {
      next();
      expect("LPAREN");
      const children: FtsQueryNode[] = [];
      children.push(parseUnary());
      while (peek().kind !== "COMMA" && peek().kind !== "RPAREN" && peek().kind !== "EOF") {
        children.push(parseUnary());
      }
      let distance = 10;
      if (peek().kind === "COMMA") {
        next();
        const distTok = next();
        if (distTok.kind !== "TERM") throw new SqliteError("fts5: syntax error near NEAR", "syntax");
        distance = Number(distTok.value);
        if (!Number.isFinite(distance)) throw new SqliteError("fts5: syntax error near NEAR", "syntax");
      }
      expect("RPAREN");
      return { type: "near", children, distance, column: null, columns: null };
    }
    if (p.kind === "STRING") {
      next();
      const terms = p.value
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => {
          const prefix = part.endsWith("*");
          return { value: prefix ? part.slice(0, -1) : part, prefix };
        });
      return { type: "phrase", terms, column: null, columns: null };
    }
    if (p.kind === "TERM") {
      next();
      if (p.prefix && (p.value === "" || p.value.includes("*"))) {
        throw new SqliteError(`unknown special query: ${p.value}`, "other");
      }
      return { type: "term", value: p.value, prefix: p.prefix, column: null, columns: null };
    }
    throw new SqliteError(`fts5: syntax error near "${displayTok(p)}"`, "syntax");
  }

  function tryParseColumnFilter(): FtsQueryNode | null {
    const save = i;
    let column: string | null = null;
    let columns: string[] | null = null;

    if (peek().kind === "LBRACE") {
      next();
      columns = [];
      while (peek().kind !== "RBRACE" && peek().kind !== "EOF") {
        if (peek().kind === "TERM") {
          const termTok = next();
          if (termTok.kind !== "TERM") {
            i = save;
            return null;
          }
          columns.push(termTok.value.toLowerCase());
        } else if (peek().kind === "COMMA") {
          next();
        } else {
          i = save;
          return null;
        }
      }
      if (peek().kind !== "RBRACE") {
        i = save;
        return null;
      }
      next();
    } else if (peek().kind === "TERM") {
      const name = next();
      if (name.kind !== "TERM") {
        i = save;
        return null;
      }
      if (peek().kind !== "COLON") {
        i = save;
        return null;
      }
      column = name.value.toLowerCase();
    } else {
      return null;
    }

    if (peek().kind !== "COLON") {
      i = save;
      return null;
    }
    next(); // colon
    const inner = parseUnary();
    return applyColumn(inner, column, columns);
  }

  if (tokens.length === 1 && tokens[0]!.kind === "EOF") return { type: "true" };
  const root = parseExpr();
  if (peek().kind !== "EOF") throw new SqliteError(`fts5: syntax error near "${displayTok(peek())}"`, "syntax");
  return root;
}

function applyColumn(node: FtsQueryNode, column: string | null, columns: string[] | null): FtsQueryNode {
  switch (node.type) {
    case "term":
    case "phrase":
    case "near":
      return { ...node, column: column ?? node.column, columns: columns ?? node.columns };
    case "and":
    case "or":
      return { ...node, children: node.children.map((child) => applyColumn(child, column, columns)) };
    case "not":
      return { type: "not", child: applyColumn(node.child, column, columns) };
    case "true":
      return node;
  }
}

function lexFts5(input: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "LPAREN" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "RPAREN" });
      i++;
      continue;
    }
    if (ch === "{") {
      tokens.push({ kind: "LBRACE" });
      i++;
      continue;
    }
    if (ch === "}") {
      tokens.push({ kind: "RBRACE" });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ kind: "COLON" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "COMMA" });
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      let value = "";
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        value += input[i++];
      }
      if (input[i] === '"') i++;
      tokens.push({ kind: "STRING", value });
      continue;
    }
    // bare word
    let word = "";
    while (i < input.length && !/[\s(){}:,"]/.test(input[i]!)) word += input[i++];
    if (!word) {
      i++;
      continue;
    }
    const upper = word.toUpperCase();
    if (upper === "AND") tokens.push({ kind: "AND" });
    else if (upper === "OR") tokens.push({ kind: "OR" });
    else if (upper === "NOT") tokens.push({ kind: "NOT" });
    else if (upper === "NEAR") {
      // NEAR is a keyword only when followed by '('; otherwise it is a bare term.
      let j = i;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (input[j] === "(") tokens.push({ kind: "NEAR" });
      else {
        const prefix = word.endsWith("*");
        tokens.push({ kind: "TERM", value: prefix ? word.slice(0, -1) : word, prefix });
      }
    } else {
      const prefix = word.endsWith("*");
      tokens.push({ kind: "TERM", value: prefix ? word.slice(0, -1) : word, prefix });
    }
  }
  tokens.push({ kind: "EOF" });
  return tokens;
}

function displayTok(t: Tok): string {
  switch (t.kind) {
    case "TERM":
      return t.prefix ? `${t.value}*` : t.value;
    case "STRING":
      return `"${t.value}"`;
    case "EOF":
      return "";
    default:
      return t.kind;
  }
}

/** FTS3/4 query parser (ENABLE_FTS3_PARENTHESIS style). */
export function parseFts3Query(input: string): FtsQueryNode {
  return parseFts5Query(input);
}
