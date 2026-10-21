/** `cjson`, the JSON library Redis bundles (lua-cjson 2.1). Strings are byte strings throughout. */

import { numberToString } from "./format.ts"
import { checkInt, checkString, freeze, makeLib } from "./stdlib.ts"
import { LuaTable, LuaUserdata, type LuaValue, rtError, typeName } from "./value.ts"

export const cjsonNull = new LuaUserdata("cjson.null")

const config = {
  encodeMaxDepth: 1000,
  decodeMaxDepth: 1000,
  sparseConvert: false,
  sparseRatio: 2,
  sparseSafe: 10,
  precision: 14,
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "/": "\\/",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
}

function quote(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string
    const escaped = ESCAPES[c]
    if (escaped !== undefined) out += escaped
    else {
      const code = c.charCodeAt(0)
      out += code < 32 || code === 127 ? `\\u${code.toString(16).padStart(4, "0")}` : c
    }
  }
  return `${out}"`
}

function numberText(n: number): string {
  if (!Number.isFinite(n)) rtError("Cannot serialise number: must not be NaN or Inf")
  return config.precision === 14
    ? numberToString(n)
    : String(Number(n.toPrecision(config.precision)))
}

/** The highest index when every key is a positive integer, or -1 when the table is an object. */
function arrayLength(table: LuaTable): number {
  let max = 0
  let items = 0
  for (let entry = table.next(undefined); entry !== undefined; entry = table.next(entry[0])) {
    const key = entry[0]
    if (typeof key !== "number" || !Number.isInteger(key) || key < 1) return -1
    if (key > max) max = key
    items++
  }
  if (max > config.sparseSafe && max > items * config.sparseRatio) {
    if (!config.sparseConvert) rtError("Cannot serialise table: excessively sparse array")
    return -1
  }
  return max
}

function encodeValue(value: LuaValue, depth: number, out: string[]): void {
  switch (typeof value) {
    case "undefined":
      out.push("null")
      return
    case "boolean":
      out.push(value ? "true" : "false")
      return
    case "number":
      out.push(numberText(value))
      return
    case "string":
      out.push(quote(value))
      return
    case "function":
      rtError("Cannot serialise function: type not supported")
      return
    default:
      break
  }
  if (value === cjsonNull) {
    out.push("null")
    return
  }
  if (!(value instanceof LuaTable)) {
    rtError("Cannot serialise userdata: type not supported")
    return
  }
  if (depth + 1 > config.encodeMaxDepth) {
    rtError(`Cannot serialise, excessive nesting (${depth + 1})`)
  }
  const length = arrayLength(value)
  if (length > 0) {
    out.push("[")
    for (let i = 1; i <= length; i++) {
      if (i > 1) out.push(",")
      encodeValue(value.get(i), depth + 1, out)
    }
    out.push("]")
    return
  }
  out.push("{")
  let first = true
  for (let entry = value.next(undefined); entry !== undefined; entry = value.next(entry[0])) {
    const key = entry[0]
    if (typeof key !== "string" && typeof key !== "number") {
      rtError(`Cannot serialise ${typeName(key)}: table key must be a number or string`)
    }
    if (!first) out.push(",")
    first = false
    out.push(quote(typeof key === "number" ? numberText(key) : (key as string)))
    out.push(":")
    encodeValue(entry[1], depth + 1, out)
  }
  out.push("}")
}

export function encodeJson(value: LuaValue): string {
  const out: string[] = []
  encodeValue(value, 0, out)
  return out.join("")
}

// ---------------------------------------------------------------------------------------------
// Decoding

type Token =
  | {
      type:
        | "T_OBJ_BEGIN"
        | "T_OBJ_END"
        | "T_ARR_BEGIN"
        | "T_ARR_END"
        | "T_COLON"
        | "T_COMMA"
        | "T_END"
      index: number
    }
  | { type: "T_STRING"; index: number; value: string }
  | { type: "T_NUMBER"; index: number; value: number }
  | { type: "T_BOOLEAN"; index: number; value: boolean }
  | { type: "T_NULL"; index: number }
  | { type: "T_ERROR"; index: number; value: string }

