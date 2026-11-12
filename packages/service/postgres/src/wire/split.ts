/**
 * Split a simple-query script into statements at top-level semicolons, the way the server's
 * lexer would: quoted strings (`'…'`, `E'…'` with backslashes, `"…"`), dollar quoting
 * (`$tag$…$tag$`), line and (nested) block comments never split. Empty statements are dropped.
 * Neither does a semicolon inside the SQL-standard body of `CREATE FUNCTION` / `CREATE PROCEDURE`
 * (`BEGIN ATOMIC … END`, with `CASE … END` nested in it), as PostgreSQL's own scanner tracks it.
 */
export const splitStatements = (script: string): string[] => {
  const out: string[] = [];
  let start = 0;
  let hasSql = false;
  let i = 0;
  const n = script.length;
  /** the statement's leading words, enough to tell a CREATE [OR REPLACE] FUNCTION / PROCEDURE */
  let words: string[] = [];
  let previousWord = "";
  let atomicDepth = 0;
  const push = (end: number) => {
    const text = script.slice(start, end).trim();
    if (hasSql) out.push(text);
    hasSql = false;
    words = [];
    previousWord = "";
    atomicDepth = 0;
  };
  const createsRoutine = (): boolean => {
    const head = words[1] === "or" && words[2] === "replace" ? words[3] : words[1];
    return words[0] === "create" && (head === "function" || head === "procedure");
  };
  while (i < n) {
    const c = script[i] as string;
    const next = script[i + 1];
    if (c === "-" && next === "-") {
      const end = script.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (script[i] === "/" && script[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (script[i] === "*" && script[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) hasSql = true; // keep unterminated comments for syntax errors
      continue;
    }
    if (c === "'" || c === '"') {
      hasSql = true;
      const escaped = c === "'" && /[eE]/.test(script[i - 1] ?? "") && !/[\w$]/.test(script[i - 2] ?? "");
      i++;
      while (i < n) {
        if (escaped && script[i] === "\\") {
          i += 2;
          continue;
        }
        if (script[i] === c) {
          if (script[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i, i + 64));
      if (m) {
        hasSql = true;
        const tag = m[0];
        const end = script.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(script[end] as string)) end++;
      // E'…' and U&'…' prefixes: the quote that follows is scanned on its own
      const word = script.slice(i, end).toLowerCase();
      hasSql = true;
      if (words.length < 4) words.push(word);
      if (word === "atomic" && previousWord === "begin" && createsRoutine()) atomicDepth++;
      else if (atomicDepth > 0 && word === "case") atomicDepth++;
      else if (atomicDepth > 0 && word === "end") atomicDepth--;
      previousWord = word;
      i = end;
      continue;
    }
    if (c === ";" && atomicDepth === 0) {
      push(i);
      start = i + 1;
    }
    if (c !== ";" && !/\s/.test(c)) hasSql = true;
    i++;
  }
  push(n);
  return out;
};
