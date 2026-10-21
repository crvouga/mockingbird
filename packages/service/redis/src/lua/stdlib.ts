/** The Lua 5.1 standard library as Redis exposes it: base, string, table, math, `os.clock`, `bit`. */

import { formatFloat, formatInteger, type NumberSpec, numberToString } from "./format.ts"
import {
  callValue,
  first,
  indexValue,
  ipairsIterator,
  lessThan,
  metaOf,
  nextFunction,
  setStringMethods,
  tostr,
} from "./interp.ts"
import { doMatch, getCapture, getCaptures, hasSpecials, newState } from "./pattern.ts"
import {
  EMPTY,
  LuaError,
  LuaTable,
  type LuaValue,
  parseNumber,
  parseNumberBase,
  pos,
  rtError,
  truthy,
  typeName,
} from "./value.ts"

type Args = LuaValue[]
type Result = LuaValue | LuaValue[]

// ---------------------------------------------------------------------------------------------
// Argument checking

function argError(i: number, fname: string, message: string): never {
  return rtError(`bad argument #${i + 1} to '${pos.line < 0 ? "?" : fname}' (${message})`)
}

function typeArgError(args: Args, i: number, fname: string, expected: string): never {
  const got = i >= args.length ? "no value" : typeName(args[i])
  return argError(i, fname, `${expected} expected, got ${got}`)
}

export function checkNumber(args: Args, i: number, fname: string): number {
  const value = args[i]
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const n = parseNumber(value)
    if (n !== undefined) return n
  }
  return typeArgError(args, i, fname, "number")
}

export function optNumber(args: Args, i: number, fname: string, fallback: number): number {
  return args[i] === undefined ? fallback : checkNumber(args, i, fname)
}

/** `luaL_checkinteger`: the number, truncated toward zero. */
export function checkInt(args: Args, i: number, fname: string): number {
  const n = checkNumber(args, i, fname)
  return Number.isNaN(n) ? 0 : Math.trunc(n)
}

export function optInt(args: Args, i: number, fname: string, fallback: number): number {
  return args[i] === undefined ? fallback : checkInt(args, i, fname)
}

export function checkString(args: Args, i: number, fname: string): string {
  const value = args[i]
  if (typeof value === "string") return value
  if (typeof value === "number") return numberToString(value)
  return typeArgError(args, i, fname, "string")
}

export function optString(args: Args, i: number, fname: string, fallback: string): string {
  return args[i] === undefined ? fallback : checkString(args, i, fname)
}

export function checkTable(args: Args, i: number, fname: string): LuaTable {
  const value = args[i]
  if (value instanceof LuaTable) return value
  return typeArgError(args, i, fname, "table")
}

function checkAny(args: Args, i: number, fname: string): LuaValue {
  if (i >= args.length) argError(i, fname, "value expected")
  return args[i]
}

// ---------------------------------------------------------------------------------------------
// tostring / tonumber

const addresses = new WeakMap<object, number>()
let nextAddress = 0x5581d0a0

function address(object: object): string {
  let id = addresses.get(object)
  if (id === undefined) {
    nextAddress += 0x40
    id = nextAddress
    addresses.set(object, id)
  }
  return `0x${id.toString(16).padStart(8, "0")}`
}

