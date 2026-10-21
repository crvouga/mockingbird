import { fromLatin1, latin1, utf8 } from "./bytes.ts"

export type Protocol = 2 | 3

export type Reply =
  | { t: "simple"; v: string }
  | { t: "error"; v: string }
  | { t: "int"; v: number | bigint }
  | { t: "bulk"; v: Uint8Array | null }
  | { t: "array"; v: Reply[] | null }
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "double"; v: number }
  | { t: "map"; v: Array<[Reply, Reply]> }
  | { t: "push"; v: Reply[] }

export const ok = (): Reply => ({ t: "simple", v: "OK" })
export const queued = (): Reply => ({ t: "simple", v: "QUEUED" })
export const pong = (): Reply => ({ t: "simple", v: "PONG" })
export const simple = (v: string): Reply => ({ t: "simple", v })
export const err = (v: string): Reply => ({ t: "error", v })
export const int = (v: number | bigint): Reply => ({ t: "int", v })
export const bulk = (v: Uint8Array | string | null): Reply => ({
  t: "bulk",
  v: v === null ? null : typeof v === "string" ? utf8(v) : v,
})
export const arr = (v: Reply[] | null): Reply => ({ t: "array", v })
export const nil = (): Reply => ({ t: "bulk", v: null })
export const nilArray = (): Reply => ({ t: "array", v: null })
export const push = (v: Reply[]): Reply => ({ t: "push", v })
export const map = (v: Array<[Reply, Reply]>): Reply => ({ t: "map", v })

export const wrongType = (): Reply =>
  err("WRONGTYPE Operation against a key holding the wrong kind of value")

export function arityError(name: string): Reply {
  return err(`ERR wrong number of arguments for '${name}' command`)
}

export const syntaxError = (): Reply => err("ERR syntax error")

export function unknownCommand(name: string, args: Uint8Array[]): Reply {
  const shown = args
    .slice(0, 10)
    .map((arg) => `'${latin1(arg)}'`)
    .join(" ")
  const extra = shown.length > 0 ? `${shown} ` : ""
  return err(`ERR unknown command '${name}', with args beginning with: ${extra}`)
}

export const invalidExpire = (command: string): Reply =>
  err(`ERR invalid expire time in '${command}' command`)
export const notInteger = (): Reply => err("ERR value is not an integer or out of range")
export const notFloat = (): Reply => err("ERR value is not a valid float")
export const noScript = (): Reply => err("NOSCRIPT No matching script. Please use EVAL.")
export const readonlyError = (): Reply =>
  err("READONLY You can't write against a read only replica.")
export const oomError = (): Reply => err("OOM command not allowed when used memory > 'maxmemory'.")
export const busyError = (): Reply =>
  err("BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.")
export const noAuth = (): Reply => err("NOAUTH Authentication required.")
export const wrongPass = (): Reply =>
  err("WRONGPASS invalid username-password pair or user is disabled.")
export function authWithoutPassword(password: string): Reply {
  return err(
    `ERR AUTH <${password}> called without any password configured for the default user. Are you sure your configuration is correct?`,
  )
}
export const clusterDisabled = (): Reply => err("ERR This instance has cluster support disabled")
export const noSuchKey = (): Reply => err("ERR no such key")
export const execWithoutMulti = (): Reply => err("ERR EXEC without MULTI")
export const discardWithoutMulti = (): Reply => err("ERR DISCARD without MULTI")
export const nestedMulti = (): Reply => err("ERR MULTI calls can not be nested")
export const execAbort = (): Reply =>
  err("EXECABORT Transaction discarded because of previous errors.")
export const scriptDenied = (): Reply => err("ERR This Redis command is not allowed from scripts")
export const notBusy = (): Reply => err("NOTBUSY No scripts in execution right now.")

