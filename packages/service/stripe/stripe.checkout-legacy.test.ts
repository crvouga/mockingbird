import { afterEach, describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * Checkout as an app on stripe-node 16 (`2024-06-20`) drives it: the pre-dahlia `ui_mode` names,
 * `payment_intent_data[capture_method]`, the subscription events a hosted completion sends, and
 * Stripe's four-level expansion limit on `total_details.breakdown`.
 */

const KEY = "sk_test_checkoutLegacy1"
const DAHLIA = "2026-08-26.dahlia"

/** A raw response body: an error, or the object's fields. */
type RawBody = { error: { code?: string; param?: string; message: string } } & Record<
  string,
  unknown
>

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const harness = async () => {
  const server = await createServer({
    accounts: [{ id: "acct_checkout_legacy", keys: [KEY], displayName: "Acme Fitness" }],
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  const raw = async (method: string, path: string, form: string, version?: string) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(version === undefined ? {} : { "stripe-version": version }),
      },
      ...(method === "GET" ? {} : { body: form }),
    })
    return { status: response.status, body: (await response.json()) as RawBody }
  }
  const complete = (session: string) =>
    fetch(`${server.url}/__admin/checkout/sessions/${session}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  return { server, stripe, raw, complete }
}

const post = (url: string, fields: Record<string, string>) =>
  fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams(fields) })

const pay = (url: string, card: string) =>
  post(url, { action: "pay", card, exp: "12 / 34", cvc: "123", zip: "94107" })

const expectStripeError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a Stripe error")
    },
    (error: unknown) => error as Stripe.errors.StripeError,
  )

const oneTimeLine = (product: string, amount = 4_000) => ({
  price_data: { currency: "usd", unit_amount: amount, product },
  quantity: 1,
})

describe("ui_mode at 2024-06-20", () => {
  test("hosted is the default and renders under its pre-dahlia name", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Mat" })
    const session = await h.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [oneTimeLine(product.id)],
      success_url: "http://localhost/done",
    })
    expect(session.ui_mode).toBe("hosted")
    const explicit = await h.stripe.checkout.sessions.create({
      mode: "payment",
      ui_mode: "hosted",
      line_items: [oneTimeLine(product.id)],
      success_url: "http://localhost/done",
    })
    expect(explicit.ui_mode).toBe("hosted")
    const latest = await h.raw("GET", `/v1/checkout/sessions/${explicit.id}`, "", DAHLIA)
    expect(latest.body.ui_mode).toBe("hosted_page")
  })

  test("embedded returns a client secret and return_url instead of a hosted url", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Mat" })
    const session = await h.stripe.checkout.sessions.create({
      mode: "payment",
      ui_mode: "embedded",
      line_items: [oneTimeLine(product.id)],
      return_url: "http://localhost/return?session_id={CHECKOUT_SESSION_ID}",
    })
    expect(session.ui_mode).toBe("embedded")
    expect(session.url).toBeNull()
    expect(session.client_secret).toStartWith(`${session.id}_secret_`)
    expect(session.return_url).toBe("http://localhost/return?session_id={CHECKOUT_SESSION_ID}")
    expect((await h.complete(session.id)).status).toBe(200)
    expect((await h.stripe.checkout.sessions.retrieve(session.id)).status).toBe("complete")
    const latest = await h.raw("GET", `/v1/checkout/sessions/${session.id}`, "", DAHLIA)
    expect(latest.body.ui_mode).toBe("embedded_page")
  })

  test("embedded refuses success_url and requires return_url", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Mat" })
    const withSuccess = await expectStripeError(
      h.stripe.checkout.sessions.create({
        mode: "payment",
        ui_mode: "embedded",
        line_items: [oneTimeLine(product.id)],
        success_url: "http://localhost/done",
        return_url: "http://localhost/return",
      }),
    )
    expect(withSuccess.param).toBe("success_url")
    const missing = await expectStripeError(
      h.stripe.checkout.sessions.create({
        mode: "payment",
        ui_mode: "embedded",
        line_items: [oneTimeLine(product.id)],
      }),
    )
    expect(missing.param).toBe("return_url")
  })

  test("the old names are refused at dahlia and the new ones at 2024-06-20", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Mat" })
    const line = `mode=payment&line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=100&line_items[0][price_data][product]=${product.id}&line_items[0][quantity]=1`
    const old = await h.raw(
      "POST",
      "/v1/checkout/sessions",
      `${line}&ui_mode=embedded&return_url=http://localhost/r`,
      DAHLIA,
    )
    expect(old.status).toBe(400)
    expect(old.body.error.param).toBe("ui_mode")
    const renamed = await h.raw(
      "POST",
      "/v1/checkout/sessions",
      `${line}&ui_mode=embedded_page&return_url=http://localhost/r`,
      "2024-06-20",
    )
    expect(renamed.status).toBe(400)
    expect(renamed.body.error.param).toBe("ui_mode")
    const current = await h.raw(
      "POST",
      "/v1/checkout/sessions",
      `${line}&ui_mode=embedded_page&return_url=http://localhost/r`,
      DAHLIA,
    )
    expect(current.status).toBe(200)
    expect(current.body.ui_mode).toBe("embedded_page")
  })

  test("custom (basil) / elements (dahlia) Checkout is an explicit emulator limitation", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Mat" })
    const line = `mode=payment&line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=100&line_items[0][price_data][product]=${product.id}&line_items[0][quantity]=1&return_url=http://localhost/r`
    // `custom` arrived at 2025-03-31.basil: stripe-node 16 (2024-06-20) cannot name it.
    const legacy = await h.raw(
      "POST",
      "/v1/checkout/sessions",
      `${line}&ui_mode=custom`,
      "2024-06-20",
    )
    expect(legacy.body.error.message).toBe("Invalid ui_mode: must be one of embedded or hosted")
    for (const [version, mode] of [
      ["2025-03-31.basil", "custom"],
      [DAHLIA, "elements"],
    ] as const) {
      const refused = await h.raw(
        "POST",
        "/v1/checkout/sessions",
        `${line}&ui_mode=${mode}`,
        version,
      )
      expect(refused.status).toBe(400)
      expect(refused.body.error.param).toBe("ui_mode")
      expect(refused.body.error.message).toContain("not modelled")
    }
    expect((await h.stripe.checkout.sessions.list()).data).toEqual([])
  })
})

