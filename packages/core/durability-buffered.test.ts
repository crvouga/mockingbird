import { expect, test } from "bun:test"
import {
  type DurabilityBackend,
  DurabilityConflictError,
  MemoryDurabilityBackend,
} from "./src/durability.js"
import {
  type BufferedDurabilityObserver,
  type DurabilityScheduler,
  type IncrementalDurabilityCodec,
  openBufferedDurable,
  readDurableJournal,
} from "./src/durability-buffered.js"

class Scheduler implements DurabilityScheduler {
  now = 0
  next = 0
  tasks = new Map<number, { at: number; run: () => void }>()
  schedule(run: () => void, delay: number) {
    const id = ++this.next
    this.tasks.set(id, { at: this.now + delay, run })
    return id
  }
  cancel(id: unknown) {
    this.tasks.delete(id as number)
  }
  advance(ms: number) {
    this.now += ms
    for (const [id, task] of this.tasks)
      if (task.at <= this.now) {
        this.tasks.delete(id)
        task.run()
      }
  }
}
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture")
  return value
}
const bytes = (n: number) => new TextEncoder().encode(String(n))
class State {
  n = 0
  busy = false
  observer: BufferedDurabilityObserver | undefined
  set(n: number) {
    this.observer?.assertWritable()
    this.n = n
    this.observer?.changed()
  }
}
function codec(): IncrementalDurabilityCodec<State, number> {
  const decode = (data: Uint8Array) =>
    Object.assign(new State(), { n: Number(new TextDecoder().decode(data)) })
  return {
    create: () => new State(),
    decode,
    encode: (value) => bytes(value.n),
    decodeJournal: (records) => decode(must(records.at(-1))),
    canCapture: (state) => !state.busy,
    capture(state, previous, checkpoint) {
      if (state.busy) throw new Error("transaction")
      return {
        checkpoint: checkpoint || previous === undefined,
        token: state.n,
        ...(previous !== state.n || checkpoint ? { bytes: bytes(state.n) } : {}),
      }
    },
    acknowledge() {},
    subscribe(state, observer) {
      state.observer = observer
      return () => {
        state.observer = undefined
      }
    },
  }
}
const settle = () => Bun.sleep(0)

test("first-change deadline coalesces writes and explicit flush drains storage", async () => {
  const scheduler = new Scheduler()
  const backend = new MemoryDurabilityBackend()
  const handle = await openBufferedDurable({ key: "t", backend, codec: codec(), scheduler })
  handle.value.set(1)
  scheduler.advance(800)
  handle.value.set(2)
  expect(scheduler.tasks.size).toBe(1)
  scheduler.advance(199)
  await settle()
  expect(await backend.load("t")).toBeUndefined()
  scheduler.advance(1)
  await settle()
  expect(handle.pending).toBe(false)
  expect(readDurableJournal(must(await backend.load("t")).bytes)?.length).toBe(1)
  handle.value.set(3)
  await handle.flush()
  expect(handle.pending).toBe(false)
  expect((await backend.load("t"))?.revision).toBe(2)
  await handle.close()
  expect(scheduler.tasks.size).toBe(0)
})

test("writes during an in-flight commit survive acknowledgement and checksums fail closed", async () => {
  const memory = new MemoryDurabilityBackend()
  let release: (() => void) | undefined
  let block = false
  const backend: DurabilityBackend = {
    load: (key) => memory.load(key),
    async commit(key, revision, patch) {
      if (block)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return memory.commit(key, revision, patch)
    },
  }
  const handle = await openBufferedDurable({
    key: "t",
    backend,
    codec: codec(),
    scheduler: new Scheduler(),
    pageSize: 37,
  })
  await handle.flush()
  block = true
  handle.value.set(1)
  const first = handle.flush()
  await settle()
  handle.value.set(2)
  must(release)()
  block = false
  await first
  expect(handle.pending).toBe(true)
  await handle.flush()
  const reopened = await openBufferedDurable({
    key: "t",
    backend,
    codec: codec(),
    scheduler: new Scheduler(),
    pageSize: 37,
  })
  expect(reopened.value.n).toBe(2)
  const image = must(await memory.load("t")).bytes
  image[image.length - 1] = (image[image.length - 1] ?? 0) ^ 1
  expect(() => readDurableJournal(image)).toThrow("Invalid buffered")
  await reopened.close()
  await handle.close()
})

