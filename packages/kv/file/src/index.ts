import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  compareKeys,
  type KeyValueEntry,
  type KeyValueStore,
  type ListOptions,
} from "@crvouga/mockingbird-kv"

export type FileKVOptions = {
  /** Directory that holds one file per key. Created on first write. */
  directory: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const HEX = "0123456789abcdef"
const MAX_INLINE_NAME = 200
const FILE_SUFFIX = ".kv"
const TEMP_SUFFIX = ".tmp"

const toHex = (bytes: Uint8Array) => {
  let out = ""
  for (const byte of bytes) out += (HEX[byte >> 4] as string) + (HEX[byte & 15] as string)
  return out
}

const sha256Hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return toHex(new Uint8Array(digest))
}

/**
 * Filenames are `k<hex(key)>.kv`, or `h<sha256(key)>.kv` when the hex form would exceed common
 * filesystem name limits. Every file stores the key itself (length-prefixed) followed by the value,
 * so enumeration never has to trust the filename.
 */
const fileNameFor = async (keyBytes: Uint8Array) => {
  const hex = toHex(keyBytes)
  if (hex.length <= MAX_INLINE_NAME) return `k${hex}${FILE_SUFFIX}`
  return `h${await sha256Hex(keyBytes)}${FILE_SUFFIX}`
}

const encodeRecord = (keyBytes: Uint8Array, value: Uint8Array) => {
  const record = new Uint8Array(4 + keyBytes.byteLength + value.byteLength)
  new DataView(record.buffer).setUint32(0, keyBytes.byteLength)
  record.set(keyBytes, 4)
  record.set(value, 4 + keyBytes.byteLength)
  return record
}

const decodeRecord = (record: Uint8Array) => {
  const keyLength = new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(0)
  const key = decoder.decode(record.subarray(4, 4 + keyLength))
  const value = record.slice(4 + keyLength)
  return { key, value }
}

const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

/**
 * {@link KeyValueStore} persisted as one file per key inside `directory`.
 *
 * Node.js / Bun only (`node:fs/promises`). Writes are atomic (temp file + rename).
 * `list()` reads every record and sorts by key, so directory order is irrelevant.
 */
export class FileKV implements KeyValueStore {
  private readonly directory: string
  private ready: Promise<void> | undefined

  constructor(options: FileKVOptions) {
    this.directory = options.directory
  }

  private ensureDirectory() {
    this.ready ??= mkdir(this.directory, { recursive: true }).then(() => undefined)
    return this.ready
  }

  private async pathFor(key: string) {
    return join(this.directory, await fileNameFor(encoder.encode(key)))
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const record = new Uint8Array(await readFile(await this.pathFor(key)))
      const decoded = decodeRecord(record)
      return decoded.key === key ? decoded.value : undefined
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.ensureDirectory()
    const path = await this.pathFor(key)
    const temp = `${path}${TEMP_SUFFIX}`
    await writeFile(temp, encodeRecord(encoder.encode(key), value))
    await rename(temp, path)
  }

  async delete(key: string): Promise<void> {
    await rm(await this.pathFor(key), { force: true })
  }

  async *list(options: ListOptions = {}): AsyncIterable<KeyValueEntry> {
    const prefix = options.prefix ?? ""
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    const entries: KeyValueEntry[] = []
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue
      try {
        const record = decodeRecord(new Uint8Array(await readFile(join(this.directory, name))))
        if (record.key.startsWith(prefix)) entries.push(record)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    entries.sort((a, b) => compareKeys(a.key, b.key))
    yield* entries
  }
}
