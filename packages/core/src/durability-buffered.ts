import {
  type DurabilityBackend,
  type DurabilityCodec,
  DurabilityConflictError,
  type Durable,
  type DurablePatch,
} from "./durability.js"

export interface DurabilityScheduler {
  schedule(run: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

export interface DurabilityLifecycle {
  subscribe(onSuspend: () => void): () => void
}

export interface BufferedDurabilityObserver {
  changed(): void
  exposed(): void
  assertWritable(): void
  /** An independently closed engine cannot keep a background persistence loop alive. */
  closed?(): void
}

export interface IncrementalCapture<Token> {
  token: Token
  checkpoint: boolean
  /** Omit when the committed state has not changed. Bytes must be independently owned. */
  bytes?: Uint8Array
}

/** Engine port: capture physical committed state, never SQL text for replay. */
export interface IncrementalDurabilityCodec<T, Token> extends DurabilityCodec<T> {
  decodeJournal(records: readonly Uint8Array[]): T
  /** Initialize comparison state after recovery without re-encoding the checkpoint. */
  baseline?(value: T): Token
  capture(value: T, previous: Token | undefined, checkpoint: boolean): IncrementalCapture<Token>
  acknowledge(value: T, token: Token): void
  canCapture(value: T): boolean
  subscribe(value: T, observer: BufferedDurabilityObserver): () => void
}

export interface BufferedDurabilityOptions {
  /** First-change deadline, not a debounce. Default 1,000 ms; suspension can delay it. */
  flushIntervalMs?: number
  scheduler?: DurabilityScheduler
  lifecycle?: DurabilityLifecycle
  onError?: (error: unknown) => void
  /** Default 256 successful delta batches. */
  compactAfterBatches?: number
  /** Default max(4 MiB, checkpoint size). */
  compactAfterBytes?: number
}

export interface BufferedDurable<T> extends Durable<T> {
  readonly pending: boolean
  readonly lastError: unknown
}

const HEADER = 32
const MAGIC = [77, 66, 68, 74] // MBDJ

export function isDurableJournal(bytes: Uint8Array): boolean {
  return MAGIC.every((byte, index) => bytes[index] === byte)
}

function checksum(bytes: Uint8Array): number {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193)
  return hash >>> 0
}

function header(checkpointBytes: number, hash: number): Uint8Array {
  if (checkpointBytes > 0xffff_ffff) throw new RangeError("Buffered checkpoint exceeds 4 GiB")
  const bytes = new Uint8Array(HEADER)
  bytes.set(MAGIC)
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 1, true)
  view.setUint32(8, checkpointBytes, true)
  view.setUint32(20, hash, true)
  view.setUint32(24, checksum(bytes.subarray(0, 24)), true)
  return bytes
}

/** A legacy immediate writer can retain a buffered image's richer checkpoint metadata. */
export function encodeDurableCheckpoint(record: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(HEADER + record.length)
  bytes.set(header(record.length, checksum(record)))
  bytes.set(record, HEADER)
  return bytes
}

/** Undefined identifies an unchanged legacy image; malformed envelopes fail closed. */
export function readDurableJournal(bytes: Uint8Array): readonly Uint8Array[] | undefined {
  if (!isDurableJournal(bytes)) return undefined
  const bad = () => {
    throw new Error("Invalid buffered durability image")
  }
  if (bytes.length < HEADER) return bad()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const checkpointBytes = view.getUint32(8, true)
  if (
    view.getUint32(4, true) !== 1 ||
    view.getUint32(12, true) !== 0 ||
    view.getUint32(16, true) !== 0 ||
    view.getUint32(24, true) !== checksum(bytes.subarray(0, 24)) ||
    HEADER + checkpointBytes > bytes.length
  )
    return bad()
  const checkpoint = bytes.subarray(HEADER, HEADER + checkpointBytes)
  if (checksum(checkpoint) !== view.getUint32(20, true)) return bad()
  const records = [checkpoint]
  let offset = HEADER + checkpointBytes
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return bad()
    const length = view.getUint32(offset, true)
    const hash = view.getUint32(offset + 4, true)
    offset += 8
    if (offset + length > bytes.length) return bad()
    const record = bytes.subarray(offset, offset + length)
    if (checksum(record) !== hash) return bad()
    records.push(record)
    offset += length
  }
  if (offset !== bytes.length) return bad()
  return records
}

const timers: DurabilityScheduler = {
  schedule(run, delay) {
    const timer = setTimeout(run, delay)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return timer
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  },
}

