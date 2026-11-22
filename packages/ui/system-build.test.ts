import { expect, test } from "bun:test"
import {
  ago,
  buildStatus,
  type SystemBuildState,
  secondsUntil,
  shortSha,
  tickAfter,
} from "./src/system-build-status.js"

const NOW = Date.parse("2026-11-20T12:00:00Z")
const before = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()
const A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const B = "b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0"
const base: SystemBuildState = {
  current: { version: A, builtAt: before(180) },
  latest: { version: A, at: before(170) },
  connection: "live",
  checkedAt: before(2),
  update: { available: false, applying: false, auto: true },
}

test("relative times read like people say them and never go negative", () => {
  expect(ago(before(3), NOW)).toBe("just now")
  expect(ago(before(42), NOW)).toBe("42 s ago")
  expect(ago(before(180), NOW)).toBe("3 min ago")
  expect(ago(before(5 * 3600), NOW)).toBe("5 h ago")
  expect(ago(before(2 * 86400 + 10), NOW)).toBe("2 d ago")
  expect(ago(before(-30), NOW)).toBe("just now")
  expect(ago("not a date", NOW)).toBe("at an unknown time")
  expect(tickAfter(before(30), NOW)).toBe(1000)
  expect(tickAfter(before(90), NOW)).toBe(15_000)
  expect(secondsUntil(before(-7.2), NOW)).toBe(8)
  expect(secondsUntil(before(5), NOW)).toBe(0)
  expect(shortSha(A)).toBe("a1b2c3d")
  expect(shortSha("v1.2")).toBe("v1.2")
})

test("the dot says the most urgent thing first", () => {
  expect(buildStatus(base, NOW)).toEqual({ tone: "ok", text: "Up to date · live" })
  expect(buildStatus({ ...base, connection: "polling" }, NOW).text).toBe("Up to date · polling")
  expect(
    buildStatus({ ...base, checks: { state: "failed", version: A, at: before(5) } }, NOW).text,
  ).toBe("Up to date · checks failed · live")
  expect(buildStatus({ ...base, connection: "offline", checkedAt: before(120) }, NOW)).toEqual({
    tone: "offline",
    text: "Offline · last checked 2 min ago",
  })
  const building = { ...base, build: { state: "building" as const, version: B, at: before(20) } }
  expect(buildStatus(building, NOW)).toEqual({ tone: "building", text: "Building b9c8d7e" })
  // A build of this tab's own commit is not news.
  expect(buildStatus({ ...building, build: { ...building.build, version: A } }, NOW).tone).toBe(
    "ok",
  )
  expect(
    buildStatus({ ...base, build: { state: "failed", version: B, at: before(20) } }, NOW),
  ).toEqual({ tone: "failed", text: "Build for b9c8d7e failed" })
  const ready: SystemBuildState = {
    ...building,
    latest: { version: B, at: before(5) },
    update: { available: true, applying: false, auto: true, autoApplyAt: before(-8) },
  }
  expect(buildStatus(ready, NOW)).toEqual({
    tone: "ready",
    text: "New version b9c8d7e ready · updating in 8s",
  })
  expect(buildStatus({ ...ready, update: { ...ready.update, auto: false } }, NOW).text).toBe(
    "New version b9c8d7e ready",
  )
  expect(buildStatus({ ...ready, update: { ...ready.update, applying: true } }, NOW).text).toBe(
    "Updating to b9c8d7e…",
  )
  expect(buildStatus({ ...ready, update: { ...ready.update, error: "boom" } }, NOW)).toEqual({
    tone: "failed",
    text: "Update to b9c8d7e failed",
  })
})
