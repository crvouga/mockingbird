import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createRuntime, PERSONA_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  handlePersonaWebhook,
  type PersonaConfig,
  PersonaConsumer,
  receivePersonaWebhook,
  verificationEffect,
  type WebhookResult,
} from "./test/consumer.js"

const MOCK = "http://persona.mock"
const SECRET = "wbhsec_persona_test"
const API_KEY = "persona_sandbox_acme"
const config = (base = MOCK): PersonaConfig => ({
  PERSONA_API_URL: base,
  PERSONA_API_KEY: API_KEY,
  PERSONA_WEB_INQUIRY_URL: `${base}/verify`,
  PERSONA_MOBILE_INQUIRY_URL: `${base}/verify`,
  PERSONA_IDENTITY_INQUIRY_TEMPLATE_ID: "itmpl_identity",
  PERSONA_PHONE_INQUIRY_TEMPLATE_ID: "itmpl_phone",
  PERSONA_WEBHOOK_SECRET: SECRET,
})
const REDIRECT = "https://app.acme.local/rx/verify/done"

type Delivery = { headers: Headers; raw: string }

/** A runtime whose webhooks land in memory, and our EMR's Persona client pointed at it. */
const harness = () => {
  const deliveries: Delivery[] = []
  const runtime = createRuntime({
    settings: { apiKeys: [API_KEY] },
    webhooks: {
      url: "http://emr.local/v1/identify-verification/webhook",
      secret: SECRET,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, raw: await request.text() })
        return Response.json({ ok: true })
      },
    },
  })
  const consumer = new PersonaConsumer(config(), (r) => runtime.fetch(r))
  const admin = (path: string, body: unknown = {}) =>
    runtime.fetch(
      new Request(`${MOCK}/__admin${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  /** Every delivery so far, through our receiver (signature verified, payload parsed). */
  const receive = async () => {
    await runtime.webhooks.idle()
    return deliveries.splice(0).map((d) => receivePersonaWebhook(SECRET, d.headers, d.raw))
  }
  return { runtime, consumer, admin, receive, deliveries }
}

const idOf = (url: string) => new URL(url).searchParams.get("inquiry-id") as string

describe("S22 acceptance: our EMR's Persona client and receiver against the mock", () => {
  test("create → reuse → hosted flow → approve: the receiver verifies and sees completed, then approved", async () => {
    const { runtime, consumer, receive } = harness()
    const created = await consumer.createInquiry({
      referenceId: "patient-123",
      redirectUri: REDIRECT,
      verificationType: "identity",
      prefillFields: { "name-first": "Ada", "name-last": "Lovelace", birthdate: "1990-01-01" },
    })
    expect(created.reused).toBe(false)
    expect(created.referenceId).toBe("patient-123")
    const inquiryId = idOf(created.inquiryUrl)
    expect(inquiryId).toMatch(/^inq_[A-Za-z0-9]{24}$/)
    expect(created.inquiryUrl).toBe(
      `${MOCK}/verify?inquiry-id=${inquiryId}&redirect-uri=${encodeURIComponent(REDIRECT)}`,
    )
    // A member coming back gets the SAME inquiry (created/pending, same template).
    const again = await consumer.createInquiry({
      referenceId: "patient-123",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    expect([again.reused, idOf(again.inquiryUrl)]).toEqual([true, inquiryId])
    // A different template is a different inquiry.
    const phone = await consumer.createInquiry({
      referenceId: "patient-123",
      redirectUri: REDIRECT,
      verificationType: "phone",
    })
    expect(idOf(phone.inquiryUrl)).not.toBe(inquiryId)

    // The hosted page starts it; it is still reusable while pending.
    const page = await runtime.fetch(new Request(created.inquiryUrl))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect((await consumer.getInquiry(inquiryId)).status).toBe("pending")
    expect(
      idOf(
        (
          await consumer.createInquiry({
            referenceId: "patient-123",
            redirectUri: REDIRECT,
            verificationType: "identity",
          })
        ).inquiryUrl,
      ),
    ).toBe(inquiryId)
    const approve = /href="([^"]*outcome=approve[^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&")
    expect(approve).toBeDefined()
    const done = await runtime.fetch(new Request(new URL(approve as string, created.inquiryUrl)))
    expect(done.status).toBe(302)
    const back = new URL(done.headers.get("location") as string)
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(Object.fromEntries(back.searchParams)).toEqual({
      "inquiry-id": inquiryId,
      status: "approved",
      "reference-id": "patient-123",
    })

    const outcomes = await receive()
    expect(outcomes.every((o) => o.status === 200)).toBe(true)
    const results = outcomes.map((o) => o.body as WebhookResult)
    // Deliveries run concurrently (arrival order may vary); publication order is the lifecycle.
    const mine = results.filter((r) => r.inquiryId === inquiryId).map((r) => r.status)
    expect(mine.sort()).toEqual(["approved", "completed", "created", "pending"])
    const published = runtime.webhooks
      .messages("default")
      .map((m) => handlePersonaWebhook(JSON.parse(m.body)))
      .filter((r) => r.inquiryId === inquiryId)
      .map((r) => r.status)
    expect(published).toEqual(["created", "pending", "completed", "approved"])
    const completed = results.find((r) => r.inquiryId === inquiryId && r.status === "completed")
    expect(completed).toEqual({
      inquiryId,
      status: "completed",
      referenceId: "patient-123",
      inquiryTemplateId: "itmpl_identity",
    })
    // Our business logic acts on `completed` only (approved alone would do nothing).
    expect(verificationEffect(config(), completed as WebhookResult)).toBe("identity-verified")
    expect(
      verificationEffect(config(), { ...(completed as WebhookResult), status: "approved" }),
    ).toBe("none")
    expect((await consumer.getInquiry(inquiryId)).status).toBe("approved")
    // Approved is not reusable: the next create mints a fresh inquiry.
    const fresh = await consumer.createInquiry({
      referenceId: "patient-123",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    expect(fresh.reused).toBe(false)
  })

  test("admin decline / needs_review / fail / expire emit Persona's events; illegal moves are refused", async () => {
    const { consumer, admin, receive, runtime } = harness()
    const make = async (ref: string) =>
      idOf(
        (
          await consumer.createInquiry({
            referenceId: ref,
            redirectUri: REDIRECT,
            verificationType: "phone",
          })
        ).inquiryUrl,
      )
    const declined = await make("p-decline")
    const review = await make("p-review")
    const failed = await make("p-fail")
    const expired = await make("p-expire")
    await receive()
    expect((await admin(`/inquiries/${declined}/decline`)).status).toBe(200)
    expect((await admin(`/inquiries/${review}/needs_review`)).status).toBe(200)
    expect((await admin(`/inquiries/${failed}/fail`)).status).toBe(200)
    expect((await admin(`/inquiries/${expired}/expire`)).status).toBe(200)
    await runtime.webhooks.idle()
    const names = runtime.webhooks
      .messages("default")
      .map(
        (m) =>
          JSON.parse(m.body) as {
            data: { attributes: { name: string; payload: { data: { id: string } } } }
          },
      )
      .map(
        (e) =>
          `${e.data.attributes.payload.data.id === declined ? "D" : e.data.attributes.payload.data.id === review ? "R" : e.data.attributes.payload.data.id === failed ? "F" : e.data.attributes.payload.data.id === expired ? "E" : "?"}:${e.data.attributes.name}`,
      )
      .filter((n) => !n.endsWith("inquiry.created"))
    expect(names).toEqual([
      "D:inquiry.started",
      "D:inquiry.completed",
      "D:inquiry.declined",
      "R:inquiry.started",
      "R:inquiry.completed",
      "R:inquiry.marked-for-review",
      "F:inquiry.started",
      "F:inquiry.failed",
      "E:inquiry.expired",
    ])
    const statuses = await Promise.all(
      [declined, review, failed, expired].map((id) => consumer.getInquiry(id)),
    )
    expect(statuses.map((s) => s.status)).toEqual(["declined", "needs_review", "failed", "expired"])
    // needs_review can still be decided; a declined inquiry cannot.
    expect((await admin(`/inquiries/${review}/approve`)).status).toBe(200)
    expect((await admin(`/inquiries/${declined}/approve`)).status).toBe(409)
    expect((await admin("/inquiries/inq_missing/approve")).status).toBe(404)
    // The receiver verifies every one of them.
    expect((await receive()).every((o) => o.status === 200)).toBe(true)
  })

  test("list_fails: the reusable-inquiry lookup fails open and a new inquiry is created", async () => {
    const { consumer, runtime } = harness()
    const first = await consumer.createInquiry({
      referenceId: "p-1",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    runtime.applyPreset("list_fails", "default", { count: 1 })
    const second = await consumer.createInquiry({
      referenceId: "p-1",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    expect(second.reused).toBe(false)
    expect(idOf(second.inquiryUrl)).not.toBe(idOf(first.inquiryUrl))
  })

  test("errors compose our message from JSON:API titles and details (string status)", async () => {
    const { consumer, runtime } = harness()
    await expect(consumer.getInquiry("inq_000000000000000000000000")).rejects.toThrow(
      "Failed to call Persona API: 404  - Record not found: Could not find the requested inquiry",
    )
    runtime.applyPreset("create_fails", "default", { count: 1 })
    await expect(
      consumer.createInquiry({
        referenceId: "p-2",
        redirectUri: REDIRECT,
        verificationType: "identity",
      }),
    ).rejects.toThrow("500  - Internal Server Error: Something went wrong")
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    await expect(consumer.getInquiry("inq_x")).rejects.toThrow(
      "429  - Too Many Requests: Rate limit exceeded",
    )
    const wrongKey = new PersonaConsumer(
      { ...config(), PERSONA_API_KEY: "persona_sandbox_revoked" },
      (r) => runtime.fetch(r),
    )
    await expect(wrongKey.getInquiry("inq_x")).rejects.toThrow(
      "401  - Must be authenticated to access this endpoint",
    )
    runtime.applyPreset("unauthorized", "default", { count: 1 })
    await expect(consumer.getInquiry("inq_x")).rejects.toThrow("401")
  })

  test("signatures: an independent HMAC matches; mismatched and short signatures hit our receiver's 401 and 500", async () => {
    const { consumer, admin, deliveries, runtime } = harness()
    await consumer.createInquiry({
      referenceId: "p-sig",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    await runtime.webhooks.idle()
    const [ok] = deliveries.splice(0)
    const header = ok?.headers.get("persona-signature") as string
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
    expect(match).not.toBeNull()
    const [, t, v1] = match as RegExpExecArray
    expect(createHmac("sha256", SECRET).update(`${t}.${ok?.raw}`).digest("hex")).toBe(v1 as string)
    // Wall-clock timestamp, even with the mock clock far in the future.
    expect(Math.abs(Number(t) - Date.now() / 1000)).toBeLessThan(60)

    expect((await admin("/signature-faults", { mode: "mismatch" })).status).toBe(201)
    expect((await admin("/signature-faults", { mode: "short" })).status).toBe(201)
    await consumer.createInquiry({
      referenceId: "p-sig2",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    await consumer.createInquiry({
      referenceId: "p-sig3",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    await consumer.createInquiry({
      referenceId: "p-sig4",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    await runtime.webhooks.idle()
    const outcomes = deliveries
      .splice(0)
      .map((d) => receivePersonaWebhook(SECRET, d.headers, d.raw).status)
    // Known consumer bug: a signature of a different length makes timingSafeEqual throw → 500.
    // (Deliveries run concurrently, so compare them unordered.)
    expect(outcomes.sort()).toEqual([200, 401, 500])
    // A missing header is the receiver's 400.
    expect(receivePersonaWebhook(SECRET, new Headers(), "{}").status).toBe(400)
  })

  test("webhook presets: duplicate delivery is idempotent for our parser; drop delivers nothing", async () => {
    const { consumer, runtime, receive } = harness()
    runtime.applyPreset("webhook_duplicate", "default", { count: 1 })
    await consumer.createInquiry({
      referenceId: "p-dup",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    const dup = await receive()
    expect(dup).toHaveLength(2)
    expect(dup[0]?.body).toEqual(dup[1]?.body)
    runtime.applyPreset("webhook_drop", "default", { count: 1 })
    await consumer.createInquiry({
      referenceId: "p-drop",
      redirectUri: REDIRECT,
      verificationType: "identity",
    })
    expect(await receive()).toHaveLength(0)
  })

  test("namespaces by API key isolate suites; the journal never holds prefill PII", async () => {
    const runtime = createRuntime()
    await runtime.fetch(
      new Request(`${MOCK}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "key-a": "a", "key-b": "b" } }),
      }),
    )
    const a = new PersonaConsumer({ ...config(), PERSONA_API_KEY: "key-a" }, (r) =>
      runtime.fetch(r),
    )
    const b = new PersonaConsumer({ ...config(), PERSONA_API_KEY: "key-b" }, (r) =>
      runtime.fetch(r),
    )
    const made = await a.createInquiry({
      referenceId: "shared-ref",
      redirectUri: REDIRECT,
      verificationType: "identity",
      prefillFields: { "name-first": "Grace", "name-last": "Hopper" },
    })
    expect(await a.listReusableInquiry("shared-ref", "itmpl_identity")).toEqual({
      id: idOf(made.inquiryUrl),
    })
    expect(await b.listReusableInquiry("shared-ref", "itmpl_identity")).toBeNull()
    const journal = JSON.stringify(
      await (await runtime.fetch(new Request(`${MOCK}/__admin/requests?namespace=a`))).json(),
    )
    expect(journal).toContain(idOf(made.inquiryUrl))
    expect(journal).not.toContain("Hopper")
    // Prefill fields are echoed on reads, as Persona does.
    const read = await runtime.fetch(
      new Request(`${MOCK}/inquiries/${idOf(made.inquiryUrl)}`, {
        headers: { authorization: "Bearer key-a" },
      }),
    )
    const body = (await read.json()) as { data: { attributes: Record<string, unknown> } }
    expect(body.data.attributes["name-last"]).toBe("Hopper")
  })

  test("list paging: page[size] and page[after] walk newest first; the payload parser rejects foreign shapes", async () => {
    const { consumer, runtime } = harness()
    for (const ref of ["r1", "r2", "r3"]) {
      await consumer.createInquiry({
        referenceId: ref,
        redirectUri: REDIRECT,
        verificationType: "identity",
      })
    }
    const get = async (query: string) =>
      (await (
        await runtime.fetch(
          new Request(`${MOCK}/inquiries?${query}`, {
            headers: { authorization: `Bearer ${API_KEY}` },
          }),
        )
      ).json()) as {
        data: { attributes: { "reference-id": string } }[]
        links: { next: string | null }
      }
    const first = await get("page[size]=2")
    expect(first.data.map((d) => d.attributes["reference-id"])).toEqual(["r3", "r2"])
    const next = await get((first.links.next as string).split("?")[1] as string)
    expect(next.data.map((d) => d.attributes["reference-id"])).toEqual(["r1"])
    expect(next.links.next).toBeNull()
    expect(() => handlePersonaWebhook({ data: {} })).toThrow()
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(PERSONA_PRESETS)).toEqual(
      expect.arrayContaining([
        "list_fails",
        "create_fails",
        "not_found",
        "unauthorized",
        "rate_limited",
        "server_error",
        "webhook_duplicate",
        "webhook_reorder",
        "webhook_drop",
      ]),
    )
  })
})

