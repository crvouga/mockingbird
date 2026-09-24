import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  createRuntime,
  FULLSCRIPT_PRESETS,
  LAB_ORDER_STATES,
  SIGNATURE_HEADER,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  createClient,
  downloadVendorPdf,
  FakeEmr,
  type Fetch,
  FullscriptApiError,
  handleWebhook,
  recoverClinicEvents,
} from "./test/consumer.js"

const API = "https://api-us-snd.fullscript.mock/"
const SECRET = "fs-webhook-secret"
const CHALLENGE = "fs-challenge-key"
const REDIRECT = "https://emr.example.com/v1/fullscript/oauth/callback"
const ENV = { FULLSCRIPT_API_URL: API }

type Delivery = { headers: Headers; raw: Uint8Array }

/** A runtime whose webhooks land in our ported controller over an in-memory EMR. */
const harness = (options: { challenge?: string; receiverChallenge?: string } = {}) => {
  const emr = new FakeEmr()
  const deliveries: Delivery[] = []
  const runtime = createRuntime({
    webhooks: {
      url: "https://emr.example.com/v1/fullscript/webhooks",
      secret: SECRET,
      challenge: options.challenge ?? CHALLENGE,
      retryDelaysMs: [0],
      fetch: async (request) => {
        const raw = new Uint8Array(await request.arrayBuffer())
        deliveries.push({ headers: request.headers, raw })
        const result = handleWebhook({
          rawBody: raw,
          signatureHeader: request.headers.get(SIGNATURE_HEADER),
          secret: SECRET,
          challengeKey: options.receiverChallenge ?? CHALLENGE,
          emr,
        })
        return Response.json(result.body, { status: result.status })
      },
    },
  })
  const fetchImpl: Fetch = (input, init) => runtime.fetch(new Request(input, init))
  const { client, logs } = createClient({ apiUrl: API, fetch: fetchImpl, redirectUri: REDIRECT })
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  /** The practitioner connect flow: consent page redirect → code → token exchange. */
  const connect = async () => {
    const consent = await runtime.fetch(
      new Request(
        `${API}oauth/authorize?client_id=emr-client&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=xyz`,
      ),
    )
    const location = new URL(consent.headers.get("location") as string)
    return client.exchangeAuthorizationCode(location.searchParams.get("code") as string)
  }
  const order = async (patientId = "pat_1", treatmentPlanId = "tp_1") => {
    emr.treatmentPlans.add(treatmentPlanId)
    return (await (await admin("/lab-orders", { patientId, treatmentPlanId })).json()) as {
      id: string
    }
  }
  const move = (id: string, to: string) => admin(`/lab-orders/${id}/transition`, { to })
  return { runtime, emr, deliveries, client, logs, admin, connect, order, move, fetchImpl }
}