test("transient errors retain pending state, retry, and conflicting writers stop", async () => {
  const memory = new MemoryDurabilityBackend()
  const scheduler = new Scheduler()
  let fail = true
  const observed: unknown[] = []
  const backend: DurabilityBackend = {
    load: (key) => memory.load(key),
    commit(key, revision, patch) {
      if (fail) return Promise.reject(new Error("quota"))
      return memory.commit(key, revision, patch)
    },
  }
  const a = await openBufferedDurable({
    key: "t",
    backend,
    codec: codec(),
    scheduler,
    onError: (error) => observed.push(error),
  })
  a.value.set(7)
  scheduler.advance(1000)
  await settle()
  expect(String(a.lastError)).toContain("quota")
  expect(a.pending).toBe(true)
  expect(observed.length).toBe(1)
  fail = false
  scheduler.advance(1000)
  await settle()
  expect(a.pending).toBe(false)
  expect(a.lastError).toBeUndefined()
  const b = await openBufferedDurable({
    key: "t",
    backend,
    codec: codec(),
    scheduler: new Scheduler(),
  })
  a.value.set(8)
  await a.flush()
  b.value.set(9)
  await expect(b.flush()).rejects.toBeInstanceOf(DurabilityConflictError)
  await expect(b.flush()).rejects.toBeInstanceOf(DurabilityConflictError)
  expect(b.pending).toBe(true)
  await a.close()
})

test("busy transactions defer timers; compaction and legacy migration recover", async () => {
  const scheduler = new Scheduler()
  const memory = new MemoryDurabilityBackend()
  await memory.commit("t", 0, {
    byteLength: 1,
    pageSize: 64,
    pages: [{ index: 0, bytes: bytes(5) }],
  })
  const handle = await openBufferedDurable({
    key: "t",
    backend: memory,
    codec: codec(),
    scheduler,
    pageSize: 64,
    compactAfterBatches: 2,
  })
  expect(handle.value.n).toBe(5)
  handle.value.busy = true
  scheduler.advance(1000)
  await settle()
  expect((await memory.load("t"))?.revision).toBe(1)
  handle.value.busy = false
  await handle.flush()
  for (let n = 6; n <= 8; n++) {
    handle.value.set(n)
    await handle.flush()
  }
  expect(readDurableJournal(must(await memory.load("t")).bytes)?.length).toBe(1)
  const reopened = await openBufferedDurable({
    key: "t",
    backend: memory,
    codec: codec(),
    scheduler: new Scheduler(),
  })
  expect(reopened.value.n).toBe(8)
  await reopened.close()
  await handle.close()
})

test("close waits for queued writes, rejects later mutations and removes lifecycle hooks", async () => {
  let suspended: (() => void) | undefined
  let stopped = false
  const handle = await openBufferedDurable({
    key: "t",
    backend: new MemoryDurabilityBackend(),
    codec: codec(),
    scheduler: new Scheduler(),
    lifecycle: {
      subscribe(run) {
        suspended = run
        return () => {
          stopped = true
        }
      },
    },
  })
  const write = handle.write((state) => state.set(1))
  const close = handle.close()
  expect(() => handle.value.set(2)).toThrow("closed")
  await write
  await close
  expect(stopped).toBe(true)
  expect(suspended).toBeDefined()
  expect(() => handle.value.set(3)).not.toThrow() // Generic state owns its post-close API; SQL databases reject it.
})

test("independent engine close stops background work and reports unacknowledged state", async () => {
  const scheduler = new Scheduler()
  let released = 0
  const adapter = codec()
  adapter.close = () => {
    released++
  }
  const handle = await openBufferedDurable({
    key: "t",
    backend: new MemoryDurabilityBackend(),
    codec: adapter,
    scheduler,
  })
  handle.value.set(7)
  handle.value.observer?.closed?.()
  await settle()
  expect(scheduler.tasks.size).toBe(0)
  expect(released).toBe(1)
  expect(String(handle.lastError)).toContain("not acknowledged")
  await expect(handle.close()).rejects.toThrow("not acknowledged")
})
