import { describe, expect, test } from "bun:test"
import { journalPath, manualFault, requestAttempts } from "./src/manual-model.js"

describe("manual fault controls", () => {
  test("actions target future matches and default UI count permits a healthy retry", () => {
    const input = {
      method: "POST",
      path: " /v1/charges ",
      operationId: " CreateCharge ",
      durationMs: 3000,
      count: 1,
    }
    const target = { method: "POST", path: "/v1/charges", operationId: "CreateCharge", count: 1 }
    expect(manualFault("delay", input)).toEqual({ ...target, delay: 3000 })
    expect(manualFault("timeout", input)).toEqual({ ...target, timeout: 3000 })
    expect(manualFault("error", input)).toEqual({ ...target, status: 503 })
    expect(manualFault("delay", { durationMs: 0, count: 2, path: " " })).toEqual({
      delay: 0,
      count: 2,
    })
  })
  test("empty or invalid counts cannot accidentally arm an unbounded fault", () => {
    for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => manualFault("timeout", { durationMs: 100, count })).toThrow(
        "positive whole number",
      )
    }
    for (const durationMs of [-1, 0.5, Number.NaN]) {
      expect(() => manualFault("delay", { durationMs, count: 1 })).toThrow("milliseconds")
    }
    expect(() => manualFault("error", { path: "v1/charges", durationMs: 0, count: 1 })).toThrow(
      "start with /",
    )
  })
})

describe("journal retry evidence", () => {
  test("server-side filters preserve exact paths and escape query delimiters", () => {
    const url = new URL(
      journalPath({ path: " /a&b ", operationId: " notes.list ", method: "GET" }),
      "http://mock.local",
    )
    expect(url.pathname).toBe("/requests")
    expect([...url.searchParams.entries()]).toEqual([
      ["limit", "1000"],
      ["path", "/a&b"],
      ["operationId", "notes.list"],
      ["method", "GET"],
    ])
    expect(journalPath({ path: " " })).toBe("/requests?limit=1000")
  })
  test("counts failed and successful attempts without combining methods, paths or operations", () => {
    const request = {
      method: "POST",
      path: "/v1/charges",
      operationId: "CreateCharge",
      at: "2030-01-01T00:00:00Z",
    }
    const groups = requestAttempts([
      { ...request, status: 0 },
      { ...request, status: 200, at: "2030-01-01T00:00:03Z" },
      { ...request, method: "GET", status: 200 },
      { ...request, path: "/v1/refunds", status: 503 },
      { ...request, operationId: "OtherOperation", status: 200 },
    ])
    expect(groups).toHaveLength(4)
    expect(groups[0]).toMatchObject({
      attempts: 2,
      failures: 1,
      firstStatus: 0,
      latestStatus: 200,
      latestAt: "2030-01-01T00:00:03Z",
    })
    expect(requestAttempts([])).toEqual([])
  })
})
