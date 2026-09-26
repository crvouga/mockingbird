/**
 * Split a simple-query script into statements at top-level semicolons, the way the server's
 * lexer would: quoted strings (`'…'`, `E'…'` with backslashes, `"…"`), dollar quoting
 * (`$tag$…$tag$`), line and (nested) block comments never split. Empty statements are dropped.
 */
export const splitStatements = (script: string): string[] => {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = script.length;
  const push = (end: number) => {
    const text = script.slice(start, end).trim();
    if (text.length > 0) out.push(text);
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
      continue;
    }
    if (c === "'" || c === '"') {
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
        const tag = m[0];
        const end = script.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (c === ";") {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(n);
  return out;
};
