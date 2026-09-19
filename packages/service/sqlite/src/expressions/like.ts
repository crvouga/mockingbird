import { SqliteError } from "../errors/index.ts";

function escapeRegexChar(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function likeLiteral(char: string, caseSensitive: boolean): string {
  if (!caseSensitive) {
    const code = char.codePointAt(0)!;
    if (code >= 65 && code <= 90) return `[${char}${char.toLowerCase()}]`;
    if (code >= 97 && code <= 122) return `[${char}${char.toUpperCase()}]`;
  }
  return escapeRegexChar(char);
}

/**
 * SQLite LIKE matching. ASCII letters are case-insensitive unless `caseSensitive`.
 *
 * @param text - Value to test.
 * @param pattern - Pattern with `%` / `_` wildcards.
 * @param escape - Optional single-character ESCAPE (or `null`).
 * @param caseSensitive - When true, match like GLOB (SQLite `PRAGMA case_sensitive_like=ON`).
 */
export function likeMatch(text: string, pattern: string, escape: string | null = null, caseSensitive = false): boolean {
  if (escape !== null && [...escape].length !== 1) {
    throw new SqliteError("ESCAPE expression must be a single character", "other");
  }

  let source = "^";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (escape !== null && char === escape) {
      const next = chars[++i];
      source += next === undefined ? likeLiteral(char, caseSensitive) : likeLiteral(next, caseSensitive);
    } else if (char === "%") {
      source += "[\\s\\S]*";
    } else if (char === "_") {
      source += "[\\s\\S]";
    } else {
      source += likeLiteral(char, caseSensitive);
    }
  }
  return new RegExp(`${source}$`).test(text);
}

/**
 * SQLite GLOB matching. GLOB is case-sensitive and uses Unix `*` / `?` wildcards.
 *
 * @param text - Value to test.
 * @param pattern - GLOB pattern.
 */
export function globMatch(text: string, pattern: string): boolean {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      source += "[\\s\\S]*";
    } else if (char === "?") {
      source += "[\\s\\S]";
    } else if (char === "[") {
      let end = i + 1;
      if (pattern[end] === "^") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end++;
      if (end >= pattern.length) {
        source += "\\[";
      } else {
        let content = pattern.slice(i + 1, end);
        // SQLite uses either ^ or ! as the first character to negate a class.
        if (content.startsWith("!")) content = `^${content.slice(1)}`;
        source += `[${content.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else {
      source += escapeRegexChar(char);
    }
  }
  return new RegExp(`${source}$`).test(text);
}