/** Single-writer buffered persistence. Only the last append page is retained between saves. */
export async function openBufferedDurable<T, Token>(
  options: BufferedDurabilityOptions & {
    key: string
    backend: DurabilityBackend
    codec: IncrementalDurabilityCodec<T, Token>
    pageSize?: number
  },
): Promise<BufferedDurable<T>> {
  const { backend, key, codec } = options
  const pageSize = options.pageSize ?? 16_384
  const interval = options.flushIntervalMs ?? 1000
  const maxBatches = options.compactAfterBatches ?? 256
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !Number.isSafeInteger(maxBatches) ||
    maxBatches < 1 ||
    (options.compactAfterBytes !== undefined &&
      (!Number.isSafeInteger(options.compactAfterBytes) || options.compactAfterBytes < 1))
  )
    throw new RangeError("Invalid buffered durability options")
  const scheduler = options.scheduler ?? timers
  const image = await backend.load(key)
  const records = image && readDurableJournal(image.bytes)
  const value = image
    ? records
      ? codec.decodeJournal(records)
      : codec.decode(image.bytes)
    : codec.create()
  let revision = image?.revision ?? 0
  let length = records && image ? image.bytes.length : 0
  let baseLength = records?.[0]?.length ?? 0
  let baseHash = records?.[0] ? checksum(records[0]) : 0
  let batches = records ? records.length - 1 : 0
  let tail: Uint8Array =
    records && image
      ? new Uint8Array(image.bytes.subarray(Math.floor((length - 1) / pageSize) * pageSize))
      : new Uint8Array()
  let checkpointRequired = !records || image?.pageSize !== pageSize
  let previous: Token | undefined
  // A reopened journal needs a comparison token, but not another persisted checkpoint.
  if (records)
    previous = codec.baseline ? codec.baseline(value) : codec.capture(value, undefined, true).token
  let generation = 0
  let saved = 0
  let queued = 0
  let inWrite = false
  let closing = false
  let closed = false
  let conflict: unknown
  let lastError: unknown
  let exposed = false
  let timer: unknown
  let timerActive = false
  let retryDelay = interval
  let queue: Promise<unknown> = Promise.resolve()

  function cancel(): void {
    if (timerActive) scheduler.cancel(timer)
    timerActive = false
  }
  function schedule(delay = interval): void {
    if (timerActive || closing || closed || conflict) return
    timerActive = true
    timer = scheduler.schedule(() => {
      timerActive = false
      if (!codec.canCapture(value)) {
        schedule()
        return
      }
      void enqueue(() => persist()).catch(() => {})
    }, delay)
  }
  function failure(error: unknown): void {
    lastError = error
    if (
      error instanceof DurabilityConflictError ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "DurabilityConflictError")
    ) {
      conflict = error
      cancel()
      stopLifecycle?.()
    } else {
      schedule(retryDelay)
      retryDelay = Math.min(10_000, Math.max(1000, retryDelay * 2))
    }
    try {
      options.onError?.(error)
    } catch {
      /* Observers cannot turn background failures into unhandled rejections. */
    }
  }
  function enqueue<R>(run: () => Promise<R>): Promise<R> {
    if (closed || closing) return Promise.reject(new Error("Durable handle is closed"))
    if (conflict) return Promise.reject(conflict)
    queued++
    const next = queue.then(run).finally(() => {
      queued--
    })
    queue = next.catch(() => {})
    return next
  }

  async function persist(force = false): Promise<void> {
    if (conflict) throw conflict
    cancel()
    if (!checkpointRequired && generation === saved && !exposed && !force) return
    const at = generation
    try {
      const checkpoint =
        checkpointRequired ||
        batches >= maxBatches ||
        length - HEADER - baseLength >=
          (options.compactAfterBytes ?? Math.max(4 * 1024 * 1024, baseLength))
      const capture = codec.capture(value, previous, checkpoint || exposed)
      if (!capture.bytes) {
        previous = capture.token
        saved = at
        codec.acknowledge(value, capture.token)
        lastError = undefined
        retryDelay = interval
        return
      }
      const payload = capture.bytes
      let patch: DurablePatch
      let nextLength: number
      let nextBase = baseLength
      let nextHash = baseHash
      let nextBatches = batches
      if (capture.checkpoint) {
        nextBase = payload.length
        nextHash = checksum(payload)
        nextBatches = 0
        nextLength = HEADER + payload.length
        const bytes = new Uint8Array(nextLength)
        bytes.set(header(nextBase, nextHash))
        bytes.set(payload, HEADER)
        const pages = []
        for (let offset = 0; offset < bytes.length; offset += pageSize)
          pages.push({ index: offset / pageSize, bytes: bytes.subarray(offset, offset + pageSize) })
        patch = { byteLength: nextLength, pageSize, pages }
      } else {
        const frame = new Uint8Array(8 + payload.length)
        const view = new DataView(frame.buffer)
        view.setUint32(0, payload.length, true)
        view.setUint32(4, checksum(payload), true)
        frame.set(payload, 8)
        nextLength = length + frame.length
        nextBatches++
        const pages = new Map<number, Uint8Array>()
        let offset = length
        while (offset < nextLength) {
          const index = Math.floor(offset / pageSize)
          const start = index * pageSize
          let page = pages.get(index)
          if (!page) {
            page = new Uint8Array(Math.min(pageSize, nextLength - start))
            if (index === Math.floor((length - 1) / pageSize)) page.set(tail)
            pages.set(index, page)
          }
          const count = Math.min(page.length - (offset - start), nextLength - offset)
          page.set(frame.subarray(offset - length, offset - length + count), offset - start)
          offset += count
        }
        patch = {
          byteLength: nextLength,
          pageSize,
          pages: [...pages].map(([index, bytes]) => ({ index, bytes })),
        }
      }
      const lastPage = patch.pages.find(
        (page) => page.index === Math.floor((nextLength - 1) / pageSize),
      )
      if (!lastPage) throw new Error("Missing buffered tail page")
      const nextTail =
        lastPage.bytes.byteOffset === 0 &&
        lastPage.bytes.byteLength === lastPage.bytes.buffer.byteLength
          ? lastPage.bytes
          : new Uint8Array(lastPage.bytes)
      revision = await backend.commit(key, revision, patch)
      tail = nextTail
      length = nextLength
      baseLength = nextBase
      baseHash = nextHash
      batches = nextBatches
      previous = capture.token
      checkpointRequired = false
      codec.acknowledge(value, capture.token)
      saved = at
      lastError = undefined
      retryDelay = interval
    } catch (error) {
      failure(error)
      throw error
    } finally {
      if (generation !== saved || exposed) schedule()
    }
  }

  let unsubscribe = () => {}
  let stopLifecycle: (() => void) | undefined
  unsubscribe = codec.subscribe(value, {
    changed() {
      generation++
      schedule()
    },
    exposed() {
      exposed = true
      generation++
      schedule()
    },
    assertWritable() {
      if (closed || (closing && !inWrite)) throw new Error("Durable handle is closed")
    },
    closed() {
      if (closing || closed) return
      closed = true
      cancel()
      unsubscribe()
      stopLifecycle?.()
      if (checkpointRequired || generation !== saved)
        failure(
          new Error("Database closed directly; pending buffered changes were not acknowledged"),
        )
      void Promise.resolve()
        .then(() => codec.close?.(value))
        .catch(failure)
    },
  })
  stopLifecycle = !closed
    ? options.lifecycle?.subscribe(() => {
        if (!closed && !closing && !conflict && codec.canCapture(value))
          void enqueue(persist).catch(() => {})
      })
    : undefined
  if (checkpointRequired) schedule()
  return {
    value,
    get pending() {
      return checkpointRequired || generation !== saved || queued > 0
    },
    get lastError() {
      return lastError
    },
    flush: () => enqueue(() => persist(true)),
    write: <R>(run: (value: T) => R) =>
      enqueue(async () => {
        let result: R
        inWrite = true
        try {
          result = run(value)
        } finally {
          inWrite = false
        }
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw new TypeError("Durable write callbacks must be synchronous")
        generation++
        await persist()
        return result
      }),
    close() {
      if (closed) return lastError ? Promise.reject(lastError) : Promise.resolve()
      if (closing) return queue as Promise<void>
      const next = enqueue(async () => {
        await persist(true)
        await codec.close?.(value)
        cancel()
        unsubscribe()
        stopLifecycle?.()
        closed = true
      })
      closing = true
      const completion = next.catch((error: unknown) => {
        closing = false
        queue = Promise.resolve()
        if (!conflict) schedule()
        throw error
      })
      queue = completion
      return completion
    },
  }
}

