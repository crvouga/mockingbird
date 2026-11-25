import { expect, test } from "bun:test"
import { runSoak } from "./test/soak.js"

test("a compressed soak keeps latency, memory, pushes and namespaces flat", async () => {
  const report = await runSoak({
    durationMs: 12_000,
    testsPerMinute: 3_000,
    windows: 4,
    idleLeftoverEvery: 10,
    namespaceIdleMs: 1_000,
    sleep: (ms) => Bun.sleep(ms),
  })
  expect(report.windows.reduce((n, w) => n + w.tests, 0)).toBeGreaterThan(100)
  expect(report.windows.every((w) => w.pushes > 0)).toBe(true)
  expect(report.verdict.reasons).toEqual([])
  expect(report.verdict.pass).toBe(true)
}, 60_000)
