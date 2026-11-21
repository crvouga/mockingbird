import { afterEach, describe, expect, test } from "bun:test"
import {
  createPreviewStatus,
  type PreviewStatusCacheLike,
  type PreviewStatusOptions,
  type PreviewStatusSnapshot,
} from "./src/preview-status.js"

const ORIGIN = "https://lab-pr-12.example.workers.dev"
const REPO = "crvouga/mockingbird"
const SHA = "a".repeat(40)
const T0 = Date.parse("2026-11-20T12:00:00Z")
const TOKEN = "ghp_SUPERSECRETTOKEN123"
const RUN_AT = "2026-11-20T11:59:00Z"

type Run = { status: string; conclusion: string | null; html_url?: string; updated_at?: string }
type Answer = Response | (() => Response | Promise<Response>) | "network"

/** A fake GitHub REST API: the PR and one latest run per workflow file. */
const fakeGithub = () => {
  const requests: Request[] = []
  const state = {
    head: SHA,
    runs: new Map<string, Run | undefined>([
      [
        "system-preview.yml",
        {
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/crvouga/mockingbird/actions/runs/1",
          updated_at: RUN_AT,
        },
      ],
      [
        "pr.yml",
        {
          status: "in_progress",
          conclusion: null,
          html_url: "https://github.com/crvouga/mockingbird/actions/runs/2",
          updated_at: RUN_AT,
        },
      ],
    ]),
    /** When set, every request gets this instead. */
    answer: undefined as Answer | undefined,
  }
  const fetch = async (request: Request): Promise<Response> => {
    requests.push(request)
    await Promise.resolve()
    const answer = state.answer
    if (answer === "network") throw new TypeError(`connect ECONNREFUSED (${TOKEN})`)
    if (answer !== undefined) return typeof answer === "function" ? answer() : answer.clone()
    const url = new URL(request.url)
    if (url.pathname === `/repos/${REPO}/pulls/12`) {
      return Response.json({ number: 12, head: { sha: state.head } })
    }
    const match = /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/runs$/.exec(url.pathname)
    if (match?.[1]) {
      const run = state.runs.get(decodeURIComponent(match[1]))
      if (url.searchParams.get("head_sha") !== state.head) {
        return Response.json({ total_count: 0, workflow_runs: [] })
      }
      return Response.json({ total_count: run ? 1 : 0, workflow_runs: run ? [run] : [] })
    }
    return Response.json({ message: "Not Found" }, { status: 404 })
  }
  return { fetch, requests, state }
}

