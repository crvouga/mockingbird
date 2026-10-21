/** `cmsgpack`, the MessagePack library Redis bundles (lua-cmsgpack). Strings are byte strings. */

import { checkInt, checkString, freeze, makeLib } from "./stdlib.ts"
import { LuaTable, type LuaValue, rtError } from "./value.ts"

const MAX_NESTING = 16

const scratch = new DataView(new ArrayBuffer(8))

function bytes(...values: number[]): string {
  return String.fromCharCode(...values)
}

function big(n: number, width: number): string {
  let out = ""
  for (let shift = (width - 1) * 8; shift >= 0; shift -= 8) {
    out += String.fromCharCode(Number((BigInt(n) >> BigInt(shift)) & 0xffn))
  }
  return out
}

function encodeInteger(n: number): string {
  if (n >= 0) {
    if (n < 128) return bytes(n)
    if (n <= 0xff) return bytes(0xcc, n)
    if (n <= 0xffff) return bytes(0xcd) + big(n, 2)
    if (n <= 0xffffffff) return bytes(0xce) + big(n, 4)
    return bytes(0xcf) + big(n, 8)
  }
  if (n >= -32) return bytes(0x100 + n)
  if (n >= -128) return bytes(0xd0, 0x100 + n)
  if (n >= -32768) return bytes(0xd1) + big(0x10000 + n, 2)
  if (n >= -2147483648) return bytes(0xd2) + big(0x100000000 + n, 4)
  return bytes(0xd3) + bigBytes(BigInt.asUintN(64, BigInt(n)))
}

function encodeNumber(n: number): string {
  if (Number.isInteger(n) && n >= -(2 ** 63) && n < 2 ** 63) {
    if (n >= 2 ** 53 || n <= -(2 ** 53)) {
      // Beyond 2^53 the double is its own integer; write it through BigInt.
      const value = BigInt(n)
      if (value >= 0n) return bytes(0xcf) + bigBytes(value)
      return bytes(0xd3) + bigBytes(BigInt.asUintN(64, value))
    }
    return encodeInteger(n)
  }
  if (Math.fround(n) === n) {
    scratch.setFloat32(0, n)
    return bytes(0xca) + bytes(...[0, 1, 2, 3].map((i) => scratch.getUint8(i)))
  }
  scratch.setFloat64(0, n)
  return bytes(0xcb) + bytes(...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => scratch.getUint8(i)))
}

function bigBytes(value: bigint): string {
  let out = ""
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    out += String.fromCharCode(Number((value >> shift) & 0xffn))
  }
  return out
}

function encodeString(s: string): string {
  const n = s.length
  if (n < 32) return bytes(0xa0 | n) + s
  if (n <= 0xff) return bytes(0xd9, n) + s
  if (n <= 0xffff) return bytes(0xda) + big(n, 2) + s
  return bytes(0xdb) + big(n, 4) + s
}

function header(n: number, fixBase: number, shortTag: number, longTag: number): string {
  if (n < 16) return bytes(fixBase | n)
  if (n <= 0xffff) return bytes(shortTag) + big(n, 2)
  return bytes(longTag) + big(n, 4)
}

function encodeValue(value: LuaValue, depth: number): string {
  switch (typeof value) {
    case "boolean":
      return bytes(value ? 0xc3 : 0xc2)
    case "number":
      return encodeNumber(value)
    case "string":
      return encodeString(value)
    default:
      break
  }
  if (!(value instanceof LuaTable) || depth >= MAX_NESTING) return bytes(0xc0)
  let count = 0
  let max = 0
  let dense = true
  for (let entry = value.next(undefined); entry !== undefined; entry = value.next(entry[0])) {
    count++
    const key = entry[0]
    if (typeof key === "number" && Number.isInteger(key) && key >= 1) {
      if (key > max) max = key
    } else dense = false
  }
  if (dense && max === count) {
    let out = header(count, 0x90, 0xdc, 0xdd)
    for (let i = 1; i <= count; i++) out += encodeValue(value.get(i), depth + 1)
    return out
  }
  let out = header(count, 0x80, 0xde, 0xdf)
  for (let entry = value.next(undefined); entry !== undefined; entry = value.next(entry[0])) {
    out += encodeValue(entry[0], depth + 1) + encodeValue(entry[1], depth + 1)
  }
  return out
}

class Reader {
  constructor(
    private readonly data: string,
    public at: number,
  ) {}

  private need(n: number): void {
    if (this.at + n > this.data.length) rtError("Missing bytes in input.")
  }

  private uint(width: number): number {
    this.need(width)
    let n = 0
    for (let i = 0; i < width; i++) n = n * 256 + this.data.charCodeAt(this.at + i)
    this.at += width
    return n
  }

