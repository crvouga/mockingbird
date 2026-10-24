export interface Statement {
  run(...values: unknown[]): unknown
  get<T = Record<string, unknown>>(...values: unknown[]): T | undefined
}

export interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  query<T = Record<string, unknown>>(sql: string): T[]
  transaction<T>(run: () => T): T
  close(): void
  state: unknown
  engineState?: unknown
  snapshot?(): { encode(): Uint8Array }
}

export interface Image {
  revision: number
  pageSize: number
  bytes: Uint8Array
}
export interface Patch {
  byteLength: number
  pageSize: number
  pages: readonly { index: number; bytes: Uint8Array }[]
}
export interface Backend {
  load(key: string): Promise<Image | undefined>
  commit(key: string, revision: number, patch: Patch): Promise<number>
}
export interface Durable<T> {
  value: T
  flush(): Promise<void>
  write<R>(run: (value: T) => R): Promise<R>
  close(): Promise<void>
}
export interface SQLModule {
  Database: new () => Database
  Snapshot: { decode(bytes: Uint8Array): { open(): Database }; prototype: { encode(): Uint8Array } }
  MemoryDurabilityBackend: new () => Backend
  IndexedDBDurabilityBackend: new (options: {
    indexedDB: object
    name: string
    durability?: "default" | "strict" | "relaxed"
  }) => Backend & { close(): Promise<void> }
  openDurableDatabase(options: { key: string; backend: Backend }): Promise<Durable<Database>>
  openBufferedDurableDatabase?(options: {
    key: string
    backend: Backend
    scheduler?: {
      schedule(run: () => void, delayMs: number): unknown
      cancel(handle: unknown): void
    }
  }): Promise<Durable<Database> & { readonly pending: boolean }>
  openDurable<T>(options: {
    key: string
    backend: Backend
    codec: {
      create(): T
      decode(bytes: Uint8Array): T
      encode(value: T): Uint8Array
    }
  }): Promise<Durable<T>>
}

export interface Engine {
  name: string
  parameter: string
  create(): Database
  module?: SQLModule
}
export interface Fixture {
  run(): void | Promise<void>
  verify(): void | Promise<void>
  close(): void | Promise<void>
  details?(): Record<string, number>
}
export interface Workload {
  name: string
  operations: number
  setup(): Fixture | Promise<Fixture>
  isolate?: boolean
  /** An operation-count invariant, independent of CPU speed and CI scheduling. */
  probe?(): Promise<Record<string, number>>
}
export interface Result {
  name: string
  operations: number
  samples: number
  medianMs: number
  p95Ms: number
  perOperationUs: number
  details: Record<string, number>
}
export interface Report {
  schema: 1
  environment: { platform: string; arch: string; bun: string }
  warmup: number
  results: Result[]
  failures: string[]
}
