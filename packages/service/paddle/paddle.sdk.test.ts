/**
 * The official `@paddle/paddle-node-sdk@3.10.0` pointed at the served mock, and the reference
 * integration in `test/consumer.ts` driven end to end: catalog, checkout, subscription
 * lifecycle, cursor pagination, error mapping and webhook verification with the SDK's own
 * `Paddle.webhooks.unmarshal`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ApiError, type Environment, Paddle } from "@paddle/paddle-node-sdk"
import { createServer, type PaddleServer } from "./src/server.js"
import { PaddleBilling } from "./test/consumer.js"

const SECRET = "pdl_ntfset_mockingbird_sdk_test_secret"
const KEY = "pdl_sdbx_apikey_mockingbird_sdk_test"

let server: PaddleServer
let paddle: Paddle
const deliveries: { body: string; signature: string | null }[] = []
let sink: ReturnType<typeof Bun.serve>
/** The fixture account, seeded once: seeding a namespace twice clashes on the fixture emails. */
let seeded: {
  prices: { monthly: { id: string }; starter: { id: string }; setup: { id: string } }
  subscriptions: { trialing: { id: string } }
}

beforeAll(async () => {
  sink = Bun.serve({
    port: 0,
    fetch: async (request) => {
      deliveries.push({
        body: await request.text(),
        signature: request.headers.get("paddle-signature"),
      })
      return new Response(null, { status: 200 })
    },
  })
  server = await createServer({
    webhooks: { url: `http://127.0.0.1:${sink.port}/webhooks/paddle`, secret: SECRET },
    paymentLink: "https://pay.example.com/checkout",
  })
  paddle = new Paddle(KEY, { environment: server.url as Environment })
})

afterAll(async () => {
  await server.close()
  sink.stop(true)
})

