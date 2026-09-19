import { SqliteError } from "../../errors/index.ts";

export type FtsKind = "fts5" | "fts3" | "fts4";

export type FtsDetail = "full" | "column" | "none";

export interface FtsColumnDef {
  name: string;
  unindexed: boolean;
}

export interface FtsTokenizerConfig {
  /** Primary tokenizer name (unicode61, ascii, porter, trigram). */
  name: string;
  /** Base tokenizer when name is porter. */
  base?: string;
  removeDiacritics?: 0 | 1 | 2;
  tokenchars?: string;
  separators?: string;
  caseSensitive?: boolean; // trigram
  removeDiacriticsTrigram?: boolean;
}

export interface FtsTableOptions {
  columns: FtsColumnDef[];
  content: "normal" | "contentless" | "external";
  contentTable: string | null;
  contentRowid: string;
  contentlessDelete: boolean;
  prefix: number[];
  columnsize: boolean;
  detail: FtsDetail;
  tokendata: boolean;
  locale: boolean;
  tokenizer: FtsTokenizerConfig;
  /** FTS3/4 */
  languageid: string | null;
  notindexed: Set<string>;
}

const OPTION_NAMES = new Set([
  "tokenize",
  "prefix",
  "content",
  "content_rowid",
  "contentless_delete",
  "columnsize",
  "detail",
  "tokendata",
  "locale",
  "languageid",
  "matchinfo",
  "order",
  "compress",
  "uncompress",
]);

export function parseFtsModuleArgs(moduleArgs: string[], kind: FtsKind): FtsTableOptions {
  const columns: FtsColumnDef[] = [];
  const notindexed = new Set<string>();
  let content: FtsTableOptions["content"] = "normal";
  let contentTable: string | null = null;
  let contentRowid = "rowid";
  let contentlessDelete = false;
  let prefix: number[] = [];
  let columnsize = true;
  let detail: FtsDetail = "full";
  let tokendata = false;
  let locale = false;
  let languageid: string | null = null;
  let tokenizer: FtsTokenizerConfig = { name: "unicode61", removeDiacritics: 1 };

  for (const raw of moduleArgs) {
    const arg = raw.trim();
    if (!arg) continue;

    const eq = splitOption(arg);
    if (eq) {
      const key = eq.key.toLowerCase();
      const value = eq.value;
      if (!OPTION_NAMES.has(key) && kind === "fts5") {
        // FTS5: unknown option-like keys that aren't columns throw
        if (/^[a-z_][a-z0-9_]*$/i.test(eq.key) && value !== null) {
          // still accept known options only
        }
      }
      switch (key) {
        case "tokenize":
          tokenizer = parseTokenizer(value);
          break;
        case "prefix":
          prefix = value
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => {
              const n = Number(part);
              if (!Number.isInteger(n) || n <= 0) throw new SqliteError("SQL logic error", "other");
              return n;
            });
          break;
        case "content":
          if (value === "") {
            content = "contentless";
            contentTable = null;
          } else {
            content = "external";
            contentTable = value;
          }
          break;
        case "content_rowid":
          contentRowid = value;
          break;
        case "contentless_delete":
          contentlessDelete = value === "1" || value.toLowerCase() === "true";
          break;
        case "columnsize":
          columnsize = value !== "0";
          break;
        case "detail": {
          const d = value.toLowerCase();
          if (d !== "full" && d !== "column" && d !== "none") throw new SqliteError("SQL logic error", "other");
          detail = d;
          break;
        }
        case "tokendata":
          tokendata = value === "1" || value.toLowerCase() === "true";
          break;
        case "locale":
          locale = value === "1" || value.toLowerCase() === "true";
          break;
        case "languageid":
          languageid = value;
          break;
        default:
          // Treat as column name = something invalid for FTS5 → column with odd name
          if (kind === "fts5") throw new SqliteError(`unrecognized parameter: ${eq.key}`, "other");
          columns.push({ name: eq.key, unindexed: false });
          break;
      }
      continue;
    }

    // Column form: name [UNINDEXED]
    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const name = unquoteIdent(parts[0]!);
    const rest = parts.slice(1).map((p) => p.toUpperCase());
    if (rest.includes("UNINDEXED") || rest.includes("NOTINDEXED")) {
      columns.push({ name, unindexed: true });
      notindexed.add(name.toLowerCase());
    } else if (rest.length === 0) {
      if (OPTION_NAMES.has(name.toLowerCase()) && kind === "fts5") {
        // bare option name without = is invalid for some; treat as column (SQLite allows content as column name)
        columns.push({ name, unindexed: false });
      } else {
        columns.push({ name, unindexed: false });
      }
    } else if (kind === "fts3" || kind === "fts4") {
      // FTS3/4 column type names ignored
      columns.push({ name, unindexed: false });
    } else {
      throw new SqliteError("SQL logic error", "other");
    }
  }

  if (columns.length === 0) throw new SqliteError("fts requires at least one column", "other");

  const names = new Set<string>();
  for (const column of columns) {
    const key = column.name.toLowerCase();
    if (names.has(key)) throw new SqliteError("SQL logic error", "other");
    names.add(key);
  }

  return {
    columns,
    content,
    contentTable,
    contentRowid,
    contentlessDelete,
    prefix,
    columnsize,
    detail,
    tokendata,
    locale,
    tokenizer,
    languageid,
    notindexed,
  };
}

