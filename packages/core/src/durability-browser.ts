import {
  applyDurablePatch,
  type DurabilityBackend,
  DurabilityConflictError,
  type DurableImage,
  type DurablePatch,
  validateDurableCommit,
  validateDurablePatch,
} from "./durability.js"
import type { DurabilityLifecycle } from "./durability-buffered.js"

/** Best effort only; browsers do not wait for asynchronous pagehide work. */
export const browserDurabilityLifecycle: DurabilityLifecycle = {
  subscribe(onSuspend) {
    if (typeof globalThis.addEventListener !== "function") return () => {}
    globalThis.addEventListener("pagehide", onSuspend)
    return () => globalThis.removeEventListener("pagehide", onSuspend)
  },
}

type ImageMeta = { revision: number; byteLength: number; pageSize: number }
type Page = { key: string; index: number; bytes: Uint8Array }

export interface IndexedDBDurabilityOptions {
  name?: string
  /** Inject for workers, tests or a different browser realm. */
  indexedDB?: { open(name: string, version?: number): unknown }
  /** Default strict: acknowledgement follows the browser's durable commit. */
  durability?: "default" | "strict" | "relaxed"
}

/** Binary pages, changed-page writes and revision checks in one IndexedDB transaction. */
export class IndexedDBDurabilityBackend implements DurabilityBackend {
  private database: Promise<IDBDatabase> | undefined
  private readonly factory: IDBFactory
  private readonly name: string
  private readonly durability: IDBTransactionDurability

  constructor(options: IndexedDBDurabilityOptions = {}) {
    this.factory = (options.indexedDB ?? globalThis.indexedDB) as IDBFactory
    if (!this.factory) throw new Error("IndexedDB is unavailable; inject a durability backend")
    this.name = options.name ?? "mockingbird"
    this.durability = options.durability ?? "strict"
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore("images")
        const pages = db.createObjectStore("pages", { keyPath: ["key", "index"] })
        pages.createIndex("image", "key")
      }
      request.onerror = () => {
        this.database = undefined
        reject(request.error)
      }
      request.onblocked = () => {
        // Other open connections can close on versionchange; keep waiting for them.
      }
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          db.close()
          this.database = undefined
        }
        resolve(db)
      }
    })
    return this.database
  }

  async load(key: string): Promise<DurableImage | undefined> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["images", "pages"], "readonly")
      let image: DurableImage | undefined
      let failure: unknown
      tx.onabort = () => reject(failure ?? tx.error)
      tx.oncomplete = () => resolve(image)
      const meta = tx.objectStore("images").get(key)
      meta.onsuccess = () => {
        const info = meta.result as ImageMeta | undefined
        if (!info) return
        const request = tx.objectStore("pages").index("image").getAll(key)
        request.onsuccess = () => {
          try {
            const bytes = new Uint8Array(info.byteLength)
            const pages = request.result as Page[]
            if (pages.length !== Math.ceil(info.byteLength / info.pageSize)) {
              throw new Error("Incomplete durable image")
            }
            const patch = {
              ...info,
              pages: pages.map((page) => ({ index: page.index, bytes: page.bytes })),
            }
            validateDurablePatch(patch)
            for (const page of pages) bytes.set(page.bytes, page.index * info.pageSize)
            image = { revision: info.revision, pageSize: info.pageSize, bytes }
          } catch (error) {
            failure = error
            tx.abort()
          }
        }
      }
    })
  }

  async commit(key: string, expectedRevision: number, patch: DurablePatch): Promise<number> {
    validateDurablePatch(patch)
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["images", "pages"], "readwrite", { durability: this.durability })
      let failure: unknown
      tx.onabort = () => reject(failure ?? tx.error)
      tx.oncomplete = () => resolve(expectedRevision + 1)
      const images = tx.objectStore("images")
      const pages = tx.objectStore("pages")
      const request = images.get(key)
      request.onsuccess = () => {
        try {
          const previous = request.result as ImageMeta | undefined
          if ((previous?.revision ?? 0) !== expectedRevision) {
            failure = new DurabilityConflictError()
            tx.abort()
            return
          }
          validateDurableCommit(patch, previous)
          // Every retained page is replaced when re-paging. Delete only the old tail;
          // no index scan or cursor round trips are needed.
          const oldCount = previous ? Math.ceil(previous.byteLength / previous.pageSize) : 0
          const newCount = Math.ceil(patch.byteLength / patch.pageSize)
          for (let index = newCount; index < oldCount; index++) pages.delete([key, index])
          for (const page of patch.pages) {
            // Structured clone preserves a view's entire backing buffer and offset.
            // Compact borrowed page views before put(), so a full-image save clones
            // O(image size) bytes rather than O(page count * image size).
            const bytes =
              page.bytes.byteOffset === 0 && page.bytes.byteLength === page.bytes.buffer.byteLength
                ? page.bytes
                : new Uint8Array(page.bytes)
            pages.put({ key, index: page.index, bytes } satisfies Page)
          }
          images.put(
            {
              revision: expectedRevision + 1,
              byteLength: patch.byteLength,
              pageSize: patch.pageSize,
            } satisfies ImageMeta,
            key,
          )
        } catch (error) {
          failure = error
          tx.abort()
        }
      }
    })
  }

  /** Release this adapter's connection; does not delete any saved images. */
  async close(): Promise<void> {
    const opening = this.database
    this.database = undefined
    if (opening) (await opening).close()
  }
}

