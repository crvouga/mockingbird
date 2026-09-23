import { describe, expect, test } from "bun:test"
import {
  CUSTOMERIO_PRESETS,
  createRuntime,
  type Delivery,
  REPORTING_WEBHOOK_PATH,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  CustomerIoTransactionalError,
  listTransactionalTriggerNames,
  ReportingReceiver,
  reportClick,
  sendCustomerIoTransactional,
  TransactionalEmailDeliveryError,
  TriggerNameListError,
  tryDeliverTransactionalEmail,
} from "./test/consumer.js"

const API = "http://customerio.mock"
const SIGNING_KEY = "cio-reporting-signing-key-0123456789abcdef"

const harness = () => {
  const deliveries: Request[] = []
  const runtime = createRuntime({
    webhooks: {
      url: `http://backend.local${REPORTING_WEBHOOK_PATH}`,
      secret: SIGNING_KEY,
      fetch: async (request) => {
        deliveries.push(request)
        return Response.json({ received: true })
      },
    },
  })
  const send = (request: Request) => runtime.fetch(request)
  const receiver = new ReportingReceiver(SIGNING_KEY, new Set([42, 7]))
  const admin = async <T>(path: string, body?: unknown, method = body ? "POST" : "GET") =>
    (await (
      await runtime.fetch(
        new Request(`${API}/__admin${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    ).json()) as T
  const outbox = async (query = "") =>
    (await admin<{ messages: Delivery[] }>(`/outbox${query}`)).messages
  /** Deliver every reporting event to our receiver logic. */
  const receive = async () => {
    await runtime.webhooks.idle()
    const out: { status: number; body: unknown }[] = []
    for (const request of deliveries.splice(0)) out.push(await receiver.receive(request))
    return out
  }
  const processor = (overrides: Partial<Parameters<typeof sendCustomerIoTransactional>[0]> = {}) =>
    sendCustomerIoTransactional({
      appApiHost: API,
      apiKey: "app_key",
      channel: "email",
      transactionalMessageId: "geviti_payment_failed_email",
      identifier: "42",
      to: "ada@example.com",
      messageData: { firstName: "Ada", ctaUrl: "https://app.gogeviti.com/billing" },
      tracked: false,
      disableMessageRetention: false,
      fetchImpl: send,
      ...overrides,
    })
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected a failure")
      },
      (error: unknown) => error as CustomerIoTransactionalError,
    )
  return { runtime, send, receiver, admin, outbox, receive, processor, failure }
}

describe("S19 Customer.io acceptance: our consumers' logic against the mock", () => {
  test("backend transactional email: the legacy trigger name resolves and lands in the outbox", async () => {
    const { send, outbox } = harness()
    const result = await tryDeliverTransactionalEmail(
      { appApiHost: API, appApiKey: "app_key", enabledTypes: ["welcome"] },
      {
        key: "welcome",
        toEmail: "ada@example.com",
        identifier: "42",
        subject: "Welcome to Geviti",
        messageData: { firstName: "Ada", loginUrl: "https://app.gogeviti.com/login", skip: null },
        attachments: [
          { filename: "welcome.pdf", contentBase64: "JVBERi0=", contentType: "application/pdf" },
        ],
      },
      send,
    )
    expect(result?.transactionalMessageId).toBe("geviti_welcome")
    expect(result?.deliveryId).toMatch(/^[A-Za-z0-9]{28}$/)
    const [delivery] = await outbox("?to=ada@example.com")
    expect(delivery).toMatchObject({
      channel: "email",
      transactionalMessageId: "geviti_welcome",
      messageId: 1,
      identifiers: { id: "42" },
      subject: "Welcome to Geviti",
      messageData: { firstName: "Ada", loginUrl: "https://app.gogeviti.com/login" },
      links: ["https://app.gogeviti.com/login"],
      tracked: false,
      sendToUnsubscribed: true,
      attachments: ["welcome.pdf"],
      state: "sent",
    })
  })

  test("a missing trigger name (400 meta.error or 404) falls back; other failures throw", async () => {
    for (const preset of ["transactional_message_missing", "transactional_404"]) {
      const { runtime, send } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      const result = await tryDeliverTransactionalEmail(
        { appApiHost: API, appApiKey: "k", enabledTypes: ["billing"] },
        { key: "billing", toEmail: "a@example.com", messageData: {} },
        send,
      )
      expect(result).toBeNull()
    }
    // Strict workspaces refuse ids they do not have, exactly as the preset does.
    const strict = harness()
    await strict.admin("/settings", { strictMessages: true }, "PUT")
    expect(
      await tryDeliverTransactionalEmail(
        { appApiHost: API, appApiKey: "k", messageIds: { billing: "999" } },
        { key: "billing", toEmail: "a@example.com", messageData: {} },
        strict.send,
      ),
    ).toBeNull()
    const broken = harness()
    broken.runtime.applyPreset("server_error", "default", { count: 1 })
    const error = await broken.failure(
      tryDeliverTransactionalEmail(
        { appApiHost: API, appApiKey: "k", enabledTypes: ["billing"] },
        { key: "billing", toEmail: "a@example.com", messageData: {} },
        broken.send,
      ),
    )
    expect(error).toBeInstanceOf(TransactionalEmailDeliveryError)
    expect((error as TransactionalEmailDeliveryError).status).toBe(500)
  })

  test("processor client: definite vs ambiguous failures, and trigger_name_missing", async () => {
    const ok = harness()
    expect((await ok.processor()).deliveryId).toMatch(/^[A-Za-z0-9]{28}$/)
    expect((await ok.processor({ channel: "sms", to: "+16025550142" })).deliveryId).toBeTruthy()
    expect((await ok.outbox("?channel=sms"))[0]?.to).toBe("+16025550142")

    const cases: [string, { status?: number; ambiguous: boolean; reason?: string }][] = [
      ["request_timeout_408", { status: 408, ambiguous: true }],
      ["server_error", { status: 500, ambiguous: true }],
      ["rate_limited", { status: 429, ambiguous: false }],
      [
        "transactional_message_missing",
        { status: 400, ambiguous: false, reason: "trigger_name_missing" },
      ],
      ["transactional_404", { status: 404, ambiguous: false, reason: "trigger_name_missing" }],
      ["invalid_app_key", { status: 401, ambiguous: false }],
      ["send_drop", { ambiguous: true }],
    ]
    for (const [preset, expected] of cases) {
      const { runtime, processor, failure } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      const error = await failure(processor())
      expect(error).toBeInstanceOf(CustomerIoTransactionalError)
      expect({ status: error.status, ambiguous: error.ambiguous, reason: error.reason }).toEqual({
        status: expected.status,
        ambiguous: expected.ambiguous,
        reason: expected.reason,
      } as never)
    }
    // meta.error is carried as the (truncated) detail.
    const missing = harness()
    missing.runtime.applyPreset("transactional_message_missing", "default", { count: 1 })
    expect((await missing.failure(missing.processor())).detail).toBe(
      "transactional_message_id not found",
    )
  })

  test("accepted_but_500: ambiguous, and the message really was queued (keep the reservation)", async () => {
    const { runtime, processor, failure, outbox } = harness()
    runtime.applyPreset("accepted_but_500", "default", { count: 1 })
    const error = await failure(processor())
    expect(error.ambiguous).toBe(true)
    expect(await outbox()).toHaveLength(1)
  })

  test("disable_message_retention keeps no body; unsubscribed profiles are suppressed unless send_to_unsubscribed", async () => {
    const { processor, outbox, admin } = harness()
    await processor({ disableMessageRetention: true })
    expect((await outbox())[0]).toMatchObject({ messageData: null, links: [], state: "sent" })
    await admin("/reporting-events", {
      metric: "unsubscribed",
      userId: "42",
      objectType: "customer",
    })
    await processor({ sendToUnsubscribed: false })
    await processor({ sendToUnsubscribed: true })
    expect((await outbox()).map((d) => d.state)).toEqual(["sent", "suppressed", "sent"])
  })

  test("trigger-name validator: list, detail fallback, and a failing list", async () => {
    const { runtime, send } = harness()
    const names = await listTransactionalTriggerNames({
      appApiHost: API,
      appApiKey: "k",
      fetchImpl: send,
    })
    expect(names.has("geviti_welcome")).toBe(true)
    expect(names.has("geviti_inbox_message")).toBe(true)
    runtime.applyPreset("omit_trigger_names", "default", { count: 1 })
    const viaDetail = await listTransactionalTriggerNames({
      appApiHost: API,
      appApiKey: "k",
      fetchImpl: send,
    })
    // Only 25 detail lookups per run: the first 25 of the 21 seeded messages all resolve.
    expect(viaDetail).toEqual(names)
    runtime.applyPreset("transactional_list_unavailable", "default", { count: 1 })
    const error = await listTransactionalTriggerNames({
      appApiHost: API,
      appApiKey: "k",
      fetchImpl: send,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TriggerNameListError)
    expect((error as TriggerNameListError).status).toBe(503)
  })

  test("tracked links are rewritten; the app's click report and a browser follow both count", async () => {
    const { runtime, processor, outbox, send, receive } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackingBase: API }),
      }),
    )
    await processor({ tracked: true })
    const [delivery] = await outbox()
    const tracked = delivery?.links[0] as string
    expect(tracked).toMatch(new RegExp(`^${API}/click/l[A-Za-z0-9]+$`))
    const linkId = tracked.split("/").at(-1) as string
    expect(await reportClick(API, linkId, send)).toEqual({ status: "sent", httpStatus: 200 })
    const follow = await send(new Request(tracked, { redirect: "manual" }))
    expect(follow.status).toBe(302)
    expect(follow.headers.get("location")).toBe("https://app.gogeviti.com/billing")
    expect((await outbox())[0]?.clicks).toBe(2)
    expect(await reportClick(API, "unknown-link", send)).toEqual({
      status: "failed",
      httpStatus: 404,
    })
    // Clicks are reported to the reporting webhook; our receiver ignores the metric.
    const received = await receive()
    expect(received.map((r) => r.status)).toEqual([200, 200])
    expect(received[0]?.body).toEqual({ received: true, applied: false })
  })

  test("reporting webhook: signed events drive suppression, opt-in and preferences", async () => {
    const { admin, receive, receiver } = harness()
    await admin("/reporting-events", {
      metric: "unsubscribed",
      userId: "42",
      objectType: "customer",
    })
    await admin("/reporting-events", { metric: "spammed", userId: "7", objectType: "email" })
    expect((await receive()).map((r) => r.body)).toEqual([
      { received: true, applied: true },
      { received: true, applied: true },
    ])
    expect([...(receiver.suppressed.get(42) ?? [])].sort()).toEqual(["email", "sms"])
    expect([...(receiver.suppressed.get(7) ?? [])]).toEqual(["email"])
    await admin("/reporting-events", { metric: "subscribed", userId: "42" })
    await admin("/reporting-events", {
      metric: "cio_subscription_preferences_changed",
      userId: "7",
      preferences: { channels: { sms: false, email: true } },
    })
    await receive()
    expect(receiver.optIns.map((o) => [o.userId, [...o.channels]])).toEqual([
      [42, ["email", "sms"]],
      [7, ["email"]],
    ])
    expect([...(receiver.suppressed.get(7) ?? [])].sort()).toEqual(["email", "sms"])
    // A profile id our receiver cannot map to a user is received but not applied.
    await admin("/reporting-events", { metric: "unsubscribed", email: "who@example.com" })
    expect((await receive())[0]?.body).toEqual({ received: true, applied: false })
  })

  test("webhook_duplicate re-sends the same event_id; our replay marker turns it away", async () => {
    const { runtime, admin, receive, receiver } = harness()
    runtime.applyPreset("webhook_duplicate", "default")
    await admin("/reporting-events", { metric: "unsubscribed", userId: "42", objectType: "email" })
    const results = await receive()
    expect(results.map((r) => r.body)).toEqual([
      { received: true, applied: true },
      { received: true, applied: false },
    ])
    expect(receiver.duplicates).toHaveLength(1)
  })

  test("the signature is hex HMAC-SHA256 of v0:<timestamp>:<body>; a wrong key is 401", async () => {
    const { runtime, admin } = harness()
    const captured: Request[] = []
    const other = createRuntime({
      webhooks: {
        url: "http://backend.local/x",
        secret: "a-different-signing-key-0123456789abcdef",
        fetch: async (request) => {
          captured.push(request)
          return new Response(null, { status: 200 })
        },
      },
    })
    await other.fetch(
      new Request(`${API}/__admin/reporting-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metric: "unsubscribed", userId: "42" }),
      }),
    )
    await other.webhooks.idle()
    const receiver = new ReportingReceiver(SIGNING_KEY, new Set([42]))
    expect((await receiver.receive(captured[0] as Request)).status).toBe(401)
    // Independent check of the scheme with node:crypto.
    const { createHmac } = await import("node:crypto")
    const event = await admin<{ event_id: string }>("/reporting-events", {
      metric: "subscribed",
      userId: "42",
    })
    await runtime.webhooks.idle()
    const delivered = (
      await admin<{ events: { id: string; body: string }[] }>("/webhooks/events")
    ).events.find((e) => e.id === event.event_id)
    const deliveries = await admin<{ deliveries: { attempts: { status: number }[] }[] }>(
      "/webhooks",
    )
    expect(deliveries.deliveries[0]?.attempts[0]?.status).toBe(200)
    expect(delivered?.body).toContain('"metric":"subscribed"')
    const ts = "1700000000"
    const sig = createHmac("sha256", SIGNING_KEY)
      .update(`v0:${ts}:${delivered?.body}`)
      .digest("hex")
    const { signReporting } = await import("./src/index.js")
    expect(await signReporting(SIGNING_KEY, Number(ts), delivered?.body ?? "")).toBe(sig)
  })

  test("namespaces by App API key and CDP write key; the journal holds no message data", async () => {
    const { runtime, send } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { app_a: "a", write_a: "a" } }),
      }),
    )
    await sendCustomerIoTransactional({
      appApiHost: API,
      apiKey: "app_a",
      channel: "email",
      transactionalMessageId: "geviti_welcome",
      identifier: "42",
      to: "ada@example.com",
      messageData: { secretLabResult: "TSH 2.1" },
      tracked: false,
      disableMessageRetention: false,
      fetchImpl: send,
    })
    await runtime.fetch(
      new Request(`${API}/v1/identify`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa("write_a:")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: "42", traits: { email: "ada@example.com" } }),
      }),
    )
    const read = async (path: string) =>
      (await (await runtime.fetch(new Request(`${API}/__admin${path}`))).json()) as Record<
        string,
        unknown[]
      >
    expect((await read("/outbox")).messages).toHaveLength(0)
    expect((await read("/outbox?namespace=a")).messages).toHaveLength(1)
    expect((await read("/profiles?namespace=a")).profiles).toHaveLength(1)
    const journal = JSON.stringify(await read("/requests?namespace=a"))
    expect(journal).toContain("SendEmail")
    expect(journal).not.toContain("TSH 2.1")
    expect(journal).not.toContain("ada@example.com")
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(CUSTOMERIO_PRESETS)).toEqual(
      expect.arrayContaining([
        "transactional_message_missing",
        "transactional_404",
        "request_timeout_408",
        "server_error",
        "accepted_but_500",
        "rate_limited",
        "send_drop",
        "cdp_unavailable",
        "cdp_bad_request",
        "webhook_duplicate",
      ]),
    )
  })
})

