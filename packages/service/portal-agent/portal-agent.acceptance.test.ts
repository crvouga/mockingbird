import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createRuntime, PORTAL_AGENT_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  applyDispatchResult,
  applyPortalAgentResult,
  buildPayload,
  type ErxFulfillmentResult,
  newPayment,
  type PaymentRecord,
  PORTAL_CREDENTIALS,
  PortalAgentConsumer,
  receiveCallback,
  sampleRequest,
} from "./test/consumer.js"

const API = "http://portal-agent.mock"
const API_KEY = "portal-agent-api-key"
const CALLBACK_KEY = "portal-agent-callback-key"

/** A runtime whose callbacks land in an in-memory receiver running our controller's logic. */
const harness = (options: { apiKeys?: string[] } = {}) => {
  const deliveries: { headers: Headers; body: unknown }[] = []
  const runtime = createRuntime({
    ...(options.apiKeys ? { settings: { apiKeys: options.apiKeys } } : {}),
    webhooks: {
      url: "http://backend.local/prescriptions/webhooks/portal-agent",
      secret: CALLBACK_KEY,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, body: await request.json() })
        return Response.json({ received: true }, { status: 202 })
      },
    },
  })
  const consumer = new PortalAgentConsumer(API, API_KEY, (request) => runtime.fetch(request))
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  /** Deliver pending callbacks through the receiver and apply accepted ones to `payment`. */
  const receive = async (payment: PaymentRecord) => {
    await runtime.webhooks.idle()
    const outcomes: string[] = []
    for (const delivery of deliveries.splice(0)) {
      const received = receiveCallback(CALLBACK_KEY, delivery.headers, delivery.body)
      if (received.status !== 202) {
        outcomes.push(String(received.status))
        continue
      }
      outcomes.push(applyPortalAgentResult(payment, received.callback))
    }
    return outcomes
  }
  const dispatch = async (paymentId: string, payment = newPayment(paymentId)) => {
    const request = sampleRequest(paymentId)
    const result = await consumer.dispatch(request, buildPayload(request, PORTAL_CREDENTIALS))
    applyDispatchResult(payment, result)
    return { result, payment }
  }
  return { runtime, consumer, deliveries, admin, receive, dispatch }
}

const jobIdOf = (result: ErxFulfillmentResult) => result.pharmacyOrderId as string

