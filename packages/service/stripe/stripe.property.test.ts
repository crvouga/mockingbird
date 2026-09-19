import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { Database } from "@crvouga/sqlite-mem"
import fc from "fast-check"
import { document, StripeAPI } from "./src/index.js"

const params = fcParameters(process.env)

const MOCK_HOST = "mock.stripe.local"
const AUTH = { authorization: "Bearer sk_test_mockingbird" }
const now = () => 1_700_000_000_000

/**
 * Two independent StripeAPI instances given the same random walk must behave identically after
 * canonicalization, and every response must conform to the vendored OpenAPI contract. This is
 * the network-free half of the differential suite; `parity.ts` runs the same walks against Stripe.
 */
describe("StripeAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new StripeAPI({ now })
      const report = await parity({
        provider: "stripe",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => AUTH,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new StripeAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => AUTH,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 40,
        maxCommands: 25,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
        latencyToleranceMs: 25,
      })
      expect(report.walks).toBeGreaterThan(0)
      // Full-surface coverage is asserted by stripe.qa.seed.property.test.ts; this suite proves
      // two independent instances agree (and conform) on ordinary walks.
      expect(new Set(Object.keys(report.exercised)).size).toBeGreaterThan(0)
    },
    { timeout: 120_000 },
  )

  test(
    "self-parity with an injected sqlite-mem client",
    async () => {
      const reference = new StripeAPI({ sqlite: new Database(), now })
      const report = await parity({
        provider: "stripe",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => AUTH,
          fetch: async (request) => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            return reference.fetch(request)
          },
        },
        mock: {
          create: () => new StripeAPI({ sqlite: new Database(), now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => AUTH,
        },
        cleanup: async () => {
          await reference.reset()
        },
        numRuns: params.numRuns ?? 10,
        maxCommands: 15,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
        latencyToleranceMs: 25,
      })
      expect(report.walks).toBeGreaterThan(0)
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new StripeAPI({ now })
          const faulty = () => {
            const api = new StripeAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (
                  request.method !== "POST" ||
                  !new URL(request.url).pathname.endsWith("/v1/customers")
                )
                  return response
                const body = (await response.json()) as Record<string, unknown>
                return Response.json(
                  { ...body, balance: 1 },
                  { status: response.status, headers: { "content-type": "application/json" } },
                )
              },
            }
          }
          const failure = await parity({
            provider: "stripe",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers: () => AUTH,
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: () => AUTH },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["PostCustomers"],
            numRuns: 20,
            maxCommands: 6,
            seed,
            invalidProbability: 0,
            sleep: async () => {},
            log: () => {},
          }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(failure).toBeInstanceOf(ParityError)
          const error = failure as ParityError
          expect(error.details.kind).toBe("mismatch")
          expect(error.details.history.length).toBeLessThanOrEqual(1)
        }),
        { ...params, numRuns: 3 },
      )
    },
    { timeout: 30_000 },
  )

  test("validates test-mode authentication and replays idempotent requests", async () => {
    const stripe = new StripeAPI({ now })
    const missing = await stripe.fetch(new Request(`https://${MOCK_HOST}/v1/customers`))
    expect(missing.status).toBe(401)
    const invalid = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/customers`, {
        headers: { authorization: "Bearer sk_live_secret" },
      }),
    )
    expect(invalid.status).toBe(401)

    const headers = {
      ...AUTH,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": "customer-create-1",
    }
    const first = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/customers`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ name: "Ada" }),
      }),
    )
    const second = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/customers`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ name: "Ada" }),
      }),
    )
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(await first.text())

    const conflict = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/customers`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ name: "Grace" }),
      }),
    )
    expect(conflict.status).toBe(400)
  })

  test("supports billing client flows without network state", async () => {
    const stripe = new StripeAPI({ now })
    const form = (body: Record<string, string>) => ({
      headers: { ...AUTH, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    })
    const customerResponse = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/customers`, {
        method: "POST",
        headers: form({}).headers,
        body: form({ email: "test@example.com" }).body,
      }),
    )
    const customer = (await customerResponse.json()) as { id: string }
    const paymentMethodResponse = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/payment_methods/pm_card_visa/attach`, {
        method: "POST",
        headers: form({ customer: customer.id }).headers,
        body: form({ customer: customer.id }).body,
      }),
    )
    expect(paymentMethodResponse.status).toBe(200)
    const intentResponse = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/payment_intents`, {
        method: "POST",
        headers: form({
          amount: "1000",
          confirm: "true",
          currency: "usd",
          customer: customer.id,
          payment_method: "pm_card_visa",
        }).headers,
        body: form({
          amount: "1000",
          confirm: "true",
          currency: "usd",
          customer: customer.id,
          payment_method: "pm_card_visa",
        }).body,
      }),
    )
    expect(((await intentResponse.json()) as { status: string }).status).toBe("succeeded")
    const productResponse = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/products`, {
        method: "POST",
        headers: form({ name: "Membership" }).headers,
        body: form({ name: "Membership" }).body,
      }),
    )
    const product = (await productResponse.json()) as { id: string }
    const priceForm = {
      currency: "usd",
      product: product.id,
      "recurring[interval]": "month",
      unit_amount: "17999",
    }
    const priceResponse = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/prices`, {
        method: "POST",
        headers: form(priceForm).headers,
        body: form(priceForm).body,
      }),
    )
    const price = (await priceResponse.json()) as { id: string }
    const subscriptionResponse = await stripe.fetch(
      new Request(`https://${MOCK_HOST}/v1/subscriptions`, {
        method: "POST",
        headers: form({ customer: customer.id, "items[0][price]": price.id }).headers,
        body: form({ customer: customer.id, "items[0][price]": price.id }).body,
      }),
    )
    expect(((await subscriptionResponse.json()) as { status: string }).status).toBe("active")
  })

  test("state is isolated per namespace and reset clears only Stripe", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,19}$/), async (name) => {
        const sqlite = new Database()
        const stripe = new StripeAPI({ sqlite, now })
        sqlite
          .prepare(
            `INSERT INTO mockingbird_records (namespace, collection, id, seq, value)
             VALUES ('other', 'keep', '1', 1, ?)`,
          )
          .run(JSON.stringify({ seq: 1, value: "keep" }))
        const created = await stripe.fetch(
          new Request(`https://${MOCK_HOST}/v1/customers`, {
            method: "POST",
            headers: { ...AUTH, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ name }),
          }),
        )
        expect(created.status).toBe(200)
        const { id } = (await created.json()) as { id: string }
        const fetched = await stripe.fetch(
          new Request(`https://${MOCK_HOST}/v1/customers/${id}`, { headers: AUTH }),
        )
        expect(((await fetched.json()) as { name: string }).name).toBe(name)
        await stripe.reset()
        const gone = await stripe.fetch(
          new Request(`https://${MOCK_HOST}/v1/customers/${id}`, { headers: AUTH }),
        )
        expect(gone.status).toBe(404)
        const other = sqlite
          .prepare(
            "SELECT value FROM mockingbird_records WHERE namespace = 'other' AND collection = 'keep' AND id = '1'",
          )
          .get<{ value: string }>()
        expect(other).toBeDefined()
      }),
      { ...params, numRuns: 10 },
    )
  })
})