describe("served over HTTP", () => {
  test("ECONNREFUSED is a definite failure; a served mock answers and posts signed webhooks", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() })
    const deadPort = closed.port
    closed.stop(true)
    const refused = await sendCustomerIoTransactional({
      appApiHost: `http://127.0.0.1:${deadPort}`,
      apiKey: "k",
      channel: "email",
      transactionalMessageId: "geviti_welcome",
      identifier: "1",
      to: "a@example.com",
      messageData: {},
      tracked: false,
      disableMessageRetention: false,
      // Production runs on Node, whose fetch (undici) reports a refused connection as
      // `TypeError` with `cause.code = "ECONNREFUSED"`; Bun says `code: "ConnectionRefused"`.
      fetchImpl: (r) =>
        fetch(r).catch((error: unknown) => {
          if ((error as { code?: string }).code !== "ConnectionRefused") throw error
          throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })
        }),
    }).catch((e: unknown) => e as CustomerIoTransactionalError)
    expect(refused).toBeInstanceOf(CustomerIoTransactionalError)
    expect((refused as CustomerIoTransactionalError).ambiguous).toBe(false)

    const receiver = new ReportingReceiver(SIGNING_KEY, new Set([42]))
    const results: unknown[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const outcome = await receiver.receive(request)
        results.push(outcome.body)
        return Response.json(outcome.body, { status: outcome.status })
      },
    })
    const server = await createServer({
      webhooks: {
        url: `http://127.0.0.1:${sink.port}${REPORTING_WEBHOOK_PATH}`,
        secret: SIGNING_KEY,
      },
    })
    try {
      const sent = await sendCustomerIoTransactional({
        appApiHost: server.url,
        apiKey: "k",
        channel: "email",
        transactionalMessageId: "geviti_welcome",
        identifier: "42",
        to: "a@example.com",
        messageData: {},
        tracked: false,
        disableMessageRetention: false,
        fetchImpl: (r) => fetch(r),
      })
      expect(sent.deliveryId).toBeTruthy()
      await fetch(`${server.url}/__admin/reporting-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metric: "unsubscribed", deliveryId: sent.deliveryId }),
      })
      const deadline = Date.now() + 3_000
      while (results.length < 1 && Date.now() < deadline) await Bun.sleep(25)
      expect(results).toEqual([{ received: true, applied: true }])
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^customerio@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})

describe("contract", () => {
  test("namespaces by header and by /ns/ prefix are isolated; reset clears one namespace", async () => {
    const runtime = createRuntime()
    const get = (url: string, headers: Record<string, string> = {}) =>
      runtime.fetch(new Request(url, { headers: { authorization: "Bearer k", ...headers } }))
    const base = "http://mock.local"
    // Seed state in namespace "a" through the header, then compare with "b" and the default.
    const before = (await (await get(`${base}/v1/transactional`)).json()) as Record<
      string,
      unknown[]
    >
    const viaHeader = await get(`${base}/v1/transactional`, { "x-mockingbird-namespace": "a" })
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/; ns=a$/)
    const viaPrefix = await get(`${base}/ns/b/v1/transactional`)
    expect(viaPrefix.status).toBe(viaHeader.status)
    expect(viaPrefix.headers.get("x-mockingbird")).toMatch(/; ns=b$/)
    expect(((await viaPrefix.json()) as Record<string, unknown[]>).messages?.length).toBe(
      before.messages?.length,
    )
    const reset = await runtime.fetch(
      new Request(`${base}/__admin/reset?namespace=a`, { method: "POST" }),
    )
    expect(reset.status).toBeLessThan(300)
    const health = (await (await runtime.fetch(new Request(`${base}/health`))).json()) as {
      status: string
    }
    expect(health.status).toBe("ok")
  })
})