export function tostringValue(value: LuaValue): string {
  switch (typeof value) {
    case "undefined":
      return "nil"
    case "boolean":
      return value ? "true" : "false"
    case "number":
      return numberToString(value)
    case "string":
      return value
    case "function":
      return `function: ${address(value)}`
    default: {
      if (value instanceof LuaTable) {
        const handler = metaOf(value, "__tostring")
        if (handler !== undefined) {
          const result = first(callValue(handler, [value]))
          if (typeof result !== "string") rtError("'__tostring' must return a string")
          return result
        }
        return `table: ${address(value)}`
      }
      return `userdata: ${address(value)}`
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Library tables

/** Library functions, as opposed to functions a script defines. */
const builtins = new WeakSet<object>()

export function makeLib(entries: Record<string, LuaValue>): LuaTable {
  const table = new LuaTable()
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value === "function") builtins.add(value)
    table.set(name, value)
  }
  return table
}

/**
 * Call `fn` for `pcall`. A library function called directly from `pcall` has no calling Lua line
 * (its errors carry no `user_script:N:` prefix and name the function `?`).
 */
function protectedCall(fn: LuaValue, args: Args): Result {
  if (typeof fn === "function" && !builtins.has(fn)) return fn(...args)
  const line = pos.line
  pos.line = -1
  try {
    return callValue(fn, args)
  } finally {
    pos.line = line
  }
}

/** Mark a library table, and the tables it holds, as read-only for scripts. */
export function freeze(table: LuaTable): LuaTable {
  table.readonly = true
  return table
}

function caught(error: unknown): LuaValue {
  if (error instanceof LuaError) {
    const value = error.value
    if (value instanceof LuaTable) {
      const text = value.getStr("err")
      if (typeof text === "string") return text
    }
    return value
  }
  if (error instanceof RangeError) return `user_script:${pos.line}: stack overflow`
  throw error
}

function pcall(...args: Args): Result {
  const fn = args[0]
  try {
    const result = protectedCall(fn, args.slice(1))
    return Array.isArray(result) ? [true, ...result] : [true, result]
  } catch (error) {
    return [false, caught(error)]
  }
}

function xpcall(...args: Args): Result {
  const fn = args[0]
  const handler = args[1]
  try {
    const result = protectedCall(fn, EMPTY)
    return Array.isArray(result) ? [true, ...result] : [true, result]
  } catch (error) {
    const value = caught(error)
    const handled = callValue(handler, [value])
    return Array.isArray(handled) ? [false, ...handled] : [false, handled]
  }
}

const stringMeta = new LuaTable()

function getmetatable(...args: Args): Result {
  const value = checkAny(args, 0, "getmetatable")
  if (typeof value === "string") return stringMeta
  if (!(value instanceof LuaTable) || value.meta === null) return undefined
  const protectedMeta = value.meta.getStr("__metatable")
  return protectedMeta !== undefined ? protectedMeta : value.meta
}

function setmetatable(...args: Args): Result {
  const table = checkTable(args, 0, "setmetatable")
  const meta = args[1]
  if (meta !== undefined && !(meta instanceof LuaTable)) {
    return typeArgError(args, 1, "setmetatable", "nil or table")
  }
  if (table.readonly) rtError("Attempt to modify a readonly table")
  if (table.meta !== null && table.meta.getStr("__metatable") !== undefined) {
    rtError("cannot change a protected metatable")
  }
  table.meta = meta ?? null
  return table
}

function toNumberBuiltin(...args: Args): Result {
  const value = checkAny(args, 0, "tonumber")
  if (args[1] === undefined || args[1] === 10) {
    if (typeof value === "number") return value
    return typeof value === "string" ? parseNumber(value) : undefined
  }
  const base = checkInt(args, 1, "tonumber")
  if (base < 2 || base > 36) argError(1, "tonumber", "base out of range")
  const text = checkString(args, 0, "tonumber")
  return parseNumberBase(text, base)
}

function unpack(...args: Args): Result {
  const table = checkTable(args, 0, "unpack")
  const from = optInt(args, 1, "unpack", 1)
  const to = args[2] === undefined ? table.length() : checkInt(args, 2, "unpack")
  if (from > to) return EMPTY
  if (to - from >= 8000) rtError("too many results to unpack")
  const out: LuaValue[] = []
  for (let i = from; i <= to; i++) out.push(table.get(i))
  return out
}

function select(...args: Args): Result {
  const n = args[0]
  if (n === "#") return args.length - 1
  let index = checkInt(args, 0, "select")
  if (index < 0) index = args.length + index
  else if (index > args.length - 1) return EMPTY
  if (index < 1) argError(0, "select", "index out of range")
  return args.slice(index)
}

function errorBuiltin(...args: Args): Result {
  let value = args[0]
  const level = optInt(args, 1, "error", 1)
  if ((typeof value === "string" || typeof value === "number") && level > 0 && pos.line >= 0) {
    value = `user_script:${pos.line}: ${tostr(value)}`
  }
  throw new LuaError(value)
}

function assertBuiltin(...args: Args): Result {
  if (args.length === 0) argError(0, "assert", "value expected")
  if (truthy(args[0])) return args
  const message = args[1]
  if (message === undefined) return rtError("assertion failed!")
  if (typeof message === "string") return rtError(message)
  throw new LuaError(message)
}

export function baseLib(globals: LuaTable): void {
  const register = (name: string, value: LuaValue) => {
    if (typeof value === "function") builtins.add(value)
    globals.set(name, value)
  }
  register("assert", assertBuiltin)
  register("collectgarbage", () => 0)
  register("gcinfo", () => 0)
  register("error", errorBuiltin)
  register("getmetatable", getmetatable)
  register("setmetatable", setmetatable)
  register("ipairs", (...args: Args) => [ipairsIterator, checkTable(args, 0, "ipairs"), 0])
  register("pairs", (...args: Args) => [nextFunction, checkTable(args, 0, "pairs"), undefined])
  register("next", (...args: Args) => nextFunction(checkTable(args, 0, "next"), args[1]))
  register("pcall", pcall)
  register("xpcall", xpcall)
  register("rawequal", (...args: Args) => args[0] === args[1])
  register("rawget", (...args: Args) => checkTable(args, 0, "rawget").get(args[1]))
  register("rawset", (...args: Args) => {
    const table = checkTable(args, 0, "rawset")
    if (table.readonly) rtError("Attempt to modify a readonly table")
    const key = args[1]
    // Raised inside a library function, so without a `user_script:N:` prefix.
    if (key === undefined) throw new LuaError("table index is nil")
    if (typeof key === "number" && Number.isNaN(key)) throw new LuaError("table index is NaN")
    table.set(key, args[2])
    return table
  })
  register("select", select)
  register("tonumber", toNumberBuiltin)
  register("tostring", (...args: Args) => tostringValue(checkAny(args, 0, "tostring")))
  register("type", (...args: Args) => typeName(checkAny(args, 0, "type")))
  register("unpack", unpack)
  register("_VERSION", "Lua 5.1")
}

// ---------------------------------------------------------------------------------------------
// string

/** `posrelat`: a possibly negative 1-based position, made absolute. */
function relativePosition(position: number, length: number): number {
  if (position >= 0) return position
  return -position > length ? 0 : length + position + 1
}

function strSub(...args: Args): Result {
  const s = checkString(args, 0, "sub")
  const length = s.length
  let start = relativePosition(checkInt(args, 1, "sub"), length)
  let end = relativePosition(optInt(args, 2, "sub", -1), length)
  if (start < 1) start = 1
  if (end > length) end = length
  return start <= end ? s.slice(start - 1, end) : ""
}

function strByte(...args: Args): Result {
  const s = checkString(args, 0, "byte")
  let start = relativePosition(optInt(args, 1, "byte", 1), s.length)
  let end = relativePosition(optInt(args, 2, "byte", start), s.length)
  if (start < 1) start = 1
  if (end > s.length) end = s.length
  if (start > end) return EMPTY
  const out: number[] = []
  for (let i = start; i <= end; i++) out.push(s.charCodeAt(i - 1))
  return out
}

function strChar(...args: Args): Result {
  let out = ""
  for (let i = 0; i < args.length; i++) {
    const code = checkInt(args, i, "char")
    if (code < 0 || code > 255) argError(i, "char", "invalid value")
    out += String.fromCharCode(code)
  }
  return out
}

function strRep(...args: Args): Result {
  const s = checkString(args, 0, "rep")
  const n = checkInt(args, 1, "rep")
  if (n <= 0 || s === "") return ""
  if (s.length * n > 0x10000000) rtError("not enough memory")
  return s.repeat(n)
}

const FORMAT_FLAGS = "-+ #0"

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9"

function padText(text: string, width: number, left: boolean): string {
  if (text.length >= width) return text
  return left ? text + " ".repeat(width - text.length) : " ".repeat(width - text.length) + text
}

function quote(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string
    if (c === '"' || c === "\\" || c === "\n") out += `\\${c}`
    else if (c === "\r") out += "\\r"
    else if (c === "\0") out += "\\000"
    else out += c
  }
  return `${out}"`
}

