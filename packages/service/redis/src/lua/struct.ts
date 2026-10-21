/** `struct`, the binary pack/unpack library Redis bundles (lua_struct.c), on a 64-bit little-endian host. */

import { checkInt, checkNumber, checkString, freeze, makeLib } from "./stdlib.ts"
import { type LuaTable, type LuaValue, rtError } from "./value.ts"

const MAXINTSIZE = 32
const NATIVE_ALIGN = 8

interface Header {
  little: boolean
  align: number
}

const scratch = new DataView(new ArrayBuffer(8))

function digit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9"
}

/** An optional decimal number after a format option. */
function getNumber(fmt: string, at: { i: number }, fallback: number): number {
  if (!digit(fmt[at.i])) return fallback
  let a = 0
  do {
    a = a * 10 + (fmt.charCodeAt(at.i++) - 48)
  } while (digit(fmt[at.i]) && a <= (2 ** 31 - 1 - 9) / 10)
  return a
}

function optionSize(opt: string, fmt: string, at: { i: number }): number {
  switch (opt) {
    case "B":
    case "b":
      return 1
    case "H":
    case "h":
      return 2
    case "L":
    case "l":
      return 8
    case "T":
      return 8
    case "f":
      return 4
    case "d":
      return 8
    case "x":
      return 1
    case "c":
      return getNumber(fmt, at, 1)
    case "i":
    case "I": {
      const size = getNumber(fmt, at, 4)
      if (size > MAXINTSIZE) {
        rtError(`integral size ${size} is larger than limit of ${MAXINTSIZE}`)
      }
      return size
    }
    default:
      return 0
  }
}

function toAlign(length: number, header: Header, opt: string, size: number): number {
  if (size === 0 || opt === "c") return 0
  let effective = size
  if (effective > header.align) effective = header.align
  return (effective - (length & (effective - 1))) & (effective - 1)
}

function controlOption(
  opt: string,
  fmt: string,
  at: { i: number },
  header: Header,
  fname: string,
): void {
  switch (opt) {
    case " ":
      return
    case ">":
      header.little = false
      return
    case "<":
    case "=":
      header.little = true
      return
    case "!": {
      const align = getNumber(fmt, at, NATIVE_ALIGN)
      if ((align & (align - 1)) !== 0) {
        rtError(`bad argument #1 to '${fname}' (alignment ${align} is not a power of 2)`)
      }
      header.align = align
      return
    }
    default:
      rtError(`bad argument #1 to '${fname}' (invalid format option '${opt}')`)
  }
}

function putInteger(value: number, size: number, little: boolean): string {
  const n = BigInt(Math.trunc(Number.isFinite(value) ? value : 0))
  let bits = BigInt.asUintN(64, n)
  const out: number[] = []
  for (let i = 0; i < size; i++) {
    out.push(Number(bits & 0xffn))
    bits >>= 8n
  }
  if (!little) out.reverse()
  return String.fromCharCode(...out)
}

function getInteger(
  data: string,
  at: number,
  little: boolean,
  signed: boolean,
  size: number,
): number {
  let value = 0n
  for (let i = 0; i < size; i++) {
    const byte = BigInt(data.charCodeAt(little ? at + size - 1 - i : at + i))
    value = (value << 8n) | byte
  }
  if (signed && size < 8) {
    const bits = BigInt(size * 8)
    if (value >> (bits - 1n) !== 0n) value -= 1n << bits
  } else if (signed) value = BigInt.asIntN(64, value)
  else if (size > 8) value = BigInt.asUintN(64, value)
  return Number(value)
}

