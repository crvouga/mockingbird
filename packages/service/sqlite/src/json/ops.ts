import { SqliteError } from "../errors/index.ts";
import { asSqlJsonText, asSqlReal, isSqlJsonText, SqlJsonText, type SqlValue, utf8Decode } from "../types/value.ts";
import { decodeJsonb, encodeJsonb, looksLikeJsonb } from "./jsonb.ts";
import { JsonParseError, parseJsonText } from "./parse.ts";
import { type PathStep, parseJsonPath, pathGet, pathParent } from "./path.ts";
import { stringifyJson } from "./stringify.ts";
import { cloneJson, type JsonNode } from "./types.ts";

export function sqlToJsonInput(value: SqlValue): JsonNode {
  if (value === null) return { kind: "null" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { kind: "null" };
    if (Number.isInteger(value)) return { kind: "integer", text: String(value) };
    return { kind: "real", text: String(value) };
  }
  if (typeof value === "bigint") return { kind: "integer", text: value.toString() };
  if (value instanceof SqlJsonText) return parseJsonText(value.value);
  if (typeof value === "string") return parseJsonText(value);
  if (value instanceof Uint8Array) {
    if (looksLikeJsonb(value)) return decodeJsonb(value);
    // Legacy blob-as-text JSON bug compatibility
    return parseJsonText(utf8Decode(value));
  }
  // SqlReal
  if (typeof value === "object" && value !== null && "value" in value) {
    const n = (value as { value: number }).value;
    if (!Number.isFinite(n)) return { kind: "null" };
    return { kind: "real", text: String(n) };
  }
  throw new SqliteError("malformed JSON", "other");
}

export function trySqlToJsonInput(value: SqlValue): JsonNode | null {
  try {
    return sqlToJsonInput(value);
  } catch {
    return null;
  }
}

/** VALUE arg for insert/set/array/object — literal unless JSON subtype / JSONB. */
export function sqlValueToJsonNode(value: SqlValue): JsonNode {
  if (value === null) return { kind: "null" };
  if (isSqlJsonText(value)) return parseJsonText(value.value);
  if (value instanceof Uint8Array && looksLikeJsonb(value)) return decodeJsonb(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { kind: "null" };
    if (Number.isInteger(value)) return { kind: "integer", text: String(value) };
    return { kind: "real", text: String(value) };
  }
  if (typeof value === "bigint") return { kind: "integer", text: value.toString() };
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array) && "value" in value) {
    const n = (value as { value: number }).value;
    return { kind: "real", text: String(n) };
  }
  if (value instanceof Uint8Array) {
    throw new SqliteError("JSON cannot hold BLOB values", "other");
  }
  // plain text / string → JSON string
  return { kind: "string", value: String(value) };
}

export function jsonNodeToSql(node: JsonNode, mode: "sql" | "json" | "jsonb"): SqlValue {
  if (mode === "jsonb") return encodeJsonb(node);
  if (mode === "json") return asSqlJsonText(stringifyJson(node));
  // sql representation (json_extract single path / ->>)
  switch (node.kind) {
    case "null":
      return null;
    case "true":
      return 1;
    case "false":
      return 0;
    case "integer": {
      const n = Number(node.text);
      if (Number.isSafeInteger(n)) return n;
      try {
        return BigInt(node.text);
      } catch {
        return n;
      }
    }
    case "real": {
      const n = Number(node.text);
      return Number.isInteger(n) ? asSqlReal(n) : n;
    }
    case "string":
      return node.value;
    case "array":
    case "object":
      // ->> / sql mode: plain TEXT without JSON subtype so nested json_* quote it.
      if (mode === "sql") return stringifyJson(node);
      return asSqlJsonText(stringifyJson(node));
  }
}

export function jsonArrowPath(right: SqlValue): string {
  if (right === null) throw new SqliteError("JSON path error", "other");
  if (typeof right === "number" || typeof right === "bigint") {
    const n = typeof right === "bigint" ? Number(right) : Math.trunc(right);
    if (n < 0) return `$[#${n}]`; // -K → [#-K] via `[#-K]` — n is already negative
    return `$[${n}]`;
  }
  const text = isSqlJsonText(right) ? right.value : String(right);
  if (text.startsWith("$")) return text;
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    if (n < 0) return `$[#${n}]`;
    return `$[${n}]`;
  }
  return `$.${text}`;
}

export function extractOne(root: JsonNode, path: string): JsonNode | undefined {
  return pathGet(root, parseJsonPath(path));
}

export type MutateMode = "insert" | "replace" | "set";

/**
 * json_array_insert / jsonb_array_insert — like json_replace, but PATH must end
 * with an array index and the value is spliced in (existing elements shift right).
 * https://www.sqlite.org/json1.html#jarrins
 */
export function arrayInsertJson(root: JsonNode, path: string, value: JsonNode): JsonNode {
  const steps = parseJsonPath(path);
  const last = steps[steps.length - 1];
  if (!last || last.kind === "root" || last.kind === "key") {
    throw new SqliteError("JSON path error", "other");
  }
  const result = cloneJson(root);
  const parentInfo = pathParent(result, steps);
  if (parentInfo?.parent.kind !== "array") return result;
  const parent = parentInfo.parent;
  let idx = parentInfo.index;
  if (last.kind === "fromEnd") idx = parent.elements.length - last.n;
  if (last.kind === "append") idx = parent.elements.length;
  if (idx < 0 || idx > parent.elements.length) return result;
  parent.elements.splice(idx, 0, cloneJson(value));
  return result;
}