function strFormat(...args: Args): Result {
  const fmt = checkString(args, 0, "format")
  let out = ""
  let arg = 0
  let i = 0
  while (i < fmt.length) {
    const c = fmt[i++] as string
    if (c !== "%") {
      out += c
      continue
    }
    if (fmt[i] === "%") {
      out += "%"
      i++
      continue
    }
    arg++
    if (arg >= args.length) argError(arg, "format", "no value")
    let flags = ""
    while (i < fmt.length && FORMAT_FLAGS.includes(fmt[i] as string)) flags += fmt[i++]
    let widthText = ""
    while (isDigit(fmt[i])) widthText += fmt[i++]
    let precision: number | null = null
    if (fmt[i] === ".") {
      i++
      let precisionText = ""
      while (isDigit(fmt[i])) precisionText += fmt[i++]
      if (precisionText.length > 2) rtError("invalid format (width or precision too long)")
      precision = precisionText === "" ? 0 : Number(precisionText)
    }
    if (widthText.length > 2) rtError("invalid format (width or precision too long)")
    const conv = fmt[i++]
    if (conv === undefined) return rtError("invalid option '%' to 'format'")
    const width = widthText === "" ? 0 : Number(widthText)
    const spec: NumberSpec = { conv, flags, width, precision }
    switch (conv) {
      case "c":
        out += padText(
          String.fromCharCode(checkInt(args, arg, "format") & 255),
          width,
          flags.includes("-"),
        )
        break
      case "d":
      case "i":
      case "o":
      case "u":
      case "x":
      case "X":
        out += formatInteger(checkNumber(args, arg, "format"), spec)
        break
      case "e":
      case "E":
      case "f":
      case "g":
      case "G":
        out += formatFloat(checkNumber(args, arg, "format"), spec)
        break
      case "q":
        out += quote(checkString(args, arg, "format"))
        break
      case "s": {
        let s = checkString(args, arg, "format")
        // C's `%s` stops at a NUL; only a long string with no precision is copied whole.
        if (precision !== null || s.length < 100) {
          const nul = s.indexOf("\0")
          if (nul >= 0) s = s.slice(0, nul)
        }
        if (precision !== null) s = s.slice(0, precision)
        out += padText(s, width, flags.includes("-"))
        break
      }
      default:
        return rtError(`invalid option '%${conv}' to 'format'`)
    }
  }
  return out
}

