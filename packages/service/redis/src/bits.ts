/**
 * String-value commands that read a string as something else: bitmaps (`SETBIT`, `GETBIT`,
 * `BITCOUNT`) and HyperLogLogs (`PFADD`, `PFCOUNT`, `PFMERGE`).
 *
 * Best guess, not oracle-verified as an algorithm: a HyperLogLog here is an exact set stored in a
 * string that starts with Redis's `HYLL` magic, so `TYPE` is `string` and the commands' replies,
 * errors and keyspace effects match Redis, but `PFCOUNT` is exact where Redis's estimate has a
 * ~0.81% standard error, and `GET` of the key returns this emulator's encoding, not Redis's
 * sparse/dense registers.
 */
import { latin1, parseI64, utf8 } from "./bytes.ts"
import {
  arityError,
  err,
  int,
  notInteger,
  ok,
  queued,
  type Reply,
  syntaxError,
  wrongType,
} from "./protocol.ts"
import type { Database } from "./store.ts"

export const BITS_WRITES = ["setbit", "pfadd", "pfmerge"] as const

const text = (bytes: Uint8Array | undefined): string => (bytes ? latin1(bytes) : "")

/** Largest bit offset: a string may hold 512 MiB (`proto-max-bulk-len`). */
const MAX_BIT_OFFSET = 4294967295n

function stringAt(database: Database, key: string): Uint8Array | Reply | null {
  const value = database.get(key)
  if (!value) return null
  return value.kind === "string" ? value.bytes : wrongType()
}

const isReply = (value: unknown): value is Reply =>
  typeof value === "object" && value !== null && "t" in value && !(value instanceof Uint8Array)

function bitOffset(raw: Uint8Array | undefined): number | null {
  const parsed = parseI64(raw ?? utf8(""))
  if (parsed === null || parsed < 0n || parsed > MAX_BIT_OFFSET) return null
  return Number(parsed)
}

const offsetError = () => err("ERR bit offset is not an integer or out of range")

export function cmdSetbit(database: Database, args: Uint8Array[], apply: boolean): Reply {
  if (args.length !== 3) return arityError("setbit")
  const offset = bitOffset(args[1])
  if (offset === null) return offsetError()
  const bitText = text(args[2])
  if (bitText !== "0" && bitText !== "1") return err("ERR bit is not an integer or out of range")
  const key = text(args[0])
  const current = stringAt(database, key)
  if (isReply(current)) return current
  if (!apply) return queued()
  const byte = offset >> 3
  const mask = 1 << (7 - (offset & 7))
  let bytes = current ?? new Uint8Array(0)
  if (bytes.length <= byte) {
    const grown = new Uint8Array(byte + 1)
    grown.set(bytes)
    bytes = grown
  } else bytes = Uint8Array.from(bytes)
  const previous = (bytes[byte] ?? 0) & mask ? 1 : 0
  bytes[byte] = bitText === "1" ? (bytes[byte] ?? 0) | mask : (bytes[byte] ?? 0) & ~mask
  database.put(key, { kind: "string", bytes })
  return int(previous)
}

export function cmdGetbit(database: Database, args: Uint8Array[]): Reply {
  if (args.length !== 2) return arityError("getbit")
  const offset = bitOffset(args[1])
  if (offset === null) return offsetError()
  const current = stringAt(database, text(args[0]))
  if (isReply(current)) return current
  const byte = current?.[offset >> 3] ?? 0
  return int(byte & (1 << (7 - (offset & 7))) ? 1 : 0)
}

const popcount = (byte: number): number => {
  let count = 0
  for (let value = byte; value; value &= value - 1) count++
  return count
}