describe("contract", () => {
  test("/health, and namespaces by header and by /ns/ prefix are isolated; reset clears them", async () => {
    const runtime = createRuntime()
    const health = await runtime.fetch(new Request(`${MOCK}/health`))
    expect(((await health.json()) as { status: string }).status).toBe("ok")
    const create = (url: string, headers: Record<string, string> = {}) =>
      runtime.fetch(
        new Request(url, {
          method: "POST",
          headers: { authorization: "Bearer k", "content-type": "application/json", ...headers },
          body: JSON.stringify({
            data: { attributes: { "inquiry-template-id": "itmpl_identity", "reference-id": "r" } },
          }),
        }),
      )
    const list = async (url: string, headers: Record<string, string> = {}) =>
      (
        (await (
          await runtime.fetch(
            new Request(url, { headers: { authorization: "Bearer k", ...headers } }),
          )
        ).json()) as {
          data: unknown[]
        }
      ).data.length
    expect((await create(`${MOCK}/inquiries`, { "x-mockingbird-namespace": "h" })).status).toBe(201)
    expect((await create(`${MOCK}/ns/p/inquiries`)).status).toBe(201)
    expect((await create(`${MOCK}/ns/p/inquiries`)).status).toBe(201)
    expect(await list(`${MOCK}/inquiries`, { "x-mockingbird-namespace": "h" })).toBe(1)
    expect(await list(`${MOCK}/ns/p/inquiries`)).toBe(2)
    expect(await list(`${MOCK}/inquiries`)).toBe(0)
    await runtime.fetch(new Request(`${MOCK}/__admin/reset?namespace=p`, { method: "POST" }))
    expect(await list(`${MOCK}/ns/p/inquiries`)).toBe(0)
    // Missing bearer: Persona's 401.
    const anonymous = await runtime.fetch(new Request(`${MOCK}/inquiries`))
    expect(anonymous.status).toBe(401)
  })
})