function findAux(args: Args, find: boolean): Result {
  const name = find ? "find" : "match"
  const s = checkString(args, 0, name)
  const p = checkString(args, 1, name)
  let init = relativePosition(optInt(args, 2, name, 1), s.length) - 1
  if (init < 0) init = 0
  else if (init > s.length) init = s.length
  if (find && (truthy(args[3]) || !hasSpecials(p))) {
    const at = s.indexOf(p, init)
    return at < 0 ? undefined : [at + 1, at + p.length]
  }
  const anchor = p.charCodeAt(0) === 94
  const start = anchor ? 1 : 0
  let s1 = init
  do {
    const ms = newState(s, p)
    const end = doMatch(ms, s1, start)
    if (end !== -1) {
      if (find) return [s1 + 1, end, ...getCaptures(ms, s1, end, false)]
      return getCaptures(ms, s1, end, true)
    }
  } while (s1++ < s.length && !anchor)
  return undefined
}

function strGmatch(...args: Args): Result {
  const s = checkString(args, 0, "gmatch")
  const p = checkString(args, 1, "gmatch")
  let at = 0
  return (): Result => {
    for (; at <= s.length; at++) {
      const ms = newState(s, p)
      const end = doMatch(ms, at, 0)
      if (end !== -1) {
        const matchStart = at
        at = end === at ? end + 1 : end
        return getCaptures(ms, matchStart, end, true)
      }
    }
    return undefined
  }
}

