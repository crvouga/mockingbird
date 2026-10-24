import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { IDBFactory, IDBObjectStore } from "fake-indexeddb"
import {
  type DurabilityBackend,
  DurabilityConflictError,
  type DurablePatch,
  MemoryDurabilityBackend,
  openDurable,
  withDurability,
} from "./src/durability.js"
import {
  IndexedDBDurabilityBackend,
  LocalStorageDurabilityBackend,
} from "./src/durability-browser.js"

const codec = {
  create: () => ({ bytes: new Uint8Array() }),
  decode: (bytes: Uint8Array) => ({ bytes: bytes.slice() }),
  encode: (value: { bytes: Uint8Array }) => value.bytes,
}

function storage() {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

const adapters = {
  memory: () => new MemoryDurabilityBackend(),
  indexedDB: () => new IndexedDBDurabilityBackend({ indexedDB: new IDBFactory() }),
  localStorage: () => new LocalStorageDurabilityBackend({ storage: storage() }),
}

for (const [name, create] of Object.entries(adapters)) {
  describe(name, () => {
    test("recovers growth, tail truncation, empty images and page size changes", async () => {
      const backend = create()
      for (const pageSize of [4, 7, 1, 16]) {
        const handle = await openDurable({ backend, key: "image", codec, pageSize })
        for (const length of [0, 15, 16, 17, 32, 9, 8, 3, 0, 4]) {
          handle.value.bytes = Uint8Array.from({ length }, (_, i) => (i * 17) % 256)
          await handle.flush()
          const reopened = await openDurable({ backend, key: "image", codec, pageSize })
          expect(reopened.value.bytes).toEqual(handle.value.bytes)
        }
        await handle.close()
      }
      if (backend instanceof IndexedDBDurabilityBackend) await backend.close()
    })

    test("rejects stale writers without overwriting the saved image", async () => {
      const backend = create()
      const a = await openDurable({ backend, key: "image", codec })
      const b = await openDurable({ backend, key: "image", codec })
      a.value.bytes = new Uint8Array([1, 2, 3])
      b.value.bytes = new Uint8Array([4, 5, 6])
      await a.flush()
      await expect(b.flush()).rejects.toBeInstanceOf(DurabilityConflictError)
      expect((await backend.load("image"))?.bytes).toEqual(a.value.bytes)
      if (backend instanceof IndexedDBDurabilityBackend) await backend.close()
    })

    test("isolates keys and rejects invalid pages before writing", async () => {
      const backend = create()
      const a = await openDurable({ backend, key: "a", codec })
      const b = await openDurable({ backend, key: "b", codec })
      await a.write((value) => {
        value.bytes = new Uint8Array([42])
      })
      await b.write((value) => {
        value.bytes = new Uint8Array([99])
      })
      await expect(
        backend.commit("a", 1, {
          byteLength: 1,
          pageSize: 1,
          pages: [{ index: 2, bytes: new Uint8Array([0]) }],
        }),
      ).rejects.toThrow()
      expect((await backend.load("a"))?.bytes[0]).toBe(42)
      expect((await backend.load("b"))?.bytes[0]).toBe(99)
      if (backend instanceof IndexedDBDurabilityBackend) await backend.close()
    })
  })
}

test("only changed pages reach the backend; unchanged saves do not write", async () => {
  const memory = new MemoryDurabilityBackend()
  const patches: DurablePatch[] = []
  const backend: DurabilityBackend = {
    load: (key) => memory.load(key),
    commit: (key, revision, patch) => {
      patches.push(patch)
      return memory.commit(key, revision, patch)
    },
  }
  const handle = await openDurable({ backend, key: "image", codec, pageSize: 4 })
  handle.value.bytes = new Uint8Array(12).fill(1)
  await handle.flush()
  await handle.flush()
  expect(patches).toHaveLength(1)
  handle.value.bytes[5] = 2
  await handle.flush()
  expect(patches[1]?.pages.map((page) => page.index)).toEqual([1])
  // Reused codec output buffers cannot mutate the comparison baseline.
  handle.value.bytes[9] = 3
  await handle.flush()
  expect(patches[2]?.pages.map((page) => page.index)).toEqual([2])
})

test("IndexedDB stores compact pages rather than cloning each view's full backing image", async () => {
  const backend = new IndexedDBDurabilityBackend({ indexedDB: new IDBFactory() })
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 251)
  const sizes: number[] = []
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === "pages") {
      const page = value as { bytes: Uint8Array }
      expect(page.bytes.byteOffset).toBe(0)
      expect(page.bytes.buffer.byteLength).toBe(page.bytes.byteLength)
      sizes.push(page.bytes.buffer.byteLength)
    }
    return put.call(this, value, key)
  }
  try {
    await backend.commit("compact", 0, {
      byteLength: bytes.length,
      pageSize: 16_384,
      pages: Array.from({ length: 64 }, (_, index) => ({
        index,
        bytes: bytes.subarray(index * 16_384, (index + 1) * 16_384),
      })),
    })
    expect(sizes).toHaveLength(64)
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(bytes.length)
    expect((await backend.load("compact"))?.bytes).toEqual(bytes)
  } finally {
    IDBObjectStore.prototype.put = put
    await backend.close()
  }
})