describe("payment_intent_data[capture_method]", () => {
  test("manual leaves the PaymentIntent requires_capture and the charge uncaptured", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Mat" })
    const session = await h.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [oneTimeLine(product.id, 4_000)],
      payment_intent_data: { capture_method: "manual" },
      success_url: "http://localhost/done",
    })
    expect((await pay(session.url as string, "4242424242424242")).status).toBe(302)
    const done = await h.stripe.checkout.sessions.retrieve(session.id, {
      expand: ["payment_intent.latest_charge"],
    })
    expect(done.status).toBe("complete")
    expect(done.payment_status).toBe("unpaid")
    const intent = done.payment_intent as Stripe.PaymentIntent
    expect(intent.capture_method).toBe("manual")
    expect(intent.status).toBe("requires_capture")
    expect(intent.amount_capturable).toBe(4_000)
    expect((intent.latest_charge as Stripe.Charge).captured).toBe(false)
    const captured = await h.stripe.paymentIntents.capture(intent.id)
    expect(captured.status).toBe("succeeded")
  })
})

describe("hosted subscription Checkout events", () => {
  test("customer.subscription.created comes before customer.subscription.updated", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Pro" })
    const price = await h.stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: 2_000,
      recurring: { interval: "month" },
    })
    const session = await h.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: "http://localhost/done",
    })
    expect((await pay(session.url as string, "4242424242424242")).status).toBe(302)
    const types = (await h.stripe.events.list({ limit: 100 })).data
      .reverse()
      .map((event) => event.type)
      .filter((type) => type.startsWith("customer.subscription."))
    expect(types[0]).toBe("customer.subscription.created")
    expect(types.indexOf("customer.subscription.created")).toBeLessThan(
      Math.max(types.indexOf("customer.subscription.updated"), 1),
    )
  })
})

describe("expanding total_details.breakdown", () => {
  test("total_details.breakdown expands; one level deeper than four is refused as Stripe does", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Mat" })
    const coupon = await h.stripe.coupons.create({ percent_off: 25, duration: "once" })
    const session = await h.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [oneTimeLine(product.id, 4_000)],
      discounts: [{ coupon: coupon.id }],
      success_url: "http://localhost/done",
    })
    expect(session.total_details?.breakdown).toBeUndefined()
    const expanded = await h.stripe.checkout.sessions.retrieve(session.id, {
      expand: ["total_details.breakdown"],
    })
    const breakdown = expanded.total_details?.breakdown
    expect(breakdown?.taxes).toEqual([])
    expect(breakdown?.discounts).toHaveLength(1)
    expect(breakdown?.discounts[0]?.amount).toBe(1_000)
    expect(breakdown?.discounts[0]?.discount.object).toBe("discount")
    // At 2024-06-20 a discount embeds its coupon, so four levels already reach it.
    expect(breakdown?.discounts[0]?.discount.coupon.id).toBe(coupon.id)
    const tooDeep = await expectStripeError(
      h.stripe.checkout.sessions.retrieve(session.id, {
        expand: ["total_details.breakdown.discounts.discount.coupon"],
      }),
    )
    expect(tooDeep.statusCode).toBe(400)
    expect(tooDeep.code).toBe("property_expansion_max_depth")
  })
})
