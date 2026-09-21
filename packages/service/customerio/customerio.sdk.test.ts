import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Analytics } from "@customerio/cdp-analytics-node"
import type { CdpEvent, Delivery, Profile } from "./src/index.js"
import { type CustomerIoServer, createServer } from "./src/server.js"
import { type NotificationRequest, sendNotification } from "./test/consumer.js"

/**
 * `@customerio/cdp-analytics-node@0.5.6` (the version our backend's lockfile pins) pointed at the
 * served mock with `host`, configured exactly as `CustomerIoClientService.getClient` does
 * (`maxEventsInBatch: 1`, `flushInterval: 1000`). It posts `{batch: [...]}` to `/v1/batch`
 * with `Basic base64(<write key>:)`.
 */
let server: CustomerIoServer
let seq = 0

beforeAll(async () => {
  server = await createServer()
})
afterAll(async () => {
  await server.close()
})

/** A fresh namespace per test, carried by the write key and the App API key. */
const workspace = async () => {
  const ns = `sdk${++seq}`
  await fetch(`${server.url}/__admin/credentials`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credentials: { [`write_${ns}`]: ns, [`app_${ns}`]: ns } }),
  })
  const client = new Analytics({
    writeKey: `write_${ns}`,
    host: server.url,
    maxEventsInBatch: 1,
    flushInterval: 1000,
  })
  const admin = async <T>(path: string, init?: RequestInit) =>
    (await (
      await fetch(
        `${server.url}/__admin${path}${path.includes("?") ? "&" : "?"}namespace=${ns}`,
        init,
      )
    ).json()) as T
  const fault = (body: unknown) =>
    fetch(`${server.url}/__admin/faults?namespace=${ns}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { ns, client, admin, fault }
}

const request = (transactionId: string): NotificationRequest => ({
  userId: 42,
  type: "labs.results_ready",
  transactionId,
  redirectPath: "/labs/results",
  properties: { labOrderId: "lab_1" },
  inbox: { title: "Your results are ready", body: "Open the app to review them.", topic: "labs" },
})

const config = (ns: string) => ({
  appApiHost: server.url,
  appApiKey: `app_${ns}`,
  inboxTransactionalMessageId: "geviti_inbox_message",
  inboxEnabled: true,
  deploymentUrl: "https://app.gogeviti.com",
})

describe("SDK drop-in: @customerio/cdp-analytics-node against the mock", () => {
  test("the notification adapter: identify + track delivered, then the inbox message", async () => {
    const { ns, client, admin } = await workspace()
    const result = await sendNotification(
      client,
      { email: "ada@example.com", timezone: "America/Phoenix" },
      request("txn_1"),
      config(ns),
      (r) => fetch(r),
    )
    expect(result).toEqual({
      provider: "customerio",
      userId: "42",
      inboxMessage: { status: "sent", transactionalMessageId: "geviti_inbox_message" },
    })
    const { events } = await admin<{ events: CdpEvent[] }>("/cdp/events?userId=42")
    expect(events.map((e) => [e.type, e.event])).toEqual([
      ["identify", null],
      ["track", "geviti.notification.requested"],
    ])
    expect(events[1]?.messageId).toBe("txn_1")
    expect(events[1]?.properties).toMatchObject({
      notificationType: "labs.results_ready",
      redirectUrl: "https://app.gogeviti.com/labs/results",
      inboxTitle: "Your results are ready",
    })
    const profile = await admin<Profile>("/profiles/42")
    expect(profile).toMatchObject({
      email: "ada@example.com",
      traits: { email: "ada@example.com", timezone: "America/Phoenix" },
    })
    const { messages } = await admin<{ messages: Delivery[] }>("/outbox?channel=inbox")
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      to: "42",
      transactionalMessageId: "geviti_inbox_message",
      messageData: { title: "Your results are ready", transactionId: "txn_1" },
    })
    await client.closeAndFlush({ timeout: 2000 })
  })

  test("a retried notification reuses its messageId: the track is recorded as a duplicate", async () => {
    const { ns, client, admin } = await workspace()
    const user = { email: "ada@example.com" }
    await sendNotification(client, user, request("txn_dup"), config(ns), (r) => fetch(r))
    await sendNotification(client, user, request("txn_dup"), config(ns), (r) => fetch(r))
    const { events } = await admin<{ events: CdpEvent[] }>("/cdp/events?type=track")
    expect(events.map((e) => e.duplicate)).toEqual([false, true])
    await client.closeAndFlush({ timeout: 2000 })
  })

  test("a CDP 400 fails the delivery callback without retries; 503s are retried, then fail", async () => {
    for (const preset of ["cdp_bad_request", "cdp_unavailable"]) {
      const { ns, client, admin, fault } = await workspace()
      await fault({ preset })
      const result = await sendNotification(
        client,
        { email: "ada@example.com" },
        request(`txn_${preset}`),
        config(ns),
        (r) => fetch(r),
      )
      expect(result).toEqual({ failed: "Error" })
      // Promise.all rejects on the first failed event; let the other finish its retries.
      await client.closeAndFlush({ timeout: 5000 })
      // Nothing was accepted, and the inbox message never went out.
      expect((await admin<{ events: unknown[] }>("/cdp/events")).events).toHaveLength(0)
      expect((await admin<{ messages: unknown[] }>("/outbox")).messages).toHaveLength(0)
      const journal = await admin<{ requests: { operationId: string }[] }>(
        "/requests?operationId=CdpBatch",
      )
      // maxRetries 3: 1 + 3 attempts per event on 503, exactly 1 on 400.
      expect(journal.requests.length).toBe(preset === "cdp_unavailable" ? 8 : 2)
    }
  }, 30_000)

  test("a slow CDP trips our delivery timeout (the caller is never held open)", async () => {
    const { ns, client, fault } = await workspace()
    await fault({ operationId: "CdpBatch", latencyMs: 1_000 })
    const result = await sendNotification(
      client,
      { email: "ada@example.com" },
      request("txn_slow"),
      { ...config(ns), deliveryTimeoutMs: 200 },
      (r) => fetch(r),
    )
    expect(result).toEqual({ failed: "CustomerIoDeliveryTimeoutError" })
    await client.closeAndFlush({ timeout: 3000 })
  }, 10_000)

  test("an inbox App API failure is reported with its status", async () => {
    const { ns, client, fault } = await workspace()
    await fault({ preset: "server_error", count: 1 })
    const result = await sendNotification(
      client,
      { email: "ada@example.com" },
      request("txn_inbox"),
      config(ns),
      (r) => fetch(r),
    )
    expect(result).toEqual({ failed: "customerio_inbox_http_error; status=500" })
    await client.closeAndFlush({ timeout: 2000 })
  })
})
