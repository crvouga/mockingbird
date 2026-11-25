import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { failures, KNOWN_DEVIATIONS, PROBE_CALLS, REPLAY_CLIENT, replay } from "./test/replay.js"

test("every recorded sandbox call replays with the same status and body (corpus/probe-calls.json)", async () => {
  const runtime = createRuntime({ latency: "none", apiUsers: [REPLAY_CLIENT] })
  const outcomes = await replay({
    fetch: (r) => runtime.fetch(r),
    base: "http://lifefile.local",
    namespace: "replay",
  })
  expect(outcomes).toHaveLength(PROBE_CALLS.length)
  const failed = failures(outcomes).map((o) => ({
    at: `${o.run}#${o.step} ${o.case}`,
    status: `${o.expectedStatus} → ${o.actualStatus}`,
    rateLimit: o.rateLimit,
    differences: o.differences.slice(0, 5),
  }))
  expect(failed).toEqual([])
  const tolerated = outcomes.flatMap((o) => o.tolerated.map((d) => `${o.case}:${d.path}`))
  expect(tolerated).toEqual(KNOWN_DEVIATIONS.map((d) => `${d.case}:${d.path}`))
}, 60_000)

test("the corpus is sanitized: no tokens, no real account ids, no vendor names", async () => {
  const text = await Bun.file(new URL("./corpus/probe-calls.json", import.meta.url)).text()
  expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/)
  expect(text.toLowerCase()).not.toContain("geviti")
  expect(text.toLowerCase()).not.toContain("medivera")
})
