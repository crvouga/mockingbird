import { describe, expect, test } from "bun:test"
import {
  createLauncherController,
  type LauncherSnapshot,
  type LauncherTimers,
  launcherRequestUrl,
  PREVIEW_LAUNCHER_CSS,
  PREVIEW_LAUNCHER_HEAD,
} from "./src/preview-launcher.js"
import {
  formatElapsed,
  type LauncherInput,
  launcherView,
  matchLauncherPath,
  POLL,
  type PreviewLaunch,
  parseLaunch,
  pollInterval,
  READY_DELAY_MS,
  stepLabel,
} from "./src/preview-launcher-view.js"

const NOW = Date.parse("2026-11-20T12:00:00Z")
const before = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const OLD = "b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0"
const NEXT = "c0ffee00112233445566778899aabbccddeeff00"
const RUN = { url: "https://ci.example/runs/7", startedAt: before(42) }
const URL_LIVE = "https://pr-42.preview.example/"

const launch = (patch: Record<string, unknown>): PreviewLaunch =>
  ({ pullRequest: 42, head: HEAD, ...patch }) as PreviewLaunch

describe("matchLauncherPath", () => {
  test("reads the pull request number and rejects anything else", () => {
    expect(matchLauncherPath("/pr/42")).toBe(42)
    expect(matchLauncherPath("/pr/42/")).toBe(42)
    expect(matchLauncherPath("/previews/7", "/previews")).toBe(7)
    expect(matchLauncherPath("/previews/7", "/previews/")).toBe(7)
    for (const path of [
      "/pr/0",
      "/pr/042",
      "/pr/",
      "/pr/4a",
      "/pr/-1",
      "/pr/42/x",
      "/pr/42//",
      "/pr/1.5",
      "/pr/99999999999",
      "/x/pr/42",
      "/pr42",
    ])
      expect(matchLauncherPath(path)).toBeUndefined()
  })
})

describe("parseLaunch", () => {
  test("accepts a launch for this pull request and drops fields the launcher does not know (9)", () => {
    const parsed = parseLaunch(
      {
        pullRequest: 42,
        head: HEAD,
        state: "building",
        steps: [{ name: "Run bun install", state: "running", log: "secret" }],
        run: RUN,
        title: "Secret feature",
        branch: "feat/secret",
      },
      42,
    )
    expect(parsed).toEqual({
      pullRequest: 42,
      head: HEAD,
      state: "building",
      run: RUN,
      steps: [{ name: "Run bun install", state: "running" }],
    })
    expect(JSON.stringify(parsed)).not.toContain("Secret")
    expect(JSON.stringify(parsed)).not.toContain("feat/secret")
  })

  test("rejects other pull requests, HTML fallbacks and malformed states (7)", () => {
    expect(parseLaunch({ pullRequest: 41, state: "idle" }, 42)).toBeUndefined()
    expect(parseLaunch("<!doctype html><html></html>", 42)).toBeUndefined()
    expect(parseLaunch(null, 42)).toBeUndefined()
    expect(parseLaunch({ pullRequest: 42, state: "nope" }, 42)).toBeUndefined()
    expect(parseLaunch({ pullRequest: 42, state: "building" }, 42)).toBeUndefined()
    expect(
      parseLaunch({ pullRequest: 42, state: "building", steps: [{ name: 1, state: "x" }] }, 42),
    ).toBeUndefined()
    expect(parseLaunch({ pullRequest: 42, state: "live", commit: HEAD }, 42)).toBeUndefined()
    expect(parseLaunch({ pullRequest: 42, state: "failed", reason: "x" }, 42)).toBeUndefined()
    expect(parseLaunch({ pullRequest: 42, state: "closed" }, 42)).toBeUndefined()
  })
})

test("CI step names read as friendly labels, falling back to the raw name without Run (2)", () => {
  expect(stepLabel("Set up job")).toBe("Preparing the build machine")
  expect(stepLabel("Run actions/checkout@v4")).toBe("Getting the code")
  expect(stepLabel("Run oven-sh/setup-bun@v2")).toBe("Setting up Bun")
  expect(stepLabel("Run actions/setup-node@v4")).toBe("Setting up Node.js")
  expect(stepLabel("Run actions/cache@v4")).toBe("Restoring the cache")
  expect(stepLabel("Run bun install --frozen-lockfile")).toBe("Installing dependencies")
  expect(stepLabel("Run npm ci")).toBe("Installing dependencies")
  expect(stepLabel("Run bun run build:preview")).toBe("Building")
  expect(stepLabel("Run bun test")).toBe("Running tests")
  expect(stepLabel("Run bun run preview:publish")).toBe("Publishing the preview")
  expect(stepLabel("Deploy to Pages")).toBe("Publishing the preview")
  expect(stepLabel("Run ./scripts/latest-thing.sh")).toBe("./scripts/latest-thing.sh")
  expect(stepLabel("Generate sitemap")).toBe("Generate sitemap")
  expect(formatElapsed(42)).toBe("0:42")
  expect(formatElapsed(725)).toBe("12:05")
  expect(formatElapsed(3723)).toBe("1:02:03")
  expect(formatElapsed(-5)).toBe("0:00")
})