test("failed saves and failed close can be retried without advancing revision", async () => {
  const memory = new MemoryDurabilityBackend()
  let fail = true
  let closed = 0
  const backend: DurabilityBackend = {
    load: (key) => memory.load(key),
    commit: (key, revision, patch) => {
      if (fail) return Promise.reject(new Error("quota"))
      return memory.commit(key, revision, patch)
    },
  }
  const handle = await openDurable({
    backend,
    key: "image",
    codec: {
      ...codec,
      close: () => {
        closed++
      },
    },
  })
  handle.value.bytes = new Uint8Array([1])
  await expect(handle.close()).rejects.toThrow("quota")
  expect(closed).toBe(0)
  fail = false
  await handle.flush()
  await handle.close()
  await handle.close()
  expect(closed).toBe(1)
  await expect(handle.flush()).rejects.toThrow("closed")
})

test("sparse saves copy only changed encoded pages and unchanged saves copy none", async () => {
  const backend = new MemoryDurabilityBackend()
  const handle = await openDurable({ backend, key: "copies", codec })
  let allocated = 0
  class ObservedBytes extends Uint8Array {
    constructor(lengthOrBuffer: number | ArrayBuffer, byteOffset?: number, length?: number) {
      if (typeof lengthOrBuffer === "number") {
        super(lengthOrBuffer)
        allocated += lengthOrBuffer
      } else super(lengthOrBuffer, byteOffset, length)
    }
  }
  const bytes = new ObservedBytes(1024 * 1024)
  handle.value.bytes = bytes
  await handle.flush()
  allocated = 0
  await handle.flush()
  expect(allocated).toBe(0)
  bytes[bytes.length - 1] = 1
  await handle.flush()
  expect(allocated).toBe(16_384)
  expect((await backend.load("copies"))?.bytes).toEqual(new Uint8Array(bytes))
  await handle.close()
})

for (const pageSize of [7, 100]) {
  test(`unaligned codec buffers cannot mutate an in-flight save (pageSize=${pageSize})`, async () => {
    const memory = new MemoryDurabilityBackend()
    let pause = false
    let resume: () => void = () => {}
    let started: () => void = () => {}
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      resume = resolve
    })
    const backend: DurabilityBackend = {
      load: (key) => memory.load(key),
      async commit(key, revision, patch) {
        if (pause) {
          started()
          await waiting
        }
        return memory.commit(key, revision, patch)
      },
    }
    const handle = await openDurable({ backend, key: "pending", codec, pageSize })
    // Buffer's slice() aliases its storage; this is also deliberately unaligned.
    handle.value.bytes = Buffer.alloc(66).subarray(1, 65)
    await handle.flush()
    pause = true
    handle.value.bytes[2] = 10
    const first = handle.flush()
    await entered
    handle.value.bytes[2] = 20
    handle.value.bytes[60] = 30
    resume()
    await first
    const saved = (await memory.load("pending"))?.bytes
    expect(saved?.[2]).toBe(10)
    expect(saved?.[60]).toBe(0)
    await handle.flush()
    expect((await memory.load("pending"))?.bytes).toEqual(new Uint8Array(handle.value.bytes))
    await handle.close()
  })
}

test("serializes concurrent durable batches and acknowledges each saved result", async () => {
  const backend = new MemoryDurabilityBackend()
  const handle = await openDurable({ backend, key: "image", codec })
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      handle.write((value) => {
        value.bytes = new Uint8Array([index])
        return index
      }),
    ),
  )
  expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i))
  expect((await backend.load("image"))?.bytes).toEqual(new Uint8Array([19]))
})

test("localStorage quota failure leaves the prior committed image intact", async () => {
  const data = storage()
  let fail = false
  const backend = new LocalStorageDurabilityBackend({
    storage: {
      ...data,
      setItem: (key, value) => {
        if (fail) throw new Error("quota")
        data.setItem(key, value)
      },
    },
  })
  const handle = await openDurable({ backend, key: "image", codec })
  await handle.write((value) => {
    value.bytes = new Uint8Array([1])
  })
  fail = true
  await expect(
    handle.write((value) => {
      value.bytes = new Uint8Array([2])
    }),
  ).rejects.toThrow("quota")
  expect((await backend.load("image"))?.bytes).toEqual(new Uint8Array([1]))
  fail = false
  await handle.flush()
  expect((await backend.load("image"))?.bytes).toEqual(new Uint8Array([2]))
})