export function pubsubOnly(name: string): Reply {
  return err(
    `ERR Can't execute '${name}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
  )
}

export function noPerm(name: string): Reply {
  return err(`NOPERM this user has no permissions to run the '${name}' command`)
}

const CRLF = utf8("\r\n")

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0
  for (const part of parts) size += part.length
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function formatDouble(value: number): string {
  if (Number.isNaN(value)) return "nan"
  if (value === Infinity) return "inf"
  if (value === -Infinity) return "-inf"
  if (Object.is(value, -0)) return "-0"
  if (Number.isInteger(value)) return String(value)
  return String(value)
}

export function encodeReply(reply: Reply, protocol: Protocol = 2): Uint8Array {
  const parts: Uint8Array[] = []
  const text = (value: string) => {
    parts.push(utf8(value))
  }
  const walk = (value: Reply): void => {
    switch (value.t) {
      case "simple":
        text(`+${value.v}\r\n`)
        return
      case "error":
        text(`-${value.v}\r\n`)
        return
      case "int":
        text(`:${value.v.toString()}\r\n`)
        return
      case "bulk":
        if (value.v === null) {
          text(protocol === 3 ? "_\r\n" : "$-1\r\n")
          return
        }
        text(`$${value.v.length}\r\n`)
        parts.push(value.v)
        parts.push(CRLF)
        return
      case "array":
        if (value.v === null) {
          text(protocol === 3 ? "_\r\n" : "*-1\r\n")
          return
        }
        text(`*${value.v.length}\r\n`)
        for (const item of value.v) walk(item)
        return
      case "null":
        text(protocol === 3 ? "_\r\n" : "$-1\r\n")
        return
      case "bool":
        if (protocol === 3) text(value.v ? "#t\r\n" : "#f\r\n")
        else text(value.v ? ":1\r\n" : ":0\r\n")
        return
      case "double":
        if (protocol === 3) text(`,${formatDouble(value.v)}\r\n`)
        else walk(bulk(formatDouble(value.v)))
        return
      case "map":
        if (protocol === 3) {
          text(`%${value.v.length}\r\n`)
          for (const [key, item] of value.v) {
            walk(key)
            walk(item)
          }
          return
        }
        text(`*${value.v.length * 2}\r\n`)
        for (const [key, item] of value.v) {
          walk(key)
          walk(item)
        }
        return
      case "push":
        text(protocol === 3 ? `>${value.v.length}\r\n` : `*${value.v.length}\r\n`)
        for (const item of value.v) walk(item)
        return
      default: {
        const never: never = value
        throw new Error(`unknown reply ${(never as Reply).t}`)
      }
    }
  }
  walk(reply)
  return concat(parts)
}

export class RespParser {
  private buf = new Uint8Array(0)
  private pos = 0

  push(chunk: Uint8Array): Reply[] {
    if (this.pos > 0) this.buf = this.buf.slice(this.pos)
    this.pos = 0
    if (chunk.length > 0) {
      const next = new Uint8Array(this.buf.length + chunk.length)
      next.set(this.buf)
      next.set(chunk, this.buf.length)
      this.buf = next
    }
    const out: Reply[] = []
    while (this.pos < this.buf.length) {
      const saved = this.pos
      const reply = this.tryOne()
      if (reply === undefined) {
        this.pos = saved
        break
      }
      out.push(reply)
    }
    return out
  }

  private tryOne(): Reply | undefined {
    if (this.pos >= this.buf.length) return undefined
    const marker = this.buf[this.pos] ?? 0
    if (
      marker !== 43 &&
      marker !== 45 &&
      marker !== 58 &&
      marker !== 36 &&
      marker !== 42 &&
      marker !== 95 &&
      marker !== 35 &&
      marker !== 44 &&
      marker !== 37 &&
      marker !== 126 &&
      marker !== 62 &&
      marker !== 33
    ) {
      return this.inline()
    }
    this.pos++
    if (marker === 43) {
      const line = this.readLine()
      if (line === null) return undefined
      return simple(line)
    }
    if (marker === 45) {
      const line = this.readLine()
      if (line === null) return undefined
      return err(line)
    }
    if (marker === 58) {
      const line = this.readLine()
      if (line === null) return undefined
      if (!/^-?\d+$/.test(line)) return err("ERR protocol error: invalid integer")
      const value = BigInt(line)
      return int(
        value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(value)
          : value,
      )
    }
    if (marker === 36) return this.bulk()
    if (marker === 42) return this.aggregate("array")
    if (marker === 95) {
      const line = this.readLine()
      if (line === null) return undefined
      return { t: "null" }
    }
    if (marker === 35) {
      const line = this.readLine()
      if (line === null) return undefined
      return { t: "bool", v: line === "t" }
    }
    if (marker === 44) {
      const line = this.readLine()
      if (line === null) return undefined
      return { t: "double", v: Number(line) }
    }
    if (marker === 37) return this.map()
    if (marker === 126) return this.aggregate("set")
    if (marker === 62) return this.aggregate("push")
    if (marker === 33) return this.bulk()
    return undefined
  }

  private inline(): Reply | undefined {
    const line = this.readLine()
    if (line === null) return undefined
    if (line.length === 0) return arr([])
    const parts: string[] = []
    let current = ""
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quote) {
        if (ch === quote) quote = null
        else current += ch ?? ""
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        continue
      }
      if (ch === " ") {
        if (current.length > 0) {
          parts.push(current)
          current = ""
        }
        continue
      }
      current += ch ?? ""
    }
    if (current.length > 0) parts.push(current)
    return arr(parts.map((part) => bulk(fromLatin1(part))))
  }

  private readLine(): string | null {
    for (let i = this.pos; i < this.buf.length; i++) {
      if (this.buf[i] !== 10) continue
      let end = i
      if (end > this.pos && this.buf[end - 1] === 13) end--
      const line = latin1(this.buf.subarray(this.pos, end))
      this.pos = i + 1
      return line
    }
    return null
  }

  private bulk(): Reply | undefined {
    const line = this.readLine()
    if (line === null) return undefined
    const size = Number(line)
    if (!Number.isInteger(size)) return err("ERR protocol error: invalid bulk length")
    if (size < 0) return nil()
    if (this.buf.length < this.pos + size + 2) return undefined
    const value = this.buf.slice(this.pos, this.pos + size)
    this.pos += size + 2
    return { t: "bulk", v: value }
  }

  private aggregate(kind: "array" | "push" | "set"): Reply | undefined {
    const line = this.readLine()
    if (line === null) return undefined
    const count = Number(line)
    if (!Number.isInteger(count)) return err("ERR protocol error: invalid multibulk length")
    if (count < 0) return nilArray()
    const items: Reply[] = []
    for (let i = 0; i < count; i++) {
      const item = this.tryOne()
      if (item === undefined) return undefined
      items.push(item)
    }
    if (kind === "push") return push(items)
    return arr(items)
  }

  private map(): Reply | undefined {
    const line = this.readLine()
    if (line === null) return undefined
    const count = Number(line)
    if (!Number.isInteger(count) || count < 0) return err("ERR protocol error: invalid map length")
    const pairs: Array<[Reply, Reply]> = []
    for (let i = 0; i < count; i++) {
      const key = this.tryOne()
      if (key === undefined) return undefined
      const value = this.tryOne()
      if (value === undefined) return undefined
      pairs.push([key, value])
    }
    return map(pairs)
  }
}

export interface Request {
  name: string
  args: Uint8Array[]
}

/** Largest bulk string and multibulk count Redis accepts in a request. */
const MAX_BULK_LENGTH = 512 * 1024 * 1024
const MAX_MULTIBULK_LENGTH = 2147483647
/** Longest header or inline line Redis buffers while waiting for its newline. */
const MAX_LINE_LENGTH = 64 * 1024

/** Redis `string2ll`: canonical base-10 integers only, no sign `+`, no leading zeros. */
function parseLength(bytes: Uint8Array): bigint | null {
  const value = latin1(bytes)
  return /^(?:0|-?[1-9]\d*)$/.test(value) ? BigInt(value) : null
}

const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13)
const hexValue = (c: number | undefined): number =>
  c === undefined
    ? -1
    : c >= 48 && c <= 57
      ? c - 48
      : c >= 97 && c <= 102
        ? c - 87
        : c >= 65 && c <= 70
          ? c - 55
          : -1

/** Redis `sdssplitargs`: inline command line to arguments, or null on unbalanced quotes. */
function splitInline(line: Uint8Array): Uint8Array[] | null {
  const out: Uint8Array[] = []
  const end = line.length
  let i = 0
  for (;;) {
    while (i < end && isSpace(line[i] ?? 0)) i++
    if (i >= end) return out
    const current: number[] = []
    let inDouble = false
    let inSingle = false
    let done = false
    while (!done) {
      const c = i < end ? (line[i] ?? 0) : 0
      if (inDouble) {
        const escaped = line[i + 1]
        if (
          c === 92 &&
          escaped === 120 &&
          hexValue(line[i + 2]) >= 0 &&
          hexValue(line[i + 3]) >= 0
        ) {
          current.push(hexValue(line[i + 2]) * 16 + hexValue(line[i + 3]))
          i += 3
        } else if (c === 92 && i + 1 < end) {
          i++
          const e = line[i] ?? 0
          current.push(
            e === 110 ? 10 : e === 114 ? 13 : e === 116 ? 9 : e === 98 ? 8 : e === 97 ? 7 : e,
          )
        } else if (c === 34) {
          if (i + 1 < end && !isSpace(line[i + 1] ?? 0)) return null
          done = true
        } else if (i >= end) return null
        else current.push(c)
      } else if (inSingle) {
        if (c === 92 && line[i + 1] === 39) {
          i++
          current.push(39)
        } else if (c === 39) {
          if (i + 1 < end && !isSpace(line[i + 1] ?? 0)) return null
          done = true
        } else if (i >= end) return null
        else current.push(c)
      } else if (i >= end || isSpace(c) || c === 0) done = true
      else if (c === 34) inDouble = true
      else if (c === 39) inSingle = true
      else current.push(c)
      if (i < end) i++
    }
    out.push(Uint8Array.from(current))
  }
}

export interface RequestBatch {
  requests: Request[]
  /** Set once the stream is malformed: the reply text after `-ERR Protocol error: `. */
  error: string | null
}

/**
 * Incremental parser for client requests (RESP multibulk or inline), following Redis
 * `networking.c`: a malformed frame is a fatal protocol error, `*0`, `*-1` and blank inline lines
 * are no-ops, and nothing after a protocol error is parsed.
 */
export class RequestParser {
  private buf = new Uint8Array(0)
  private pos = 0
  private remaining = 0
  private bulkLength = -1
  private args: Uint8Array[] = []
  private failed = false

  push(chunk: Uint8Array): RequestBatch {
    const requests: Request[] = []
    if (this.failed) return { requests, error: null }
    if (this.pos > 0) this.buf = this.buf.slice(this.pos)
    this.pos = 0
    if (chunk.length > 0) {
      const next = new Uint8Array(this.buf.length + chunk.length)
      next.set(this.buf)
      next.set(chunk, this.buf.length)
      this.buf = next
    }
    const fail = (message: string): RequestBatch => {
      this.failed = true
      this.buf = new Uint8Array(0)
      this.pos = 0
      return { requests, error: message }
    }
    while (this.pos < this.buf.length) {
      if (this.remaining === 0) {
        if (this.buf[this.pos] === 42) {
          const header = this.header()
          if (header === null) {
            if (this.buf.length - this.pos > MAX_LINE_LENGTH)
              return fail("too big mbulk count string")
            break
          }
          const count = parseLength(header.subarray(1))
          if (count === null || count > BigInt(MAX_MULTIBULK_LENGTH)) {
            return fail("invalid multibulk length")
          }
          if (count > 0n) {
            this.remaining = Number(count)
            this.args = []
          }
        } else {
          const newline = this.buf.indexOf(10, this.pos)
          if (newline < 0) {
            if (this.buf.length - this.pos > MAX_LINE_LENGTH) return fail("too big inline request")
            break
          }
          let end = newline
          if (end > this.pos && this.buf[end - 1] === 13) end--
          const line = this.buf.subarray(this.pos, end)
          this.pos = newline + 1
          const args = splitInline(line)
          if (args === null) return fail("unbalanced quotes in request")
          if (args.length > 0) requests.push(toRequest(args))
        }
        continue
      }
      if (this.bulkLength < 0) {
        if (this.buf[this.pos] !== 36) {
          const got = String.fromCharCode(this.buf[this.pos] ?? 0)
          return fail(`expected '$', got '${got}'`)
        }
        const header = this.header()
        if (header === null) {
          if (this.buf.length - this.pos > MAX_LINE_LENGTH) return fail("too big bulk count string")
          break
        }
        const length = parseLength(header.subarray(1))
        if (length === null || length < 0n || length > BigInt(MAX_BULK_LENGTH)) {
          return fail("invalid bulk length")
        }
        this.bulkLength = Number(length)
      }
      if (this.buf.length - this.pos < this.bulkLength + 2) break
      this.args.push(this.buf.slice(this.pos, this.pos + this.bulkLength))
      this.pos += this.bulkLength + 2
      this.bulkLength = -1
      if (--this.remaining === 0) {
        requests.push(toRequest(this.args))
        this.args = []
      }
    }
    return { requests, error: null }
  }

  /** A `*N` or `$N` header line ending in CRLF, consumed; null while the CRLF has not arrived. */
  private header(): Uint8Array | null {
    const cr = this.buf.indexOf(13, this.pos)
    if (cr < 0 || cr + 1 >= this.buf.length) return null
    const line = this.buf.subarray(this.pos, cr)
    this.pos = cr + 2
    return line
  }
}

function toRequest(args: Uint8Array[]): Request {
  return { name: latin1(args[0] ?? new Uint8Array(0)), args: args.slice(1) }
}

/** Reply-shaped command frame to a command, used by the parity script; servers use `RequestParser`. */
export function asCommand(reply: Reply): { name: string; args: Uint8Array[] } | Reply {
  if (reply.t !== "array" || reply.v === null || reply.v.length === 0) {
    return err("ERR protocol error: expected command array")
  }
  const name = reply.v[0]
  if (name?.t !== "bulk" || name.v === null) return err("ERR protocol error: expected command name")
  const args: Uint8Array[] = []
  for (let i = 1; i < reply.v.length; i++) {
    const arg = reply.v[i]
    if (arg?.t !== "bulk" || arg.v === null)
      return err("ERR protocol error: expected bulk argument")
    args.push(arg.v)
  }
  return { name: latin1(name.v), args }
}
