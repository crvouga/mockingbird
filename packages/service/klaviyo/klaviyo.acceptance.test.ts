import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, KLAVIYO_PRESETS, type KlaviyoEvent } from "./src/index.js"
import { createServer } from "./src/server.js"
import { checkoutPayload, KLAVIYO_EVENTS, KlaviyoConsumer } from "./test/consumer.js"

const params = fcParameters(process.env)
const API = "http://klaviyo.mock"
const KLAVIYO_URL = `${API}/api/events/`

const harness = () => {
  const runtime = createRuntime()
  const consumer = (key = "pk_test_geviti", url = KLAVIYO_URL) =>
    new KlaviyoConsumer(url, key, (request) => runtime.fetch(request))
  const admin = async <T>(path: string, init: RequestInit = {}): Promise<T> =>
    (await (await runtime.fetch(new Request(`${API}/__admin${path}`, init))).json()) as T
  const outbox = async (query = "") =>
    (await admin<{ messages: KlaviyoEvent[] }>(`/outbox${query}`)).messages
  return { runtime, consumer, admin, outbox }
}

const order = (overrides: Partial<Parameters<typeof checkoutPayload>[0]> = {}) =>
  checkoutPayload({
    userToken: "usr_tok_42",
    email: "ada@example.com",
    phoneNumber: "+16025550142",
    stripeProductId: "prod_Membership",
    productName: "Geviti Membership",
    amount: "19900",
    orderSourceReference: "ord_1001",
    now: new Date("2026-09-20T12:00:00.000Z"),
    ...overrides,
  })

