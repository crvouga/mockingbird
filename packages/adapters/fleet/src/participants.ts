import { type Clock, createClock, parseDuration, restoreClock } from "@crvouga/mockingbird-service"
import type { InProcessRuntime } from "./in-process.js"

type Codec<T, Point> = {
  create(namespace: string): T
  snapshot(value: T): Point
  restore(value: T, point: Point): T
  encode(value: T, point: Point): unknown
  decode(value: T, document: unknown): Point
  dispose?(value: T): void
  clock?(value: T): Clock
}

/** Adapt an engine's own checkpoint codec; never serialize its private mutable fields. */
export function snapshotParticipant<T, Point>(codec: Codec<T, Point>) {
  const values = new Map<string, T>()
  const points = new WeakMap<object, { namespace: string; document: unknown }>()
  const named = new Map<string, Map<string, object>>()
  const value = (namespace = "default") => {
    let current = values.get(namespace)
    if (current === undefined) {
      current = codec.create(namespace)
      values.set(namespace, current)
    }
    return current
  }
  const point = (namespace: string, document: unknown) => {
    const handle = {}
    points.set(handle, { namespace, document: structuredClone(document) })
    return handle
  }
  const read = (handle: object) => {
    const stored = points.get(handle)
    if (!stored) throw new Error("invalid participant checkpoint")
    return stored
  }
  const runtime: InProcessRuntime & { value: typeof value; dispose(): void } = {
    value,
    namespaces: () => [...values.keys()],
    async reset(namespace = "default") {
      const previous = values.get(namespace)
      const next = codec.create(namespace)
      values.set(namespace, next)
      if (previous !== undefined) codec.dispose?.(previous)
      named.delete(namespace)
    },
    async dropNamespace(namespace) {
      const previous = values.get(namespace)
      if (previous !== undefined) codec.dispose?.(previous)
      values.delete(namespace)
      named.delete(namespace)
    },
    snapshots: {
      create(options = {}) {
        const namespace = options.namespace ?? "default"
        const id = options.name ?? crypto.randomUUID()
        const collection = named.get(namespace) ?? new Map<string, object>()
        if (collection.has(id)) throw new Error("snapshot already exists")
        collection.set(id, runtime.fleetSnapshot(namespace))
        named.set(namespace, collection)
        return { id }
      },
      list: (namespace = "default") =>
        [...(named.get(namespace)?.keys() ?? [])].map((id) => ({ id })),
      delete: (id, namespace = "default") => named.get(namespace)?.delete(id) ?? false,
      restore(id, namespace = "default") {
        const handle = named.get(namespace)?.get(id)
        if (!handle) throw new Error("snapshot not found")
        runtime.fleetRestore(handle, namespace)
      },
    },
    fleetSnapshot: (namespace) =>
      point(namespace, codec.encode(value(namespace), codec.snapshot(value(namespace)))),
    fleetExport(handle) {
      const stored = read(handle)
      return structuredClone(stored.document)
    },
    fleetImport: (namespace, document) => {
      codec.decode(value(namespace), document)
      return point(namespace, document)
    },
    fleetRestore(handle, namespace) {
      const stored = read(handle)
      if (stored.namespace !== namespace) throw new Error("participant namespace mismatch")
      const previous = value(namespace)
      const next = codec.restore(previous, codec.decode(previous, stored.document))
      values.set(namespace, next)
      if (next !== previous) codec.dispose?.(previous)
    },
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/__admin/health") return Response.json({ status: "ok", service: "participant" })
      if (path === "/__admin/clock" && ["GET", "POST"].includes(request.method) && codec.clock) {
        const namespace = request.headers.get("x-mockingbird-namespace") ?? "default"
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(namespace))
          return Response.json({ error: "invalid namespace" }, { status: 400 })
        const clock = codec.clock(value(namespace))
        if (request.method === "POST") {
          try {
            const body = (await request.json()) as Record<string, unknown>
            if (
              !body ||
              typeof body !== "object" ||
              Array.isArray(body) ||
              Object.keys(body).some((key) => !["set", "advance", "freeze"].includes(key))
            )
              throw new Error("invalid clock control")
            const set =
              body.set === undefined
                ? undefined
                : typeof body.set === "number"
                  ? body.set
                  : typeof body.set === "string"
                    ? Date.parse(body.set)
                    : NaN
            const advance = body.advance === undefined ? undefined : parseDuration(body.advance)
            if (
              (set !== undefined && !Number.isFinite(set)) ||
              (body.advance !== undefined && advance === undefined) ||
              (body.freeze !== undefined && typeof body.freeze !== "boolean")
            )
              throw new Error("invalid clock control")
            if (set !== undefined) clock.set(set)
            if (advance !== undefined) clock.advance(advance)
            if (body.freeze === true) clock.freeze()
            if (body.freeze === false) clock.unfreeze()
          } catch (error) {
            return Response.json(
              { error: error instanceof Error ? error.message : "invalid clock control" },
              { status: 400 },
            )
          }
        }
        return Response.json(clock.state())
      }
      return Response.json(
        {
          error: {
            type: "mockingbird_unsupported",
            message: "Use the engine API inside fleet.run; this participant has no HTTP vendor API",
          },
        },
        { status: 501 },
      )
    },
    dispose() {
      for (const current of values.values()) codec.dispose?.(current)
      values.clear()
      named.clear()
    },
  }
  return runtime
}