function addReplacement(
  ms: ReturnType<typeof newState>,
  s: number,
  e: number,
  repl: LuaValue,
  kind: string,
): string {
  const whole = ms.src.slice(s, e)
  let value: LuaValue
  if (kind === "string") {
    const text = repl as string
    let out = ""
    for (let i = 0; i < text.length; i++) {
      const c = text[i] as string
      if (c !== "%") {
        out += c
        continue
      }
      i++
      const next = text[i]
      if (next === undefined || next < "0" || next > "9") {
        if (next !== "%") rtError("invalid use of '%' in replacement string")
        out += "%"
      } else if (next === "0") out += whole
      else out += String(getCapture(ms, next.charCodeAt(0) - 49, s, e))
    }
    return out
  }
  if (kind === "table") {
    const key = ms.level === 0 ? whole : getCapture(ms, 0, s, e)
    value = indexValue(repl, key)
  } else {
    const captures = getCaptures(ms, s, e, true)
    value = first(callValue(repl, captures))
  }
  if (value === undefined || value === false) return whole
  const text = tostr(value)
  if (text === undefined) return rtError(`invalid replacement value (a ${typeName(value)})`)
  return text
}

function strGsub(...args: Args): Result {
  const src = checkString(args, 0, "gsub")
  const p = checkString(args, 1, "gsub")
  const repl = args[2]
  let kind = typeName(repl)
  if (kind === "number") kind = "string"
  if (kind !== "string" && kind !== "table" && kind !== "function") {
    return argError(2, "gsub", "string/function/table expected")
  }
  const replacement = typeof repl === "number" ? numberToString(repl) : repl
  const anchor = p.charCodeAt(0) === 94
  const start = anchor ? 1 : 0
  const max = args[3] === undefined ? src.length + 1 : checkInt(args, 3, "gsub")
  let out = ""
  let at = 0
  let count = 0
  while (count < max) {
    const ms = newState(src, p)
    const end = doMatch(ms, at, start)
    if (end !== -1) {
      count++
      out += addReplacement(ms, at, end, replacement, kind)
    }
    if (end !== -1 && end > at) at = end
    else if (at < src.length) out += src[at++]
    else break
    if (anchor) break
  }
  return [out + src.slice(at), count]
}

export function stringLib(): LuaTable {
  const lib = makeLib({
    len: (...args: Args) => checkString(args, 0, "len").length,
    sub: strSub,
    byte: strByte,
    char: strChar,
    rep: strRep,
    reverse: (...args: Args) => [...checkString(args, 0, "reverse")].reverse().join(""),
    lower: (...args: Args) =>
      checkString(args, 0, "lower").replace(/[A-Z]+/g, (m) => m.toLowerCase()),
    upper: (...args: Args) =>
      checkString(args, 0, "upper").replace(/[a-z]+/g, (m) => m.toUpperCase()),
    format: strFormat,
    find: (...args: Args) => findAux(args, true),
    match: (...args: Args) => findAux(args, false),
    gmatch: strGmatch,
    gfind: strGmatch,
    gsub: strGsub,
    dump: () => rtError("unable to dump given function"),
  })
  stringMeta.set("__index", lib)
  setStringMethods(lib)
  return freeze(lib)
}

// ---------------------------------------------------------------------------------------------
// table