const PUNCTUATION: Record<string, Token["type"]> = {
  "{": "T_OBJ_BEGIN",
  "}": "T_OBJ_END",
  "[": "T_ARR_BEGIN",
  "]": "T_ARR_END",
  ":": "T_COLON",
  ",": "T_COMMA",
}

function utf8FromCodePoint(code: number): string {
  if (code < 0x80) return String.fromCharCode(code)
  if (code < 0x800) return String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 63))
  if (code < 0x10000) {
    return String.fromCharCode(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  return String.fromCharCode(
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 63),
    0x80 | ((code >> 6) & 63),
    0x80 | (code & 63),
  )
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
}

class Decoder {
  private at = 0
  constructor(private readonly text: string) {}

  private fail(expected: string, token: Token): never {
    const found = token.type === "T_ERROR" ? token.value : token.type
    return rtError(`Expected ${expected} but found ${found} at character ${token.index + 1}`)
  }

  private skipSpace(): void {
    const text = this.text
    while (" \t\n\r".includes(text[this.at] ?? "x")) this.at++
  }

  private token(): Token {
    this.skipSpace()
    const text = this.text
    const index = this.at
    const c = text[index]
    if (c === undefined) return { type: "T_END", index }
    const punctuation = PUNCTUATION[c]
    if (punctuation !== undefined) {
      this.at++
      return { type: punctuation, index } as Token
    }
    if (c === '"') return this.stringToken(index)
    if (c === "-" || (c >= "0" && c <= "9")) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index, index + 400))
      if (match === null) return { type: "T_ERROR", index, value: "invalid token" }
      this.at += match[0].length
      return { type: "T_NUMBER", index, value: Number(match[0]) }
    }
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, index)) {
        this.at += word.length
        return value === null ? { type: "T_NULL", index } : { type: "T_BOOLEAN", index, value }
      }
    }
    return { type: "T_ERROR", index, value: "invalid token" }
  }

  private stringToken(index: number): Token {
    const text = this.text
    let i = index + 1
    let out = ""
    for (;;) {
      const c = text[i]
      if (c === undefined)
        return { type: "T_ERROR", index: text.length, value: "unexpected end of string" }
      if (c === '"') break
      if (c !== "\\") {
        out += c
        i++
        continue
      }
      const esc = text[i + 1]
      if (esc === "u") {
        const hex = text.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { type: "T_ERROR", index: i, value: "invalid unicode escape code" }
        }
        let code = Number.parseInt(hex, 16)
        i += 6
        if (code >= 0xd800 && code <= 0xdbff) {
          const low = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(text.slice(i, i + 6))
          if (low === null)
            return { type: "T_ERROR", index: i, value: "invalid unicode escape code" }
          code =
            0x10000 + ((code - 0xd800) << 10) + (Number.parseInt(low[1] as string, 16) - 0xdc00)
          i += 6
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return { type: "T_ERROR", index: i - 5, value: "invalid unicode escape code" }
        }
        out += utf8FromCodePoint(code)
        continue
      }
      const simple = esc === undefined ? undefined : SIMPLE_ESCAPES[esc]
      if (simple === undefined) return { type: "T_ERROR", index: i, value: "invalid escape code" }
      out += simple
      i += 2
    }
    this.at = i + 1
    return { type: "T_STRING", index, value: out }
  }

  private value(token: Token, depth: number): LuaValue {
    switch (token.type) {
      case "T_STRING":
      case "T_NUMBER":
      case "T_BOOLEAN":
        return token.value
      case "T_NULL":
        return cjsonNull
      case "T_OBJ_BEGIN":
        return this.object(depth + 1, token)
      case "T_ARR_BEGIN":
        return this.array(depth + 1, token)
      default:
        return this.fail("value", token)
    }
  }

  private depthCheck(depth: number, token: Token): void {
    if (depth > config.decodeMaxDepth) {
      rtError(`Found too many nested data structures (${depth}) at character ${token.index + 1}`)
    }
  }

  private object(depth: number, start: Token): LuaValue {
    this.depthCheck(depth, start)
    const table = new LuaTable()
    let token = this.token()
    if (token.type === "T_OBJ_END") return table
    for (;;) {
      if (token.type !== "T_STRING") this.fail("object key string", token)
      const key = token.value
      const colon = this.token()
      if (colon.type !== "T_COLON") this.fail("colon", colon)
      table.set(key, this.value(this.token(), depth))
      token = this.token()
      if (token.type === "T_OBJ_END") return table
      if (token.type !== "T_COMMA") this.fail("comma or object end", token)
      token = this.token()
    }
  }

  private array(depth: number, start: Token): LuaValue {
    this.depthCheck(depth, start)
    const items: LuaValue[] = []
    let token = this.token()
    if (token.type === "T_ARR_END") return new LuaTable()
    for (;;) {
      items.push(this.value(token, depth))
      token = this.token()
      if (token.type === "T_ARR_END") break
      if (token.type !== "T_COMMA") this.fail("comma or array end", token)
      token = this.token()
    }
    const table = new LuaTable()
    table.arr = items
    return table
  }

  decode(): LuaValue {
    const result = this.value(this.token(), 0)
    const end = this.token()
    if (end.type !== "T_END") this.fail("the end", end)
    return result
  }
}

