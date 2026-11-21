import { describe, expect, test } from "bun:test"
import { createPreviewArtifact } from "./src/artifacts.js"
import {
  type BuildIdentity,
  compareFreshness,
  createBuildIdentity,
  createFreshnessStatusFile,
  type Freshness,
  type FreshnessStatus,
  type FreshnessVisibility,
  freshnessFromLaunch,
  freshnessStatusResponse,
  parseFreshnessStatus,
  planFreshnessUpdate,
  watchFreshness,
} from "./src/freshness.js"

const A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const B = "b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0"
const C = "c0ffee1234567890abcdef1234567890abcdef12"
const AT = "2026-11-21T12:00:00.000Z"
const RUN = "https://github.com/o/r/actions/runs/9"

const build = (commit: string, parts: Record<string, string>): BuildIdentity => ({
  commit,
  builtAt: AT,
  parts,
})
const running = build(A, { app: "p1", admin: "p2", emulators: "p3" })

/** A fake source with scripted answers, a manual clock and a visibility switch. */
function harness(initial: FreshnessStatus | Error) {
  let answer: FreshnessStatus | Error = initial
  let reads = 0
  let hidden = false
  let visible: (() => void) | undefined
  const pending: { run: () => void; at: number; id: number }[] = []
  let now = 0
  let ids = 0
  const visibility: FreshnessVisibility = {
    hidden: () => hidden,
    onVisible(listener) {
      visible = listener
      return () => {
        visible = undefined
      }
    },
  }
  const seen: Freshness[] = []
  const watch = watchFreshness({
    running,
    interval: 30_000,
    source: async () => {
      reads++
      if (answer instanceof Error) throw answer
      return answer
    },
    visibility,
    onChange: (value) => seen.push(value),
    timers: {
      setTimeout(run, ms) {
        const id = ++ids
        pending.push({ run, at: now + ms, id })
        return id
      },
      clearTimeout(handle) {
        const index = pending.findIndex((item) => item.id === handle)
        if (index >= 0) pending.splice(index, 1)
      },
    },
  })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    watch,
    seen,
    reads: () => reads,
    set(next: FreshnessStatus | Error) {
      answer = next
    },
    /** Advance the clock, firing due timers. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        pending.sort((a, b) => a.at - b.at)
        const due = pending[0]
        if (!due || due.at > end) break
        pending.shift()
        now = due.at
        due.run()
        await flush()
      }
      now = end
      await flush()
    },
    hide() {
      hidden = true
    },
    show() {
      hidden = false
      visible?.()
    },
    nextDelay: () => (pending[0] ? pending[0].at - now : undefined),
    flush,
  }
}

describe("freshness", () => {
  test("1: running the current build is current and shows nothing", async () => {
    const h = harness({ current: running })
    await h.flush()
    expect(h.watch.get()).toEqual({ state: "current", running, changed: [] })
    expect(h.seen).toEqual([])
  })

  test("2: a newer current build is newer-live within one interval (or at once on focus), naming the changed apps", async () => {
    const h = harness({ current: running })
    await h.flush()
    const next = build(B, { app: "p1-new", admin: "p2", emulators: "p3" })
    h.set({ current: next })
    await h.advance(29_000)
    expect(h.watch.get().state).toBe("current")
    await h.advance(1_000)
    expect(h.watch.get()).toEqual({
      state: "newer-live",
      running,
      current: next,
      changed: ["app"],
      update: { kind: "app", app: "app" },
    })

    const focus = harness({ current: running })
    await focus.flush()
    focus.set({ current: next })
    focus.show()
    await focus.flush()
    expect(focus.watch.get().state).toBe("newer-live")
  })

  test("3: a building next is newer-building with its start and log, then newer-live without a refresh", async () => {
    const h = harness({
      current: running,
      next: { state: "building", commit: B, startedAt: AT, run: RUN },
    })
    await h.flush()
    expect(h.watch.get()).toEqual({
      state: "newer-building",
      running,
      next: { state: "building", commit: B, startedAt: AT, run: RUN },
      changed: null,
    })
    const published = build(B, { app: "p1", admin: "p2-new", emulators: "p3" })
    h.set({ current: published })
    await h.advance(30_000)
    expect(h.watch.get()).toMatchObject({ state: "newer-live", changed: ["admin"] })
  })

  test("4: a failed next is newer-failed with the log link; the running build stays usable", async () => {
    const h = harness({
      current: running,
      next: { state: "failed", commit: B, startedAt: AT, run: RUN },
    })
    await h.flush()
    expect(h.watch.get()).toMatchObject({ state: "newer-failed", next: { run: RUN }, running })
  })

  test("5: an unreadable status is unknown and retries back off; it never throws", async () => {
    const h = harness(new Error("HTTP 503"))
    await h.flush()
    expect(h.watch.get()).toMatchObject({ state: "unknown", reason: "HTTP 503", retryInMs: 30_000 })
    expect(h.nextDelay()).toBe(30_000)
    await h.advance(30_000)
    expect(h.nextDelay()).toBe(60_000)
    await h.advance(60_000)
    expect(h.nextDelay()).toBe(120_000)
    h.set({ current: running })
    await h.advance(120_000)
    expect(h.watch.get().state).toBe("current")
    expect(h.nextDelay()).toBe(30_000)
    // Malformed bodies are unknown too.
    const bad = harness({ nope: true } as unknown as FreshnessStatus)
    await bad.flush()
    expect(bad.watch.get().state).toBe("unknown")
  })

  test("6: a tab hidden for a day does not poll, and checks once when visible", async () => {
    const h = harness({ current: running })
    await h.flush()
    expect(h.reads()).toBe(1)
    h.hide()
    await h.advance(86_400_000)
    expect(h.reads()).toBe(1)
    h.show()
    await h.flush()
    expect(h.reads()).toBe(2)
    h.watch.stop()
  })

  test("7: one changed part updates that app only; anything else reloads the shell", () => {
    const base = build(A, { app: "1", admin: "2" })
    expect(planFreshnessUpdate(base, build(B, { app: "1*", admin: "2" }))).toEqual({
      kind: "app",
      app: "app",
    })
    expect(planFreshnessUpdate(base, build(B, { app: "1*", admin: "2*" }))).toEqual({
      kind: "reload",
    })
    expect(planFreshnessUpdate(base, build(B, { app: "1", admin: "2", extra: "3" }))).toEqual({
      kind: "reload",
    })
    // Same parts, new commit (only the shell changed): reload.
    expect(planFreshnessUpdate(base, build(B, { app: "1", admin: "2" }))).toEqual({
      kind: "reload",
    })
  })

  test("compare: newer-live wins over a newer build and carries it", () => {
    const current = build(B, running.parts)
    const value = compareFreshness(running, {
      current,
      next: { state: "building", commit: C, startedAt: AT, run: RUN },
    })
    expect(value).toMatchObject({ state: "newer-live", changed: [], next: { commit: C } })
    // A next that is this tab's own commit is not news.
    expect(
      compareFreshness(running, {
        current: running,
        next: { state: "failed", commit: A, startedAt: AT, run: RUN },
      }).state,
    ).toBe("current")
  })
})

describe("status documents", () => {
  test("build identity extends preview artifacts; the file and response are no-store with open CORS", async () => {
    const part = await createPreviewArtifact(new TextEncoder().encode("app"), {
      commit: A,
      url: "https://x/app.js",
    })
    const identity = createBuildIdentity({
      commit: A,
      builtAt: AT,
      parts: { app: part, admin: "pin" },
    })
    expect(identity).toEqual({ commit: A, builtAt: AT, parts: { app: part.sha256, admin: "pin" } })
    const file = createFreshnessStatusFile({ current: identity })
    expect(file.path).toBe("freshness.json")
    expect(JSON.parse(new TextDecoder().decode(file.bytes))).toEqual({ current: identity })
    expect(file.headers).toBe(
      "/freshness.json\n  cache-control: no-store\n  access-control-allow-origin: *\n",
    )
    const response = freshnessStatusResponse({ current: null })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(() =>
      createFreshnessStatusFile({ current: { commit: "x", builtAt: AT, parts: {} } }),
    ).toThrow()
    expect(
      parseFreshnessStatus({
        current: null,
        next: { state: "done", commit: B, startedAt: AT, run: RUN },
      }),
    ).toBeUndefined()
  })

  test("the on-demand relay's answer derives a status document", () => {
    const current = build(A, {})
    expect(
      freshnessFromLaunch(
        { pullRequest: 1, head: B, state: "building", run: { url: RUN, startedAt: AT }, steps: [] },
        current,
      ),
    ).toEqual({ current, next: { state: "building", commit: B, startedAt: AT, run: RUN } })
    expect(
      freshnessFromLaunch(
        { pullRequest: 1, head: B, state: "failed", reason: "x", retryable: true },
        current,
        () => Date.parse(AT),
      ),
    ).toEqual({ current, next: { state: "failed", commit: B, startedAt: AT, run: "" } })
    expect(
      freshnessFromLaunch(
        { pullRequest: 1, head: A, state: "live", commit: A, url: "https://x/" },
        current,
      ),
    ).toEqual({ current })
    expect(freshnessFromLaunch({ pullRequest: 1, state: "closed", message: "x" }, null)).toEqual({
      current: null,
    })
  })
})