describe("S12.4 acceptance: our consumer's logic against the mock", () => {
  test("dispatch → accepted → callbacks move the payment submitted → processing → shipped", async () => {
    const { dispatch, admin, receive } = harness()
    const { result, payment } = await dispatch("pay_1001")
    expect(result).toMatchObject({
      success: true,
      fulfillmentStatus: "processing",
      portalAgentStatus: "accepted",
    })
    const jobId = jobIdOf(result)
    expect(jobId).toMatch(/^job_/)
    expect(payment.fulfillmentStatus).toBe("processing")

    const complete = (body: unknown) => admin(`/jobs/${jobId}/complete`, body)
    expect((await complete({ status: "submitted" })).status).toBe(200)
    expect(await receive(payment)).toEqual(["applied"])
    expect(payment.fulfillmentStatus).toBe("submitted")
    expect(payment.pharmacyOrderId).toMatch(/^LF-/)
    expect(payment.pharmacyStatus).toBe("portal_agent_submitted")

    await complete({ status: "submitted", fulfillmentStatus: "processing" })
    expect(await receive(payment)).toEqual(["applied"])
    expect(payment.fulfillmentStatus).toBe("processing")

    await complete({
      status: "submitted",
      fulfillmentStatus: "shipped",
      trackingNumber: "1ZPORTAL",
      trackingCarrier: "UPS",
    })
    expect(await receive(payment)).toEqual(["applied"])
    expect(payment).toMatchObject({
      fulfillmentStatus: "shipped",
      trackingNumber: "1ZPORTAL",
      trackingCarrier: "UPS",
    })

    // Catalog discrepancy: S12 expects every pharmacy to reach `delivered`. Our consumer
    // protects `shipped` (PORTAL_CALLBACK_PROTECTED_STATUSES), so a delivered callback is
    // delivered and accepted by the controller (202) but ignored by handlePortalAgentResult.
    await complete({ status: "submitted", fulfillmentStatus: "delivered" })
    expect(await receive(payment)).toEqual(["ignored"])
    expect(payment.fulfillmentStatus).toBe("shipped")
  })

  test("draft_ready synchronously and via callback", async () => {
    const sync = harness()
    sync.runtime.applyPreset("respond_draft_ready", "default", { count: 1 })
    const { result } = await sync.dispatch("pay_2001")
    expect(result).toMatchObject({
      success: false,
      fulfillmentStatus: "processing",
      portalAgentStatus: "draft_ready",
    })
    expect(result.portalDraftOrderId).toMatch(/^DRAFT-/)
    expect(result.pharmacyOrderId).toBe(result.portalDraftOrderId as string)

    const later = harness()
    const { result: accepted, payment } = await later.dispatch("pay_2002")
    await later.admin(`/jobs/${jobIdOf(accepted)}/complete`, { status: "draft_ready" })
    expect(await later.receive(payment)).toEqual(["applied"])
    expect(payment).toMatchObject({
      fulfillmentStatus: "processing",
      portalAgentStatus: "draft_ready",
    })
    expect(payment.pharmacyOrderId).toMatch(/^DRAFT-/)
  })

  test("needs_review and error, synchronously and via callback", async () => {
    const a = harness()
    a.runtime.applyPreset("respond_needs_review", "default", { count: 1 })
    expect((await a.dispatch("pay_3001")).result).toMatchObject({
      success: false,
      fulfillmentStatus: "error",
      portalAgentStatus: "needs_review",
      error: "Portal agent needs review: Portal product could not be matched",
    })
    const b = harness()
    b.runtime.applyPreset("respond_error", "default", { count: 1 })
    expect((await b.dispatch("pay_3002")).result).toMatchObject({
      success: false,
      fulfillmentStatus: "error",
      portalAgentStatus: "error",
      error: "The pharmacy portal rejected the order",
    })

    const c = harness()
    const { result, payment } = await c.dispatch("pay_3003")
    await c.admin(`/jobs/${jobIdOf(result)}/complete`, {
      status: "needs_review",
      needsReviewReason: "Product variant missing",
    })
    await c.receive(payment)
    expect(payment).toMatchObject({
      fulfillmentStatus: "error",
      fulfillmentError: "Portal agent needs review: Product variant missing",
    })
    const d = harness()
    const second = await d.dispatch("pay_3004")
    await d.admin(`/jobs/${jobIdOf(second.result)}/complete`, {
      status: "error",
      errorCode: "login_failed",
      errorDetail: "LifeFile rejected the credentials",
    })
    await d.receive(second.payment)
    expect(second.payment.fulfillmentError).toBe(
      "Portal agent error: LifeFile rejected the credentials",
    )
  })

  test("settings.respondWith answers submitted synchronously", async () => {
    const { admin, dispatch } = harness()
    await admin("/settings", { respondWith: { status: "submitted" } }, "PUT")
    const { result } = await dispatch("pay_4001")
    expect(result).toMatchObject({ success: true, fulfillmentStatus: "submitted" })
    expect(result.pharmacyOrderId).toMatch(/^LF-/)
    expect(result.pharmacyStatus).toMatch(/^portal_agent_submitted submittedAt=/)
  })

  test("every strict-rule preset is rejected by our parser", async () => {
    for (const preset of [
      "accepted_without_job_id",
      "submitted_without_order_id",
      "draft_ready_without_draft_id",
      "non_string_field",
    ]) {
      const { runtime, dispatch } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      expect((await dispatch(`pay_${preset}`)).result).toEqual({
        success: false,
        fulfillmentStatus: "error",
        portalAgentStatus: "error",
        error: "Portal agent returned an invalid success response",
      })
    }
  })

  test("http_500 surfaces errorDetail; timeout takes the network-error branch", async () => {
    const a = harness()
    a.runtime.applyPreset("http_500", "default", { count: 1 })
    expect((await a.dispatch("pay_5001")).result).toEqual({
      success: false,
      fulfillmentStatus: "error",
      portalAgentStatus: "error",
      error: "Portal agent browser pool exhausted",
    })
    const b = harness()
    b.runtime.applyPreset("timeout", "default", { count: 1 })
    const dropped = (await b.dispatch("pay_5002")).result
    expect(dropped.success).toBe(false)
    expect(dropped.error).toMatch(/^Portal agent request failed: /)
  })

  test("the receiver rejects a wrong x-internal-key and a callback it would not accept", async () => {
    const { runtime, dispatch, admin, deliveries } = harness()
    const { result } = await dispatch("pay_6001")
    await admin(`/jobs/${jobIdOf(result)}/complete`, { status: "submitted" })
    await runtime.webhooks.idle()
    const [delivery] = deliveries.splice(0)
    if (!delivery) throw new Error("no callback delivered")
    expect(delivery.headers.get("x-internal-key")).toBe(CALLBACK_KEY)
    expect(receiveCallback("another-key", delivery.headers, delivery.body).status).toBe(401)
    expect(receiveCallback(undefined, delivery.headers, delivery.body).status).toBe(401)

    // The admin route refuses a callback the controller would 400 on, unless forced.
    const bad = await admin(`/jobs/${jobIdOf(result)}/complete`, {
      status: "submitted",
      fulfillmentStatus: "teleported",
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { type: string } }).error.type).toBe("mockingbird_admin")
    const forced = await admin(`/jobs/${jobIdOf(result)}/complete?force=1`, {
      status: "draft_ready",
      portalDraftOrderId: "",
    })
    expect(forced.status).toBe(200)
    await runtime.webhooks.idle()
    const [rejected] = deliveries.splice(0)
    expect(receiveCallback(CALLBACK_KEY, rejected?.headers as Headers, rejected?.body).status).toBe(
      400,
    )
  })

  test("the same idempotency key replays the job; a different payload is a 409", async () => {
    const { runtime, consumer, admin } = harness()
    const request = sampleRequest("pay_7001")
    const payload = buildPayload(request, PORTAL_CREDENTIALS)
    const first = await consumer.dispatch(request, payload)
    const again = await consumer.dispatch(request, payload)
    expect(again).toEqual(first)
    const jobs = (await (await admin("/jobs")).json()) as { jobs: unknown[] }
    expect(jobs.jobs).toHaveLength(1)
    const changed = await consumer.dispatch(request, { ...payload, quantity: 20 })
    expect(changed).toMatchObject({ success: false, fulfillmentStatus: "error" })
    expect(changed.error).toMatch(/already used with a different payload/)
    expect(runtime.instance().jobs()).toHaveLength(1)
  })

  test("a wrong or missing bearer key is 401 when keys are configured", async () => {
    const { runtime } = harness({ apiKeys: ["the-right-key"] })
    const request = sampleRequest("pay_8001")
    const wrong = new PortalAgentConsumer(API, "wrong-key", (r) => runtime.fetch(r))
    expect(await wrong.dispatch(request, buildPayload(request, PORTAL_CREDENTIALS))).toEqual({
      success: false,
      fulfillmentStatus: "error",
      portalAgentStatus: "error",
      error: "Missing or invalid bearer token",
    })
    const right = new PortalAgentConsumer(API, "the-right-key", (r) => runtime.fetch(r))
    expect((await right.dispatch(request, buildPayload(request, PORTAL_CREDENTIALS))).success).toBe(
      true,
    )
  })

  test("an invalid payload is a 400 naming the field", async () => {
    const { consumer } = harness()
    const request = sampleRequest("pay_8101")
    const payload = buildPayload(request, { ...PORTAL_CREDENTIALS, url: "http://insecure" })
    const result = await consumer.dispatch(request, payload)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/portalCredentials\.url/)
  })

  test("the journal and job store hold no credentials or PHI; namespaces by bearer key isolate workers", async () => {
    const { runtime, admin } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "key-a": "a", "key-b": "b" } }),
      }),
    )
    const request = sampleRequest("pay_9001")
    const a = new PortalAgentConsumer(API, "key-a", (r) => runtime.fetch(r))
    const placed = await a.dispatch(request, buildPayload(request, PORTAL_CREDENTIALS))
    const inA = (await (await admin("/jobs?namespace=a")).json()) as { jobs: unknown[] }
    const inB = (await (await admin("/jobs?namespace=b")).json()) as { jobs: unknown[] }
    expect(inA.jobs).toHaveLength(1)
    expect(inB.jobs).toHaveLength(0)
    const journal = await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=a`))
    ).text()
    expect(journal).toContain(placed.pharmacyOrderId as string)
    for (const secret of [PORTAL_CREDENTIALS.password, PORTAL_CREDENTIALS.username, "Lovelace"]) {
      expect(journal).not.toContain(secret)
      expect(JSON.stringify(inA)).not.toContain(secret)
    }
  })

  test("callback delivery presets: duplicate is idempotent for our receiver", async () => {
    const { runtime, dispatch, admin, receive } = harness()
    const { result, payment } = await dispatch("pay_9101")
    runtime.applyPreset("callback_duplicate", "default")
    await admin(`/jobs/${jobIdOf(result)}/complete`, { status: "submitted" })
    expect(await receive(payment)).toEqual(["applied", "applied"])
    expect(payment.fulfillmentStatus).toBe("submitted")
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(PORTAL_AGENT_PRESETS)).toEqual(
      expect.arrayContaining([
        "respond_submitted",
        "respond_draft_ready",
        "respond_needs_review",
        "respond_error",
        "accepted_without_job_id",
        "submitted_without_order_id",
        "draft_ready_without_draft_id",
        "non_string_field",
        "http_500",
        "timeout",
        "slow",
      ]),
    )
  })

  test("the callback key header is the plain secret (independent check)", async () => {
    const { runtime, dispatch, admin, deliveries } = harness()
    const { result } = await dispatch("pay_9201")
    await admin(`/jobs/${jobIdOf(result)}/complete`, { status: "submitted" })
    await runtime.webhooks.idle()
    const header = deliveries[0]?.headers.get("x-internal-key") ?? ""
    // Plain equality, not an HMAC: the header never looks like a signature of the body.
    const hmac = createHmac("sha256", CALLBACK_KEY)
      .update(JSON.stringify(deliveries[0]?.body))
      .digest("hex")
    expect(header).toBe(CALLBACK_KEY)
    expect(header).not.toBe(hmac)
  })
})

describe("contract/runtime", () => {
  test("/health, namespaces by header and by /ns/ prefix", async () => {
    const { runtime, admin } = harness()
    const health = await runtime.fetch(new Request(`${API}/health`))
    expect(((await health.json()) as { status: string; service: string }).status).toBe("ok")
    const request = sampleRequest("pay_ns")
    const payload = buildPayload(request, PORTAL_CREDENTIALS)
    const viaHeader = new PortalAgentConsumer(API, API_KEY, (r) => {
      const headers = new Headers(r.headers)
      headers.set("x-mockingbird-namespace", "h")
      return runtime.fetch(new Request(r, { headers }))
    })
    const viaPrefix = new PortalAgentConsumer(`${API}/ns/p`, API_KEY, (r) => runtime.fetch(r))
    expect((await viaHeader.dispatch(request, payload)).success).toBe(true)
    expect((await viaPrefix.dispatch(request, payload)).success).toBe(true)
    for (const ns of ["h", "p"]) {
      const jobs = (await (await admin(`/jobs?namespace=${ns}`)).json()) as { jobs: unknown[] }
      expect(jobs.jobs).toHaveLength(1)
    }
    const jobs = (await (await admin("/jobs")).json()) as { jobs: unknown[] }
    expect(jobs.jobs).toHaveLength(0)
  })
})

describe("served over HTTP", () => {
  test("dispatch against the node server, callback on a Bun.serve sink, timeout via latency", async () => {
    const received: unknown[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const outcome = receiveCallback(CALLBACK_KEY, request.headers, await request.json())
        if (outcome.status === 202) received.push(outcome.callback)
        return Response.json({ received: true }, { status: outcome.status })
      },
    })
    const server = await createServer({
      webhooks: {
        url: `http://127.0.0.1:${sink.port}/prescriptions/webhooks/portal-agent`,
        secret: CALLBACK_KEY,
      },
    })
    try {
      const consumer = new PortalAgentConsumer(server.url, API_KEY, (r) => fetch(r))
      const request = sampleRequest("pay_http")
      const result = await consumer.dispatch(request, buildPayload(request, PORTAL_CREDENTIALS))
      expect(result.success).toBe(true)
      await fetch(`${server.url}/__admin/jobs/${jobIdOf(result)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "submitted", fulfillmentStatus: "shipped" }),
      })
      const deadline = Date.now() + 3_000
      while (received.length < 1 && Date.now() < deadline) await Bun.sleep(25)
      expect(received).toHaveLength(1)
      expect((received[0] as { fulfillmentStatus: string }).fulfillmentStatus).toBe("shipped")

      // Our client aborts after ERX_PORTAL_AGENT_HTTP_TIMEOUT_MS (20 s by default; 100 ms here).
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "CreatePortalFulfillmentJob",
          latencyMs: 1_000,
          count: 1,
        }),
      })
      const impatient = new PortalAgentConsumer(server.url, API_KEY, (r) => fetch(r), 100)
      const slow = sampleRequest("pay_slow")
      expect(await impatient.dispatch(slow, buildPayload(slow, PORTAL_CREDENTIALS))).toEqual({
        success: false,
        fulfillmentStatus: "error",
        portalAgentStatus: "error",
        error: "Portal agent request timed out after 100ms",
      })
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^portal-agent@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
