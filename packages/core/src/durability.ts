/** Atomic binary image port. Implementations must reject stale revisions without writing. */
export interface DurabilityBackend {
  load(key: string): Promise<DurableImage | undefined>
  commit(key: string, expectedRevision: number, patch: DurablePatch): Promise<number>
}

/**
 * Give a Fetch emulator a durable acknowledgement boundary. Inject the handle's value into
 * the service, then send every request through this wrapper. Requests serialize through the
 * response's commit, so another request cannot mutate the database during a pending save.
 */
export function withDurability<RequestType, ResponseType>(
  api: { fetch(request: RequestType): Promise<ResponseType> },
  durable: Pick<Durable<unknown>, "flush">,
): { fetch(request: RequestType): Promise<ResponseType> } {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    fetch(request) {
      const next = queue.then(async () => {
        const response = await api.fetch(request)
        await durable.flush()
        return response
      })
      queue = next.catch(() => {})
      return next
    },
  }
}

export interface DurableImage {
  revision: number
  bytes: Uint8Array
  pageSize: number
}

export interface DurablePatch {
  byteLength: number
  pageSize: number
  /** Only changed pages; data is owned by the caller until commit resolves. */
  pages: readonly { index: number; bytes: Uint8Array }[]
}

/** A second writer changed the image. Reopen before writing; never silently overwrite it. */
export class DurabilityConflictError extends Error {
  constructor() {
    super("Durable image changed in another writer; reopen before saving")
    this.name = "DurabilityConflictError"
  }
}

/** An emulator owns its codec; storage adapters know nothing about SQL or service state. */
export interface DurabilityCodec<T> {
  create(): T
  decode(bytes: Uint8Array): T
  encode(value: T): Uint8Array
  close?(value: T): void | Promise<void>
}

export interface DurableOptions<T> {
  backend: DurabilityBackend
  key: string
  codec: DurabilityCodec<T>
  /** Binary comparison/write granularity. Default 16 KiB. */
  pageSize?: number
}

export interface Durable<T> {
  readonly value: T
  /** Capture and atomically save the current state. Resolve only after storage commits. */
  flush(): Promise<void>
  /** Serialize a synchronous batch and save it with one encode and storage transaction. */
  write<R>(run: (value: T) => R): Promise<R>
  /** Save before closing. A failed save leaves the handle open for retry. */
  close(): Promise<void>
}

/**
 * Keeps the synchronous emulator hot path free of storage IO. Batch any number of mutations,
 * then await flush(), or await write(batch). A successful synchronous mutation alone is not
 * durable. No unload handlers, background timers or unhandled persistence failures.
 */
export async function openDurable<T>(options: DurableOptions<T>): Promise<Durable<T>> {
  const { backend, key, codec } = options
  const pageSize = options.pageSize ?? 16_384
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("Invalid page size")
  const image = await backend.load(key)
  let previous = image ? new Uint8Array(image.bytes) : new Uint8Array()
  const value = image ? codec.decode(image.bytes) : codec.create()
  let revision = image?.revision ?? 0
  let storedPageSize = image?.pageSize ?? pageSize
  let queue: Promise<unknown> = Promise.resolve()
  let closing = false
  let closed = false

  function enqueue<R>(run: () => Promise<R>): Promise<R> {
    if (closed || closing) return Promise.reject(new Error("Durable handle is closed"))
    const next = queue.then(run)
    queue = next.catch(() => {})
    return next
  }

  async function persist(): Promise<void> {
    const bytes = codec.encode(value)
    const byteLength = bytes.length
    const changedPages: number[] = []
    let changedBytes = 0
    // Compare synchronously before yielding, then own only changed pages. A codec can
    // reuse/mutate its buffer while storage is pending without changing this commit.
    const words =
      bytes.byteOffset % 4 === 0
        ? new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(byteLength / 4))
        : null
    const previousWords = new Uint32Array(
      previous.buffer,
      previous.byteOffset,
      Math.floor(previous.length / 4),
    )
    for (let offset = 0; offset < byteLength; offset += pageSize) {
      const end = Math.min(offset + pageSize, byteLength)
      let changed =
        storedPageSize !== pageSize || Math.min(pageSize, previous.length - offset) !== end - offset
      if (!changed) changed = !equalPage(bytes, previous, words, previousWords, offset, end)
      if (changed) {
        changedPages.push(offset / pageSize)
        changedBytes += end - offset
      }
    }
    if (
      revision !== 0 &&
      changedPages.length === 0 &&
      byteLength === previous.length &&
      storedPageSize === pageSize
    )
      return
    // Initial, resized and dense writes already replace most bytes. Own the whole image
    // once in those cases, avoiding per-page allocations plus a second reconstruction.
    const replacement =
      previous.length !== byteLength || changedBytes >= byteLength / 2
        ? new Uint8Array(bytes)
        : undefined
    const pages = changedPages.map((index) => {
      const offset = index * pageSize
      const end = Math.min(offset + pageSize, byteLength)
      return {
        index,
        // Buffer.slice returns a borrowed view; the TypedArray operation owns its result.
        bytes: replacement
          ? replacement.subarray(offset, end)
          : Uint8Array.prototype.slice.call(bytes, offset, end),
      }
    })
    revision = await backend.commit(key, revision, { byteLength, pageSize, pages })
    // Update the private comparison image only after an acknowledged commit. Reuse its
    // allocation when dimensions are unchanged, leaving failed commits safe to retry.
    if (replacement) previous = replacement
    else for (const page of pages) previous.set(page.bytes, page.index * pageSize)
    storedPageSize = pageSize
  }

  return {
    value,
    flush: () => enqueue(persist),
    write: (run) =>
      enqueue(async () => {
        const result = run(value)
        if (result && typeof (result as { then?: unknown }).then === "function") {
          throw new TypeError("Durable write callbacks must be synchronous")
        }
        await persist()
        return result
      }),
    close() {
      if (closed) return Promise.resolve()
      if (closing) return queue as Promise<void>
      const next = enqueue(async () => {
        await persist()
        await codec.close?.(value)
        closed = true
      })
      closing = true
      const completion = next.catch((error: unknown) => {
        closing = false
        queue = Promise.resolve()
        throw error
      })
      queue = completion
      return completion
    },
  }
}

