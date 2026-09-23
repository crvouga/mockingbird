import { pgError } from "../errors/error.ts";
import type { JsonbValue } from "./jsonb.ts";

type PathStep = { kind: "member"; name: string } | { kind: "index"; index: number };

function invalidJsonpath(): never {
  throw pgError("invalid_text_representation", "invalid input syntax for type jsonpath", "22P02");
}

/** Parse a SQL/JSON path subset: `$`, `.key`, `."key"`, `[n]`. */
export function parseJsonpath(text: string): PathStep[] {
  const s = text.trim();
  if (s.length === 0 || s[0] !== "$") invalidJsonpath();
  let i = 1;
  const steps: PathStep[] = [];
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === ".") {
      i++;
      if (s[i] === '"') {
        i++;
        let name = "";
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\" && i + 1 < s.length) {
            name += s[i + 1]!;
            i += 2;
          } else {
            name += s[i]!;
            i++;
          }
        }
        if (s[i] !== '"') invalidJsonpath();
        i++;
        steps.push({ kind: "member", name });
        continue;
      }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (!m) invalidJsonpath();
      steps.push({ kind: "member", name: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === "[") {
      const rest = s.slice(i);
      const m = /^\[\s*(\d+)\s*\]/.exec(rest);
      if (!m) invalidJsonpath();
      steps.push({ kind: "index", index: Number(m[1]) });
      i += m[0].length;
      continue;
    }
    invalidJsonpath();
  }
  return steps;
}

/**
 * First match of a jsonpath against a jsonb document.
 * Missing path → SQL NULL (`null` return). JSON null is `{ j: "null" }`.
 */
export function jsonpathQueryFirst(doc: JsonbValue, pathText: string): JsonbValue | null {
  const steps = parseJsonpath(pathText);
  let cur: JsonbValue | null = doc;
  for (const step of steps) {
    if (cur === null) return null;
    if (step.kind === "member") {
      if (cur.j !== "obj") return null;
      cur = cur.v.get(step.name) ?? null;
    } else {
      if (cur.j !== "arr") return null;
      cur = cur.v[step.index] ?? null;
    }
  }
  return cur;
}