describe("S25 Fullscript acceptance: the EMR's integration against the mock", () => {
  test("OAuth: consent redirect with code and state, exchange, single-use codes, rotating refresh, revoke", async () => {
    const { runtime, client, connect } = harness()
    const consent = await runtime.fetch(
      new Request(
        `${API}oauth/authorize?client_id=emr-client&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=abc`,
      ),
    )
    expect(consent.status).toBe(302)
    const location = new URL(consent.headers.get("location") as string)
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
    expect(location.searchParams.get("state")).toBe("abc")
    const code = location.searchParams.get("code") as string
    const token = await client.exchangeAuthorizationCode(code)
    expect(token).toMatchObject({
      expiresIn: 7200,
      resourceOwner: { id: "prac_mock_1", type: "Practitioner", clinicId: "clinic_mock_1" },
    })
    const reused = await client.exchangeAuthorizationCode(code).catch((e: unknown) => e)
    expect(reused).toBeInstanceOf(FullscriptApiError)
    expect(reused).toMatchObject({ status: 400, code: "invalid_grant" })

    const rotated = await client.refreshAccessToken(token.refreshToken)
    expect(rotated.refreshToken).not.toBe(token.refreshToken)
    await expect(client.refreshAccessToken(token.refreshToken)).rejects.toMatchObject({
      status: 400,
      code: "invalid_grant",
    })

    const second = await connect()
    expect((await client.getClinic(second.accessToken)).id).toBe("clinic_mock_1")
    await client.revokeToken(second.accessToken)
    await expect(client.getClinic(second.accessToken)).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    })
  })

  test("tokens expire after 2 h on the mock clock; the refresh grant recovers", async () => {
    const { runtime, client, connect } = harness()
    const token = await connect()
    runtime.clock.advance(7_200_000)
    await expect(client.getClinic(token.accessToken)).rejects.toMatchObject({
      status: 401,
      code: "token_expired",
    })
    const refreshed = await client.refreshAccessToken(token.refreshToken)
    expect((await client.getClinic(refreshed.accessToken)).id).toBe("clinic_mock_1")
  })

  test("clinic and embeddable session grants", async () => {
    const { client, connect } = harness()
    const { accessToken } = await connect()
    expect(await client.getClinic(accessToken)).toEqual({ id: "clinic_mock_1" })
    const grant = await client.createSessionGrant(accessToken)
    expect(grant.secretToken).toMatch(/^sg_/)
  })

  test("lab orders go forward only, through every state, with results appearing as they should", async () => {
    const { client, connect, order, move } = harness()
    const { accessToken } = await connect()
    const { id } = await order()
    expect(await client.getLabOrder(accessToken, id)).toEqual({
      id,
      state: "not_purchased",
      treatmentPlanId: "tp_1",
    })
    for (const state of LAB_ORDER_STATES.slice(1)) {
      expect((await move(id, state)).status).toBe(200)
      const detail = await client.getLabOrderDetail(accessToken, id)
      expect(detail.state).toBe(state)
      expect(detail.tests.map((t) => t.testName)).toEqual([
        "Lipid Panel",
        "Comprehensive Metabolic Panel",
      ])
      const rank = LAB_ORDER_STATES.indexOf(state)
      expect(detail.results.length).toBe(rank < 5 ? 0 : rank === 5 ? 1 : 2)
      expect(detail.latestAggregatedResult === null).toBe(rank < 6)
    }
    // Backwards (and staying put) is refused.
    expect((await move(id, "processing")).status).toBe(409)
    expect((await move(id, "results_amended")).status).toBe(409)
    // Jumping forward is allowed.
    const other = await order("pat_2", "tp_2")
    expect((await move(other.id, "results_ready")).status).toBe(200)
    expect((await client.getLabOrderDetail(accessToken, other.id)).results).toHaveLength(2)
    expect(await client.listLabOrders(accessToken, "pat_1")).toEqual([
      { id, state: "results_amended", treatmentPlanId: "tp_1" },
    ])
  })

  test("webhooks: Fullscript-Signature verifies (our verifier and an independent HMAC), the EMR state follows monotonically", async () => {
    const { runtime, emr, deliveries, order, move } = harness()
    const { id } = await order()
    await move(id, "purchased")
    await move(id, "processing")
    await move(id, "partial_results")
    await runtime.webhooks.idle()
    expect(
      deliveries.map((d) => JSON.parse(new TextDecoder().decode(d.raw)).event_payload.event.type),
    ).toEqual(["order.placed", "lab_order.updated", "lab_order.updated", "lab_order.updated"])
    for (const delivery of deliveries) {
      const header = delivery.headers.get(SIGNATURE_HEADER) as string
      const [, t, v1] = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header) ?? []
      const expected = createHmac("sha256", SECRET)
        .update(`${t}.`)
        .update(delivery.raw)
        .digest("hex")
      expect(v1).toBe(expected)
      expect(Math.abs(Number(t) - Date.now() / 1000)).toBeLessThan(60)
    }
    expect(emr.stateOf(id)).toBe("partial_results")
    expect(emr.resultsDispatches).toEqual([{ clinicId: "clinic_mock_1", orderId: id }])
    const statuses = runtime.webhooks.deliveries().map((d) => d.state)
    expect(statuses.every((s) => s === "delivered")).toBe(true)
  })

  test("a receiver that does not echo the challenge is not acknowledged (Fullscript retries)", async () => {
    const { runtime, order, move } = harness({ receiverChallenge: "wrong-key" })
    const { id } = await order()
    await move(id, "purchased")
    await runtime.webhooks.idle()
    const attempts = runtime.webhooks.deliveries().flatMap((d) => d.attempts.map((a) => a.status))
    expect(attempts.every((s) => s === 502)).toBe(true)
  })

  test("registration verification: an empty-body ping must be answered with the challenge", async () => {
    const { admin } = harness()
    const verify = (await (await admin("/webhooks/verify", {})).json()) as {
      endpoints: { url: string; status: number; challengeEchoed: boolean }[]
    }
    expect(verify.endpoints).toEqual([
      { url: "https://emr.example.com/v1/fullscript/webhooks", status: 200, challengeEchoed: true },
    ])
  })

  test("duplicate deliveries are processed once; a dropped webhook is recovered by the events poller", async () => {
    const { runtime, emr, client, connect, order, move } = harness()
    const { accessToken } = await connect()
    const { id } = await order()
    await move(id, "purchased")
    runtime.applyPreset("webhook_duplicate")
    await move(id, "processing")
    await runtime.webhooks.idle()
    const processing = [...emr.processedEvents.keys()]
    expect(processing).toHaveLength(3)
    runtime.applyPreset("webhook_drop")
    await move(id, "results_ready")
    await runtime.webhooks.idle()
    expect(emr.stateOf(id)).toBe("processing")
    await recoverClinicEvents(client, accessToken, "clinic_mock_1", emr)
    expect(emr.stateOf(id)).toBe("results_ready")
    expect(emr.resultsDispatches.map((d) => d.orderId)).toEqual([id])
    const page = await client.listLabOrderEvents(accessToken, 1)
    expect(page.events.map((e) => e.type)).toEqual([
      "lab_order.updated",
      "lab_order.updated",
      "lab_order.updated",
    ])
    expect(page.nextPage).toBeNull()
  })

  test("result PDFs download through our guard: https, allowlisted host, application/pdf, %PDF- magic", async () => {
    const { runtime, client, connect, order, move, fetchImpl } = harness()
    const { accessToken } = await connect()
    const { id } = await order()
    await move(id, "results_ready")
    const detail = await client.getLabOrderDetail(accessToken, id)
    const pdfUrl = detail.latestAggregatedResult?.pdfUrl as string
    // The default allowlist includes FULLSCRIPT_API_URL's host, which is where the mock serves them.
    const pdf = await downloadVendorPdf(pdfUrl, fetchImpl, ENV)
    expect(pdf.byteSize).toBeGreaterThan(100)
    await expect(
      downloadVendorPdf(pdfUrl, fetchImpl, {
        FULLSCRIPT_RESULTS_PDF_HOST_ALLOWLIST: "fullscript.com",
      }),
    ).rejects.toThrow("host not allowlisted")
    for (const [preset, reason] of [
      ["pdf_not_pdf", "content-type was not application/pdf"],
      ["pdf_redirect", "redirect not allowed"],
      ["pdf_expired", "unexpected status 403"],
    ] as const) {
      runtime.applyPreset(preset, "default", { count: 1 })
      await expect(downloadVendorPdf(pdfUrl, fetchImpl, ENV)).rejects.toThrow(reason)
    }
    runtime.clock.advance(16 * 60_000)
    await expect(downloadVendorPdf(pdfUrl, fetchImpl, ENV)).rejects.toThrow("unexpected status 403")
  })

  test("presets: token_expired, invalid_grant, rate limit, events schema drift, dropped connection", async () => {
    const { runtime, client, connect, logs } = harness()
    const token = await connect()
    // One rule per API family (clinic, events): count applies to each.
    runtime.applyPreset("token_expired", "default", { count: 1 })
    await expect(client.getClinic(token.accessToken)).rejects.toMatchObject({
      status: 401,
      code: "token_expired",
    })
    await expect(client.listLabOrderEvents(token.accessToken, 1)).rejects.toMatchObject({
      status: 401,
      code: "token_expired",
    })
    runtime.applyPreset("invalid_grant", "default", { count: 1 })
    await expect(client.refreshAccessToken(token.refreshToken)).rejects.toMatchObject({
      status: 400,
      code: "invalid_grant",
    })
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    await expect(client.getClinic(token.accessToken)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    })
    runtime.applyPreset("events_schema_drift", "default", { count: 1 })
    await runtime.fetch(
      new Request(`${API}__admin/lab-orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId: "p" }),
      }),
    )
    const [created] = (await (await runtime.fetch(new Request(`${API}__admin/lab-orders`))).json())
      .orders as { id: string }[]
    await runtime.fetch(
      new Request(`${API}__admin/lab-orders/${created?.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "purchased" }),
      }),
    )
    await expect(client.listLabOrderEvents(token.accessToken, 1)).rejects.toThrow(
      "Fullscript lab order events response was invalid",
    )
    runtime.applyPreset("connection_drop", "default", { count: 1 })
    await expect(client.getClinic(token.accessToken)).rejects.toThrow(
      "Fullscript request did not complete",
    )
    expect(logs.some((l) => l.operation === "clinic_retrieve" && l.status === 429)).toBe(true)
    expect(Object.keys(FULLSCRIPT_PRESETS)).toEqual(
      expect.arrayContaining(["webhook_duplicate", "webhook_drop", "pdf_redirect"]),
    )
  })

  test("namespaces by /ns/ prefix on FULLSCRIPT_API_URL, by header, and by OAuth client; no bodies in the journal", async () => {
    const { runtime, fetchImpl } = harness()
    const a = createClient({
      apiUrl: `${API}ns/a/`,
      fetch: fetchImpl,
      redirectUri: REDIRECT,
    }).client
    const consent = await runtime.fetch(
      new Request(
        `${API}ns/a/oauth/authorize?client_id=emr-client&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      ),
    )
    const code = new URL(consent.headers.get("location") as string).searchParams.get(
      "code",
    ) as string
    const token = await a.exchangeAuthorizationCode(code)
    await runtime.fetch(
      new Request(`${API}__admin/lab-orders?namespace=a`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId: "pat_ns" }),
      }),
    )
    expect(await a.listLabOrders(token.accessToken, "pat_ns")).toHaveLength(1)
    const defaultNs = createClient({ apiUrl: API, fetch: fetchImpl }).client
    expect(await defaultNs.listLabOrders(token.accessToken, "pat_ns")).toHaveLength(0)
    await runtime.fetch(
      new Request(`${API}__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "emr-client": "a" } }),
      }),
    )
    expect(await defaultNs.listLabOrders(token.accessToken, "pat_ns")).toHaveLength(1)
    const viaHeader = await runtime.fetch(
      new Request(`${API}api/clinic`, {
        headers: { authorization: `Bearer ${token.accessToken}`, "x-mockingbird-namespace": "a" },
      }),
    )
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/^fullscript@.*; ns=a$/)
    const journal = JSON.stringify(
      await (await runtime.fetch(new Request(`${API}__admin/requests?namespace=a`))).json(),
    )
    expect(journal).not.toContain("emr-secret")
    expect(journal).not.toContain(code)
  })
})