describe("served over HTTP", () => {
  test("the consumer works against the node server; the hosted flow under /ns/ redirects; a real sink verifies", async () => {
    const received: { status: number; body: unknown }[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const outcome = receivePersonaWebhook(SECRET, request.headers, await request.text())
        received.push(outcome)
        return Response.json(outcome.body, { status: outcome.status })
      },
    })
    const server = await createServer({
      webhooks: {
        url: `http://127.0.0.1:${sink.port}/v1/identify-verification/webhook`,
        secret: SECRET,
      },
    })
    try {
      const base = `${server.url}/ns/worker-1`
      const consumer = new PersonaConsumer(config(base), (r) => fetch(r))
      const created = await consumer.createInquiry({
        referenceId: "p-http",
        redirectUri: REDIRECT,
        verificationType: "phone",
      })
      expect(created.inquiryUrl).toStartWith(`${base}/verify?`)
      const page = await (await fetch(created.inquiryUrl)).text()
      const href = /href="([^"]*outcome=complete[^"]*)"/
        .exec(page)?.[1]
        ?.replace(/&amp;/g, "&") as string
      const done = await fetch(new URL(href, created.inquiryUrl), { redirect: "manual" })
      expect(done.status).toBe(302)
      expect(new URL(done.headers.get("location") as string).searchParams.get("status")).toBe(
        "completed",
      )
      const deadline = Date.now() + 3_000
      while (received.length < 3 && Date.now() < deadline) await Bun.sleep(25)
      expect(received.map((r) => [r.status, (r.body as WebhookResult).status]).sort()).toEqual([
        [200, "completed"],
        [200, "created"],
        [200, "pending"],
      ])
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^persona@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
