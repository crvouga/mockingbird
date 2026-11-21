import { afterEach, describe, expect, test } from "bun:test"
import {
  createPreviewStatus,
  PREVIEW_STATUS_NO_CI_MESSAGE,
  type PreviewStatusOptions,
  type PreviewStatusSnapshot,
  parsePreviewBuild,
  parsePreviewChecks,
  parsePreviewPr,
} from "./src/preview-status.js"

const ORIGIN = "https://lab-pr-12.example.workers.dev"
const SHA = "a".repeat(40)
const T0 = Date.parse("2026-11-20T12:00:00Z")
const AT = "2026-11-20T11:59:00.000Z"
const RUN = "https://github.com/crvouga/mockingbird/actions/runs/1"
const PR = { number: 12, url: "https://github.com/crvouga/mockingbird/pull/12" }

const setup = (overrides: Partial<PreviewStatusOptions> = {}) => {
  const env: Record<string, unknown> = {
    PREVIEW_BUILD: JSON.stringify({ state: "deployed", version: SHA, at: AT, runUrl: RUN }),
    PREVIEW_CHECKS: JSON.stringify({
      state: "running",
      version: SHA,
      at: AT,
      runUrl: "https://github.com/crvouga/mockingbird/actions/runs/2",
    }),
    PREVIEW_PR: JSON.stringify(PR),
    ASSETS: { fetch: () => Promise.reject(new Error("unused")) },
  }
  let envReads = 0
  const version = { value: { version: SHA, builtAt: "2026-11-20T11:58:00.000Z" } as unknown }
  const handler = createPreviewStatus({
    env: () => {
      envReads++
      return env
    },
    now: () => T0,
    readVersion: async () => {
      if (version.value instanceof Error) throw version.value
      return version.value as { version: string; builtAt: string } | undefined
    },
    ...overrides,
  })
  const call = (path: string, init: RequestInit = {}) =>
    handler(new Request(`${ORIGIN}${path}`, init))
  const status = async (): Promise<PreviewStatusSnapshot> => {
    const response = await call("/__preview/status")
    if (response === undefined) throw new Error("not routed")
    expect(response.status).toBe(200)
    return (await response.json()) as PreviewStatusSnapshot
  }
  return { handler, call, status, env, version, reads: () => envReads }
}