function tableInsert(...args: Args): Result {
  const table = checkTable(args, 0, "insert")
  const n = table.length() + 1
  if (args.length === 2) table.set(n, args[1])
  else if (args.length === 3) {
    const at = checkInt(args, 1, "insert")
    for (let i = n; i > at; i--) table.set(i, table.get(i - 1))
    table.set(at, args[2])
  } else rtError("wrong number of arguments to 'insert'")
  return EMPTY
}

function tableRemove(...args: Args): Result {
  const table = checkTable(args, 0, "remove")
  const size = table.length()
  let at = optInt(args, 1, "remove", size)
  if (at < 1 || at > size) return EMPTY
  const removed = table.get(at)
  for (; at < size; at++) table.set(at, table.get(at + 1))
  table.set(size, undefined)
  return removed
}

function tableConcat(...args: Args): Result {
  const table = checkTable(args, 0, "concat")
  const separator = optString(args, 1, "concat", "")
  const from = optInt(args, 2, "concat", 1)
  const to = args[3] === undefined ? table.length() : checkInt(args, 3, "concat")
  const parts: string[] = []
  for (let i = from; i <= to; i++) {
    const text = tostr(table.get(i))
    if (text === undefined) {
      rtError(`invalid value (${typeName(table.get(i))}) at index ${i} in table for 'concat'`)
    }
    parts.push(text as string)
  }
  return parts.join(separator)
}

function tableSort(...args: Args): Result {
  const table = checkTable(args, 0, "sort")
  const comparator = args[1]
  if (
    comparator !== undefined &&
    typeof comparator !== "function" &&
    !(comparator instanceof LuaTable)
  ) {
    return typeArgError(args, 1, "sort", "function")
  }
  const n = table.length()
  const items: LuaValue[] = []
  for (let i = 1; i <= n; i++) items.push(table.get(i))
  const less =
    comparator === undefined
      ? lessThan
      : (a: LuaValue, b: LuaValue) => truthy(first(callValue(comparator, [a, b])))
  const sorted = mergeSort(items, comparator === undefined ? withoutPosition(less) : less)
  for (let i = 0; i < n; i++) table.set(i + 1, sorted[i])
  return EMPTY
}

/** Errors raised inside a C function such as `table.sort` carry no `user_script:N:` prefix. */
function withoutPosition(
  less: (a: LuaValue, b: LuaValue) => boolean,
): (a: LuaValue, b: LuaValue) => boolean {
  return (a, b) => {
    try {
      return less(a, b)
    } catch (error) {
      if (error instanceof LuaError && typeof error.value === "string") {
        const prefix = `user_script:${error.line}: `
        if (error.value.startsWith(prefix))
          throw new LuaError(error.value.slice(prefix.length), error.line)
      }
      throw error
    }
  }
}

function mergeSort(items: LuaValue[], less: (a: LuaValue, b: LuaValue) => boolean): LuaValue[] {
  if (items.length < 2) return items
  const middle = items.length >> 1
  const left = mergeSort(items.slice(0, middle), less)
  const right = mergeSort(items.slice(middle), less)
  const out: LuaValue[] = []
  let l = 0
  let r = 0
  while (l < left.length && r < right.length) {
    if (less(right[r], left[l])) out.push(right[r++])
    else out.push(left[l++])
  }
  while (l < left.length) out.push(left[l++])
  while (r < right.length) out.push(right[r++])
  return out
}

function maxn(table: LuaTable): number {
  let max = table.arr.length
  if (table.hash !== null) {
    for (const key of table.hash.keys()) if (typeof key === "number" && key > max) max = key
  }
  return max
}