const setup = (overrides: Partial<PreviewStatusOptions> = {}) => {
  const github = fakeGithub()
  let clock = T0
  const version = { value: { version: SHA, builtAt: "2026-11-20T11:58:00.000Z" } as unknown }
  const handler = createPreviewStatus({
    repository: REPO,
    pr: 12,
    fetch: github.fetch,
    now: () => clock,
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
  return {
    handler,
    call,
    status,
    github,
    version,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const rateLimited = (reset?: number) =>
  new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403,
    headers: {
      "x-ratelimit-remaining": "0",
      ...(reset === undefined ? {} : { "x-ratelimit-reset": String(reset) }),
    },
  })

describe("createPreviewStatus: GitHub mapping", () => {
  const buildCases: [string, string | null, "building" | "deployed" | "failed" | undefined][] = [
    ["queued", null, "building"],
    ["in_progress", null, "building"],
    ["waiting", null, "building"],
    ["completed", "success", "deployed"],
    ["completed", "failure", "failed"],
    ["completed", "cancelled", "failed"],
    ["completed", "timed_out", "failed"],
    ["completed", "skipped", undefined],
  ]
  for (const [status, conclusion, expected] of buildCases) {
    test(`build run ${status}/${conclusion} → ${expected}`, async () => {
      const h = setup()
      h.github.state.runs.set("system-preview.yml", {
        status,
        conclusion,
        html_url: "https://github.com/crvouga/mockingbird/actions/runs/9",
        updated_at: RUN_AT,
      })
      const snapshot = await h.status()
      if (expected === undefined) {
        expect(snapshot.build).toBeUndefined()
        return
      }
      expect(snapshot.build).toMatchObject({
        kind: "build",
        state: expected,
        version: SHA,
        at: new Date(RUN_AT).toISOString(),
        runUrl: "https://github.com/crvouga/mockingbird/actions/runs/9",
      })
      if (expected === "failed") expect(snapshot.build?.message).toBeString()
      else expect(snapshot.build?.message).toBeUndefined()
    })
  }

  const checkCases: [string, string | null, "running" | "passed" | "failed"][] = [
    ["queued", null, "running"],
    ["in_progress", null, "running"],
    ["completed", "success", "passed"],
    ["completed", "failure", "failed"],
    ["completed", "cancelled", "failed"],
  ]
  for (const [status, conclusion, expected] of checkCases) {
    test(`checks run ${status}/${conclusion} → ${expected}`, async () => {
      const h = setup()
      h.github.state.runs.set("pr.yml", { status, conclusion, updated_at: RUN_AT })
      const snapshot = await h.status()
      expect(snapshot.checks).toEqual({
        kind: "checks",
        state: expected,
        version: SHA,
        at: new Date(RUN_AT).toISOString(),
      })
    })
  }

  test("a full snapshot: build, checks, deployed from version.json, PR and source", async () => {
    const h = setup()
    expect(await h.status()).toEqual({
      build: {
        kind: "build",
        state: "deployed",
        version: SHA,
        at: new Date(RUN_AT).toISOString(),
        runUrl: "https://github.com/crvouga/mockingbird/actions/runs/1",
      },
      checks: {
        kind: "checks",
        state: "running",
        version: SHA,
        at: new Date(RUN_AT).toISOString(),
        runUrl: "https://github.com/crvouga/mockingbird/actions/runs/2",
      },
      deployed: {
        version: SHA,
        at: "2026-11-20T11:58:00.000Z",
        runUrl: "https://github.com/crvouga/mockingbird/actions/runs/1",
      },
      pr: { number: 12, url: "https://github.com/crvouga/mockingbird/pull/12" },
      source: "github",
      updatedAt: new Date(T0).toISOString(),
    })
  })

  test("no runs for the head yet: no build or checks", async () => {
    const h = setup()
    h.github.state.runs.clear()
    const snapshot = await h.status()
    expect(snapshot.build).toBeUndefined()
    expect(snapshot.checks).toBeUndefined()
    expect(snapshot.source).toBe("github")
  })

  test("deployed comes from version.json alone; a broken readVersion leaves it out", async () => {
    const h = setup({ cacheTtlMs: 0 })
    h.version.value = { version: "b".repeat(40), builtAt: "2026-11-20T10:00:00.000Z" }
    expect((await h.status()).deployed).toEqual({
      version: "b".repeat(40),
      at: "2026-11-20T10:00:00.000Z",
    })
    h.version.value = new Error("assets down")
    expect((await h.status()).deployed).toBeUndefined()
    h.version.value = { nope: true }
    expect((await h.status()).deployed).toBeUndefined()
  })
})

describe("createPreviewStatus: GitHub requests", () => {
  test("looks up the PR head, then the latest run of each workflow for that SHA", async () => {
    const h = setup()
    await h.status()
    const urls = h.github.requests.map((request) => request.url)
    expect(urls[0]).toBe(`https://api.github.com/repos/${REPO}/pulls/12`)
    expect(urls.slice(1).sort()).toEqual([
      `https://api.github.com/repos/${REPO}/actions/workflows/pr.yml/runs?head_sha=${SHA}&per_page=1`,
      `https://api.github.com/repos/${REPO}/actions/workflows/system-preview.yml/runs?head_sha=${SHA}&per_page=1`,
    ])
  })

  test("workflow file names are configurable", async () => {
    const h = setup({ workflows: { build: "deploy.yml", checks: "ci.yml" } })
    h.github.state.runs.set("deploy.yml", {
      status: "queued",
      conclusion: null,
      updated_at: RUN_AT,
    })
    const snapshot = await h.status()
    expect(snapshot.build?.state).toBe("building")
    const paths = h.github.requests.map((request) => new URL(request.url).pathname)
    expect(paths).toContain(`/repos/${REPO}/actions/workflows/deploy.yml/runs`)
    expect(paths).toContain(`/repos/${REPO}/actions/workflows/ci.yml/runs`)
  })

  test("unauthenticated by default: GitHub headers, no authorization", async () => {
    const h = setup()
    await h.status()
    for (const request of h.github.requests) {
      expect(request.headers.get("accept")).toBe("application/vnd.github+json")
      expect(request.headers.get("x-github-api-version")).toBe("2022-11-28")
      expect(request.headers.get("user-agent")).toBe("mockingbird-preview")
      expect(request.headers.has("authorization")).toBe(false)
    }
  })

  test("sends the token as a Bearer header when set", async () => {
    const h = setup({ token: TOKEN })
    await h.status()
    expect(h.github.requests.length).toBe(3)
    for (const request of h.github.requests) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    }
  })

  test("caches the snapshot for cacheTtlMs and shares one refresh across concurrent requests", async () => {
    const h = setup()
    const all = await Promise.all(Array.from({ length: 5 }, () => h.status()))
    expect(h.github.requests.length).toBe(3)
    expect(new Set(all.map((s) => JSON.stringify(s))).size).toBe(1)
    h.advance(9_999)
    await h.status()
    expect(h.github.requests.length).toBe(3)
    h.advance(1)
    await h.status()
    expect(h.github.requests.length).toBe(6)
  })

  test("a shared Cache API spares other isolates the GitHub calls", async () => {
    const store = new Map<string, Response>()
    const cache: PreviewStatusCacheLike = {
      match: async (request) => store.get(request.url)?.clone(),
      put: async (request, response) => {
        store.set(request.url, response)
      },
    }
    const first = setup({ cache })
    const a = await first.status()
    expect(store.size).toBe(1)
    const second = setup({ cache })
    const b = await second.status()
    expect(second.github.requests.length).toBe(0)
    expect(b).toEqual(a)
    second.advance(10_000)
    await second.status()
    expect(second.github.requests.length).toBe(3)
  })
})

describe("createPreviewStatus: failures", () => {
  test("rate limited: backs off until x-ratelimit-reset and serves the last snapshot", async () => {
    const h = setup()
    const good = await h.status()
    expect(good.build?.state).toBe("deployed")
    h.advance(10_000)
    h.github.state.answer = rateLimited(Math.floor(T0 / 1000) + 120)
    const limited = await h.status()
    expect(limited.source).toBe("rate-limited")
    expect(limited.message).toContain("rate limit")
    expect(limited.build).toEqual(good.build)
    expect(limited.checks).toEqual(good.checks)
    expect(limited.deployed).toEqual(good.deployed)
    const calls = h.github.requests.length
    h.github.state.answer = undefined
    h.advance(60_000)
    expect((await h.status()).source).toBe("rate-limited")
    expect(h.github.requests.length).toBe(calls)
    h.advance(50_000) // past the reset
    expect((await h.status()).source).toBe("github")
    expect(h.github.requests.length).toBe(calls + 3)
  })

  test("429 without headers backs off five minutes", async () => {
    const h = setup()
    h.github.state.answer = new Response("slow down", { status: 429 })
    expect((await h.status()).source).toBe("rate-limited")
    h.github.state.answer = undefined
    const calls = h.github.requests.length
    h.advance(5 * 60_000 - 1)
    await h.status()
    expect(h.github.requests.length).toBe(calls)
    h.advance(1)
    expect((await h.status()).source).toBe("github")
  })

  test("retry-after is honoured", async () => {
    const h = setup()
    h.github.state.answer = new Response("", { status: 403, headers: { "retry-after": "30" } })
    expect((await h.status()).source).toBe("rate-limited")
    h.github.state.answer = undefined
    h.advance(30_000)
    expect((await h.status()).source).toBe("github")
  })

  test("5xx and network failures serve the last snapshot as unavailable", async () => {
    const h = setup({ cacheTtlMs: 0 })
    const good = await h.status()
    h.github.state.answer = new Response("bad gateway", { status: 502 })
    const down = await h.status()
    expect(down.source).toBe("unavailable")
    expect(down.message).toBe("GitHub answered 502")
    expect(down.build).toEqual(good.build)
    h.github.state.answer = "network"
    const offline = await h.status()
    expect(offline.source).toBe("unavailable")
    expect(offline.message).toBe("GitHub could not be reached")
    expect(offline.checks).toEqual(good.checks)
    h.github.state.answer = undefined
    expect((await h.status()).source).toBe("github")
  })

  test("unavailable with nothing known yet still answers deployed and PR", async () => {
    const h = setup()
    h.github.state.answer = "network"
    const snapshot = await h.status()
    expect(snapshot.source).toBe("unavailable")
    expect(snapshot.build).toBeUndefined()
    expect(snapshot.deployed?.version).toBe(SHA)
    expect(snapshot.pr?.number).toBe(12)
  })

  test("a private repository without a token is unauthenticated", async () => {
    const h = setup()
    h.github.state.answer = Response.json({ message: "Not Found" }, { status: 404 })
    const snapshot = await h.status()
    expect(snapshot.source).toBe("unauthenticated")
    expect(snapshot.message).toContain("token")
  })

  test("a rejected token is unauthenticated; a token without access is unavailable", async () => {
    const h = setup({ token: TOKEN, cacheTtlMs: 0 })
    h.github.state.answer = Response.json({ message: "Bad credentials" }, { status: 401 })
    expect((await h.status()).source).toBe("unauthenticated")
    h.github.state.answer = Response.json({ message: "Not Found" }, { status: 404 })
    expect((await h.status()).source).toBe("unavailable")
  })

  test("the token never appears in a response", async () => {
    const answers: Answer[] = [
      Response.json({ message: `Bad credentials ${TOKEN}` }, { status: 401 }),
      Response.json({ message: TOKEN }, { status: 404 }),
      new Response(TOKEN, { status: 500 }),
      rateLimited(),
      "network",
      () => {
        throw new Error(TOKEN)
      },
    ]
    for (const answer of answers) {
      const h = setup({ token: TOKEN })
      h.github.state.answer = answer
      for (const path of ["/__preview/status", "/__preview/nope"]) {
        const response = await h.call(path)
        const text = await response?.text()
        expect(text).toBeString()
        expect(text).not.toContain(TOKEN)
        expect(text).not.toContain("SUPERSECRET")
        expect(JSON.stringify([...(response?.headers ?? [])])).not.toContain(TOKEN)
      }
    }
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
    expect(h.github.requests.length).toBe(0)
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
    expect(h.github.requests.length).toBe(3)
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
    const h = setup({ cacheTtlMs: 0, sse: { intervalMs: 10, heartbeatMs: 45, maxMs: 200 } })
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
        h.github.state.runs.set("system-preview.yml", {
          status: "in_progress",
          conclusion: null,
          updated_at: RUN_AT,
        })
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
    expect(h.github.requests.length).toBeGreaterThan(6)
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
    const calls = h.github.requests.length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(h.github.requests.length).toBe(calls)
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

  test("the stream refuses foreign origins and serves rate-limited snapshots too", async () => {
    const h = setup({ sse: { intervalMs: 10, heartbeatMs: 1_000, maxMs: 30 } })
    expect(
      (await h.call("/__preview/live", { headers: { origin: "https://evil.example" } }))?.status,
    ).toBe(403)
    h.github.state.answer = rateLimited()
    const text = await readAll((await h.call("/__preview/live")) as Response)
    const frame = parseFrames(text).find((f) => f.event === "snapshot")
    const snapshot = JSON.parse(frame?.data ?? "{}") as PreviewStatusSnapshot
    expect(snapshot.source).toBe("rate-limited")
    expect(text).not.toContain("API rate limit exceeded")
  })
})