describe("createPreviewStatus: snapshot from the Worker env", () => {
  test("a full snapshot: build, checks, deployed from version.json, PR and source ci", async () => {
    const h = setup()
    expect(await h.status()).toEqual({
      build: { kind: "build", state: "deployed", version: SHA, at: AT, runUrl: RUN },
      checks: {
        kind: "checks",
        state: "running",
        version: SHA,
        at: AT,
        runUrl: "https://github.com/crvouga/mockingbird/actions/runs/2",
      },
      deployed: { version: SHA, at: "2026-11-20T11:58:00.000Z", runUrl: RUN },
      pr: PR,
      source: "ci",
      updatedAt: new Date(T0).toISOString(),
    })
  })

  test("every build and checks state", async () => {
    const h = setup()
    for (const state of ["building", "deployed", "failed"] as const) {
      h.env.PREVIEW_BUILD = JSON.stringify({
        state,
        version: SHA,
        at: AT,
        ...(state === "failed" ? { message: "The build failed" } : {}),
      })
      const snapshot = await h.status()
      expect(snapshot.build?.state).toBe(state)
      if (state === "failed") expect(snapshot.build?.message).toBe("The build failed")
    }
    for (const state of ["running", "passed", "failed"] as const) {
      h.env.PREVIEW_CHECKS = JSON.stringify({ state, version: SHA, at: AT, summary: "3 of 4" })
      const snapshot = await h.status()
      expect(snapshot.checks?.state).toBe(state)
      expect(snapshot.checks?.summary).toBe("3 of 4")
    }
  })

  test("env is read on every call, so a new Worker version's values show at once", async () => {
    const h = setup()
    expect((await h.status()).build?.state).toBe("deployed")
    h.env.PREVIEW_BUILD = JSON.stringify({ state: "building", version: "b".repeat(40), at: AT })
    expect((await h.status()).build).toEqual({
      kind: "build",
      state: "building",
      version: "b".repeat(40),
      at: AT,
    })
  })

  test("only checks reported is still source ci", async () => {
    const h = setup()
    delete h.env.PREVIEW_BUILD
    const snapshot = await h.status()
    expect(snapshot.source).toBe("ci")
    expect(snapshot.build).toBeUndefined()
    expect(snapshot.deployed).toEqual({ version: SHA, at: "2026-11-20T11:58:00.000Z" })
  })

  test("nothing reported: source none with a message, deployed and PR still answer", async () => {
    const h = setup()
    delete h.env.PREVIEW_BUILD
    delete h.env.PREVIEW_CHECKS
    expect(await h.status()).toEqual({
      deployed: { version: SHA, at: "2026-11-20T11:58:00.000Z" },
      pr: PR,
      source: "none",
      message: PREVIEW_STATUS_NO_CI_MESSAGE,
      updatedAt: new Date(T0).toISOString(),
    })
    expect(PREVIEW_STATUS_NO_CI_MESSAGE).toBe("CI has not reported for this preview yet")
  })

  test("malformed values leave their part out and never throw", async () => {
    const h = setup()
    h.env.PREVIEW_BUILD = "{not json"
    h.env.PREVIEW_CHECKS = JSON.stringify({ state: "exploded", version: SHA, at: AT })
    h.env.PREVIEW_PR = JSON.stringify({ number: -1, url: PR.url })
    const snapshot = await h.status()
    expect(snapshot.build).toBeUndefined()
    expect(snapshot.checks).toBeUndefined()
    expect(snapshot.pr).toBeUndefined()
    expect(snapshot.source).toBe("none")
  })

  test("an env that throws answers source none", async () => {
    const h = setup({
      env: () => {
        throw new Error("boom")
      },
    })
    expect((await h.status()).source).toBe("none")
  })

  test("deployed comes from version.json alone; a broken readVersion leaves it out", async () => {
    const h = setup()
    h.env.PREVIEW_BUILD = JSON.stringify({ state: "deployed", version: "c".repeat(40), at: AT })
    expect((await h.status()).deployed).toEqual({
      version: SHA,
      at: "2026-11-20T11:58:00.000Z",
    })
    h.version.value = new Error("assets down")
    expect((await h.status()).deployed).toBeUndefined()
    h.version.value = { version: 7 }
    expect((await h.status()).deployed).toBeUndefined()
  })

  test("a plain-var PR may already be an object", async () => {
    const h = setup()
    h.env.PREVIEW_PR = PR
    expect((await h.status()).pr).toEqual(PR)
  })
})

describe("parsePreview*", () => {
  test("build: validates state, version, time and URL; normalizes the time", () => {
    expect(parsePreviewBuild(undefined)).toBeUndefined()
    expect(parsePreviewBuild("")).toBeUndefined()
    expect(parsePreviewBuild("[]")).toBeUndefined()
    expect(parsePreviewBuild(JSON.stringify({ state: "deployed", version: SHA }))).toBeUndefined()
    expect(
      parsePreviewBuild(JSON.stringify({ state: "deployed", version: "", at: AT })),
    ).toBeUndefined()
    expect(
      parsePreviewBuild(JSON.stringify({ state: "deployed", version: SHA, at: "yesterday" })),
    ).toBeUndefined()
    expect(
      parsePreviewBuild(
        JSON.stringify({
          state: "failed",
          version: SHA,
          at: "2026-11-20T11:59:00Z",
          runUrl: "javascript:alert(1)",
          message: "x".repeat(900),
          extra: true,
        }),
      ),
    ).toEqual({
      kind: "build",
      state: "failed",
      version: SHA,
      at: AT,
      message: "x".repeat(500),
    })
  })

  test("checks: running, passed, failed only", () => {
    expect(
      parsePreviewChecks(JSON.stringify({ state: "building", version: SHA, at: AT })),
    ).toBeUndefined()
    expect(parsePreviewChecks(JSON.stringify({ state: "passed", version: SHA, at: AT }))).toEqual({
      kind: "checks",
      state: "passed",
      version: SHA,
      at: AT,
    })
  })

  test("pr: a positive integer and an https URL", () => {
    expect(parsePreviewPr(JSON.stringify(PR))).toEqual(PR)
    expect(parsePreviewPr(JSON.stringify({ number: 1.5, url: PR.url }))).toBeUndefined()
    expect(parsePreviewPr(JSON.stringify({ number: 3, url: "http://x" }))).toBeUndefined()
    expect(parsePreviewPr("12")).toBeUndefined()
  })
})

