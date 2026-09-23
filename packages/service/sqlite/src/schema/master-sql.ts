import { tokenize } from "../lexer/tokenize.ts";

/**
 * Normalize CREATE source toward SQLite's `sqlite_master.sql` conventions:
 * strip TEMP/TEMPORARY, IF NOT EXISTS, and schema qualifiers on the object name.
 * Body text (from after the object name) is preserved byte-for-byte from the input.
 */
export function normalizeMasterSql(sql: string): string {
  const trimmed = sql
    .trim()
    .replace(/;+\s*$/u, "")
    .trim();
  if (!trimmed) return trimmed;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0 || tokens[0]!.kind === "EOF") return trimmed;

  let i = 0;
  const at = (offset: number, ...kinds: string[]): boolean => {
    const tok = tokens[i + offset];
    return tok !== undefined && kinds.includes(tok.kind);
  };

  if (!at(0, "CREATE")) return trimmed;
  i++; // CREATE

  if (at(0, "TEMP", "TEMPORARY")) i++;

  let headKind: "table" | "view" | "index" | "trigger" | "vtable" | "unique_index" = "table";
  if (at(0, "UNIQUE") && at(1, "INDEX")) {
    headKind = "unique_index";
    i += 2;
  } else if (at(0, "VIRTUAL") && at(1, "TABLE")) {
    headKind = "vtable";
    i += 2;
  } else if (at(0, "TABLE")) {
    headKind = "table";
    i++;
  } else if (at(0, "VIEW")) {
    headKind = "view";
    i++;
  } else if (at(0, "INDEX")) {
    headKind = "index";
    i++;
  } else if (at(0, "TRIGGER")) {
    headKind = "trigger";
    i++;
  } else {
    return trimmed;
  }

  if (at(0, "IF") && at(1, "NOT") && at(2, "EXISTS")) i += 3;

  let nameText = "";
  let nameEnd = 0;
  if (tokens[i] && tokens[i]!.kind !== "EOF" && at(1, "DOT") && tokens[i + 2] && tokens[i + 2]!.kind !== "EOF") {
    nameText = trimmed.slice(tokens[i + 2]!.start, tokens[i + 2]!.end);
    nameEnd = tokens[i + 2]!.end;
    i += 3;
  } else if (tokens[i] && tokens[i]!.kind !== "EOF") {
    nameText = trimmed.slice(tokens[i]!.start, tokens[i]!.end);
    nameEnd = tokens[i]!.end;
    i++;
  }

  // Preserve whitespace between the object name and the body (SQLite keeps `projects (`).
  const body = nameEnd < trimmed.length ? trimmed.slice(nameEnd) : "";
  const needsSpace = body.length > 0 && !/^[\s(]/u.test(body);

  const head =
    headKind === "unique_index"
      ? "CREATE UNIQUE INDEX"
      : headKind === "vtable"
        ? "CREATE VIRTUAL TABLE"
        : headKind === "view"
          ? "CREATE VIEW"
          : headKind === "index"
            ? "CREATE INDEX"
            : headKind === "trigger"
              ? "CREATE TRIGGER"
              : "CREATE TABLE";

  if (body.length === 0) return `${head} ${nameText}`;
  return needsSpace ? `${head} ${nameText} ${body}` : `${head} ${nameText}${body}`;
}

/** Append an ALTER TABLE ADD COLUMN definition into CREATE TABLE master sql (SQLite style). */
export function appendAddColumnToMasterSql(originalSql: string | null, alterSql: string | null): string | null {
  if (!originalSql || !alterSql) return originalSql;
  const match = alterSql.match(/\bADD\s+(?:COLUMN\s+)?(.+)$/iu);
  if (!match?.[1]) return originalSql;
  const colDef = match[1]
    .trim()
    .replace(/;+\s*$/u, "")
    .trim();
  const close = originalSql.lastIndexOf(")");
  if (close < 0) return originalSql;
  return `${originalSql.slice(0, close)}, ${colDef}${originalSql.slice(close)}`;
}

/** Synthesize CTAS catalog SQL: `CREATE TABLE name(col1, col2, ...)`. */
export function synthesizeCtasMasterSql(tableName: string, columnNames: string[]): string {
  const cols = columnNames.map(quoteIdentIfNeeded).join(",");
  return `CREATE TABLE ${quoteIdentIfNeeded(tableName)}(${cols})`;
}

function quoteIdentIfNeeded(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return name;
  return `"${name.replaceAll('"', '""')}"`;
}