type PostgresSnapshot<T> = { encode(): Uint8Array; openWithClock(now: () => Date): T }
type PostgresValue<T> = {
  query(sql: string): Record<string, unknown>[]
  snapshot(): PostgresSnapshot<T>
  close(): void
}

/** `decode` is the public PostgreSQL Snapshot.decode; the fleet imports no SQL engine eagerly. */
export function postgresParticipant<T extends PostgresValue<T>>(options: {
  create(namespace: string): T
  decode(bytes: Uint8Array): PostgresSnapshot<T>
  database?: string
}) {
  const clocks = new WeakMap<object, Clock>()
  const clockOf = (value: T) => {
    const clock = clocks.get(value)
    if (!clock) throw new Error("unknown Postgres participant clock")
    return clock
  }
  const open = (point: PostgresSnapshot<T>, state: { now: number; frozen: boolean }) => {
    const clock = createClock()
    restoreClock(clock, state)
    const value = point.openWithClock(() => new Date(clock.now()))
    clocks.set(value, clock)
    return value
  }
  return snapshotParticipant({
    create: (namespace) => {
      const original = options.create(namespace)
      try {
        return open(original.snapshot(), { now: postgresTime(original), frozen: true })
      } finally {
        original.close()
      }
    },
    snapshot: (value) => {
      const { now, frozen } = clockOf(value).state()
      return { snapshot: value.snapshot(), clock: { now, frozen } }
    },
    restore: (_value, point) => open(point.snapshot, point.clock),
    encode: (_value, point) => ({
      format: "mockingbird.postgres/v1",
      databases: [
        { name: options.database ?? "postgres", bytes: bytesToBase64(point.snapshot.encode()) },
      ],
      clock: point.clock,
      faults: {},
    }),
    decode: (_value, document) => {
      const doc = document as {
        format?: unknown
        databases?: { name: string; bytes: string }[]
        clock?: { now: number; frozen: boolean }
        faults?: Record<string, unknown>
      }
      if (
        doc?.format !== "mockingbird.postgres/v1" ||
        !Array.isArray(doc.databases) ||
        doc.databases.length !== 1 ||
        doc.databases[0]?.name !== (options.database ?? "postgres") ||
        typeof doc.databases[0].bytes !== "string" ||
        !doc.clock ||
        !Number.isFinite(doc.clock.now) ||
        typeof doc.clock.frozen !== "boolean" ||
        (doc.faults && Object.keys(doc.faults).length > 0)
      )
        throw new Error("incompatible Postgres participant archive")
      return { snapshot: options.decode(base64ToBytes(doc.databases[0].bytes)), clock: doc.clock }
    },
    clock: clockOf,
    dispose: (value) => value.close(),
  })
}

