import { describe, expect, test } from "bun:test"
import {
  createLivePreview,
  isChunkLoadFailure,
  LIVE_PREVIEW_STORAGE_KEY,
  type LiveBuildState,
  type LivePreviewOptions,
  type PreviewVersion,
} from "./src/live.js"
import type { PreviewStatusSnapshot } from "./src/preview-status.js"

const ORIGIN = "https://lab-pr-12.example.workers.dev"
const T0 = Date.parse("2026-11-20T12:00:00Z")
const V1: PreviewVersion = {
  version: "1".repeat(40),
  builtAt: "2026-11-20T11:00:00.000Z",
  entry: "/app-1.js",
}
const V2: PreviewVersion = {
  version: "2".repeat(40),
  builtAt: "2026-11-20T12:00:00.000Z",
  entry: "/app-2.js",
}
const V3: PreviewVersion = {
  version: "3".repeat(40),
  builtAt: "2026-11-20T12:30:00.000Z",
  entry: "/app-3.js",
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A deterministic clock: timers run only when `advance` passes them. */
const fakeClock = () => {
  let now = T0
  let nextId = 1
  const pending = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    timers: {
      setTimeout: (run: () => void, ms: number) => {
        const id = nextId++
        pending.set(id, { at: now + ms, run })
        return id
      },
      clearTimeout: (id: unknown) => {
        pending.delete(id as number)
      },
    },
    pendingCount: () => pending.size,
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= end)
          .sort(([a, x], [b, y]) => x.at - y.at || a - b)[0]
        if (due === undefined) break
        pending.delete(due[0])
        now = due[1].at
        due[1].run()
        await flush()
      }
      now = end
      await flush()
    },
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  closed = false
  listeners = new Map<string, Set<(event: { data?: unknown }) => void>>()
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(listener)
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  #dispatch(type: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  open() {
    this.readyState = 1
    this.#dispatch("open")
  }
  snapshot(snapshot: Partial<PreviewStatusSnapshot>) {
    this.#dispatch("snapshot", {
      data: JSON.stringify({
        updatedAt: new Date(T0).toISOString(),
        source: "ci",
        ...snapshot,
      }),
    })
  }
  /** A dropped stream EventSource will retry by itself. */
  error() {
    this.readyState = 0
    this.#dispatch("error")
  }
  /** A failure EventSource will not retry (HTTP error, wrong content type). */
  fail() {
    this.readyState = 2
    this.#dispatch("error")
  }
}

class FakeTarget {
  hidden = false
  listeners = new Map<string, Set<(event: unknown) => void>>()
  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(listener)
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  count() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0)
  }
}

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

type Served = { version: PreviewVersion | "fail"; status: PreviewStatusSnapshot | "fail" }

const harness = (overrides: Partial<LivePreviewOptions> = {}) => {
  FakeEventSource.instances = []
  const clock = fakeClock()
  const served: Served = {
    version: V1,
    status: { updatedAt: new Date(T0).toISOString(), source: "ci" },
  }
  const requests: string[] = []
  const loads: string[] = []
  const disposed: string[] = []
  const failLoad = new Set<string>()
  const doc = new FakeTarget()
  const win = new FakeTarget()
  const storage = memoryStorage()
  const fetchFake = async (input: string | URL | Request) => {
    const href = String(input)
    requests.push(new URL(href).pathname)
    const path = new URL(href).pathname
    if (path === "/version.json") {
      if (served.version === "fail") throw new TypeError("network")
      return Response.json(served.version)
    }
    if (path === "/__preview/status") {
      if (served.status === "fail") return new Response("down", { status: 503 })
      return Response.json(served.status)
    }
    return new Response("not found", { status: 404 })
  }
  const live = createLivePreview({
    current: V1,
    origin: ORIGIN,
    now: clock.now,
    timers: clock.timers,
    document: doc,
    window: win,
    storage,
    EventSource: FakeEventSource,
    fetch: fetchFake as typeof fetch,
    load: async (version) => {
      loads.push(version.version)
      if (failLoad.has(version.version)) throw new Error(`boom ${version.entry}`)
      return () => {
        disposed.push(version.version)
      }
    },
    ...overrides,
  })
  const states: LiveBuildState[] = []
  live.subscribe((state) => states.push(state))
  const socket = () => FakeEventSource.instances.at(-1) as FakeEventSource
  return {
    live,
    clock,
    served,
    requests,
    loads,
    disposed,
    failLoad,
    doc,
    win,
    storage,
    states,
    socket,
  }
}