const admin = async <T>(path: string, body?: unknown): Promise<T> =>
  (await (
    await fetch(`${server.url}/__admin${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json()) as T

describe("@paddle/paddle-node-sdk against the mock", () => {
  test("catalog, customer and a transaction with computed totals", async () => {
    const product = await paddle.products.create({ name: "Team plan", taxCategory: "saas" })
    expect(product.id).toMatch(/^pro_01[a-z0-9]{24}$/)
    const price = await paddle.prices.create({
      productId: product.id,
      description: "Team monthly",
      unitPrice: { amount: "4900", currencyCode: "USD" },
      billingCycle: { interval: "month", frequency: 1 },
      quantity: { minimum: 1, maximum: 50 },
    })
    expect(price.billingCycle).toEqual({ interval: "month", frequency: 1 })
    const withProduct = await paddle.prices.get(price.id, { include: ["product"] })
    expect(withProduct.product?.name).toBe("Team plan")
    const customer = await paddle.customers.create({ email: "team@example.com", name: "Team Lead" })
    const address = await paddle.addresses.create(customer.id, {
      countryCode: "US",
      postalCode: "94107",
    })
    const transaction = await paddle.transactions.create({
      items: [{ priceId: price.id, quantity: 4 }],
      customerId: customer.id,
      addressId: address.id,
      customData: { team: "platform" },
    })
    expect(transaction.status).toBe("ready")
    expect(transaction.checkout?.url).toBe(
      `https://pay.example.com/checkout?_ptxn=${transaction.id}`,
    )
    expect(transaction.details?.totals?.grandTotal).toBe("19600")
    expect(transaction.details?.lineItems[0]?.product?.id).toBe(product.id)
    expect(transaction.items[0]?.price?.id).toBe(price.id)
    const fetched = await paddle.transactions.get(transaction.id, {
      include: ["customer", "address"],
    })
    expect(fetched.customer?.email).toBe("team@example.com")
    expect(fetched.address?.postalCode).toBe("94107")
  })

  test("cursor pagination through the SDK's collection, filters and errors", async () => {
    for (const email of ["p1@example.com", "p2@example.com", "p3@example.com"]) {
      await paddle.customers.create({ email })
    }
    const seen: string[] = []
    for await (const customer of paddle.customers.list({ perPage: 2, search: "p" }))
      seen.push(customer.email)
    expect(seen).toEqual(
      expect.arrayContaining(["p1@example.com", "p2@example.com", "p3@example.com"]),
    )
    const missing = await paddle.customers.get("ctm_00000000000000000000000000").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(missing).toBeInstanceOf(ApiError)
    expect((missing as ApiError).code).toBe("not_found")
    const duplicate = await paddle.customers.create({ email: "p1@example.com" }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((duplicate as ApiError).code).toBe("customer_already_exists")
    const invalid = await paddle.products.create({ name: "", taxCategory: "saas" }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((invalid as ApiError).code).toBe("invalid_field")
    expect((invalid as ApiError).errors?.[0]?.field).toBe("name")
    server.runtime.applyPreset("rate_limited", "default", { count: 1 })
    const limited = await paddle.customers.get("ctm_00000000000000000000000000").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((limited as ApiError).code).toBe("too_many_requests")
    expect((limited as ApiError).retryAfter).toBe(2)
  })

  test("the reference integration: checkout, entitlements from verified webhooks, cancel at period end", async () => {
    seeded = await admin("/seed")
    const seed = seeded
    const billing = new PaddleBilling({
      apiKey: KEY,
      baseUrl: server.url,
      webhookSecret: SECRET,
      plans: { [seed.prices.monthly.id]: "pro", [seed.prices.starter.id]: "starter" },
    })
    const transaction = await billing.startCheckout({
      email: "founder@example.com",
      priceId: seed.prices.monthly.id,
      userId: "user_42",
    })
    expect(transaction.status).toBe("draft")
    // The app hands the transaction to Paddle.js; the customer enters an address and pays.
    const paid = await admin<{ subscription: { id: string; customer_id: string } }>("/checkout", {
      email: "founder@example.com",
      items: [{ price_id: seed.prices.monthly.id }],
      custom_data: { user_id: "user_42" },
    })
    await server.runtime.webhooks.idle()
    const handled: string[] = []
    for (const delivery of deliveries.splice(0)) {
      const type = await billing.handleWebhook(delivery.body, delivery.signature)
      if (type) handled.push(type)
    }
    expect(handled).toEqual(
      expect.arrayContaining(["subscription.created", "subscription.activated"]),
    )
    expect(billing.entitlements.get(paid.subscription.customer_id)).toMatchObject({
      plan: "pro",
      status: "active",
      cancelAt: null,
    })
    const scheduled = await billing.cancelAtPeriodEnd(paid.subscription.id)
    expect(scheduled.scheduledChange?.action).toBe("cancel")
    await admin(`/subscriptions/${paid.subscription.id}/renew`)
    await server.runtime.webhooks.idle()
    for (const delivery of deliveries.splice(0))
      await billing.handleWebhook(delivery.body, delivery.signature)
    expect(billing.entitlements.get(paid.subscription.customer_id)).toMatchObject({
      plan: "free",
      status: "canceled",
    })
    await expect(
      billing.handleWebhook('{"event_type":"subscription.updated"}', "ts=1;h1=bad"),
    ).rejects.toThrow("signature verification failed")
  })

  test("trials, pause and resume through the SDK", async () => {
    const trialing = await paddle.subscriptions.get(seeded.subscriptions.trialing.id, {
      include: ["next_transaction"],
    })
    expect(trialing.status).toBe("trialing")
    expect(trialing.items[0]?.trialDates).not.toBeNull()
    expect(trialing.nextTransaction?.details.totals.total).toBe("1900")
    const activated = await paddle.subscriptions.activate(trialing.id)
    expect(activated.status).toBe("active")
    expect(activated.firstBilledAt).not.toBeNull()
    const paused = await paddle.subscriptions.pause(trialing.id, { effectiveFrom: "immediately" })
    expect(paused.status).toBe("paused")
    expect(paused.nextBilledAt).toBeNull()
    const resumed = await paddle.subscriptions.resume(trialing.id, { effectiveFrom: "immediately" })
    expect(resumed.status).toBe("active")
    expect(resumed.currentBillingPeriod).not.toBeNull()
    const charged = await paddle.subscriptions.createOneTimeCharge(trialing.id, {
      effectiveFrom: "immediately",
      items: [{ priceId: seeded.prices.setup.id, quantity: 1 }],
    })
    expect(charged.id).toBe(trialing.id)
    const transactions: string[] = []
    for await (const t of paddle.transactions.list({ subscriptionId: [trialing.id] }))
      transactions.push(t.origin)
    expect(transactions).toEqual(
      expect.arrayContaining(["web", "subscription_update", "subscription_charge"]),
    )
  })
})