type RedisValue = {
  clock: Clock
  close(): void
  snapshot(): object
  exportSnapshot(point: unknown): unknown
  importSnapshot(document: unknown): object
  restore(point: unknown): void
}
export function redisParticipant<T extends RedisValue>(create: (namespace: string) => T) {
  return snapshotParticipant({
    create,
    snapshot: (value) => value.snapshot(),
    restore: (value, point) => {
      value.restore(point)
      return value
    },
    encode: (value, point) => value.exportSnapshot(point),
    decode: (value, document) => value.importSnapshot(document),
    clock: (value) => value.clock,
    dispose: (value) => value.close(),
  })
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (let start = 0; start < bytes.length; start += 16384)
    binary += String.fromCharCode(...bytes.subarray(start, start + 16384))
  return btoa(binary)
}
function base64ToBytes(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("invalid Postgres archive bytes")
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function postgresTime(value: { query(sql: string): Record<string, unknown>[] }) {
  const timestamp = value.query("SELECT now() AS now")[0]?.now
  if (timestamp instanceof Date) return timestamp.getTime()
  if (typeof timestamp === "string") {
    const result = Date.parse(timestamp)
    if (Number.isFinite(result)) return result
  }
  throw new Error("Postgres clock query did not return a timestamp")
}

/** Aggregate independently mounted runtimes using their own namespace checkpoint codecs. */
export function mountedParticipant<
  T extends {
    mounts: ReadonlyMap<string, InProcessRuntime>
    fetch(request: Request): Promise<Response>
    reset(namespace?: string): Promise<void>
  },
>(mounted: T) {
  const adapter = snapshotParticipant({
    create: (namespace: string) => ({ mounted, namespace }),
    snapshot: ({ mounted: value, namespace }) =>
      Object.fromEntries(
        [...value.mounts].map(([path, runtime]) => [
          path,
          runtime.fleetExport(runtime.fleetSnapshot(namespace)),
        ]),
      ),
    encode: (_value, point) => ({ format: "mockingbird.mounts/v1", mounts: point }),
    decode: ({ mounted: value, namespace }, document) => {
      const doc = document as { format?: unknown; mounts?: Record<string, unknown> }
      if (
        doc?.format !== "mockingbird.mounts/v1" ||
        !doc.mounts ||
        typeof doc.mounts !== "object" ||
        Array.isArray(doc.mounts) ||
        [...new Set([...value.mounts.keys(), ...Object.keys(doc.mounts)])].some(
          (path) => !value.mounts.has(path) || !(path in (doc.mounts ?? {})),
        )
      )
        throw new Error("mounted runtime compatibility mismatch")
      for (const [path, runtime] of value.mounts) runtime.fleetImport(namespace, doc.mounts[path])
      return structuredClone(doc.mounts)
    },
    restore: (value, point) => {
      for (const [path, runtime] of value.mounted.mounts)
        runtime.fleetRestore(runtime.fleetImport(value.namespace, point[path]), value.namespace)
      return value
    },
  })
  return {
    ...adapter,
    fetch: (request: Request) => {
      if (new URL(request.url).pathname === "/__admin/clock" && request.method === "GET") {
        const first = mounted.mounts.values().next().value
        if (first) return first.fetch(request)
      }
      return mounted.fetch(request)
    },
    namespaces: () => [
      ...new Set([...mounted.mounts.values()].flatMap((runtime) => runtime.namespaces())),
    ],
    async reset(namespace = "default") {
      await mounted.reset(namespace)
      await adapter.reset(namespace)
    },
    async dropNamespace(namespace: string) {
      for (const runtime of mounted.mounts.values()) await runtime.dropNamespace(namespace)
      await adapter.dropNamespace(namespace)
    },
  }
}
