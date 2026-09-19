import { pgError } from "../errors/error.ts";
import { assertNever } from "../runtime/assert.ts";
import { type Numeric, numericCmp, numericStripTrailingZeros, numericText, parseNumeric } from "./numeric.ts";

const MAX_JSON_PARSE_DEPTH = 512;
const JSON_TEXT_ENCODER = new TextEncoder();

/**
 * jsonb value tree. Numbers are kept as `numeric` (PG stores jsonb numbers
 * as numeric — `1.50::jsonb` keeps its scale). Object keys are unique;
 * output order is (length, byte order), matching PG jsonb.
 */
export type JsonbValue =
  | { j: "null" }
  | { j: "bool"; v: boolean }
  | { j: "num"; v: Numeric }
  | { j: "str"; v: string }
  | { j: "arr"; v: JsonbValue[] }
  | { j: "obj"; v: Map<string, JsonbValue> };

export const JSONB_NULL: JsonbValue = { j: "null" };

export function jsonbBool(v: boolean): JsonbValue {
  return { j: "bool", v };
}

export function jsonbNum(v: Numeric): JsonbValue {
  return { j: "num", v };
}

export function jsonbStr(v: string): JsonbValue {
  return { j: "str", v };
}

export function jsonbArr(v: JsonbValue[]): JsonbValue {
  return { j: "arr", v };
}

export function jsonbObj(entries: Iterable<[string, JsonbValue]>): JsonbValue {
  const m = new Map<string, JsonbValue>();
  for (const [k, v] of entries) m.set(k, v); // later duplicate wins (PG behavior)
  return { j: "obj", v: m };
}

// --- JSON text parsing (strict RFC 8259 with PG error wording) -----------

class JsonParser {
  private pos = 0;
  constructor(private readonly text: string) {}

  parse(): JsonbValue {
    this.skipWs();
    const v = this.parseValue(0);
    this.skipWs();
    if (this.pos < this.text.length) this.fail("expected end of input");
    return v;
  }

  private fail(_detail: string): never {
    throw pgError("invalid_text_representation", `invalid input syntax for type json`, "22P02");
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else break;
    }
  }

  private parseValue(depth: number): JsonbValue {
    if (depth > MAX_JSON_PARSE_DEPTH) {
      throw pgError("program_limit_exceeded", "json nesting depth exceeds maximum", "54000");
    }
    const c = this.text[this.pos];
    if (c === undefined) this.fail("unexpected end");
    if (c === "{") return this.parseObject(depth + 1);
    if (c === "[") return this.parseArray(depth + 1);
    if (c === '"') return jsonbStr(this.parseString());
    if (c === "t") {
      this.expect("true");
      return jsonbBool(true);
    }
    if (c === "f") {
      this.expect("false");
      return jsonbBool(false);
    }
    if (c === "n") {
      this.expect("null");
      return JSONB_NULL;
    }
    return this.parseNumber();
  }

  private expect(word: string): void {
    if (this.text.slice(this.pos, this.pos + word.length) !== word) this.fail(`expected ${word}`);
    this.pos += word.length;
  }

  private parseObject(depth: number): JsonbValue {
    this.pos++; // {
    const m = new Map<string, JsonbValue>();
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return { j: "obj", v: m };
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') this.fail("expected string key");
      const key = this.parseString();
      this.skipWs();
      if (this.text[this.pos] !== ":") this.fail("expected :");
      this.pos++;
      this.skipWs();
      const value = this.parseValue(depth);
      m.set(key, value);
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return { j: "obj", v: m };
      }
      this.fail("expected , or }");
    }
  }

  private parseArray(depth: number): JsonbValue {
    this.pos++; // [
    const items: JsonbValue[] = [];
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return jsonbArr(items);
    }
    for (;;) {
      this.skipWs();
      items.push(this.parseValue(depth));
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return jsonbArr(items);
      }
      this.fail("expected , or ]");
    }
  }

  private parseString(): string {
    this.pos++; // "
    let out = "";
    for (;;) {
      const c = this.text[this.pos];
      if (c === undefined) this.fail("unterminated string");
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === "\\") {
        const e = this.text[this.pos + 1];
        this.pos += 2;
        switch (e) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("bad unicode escape");
            this.pos += 4;
            let code = Number.parseInt(hex, 16);
            if (code >= 0xd800 && code <= 0xdbff && this.text.slice(this.pos, this.pos + 2) === "\\u") {
              const hex2 = this.text.slice(this.pos + 2, this.pos + 6);
              if (/^[0-9a-fA-F]{4}$/.test(hex2)) {
                const low = Number.parseInt(hex2, 16);
                if (low >= 0xdc00 && low <= 0xdfff) {
                  code = 0x10000 + (code - 0xd800) * 0x400 + (low - 0xdc00);
                  this.pos += 6;
                }
              }
            }
            if (code === 0) {
              throw pgError("invalid_text_representation", "unsupported Unicode escape sequence", "22P05");
            }
            out += String.fromCodePoint(code);
            break;
          }
          default:
            this.fail("bad escape");
        }
        continue;
      }
      if (c < " ") this.fail("control character in string");
      out += c;
      this.pos++;
    }
  }

  private parseNumber(): JsonbValue {
    const start = this.pos;
    const re = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m || m.index !== start) this.fail("bad number");
    this.pos = re.lastIndex;
    return jsonbNum(parseNumeric(m[0]));
  }
}

export function parseJsonText(text: string): JsonbValue {
  return new JsonParser(text).parse();
}

/** Validate json text without canonicalizing (for `json` type input). */
export function validateJsonText(text: string): void {
  new JsonParser(text).parse();
}

function escapeJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** jsonb key sort: length first, then byte order (PG lexCompareJsonbStringValue). */
export function jsonbKeyCompare(a: string, b: string): number {
  const ea = JSON_TEXT_ENCODER.encode(a);
  const eb = JSON_TEXT_ENCODER.encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    if (ea[i]! !== eb[i]!) return ea[i]! < eb[i]! ? -1 : 1;
  }
  if (ea.length !== eb.length) return ea.length < eb.length ? -1 : 1;
  return 0;
}

function sortedKeys(m: Map<string, JsonbValue>): string[] {
  return [...m.keys()].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return jsonbKeyCompare(a, b);
  });
}

/** jsonb number rendering: numeric text with trailing zeros preserved per stored scale. */
function jsonbNumText(v: Numeric): string {
  return numericText(v);
}

/** Render jsonb in PG's canonical text form: `{"a": 1, "b": [1, 2]}` */
export function jsonbText(v: JsonbValue): string {
  switch (v.j) {
    case "null":
      return "null";
    case "bool":
      return v.v ? "true" : "false";
    case "num":
      return jsonbNumText(v.v);
    case "str":
      return escapeJsonString(v.v);
    case "arr":
      return `[${v.v.map(jsonbText).join(", ")}]`;
    case "obj": {
      const keys = sortedKeys(v.v);
      return `{${keys.map((k) => `${escapeJsonString(k)}: ${jsonbText(v.v.get(k)!)}`).join(", ")}}`;
    }
  }
}

/** Render as compact json text with insertion order (row_to_json / to_json / composite_to_json). */
export function jsonbCompactText(v: JsonbValue): string {
  switch (v.j) {
    case "null":
      return "null";
    case "bool":
      return v.v ? "true" : "false";
    case "num":
      return jsonbNumText(v.v);
    case "str":
      return escapeJsonString(v.v);
    case "arr":
      return `[${v.v.map(jsonbCompactText).join(",")}]`;
    case "obj":
      return `{${[...v.v.entries()].map(([k, x]) => `${escapeJsonString(k)}:${jsonbCompactText(x)}`).join(",")}}`;
  }
}

/** Structural equality (jsonb = jsonb). */
export function jsonbEquals(a: JsonbValue, b: JsonbValue): boolean {
  return jsonbCompare(a, b) === 0;
}

const TYPE_ORDER: Record<JsonbValue["j"], number> = {
  // PG jsonb btree ordering: Object > Array > Boolean > Number > String > Null
  obj: 5,
  arr: 4,
  bool: 3,
  num: 2,
  str: 1,
  null: 0,
};

/** Total order over jsonb (matches jsonb btree comparison semantics). */
export function jsonbCompare(a: JsonbValue, b: JsonbValue): number {
  if (a.j !== b.j) return TYPE_ORDER[a.j] - TYPE_ORDER[b.j];
  switch (a.j) {
    case "null":
      return 0;
    case "bool": {
      const bb = b as Extract<JsonbValue, { j: "bool" }>;
      return a.v === bb.v ? 0 : a.v ? 1 : -1;
    }
    case "num": {
      const bb = b as Extract<JsonbValue, { j: "num" }>;
      return numericCmp(numericStripTrailingZeros(a.v), numericStripTrailingZeros(bb.v));
    }
    case "str": {
      const bb = b as Extract<JsonbValue, { j: "str" }>;
      return a.v < bb.v ? -1 : a.v > bb.v ? 1 : 0;
    }
    case "arr": {
      const bb = b as Extract<JsonbValue, { j: "arr" }>;
      if (a.v.length !== bb.v.length) return a.v.length - bb.v.length;
      for (let i = 0; i < a.v.length; i++) {
        const c = jsonbCompare(a.v[i]!, bb.v[i]!);
        if (c !== 0) return c;
      }
      return 0;
    }
    case "obj": {
      const bb = b as Extract<JsonbValue, { j: "obj" }>;
      if (a.v.size !== bb.v.size) return a.v.size - bb.v.size;
      const ka = sortedKeys(a.v);
      const kb = sortedKeys(bb.v);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i]! !== kb[i]!) {
          if (ka[i]!.length !== kb[i]!.length) return ka[i]!.length - kb[i]!.length;
          return jsonbKeyCompare(ka[i]!, kb[i]!);
        }
        const c = jsonbCompare(a.v.get(ka[i]!)!, bb.v.get(kb[i]!)!);
        if (c !== 0) return c;
      }
      return 0;
    }
    default:
      return assertNever(a);
  }
}

/** jsonb containment (@>). */
export function jsonbContains(a: JsonbValue, b: JsonbValue, opts?: { allowScalarInArray?: boolean }): boolean {
  const allowScalarInArray = opts?.allowScalarInArray ?? true;
  if (a.j === "obj" && b.j === "obj") {
    for (const [k, bv] of b.v) {
      const av = a.v.get(k);
      if (av === undefined || !jsonbContains(av, bv, { allowScalarInArray: false })) return false;
    }
    return true;
  }
  if (a.j === "arr" && b.j === "arr") {
    for (const bv of b.v) {
      let found = false;
      for (const av of a.v) {
        if (jsonbContains(av, bv, opts)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }
  if (allowScalarInArray && a.j === "arr" && b.j !== "arr" && b.j !== "obj") {
    // top-level only: '[1,2]' @> '1' — not '{"a":[1,2]}' @> '{"a":1}'
    for (const av of a.v) {
      if (av.j === b.j && jsonbEquals(av, b)) return true;
    }
    return false;
  }
  return a.j === b.j && jsonbEquals(a, b);
}