  private int(width: number): number {
    const unsigned = this.uint(width)
    const limit = 2 ** (width * 8 - 1)
    return unsigned >= limit ? unsigned - 2 * limit : unsigned
  }

  private float(width: number): number {
    this.need(width)
    for (let i = 0; i < width; i++) scratch.setUint8(i, this.data.charCodeAt(this.at + i))
    this.at += width
    return width === 4 ? scratch.getFloat32(0) : scratch.getFloat64(0)
  }

  private text(n: number): string {
    this.need(n)
    const out = this.data.slice(this.at, this.at + n)
    this.at += n
    return out
  }

  private array(n: number, depth: number): LuaValue {
    const table = new LuaTable()
    for (let i = 1; i <= n; i++) table.set(i, this.value(depth + 1))
    return table
  }

  private map(n: number, depth: number): LuaValue {
    const table = new LuaTable()
    for (let i = 0; i < n; i++) {
      const key = this.value(depth + 1)
      const value = this.value(depth + 1)
      if (key !== undefined && !(typeof key === "number" && Number.isNaN(key)))
        table.set(key, value)
    }
    return table
  }

  value(depth = 0): LuaValue {
    const tag = this.uint(1)
    if (tag < 0x80) return tag
    if (tag >= 0xe0) return tag - 0x100
    if (tag >= 0xa0 && tag <= 0xbf) return this.text(tag & 0x1f)
    if (tag >= 0x90 && tag <= 0x9f) return this.array(tag & 0x0f, depth)
    if (tag >= 0x80 && tag <= 0x8f) return this.map(tag & 0x0f, depth)
    switch (tag) {
      case 0xc0:
        return undefined
      case 0xc2:
        return false
      case 0xc3:
        return true
      case 0xc4:
      case 0xd9:
        return this.text(this.uint(1))
      case 0xc5:
      case 0xda:
        return this.text(this.uint(2))
      case 0xc6:
      case 0xdb:
        return this.text(this.uint(4))
      case 0xca:
        return this.float(4)
      case 0xcb:
        return this.float(8)
      case 0xcc:
        return this.uint(1)
      case 0xcd:
        return this.uint(2)
      case 0xce:
        return this.uint(4)
      case 0xcf:
        return this.uint(8)
      case 0xd0:
        return this.int(1)
      case 0xd1:
        return this.int(2)
      case 0xd2:
        return this.int(4)
      case 0xd3:
        return this.int(8)
      case 0xdc:
        return this.array(this.uint(2), depth)
      case 0xdd:
        return this.array(this.uint(4), depth)
      case 0xde:
        return this.map(this.uint(2), depth)
      case 0xdf:
        return this.map(this.uint(4), depth)
      default:
        return rtError("Bad data format in input.")
    }
  }
}

function unpackMany(data: string, limit: number, offset: number): LuaValue[] {
  if (offset < 0 || limit < 0)
    rtError("Invalid request to unpack with offset of " + offset + " and limit of " + limit + ".")
  if (offset > data.length)
    rtError("Start offset " + offset + " greater than input length " + data.length + ".")
  const reader = new Reader(data, offset)
  const out: LuaValue[] = []
  while (reader.at < data.length && (limit === 0 || out.length < limit)) out.push(reader.value())
  return out
}

export function cmsgpackLib(): LuaTable {
  return freeze(
    makeLib({
      pack: (...args: LuaValue[]) => {
        if (args.length === 0) rtError("bad argument #0 to 'pack' (MessagePack pack needs input.)")
        return args.map((arg) => encodeValue(arg, 0)).join("")
      },
      unpack: (...args: LuaValue[]) => unpackMany(checkString(args, 0, "unpack"), 0, 0),
      unpack_one: (...args: LuaValue[]) => {
        const data = checkString(args, 0, "unpack_one")
        const offset = args[1] === undefined ? 0 : checkInt(args, 1, "unpack_one")
        const out = unpackMany(data, 1, offset)
        if (out.length === 0) return [-1]
        const reader = new Reader(data, offset)
        reader.value()
        return [reader.at >= data.length ? -1 : reader.at, out[0]]
      },
      unpack_limit: (...args: LuaValue[]) => {
        const data = checkString(args, 0, "unpack_limit")
        const limit = checkInt(args, 1, "unpack_limit")
        const offset = args[2] === undefined ? 0 : checkInt(args, 2, "unpack_limit")
        const out = unpackMany(data, limit, offset)
        if (out.length === 0) return [-1]
        const reader = new Reader(data, offset)
        for (let i = 0; i < out.length; i++) reader.value()
        return [reader.at >= data.length ? -1 : reader.at, ...out]
      },
    }),
  )
}
