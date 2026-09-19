import { utf8Decode, utf8Encode } from "../types/value.ts";
import { JsonParseError, parseJsonText } from "./parse.ts";
import { stringifyJson } from "./stringify.ts";
import type { JsonNode } from "./types.ts";

/** JSONB element types (low nibble). */
export const JB = {
  NULL: 0,
  TRUE: 1,
  FALSE: 2,
  INT: 3,
  INT5: 4,
  FLOAT: 5,
  FLOAT5: 6,
  TEXT: 7,
  TEXTJ: 8,
  TEXT5: 9,
  TEXTRAW: 10,
  ARRAY: 11,
  OBJECT: 12,
} as const;

export function encodeJsonb(node: JsonNode): Uint8Array {
  const parts: number[] = [];
  writeNode(node, parts);
  return Uint8Array.from(parts);
}

function writeNode(node: JsonNode, out: number[]): void {
  switch (node.kind) {
    case "null":
      writeHeader(out, 0, JB.NULL);
      break;
    case "true":
      writeHeader(out, 0, JB.TRUE);
      break;
    case "false":
      writeHeader(out, 0, JB.FALSE);
      break;
    case "integer": {
      const payload = utf8Encode(node.text);
      writeHeader(out, payload.length, JB.INT);
      for (const b of payload) out.push(b);
      break;
    }
    case "real": {
      const payload = utf8Encode(node.text);
      writeHeader(out, payload.length, JB.FLOAT);
      for (const b of payload) out.push(b);
      break;
    }
    case "string": {
      const payload = utf8Encode(node.value);
      const needsEscape = [...node.value].some((ch) => {
        const c = ch.charCodeAt(0);
        return ch === '"' || ch === "\\" || c < 0x20;
      });
      // Prefer TEXT when no escapes needed; TEXTRAW if chars need escaping in JSON text
      const type = needsEscape ? JB.TEXTRAW : JB.TEXT;
      writeHeader(out, payload.length, type);
      for (const b of payload) out.push(b);
      break;
    }
    case "array": {
      const payload: number[] = [];
      for (const el of node.elements) writeNode(el, payload);
      writeHeader(out, payload.length, JB.ARRAY);
      out.push(...payload);
      break;
    }
    case "object": {
      const payload: number[] = [];
      for (const entry of node.entries) {
        writeNode({ kind: "string", value: entry.key }, payload);
        writeNode(entry.value, payload);
      }
      writeHeader(out, payload.length, JB.OBJECT);
      out.push(...payload);
      break;
    }
  }
}

