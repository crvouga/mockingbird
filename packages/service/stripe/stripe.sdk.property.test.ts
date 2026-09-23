import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import Stripe from "stripe"
import { StripeAPI } from "./src/index.js"

const params = fcParameters(process.env)
const now = () => 1_700_000_000_000
const HOST = "mock.stripe.local"

const clientFor = (api: StripeAPI) =>
  new Stripe("sk_test_mockingbird", {
    host: HOST,
    protocol: "https",
    port: 443,
    maxNetworkRetries: 0,
    telemetry: false,
    httpClient: Stripe.createFetchHttpClient(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          return api.fetch(new Request(input, init))
        },
        {
          preconnect: () => undefined,
        },
      ) as typeof fetch,
    ),
  })

const amount = fc.integer({ min: 50, max: 50_000 })
const name = fc.string({ minLength: 1, maxLength: 40 }).filter((value) => value.trim().length > 0)

describe("official Stripe SDK", () => {
  test("server SDK round-trips customers, prices, payment intents, refunds and subscriptions", async () => {
    await fc.assert(
      fc.asyncProperty(name, amount, async (customerName, unitAmount) => {
        const api = new StripeAPI({ now })
        const stripe = clientFor(api)
        const customer = await stripe.customers.create({
          name: customerName,
          email: "ada@example.com",
        })
        expect(customer.id.startsWith("cus_")).toBe(true)
        const again = await stripe.customers.retrieve(customer.id)
        expect(again).toMatchObject({ id: customer.id, name: customer.name, object: "customer" })

        const product = await stripe.products.create({ name: customerName })
        const price = await stripe.prices.create({
          product: product.id,
          currency: "usd",
          unit_amount: unitAmount,
          recurring: { interval: "month" },
        })
        const subscription = await stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: price.id }],
          trial_period_days: 14,
        })
        expect(subscription.status).toBe("trialing")
        expect(subscription.items.data[0]?.price.id).toBe(price.id)

        const intent = await stripe.paymentIntents.create({
          amount: unitAmount,
          currency: "usd",
          customer: customer.id,
          payment_method: "pm_card_visa",
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        })
        expect(intent.status).toBe("succeeded")
        expect(intent.client_secret).toContain("_secret_")
        const expanded = await stripe.paymentIntents.retrieve(intent.id, { expand: ["customer"] })
        expect(expanded.customer).toMatchObject({ id: customer.id, name: customer.name })

        const refund = await stripe.refunds.create({ payment_intent: intent.id })
        expect(refund.status).toBe("succeeded")
        expect(refund.amount).toBe(unitAmount)

        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer: customer.id,
          success_url: "https://example.com/success",
          cancel_url: "https://example.com/cancel",
          line_items: [{ price: price.id, quantity: 1 }],
        })
        expect(session.id.startsWith("cs_")).toBe(true)
        expect(session.url).toContain(session.id)
        expect(session.status).toBe("open")

        const ephemeral = await stripe.ephemeralKeys.create(
          { customer: customer.id },
          { apiVersion: "2026-08-26.dahlia" },
        )
        expect(ephemeral.secret?.length).toBeGreaterThan(8)
        const customerSession = await stripe.customerSessions.create({
          customer: customer.id,
          components: { payment_element: { enabled: true } },
        })
        expect(customerSession.client_secret.startsWith("cuss_")).toBe(true)
      }),
      { ...params, numRuns: params.numRuns ?? 5 },
    )
  }, 60_000)

  test("card declines and missing resources use Stripe error classes", async () => {
    await fc.assert(
      fc.asyncProperty(amount, async (unitAmount) => {
        const stripe = clientFor(new StripeAPI({ now }))
        await expect(
          stripe.paymentIntents.create({
            amount: unitAmount,
            currency: "usd",
            payment_method: "pm_card_chargeDeclined",
            confirm: true,
          }),
        ).rejects.toBeInstanceOf(Stripe.errors.StripeCardError)
        await expect(stripe.customers.retrieve("cus_mockingbird_missing")).rejects.toMatchObject({
          code: "resource_missing",
          statusCode: 404,
        })
      }),
      { ...params, numRuns: params.numRuns ?? 4 },
    )
  })

  test("idempotency keys replay and reject changed parameters", async () => {
    await fc.assert(
      fc.asyncProperty(name, fc.uuid(), async (customerName, key) => {
        const stripe = clientFor(new StripeAPI({ now }))
        const first = await stripe.customers.create({ name: customerName }, { idempotencyKey: key })
        const replay = await stripe.customers.create(
          { name: customerName },
          { idempotencyKey: key },
        )
        expect(replay.id).toBe(first.id)
        await expect(
          stripe.customers.create({ name: `${customerName} changed` }, { idempotencyKey: key }),
        ).rejects.toBeInstanceOf(Stripe.errors.StripeIdempotencyError)
      }),
      { ...params, numRuns: params.numRuns ?? 4 },
    )
  })

  test("Elements session, confirmation token and publishable-key confirm succeed", async () => {
    await fc.assert(
      fc.asyncProperty(amount, async (unitAmount) => {
        const api = new StripeAPI({ now })
        const stripe = clientFor(api)
        const created = await stripe.paymentIntents.create({
          amount: unitAmount,
          currency: "usd",
          automatic_payment_methods: { enabled: true },
        })
        const sessionResponse = await api.fetch(
          new Request(
            `https://${HOST}/v1/elements/sessions?client_secret=${encodeURIComponent(created.client_secret ?? "")}&type=payment_intent&locale=en-US`,
            { headers: { authorization: "Bearer pk_test_mockingbird" } },
          ),
        )
        expect(sessionResponse.status).toBe(200)
        const session = (await sessionResponse.json()) as {
          object: string
          mode: string
          ordered_payment_method_types: string[]
          payment_intent: { id: string; client_secret: string }
        }
        expect(session.object).toBe("elements_session")
        expect(session.mode).toBe("payment")
        expect(session.ordered_payment_method_types).toContain("card")
        expect(session.payment_intent.id).toBe(created.id)

        const tokenResponse = await api.fetch(
          new Request(`https://${HOST}/v1/confirmation_tokens`, {
            method: "POST",
            headers: {
              authorization: "Bearer pk_test_mockingbird",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              "payment_method_data[type]": "card",
              "payment_method_data[card][number]": "4242424242424242",
              "payment_method_data[card][exp_month]": "12",
              "payment_method_data[card][exp_year]": "2034",
              "payment_method_data[card][cvc]": "123",
            }),
          }),
        )
        expect(tokenResponse.status).toBe(200)
        const token = (await tokenResponse.json()) as { id: string }
        expect(token.id.startsWith("ctoken_")).toBe(true)
        const confirmed = await stripe.paymentIntents.confirm(created.id, {
          confirmation_token: token.id,
        })
        expect(confirmed.status).toBe("succeeded")

        const forbidden = await api.fetch(
          new Request(`https://${HOST}/v1/customers`, {
            method: "POST",
            headers: {
              authorization: "Bearer pk_test_mockingbird",
              "content-type": "application/x-www-form-urlencoded",
            },
          }),
        )
        expect(forbidden.status).toBe(403)
      }),
      { ...params, numRuns: params.numRuns ?? 4 },
    )
  })

  test("signed webhook deliveries verify with stripe.webhooks.constructEvent", async () => {
    await fc.assert(
      fc.asyncProperty(name, async (customerName) => {
        const received: Array<{ raw: string; header: string }> = []
        const server = Bun.serve({
          port: 0,
          async fetch(request) {
            received.push({
              raw: await request.text(),
              header: request.headers.get("stripe-signature") ?? "",
            })
            return new Response("ok")
          },
        })
        try {
          const stripe = clientFor(new StripeAPI({ now }))
          const endpoint = await stripe.webhookEndpoints.create({
            url: `http://127.0.0.1:${server.port}/stripe`,
            enabled_events: ["customer.created"],
          })
          expect(endpoint.secret?.startsWith("whsec_")).toBe(true)
          await stripe.customers.create({ name: customerName })
          expect(received.length).toBe(1)
          const event = await stripe.webhooks.constructEventAsync(
            received[0]?.raw ?? "",
            received[0]?.header ?? "",
            endpoint.secret ?? "",
            10_000_000_000,
          )
          expect(event.type).toBe("customer.created")
          const listed = await stripe.events.list({ type: "customer.created", limit: 5 })
          expect(listed.data.some((item) => item.type === "customer.created")).toBe(true)
        } finally {
          await server.stop(true)
        }
      }),
      { ...params, numRuns: params.numRuns ?? 3 },
    )
  })
})