describe("launcherView, for every state", () => {
  const statuses = (input: LauncherInput, stay = false) =>
    launcherView(input, NOW, { stay, pullRequest: 42 }).phases?.map((phase) => phase.status)

  test("loading and idle: starting, nothing to link to", () => {
    const loading = launcherView({ state: "loading" }, NOW, { pullRequest: 42 })
    expect(loading.headline).toBe("Checking the preview…")
    expect(loading.title).toBe("Pull request #42")
    const idle = launcherView(launch({ state: "idle" }), NOW)
    expect(idle.headline).toBe("Starting a build…")
    expect(idle.commit).toBe("a1b2c3d")
    expect(statuses(launch({ state: "idle" }))).toEqual(["current", "todo", "todo", "todo"])
    expect(idle.progress).toBe("indeterminate")
    expect(idle.current).toBeUndefined()
    expect(idle.retry).toBe(false)
  })

  test("queued, building and publishing: stepper, steps, elapsed, capped progress, log (2)", () => {
    const steps = [
      { name: "Set up job", state: "done" },
      { name: "Run bun install --frozen-lockfile", state: "running" },
      { name: "Run bun run build:preview", state: "pending" },
    ]
    const building = launcherView(
      launch({ state: "building", run: RUN, steps, estimateSeconds: 120 }),
      NOW,
    )
    expect(building.headline).toBe("Building the preview…")
    expect(statuses(launch({ state: "building", steps }))).toEqual([
      "done",
      "current",
      "todo",
      "todo",
    ])
    expect(building.steps).toEqual([
      { label: "Preparing the build machine", name: "Set up job", state: "done" },
      {
        label: "Installing dependencies",
        name: "Run bun install --frozen-lockfile",
        state: "running",
      },
      { label: "Building", name: "Run bun run build:preview", state: "pending" },
    ])
    expect(building.elapsed).toBe("0:42")
    expect(building.ticking).toBe(true)
    expect(building.usually).toBe("about 2 min")
    expect(building.progress).toEqual({ percent: 35 })
    expect(building.log).toBe(RUN.url)

    // Elapsed ticks with the clock; progress never reaches 100 before live.
    const later = launcherView(
      launch({ state: "building", run: RUN, steps, estimateSeconds: 120 }),
      NOW + 1000,
    )
    expect(later.elapsed).toBe("0:43")
    const overdue = launcherView(
      launch({ state: "publishing", run: RUN, steps: [], estimateSeconds: 10 }),
      NOW,
    )
    expect(overdue.progress).toEqual({ percent: 95 })
    expect(overdue.headline).toBe("Publishing the preview…")
    expect(statuses(launch({ state: "publishing", steps: [] }))).toEqual([
      "done",
      "done",
      "current",
      "todo",
    ])

    const noEstimate = launcherView(launch({ state: "building", run: RUN, steps }), NOW)
    expect(noEstimate.progress).toBe("indeterminate")
    expect(noEstimate.usually).toBeUndefined()

    const queued = launcherView(launch({ state: "queued", steps: [] }), NOW, {
      startedAt: NOW - 5000,
    })
    expect(queued.headline).toBe("Waiting for a build machine…")
    expect(queued.elapsed).toBe("0:05")
    expect(queued.log).toBeUndefined()
    expect(statuses(launch({ state: "queued", steps: [] }))).toEqual([
      "current",
      "todo",
      "todo",
      "todo",
    ])
  })

  test("an older live commit is offered while the head builds (3)", () => {
    const view = launcherView(
      launch({ state: "building", steps: [], live: { commit: OLD, url: URL_LIVE } }),
      NOW,
    )
    expect(view.current).toEqual({ label: "Open the current version (b9c8d7e)", url: URL_LIVE })
  })

  test("live: Ready, then open; with stay an Open button (4)", () => {
    const live = launch({ state: "live", commit: HEAD, url: URL_LIVE })
    const redirect = launcherView(live, NOW)
    expect(redirect.headline).toBe("Ready. Opening the preview…")
    expect(redirect.redirect).toEqual({ url: URL_LIVE, afterMs: READY_DELAY_MS })
    expect(redirect.open).toBeUndefined()
    expect(redirect.progress).toEqual({ percent: 100 })
    expect(statuses(live)).toEqual(["done", "done", "done", "current"])
    const stay = launcherView(live, NOW, { stay: true })
    expect(stay.redirect).toBeUndefined()
    expect(stay.open).toEqual({ label: "Open preview", url: URL_LIVE })
    expect(stay.tone).toBe("ready")
  })

  test("failed, unsupported, closed, unavailable (5)", () => {
    const failed = launcherView(
      launch({ state: "failed", reason: "The build failed.", retryable: true, run: RUN }),
      NOW,
    )
    expect(failed).toMatchObject({
      tone: "failed",
      headline: "The build failed.",
      detail: "The build failed.",
      retry: true,
      log: RUN.url,
    })
    for (const state of ["unsupported", "closed", "unavailable"] as const) {
      const view = launcherView(launch({ state, message: `Message for ${state}` }), NOW)
      expect(view.tone).toBe("stopped")
      expect(view.detail).toBe(`Message for ${state}`)
      expect(view.retry).toBe(false)
      expect(view.phases).toBeUndefined()
    }
  })

  test("reconnecting and busy are calm (7)", () => {
    const view = launcherView({ state: "reconnecting" }, NOW, { pullRequest: 42 })
    expect(view.headline).toBe("Reconnecting…")
    expect(view.tone).toBe("reconnecting")
    expect(view.title).toBe("Pull request #42")
    const busy = launcherView({ state: "busy", message: "Too many." }, NOW, { pullRequest: 42 })
    expect(busy.detail).toBe("Too many.")
  })
})