describe("createPreviewStatus: routes", () => {
  test("status answers JSON with no-store", async () => {
    const h = setup()
    const response = await h.call("/__preview/status")
    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-type")).toContain("application/json")
    expect(response?.headers.get("cache-control")).toBe("no-store")
  })

  test("paths outside the base fall through; unknown paths under it are 404", async () => {
    const h = setup()
    expect(h.call("/")).toBeUndefined()
    expect(h.call("/__previewx/status")).toBeUndefined()
    expect(h.call("/app/__preview/status")).toBeUndefined()
    expect((await h.call("/__preview/events", { method: "POST" }))?.status).toBe(404)
    expect((await h.call("/__preview"))?.status).toBe(404)
    expect((await h.call("/__preview/status/x"))?.status).toBe(404)
    expect(h.reads()).toBe(0)
  })

  test("a custom basePath", async () => {
    const h = setup({ basePath: "/_status/" })
    expect(h.call("/__preview/status")).toBeUndefined()
    expect((await h.call("/_status/status"))?.status).toBe(200)
  })

  test("only GET and HEAD", async () => {
    const h = setup()
    expect((await h.call("/__preview/status", { method: "POST" }))?.status).toBe(405)
    expect((await h.call("/__preview/status", { method: "HEAD" }))?.status).toBe(200)
  })

  test("same-origin only", async () => {
    const h = setup()
    const foreign = await h.call("/__preview/status", {
      headers: { origin: "https://evil.example" },
    })
    expect(foreign?.status).toBe(403)
    const crossSite = await h.call("/__preview/live", {
      headers: { "sec-fetch-site": "cross-site" },
    })
    expect(crossSite?.status).toBe(403)
    const sameSite = await h.call("/__preview/status", {
      headers: { "sec-fetch-site": "same-site" },
    })
    expect(sameSite?.status).toBe(403)
    for (const site of ["same-origin", "none"]) {
      const ok = await h.call("/__preview/status", {
        headers: { "sec-fetch-site": site, origin: ORIGIN },
      })
      expect(ok?.status).toBe(200)
    }
    expect(h.reads()).toBe(2)
  })
})

// --- SSE ---

/** Tracks real timers so a test can assert none were left behind. */
const trackTimers = () => {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const live = new Set<unknown>()
  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    const handle = realSet(() => {
      live.delete(handle)
      run()
    }, ms)
    live.add(handle)
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    live.delete(handle)
    realClear(handle)
  }) as typeof clearTimeout
  return {
    pending: () => live.size,
    restore: () => {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    },
  }
}

let timers: ReturnType<typeof trackTimers> | undefined
afterEach(() => {
  timers?.restore()
  timers = undefined
})

type Frame = { event?: string; data?: string; retry?: string; comment?: string }

const parseFrames = (text: string): Frame[] =>
  text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const frame: Frame = {}
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) frame.comment = line.slice(1).trim()
        else if (line.startsWith("event: ")) frame.event = line.slice(7)
        else if (line.startsWith("data: ")) frame.data = line.slice(6)
        else if (line.startsWith("retry: ")) frame.retry = line.slice(7)
      }
      return frame
    })

const readAll = async (response: Response, onChunk?: (text: string) => void): Promise<string> => {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    const chunk = decoder.decode(value, { stream: true })
    text += chunk
    onChunk?.(chunk)
  }
}