function splitOption(arg: string): { key: string; value: string } | null {
  const match = /^([A-Za-z_][\w]*)\s*=\s*(.*)$/s.exec(arg);
  if (!match) return null;
  return { key: match[1]!, value: unquoteValue(match[2]!.trim()) };
}

function unquoteValue(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    const q = value[0]!;
    return value
      .slice(1, -1)
      .replaceAll(q + q, q)
      .replaceAll("\\'", "'")
      .replaceAll('\\"', '"');
  }
  return value;
}

function unquoteIdent(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("`") && value.endsWith("`")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseTokenizer(spec: string): FtsTokenizerConfig {
  const tokens = tokenizeSpec(spec);
  if (tokens.length === 0) throw new SqliteError("no such tokenizer: ", "other");
  const name = tokens[0]!.toLowerCase();
  if (name === "porter") {
    const base = tokens[1]?.toLowerCase() ?? "unicode61";
    const rest = parseUnicodeOpts(tokens.slice(base === "unicode61" || base === "ascii" ? 2 : 1));
    return { name: "porter", base: base === "ascii" ? "ascii" : "unicode61", ...rest };
  }
  if (name === "trigram") {
    let caseSensitive = false;
    let removeDiacriticsTrigram = false;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!.toLowerCase();
      if (t === "case_sensitive" && tokens[i + 1] === "1") {
        caseSensitive = true;
        i++;
      } else if (t === "remove_diacritics" && tokens[i + 1] === "1") {
        removeDiacriticsTrigram = true;
        i++;
      }
    }
    return { name: "trigram", caseSensitive, removeDiacriticsTrigram };
  }
  if (name === "ascii") {
    return { name: "ascii", ...parseUnicodeOpts(tokens.slice(1)) };
  }
  if (name === "unicode61") {
    return { name: "unicode61", removeDiacritics: 1, ...parseUnicodeOpts(tokens.slice(1)) };
  }
  throw new SqliteError(`no such tokenizer: ${name}`, "other");
}

function parseUnicodeOpts(tokens: string[]): Partial<FtsTokenizerConfig> {
  const out: Partial<FtsTokenizerConfig> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase();
    if (t === "remove_diacritics") {
      const v = Number(tokens[++i] ?? "1");
      if (v !== 0 && v !== 1 && v !== 2) throw new SqliteError("SQL logic error", "other");
      out.removeDiacritics = v as 0 | 1 | 2;
    } else if (t === "tokenchars") {
      out.tokenchars = tokens[++i] ?? "";
    } else if (t === "separators") {
      out.separators = tokens[++i] ?? "";
    }
  }
  return out;
}

function tokenizeSpec(spec: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < spec.length) {
    while (i < spec.length && /\s/.test(spec[i]!)) i++;
    if (i >= spec.length) break;
    if (spec[i] === "'" || spec[i] === '"') {
      const q = spec[i]!;
      i++;
      let s = "";
      while (i < spec.length && spec[i] !== q) {
        s += spec[i++];
      }
      if (spec[i] === q) i++;
      out.push(s);
      continue;
    }
    let s = "";
    while (i < spec.length && !/\s/.test(spec[i]!)) s += spec[i++];
    out.push(s);
  }
  return out;
}