const deployedSnapshot = (
  version: PreviewVersion,
  at = version.builtAt,
): Partial<PreviewStatusSnapshot> => ({
  build: { kind: "build", state: "deployed", version: version.version, at },
  deployed: { version: version.version, at },
})

describe("createLivePreview", () => {
  test("keeps the fetch it was created with when a loaded app replaces the global", async () => {
    // The lab's app installs a browser runtime that routes fetch to in-page servers; status and
    // version checks made after that must still reach the network (seen in a real preview).
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(new URL(String(input)).pathname)
      return Response.json(V1)
    }) as typeof fetch
    try {
      const clock = fakeClock()
      const live = createLivePreview({
        current: V1,
        origin: ORIGIN,
        now: clock.now,
        timers: clock.timers,
        document: new FakeTarget(),
        window: new FakeTarget(),
        storage: memoryStorage(),
        EventSource: FakeEventSource,
        load: async () => {
          globalThis.fetch = (async () => {
            throw new Error("the app's runtime fetch")
          }) as unknown as typeof fetch
          return () => {}
        },
      })
      await live.start()
      expect(seen).toEqual(["/version.json"])
      expect(live.get().update.available).toBe(false)
      live.close()
    } finally {
      globalThis.fetch = original
    }
  })

  test("start mounts current, connects, and maps the snapshot", async () => {
    const h = harness({ pr: { number: 12, url: "https://github.com/crvouga/mockingbird/pull/12" } })
    await h.live.start()
    expect(h.loads).toEqual([V1.version])
    expect(h.socket().url).toBe("https://lab-pr-12.example.workers.dev/__preview/live")
    expect(h.requests).toContain("/version.json")
    expect(h.live.get().connection).toBe("polling") // version.json answered; stream not open yet
    h.socket().open()
    h.socket().snapshot({
      build: {
        kind: "build",
        state: "building",
        version: V2.version,
        at: "2026-11-20T12:00:00.000Z",
        runUrl: "https://github.com/r/1",
      },
      deployed: { version: V1.version, at: V1.builtAt },
      checks: {
        kind: "checks",
        state: "running",
        version: V2.version,
        at: "2026-11-20T12:00:01.000Z",
        summary: "3 of 14 passed",
      },
    })
    const state = h.live.get()
    expect(state).toEqual({
      current: { version: V1.version, builtAt: V1.builtAt },
      latest: { version: V1.version, at: V1.builtAt },
      build: {
        state: "building",
        version: V2.version,
        at: "2026-11-20T12:00:00.000Z",
        url: "https://github.com/r/1",
      },
      checks: {
        state: "running",
        version: V2.version,
        at: "2026-11-20T12:00:01.000Z",
        summary: "3 of 14 passed",
      },
      connection: "live",
      checkedAt: new Date(T0).toISOString(),
      update: { available: false, applying: false, auto: true },
      pr: { number: 12, url: "https://github.com/crvouga/mockingbird/pull/12" },
    })
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.update)).toBe(true)
    h.live.close()
  })

  test("uses the snapshot's PR when none is given", async () => {
    const h = harness({ origin: "http://localhost:8787" })
    await h.live.start()
    expect(h.socket().url).toBe("http://localhost:8787/__preview/live")
    h.socket().open()
    h.socket().snapshot({ pr: { number: 3, url: "https://github.com/o/r/pull/3" } })
    expect(h.live.get().pr).toEqual({ number: 3, url: "https://github.com/o/r/pull/3" })
    h.live.close()
  })

  test("stays live across the server's periodic stream close, and does not poll", async () => {
    const h = harness()
    await h.live.start()
    h.socket().open()
    h.socket().snapshot({})
    h.socket().error() // the server ended the stream after maxMs; EventSource reopens it
    expect(h.live.get().connection).toBe("live")
    h.socket().open()
    h.socket().snapshot({})
    await h.clock.advance(120_000)
    expect(h.requests.filter((p) => p === "/__preview/status").length).toBe(0)
    expect(FakeEventSource.instances.length).toBe(1)
    h.live.close()
  })

  test("falls back to polling after 3 errors without a snapshot", async () => {
    const h = harness()
    await h.live.start()
    h.socket().open()
    h.socket().error()
    h.socket().error()
    expect(h.live.get().connection).toBe("polling")
    expect(h.socket().closed).toBe(false)
    expect(h.requests.filter((p) => p === "/__preview/status").length).toBe(0)
    h.socket().error()
    expect(h.socket().closed).toBe(true)
    await h.clock.advance(0)
    expect(h.requests.filter((p) => p === "/__preview/status").length).toBe(1)
    expect(h.live.get().connection).toBe("polling")
    h.live.close()
  })

  test("a snapshot resets the error count", async () => {
    const h = harness()
    await h.live.start()
    h.socket().error()
    h.socket().error()
    h.socket().open()
    h.socket().snapshot({})
    h.socket().error()
    h.socket().error()
    expect(h.socket().closed).toBe(false)
    h.live.close()
  })

  test("falls back at once when EventSource gives up", async () => {
    const h = harness()
    await h.live.start()
    h.socket().fail()
    expect(h.socket().closed).toBe(true)
    await h.clock.advance(0)
    expect(h.requests.filter((p) => p === "/__preview/status").length).toBe(1)
    h.live.close()
  })

  test("polls without EventSource: 30 s idle, 5 s while building", async () => {
    const h = harness({ EventSource: null })
    await h.live.start()
    expect(FakeEventSource.instances.length).toBe(0)
    const count = () => h.requests.filter((p) => p === "/__preview/status").length
    expect(count()).toBe(1)
    await h.clock.advance(29_999)
    expect(count()).toBe(1)
    await h.clock.advance(1)
    expect(count()).toBe(2)
    h.served.status = {
      build: { kind: "build", state: "building", version: V2.version, at: V2.builtAt },
      source: "ci",
      updatedAt: new Date(T0).toISOString(),
    }
    await h.clock.advance(30_000)
    expect(count()).toBe(3)
    expect(h.live.get().build?.state).toBe("building")
    await h.clock.advance(5_000)
    expect(count()).toBe(4)
    await h.clock.advance(5_000)
    expect(count()).toBe(5)
    h.live.close()
    expect(h.clock.pendingCount()).toBe(0)
  })

  test("polls four times slower while hidden and at once on becoming visible", async () => {
    const h = harness({ EventSource: null })
    await h.live.start()
    const count = () => h.requests.filter((p) => p === "/__preview/status").length
    h.doc.hidden = true
    await h.clock.advance(30_000) // the timer set while visible
    expect(count()).toBe(2)
    await h.clock.advance(119_999)
    expect(count()).toBe(2)
    await h.clock.advance(1)
    expect(count()).toBe(3)
    h.doc.hidden = false
    h.doc.dispatch("visibilitychange")
    await flush()
    expect(count()).toBe(4)
    await h.clock.advance(30_000)
    expect(count()).toBe(5)
    h.live.close()
  })

  test("retries the stream every 60 s while polling and returns to live when it opens", async () => {
    const h = harness()
    await h.live.start()
    h.socket().fail()
    await h.clock.advance(0)
    expect(h.live.get().connection).toBe("polling")
    await h.clock.advance(60_000)
    expect(FakeEventSource.instances.length).toBe(2)
    h.socket().fail() // still down: keep polling, try again in a minute
    await h.clock.advance(60_000)
    expect(FakeEventSource.instances.length).toBe(3)
    h.socket().open()
    expect(h.live.get().connection).toBe("live")
    const count = h.requests.filter((p) => p === "/__preview/status").length
    await h.clock.advance(120_000)
    expect(h.requests.filter((p) => p === "/__preview/status").length).toBe(count)
    expect(FakeEventSource.instances.length).toBe(3)
    h.live.close()
  })

  test("offline when both /status and /version.json fail", async () => {
    const h = harness()
    await h.live.start()
    h.socket().open()
    expect(h.live.get().connection).toBe("live")
    h.served.status = "fail"
    h.served.version = "fail"
    h.socket().fail()
    await h.clock.advance(60_000)
    expect(h.live.get().connection).toBe("offline")
    const lastContact = h.live.get().checkedAt
    expect(Date.parse(lastContact ?? "")).toBeLessThan(h.clock.now())
    h.served.version = V1
    await h.clock.advance(60_000)
    expect(h.live.get().connection).toBe("polling")
    h.live.close()
  })

  test("polls /version.json every 60 s even while live", async () => {
    const h = harness()
    await h.live.start()
    h.socket().open()
    const count = () => h.requests.filter((p) => p === "/version.json").length
    expect(count()).toBe(1)
    await h.clock.advance(60_000)
    expect(count()).toBe(2)
    await h.clock.advance(120_000)
    expect(count()).toBe(4)
    h.live.close()
  })

  test("an announced deploy is not available until /version.json names it", async () => {
    const h = harness()
    await h.live.start()
    h.socket().open()
    h.socket().snapshot(deployedSnapshot(V2))
    await h.clock.advance(0)
    expect(h.live.get().latest?.version).toBe(V2.version)
    expect(h.live.get().update.available).toBe(false)
    // Rechecked shortly, without waiting a full minute.
    h.served.version = V2
    await h.clock.advance(5_000)
    expect(h.live.get().update.available).toBe(true)
    expect(h.live.get().update.autoApplyAt).toBe(new Date(T0 + 15_000).toISOString())
    h.live.close()
  })

  test("/version.json alone (no status events) is enough to offer an update", async () => {
    const h = harness()
    h.served.version = V2
    await h.live.start()
    expect(h.live.get().update.available).toBe(true)
    expect(h.live.get().latest).toEqual({ version: V2.version, at: V2.builtAt })
    h.live.close()
  })

  test("auto-update counts down, then disposes the old app and mounts the new one", async () => {
    const h = harness()
    await h.live.start()
    h.socket().open()
    h.served.version = V2
    h.socket().snapshot(deployedSnapshot(V2))
    await h.clock.advance(0)
    expect(h.live.get().update).toEqual({
      available: true,
      applying: false,
      auto: true,
      autoApplyAt: new Date(T0 + 10_000).toISOString(),
    })
    await h.clock.advance(9_999)
    expect(h.loads).toEqual([V1.version])
    await h.clock.advance(1)
    expect(h.disposed).toEqual([V1.version])
    expect(h.loads).toEqual([V1.version, V2.version])
    expect(h.live.get().current).toEqual({ version: V2.version, builtAt: V2.builtAt })
    expect(h.live.get().update).toEqual({ available: false, applying: false, auto: true })
    expect(h.states.some((s) => s.update.applying)).toBe(true)
    h.live.close()
  })

  test("countdownMs is configurable and applyUpdate applies at once", async () => {
    const h = harness({ countdownMs: 3_000 })
    h.served.version = V2
    await h.live.start()
    expect(h.live.get().update.autoApplyAt).toBe(new Date(T0 + 3_000).toISOString())
    await h.live.applyUpdate()
    expect(h.live.get().current.version).toBe(V2.version)
    expect(h.live.get().update.autoApplyAt).toBeUndefined()
    await h.clock.advance(5_000)
    expect(h.loads).toEqual([V1.version, V2.version])
    h.live.close()
  })

  test("applies immediately while the document is hidden", async () => {
    const h = harness()
    await h.live.start()
    h.doc.hidden = true
    h.served.version = V2
    await h.clock.advance(60_000)
    expect(h.live.get().current.version).toBe(V2.version)
  })

  test("a countdown in progress applies when the tab is hidden", async () => {
    const h = harness()
    h.served.version = V2
    await h.live.start()
    expect(h.live.get().update.autoApplyAt).toBeDefined()
    h.doc.hidden = true
    h.doc.dispatch("visibilitychange")
    await flush()
    expect(h.live.get().current.version).toBe(V2.version)
    h.live.close()
  })

  test("postpone clears the countdown until the next new version", async () => {
    const h = harness()
    h.served.version = V2
    await h.live.start()
    h.live.postpone()
    expect(h.live.get().update).toEqual({ available: true, applying: false, auto: true })
    await h.clock.advance(60_000)
    expect(h.loads).toEqual([V1.version])
    h.served.version = V3
    await h.clock.advance(60_000)
    expect(h.live.get().update.autoApplyAt).toBe(new Date(h.clock.now() + 10_000).toISOString())
    await h.clock.advance(10_000)
    expect(h.live.get().current.version).toBe(V3.version)
    h.live.close()
  })

  test("auto-update off: no countdown, persisted, manual update still works", async () => {
    const h = harness()
    h.served.version = V2
    await h.live.start()
    h.live.setAutoUpdate(false)
    expect(h.storage.values.get(LIVE_PREVIEW_STORAGE_KEY)).toBe("off")
    expect(h.live.get().update).toEqual({ available: true, applying: false, auto: false })
    await h.clock.advance(30_000)
    expect(h.loads).toEqual([V1.version])
    await h.live.applyUpdate()
    expect(h.live.get().current.version).toBe(V2.version)
    h.live.setAutoUpdate(true)
    expect(h.storage.values.get(LIVE_PREVIEW_STORAGE_KEY)).toBe("on")
    h.live.close()
  })

  test("reads the persisted preference", async () => {
    const h = harness({ storage: memoryStorage({ [LIVE_PREVIEW_STORAGE_KEY]: "off" }) })
    h.served.version = V2
    expect(h.live.get().update.auto).toBe(false)
    await h.live.start()
    expect(h.live.get().update.autoApplyAt).toBeUndefined()
    h.live.close()
  })

  test("storage that throws defaults to on", async () => {
    const h = harness({
      storage: {
        getItem: () => {
          throw new Error("denied")
        },
        setItem: () => {
          throw new Error("denied")
        },
      },
    })
    expect(h.live.get().update.auto).toBe(true)
    h.live.setAutoUpdate(false)
    expect(h.live.get().update.auto).toBe(false)
  })

  test("a failed apply restores the previous app, surfaces the error and does not loop", async () => {
    const h = harness()
    h.failLoad.add(V2.version)
    h.served.version = V2
    await h.live.start()
    await h.clock.advance(10_000)
    expect(h.loads).toEqual([V1.version, V2.version, V1.version])
    const state = h.live.get()
    expect(state.current.version).toBe(V1.version)
    expect(state.update.available).toBe(true)
    expect(state.update.applying).toBe(false)
    expect(state.update.error).toContain("boom /app-2.js")
    expect(state.update.autoApplyAt).toBeUndefined()
    await h.clock.advance(120_000)
    expect(h.loads.length).toBe(3)
    // Retry by hand once it is fixed.
    h.failLoad.clear()
    await h.live.applyUpdate()
    expect(h.live.get().current.version).toBe(V2.version)
    expect(h.live.get().update.error).toBeUndefined()
    h.live.close()
  })

  test("reports when restoring the previous app also fails", async () => {
    const h = harness()
    h.served.version = V2
    await h.live.start()
    h.failLoad.add(V2.version)
    h.failLoad.add(V1.version)
    await h.live.applyUpdate()
    expect(h.live.get().update.error).toMatch(/restoring 1111111 also failed/)
    h.live.close()
  })

  test("a failed first mount still connects, rejects start, and applies the next build at once", async () => {
    const h = harness()
    h.failLoad.add(V1.version)
    await expect(h.live.start()).rejects.toThrow("boom /app-1.js")
    expect(FakeEventSource.instances.length).toBe(1)
    expect(h.live.get().update.error).toContain("boom")
    h.served.version = V2
    await h.clock.advance(60_000)
    expect(h.live.get().current.version).toBe(V2.version)
    h.live.close()
  })

  test("a chunk-load failure checks /version.json and applies now, even with auto off", async () => {
    const h = harness({ storage: memoryStorage({ [LIVE_PREVIEW_STORAGE_KEY]: "off" }) })
    await h.live.start()
    h.served.version = V2
    h.win.dispatch("error", { message: "boring error" })
    await flush()
    expect(h.loads).toEqual([V1.version])
    h.win.dispatch("unhandledrejection", {
      reason: new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}/chunk-abc.js`),
    })
    await flush()
    expect(h.loads).toEqual([V1.version, V2.version])
    expect(h.live.get().current.version).toBe(V2.version)
    h.live.close()
  })

  // #873: a build whose stateVersion differs resets the in-tab data, so it waits for the person.
  describe("a pending version with a different stateVersion", () => {
    const S1: PreviewVersion = { ...V1, stateVersion: "schema-1" }
    const S2: PreviewVersion = { ...V2, stateVersion: "schema-2" }

    test("says it resets the data and never auto-updates: no countdown, hidden tab or chunk failure", async () => {
      const h = harness({ current: S1 })
      await h.live.start()
      h.socket().open()
      h.served.version = S2
      h.socket().snapshot(deployedSnapshot(S2))
      await h.clock.advance(0)
      expect(h.live.get().update).toEqual({
        available: true,
        applying: false,
        auto: true,
        resetsData: true,
      })
      await h.clock.advance(5 * 60_000)
      h.doc.hidden = true
      h.doc.dispatch("visibilitychange")
      await h.clock.advance(5 * 60_000)
      h.win.dispatch("unhandledrejection", {
        reason: new TypeError(
          `Failed to fetch dynamically imported module: ${ORIGIN}/chunk-abc.js`,
        ),
      })
      await flush()
      expect(h.loads).toEqual([S1.version])
      expect(h.live.get().current.version).toBe(S1.version)
      expect(h.live.get().update.resetsData).toBe(true)
      h.live.close()
    })

    test("still updates when the person asks, and then no longer resets", async () => {
      const h = harness({ current: S1 })
      h.served.version = S2
      await h.live.start()
      expect(h.live.get().update.autoApplyAt).toBeUndefined()
      await h.live.applyUpdate()
      expect(h.loads).toEqual([S1.version, S2.version])
      expect(h.live.get().update).toEqual({ available: false, applying: false, auto: true })
      h.live.close()
    })

    test("a version that starts or stops naming a stateVersion also resets", async () => {
      const h = harness()
      h.served.version = S2
      await h.live.start()
      expect(h.live.get().update.resetsData).toBe(true)
      await h.clock.advance(60_000)
      expect(h.loads).toEqual([V1.version])
      h.live.close()
    })

    test("the same stateVersion keeps the countdown and leaves resetsData out", async () => {
      const h = harness({ current: S1 })
      h.served.version = { ...V2, stateVersion: "schema-1" }
      await h.live.start()
      expect(h.live.get().update).toEqual({
        available: true,
        applying: false,
        auto: true,
        autoApplyAt: new Date(T0 + 10_000).toISOString(),
      })
      await h.clock.advance(10_000)
      expect(h.live.get().current.version).toBe(V2.version)
      h.live.close()
    })

    test("a non-string stateVersion in version.json is ignored", async () => {
      const h = harness()
      h.served.version = { ...V2, stateVersion: 7 } as unknown as PreviewVersion
      await h.live.start()
      expect(h.live.get().update.resetsData).toBeUndefined()
      expect(h.live.get().update.autoApplyAt).toBeDefined()
      h.live.close()
    })
  })

  test("a chunk-load failure with nothing newer does nothing", async () => {
    const h = harness()
    await h.live.start()
    h.win.dispatch("error", { error: Object.assign(new Error("x"), { name: "ChunkLoadError" }) })
    await flush()
    expect(h.loads).toEqual([V1.version])
    expect(h.requests.filter((p) => p === "/version.json").length).toBe(2)
    h.live.close()
  })

  test("becoming visible checks at once and retries a failed stream", async () => {
    const h = harness()
    await h.live.start()
    h.socket().fail()
    await flush()
    const sockets = FakeEventSource.instances.length
    const versions = h.requests.filter((p) => p === "/version.json").length
    h.doc.dispatch("visibilitychange")
    await flush()
    expect(h.requests.filter((p) => p === "/version.json").length).toBe(versions + 1)
    expect(FakeEventSource.instances.length).toBe(sockets + 1)
    h.live.close()
  })

  test("subscribe notifies on change and unsubscribes", async () => {
    const h = harness()
    const seen: LiveBuildState[] = []
    const off = h.live.subscribe((state) => seen.push(state))
    await h.live.start()
    h.socket().open()
    expect(seen.at(-1)?.connection).toBe("live")
    const count = seen.length
    off()
    h.socket().snapshot(deployedSnapshot(V1))
    expect(seen.length).toBe(count)
    expect(h.states.length).toBeGreaterThan(count)
    h.live.close()
  })

  test("close stops timers, listeners and the stream", async () => {
    const h = harness()
    await h.live.start()
    h.socket().open()
    expect(h.doc.count() + h.win.count()).toBe(3)
    h.live.close()
    expect(h.socket().closed).toBe(true)
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.doc.count() + h.win.count()).toBe(0)
    expect(h.live.get().connection).not.toBe("live")
    expect(h.disposed).toEqual([])
  })
})

describe("isChunkLoadFailure", () => {
  const cases: [unknown, boolean][] = [
    [
      { reason: new TypeError("Failed to fetch dynamically imported module: https://x/a.js") },
      true,
    ],
    [{ reason: new TypeError("Importing a module script failed.") }, true],
    [{ reason: new TypeError("error loading dynamically imported module: https://x/a.js") }, true],
    [
      { reason: Object.assign(new Error("Loading chunk 7 failed."), { name: "ChunkLoadError" }) },
      true,
    ],
    [
      { message: "Uncaught TypeError: Failed to fetch dynamically imported module", error: null },
      true,
    ],
    [{ reason: "ChunkLoadError: Loading chunk 3 failed" }, true],
    [{ reason: new Error("Cannot read properties of undefined") }, false],
    [{ message: "Script error." }, false],
    [null, false],
    ["Failed to fetch dynamically imported module", false],
  ]
  for (const [event, expected] of cases) {
    test(`${JSON.stringify(event, (_, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v))} → ${expected}`, () => {
      expect(isChunkLoadFailure(event)).toBe(expected)
    })
  }
})