export function decodeJson(text: string): LuaValue {
  return new Decoder(text).decode()
}

function setter(apply: (args: LuaValue[]) => void, read: () => LuaValue) {
  return (...args: LuaValue[]) => {
    if (args.length > 0 && args[0] !== undefined) apply(args)
    return read()
  }
}

/** An option this runtime has one behaviour for: reading it works, changing it is an error. */
function fixed(name: string, value: boolean) {
  return (...args: LuaValue[]) => {
    if (args[0] !== undefined && args[0] !== value) {
      rtError(`cjson.${name} is not supported by this emulator: it is always ${value}`)
    }
    return value
  }
}

export function cjsonLib(): LuaTable {
  return freeze(
    makeLib({
      encode: (...args: LuaValue[]) => {
        if (args.length !== 1) rtError("bad argument #1 to 'encode' (expected 1 argument)")
        return encodeJson(args[0])
      },
      decode: (...args: LuaValue[]) => {
        if (args.length !== 1) rtError("bad argument #1 to 'decode' (expected 1 argument)")
        return decodeJson(checkString(args, 0, "decode"))
      },
      null: cjsonNull,
      encode_max_depth: setter(
        (args) => {
          config.encodeMaxDepth = checkInt(args, 0, "encode_max_depth")
        },
        () => config.encodeMaxDepth,
      ),
      decode_max_depth: setter(
        (args) => {
          config.decodeMaxDepth = checkInt(args, 0, "decode_max_depth")
        },
        () => config.decodeMaxDepth,
      ),
      encode_number_precision: setter(
        (args) => {
          const precision = checkInt(args, 0, "encode_number_precision")
          if (precision < 1 || precision > 14)
            rtError(
              "bad argument #1 to 'encode_number_precision' (expected integer between 1 and 14)",
            )
          config.precision = precision
        },
        () => config.precision,
      ),
      encode_sparse_array: (...args: LuaValue[]) => {
        if (args[0] !== undefined) config.sparseConvert = args[0] !== false
        if (args[1] !== undefined) config.sparseRatio = checkInt(args, 1, "encode_sparse_array")
        if (args[2] !== undefined) config.sparseSafe = checkInt(args, 2, "encode_sparse_array")
        return [config.sparseConvert, config.sparseRatio, config.sparseSafe]
      },
      encode_keep_buffer: fixed("encode_keep_buffer", true),
      encode_invalid_numbers: fixed("encode_invalid_numbers", false),
      decode_invalid_numbers: fixed("decode_invalid_numbers", true),
    }),
  )
}
