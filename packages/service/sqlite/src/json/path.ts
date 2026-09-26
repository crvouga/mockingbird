import { SqliteError } from "../errors/index.ts";
import type { JsonNode } from "./types.ts";

export type PathStep =
  | { kind: "root" }
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "append" } // [#]
  | { kind: "fromEnd"; n: number }; // [#-n]

export function parseJsonPath(path: string): PathStep[] {
  if (path === "") throw new SqliteError("bad JSON path: ''", "other");
  if (!path.startsWith("$")) throw new SqliteError(`bad JSON path: '${path}'`, "other");
  const steps: PathStep[] = [{ kind: "root" }];
  let i = 1;
  while (i < path.length) {
    if (path[i] === ".") {
      i++;
      if (i >= path.length) throw new SqliteError(`bad JSON path: '${path}'`, "other");
      if (path[i] === '"') {
        i++;
        let key = "";
        while (i < path.length) {
          const ch = path[i]!;
          if (ch === '"') {
            i++;
            break;
          }
          if (ch === "\\") {
            i++;
            if (i >= path.length) throw new SqliteError(`bad JSON path: '${path}'`, "other");
            key += path[i]!;
            i++;
            continue;
          }
          key += ch;
          i++;
        }
        steps.push({ kind: "key", key });
        continue;
      }
      let key = "";
      while (i < path.length && path[i] !== "." && path[i] !== "[") {
        key += path[i]!;
        i++;
      }
      if (!key) throw new SqliteError(`bad JSON path: '${path}'`, "other");
      steps.push({ kind: "key", key });
      continue;
    }
    if (path[i] === "[") {
      i++;
      if (path[i] === "#") {
        i++;
        if (path[i] === "]") {
          i++;
          steps.push({ kind: "append" });
          continue;
        }
        if (path[i] === "-") {
          i++;
          let digits = "";
          while (i < path.length && path[i]! >= "0" && path[i]! <= "9") {
            digits += path[i]!;
            i++;
          }
          if (!digits || path[i] !== "]") throw new SqliteError(`bad JSON path: '${path}'`, "other");
          i++;
          steps.push({ kind: "fromEnd", n: Number(digits) });
          continue;
        }
        throw new SqliteError(`bad JSON path: '${path}'`, "other");
      }
      let digits = "";
      while (i < path.length && path[i]! >= "0" && path[i]! <= "9") {
        digits += path[i]!;
        i++;
      }
      if (!digits || path[i] !== "]") throw new SqliteError(`bad JSON path: '${path}'`, "other");
      i++;
      steps.push({ kind: "index", index: Number(digits) });
      continue;
    }
    throw new SqliteError(`bad JSON path: '${path}'`, "other");
  }
  return steps;
}

/** Resolve path for read; returns undefined if missing. */
export function pathGet(root: JsonNode, steps: PathStep[]): JsonNode | undefined {
  let cur: JsonNode | undefined = root;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === "root") continue;
    if (cur === undefined) return undefined;
    if (step.kind === "key") {
      if (cur.kind !== "object") return undefined;
      const entries = cur.entries;
      let next: JsonNode | undefined;
      for (let j = entries.length - 1; j >= 0; j--) {
        if (entries[j]!.key === step.key) {
          next = entries[j]!.value;
          break;
        }
      }
      cur = next;
      continue;
    }
    if (step.kind === "append") return undefined;
    if (cur.kind !== "array") return undefined;
    let index: number;
    if (step.kind === "index") index = step.index;
    else index = cur.elements.length - step.n;
    if (index < 0 || index >= cur.elements.length) return undefined;
    cur = cur.elements[index];
  }
  return cur;
}

export interface PathParent {
  parent: JsonNode;
  step: PathStep;
  /** For object: entry index; for array: element index (may be length for append). */
  index: number;
}

/** Locate parent container for the final path step (for mutate). */
export function pathParent(root: JsonNode, steps: PathStep[]): PathParent | null {
  if (steps.length <= 1) return null;
  const parentSteps = steps.slice(0, -1);
  const parent = pathGet(root, parentSteps);
  if (!parent) return null;
  const step = steps[steps.length - 1]!;
  if (step.kind === "root") return null;
  if (step.kind === "key") {
    if (parent.kind !== "object") return null;
    const index = parent.entries.findIndex((e) => e.key === step.key);
    return { parent, step, index };
  }
  if (parent.kind !== "array") return null;
  if (step.kind === "append") return { parent, step, index: parent.elements.length };
  if (step.kind === "index") return { parent, step, index: step.index };
  return { parent, step, index: parent.elements.length - step.n };
}