/** Pack engine-specific metadata alongside a standard SQLM/PGMM snapshot. */
export function packDurableRecord(metadata: unknown, snapshot: Uint8Array): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify(packValue(metadata)))
  const bytes = new Uint8Array(4 + meta.length + snapshot.length)
  new DataView(bytes.buffer).setUint32(0, meta.length, true)
  bytes.set(meta, 4)
  bytes.set(snapshot, 4 + meta.length)
  return bytes
}

export function unpackDurableRecord<Metadata>(bytes: Uint8Array): {
  metadata: Metadata
  snapshot: Uint8Array
} {
  if (bytes.length < 4) throw new Error("Invalid buffered record")
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
  if (length > bytes.length - 4) throw new Error("Invalid buffered record")
  return {
    metadata: unpackValue(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + length))),
    ) as Metadata,
    snapshot: bytes.subarray(4 + length),
  }
}

// Every container is tagged, so user arrays/objects cannot collide with scalar extension tags.
function packValue(value: unknown): unknown {
  if (typeof value === "bigint") return [2, String(value)]
  if (typeof value === "number" && !Number.isFinite(value)) return [3, String(value)]
  if (value instanceof Uint8Array) return [1, Array.from(value)]
  if (Array.isArray(value)) return [0, value.map(packValue)]
  if (value !== null && typeof value === "object")
    return [
      4,
      Object.entries(value)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, packValue(value)]),
    ]
  if (value === undefined) throw new TypeError("Undefined durable metadata")
  return value
}
function unpackValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const [tag, payload] = value
  switch (tag) {
    case 0:
      return (payload as unknown[]).map(unpackValue)
    case 1:
      return new Uint8Array(payload as number[])
    case 2:
      return BigInt(payload as string)
    case 3:
      return Number(payload)
    case 4:
      return Object.fromEntries(
        (payload as [string, unknown][]).map(([key, value]) => [key, unpackValue(value)]),
      )
    default:
      throw new Error("Invalid durable metadata tag")
  }
}