export function tableLib(): LuaTable {
  return freeze(
    makeLib({
      insert: tableInsert,
      remove: tableRemove,
      concat: tableConcat,
      sort: tableSort,
      getn: (...args: Args) => checkTable(args, 0, "getn").length(),
      maxn: (...args: Args) => maxn(checkTable(args, 0, "maxn")),
      setn: () => rtError("'setn' is obsolete"),
      foreach: (...args: Args) => {
        const table = checkTable(args, 0, "foreach")
        for (let entry = table.next(undefined); entry !== undefined; entry = table.next(entry[0])) {
          const result = first(callValue(args[1], [entry[0], entry[1]]))
          if (result !== undefined) return result
        }
        return undefined
      },
      foreachi: (...args: Args) => {
        const table = checkTable(args, 0, "foreachi")
        for (let i = 1; i <= table.length(); i++) {
          const result = first(callValue(args[1], [i, table.get(i)]))
          if (result !== undefined) return result
        }
        return undefined
      },
    }),
  )
}

// ---------------------------------------------------------------------------------------------
// math

// A 48-bit linear congruential generator, the one C's `drand48` uses. Scripts that need
// reproducible numbers call `math.randomseed`; unseeded, a fixed seed keeps runs repeatable.
let randomState = 0x1234abcd330en

function nextRandom(): number {
  randomState = (randomState * 0x5deece66dn + 0xbn) & 0xffffffffffffn
  return Number(randomState) / 2 ** 48
}

function mathRandom(...args: Args): Result {
  const r = nextRandom()
  if (args.length === 0) return r
  const low = args.length === 1 ? 1 : checkInt(args, 0, "random")
  const high = checkInt(args, args.length === 1 ? 0 : 1, "random")
  if (args.length > 2) rtError("wrong number of arguments")
  if (low > high) argError(args.length === 1 ? 0 : 1, "random", "interval is empty")
  return Math.floor(r * (high - low + 1)) + low
}

function math1(name: string, fn: (x: number) => number): (...args: Args) => Result {
  return (...args) => fn(checkNumber(args, 0, name))
}

export function mathLib(): LuaTable {
  const fmod = (...args: Args) => checkNumber(args, 0, "fmod") % checkNumber(args, 1, "fmod")
  return freeze(
    makeLib({
      abs: math1("abs", Math.abs),
      acos: math1("acos", Math.acos),
      asin: math1("asin", Math.asin),
      atan: math1("atan", Math.atan),
      atan2: (...args: Args) =>
        Math.atan2(checkNumber(args, 0, "atan2"), checkNumber(args, 1, "atan2")),
      ceil: math1("ceil", Math.ceil),
      cos: math1("cos", Math.cos),
      cosh: math1("cosh", Math.cosh),
      deg: math1("deg", (x) => (x * 180) / Math.PI),
      exp: math1("exp", Math.exp),
      floor: math1("floor", Math.floor),
      fmod,
      mod: fmod,
      frexp: (...args: Args) => {
        const x = checkNumber(args, 0, "frexp")
        if (x === 0 || !Number.isFinite(x)) return [x, 0]
        let exponent = Math.max(-1023, Math.floor(Math.log2(Math.abs(x))) + 1)
        let mantissa = x * 2 ** -exponent
        while (Math.abs(mantissa) < 0.5) {
          mantissa *= 2
          exponent--
        }
        while (Math.abs(mantissa) >= 1) {
          mantissa /= 2
          exponent++
        }
        return [mantissa, exponent]
      },
      huge: Infinity,
      ldexp: (...args: Args) => checkNumber(args, 0, "ldexp") * 2 ** checkInt(args, 1, "ldexp"),
      log: math1("log", Math.log),
      log10: math1("log10", Math.log10),
      max: (...args: Args) => {
        let best = checkNumber(args, 0, "max")
        for (let i = 1; i < args.length; i++) best = Math.max(best, checkNumber(args, i, "max"))
        return best
      },
      min: (...args: Args) => {
        let best = checkNumber(args, 0, "min")
        for (let i = 1; i < args.length; i++) best = Math.min(best, checkNumber(args, i, "min"))
        return best
      },
      modf: (...args: Args) => {
        const x = checkNumber(args, 0, "modf")
        const whole = x >= 0 ? Math.floor(x) : Math.ceil(x)
        return [whole, Number.isFinite(x) ? x - whole : 0]
      },
      pi: Math.PI,
      pow: (...args: Args) => checkNumber(args, 0, "pow") ** checkNumber(args, 1, "pow"),
      rad: math1("rad", (x) => (x * Math.PI) / 180),
      random: mathRandom,
      randomseed: (...args: Args) => {
        const seed = BigInt.asUintN(32, BigInt(Math.trunc(checkNumber(args, 0, "randomseed")) || 0))
        randomState = (seed << 16n) | 0x330en
        return EMPTY
      },
      sin: math1("sin", Math.sin),
      sinh: math1("sinh", Math.sinh),
      sqrt: math1("sqrt", Math.sqrt),
      tan: math1("tan", Math.tan),
      tanh: math1("tanh", Math.tanh),
    }),
  )
}

