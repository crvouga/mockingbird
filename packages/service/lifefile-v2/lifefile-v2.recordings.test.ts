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

const ACCOUNT_KEYS: Record<string, (id: number) => boolean> = {
  vendorId: (id) => id === 10001,
  practiceId: (id) => id === 900001 || id === 1,
  locationId: (id) => (id >= 100_001 && id <= 100_199) || id === 999_999,
  apiUserId: (id) => id >= 200_001 && id <= 200_999,
  userId: (id) => id >= 200_001 && id <= 200_999,
  orderId: (id) => (id >= 50_000_000 && id <= 50_999_999) || id === 1,
}
const PARENT_KEYS: Record<string, string> = {
  vendor: "vendorId",
  practice: "practiceId",
  location: "locationId",
  apiUser: "apiUserId",
  order: "orderId",
}

const accountIds = (value: unknown, parent = ""): [string, number][] => {
  if (Array.isArray(value)) return value.flatMap((entry) => accountIds(entry, parent))
  if (typeof value === "string") {
    return [...value.matchAll(/\/orders\/(\d+)/g)].map((m): [string, number] => [
      "orderId",
      Number(m[1]),
    ])
  }
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, entry]): [string, number][] => {
    const kind = key === "id" ? PARENT_KEYS[parent] : ACCOUNT_KEYS[key] ? key : undefined
    if (kind && typeof entry === "number") return [[kind, entry]]
    if (kind && typeof entry === "string" && /^\d+$/.test(entry)) return [[kind, Number(entry)]]
    return accountIds(entry, key)
  })
}

test("the corpus is sanitized: no tokens, only synthetic account ids, no credentials", async () => {
  const text = await Bun.file(new URL("./corpus/probe-calls.json", import.meta.url)).text()
  expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/)
  expect(text).not.toContain("<pii>")
  expect(text).not.toMatch(/client_secret"\s*:\s*"(?!<)/)
  const found = accountIds(JSON.parse(text))
  expect(found.length).toBeGreaterThan(30)
  const real = found.filter(([kind, id]) => !(ACCOUNT_KEYS[kind] as (id: number) => boolean)(id))
  expect(real).toEqual([])
})
