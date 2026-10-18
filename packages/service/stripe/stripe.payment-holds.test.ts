import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import Stripe from "stripe"
import { createRuntime } from "./src/index.js"

const SECRET = "whsec_holds"
const KEY = "sk_test_holds"
const START = Date.UTC(2026, 0, 1)

const harness = () => {
  const clock = createClock(() => START)
  clock.freeze()
  const delivered: Request[] = []
  const runtime = createRuntime({
    clock,
    webhooks: {
      endpoints: [{ url: "http://app.test/webhooks/stripe", secret: SECRET }],
      fetch: async (request) => {
        delivered.push(request.clone())
        return new Response("ok")
      },
    },
  })
  const call = (method: string, path: string, body?: string, key = KEY) =>
    runtime.fetch(
      new Request(`http://stripe.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(body === undefined ? {} : { body }),
      }),
    )
  const admin = (method: string, path: string, body?: unknown) =>
    runtime.fetch(
      new Request(`http://stripe.test/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const customer = async (email: string) =>
    ((await (await call("POST", "/v1/customers", `email=${email}`)).json()) as { id: string }).id
  const pay = async (customerId: string) =>
    (await (
      await call(
        "POST",
        "/v1/payment_intents",
        `amount=1500&currency=usd&customer=${customerId}&payment_method=pm_card_visa&confirm=true&automatic_payment_methods[enabled]=true&automatic_payment_methods[allow_redirects]=never`,
      )
    ).json()) as { id: string; status: string; client_secret: string }
  return { clock, delivered, runtime, call, admin, customer, pay }
}

const bodies = async (requests: Request[]) =>
  Promise.all(
    requests.map(async (request) => JSON.parse(await request.clone().text()) as Stripe.Event),
  )
const signedAt = (request: Request | undefined) =>
  Number(/t=(\d+)/.exec(request?.headers.get("stripe-signature") ?? "")?.[1])
const customerOf = (event: Stripe.Event) =>
  (event.data.object as { customer?: string | null }).customer

describe("per-customer payment holds: webhooks", () => {
  test("a held customer's webhooks wait, other customers' are delivered", async () => {
    const { delivered, runtime, admin, customer, pay } = harness()
    const held = await customer("held@example.com")
    const other = await customer("other@example.com")
    expect((await admin("PUT", `/payment-holds/${held}`, { lookups: false })).status).toBe(200)
    delivered.length = 0

    await pay(held)
    await pay(other)
    await runtime.webhooks.idle()

    const events = await bodies(delivered)
    expect(events.length).toBeGreaterThan(0)
    expect(events.some((event) => customerOf(event) === held)).toBe(false)
    expect(events.some((event) => customerOf(event) === other)).toBe(true)
    const listing = (await (await admin("GET", "/payment-holds")).json()) as {
      holds: Array<{ customer: string; held: Array<{ type: string }> }>
    }
    expect(listing.holds).toHaveLength(1)
    expect(listing.holds[0]?.customer).toBe(held)
    expect(listing.holds[0]?.held.map((event) => event.type)).toContain("payment_intent.succeeded")
  })

  test("release delivers the held events in order with the signature timestamp they were held at", async () => {
    const { clock, delivered, runtime, admin, customer, pay } = harness()
    const held = await customer("held@example.com")
    await admin("PUT", `/payment-holds/${held}`, { lookups: false })
    await runtime.webhooks.idle()
    delivered.length = 0

    await pay(held)
    // Everything of the held customer's, in the order the mock recorded it.
    const recorded = runtime.instance("default").webhookEvents()
    const expected = recorded
      .filter((event) => customerOf(JSON.parse(event.body)) === held)
      .map((event) => event.id)
    expect(expected.length).toBeGreaterThan(1)
    await runtime.webhooks.idle()
    expect(delivered).toHaveLength(0)

    clock.advance(10 * 60 * 1000)
    const released = await admin("POST", `/payment-holds/${held}/release`)
    expect(released.status).toBe(200)
    expect(
      ((await released.json()) as { released: Array<{ id: string }> }).released.map(
        (event) => event.id,
      ),
    ).toEqual(expected)
    await runtime.webhooks.idle()

    const events = await bodies(delivered)
    expect(events.map((event) => event.id)).toEqual(expected)
    // Signed when held, not at release: ten minutes earlier on the mock clock.
    for (const request of delivered) expect(signedAt(request)).toBe(START / 1000)
    const first = delivered[0]
    const verified = await Stripe.webhooks.constructEventAsync(
      (await first?.clone().text()) ?? "",
      first?.headers.get("stripe-signature") ?? "",
      SECRET,
      300,
      undefined,
      START,
    )
    expect(verified.id).toBe(expected[0] ?? "")

    // The hold is over: later events flow straight through.
    delivered.length = 0
    await pay(held)
    await runtime.webhooks.idle()
    expect(delivered.length).toBeGreaterThan(0)
    expect(((await (await admin("GET", "/payment-holds")).json()) as { holds: [] }).holds).toEqual(
      [],
    )
  })

  test("discarding a hold drops the queued events but keeps them in GET /v1/events", async () => {
    const { delivered, runtime, admin, customer, pay, call } = harness()
    const held = await customer("held@example.com")
    await admin("PUT", `/payment-holds/${held}`, { lookups: false })
    await pay(held)
    const discarded = await admin("DELETE", `/payment-holds/${held}`)
    expect(((await discarded.json()) as { discarded: number }).discarded).toBeGreaterThan(0)
    await runtime.webhooks.idle()
    expect((await bodies(delivered)).filter((event) => customerOf(event) === held)).toHaveLength(0)
    const events = (await (
      await call("GET", "/v1/events?type=payment_intent.succeeded")
    ).json()) as {
      data: Stripe.Event[]
    }
    expect(events.data.some((event) => customerOf(event) === held)).toBe(true)
  })

  test("releasing an unknown hold is 404, and bad bodies are 400", async () => {
    const { admin } = harness()
    expect((await admin("POST", "/payment-holds/cus_none/release")).status).toBe(404)
    expect((await admin("DELETE", "/payment-holds/cus_none")).status).toBe(404)
    expect((await admin("PUT", "/payment-holds/cus_x", { webhooks: "yes" })).status).toBe(400)
    expect(
      (await admin("PUT", "/payment-holds/cus_x", { webhooks: false, lookups: false })).status,
    ).toBe(400)
  })

  test("a reset clears holds and queued events", async () => {
    const { delivered, runtime, admin, customer, pay } = harness()
    const held = await customer("held@example.com")
    await admin("PUT", `/payment-holds/${held}`)
    await pay(held)
    expect((await admin("POST", "/reset")).status).toBe(200)
    expect(((await (await admin("GET", "/payment-holds")).json()) as { holds: [] }).holds).toEqual(
      [],
    )
    await runtime.webhooks.idle()
    expect((await bodies(delivered)).filter((event) => customerOf(event) === held)).toHaveLength(0)
  })
})

describe("per-customer payment holds: lookup faults", () => {
  test("secret-key reads filtered by the customer, or of an intent it owns, answer 503 api_error", async () => {
    const { admin, customer, pay, call } = harness()
    const held = await customer("held@example.com")
    const other = await customer("other@example.com")
    const heldIntent = await pay(held)
    const otherIntent = await pay(other)
    await admin("PUT", `/payment-holds/${held}`, { webhooks: false })

    const filtered = await call("GET", `/v1/payment_intents?customer=${held}`)
    expect(filtered.status).toBe(503)
    expect(((await filtered.json()) as { error: { type: string } }).error.type).toBe("api_error")
    expect((await call("GET", `/v1/charges?customer=${held}`)).status).toBe(503)
    expect((await call("GET", `/v1/payment_intents/${heldIntent.id}`)).status).toBe(503)

    // Other customers, unfiltered lists and writes are untouched.
    expect((await call("GET", `/v1/payment_intents?customer=${other}`)).status).toBe(200)
    expect((await call("GET", `/v1/payment_intents/${otherIntent.id}`)).status).toBe(200)
    expect((await call("GET", "/v1/payment_intents")).status).toBe(200)
    expect((await call("GET", `/v1/customers/${held}`)).status).toBe(200)
  })

  test("a publishable-key retrieve (Stripe.js) is not failed, and the lookups recover on release", async () => {
    const { admin, customer, pay, call } = harness()
    const held = await customer("held@example.com")
    const intent = await pay(held)
    await admin("PUT", `/payment-holds/${held}`, { webhooks: false })
    const browser = await call(
      "GET",
      `/v1/payment_intents/${intent.id}?client_secret=${intent.client_secret}`,
      undefined,
      "pk_test_holds",
    )
    expect(browser.status).toBe(200)
    expect((await call("GET", `/v1/payment_intents/${intent.id}`)).status).toBe(503)

    expect((await admin("POST", `/payment-holds/${held}/release`)).status).toBe(200)
    expect((await call("GET", `/v1/payment_intents/${intent.id}`)).status).toBe(200)
    expect((await call("GET", `/v1/payment_intents?customer=${held}`)).status).toBe(200)
  })

  test("holds are per namespace", async () => {
    const { runtime } = harness()
    const put = await runtime.fetch(
      new Request("http://stripe.test/__admin/payment-holds/cus_a", {
        method: "PUT",
        headers: { "x-mockingbird-namespace": "worker-1" },
      }),
    )
    expect(put.status).toBe(200)
    const other = await runtime.fetch(new Request("http://stripe.test/__admin/payment-holds"))
    expect(((await other.json()) as { holds: [] }).holds).toEqual([])
  })
})