export interface LocalStorageDurabilityOptions {
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void }
  prefix?: string
  /** Inject navigator.locks for cross-tab compare-and-swap. Required for safe shared writers. */
  locks?: { request<T>(name: string, run: () => T | PromiseLike<T>): Promise<T> }
}

/**
 * Small-image fallback. Each commit replaces one base64 image atomically. IndexedDB avoids
 * this full-image encoding and synchronous main-thread IO and is preferred for performance.
 * With no Web Locks support, use one writer per key (localStorage has no native CAS).
 */
export class LocalStorageDurabilityBackend implements DurabilityBackend {
  private readonly storage: NonNullable<LocalStorageDurabilityOptions["storage"]>
  private readonly prefix: string
  private readonly locks: LocalStorageDurabilityOptions["locks"]

  constructor(options: LocalStorageDurabilityOptions = {}) {
    this.storage = options.storage ?? globalThis.localStorage
    if (!this.storage) throw new Error("localStorage is unavailable; inject a durability backend")
    this.prefix = options.prefix ?? "mockingbird:"
    this.locks = options.locks ?? globalThis.navigator?.locks
  }

  async load(key: string): Promise<DurableImage | undefined> {
    return this.read(key)
  }

  private read(key: string): DurableImage | undefined {
    const text = this.storage.getItem(this.prefix + key)
    if (text === null) return undefined
    const image = JSON.parse(text) as { revision: number; pageSize: number; data: string }
    const binary = atob(image.data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { revision: image.revision, pageSize: image.pageSize, bytes }
  }

  async commit(key: string, expectedRevision: number, patch: DurablePatch): Promise<number> {
    const save = () => {
      const previous = this.read(key)
      if ((previous?.revision ?? 0) !== expectedRevision) throw new DurabilityConflictError()
      validateDurableCommit(
        patch,
        previous && { byteLength: previous.bytes.length, pageSize: previous.pageSize },
      )
      const bytes = applyDurablePatch(previous?.bytes ?? new Uint8Array(), patch)
      let binary = ""
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      }
      const revision = expectedRevision + 1
      this.storage.setItem(
        this.prefix + key,
        JSON.stringify({ revision, pageSize: patch.pageSize, data: btoa(binary) }),
      )
      return revision
    }
    return this.locks ? this.locks.request(this.prefix + key, save) : save()
  }
}
