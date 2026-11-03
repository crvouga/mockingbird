import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createWebhookCollector } from "./src/index.ts"

const store = { insert: async () => {}, list: async () => [] }

test("only the exact bearer token reads events", async () => {
  const app = createWebhookCollector(store, "test-read-token")
  const read = (authorization?: string) =>
    app.request("http://localhost/__admin/events/run-1", {
      headers: authorization === undefined ? {} : { authorization },
    })
  for (const sent of [
    undefined,
    "",
    "Bearer ",
    "Bearer test-read-tokeN",
    "Bearer test-read-token2",
    "test-read-token",
  ])
    expect((await read(sent)).status).toBe(401)
  expect((await read("Bearer test-read-token")).status).toBe(200)
})

// Timing cannot be asserted reliably in a unit test, so this pins the compare instead: a plain
// `!==` returns at the first differing character, which lets a caller recover the token one
// character at a time from response times.
test("the read token is compared in constant time", () => {
  const source = readFileSync(new URL("./src/index.ts", import.meta.url), "utf8")
  expect(source.match(/header\("authorization"\)\s*[!=]==/g)).toBeNull()
  expect(source).toContain("timingSafeEqual(")
})
