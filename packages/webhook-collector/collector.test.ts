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
  const response = await app.request("http://localhost/events/walk-1?service=new-provider", {
    headers: { authorization: "Bearer test-read-token" },
  })
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
  expect((await app.request("http://localhost/events")).status).toBe(401)
  expect(
    (
      await app.request("http://localhost/events", {
        headers: { authorization: "Bearer test-read-token" },
      })
    ).status,
  ).toBe(200)
})