export function cmdBitcount(database: Database, args: Uint8Array[]): Reply {
  if (args.length < 1) return arityError("bitcount")
  if (args.length === 2 || args.length > 4) return syntaxError()
  let bitMode = false
  if (args.length === 4) {
    const unit = text(args[3]).toUpperCase()
    if (unit === "BIT") bitMode = true
    else if (unit !== "BYTE") return syntaxError()
  }
  const start = args.length >= 3 ? parseI64(args[1] ?? utf8("")) : 0n
  const end = args.length >= 3 ? parseI64(args[2] ?? utf8("")) : -1n
  if (start === null || end === null) return notInteger()
  const current = stringAt(database, text(args[0]))
  if (isReply(current)) return current
  if (!current) return int(0)
  const length = BigInt(bitMode ? current.length * 8 : current.length)
  let from = start < 0n ? length + start : start
  let to = end < 0n ? length + end : end
  if (from < 0n) from = 0n
  if (to < 0n) to = 0n
  if (to >= length) to = length - 1n
  if (from > to) return int(0)
  let count = 0
  if (!bitMode) {
    for (let i = Number(from); i <= Number(to); i++) count += popcount(current[i] ?? 0)
    return int(count)
  }
  for (let bit = Number(from); bit <= Number(to); bit++)
    if ((current[bit >> 3] ?? 0) & (1 << (7 - (bit & 7)))) count++
  return int(count)
}

// ---------------------------------------------------------------------------------------------
// HyperLogLog (exact-set best guess)

/** `HYLL`, then this emulator's encoding byte (0xff: an exact member list), then 11 zero bytes. */
const HEADER = Uint8Array.from([0x48, 0x59, 0x4c, 0x4c, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

const notHll = () => err("WRONGTYPE Key is not a valid HyperLogLog string value.")

function decodeHll(bytes: Uint8Array): Set<string> | null {
  if (bytes.length < HEADER.length) return null
  for (let i = 0; i < HEADER.length; i++) if (bytes[i] !== HEADER[i]) return null
  const members = new Set<string>()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = HEADER.length
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return null
    const size = view.getUint32(at)
    at += 4
    if (at + size > bytes.length) return null
    members.add(latin1(bytes.subarray(at, at + size)))
    at += size
  }
  return members
}

function encodeHll(members: Set<string>): Uint8Array {
  const parts = [...members].sort()
  let size = HEADER.length
  for (const member of parts) size += 4 + member.length
  const out = new Uint8Array(size)
  out.set(HEADER)
  const view = new DataView(out.buffer)
  let at = HEADER.length
  for (const member of parts) {
    view.setUint32(at, member.length)
    at += 4
    for (let i = 0; i < member.length; i++) out[at++] = member.charCodeAt(i)
  }
  return out
}

/** The members of the HLL at `key`, null when it does not exist, or an error reply. */
function hllAt(database: Database, key: string): Set<string> | Reply | null {
  const value = database.get(key)
  if (!value) return null
  if (value.kind !== "string") return wrongType()
  return decodeHll(value.bytes) ?? notHll()
}

const isSet = (value: unknown): value is Set<string> => value instanceof Set

function writeHll(database: Database, key: string, members: Set<string>): void {
  database.put(key, { kind: "string", bytes: encodeHll(members) })
}

export function cmdPfadd(database: Database, args: Uint8Array[], apply: boolean): Reply {
  if (args.length < 1) return arityError("pfadd")
  const key = text(args[0])
  const current = hllAt(database, key)
  if (current !== null && !isSet(current)) return current
  if (!apply) return queued()
  const members = current ?? new Set<string>()
  let changed = current === null
  for (const arg of args.slice(1)) {
    const member = latin1(arg)
    if (members.has(member)) continue
    members.add(member)
    changed = true
  }
  if (changed) writeHll(database, key, members)
  return int(changed ? 1 : 0)
}

export function cmdPfcount(database: Database, args: Uint8Array[]): Reply {
  if (args.length < 1) return arityError("pfcount")
  const union = new Set<string>()
  for (const arg of args) {
    const members = hllAt(database, text(arg))
    if (members === null) continue
    if (!isSet(members)) return members
    for (const member of members) union.add(member)
  }
  return int(union.size)
}

export function cmdPfmerge(database: Database, args: Uint8Array[], apply: boolean): Reply {
  if (args.length < 1) return arityError("pfmerge")
  const union = new Set<string>()
  for (const arg of args) {
    const members = hllAt(database, text(arg))
    if (members === null) continue
    if (!isSet(members)) return members
    for (const member of members) union.add(member)
  }
  if (!apply) return queued()
  writeHll(database, text(args[0]), union)
  return ok()
}