export function osLib(): LuaTable {
  return freeze(
    makeLib({
      clock: () => (typeof performance === "undefined" ? Date.now() : performance.now()) / 1000,
    }),
  )
}

// ---------------------------------------------------------------------------------------------
// bit (LuaBitOp)

const bitFloat = new Float64Array(1)
const bitWords = new Int32Array(bitFloat.buffer)
const BIT_LOW = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1

/** LuaBitOp's `tobit`: round to nearest even and keep the low 32 bits. */
function toBit(x: number): number {
  bitFloat[0] = x + 6755399441055744
  return bitWords[BIT_LOW] as number
}

function bitArg(args: Args, i: number, fname: string): number {
  return toBit(checkNumber(args, i, fname))
}

function bitFold(name: string, op: (a: number, b: number) => number): (...args: Args) => Result {
  return (...args) => {
    let acc = bitArg(args, 0, name)
    for (let i = 1; i < args.length; i++) acc = op(acc, bitArg(args, i, name))
    return acc
  }
}

function bitHex(...args: Args): Result {
  const x = bitArg(args, 0, "tohex")
  let n = args[1] === undefined ? 8 : toBit(checkNumber(args, 1, "tohex"))
  let digits = "0123456789abcdef"
  if (n < 0) {
    n = -n
    digits = digits.toUpperCase()
  }
  if (n > 8) n = 8
  let out = ""
  for (let shift = (n - 1) * 4; shift >= 0; shift -= 4) out += digits[(x >>> shift) & 15]
  return out
}

export function bitLib(): LuaTable {
  const shift =
    (name: string, op: (x: number, n: number) => number) =>
    (...args: Args) =>
      op(bitArg(args, 0, name), bitArg(args, 1, name) & 31)
  return freeze(
    makeLib({
      tobit: (...args: Args) => bitArg(args, 0, "tobit"),
      tohex: bitHex,
      bnot: (...args: Args) => ~bitArg(args, 0, "bnot"),
      band: bitFold("band", (a, b) => a & b),
      bor: bitFold("bor", (a, b) => a | b),
      bxor: bitFold("bxor", (a, b) => a ^ b),
      lshift: shift("lshift", (x, n) => x << n),
      rshift: shift("rshift", (x, n) => (x >>> n) | 0),
      arshift: shift("arshift", (x, n) => x >> n),
      rol: shift("rol", (x, n) => (x << n) | (x >>> (32 - n))),
      ror: shift("ror", (x, n) => (x >>> n) | (x << (32 - n))),
      bswap: (...args: Args) => {
        const x = bitArg(args, 0, "bswap")
        return ((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)
      },
    }),
  )
}

/** Coroutines need a resumable evaluator, which this one is not; each entry says so when called. */
export function coroutineLib(): LuaTable {
  const unsupported = (name: string) => () =>
    rtError(`coroutine.${name} is not supported by this emulator's Lua runtime`)
  return freeze(
    makeLib(
      Object.fromEntries(
        ["create", "resume", "running", "status", "wrap", "yield"].map((name) => [
          name,
          unsupported(name),
        ]),
      ),
    ),
  )
}