/** Handle unaligned page boundaries and a partial final word without reading past either view. */
function equalPage(
  left: Uint8Array,
  right: Uint8Array,
  leftWords: Uint32Array | null,
  rightWords: Uint32Array,
  start: number,
  end: number,
): boolean {
  let offset = start
  if (!leftWords) {
    for (; offset < end; offset++) if (left[offset] !== right[offset]) return false
    return true
  }
  while (offset < end && offset % 4 !== 0) {
    if (left[offset] !== right[offset]) return false
    offset++
  }
  const wordEnd = Math.floor(end / 4)
  let word = offset / 4
  for (; word + 4 <= wordEnd; word += 4) {
    if (
      leftWords[word] !== rightWords[word] ||
      leftWords[word + 1] !== rightWords[word + 1] ||
      leftWords[word + 2] !== rightWords[word + 2] ||
      leftWords[word + 3] !== rightWords[word + 3]
    )
      return false
  }
  for (; word < wordEnd; word++) {
    if (leftWords[word] !== rightWords[word]) return false
  }
  offset = word * 4
  while (offset < end) {
    if (left[offset] !== right[offset]) return false
    offset++
  }
  return true
}

/** Apply a validated patch to an independently owned image. Also used by custom adapters. */
export function applyDurablePatch(previous: Uint8Array, patch: DurablePatch): Uint8Array {
  validateDurablePatch(patch)
  const bytes = new Uint8Array(patch.byteLength)
  bytes.set(previous.subarray(0, bytes.length))
  for (const page of patch.pages) bytes.set(page.bytes, page.index * patch.pageSize)
  return bytes
}

/** Validate before starting storage writes so invalid custom patches cannot partially commit. */
export function validateDurablePatch(patch: DurablePatch): void {
  if (
    !Number.isSafeInteger(patch.byteLength) ||
    patch.byteLength < 0 ||
    !Number.isSafeInteger(patch.pageSize) ||
    patch.pageSize < 1
  ) {
    throw new RangeError("Invalid durable patch dimensions")
  }
  const seen = new Set<number>()
  for (const page of patch.pages) {
    const offset = page.index * patch.pageSize
    if (
      !Number.isSafeInteger(page.index) ||
      page.index < 0 ||
      offset >= patch.byteLength ||
      page.bytes.length !== Math.min(patch.pageSize, patch.byteLength - offset) ||
      seen.has(page.index)
    ) {
      throw new RangeError("Invalid durable page")
    }
    seen.add(page.index)
  }
}

/** Reject missing replacement/new pages before an adapter changes the saved image. */
export function validateDurableCommit(
  patch: DurablePatch,
  previous?: { byteLength: number; pageSize: number },
): void {
  validateDurablePatch(patch)
  const supplied = new Set(patch.pages.map((page) => page.index))
  const count = Math.ceil(patch.byteLength / patch.pageSize)
  let start = count
  if (!previous || previous.pageSize !== patch.pageSize) start = 0
  else if (patch.byteLength > previous.byteLength)
    start = Math.floor(previous.byteLength / patch.pageSize)
  else if (patch.byteLength < previous.byteLength && patch.byteLength % patch.pageSize !== 0)
    start = count - 1
  for (let index = start; index < count; index++) {
    if (!supplied.has(index)) throw new RangeError("Missing durable page")
  }
}

/** Reference adapter for tests and server-side ephemeral use. */
export class MemoryDurabilityBackend implements DurabilityBackend {
  private readonly images = new Map<string, DurableImage>()

  async load(key: string): Promise<DurableImage | undefined> {
    const image = this.images.get(key)
    return image && { ...image, bytes: image.bytes.slice() }
  }

  async commit(key: string, expectedRevision: number, patch: DurablePatch): Promise<number> {
    const previous = this.images.get(key)
    if ((previous?.revision ?? 0) !== expectedRevision) throw new DurabilityConflictError()
    validateDurableCommit(
      patch,
      previous && { byteLength: previous.bytes.length, pageSize: previous.pageSize },
    )
    const revision = expectedRevision + 1
    this.images.set(key, {
      revision,
      pageSize: patch.pageSize,
      bytes: applyDurablePatch(previous?.bytes ?? new Uint8Array(), patch),
    })
    return revision
  }
}