describe("createPreviewStatus: /live", () => {
  test("streams retry and a snapshot at once, then only changes, heartbeats, and closes at maxMs", async () => {
    timers = trackTimers()
    const h = setup({ sse: { intervalMs: 10, heartbeatMs: 45, maxMs: 200 } })
    const response = await h.call("/__preview/live")
    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(response?.headers.get("cache-control")).toBe("no-store")
    let flipped = false
    const started = Date.now()
    const text = await readAll(response as Response, (chunk) => {
      if (!flipped && chunk.includes("event: snapshot")) {
        flipped = true
        // The next recompute sees a build starting.
        h.env.PREVIEW_BUILD = JSON.stringify({ state: "building", version: SHA, at: AT })
      }
    })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(190)
    expect(elapsed).toBeLessThan(5_000)
    const frames = parseFrames(text)
    expect(frames[0]).toEqual({ retry: "2000" })
    expect(frames[1]?.event).toBe("snapshot")
    const snapshots = frames
      .filter((frame) => frame.event === "snapshot")
      .map((frame) => JSON.parse(frame.data ?? "") as PreviewStatusSnapshot)
    // ~20 recomputes, but only two distinct snapshots.
    expect(snapshots.map((s) => s.build?.state)).toEqual(["deployed", "building"])
    expect(h.reads()).toBeGreaterThan(6)
    const heartbeats = frames.filter((frame) => frame.comment === "heartbeat").length
    expect(heartbeats).toBeGreaterThanOrEqual(1)
    expect(heartbeats).toBeLessThanOrEqual(5)
    expect(timers.pending()).toBe(0)
  })

  test("stops when the client disconnects (request.signal) and leaves no timers", async () => {
    timers = trackTimers()
    const h = setup({ sse: { intervalMs: 10, heartbeatMs: 10, maxMs: 60_000 } })
    const controller = new AbortController()
    const response = (await h.handler(
      new Request(`${ORIGIN}/__preview/live`, { signal: controller.signal }),
    )) as Response
    let seen = ""
    const done = readAll(response, (chunk) => {
      seen += chunk
      if (seen.includes("event: snapshot")) controller.abort()
    })
    await done
    expect(timers.pending()).toBe(0)
    const calls = h.reads()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(h.reads()).toBe(calls)
  })

  test("stops when the reader cancels the stream", async () => {
    timers = trackTimers()
    const h = setup({ sse: { intervalMs: 10, heartbeatMs: 10, maxMs: 60_000 } })
    const response = (await h.call("/__preview/live")) as Response
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await reader.cancel()
    expect(timers.pending()).toBe(0)
  })

  test("an already aborted request closes at once", async () => {
    timers = trackTimers()
    const h = setup()
    const controller = new AbortController()
    controller.abort()
    const response = (await h.handler(
      new Request(`${ORIGIN}/__preview/live`, { signal: controller.signal }),
    )) as Response
    expect(await readAll(response)).toBe("")
    expect(timers.pending()).toBe(0)
  })

  test("the stream refuses foreign origins and streams a no-CI snapshot too", async () => {
    const h = setup({ sse: { intervalMs: 10, heartbeatMs: 1_000, maxMs: 30 } })
    expect(
      (await h.call("/__preview/live", { headers: { origin: "https://evil.example" } }))?.status,
    ).toBe(403)
    delete h.env.PREVIEW_BUILD
    delete h.env.PREVIEW_CHECKS
    const text = await readAll((await h.call("/__preview/live")) as Response)
    const frame = parseFrames(text).find((f) => f.event === "snapshot")
    const snapshot = JSON.parse(frame?.data ?? "{}") as PreviewStatusSnapshot
    expect(snapshot.source).toBe("none")
  })

  test("closes after 25 s by default", async () => {
    timers = trackTimers()
    const delays: number[] = []
    const realSet = globalThis.setTimeout
    globalThis.setTimeout = ((run: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return realSet(run, ms)
    }) as typeof setTimeout
    try {
      const h = setup()
      const response = (await h.call("/__preview/live")) as Response
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      expect(delays).toContain(25_000)
      expect(delays).toContain(15_000)
      await reader.cancel()
    } finally {
      globalThis.setTimeout = realSet
    }
  })
})