describe("served over HTTP", () => {
  test("OAuth and signed webhooks against the node server, received on a Bun.serve sink", async () => {
    const emr = new FakeEmr()
    emr.treatmentPlans.add("tp_http")
    // Resolved by the delivery that brings an order to results_ready, so the test waits on the
    // webhook itself rather than a wall-clock deadline a loaded CI runner can overrun.
    const resultsReady = Promise.withResolvers<void>()
    let orderId: string | undefined
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const result = handleWebhook({
          rawBody: new Uint8Array(await request.arrayBuffer()),
          signatureHeader: request.headers.get(SIGNATURE_HEADER),
          secret: SECRET,
          challengeKey: CHALLENGE,
          emr,
        })
        if (orderId && emr.stateOf(orderId) === "results_ready") resultsReady.resolve()
        return Response.json(result.body, { status: result.status })
      },
    })
    const server = await createServer({
      webhooks: {
        url: `http://127.0.0.1:${sink.port}/v1/fullscript/webhooks`,
        secret: SECRET,
        challenge: CHALLENGE,
      },
    })
    try {
      const { client } = createClient({
        apiUrl: server.url,
        fetch: (i, n) => fetch(i, n),
        redirectUri: REDIRECT,
      })
      const consent = await fetch(
        `${server.url}/oauth/authorize?client_id=emr-client&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        { redirect: "manual" },
      )
      const code = new URL(consent.headers.get("location") as string).searchParams.get(
        "code",
      ) as string
      const token = await client.exchangeAuthorizationCode(code)
      const created = (await (
        await fetch(`${server.url}/__admin/lab-orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patientId: "pat_http", treatmentPlanId: "tp_http" }),
        })
      ).json()) as { id: string }
      orderId = created.id
      await fetch(`${server.url}/__admin/lab-orders/${created.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "results_ready" }),
      })
      await resultsReady.promise
      expect(emr.stateOf(created.id)).toBe("results_ready")
      expect((await client.getLabOrder(token.accessToken, created.id)).state).toBe("results_ready")
    } finally {
      await server.close()
      sink.stop(true)
    }
  }, 30_000)
})
