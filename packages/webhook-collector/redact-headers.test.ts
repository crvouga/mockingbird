import { expect, test } from "bun:test"
import { createWebhookCollector, type WebhookRow } from "./src/index.ts"

test("credential headers a sender includes are stored redacted, by name only", async () => {
  const rows: WebhookRow[] = []
  const app = createWebhookCollector(
    { insert: async (row) => void rows.push(row), list: async () => rows },
    "test-read-token",
  )
  const response = await app.request("http://localhost/new-provider?run_id=walk-1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Token placeholder",
      "proxy-authorization": "Bearer upstream-proxy",
      cookie: "session=abc",
      "stripe-signature": "t=1,v1=deadbeef",
    },
    body: JSON.stringify({ event_type: "new-provider.created" }),
  })
  expect(response.status).toBe(202)
  const read = await app.request("http://localhost/__admin/events?run_id=walk-1", {
    headers: { authorization: "Bearer test-read-token" },
  })
  const [row] = (await read.json()) as WebhookRow[]
  expect(row?.headers).toMatchObject({
    authorization: "[redacted]",
    "proxy-authorization": "[redacted]",
    cookie: "[redacted]",
    // Signature headers stay, so parity code can still verify deliveries.
    "stripe-signature": "t=1,v1=deadbeef",
    "content-type": "application/json",
  })
})