test("Fetch responses wait for storage and subsequent requests cannot overtake a save", async () => {
  const events: string[] = []
  const api = withDurability(
    {
      fetch: async (request: Request) => {
        events.push(new URL(request.url).pathname)
        return new Response("ok")
      },
    },
    {
      flush: async () => {
        events.push("save")
        await Promise.resolve()
        events.push("commit")
      },
    },
  )
  const [a, b] = await Promise.all([
    api.fetch(new Request("https://test/one")),
    api.fetch(new Request("https://test/two")),
  ])
  expect(events).toEqual(["/one", "save", "commit", "/two", "save", "commit"])
  expect(a.status).toBe(200)
  expect(b.status).toBe(200)
  const failing = withDurability(
    { fetch: async () => new Response("ok") },
    { flush: () => Promise.reject(new Error("quota")) },
  )
  await expect(failing.fetch(new Request("https://test/"))).rejects.toThrow("quota")
})

test("reopening with a different page size rewrites the same nonempty image correctly", async () => {
  const backend = new IndexedDBDurabilityBackend({ indexedDB: new IDBFactory() })
  const first = await openDurable({ backend, key: "image", codec, pageSize: 2 })
  await first.write((value) => {
    value.bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
  })
  for (const pageSize of [3, 1, 16, 4]) {
    const handle = await openDurable({ backend, key: "image", codec, pageSize })
    await handle.flush()
    expect((await backend.load("image"))?.bytes).toEqual(first.value.bytes)
  }
  await backend.close()
})

test("IndexedDB serializes simultaneous writers across separate connections", async () => {
  const factory = new IDBFactory()
  const a = new IndexedDBDurabilityBackend({ indexedDB: factory })
  const b = new IndexedDBDurabilityBackend({ indexedDB: factory })
  const patch = { byteLength: 1, pageSize: 1, pages: [{ index: 0, bytes: new Uint8Array([7]) }] }
  const attempts = await Promise.allSettled([
    a.commit("image", 0, patch),
    b.commit("image", 0, patch),
  ])
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1)
  expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1)
  expect((await b.load("image"))?.revision).toBe(1)
  await a.close()
  await b.close()
})

test("an IndexedDB request failure aborts all pages and metadata, then permits retry", async () => {
  const backend = new IndexedDBDurabilityBackend({ indexedDB: new IDBFactory() })
  const handle = await openDurable({ backend, key: "image", codec, pageSize: 2 })
  await handle.write((value) => {
    value.bytes = new Uint8Array([1, 2, 3, 4])
  })
  handle.value.bytes = new Uint8Array([5, 6, 7, 8])
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "images") throw new Error("simulated quota after page writes")
    return put.apply(this, args)
  }
  try {
    await expect(handle.flush()).rejects.toThrow("simulated quota")
  } finally {
    IDBObjectStore.prototype.put = put
  }
  expect((await backend.load("image"))?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
  await handle.flush()
  expect((await backend.load("image"))?.bytes).toEqual(new Uint8Array([5, 6, 7, 8]))
  await backend.close()
})

test("adapters reject incomplete replacement images instead of saving missing pages", async () => {
  for (const create of Object.values(adapters)) {
    const backend = create()
    await expect(
      backend.commit("image", 0, {
        byteLength: 4,
        pageSize: 2,
        pages: [{ index: 0, bytes: new Uint8Array([1, 2]) }],
      }),
    ).rejects.toThrow("Missing durable page")
    expect(await backend.load("image")).toBeUndefined()
    if (backend instanceof IndexedDBDurabilityBackend) await backend.close()
  }
})

test("word-wise dirty-page comparison preserves every byte at aligned and unaligned boundaries", async () => {
  for (const pageSize of [1, 3, 4, 7, 16, 31, 16_384]) {
    const backend = new MemoryDurabilityBackend()
    const handle = await openDurable({ backend, key: "words", codec, pageSize })
    handle.value.bytes = Uint8Array.from({ length: 257 }, (_, index) => index % 256)
    await handle.flush()
    for (let offset = 0; offset < handle.value.bytes.length; offset++) {
      handle.value.bytes[offset] = (handle.value.bytes[offset] ?? 0) ^ 0xa5
      await handle.flush()
      expect((await backend.load("words"))?.bytes).toEqual(handle.value.bytes)
    }
    await handle.close()
  }
})
