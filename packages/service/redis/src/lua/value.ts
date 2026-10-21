/**
 * Lua 5.1 value model for the Redis script engine. `undefined` is nil, strings are Latin-1 byte
 * strings (one UTF-16 unit per byte), numbers are doubles, and a function returns a single value,
 * or an array when it returns zero or several values.
 */

export type LuaValue = undefined | boolean | number | string | LuaTable | LuaFunction | LuaUserdata
export type LuaFunction = (...args: LuaValue[]) => LuaValue | LuaValue[]

/** An opaque value such as `cjson.null`. */
export class LuaUserdata {
  constructor(readonly label: string) {}
}

/** Where the running script is, for `user_script:N:` error prefixes. Scripts run one at a time. */
export const pos = { line: 0 }

/** A raised Lua error. `value` is whatever `error` was given (usually a message string). */
export class LuaError {
  readonly line: number
  constructor(
    readonly value: LuaValue,
    line = pos.line,
  ) {
    this.line = line
  }
}

/** Raise a runtime error with the `user_script:LINE:` prefix Lua adds to its own messages. */
export function rtError(message: string): never {
  throw new LuaError(`user_script:${pos.line}: ${message}`)
}

export const EMPTY: LuaValue[] = []

export function first(result: LuaValue | LuaValue[]): LuaValue {
  return result instanceof Array ? result[0] : result
}

export function toList(result: LuaValue | LuaValue[]): LuaValue[] {
  return result instanceof Array ? result : [result]
}

export class LuaTable {
  /** `arr[i - 1]` is `t[i]`; holes are `undefined` and the last element is never `undefined`. */
  arr: LuaValue[] = []
  hash: Map<LuaValue, LuaValue> | null = null
  meta: LuaTable | null = null
  readonly = false
  private cursor: { iter: Iterator<[LuaValue, LuaValue]>; last: LuaValue } | null = null

  get(key: LuaValue): LuaValue {
    if (typeof key === "number") {
      const i = key - 1
      if (i >= 0 && i < this.arr.length && Number.isInteger(i)) return this.arr[i]
    }
    return this.hash === null ? undefined : this.hash.get(key)
  }

  getStr(key: string): LuaValue {
    return this.hash === null ? undefined : this.hash.get(key)
  }

  /** Raw set. The caller has already rejected nil and NaN keys. */
  set(key: LuaValue, value: LuaValue): void {
    if (typeof key === "number") {
      const i = key - 1
      if (i >= 0 && Number.isInteger(i)) {
        const arr = this.arr
        if (i < arr.length) {
          arr[i] = value
          if (value === undefined && i === arr.length - 1) {
            arr.pop()
            while (arr.length > 0 && arr[arr.length - 1] === undefined) arr.pop()
          }
          return
        }
        if (i === arr.length) {
          if (value === undefined) {
            this.hash?.delete(key)
            return
          }
          arr.push(value)
          const hash = this.hash
          if (hash !== null && hash.size > 0) {
            hash.delete(key)
            for (let next = arr.length + 1; hash.has(next); next++) {
              arr.push(hash.get(next))
              hash.delete(next)
            }
          }
          return
        }
      }
    }
    if (value === undefined) {
      this.hash?.delete(key)
      return
    }
    if (this.hash === null) this.hash = new Map()
    this.hash.set(key, value)
  }

  length(): number {
    return this.arr.length
  }

  /** The `next` primitive: the entry after `key` (the first one for nil), or `undefined` at the end. */
  next(key: LuaValue): [LuaValue, LuaValue] | undefined {
    let index = 0
    if (key !== undefined) {
      if (typeof key === "number" && Number.isInteger(key) && key >= 1) {
        // A key past the array (cleared during traversal) resumes at the hash part.
        index = key <= this.arr.length || !this.hash?.has(key) ? key : -1
      } else index = -1
    }
    if (index >= 0) {
      for (; index < this.arr.length; index++) {
        const value = this.arr[index]
        if (value !== undefined) return [index + 1, value]
      }
      if (this.hash === null) return undefined
      this.cursor = { iter: this.hash.entries(), last: undefined }
      return this.advance()
    }
    if (this.hash === null) throw new LuaError("invalid key to 'next'")
    if (this.cursor === null || this.cursor.last !== key) {
      const iter = this.hash.entries()
      let found = false
      for (let step = iter.next(); !step.done; step = iter.next()) {
        if (step.value[0] === key) {
          found = true
          break
        }
      }
      if (!found) rtError("invalid key to 'next'")
      this.cursor = { iter, last: key }
    }
    return this.advance()
  }

  private advance(): [LuaValue, LuaValue] | undefined {
    const cursor = this.cursor
    if (cursor === null) return undefined
    const step = cursor.iter.next()
    if (step.done) {
      this.cursor = null
      return undefined
    }
    cursor.last = step.value[0]
    return [step.value[0], step.value[1]]
  }
}

export function typeName(value: LuaValue): string {
  switch (typeof value) {
    case "undefined":
      return "nil"
    case "boolean":
      return "boolean"
    case "number":
      return "number"
    case "string":
      return "string"
    case "function":
      return "function"
    default:
      return value instanceof LuaTable ? "table" : "userdata"
  }
}

export const truthy = (value: LuaValue): boolean => value !== undefined && value !== false

/** Lua's `tonumber` on a string: decimal, hex, `inf` and `nan`, with surrounding whitespace. */
export function parseNumber(text: string): number | undefined {
  const s = text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "")
  if (s === "") return undefined
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s)
  const hex = /^([+-]?)0[xX]([0-9a-fA-F]+)$/.exec(s)
  if (hex) {
    const magnitude = Number(`0x${hex[2]}`)
    return hex[1] === "-" ? -magnitude : magnitude
  }
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(s)
  if (special) {
    if (special[2]?.toLowerCase() === "nan") return Number.NaN
    return special[1] === "-" ? -Infinity : Infinity
  }
  return undefined
}

/** `tonumber(s, base)`: an integer in the given base, or nil. */
export function parseNumberBase(text: string, base: number): number | undefined {
  const s = text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "")
  const match = /^(-?)([0-9a-zA-Z]+)$/.exec(s)
  if (!match) return undefined
  let value = 0
  for (const ch of (match[2] as string).toLowerCase()) {
    const digit = parseInt(ch, 36)
    if (digit >= base) return undefined
    value = value * base + digit
  }
  return match[1] === "-" ? -value : value
}

/** The number a string or number stands for in arithmetic, or undefined. */
export function toNumber(value: LuaValue): number | undefined {
  if (typeof value === "number") return value
  if (typeof value === "string") return parseNumber(value)
  return undefined
}