test("polling adapts to the state (6)", () => {
  const p = (input: LauncherInput, options: { stay?: boolean; starting?: boolean } = {}) =>
    pollInterval(input, options)
  expect(p(launch({ state: "queued", steps: [] }))).toBe(POLL.active)
  expect(p(launch({ state: "building", steps: [] }))).toBe(5_000)
  expect(p(launch({ state: "publishing", steps: [] }))).toBe(5_000)
  expect(p({ state: "reconnecting" })).toBe(5_000)
  expect(p(launch({ state: "idle" }))).toBe(15_000)
  expect(p(launch({ state: "idle" }), { starting: true })).toBe(5_000)
  expect(p(launch({ state: "failed", reason: "x", retryable: true }))).toBe(15_000)
  expect(p({ state: "busy", message: "x" })).toBe(15_000)
  expect(p(launch({ state: "live", commit: HEAD, url: URL_LIVE }), { stay: true })).toBe(30_000)
  expect(p(launch({ state: "live", commit: HEAD, url: URL_LIVE }))).toBeUndefined()
  for (const state of ["unsupported", "closed", "unavailable"])
    expect(p(launch({ state, message: "x" }))).toBeUndefined()
})

test("the request URL keeps an existing query string", () => {
  expect(launcherRequestUrl("/api/launch", 42)).toBe("/api/launch?pr=42")
  expect(launcherRequestUrl("https://relay.example/x?site=lab", 7)).toBe(
    "https://relay.example/x?site=lab&pr=7",
  )
  expect(launcherRequestUrl("/x?", 7)).toBe("/x?pr=7")
  expect(launcherRequestUrl("/x#frag", 7)).toBe("/x?pr=7")
})

test("the page follows the system theme, honours reduced motion and ships a no-flash head (8)", () => {
  expect(PREVIEW_LAUNCHER_HEAD).toContain('<meta name="color-scheme" content="light dark">')
  expect(PREVIEW_LAUNCHER_HEAD).toContain("prefers-color-scheme:dark")
  expect(PREVIEW_LAUNCHER_CSS).toContain("color-scheme:light dark")
  expect(PREVIEW_LAUNCHER_CSS).toContain("prefers-reduced-motion:reduce")
  expect(PREVIEW_LAUNCHER_CSS).toContain("prefers-color-scheme:dark")
})

// --- The controller, against a scripted relay and manual timers. ---

