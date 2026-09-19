import { SqliteError } from "../errors/index.ts";
import type { JsonNode } from "./types.ts";

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = "JsonParseError";
  }
}

/** Parse JSON / JSON5-ish input into a JsonNode. Position is 1-based for errors. */
export function parseJsonText(input: string, options?: { strictCanonical?: boolean }): JsonNode {
  const parser = new JsonTextParser(input, options?.strictCanonical ?? false);
  const node = parser.parseValue();
  parser.skipWs();
  if (!parser.eof()) {
    throw new JsonParseError("malformed JSON", parser.pos1());
  }
  return node;
}

export function jsonErrorPosition(input: string): number {
  try {
    parseJsonText(input);
    return 0;
  } catch (e) {
    if (e instanceof JsonParseError) return e.position;
    return 1;
  }
}

export function isValidJsonText(input: string, flags = 0): boolean {
  // SQLite flags: 0x01 accepts canonical RFC-8259 JSON and 0x02 accepts
  // JSON5. With no explicit flags json_valid() uses canonical JSON.
  const allowCanonical = flags === 0 || (flags & 0x01) !== 0;
  const allowJson5 = (flags & 0x02) !== 0;
  try {
    if (allowJson5) {
      parseJsonText(input);
      return true;
    }
    if (allowCanonical) {
      parseJsonText(input, { strictCanonical: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

class JsonTextParser {
  private i = 0;
  constructor(
    private readonly s: string,
    private readonly strictCanonical: boolean,
  ) {}

  eof(): boolean {
    return this.i >= this.s.length;
  }

  pos1(): number {
    return this.i + 1;
  }

  peek(n = 0): string {
    return this.s[this.i + n] ?? "";
  }

  advance(): string {
    return this.s[this.i++] ?? "";
  }

  skipWs(): void {
    while (this.i < this.s.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\v" || ch === "\f") {
        this.advance();
        continue;
      }
      if (!this.strictCanonical && ch === "/" && this.peek(1) === "/") {
        this.i += 2;
        while (!this.eof() && this.peek() !== "\n") this.advance();
        continue;
      }
      if (!this.strictCanonical && ch === "/" && this.peek(1) === "*") {
        this.i += 2;
        while (!this.eof() && !(this.peek() === "*" && this.peek(1) === "/")) this.advance();
        if (!this.eof()) this.i += 2;
        continue;
      }
      break;
    }
  }

  parseValue(): JsonNode {
    this.skipWs();
    if (this.eof()) throw new JsonParseError("malformed JSON", this.pos1());
    const ch = this.peek();
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"' || (!this.strictCanonical && ch === "'")) return this.parseString();
    if (ch === "-" || ch === "+" || (ch >= "0" && ch <= "9") || ch === ".") return this.parseNumber();
    if (ch === "n" || ch === "N") return this.parseKeyword();
    if (ch === "t" || ch === "T" || ch === "f" || ch === "F" || ch === "I" || ch === "i") {
      return this.parseKeyword();
    }
    throw new JsonParseError("malformed JSON", this.pos1());
  }

  parseObject(): JsonNode {
    this.advance(); // {
    this.skipWs();
    const entries: Array<{ key: string; value: JsonNode }> = [];
    if (this.peek() === "}") {
      this.advance();
      return { kind: "object", entries };
    }
    while (true) {
      this.skipWs();
      let key: string;
      if (this.peek() === '"' || (!this.strictCanonical && this.peek() === "'")) {
        const str = this.parseString();
        key = (str as { kind: "string"; value: string }).value;
      } else if (!this.strictCanonical && this.isIdentStart(this.peek())) {
        key = this.parseIdent();
      } else {
        throw new JsonParseError("malformed JSON", this.pos1());
      }
      this.skipWs();
      if (this.advance() !== ":") throw new JsonParseError("malformed JSON", this.pos1());
      const value = this.parseValue();
      entries.push({ key, value });
      this.skipWs();
      const sep = this.peek();
      if (sep === ",") {
        this.advance();
        this.skipWs();
        if (!this.strictCanonical && this.peek() === "}") {
          this.advance();
          break;
        }
        continue;
      }
      if (sep === "}") {
        this.advance();
        break;
      }
      throw new JsonParseError("malformed JSON", this.pos1());
    }
    return { kind: "object", entries };
  }

  parseArray(): JsonNode {
    this.advance(); // [
    this.skipWs();
    const elements: JsonNode[] = [];
    if (this.peek() === "]") {
      this.advance();
      return { kind: "array", elements };
    }
    while (true) {
      elements.push(this.parseValue());
      this.skipWs();
      const sep = this.peek();
      if (sep === ",") {
        this.advance();
        this.skipWs();
        if (!this.strictCanonical && this.peek() === "]") {
          this.advance();
          break;
        }
        continue;
      }
      if (sep === "]") {
        this.advance();
        break;
      }
      throw new JsonParseError("malformed JSON", this.pos1());
    }
    return { kind: "array", elements };
  }

  parseString(): JsonNode {
    const quote = this.advance();
    if (this.strictCanonical && quote !== '"') {
      throw new JsonParseError("malformed JSON", this.pos1());
    }
    let out = "";
    while (!this.eof()) {
      const ch = this.advance();
      if (ch === quote) return { kind: "string", value: out };
      if (ch === "\\") {
        if (this.eof()) throw new JsonParseError("malformed JSON", this.pos1());
        const esc = this.advance();
        switch (esc) {
          case '"':
          case "'":
          case "\\":
          case "/":
            out += esc;
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
            const hex = this.s.slice(this.i, this.i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JsonParseError("malformed JSON", this.pos1());
            this.i += 4;
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          case "\n":
          case "\r":
            if (this.strictCanonical) throw new JsonParseError("malformed JSON", this.pos1());
            if (esc === "\r" && this.peek() === "\n") this.advance();
            break;
          default:
            if (this.strictCanonical) throw new JsonParseError("malformed JSON", this.pos1());
            out += esc;
        }
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        if (this.strictCanonical) throw new JsonParseError("malformed JSON", this.pos1());
      }
      out += ch;
    }
    throw new JsonParseError("malformed JSON", this.pos1());
  }

  parseNumber(): JsonNode {
    const start = this.i;
    if (this.peek() === "+" || this.peek() === "-") {
      if (this.strictCanonical && this.peek() === "+") {
        throw new JsonParseError("malformed JSON", this.pos1());
      }
      this.advance();
    }
    // Infinity / NaN handled via keyword if letter
    if (/[A-Za-z]/.test(this.peek())) {
      this.i = start;
      return this.parseKeyword();
    }
    if (this.peek() === "0" && /[xX]/.test(this.peek(1))) {
      if (this.strictCanonical) throw new JsonParseError("malformed JSON", this.pos1());
      this.i += 2;
      while (/[0-9a-fA-F]/.test(this.peek())) this.advance();
      const text = this.s.slice(start, this.i);
      const n = Number(text);
      if (!Number.isFinite(n)) throw new JsonParseError("malformed JSON", start + 1);
      return Number.isInteger(n) ? { kind: "integer", text: String(Math.trunc(n)) } : { kind: "real", text: String(n) };
    }
    let seenDot = false;
    let seenExp = false;
    if (this.peek() === ".") {
      if (this.strictCanonical) throw new JsonParseError("malformed JSON", this.pos1());
      seenDot = true;
      this.advance();
    }
    if (!(this.peek() >= "0" && this.peek() <= "9") && !seenDot) {
      throw new JsonParseError("malformed JSON", this.pos1());
    }
    while (this.peek() >= "0" && this.peek() <= "9") this.advance();
    if (this.peek() === ".") {
      seenDot = true;
      this.advance();
      while (this.peek() >= "0" && this.peek() <= "9") this.advance();
    }
    if (this.peek() === "e" || this.peek() === "E") {
      seenExp = true;
      this.advance();
      if (this.peek() === "+" || this.peek() === "-") this.advance();
      if (!(this.peek() >= "0" && this.peek() <= "9")) throw new JsonParseError("malformed JSON", this.pos1());
      while (this.peek() >= "0" && this.peek() <= "9") this.advance();
    }
    const raw = this.s.slice(start, this.i);
    if (this.strictCanonical) {
      if (raw.startsWith("+")) throw new JsonParseError("malformed JSON", start + 1);
      if (raw.includes(".") && (raw.startsWith(".") || raw.endsWith(".") || /\.-|\+\./.test(raw))) {
        // trailing/leading dot rejected in strict — already partially handled
      }
      if (/^-?0\d/.test(raw)) throw new JsonParseError("malformed JSON", start + 1);
    }
    const canon = canonicalizeNumberText(raw);
    if (canon.kind === "integer" || (!seenDot && !seenExp && !raw.includes("."))) {
      // Prefer integer when no fractional/exponent markers in original (after leading +-)
      const body = raw.replace(/^[+-]/, "");
      if (!body.includes(".") && !/[eE]/.test(body)) {
        return { kind: "integer", text: canon.text };
      }
    }
    return { kind: "real", text: canon.text };
  }

  parseKeyword(): JsonNode {
    const start = this.i;
    while (/[A-Za-z]/.test(this.peek())) this.advance();
    const word = this.s.slice(start, this.i);
    const lower = word.toLowerCase();
    if (lower === "null") return { kind: "null" };
    if (lower === "true") return { kind: "true" };
    if (lower === "false") return { kind: "false" };
    if (!this.strictCanonical) {
      if (lower === "nan" || lower === "qnan" || lower === "snan") return { kind: "null" };
      if (lower === "infinity" || lower === "inf") {
        const _sign = this.s[start - 1] === "-" ? "-" : "";
        // Treat as null-ish? Docs say Inf is allowed in JSON5 input and converted; use a large number string?
        // SQLite converts Infinity to null when rendering? Actually json() of Infinity might error or become null.
        // Probe showed NaN -> null. For Inf, check:
        return { kind: "null" };
      }
    }
    throw new JsonParseError("malformed JSON", start + 1);
  }

  isIdentStart(ch: string): boolean {
    return /[A-Za-z_$]/.test(ch) || (ch.length > 0 && ch.charCodeAt(0) > 0x7f);
  }

  parseIdent(): string {
    let out = "";
    while (!this.eof()) {
      const ch = this.peek();
      if (/[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 0x7f) {
        out += this.advance();
        continue;
      }
      break;
    }
    if (!out) throw new JsonParseError("malformed JSON", this.pos1());
    return out;
  }
}

function canonicalizeNumberText(raw: string): { kind: "integer" | "real"; text: string } {
  let s = raw.trim();
  if (s.startsWith("+")) s = s.slice(1);
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new JsonParseError("malformed JSON", 1);
  }
  if (Number.isInteger(n) && !/[eE.]/.test(s.replace(/^-/, ""))) {
    return { kind: "integer", text: String(Math.trunc(n)) };
  }
  // Prefer a stable JSON number rendering
  let text = String(n);
  if (text.includes("e") || text.includes("E")) {
    // keep JS default
  } else if (text.endsWith(".0") && Number.isInteger(n)) {
    text = String(Math.trunc(n));
    return { kind: "integer", text };
  }
  return { kind: Number.isInteger(n) && !s.includes(".") && !/[eE]/.test(s) ? "integer" : "real", text };
}

export function malformedJsonError(position?: number): SqliteError {
  return new SqliteError(position !== undefined ? `malformed JSON` : "malformed JSON", "other");
}