function pack(...args: LuaValue[]): LuaValue {
  const fmt = checkString(args, 0, "pack")
  const at = { i: 0 }
  const header: Header = { little: true, align: 1 }
  let arg = 1
  let total = 0
  let out = ""
  while (at.i < fmt.length) {
    const opt = fmt[at.i++] as string
    let size = optionSize(opt, fmt, at)
    const pad = toAlign(total, header, opt, size)
    out += "\0".repeat(pad)
    total += pad
    switch (opt) {
      case "b":
      case "B":
      case "h":
      case "H":
      case "l":
      case "L":
      case "T":
      case "i":
      case "I":
        out += putInteger(checkNumber(args, arg++, "pack"), size, header.little)
        break
      case "x":
        out += "\0"
        break
      case "f":
      case "d": {
        const value = checkNumber(args, arg++, "pack")
        if (opt === "f") scratch.setFloat32(0, value, header.little)
        else scratch.setFloat64(0, value, header.little)
        let bytes = ""
        for (let i = 0; i < size; i++) bytes += String.fromCharCode(scratch.getUint8(i))
        out += bytes
        break
      }
      case "c":
      case "s": {
        const s = checkString(args, arg++, "pack")
        if (size === 0) size = s.length
        if (s.length < size) rtError(`bad argument #${arg} to 'pack' (string too short)`)
        out += s.slice(0, size)
        if (opt === "s") {
          out += "\0"
          size++
        }
        break
      }
      default:
        controlOption(opt, fmt, at, header, "pack")
    }
    total += size
  }
  return out
}

function unpack(...args: LuaValue[]): LuaValue[] {
  const fmt = checkString(args, 0, "unpack")
  const data = checkString(args, 1, "unpack")
  let position = (args[2] === undefined ? 1 : checkInt(args, 2, "unpack")) - 1
  const at = { i: 0 }
  const header: Header = { little: true, align: 1 }
  const results: LuaValue[] = []
  while (at.i < fmt.length) {
    const opt = fmt[at.i++] as string
    let size = optionSize(opt, fmt, at)
    position += toAlign(position, header, opt, size)
    if (position + size > data.length)
      rtError("bad argument #2 to 'unpack' (data string too short)")
    switch (opt) {
      case "b":
      case "B":
      case "h":
      case "H":
      case "l":
      case "L":
      case "T":
      case "i":
      case "I":
        results.push(getInteger(data, position, header.little, opt === opt.toLowerCase(), size))
        break
      case "x":
        break
      case "f":
      case "d": {
        for (let i = 0; i < size; i++) scratch.setUint8(i, data.charCodeAt(position + i))
        results.push(
          opt === "f" ? scratch.getFloat32(0, header.little) : scratch.getFloat64(0, header.little),
        )
        break
      }
      case "c": {
        if (size === 0) {
          const previous = results[results.length - 1]
          if (typeof previous !== "number") rtError("format 'c0' needs a previous size")
          size = previous as number
          results.pop()
          if (position + size > data.length)
            rtError("bad argument #2 to 'unpack' (data string too short)")
        }
        results.push(data.slice(position, position + size))
        break
      }
      case "s": {
        const end = data.indexOf("\0", position)
        if (end < 0) rtError("unfinished string in data")
        size = end - position + 1
        results.push(data.slice(position, end))
        break
      }
      default:
        controlOption(opt, fmt, at, header, "unpack")
    }
    position += size
  }
  results.push(position + 1)
  return results
}

function size(...args: LuaValue[]): LuaValue {
  const fmt = checkString(args, 0, "size")
  const at = { i: 0 }
  const header: Header = { little: true, align: 1 }
  let total = 0
  while (at.i < fmt.length) {
    const opt = fmt[at.i++] as string
    const width = optionSize(opt, fmt, at)
    total += toAlign(total, header, opt, width)
    if (opt === "s") rtError("bad argument #1 to 'size' (option 's' has no fixed size)")
    if (opt === "c" && width === 0)
      rtError("bad argument #1 to 'size' (option 'c0' has no fixed size)")
    if (!"bBhHlLTiIfdxcs".includes(opt)) controlOption(opt, fmt, at, header, "size")
    total += width
  }
  return total
}

export function structLib(): LuaTable {
  return freeze(makeLib({ pack, unpack, size }))
}