describe("S19 Klaviyo acceptance: our consumer's logic against the mock", () => {
  test("the checkout job posts Ordered Product then Placed Order; both land in the outbox", async () => {
    const { consumer, outbox, admin } = harness()
    await consumer().pushDataToKlaviyo(order())
    const events = await outbox("?to=ada@example.com")
    expect(events.map((e) => e.metric)).toEqual([
      KLAVIYO_EVENTS.ORDERED_EVENT,
      KLAVIYO_EVENTS.PLACE_ORDER,
    ])
    const [ordered, placed] = events as [KlaviyoEvent, KlaviyoEvent]
    expect(ordered.properties).toEqual({
      Items: [
        {
          ProductID: "prod_Membership",
          ProductName: "Geviti Membership",
          Quantity: 1,
          ItemPrice: 19900,
        },
      ],
    })
    expect(placed.properties).toEqual({
      ProductId: "prod_Membership",
      ProductName: "Geviti Membership",
      Quantity: 1,
    })
    for (const event of events) {
      expect(event.value).toBe(19900)
      expect(event.valueCurrency).toBe("USD")
      expect(event.uniqueId).toBe("ord_1001")
      expect(event.time).toBe("2026-09-20T12:00:00.000Z")
      expect(event.profileId).toBe("usr_tok_42")
    }
    // One profile, found by the id our backend sends (the user token), carrying email + phone.
    const { profiles } = await admin<{ profiles: { id: string; email: string }[] }>("/profiles")
    expect(profiles).toEqual([
      expect.objectContaining({ id: "usr_tok_42", email: "ada@example.com" }),
    ])
    expect((await outbox("?metric=Placed%20Order")).length).toBe(1)
  })

  test("a BullMQ retry of the same order is deduplicated by unique_id (no double revenue)", async () => {
    const { consumer, outbox } = harness()
    await consumer().pushDataToKlaviyo(order())
    await consumer().pushDataToKlaviyo(order())
    expect((await outbox()).length).toBe(2)
    await consumer().pushDataToKlaviyo(order({ orderSourceReference: "ord_1002" }))
    expect((await outbox("?unique_id=ord_1002")).length).toBe(2)
  })

  test("a null user token sends id '' and the profile is matched by email instead", async () => {
    const { consumer, admin } = harness()
    await consumer().pushDataToKlaviyo(order({ userToken: null }))
    await consumer().pushDataToKlaviyo(order({ userToken: null, orderSourceReference: "ord_2" }))
    const { profiles } = await admin<{ profiles: { id: string; email: string }[] }>("/profiles")
    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.id).toMatch(/^01H[0-9A-Z]{23}$/)
  })

  test("errors surface as the thrown JSON:API body text, which fails (and retries) the job", async () => {
    const { runtime, consumer, outbox } = harness()
    runtime.applyPreset("throttled", "default", { count: 1 })
    const failure = await consumer()
      .pushDataToKlaviyo(order())
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      )
    const body = JSON.parse(failure?.message ?? "{}") as { errors: { code: string }[] }
    expect(body.errors[0]?.code).toBe("throttled")
    expect(await outbox()).toHaveLength(0)
    // The retry goes through: the preset was limited to one hit.
    await consumer().pushDataToKlaviyo(order())
    expect(await outbox()).toHaveLength(2)
  })

  test("a phone number that is not E.164 is rejected the way Klaviyo rejects it", async () => {
    const { consumer } = harness()
    const failure = await consumer()
      .sendEvent(order({ phoneNumber: "(602) 555-0142" }), KLAVIYO_EVENTS.PLACE_ORDER)
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      )
    const body = JSON.parse(failure?.message ?? "{}") as {
      errors: { status: number; code: string; detail: string; source: { pointer: string } }[]
    }
    expect(body.errors[0]).toMatchObject({
      status: 400,
      code: "invalid",
      source: { pointer: "/data/attributes/profile/data/attributes/phone_number" },
    })
    expect(body.errors[0]?.detail).toContain("Invalid phone number format")
  })

  test("every error preset fails the job; connection_drop rejects the fetch itself", async () => {
    for (const preset of ["invalid_api_key", "server_error", "service_unavailable"]) {
      const { runtime, consumer } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      await expect(consumer().pushDataToKlaviyo(order())).rejects.toThrow()
    }
    const { runtime, consumer, outbox } = harness()
    runtime.applyPreset("connection_drop", "default", { count: 1 })
    await expect(consumer().pushDataToKlaviyo(order())).rejects.toBeInstanceOf(TypeError)
    expect(await outbox()).toHaveLength(0)
  })

  test("auth and revision are enforced as Klaviyo does", async () => {
    const { runtime } = harness()
    const post = (headers: Record<string, string>) =>
      runtime.fetch(
        new Request(KLAVIYO_URL, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({}),
        }),
      )
    const noKey = await post({ revision: "2024-02-15" })
    expect(noKey.status).toBe(401)
    expect(((await noKey.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe(
      "not_authenticated",
    )
    const noRevision = await post({ authorization: "Klaviyo-API-Key pk_x" })
    expect(noRevision.status).toBe(400)
  })

  test("namespaces by private key (and by /ns/ prefix in KLAVIYO_URL) isolate workers", async () => {
    const { runtime, consumer, outbox } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { pk_worker_a: "a" } }),
      }),
    )
    await consumer("pk_worker_a").pushDataToKlaviyo(order())
    await consumer("pk_other", `${API}/ns/b/api/events/`).pushDataToKlaviyo(order())
    expect(await outbox()).toHaveLength(0)
    const read = async (ns: string) =>
      (
        (await (
          await runtime.fetch(new Request(`${API}/__admin/outbox?namespace=${ns}`))
        ).json()) as { messages: unknown[] }
      ).messages.length
    expect(await read("a")).toBe(2)
    expect(await read("b")).toBe(2)
    const journal = (await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=a`))
    ).json()) as { requests: { operationId: string; ids?: Record<string, string> }[] }
    expect(journal.requests.map((r) => r.operationId)).toEqual(["CreateEvent", "CreateEvent"])
    // The journal holds metadata only: no email, no product names.
    expect(JSON.stringify(journal)).not.toContain("ada@example.com")
    expect(JSON.stringify(journal)).not.toContain("Geviti Membership")
  })

  test("events read back through GET /api/events and /api/events/{id}", async () => {
    const { runtime, consumer, outbox } = harness()
    await consumer().pushDataToKlaviyo(order())
    const headers = { authorization: "Klaviyo-API-Key pk_x", revision: "2024-02-15" }
    const list = (await (
      await runtime.fetch(new Request(`${API}/api/events/`, { headers }))
    ).json()) as {
      data: { id: string; attributes: { event_properties: Record<string, unknown> } }[]
    }
    expect(list.data).toHaveLength(2)
    expect(list.data[1]?.attributes.event_properties).toMatchObject({
      $value: 19900,
      $event_id: "ord_1001",
    })
    const [first] = await outbox()
    const one = await runtime.fetch(new Request(`${API}/api/events/${first?.id}/`, { headers }))
    expect(one.status).toBe(200)
  })

  test("any order our checkout can build is accepted exactly once per metric", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          amount: fc.integer({ min: 0, max: 99_999 }).map(String),
          productName: fc.string({ minLength: 1, maxLength: 30 }),
          ref: fc.stringMatching(/^[a-z0-9_]{1,20}$/),
          token: fc.option(fc.stringMatching(/^[a-z0-9]{1,16}$/), { nil: null }),
        }),
        async ({ amount, productName, ref, token }) => {
          const { consumer, outbox } = harness()
          const payload = order({
            amount,
            productName,
            orderSourceReference: ref,
            userToken: token,
          })
          await consumer().pushDataToKlaviyo(payload)
          await consumer().pushDataToKlaviyo(payload)
          const events = await outbox()
          expect(events.map((e) => e.metric).sort()).toEqual(["Ordered Product", "Placed Order"])
          expect(events.every((e) => e.value === Number.parseInt(amount, 10))).toBe(true)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 25 },
    )
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(KLAVIYO_PRESETS).sort()).toEqual(
      [
        "connection_drop",
        "invalid_api_key",
        "server_error",
        "service_unavailable",
        "throttled",
      ].sort(),
    )
  })
})

describe("served over HTTP", () => {
  test("the consumer works against the node server", async () => {
    const server = await createServer()
    try {
      const consumer = new KlaviyoConsumer(`${server.url}/api/events/`, "pk_http", (r) => fetch(r))
      await consumer.pushDataToKlaviyo(order())
      const outbox = (await (await fetch(`${server.url}/__admin/outbox`)).json()) as {
        messages: unknown[]
      }
      expect(outbox.messages).toHaveLength(2)
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^klaviyo@/)
      expect(((await health.json()) as { status: string }).status).toBe("ok")
    } finally {
      await server.close()
    }
  })
})

describe("contract", () => {
  test("namespaces by header and by /ns/ prefix are isolated; reset clears one namespace", async () => {
    const runtime = createRuntime()
    const get = (url: string, headers: Record<string, string> = {}) =>
      runtime.fetch(
        new Request(url, {
          headers: { authorization: "Klaviyo-API-Key pk_x", revision: "2024-02-15", ...headers },
        }),
      )
    const base = "http://mock.local"
    // Seed state in namespace "a" through the header, then compare with "b" and the default.
    const before = (await (await get(`${base}/api/events/`)).json()) as Record<string, unknown[]>
    const viaHeader = await get(`${base}/api/events/`, { "x-mockingbird-namespace": "a" })
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/; ns=a$/)
    const viaPrefix = await get(`${base}/ns/b/api/events/`)
    expect(viaPrefix.status).toBe(viaHeader.status)
    expect(viaPrefix.headers.get("x-mockingbird")).toMatch(/; ns=b$/)
    expect(((await viaPrefix.json()) as Record<string, unknown[]>).data?.length).toBe(
      before.data?.length,
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
