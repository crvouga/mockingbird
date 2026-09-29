import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeObservation } from "./comparison.mjs"

const realIds = new Map([["real-id", "run"]])
const mockIds = new Map([["mock-id", "run"]])
const same = (real, mock) =>
  assert.deepEqual(normalizeObservation(real, realIds), normalizeObservation(mock, mockIds))

test("identity fields map without mutating the response", () => {
  const real = { status: 200, body: { run_id: "real-id", session_id: "real-id" } }
  same(real, { status: 200, body: { run_id: "mock-id", session_id: "mock-id" } })
  assert.equal(real.body.run_id, "real-id")
})
test("result and arbitrary error strings retain generated IDs", () => {
  for (const field of ["output", "error"]) {
    assert.throws(
      () =>
        same(
          { status: 200, body: { [field]: "result real-id" } },
          { status: 200, body: { [field]: "result mock-id" } },
        ),
      assert.AssertionError,
    )
  }
})
test("missing-run normalization requires the exact error template", () => {
  const missing = (message) => ({
    status: 404,
    body: { error: { code: "run_not_found", message } },
  })
  same(missing("Run not found: real-id"), missing("Run not found: mock-id"))
  assert.throws(
    () => same(missing("Run not found: real-id"), missing("Different: mock-id")),
    assert.AssertionError,
  )
  assert.throws(
    () => same(missing("Run not found: real-id"), missing("Run not found: mock-id suffix")),
    assert.AssertionError,
  )
})