function writeHeader(out: number[], size: number, type: number): void {
  if (size <= 11) {
    out.push((size << 4) | type);
    return;
  }
  if (size <= 0xff) {
    out.push((12 << 4) | type, size);
    return;
  }
  if (size <= 0xffff) {
    out.push((13 << 4) | type, (size >> 8) & 0xff, size & 0xff);
    return;
  }
  out.push((14 << 4) | type, (size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff);
}

export interface JsonbElement {
  offset: number;
  end: number;
  type: number;
  payloadOffset: number;
  payloadSize: number;
}

export function readHeader(blob: Uint8Array, offset: number): JsonbElement {
  if (offset >= blob.length) throw new JsonParseError("malformed JSON", offset + 1);
  const first = blob[offset]!;
  const sizeCode = first >> 4;
  const type = first & 0x0f;
  let headerSize = 1;
  let payloadSize = sizeCode;
  if (sizeCode >= 12) {
    const lenBytes = sizeCode === 12 ? 1 : sizeCode === 13 ? 2 : sizeCode === 14 ? 4 : 8;
    headerSize = 1 + lenBytes;
    if (offset + headerSize > blob.length) throw new JsonParseError("malformed JSON", offset + 1);
    payloadSize = 0;
    for (let i = 0; i < lenBytes; i++) {
      payloadSize = (payloadSize << 8) | blob[offset + 1 + i]!;
    }
  }
  const payloadOffset = offset + headerSize;
  const end = payloadOffset + payloadSize;
  if (end > blob.length) throw new JsonParseError("malformed JSON", offset + 1);
  return { offset, end, type, payloadOffset, payloadSize };
}

export function looksLikeJsonb(blob: Uint8Array): boolean {
  if (blob.length === 0) return false;
  try {
    const el = readHeader(blob, 0);
    return el.end === blob.length && el.type <= JB.OBJECT;
  } catch {
    return false;
  }
}

export function decodeJsonb(blob: Uint8Array): JsonNode {
  const el = readHeader(blob, 0);
  if (el.end !== blob.length) throw new JsonParseError("malformed JSON", 1);
  return decodeElement(blob, el);
}

function decodeElement(blob: Uint8Array, el: JsonbElement): JsonNode {
  switch (el.type) {
    case JB.NULL:
      return { kind: "null" };
    case JB.TRUE:
      return { kind: "true" };
    case JB.FALSE:
      return { kind: "false" };
    case JB.INT:
    case JB.INT5: {
      const text = utf8Decode(blob.subarray(el.payloadOffset, el.end));
      return { kind: "integer", text: normalizeIntText(text) };
    }
    case JB.FLOAT:
    case JB.FLOAT5: {
      const text = utf8Decode(blob.subarray(el.payloadOffset, el.end));
      return { kind: "real", text };
    }
    case JB.TEXT:
    case JB.TEXTJ:
    case JB.TEXT5:
    case JB.TEXTRAW: {
      const raw = utf8Decode(blob.subarray(el.payloadOffset, el.end));
      if (el.type === JB.TEXT || el.type === JB.TEXTRAW) return { kind: "string", value: raw };
      // TEXTJ / TEXT5 store escaped content without quotes — unescape lightly
      return { kind: "string", value: unescapeJsonPayload(raw) };
    }
    case JB.ARRAY: {
      const elements: JsonNode[] = [];
      let pos = el.payloadOffset;
      while (pos < el.end) {
        const child = readHeader(blob, pos);
        elements.push(decodeElement(blob, child));
        pos = child.end;
      }
      return { kind: "array", elements };
    }
    case JB.OBJECT: {
      const entries: Array<{ key: string; value: JsonNode }> = [];
      let pos = el.payloadOffset;
      while (pos < el.end) {
        const keyEl = readHeader(blob, pos);
        const keyNode = decodeElement(blob, keyEl);
        if (keyNode.kind !== "string") throw new JsonParseError("malformed JSON", pos + 1);
        pos = keyEl.end;
        const valEl = readHeader(blob, pos);
        entries.push({ key: keyNode.value, value: decodeElement(blob, valEl) });
        pos = valEl.end;
      }
      return { kind: "object", entries };
    }
    default:
      throw new JsonParseError("malformed JSON", el.offset + 1);
  }
}

function normalizeIntText(text: string): string {
  const n = Number(text);
  if (Number.isFinite(n) && Number.isInteger(n)) return String(Math.trunc(n));
  return text;
}

function unescapeJsonPayload(raw: string): string {
  // Payload may contain JSON escapes without surrounding quotes
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return raw;
  }
}

/** Walk JSONB and collect element metadata for TVF id/parent assignment. */
export interface JsonbWalkEntry {
  offset: number;
  parent: number | null;
  node: JsonNode;
  key: string | number | null;
  path: string;
  fullkey: string;
  /** For object entries, offset of the key header (used as id). */
  idOffset: number;
}

export function walkJsonbTree(blob: Uint8Array): JsonbWalkEntry[] {
  const root = readHeader(blob, 0);
  const node = decodeElement(blob, root);
  const out: JsonbWalkEntry[] = [];
  walk(blob, root, node, null, "$", "$", null, out);
  return out;
}

function walk(
  blob: Uint8Array,
  el: JsonbElement,
  node: JsonNode,
  parentId: number | null,
  path: string,
  fullkey: string,
  key: string | number | null,
  out: JsonbWalkEntry[],
  idOffset = el.offset,
): void {
  out.push({ offset: el.offset, parent: parentId, node, key, path, fullkey, idOffset });
  if (node.kind === "array") {
    let pos = el.payloadOffset;
    let index = 0;
    while (pos < el.end) {
      const child = readHeader(blob, pos);
      const childNode = decodeElement(blob, child);
      const childFull = `${fullkey}[${index}]`;
      walk(blob, child, childNode, idOffset, fullkey, childFull, index, out);
      pos = child.end;
      index++;
    }
  } else if (node.kind === "object") {
    let pos = el.payloadOffset;
    while (pos < el.end) {
      const keyEl = readHeader(blob, pos);
      const keyNode = decodeElement(blob, keyEl);
      if (keyNode.kind !== "string") throw new JsonParseError("malformed JSON", pos + 1);
      pos = keyEl.end;
      const valEl = readHeader(blob, pos);
      const valNode = decodeElement(blob, valEl);
      const childFull = appendObjectKey(fullkey, keyNode.value);
      // Children of this entry use the entry's id (key offset), matching SQLite.
      walk(blob, valEl, valNode, idOffset, fullkey, childFull, keyNode.value, out, keyEl.offset);
      pos = valEl.end;
    }
  }
}

function appendObjectKey(base: string, key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `${base}.${key}`;
  return `${base}."${key.replace(/"/g, '\\"')}"`;
}

export function jsonbToText(blob: Uint8Array): string {
  return stringifyJson(decodeJsonb(blob));
}

export function textToJsonb(text: string): Uint8Array {
  return encodeJsonb(parseJsonText(text));
}
