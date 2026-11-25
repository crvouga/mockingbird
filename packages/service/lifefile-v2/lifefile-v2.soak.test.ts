import { expect, test } from "bun:test"
import { runSoak } from "./test/soak.js"

test("a compressed soak keeps namespaces, records and pushes bounded, the default namespace included", async () => {
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
  expect(report.windows.every((w) => w.defaultOrders > 0)).toBe(true)
  expect(report.verdict.recordsPerDefaultOrder).toBeLessThanOrEqual(4)
  expect(report.verdict.recordLimitRefusals).toBe(0)
  expect(report.verdict.resourceReasons).toEqual([])
}, 60_000)
