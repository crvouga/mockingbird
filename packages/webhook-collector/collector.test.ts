import { expect, test } from "bun:test"
import { createWebhookCollector, type WebhookRow, type WebhookStore } from "./src/index.ts"

const memoryStore = () => {
  const rows: WebhookRow[] = []
  const store: WebhookStore = {
    async insert(row) {
      rows.push(row)
    },
    async list({ service, runId }) {
      return rows.filter(
        (row) =>
          (service === undefined || row.service === service) &&
          (runId === undefined || row.run_id === runId),
      )
    },
  }
  return store
}

test("new service slugs need no collector changes", async () => {
  const app = createWebhookCollector(memoryStore(), "test-read-token")
  for (const service of ["stripe", "junction", "new-provider"]) {
    const response = await app.request(`http://localhost/${service}?run_id=walk-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_type: `${service}.created` }),
    })
    expect(response.status).toBe(202)
  }
  const response = await app.request(
    "http://localhost/__admin/events/walk-1?service=new-provider",
    {
      headers: { authorization: "Bearer test-read-token" },
    },
  )
  expect(await response.json()).toEqual([{ event_type: "new-provider.created" }])
})

test("rejects malformed service slugs and JSON without storing", async () => {
  const store = memoryStore()
  const app = createWebhookCollector(store)
  expect((await app.request("http://localhost/Bad_Service", { method: "POST" })).status).toBe(400)
  expect(
    (
      await app.request("http://localhost/new-provider", {
        method: "POST",
        body: "{invalid",
      })
    ).status,
  ).toBe(400)
  expect(await store.list({})).toEqual([])
})

test("collected payloads require a read token", async () => {
  const app = createWebhookCollector(memoryStore(), "test-read-token")
  expect((await app.request("http://localhost/__admin/events")).status).toBe(401)
  expect(
    (
      await app.request("http://localhost/__admin/events", {
        headers: { authorization: "Bearer test-read-token" },
      })
    ).status,
  ).toBe(200)
})

test("collector control routes relocate together without aliases", async () => {
  const app = createWebhookCollector(memoryStore(), "test-read-token", {
    adminPrefix: "/_control/mock",
  })
  expect((await app.request("http://localhost/_control/mock/health")).status).toBe(200)
  expect(
    (
      await app.request("http://localhost/_control/mock/events", {
        headers: { authorization: "Bearer test-read-token" },
      })
    ).status,
  ).toBe(200)
  for (const path of ["/health", "/events", "/__admin/health", "/__admin/events"])
    expect((await app.request(`http://localhost${path}`)).status).toBe(404)
})

test("a chunked body is refused once it passes the limit, not after it is buffered", async () => {
  const store = memoryStore()
  const app = createWebhookCollector(store)
  // No Content-Length (chunked transfer): the collector has to count as the bytes arrive.
  const chunk = new Uint8Array(64 * 1024).fill(0x20)
  const total = 64 * 1024 * 1024
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close()
      pulled += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
  const response = await app.request("http://localhost/new-provider", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit)
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ error: "payload_too_large" })
  // At most the 1 MiB limit plus the chunk that crossed it, never the whole 64 MiB upload.
  expect(pulled).toBeLessThanOrEqual(1_048_576 + 2 * chunk.byteLength)
  expect(await store.list({})).toEqual([])
})
