import { expect, test } from "bun:test"
import {
  type FreshnessFeed,
  type FreshnessIdentity,
  type FreshnessValue,
  freshnessBuild,
  freshnessView,
} from "./src/freshness-indicator.js"

const NOW = Date.parse("2026-11-21T12:00:00Z")
const A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const B = "b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0"
const RUN = "https://github.com/o/r/actions/runs/9"
const running: FreshnessIdentity = {
  commit: A,
  builtAt: "2026-11-21T11:00:00Z",
  parts: { app: "1", admin: "2" },
}
const current: FreshnessIdentity = {
  commit: B,
  builtAt: "2026-11-21T11:58:00Z",
  parts: { app: "1*", admin: "2" },
}
const next = { state: "building" as const, commit: B, startedAt: "2026-11-21T11:58:00Z", run: RUN }

test("current says nothing", () => {
  expect(freshnessView({ state: "current", running, changed: [] }, NOW).visible).toBe(false)
})

test("newer-live names the changed apps, offers a one-app update, the range and keep", () => {
  const value: FreshnessValue = {
    state: "newer-live",
    running,
    current,
    changed: ["app"],
    update: { kind: "app", app: "app" },
  }
  expect(freshnessView(value, NOW)).toEqual({
    visible: true,
    tone: "ready",
    headline: "A newer build (b9c8d7e) is live",
    detail: "Changed: app.",
    update: { label: "Update app", plan: { kind: "app", app: "app" } },
    range: { from: A, to: B },
    keepable: true,
  })
  expect(
    freshnessView(
      { ...value, update: { kind: "reload" }, changed: ["a", "b", "c", "d", "e"] },
      NOW,
    ),
  ).toMatchObject({
    detail: "Changed: a, b, c and 2 more.",
    update: { label: "Update now" },
  })
  // Keep this version hides it until a different build.
  expect(freshnessView(value, NOW, B).visible).toBe(false)
})

test("newer-building and newer-failed carry the log link; unknown never blocks", () => {
  expect(
    freshnessView({ state: "newer-building", running, next, changed: null }, NOW),
  ).toMatchObject({
    tone: "building",
    headline: "A newer build (b9c8d7e) is building",
    detail: "Started 2 min ago.",
    log: RUN,
  })
  expect(
    freshnessView(
      { state: "newer-failed", running, next: { ...next, state: "failed" }, changed: null },
      NOW,
    ),
  ).toMatchObject({
    tone: "failed",
    detail: "This version keeps working.",
    log: RUN,
    keepable: true,
  })
  expect(
    freshnessView(
      { state: "unknown", running, changed: null, reason: "HTTP 503", retryInMs: 60_000 },
      NOW,
    ),
  ).toMatchObject({ tone: "offline", detail: "Retrying in 60 s. This version keeps working." })
})

test("freshnessBuild projects freshness onto the harness's SystemBuild and applies the plan", async () => {
  let value: FreshnessValue = { state: "newer-building", running, next, changed: null }
  const listeners = new Set<(value: FreshnessValue) => void>()
  const swapped: FreshnessIdentity[] = []
  const feed: FreshnessFeed = {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setRunning: (identity) => swapped.push(identity),
  }
  const plans: unknown[] = []
  const build = freshnessBuild({ freshness: feed, onUpdate: (plan) => void plans.push(plan) })
  expect(build.get()).toMatchObject({
    current: { version: A },
    build: { state: "building", version: B, url: RUN },
    update: { available: false },
  })
  value = {
    state: "newer-live",
    running,
    current,
    changed: ["app"],
    update: { kind: "app", app: "app" },
  }
  for (const listener of listeners) listener(value)
  expect(build.get()).toMatchObject({
    latest: { version: B },
    update: { available: true, auto: false },
  })
  await build.applyUpdate()
  expect(plans).toEqual([{ kind: "app", app: "app" }])
  expect(swapped).toEqual([current])
  build.destroy()
})