function manualTimers() {
  let clock = NOW
  let id = 0
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timers: LauncherTimers = {
    setTimeout(callback, ms) {
      pending.set(++id, { at: clock + ms, callback })
      return id
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
  }
  return {
    timers,
    now: () => clock,
    /** Delays of the timers waiting now. */
    waiting: () => [...pending.values()].map((entry) => entry.at - clock).sort((a, b) => a - b),
    async advance(ms: number) {
      const end = clock + ms
      for (;;) {
        const next = [...pending.entries()]
          .filter(([, entry]) => entry.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        pending.delete(next[0])
        clock = next[1].at
        next[1].callback()
        await flush()
      }
      clock = end
      await flush()
    },
  }
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

type Answer = { status?: number; body: unknown } | "network" | "html"
function scriptedRelay(answer: (method: string) => Answer) {
  const calls: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push(`${method} ${String(input)}`)
    const reply = answer(method)
    if (reply === "network") throw new TypeError("Failed to fetch")
    if (reply === "html")
      return new Response("<!doctype html><title>Not found</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    return Response.json(reply.body, { status: reply.status ?? 200 })
  }) as typeof globalThis.fetch
  return {
    fetch,
    calls,
    posts: () => calls.filter((call) => call.startsWith("POST")).length,
    gets: () => calls.filter((call) => call.startsWith("GET")).length,
  }
}

let relays = 0
function controller(
  answer: (method: string) => Answer,
  options: { stay?: boolean; hidden?: () => boolean; relayName?: string } = {},
) {
  const time = manualTimers()
  const relay = scriptedRelay(answer)
  const lives: string[] = []
  const seen: LauncherSnapshot[] = []
  const name = options.relayName ?? `https://relay.example/${++relays}`
  const make = () =>
    createLauncherController({
      pullRequest: 42,
      relay: name,
      fetch: relay.fetch,
      now: time.now,
      timers: time.timers,
      ...(options.stay ? { stay: true } : {}),
      ...(options.hidden ? { hidden: options.hidden } : {}),
      onChange: (snapshot) => seen.push(snapshot),
      onLive: (url) => lives.push(url),
    })
  const state = () => seen.at(-1)?.input.state
  return { time, relay, lives, seen, make, state, name }
}

test("idle starts exactly one build per head, across mounts and polls (1)", async () => {
  let started = false
  const t = controller((method) => {
    if (method === "POST") started = true
    return {
      status: method === "POST" ? 202 : 200,
      body: started ? launch({ state: "queued", steps: [] }) : launch({ state: "idle" }),
    }
  })
  // React StrictMode: mount, unmount, mount again, plus a third rerender mount.
  const first = t.make()
  first.refresh()
  const second = t.make()
  second.refresh()
  await flush()
  first.destroy()
  const third = t.make()
  third.refresh()
  await flush()
  await t.time.advance(60_000)
  expect(t.relay.posts()).toBe(1)
  expect(t.relay.calls[0]).toBe(`GET ${t.name}?pr=42`)
  expect(t.state()).toBe("queued")
  second.destroy()
  third.destroy()
})

test("a failed start clears the marker so the next poll retries (1)", async () => {
  let posts = 0
  const t = controller((method) => {
    if (method === "POST") {
      posts++
      return posts === 1 ? "network" : { status: 202, body: launch({ state: "queued", steps: [] }) }
    }
    return { body: posts >= 2 ? launch({ state: "queued", steps: [] }) : launch({ state: "idle" }) }
  })
  const c = t.make()
  c.refresh()
  await flush()
  expect(posts).toBe(1)
  expect(t.state()).toBe("reconnecting")
  await t.time.advance(POLL.active)
  expect(posts).toBe(2)
  expect(t.state()).toBe("queued")
  c.destroy()
})

test("HTTP 429 shows busy, clears the marker and retries on the slow poll", async () => {
  let posts = 0
  const t = controller((method) => {
    if (method === "POST") {
      posts++
      return posts === 1
        ? { status: 429, body: launch({ state: "unavailable", message: "Too many previews." }) }
        : { status: 202, body: launch({ state: "queued", steps: [] }) }
    }
    return { body: launch({ state: "idle" }) }
  })
  const c = t.make()
  c.refresh()
  await flush()
  expect(t.seen.at(-1)?.input).toEqual({ state: "busy", message: "Too many previews." })
  expect(t.time.waiting()).toEqual([POLL.idle])
  await t.time.advance(POLL.idle)
  expect(posts).toBe(2)
  expect(t.state()).toBe("queued")
  c.destroy()
})

test("live for the head: Ready, then onLive after a moment; stay keeps watching (4)", async () => {
  const live = launch({ state: "live", commit: HEAD, url: URL_LIVE })
  const t = controller(() => ({ body: live }))
  const c = t.make()
  c.refresh()
  await flush()
  expect(t.state()).toBe("live")
  expect(t.lives).toEqual([])
  await t.time.advance(READY_DELAY_MS - 1)
  expect(t.lives).toEqual([])
  await t.time.advance(1)
  expect(t.lives).toEqual([URL_LIVE])
  expect(t.time.waiting()).toEqual([])

  const s = controller(() => ({ body: live }), { stay: true })
  const staying = s.make()
  staying.refresh()
  await flush()
  await s.time.advance(READY_DELAY_MS)
  expect(s.lives).toEqual([])
  expect(s.time.waiting()).toEqual([POLL.live - READY_DELAY_MS])
  staying.destroy()
})

test("failed: Try again sends a start; terminal states never poll (5)", async () => {
  let failed = true
  const t = controller((method) => {
    if (method === "POST") failed = false
    return {
      status: method === "POST" ? 202 : 200,
      body: failed
        ? launch({ state: "failed", reason: "The build failed.", retryable: true, run: RUN })
        : launch({ state: "queued", steps: [] }),
    }
  })
  const c = t.make()
  c.refresh()
  await flush()
  expect(t.state()).toBe("failed")
  expect(t.relay.posts()).toBe(0)
  expect(t.time.waiting()).toEqual([POLL.idle])
  c.retry()
  await flush()
  expect(t.relay.posts()).toBe(1)
  expect(t.state()).toBe("queued")
  c.destroy()

  for (const state of ["unsupported", "closed", "unavailable"] as const) {
    const s = controller(() => ({ body: launch({ state, message: "No." }) }))
    const terminal = s.make()
    terminal.refresh()
    await flush()
    expect(s.state()).toBe(state)
    expect(s.time.waiting()).toEqual([])
    await s.time.advance(600_000)
    expect(s.relay.gets()).toBe(1)
    terminal.resume()
    await flush()
    expect(s.relay.gets()).toBe(1)
  }
})

test("polling pauses while hidden and resumes when shown; a staying page builds a newer head (6)", async () => {
  let hidden = false
  let head = HEAD
  let building = false
  const t = controller(
    (method) => {
      if (method === "POST") building = true
      if (building)
        return {
          status: method === "POST" ? 202 : 200,
          body: launch({ head, state: "queued", steps: [], live: { commit: HEAD, url: URL_LIVE } }),
        }
      return head === HEAD
        ? { body: launch({ state: "live", commit: HEAD, url: URL_LIVE }) }
        : { body: launch({ head, state: "idle", live: { commit: HEAD, url: URL_LIVE } }) }
    },
    { stay: true, hidden: () => hidden },
  )
  const c = t.make()
  c.refresh()
  await flush()
  expect(t.time.waiting()).toEqual([POLL.live])

  hidden = true
  c.pause()
  expect(t.time.waiting()).toEqual([])
  await t.time.advance(120_000)
  expect(t.relay.gets()).toBe(1)
  hidden = false
  c.resume()
  await flush()
  expect(t.relay.gets()).toBe(2)

  // A push: the relay now says idle for the newer head, with the old one live.
  head = NEXT
  await t.time.advance(POLL.live)
  expect(t.relay.posts()).toBe(1)
  expect(t.state()).toBe("queued")
  const view = launcherView(t.seen.at(-1)?.input ?? { state: "loading" }, NOW, { stay: true })
  expect(view.current?.url).toBe(URL_LIVE)
  expect(t.time.waiting()).toEqual([POLL.active])
  expect(t.lives).toEqual([])
  c.destroy()
})

test("503, a launch for another PR, HTML or a network error: reconnecting, retried every 5 s (7)", async () => {
  const answers: Answer[] = [
    {
      status: 503,
      body: launch({ state: "unavailable", message: "The build service is not answering." }),
    },
    { body: { pullRequest: 41, state: "idle" } },
    "html",
    "network",
    { body: launch({ state: "building", steps: [] }) },
  ]
  let index = 0
  const t = controller(() => answers[Math.min(index++, answers.length - 1)] as Answer)
  const c = t.make()
  c.refresh()
  for (let i = 0; i < 4; i++) {
    await flush()
    expect(t.state()).toBe("reconnecting")
    expect(t.time.waiting()).toEqual([POLL.active])
    await t.time.advance(POLL.active)
  }
  expect(t.state()).toBe("building")
  c.destroy()
})

test("elapsed time before the relay has a run counts from when the page saw the start", async () => {
  const t = controller((method) => ({
    status: method === "POST" ? 202 : 200,
    body: launch({ state: method === "POST" ? "queued" : "idle", steps: [] }),
  }))
  const c = t.make()
  c.refresh()
  await flush()
  expect(t.seen.at(-1)?.startedAt).toBe(NOW)
  c.destroy()
})

test("the README's static page carries PREVIEW_LAUNCHER_HEAD verbatim", async () => {
  const readme = await Bun.file(`${import.meta.dir}/README.md`).text()
  expect(readme).toContain(PREVIEW_LAUNCHER_HEAD)
})