export function mutateJson(root: JsonNode, path: string, value: JsonNode, mode: MutateMode): JsonNode {
  const steps = parseJsonPath(path);
  if (steps.length <= 1) {
    // path is $
    if (mode === "insert") return root;
    return cloneJson(value);
  }
  const result = cloneJson(root);
  if (!applyMutate(result, steps, value, mode)) {
    createPathAndSet(result, steps, value, mode);
  }
  return result;
}

function applyMutate(root: JsonNode, steps: PathStep[], value: JsonNode, mode: MutateMode): boolean {
  const parentInfo = pathParent(root, steps);
  if (!parentInfo) return false;
  const { parent, step, index } = parentInfo;
  if (step.kind === "key") {
    if (parent.kind !== "object") return false;
    if (index >= 0) {
      if (mode === "insert") return false;
      parent.entries[index] = { key: step.key, value: cloneJson(value) };
      return true;
    }
    if (mode === "replace") return false;
    parent.entries.push({ key: step.key, value: cloneJson(value) });
    return true;
  }
  if (parent.kind !== "array") return false;
  if (step.kind === "append") {
    if (mode === "replace") return false;
    parent.elements.push(cloneJson(value));
    return true;
  }
  let idx = index;
  if (step.kind === "fromEnd") idx = parent.elements.length - step.n;
  if (idx < 0 || idx > parent.elements.length) return false;
  if (idx === parent.elements.length) {
    if (mode === "replace") return false;
    parent.elements.push(cloneJson(value));
    return true;
  }
  if (mode === "insert") return false;
  parent.elements[idx] = cloneJson(value);
  return true;
}

function createPathAndSet(root: JsonNode, steps: PathStep[], value: JsonNode, mode: MutateMode): boolean {
  // Walk creating missing object keys / refusing missing array slots (SQLite behavior)
  let cur = root;
  for (let i = 1; i < steps.length - 1; i++) {
    const step = steps[i]!;
    const next = steps[i + 1]!;
    if (step.kind === "key") {
      if (cur.kind !== "object") return false;
      let entry = cur.entries.find((e) => e.key === step.key);
      if (!entry) {
        if (mode === "replace") return false;
        const child: JsonNode =
          next.kind === "key" || next.kind === "root"
            ? { kind: "object", entries: [] }
            : { kind: "array", elements: [] };
        entry = { key: step.key, value: child };
        cur.entries.push(entry);
      }
      cur = entry.value;
      continue;
    }
    if (cur.kind !== "array") return false;
    let idx = step.kind === "index" ? step.index : step.kind === "fromEnd" ? cur.elements.length - step.n : -1;
    if (step.kind === "append") idx = cur.elements.length;
    if (idx < 0 || idx > cur.elements.length) return false;
    if (idx === cur.elements.length) {
      if (mode === "replace") return false;
      const child: JsonNode = next.kind === "key" ? { kind: "object", entries: [] } : { kind: "array", elements: [] };
      cur.elements.push(child);
    }
    cur = cur.elements[idx]!;
  }
  return applyMutate(root, steps, value, mode);
}

export function removeJson(root: JsonNode, path: string): JsonNode {
  const steps = parseJsonPath(path);
  if (steps.length <= 1) return root;
  const result = cloneJson(root);
  const parentInfo = pathParent(result, steps);
  if (!parentInfo) return result;
  const { parent, step, index } = parentInfo;
  if (step.kind === "key" && parent.kind === "object" && index >= 0) {
    parent.entries.splice(index, 1);
  } else if (parent.kind === "array") {
    let idx = index;
    if (step.kind === "fromEnd") idx = parent.elements.length - step.n;
    if (step.kind === "append") return result;
    if (idx >= 0 && idx < parent.elements.length) parent.elements.splice(idx, 1);
  }
  return result;
}

/** RFC7396-ish JSON Merge Patch as implemented by SQLite json_patch. */
export function patchJson(target: JsonNode, patch: JsonNode): JsonNode {
  if (patch.kind !== "object") return cloneJson(patch);
  const base = target.kind === "object" ? cloneJson(target) : ({ kind: "object", entries: [] } as JsonNode);
  if (base.kind !== "object") return cloneJson(patch);
  for (const entry of patch.entries) {
    if (entry.value.kind === "null") {
      base.entries = base.entries.filter((e) => e.key !== entry.key);
      continue;
    }
    const existing = base.entries.find((e) => e.key === entry.key);
    if (existing) {
      existing.value = patchJson(existing.value, entry.value);
    } else {
      base.entries.push({ key: entry.key, value: cloneJson(entry.value) });
    }
  }
  return base;
}

export function wrapJsonError(e: unknown): never {
  if (e instanceof SqliteError) throw e;
  if (e instanceof JsonParseError) throw new SqliteError("malformed JSON", "other");
  throw new SqliteError("malformed JSON", "other");
}

export function ensureJson(value: SqlValue): JsonNode {
  try {
    return sqlToJsonInput(value);
  } catch (e) {
    wrapJsonError(e);
  }
}

export function toJsonbBlob(value: SqlValue): Uint8Array {
  if (value instanceof Uint8Array && looksLikeJsonb(value)) return value;
  return encodeJsonb(ensureJson(value));
}

export function toJsonText(value: SqlValue): SqlJsonText {
  return asSqlJsonText(stringifyJson(ensureJson(value)));
}
