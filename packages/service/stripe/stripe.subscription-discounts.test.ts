import { afterEach, describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * Subscription extras an app sends at `2024-06-20` (stripe-node 16): `add_invoice_items` on
 * create and update, discounts on schedule phases, the `customer.discount.*` events, the singular
 * `coupon` / `promotion_code` parameters Stripe removed at 2025-03-31.basil, and the
 * `DELETE …/discount` endpoints.
 */

const KEY = "sk_test_subscriptionDiscounts1"
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
    accounts: [{ id: "acct_discounts", keys: [KEY], displayName: "Acme Fitness" }],
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const advance = (duration: string) => admin("POST", "/clock", { advance: duration })
  /** Every event, oldest first. */
  const allEvents = async () => (await stripe.events.list({ limit: 100 })).data.reverse()
  const events = async (type: string) =>
    (await allEvents())
      .filter((event) => event.type === type)
      .map((event) => event.data.object as unknown as Record<string, unknown>)
  /** A raw form request at `version` (the vendored dahlia contract when omitted). */
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
  return { server, stripe, admin, advance, events, allEvents, raw }
}

type Harness = Awaited<ReturnType<typeof harness>>

const plan = async (stripe: Stripe, amount = 9_900, name = "Pro") => {
  const product = await stripe.products.create({ name })
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month" },
  })
  return { product, price }
}

const payingCustomer = async (stripe: Stripe) => {
  const customer = await stripe.customers.create({ email: "member@example.com" })
  const method = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: method.id },
  })
  return customer
}

const expectStripeError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a Stripe error")
    },
    (error: unknown) => error as Stripe.errors.StripeError,
  )

const latestInvoice = async (h: Harness, subscription: Stripe.Subscription) =>
  h.stripe.invoices.retrieve(subscription.latest_invoice as string)

// --- #731 add_invoice_items ----------------------------------------------------------------------

describe("add_invoice_items", () => {
  test("a negative price_data item on create is a credit line on the first invoice", async () => {
    const h = await harness()
    const { product, price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      add_invoice_items: [
        { price_data: { currency: "usd", product: product.id, unit_amount: -2_000 }, quantity: 1 },
      ],
    })
    expect(subscription.status).toBe("active")
    const invoice = await latestInvoice(h, subscription)
    expect(invoice.lines.data.map((line) => line.amount).sort((a, b) => a - b)).toEqual([
      -2_000, 9_900,
    ])
    expect(invoice.total).toBe(7_900)
    expect(invoice.amount_paid).toBe(7_900)
    const credit = invoice.lines.data.find((line) => line.amount === -2_000)
    expect(credit?.type).toBe("invoiceitem")
    expect(typeof credit?.invoice_item).toBe("string")
    const item = await h.stripe.invoiceItems.retrieve(credit?.invoice_item as string)
    expect(item.invoice).toBe(invoice.id)
    expect(item.amount).toBe(-2_000)
  })

  test("a positive price_data item (quantity 2) on create is charged with the plan", async () => {
    const h = await harness()
    const { product, price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      add_invoice_items: [
        { price_data: { currency: "usd", product: product.id, unit_amount: 250 }, quantity: 2 },
      ],
    })
    const invoice = await latestInvoice(h, subscription)
    expect(invoice.total).toBe(10_400)
    expect(invoice.amount_paid).toBe(10_400)
  })

  test("update with always_invoice puts the items on the invoice it creates", async () => {
    const h = await harness()
    const { product, price } = await plan(h.stripe)
    const { price: bigger } = await plan(h.stripe, 19_900, "Max")
    const customer = await payingCustomer(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    const updated = await h.stripe.subscriptions.update(subscription.id, {
      items: [{ id: subscription.items.data[0]?.id as string, price: bigger.id }],
      proration_behavior: "always_invoice",
      add_invoice_items: [
        { price_data: { currency: "usd", product: product.id, unit_amount: 500 }, quantity: 1 },
      ],
    })
    expect(updated.latest_invoice).not.toBe(subscription.latest_invoice)
    const invoice = await latestInvoice(h, updated)
    expect(invoice.billing_reason).toBe("subscription_update")
    const extra = invoice.lines.data.find((line) => line.amount === 500 && !line.proration)
    expect(extra).toBeDefined()
    const prorated = invoice.lines.data
      .filter((line) => line !== extra)
      .reduce((sum, line) => sum + line.amount, 0)
    expect(invoice.total).toBe(prorated + 500)
    expect(invoice.status).toBe("paid")
  })

  test("update with always_invoice and only added items invoices them at once", async () => {
    const h = await harness()
    const { product, price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    const updated = await h.stripe.subscriptions.update(subscription.id, {
      proration_behavior: "always_invoice",
      add_invoice_items: [
        { price_data: { currency: "usd", product: product.id, unit_amount: 700 }, quantity: 1 },
      ],
    })
    const invoice = await latestInvoice(h, updated)
    expect(invoice.id).not.toBe(subscription.latest_invoice)
    expect(invoice.total).toBe(700)
    expect(invoice.status).toBe("paid")
  })

  test("update without an immediate invoice leaves pending items the next renewal bills", async () => {
    const h = await harness()
    const { product, price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    const updated = await h.stripe.subscriptions.update(subscription.id, {
      add_invoice_items: [
        { price_data: { currency: "usd", product: product.id, unit_amount: -1_500 }, quantity: 1 },
      ],
    })
    expect(updated.latest_invoice).toBe(subscription.latest_invoice)
    const pending = await h.stripe.invoiceItems.list({ customer: customer.id, pending: true })
    expect(pending.data.map((item) => item.amount)).toEqual([-1_500])
    await h.advance("32d")
    const renewal = (await h.stripe.invoices.list({ subscription: subscription.id })).data.find(
      (invoice) => invoice.billing_reason === "subscription_cycle",
    )
    expect(renewal?.total).toBe(8_400)
    expect(renewal?.amount_paid).toBe(8_400)
    expect(
      (await h.stripe.invoiceItems.list({ customer: customer.id, pending: true })).data,
    ).toEqual([])
  })

  test("sub-parameters the emulator does not model are refused, and nothing is created", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const error = await expectStripeError(
      h.stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.id }],
        add_invoice_items: [{ price: price.id, tax_rates: ["txr_123"] }],
      }),
    )
    expect(error.statusCode).toBe(400)
    expect(error.param).toBe("add_invoice_items[0][tax_rates]")
    expect(error.message).toContain("not modelled")
    expect((await h.stripe.subscriptions.list({ customer: customer.id })).data).toEqual([])
  })

  test("a recurring price is refused as an invoice item", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const error = await expectStripeError(
      h.stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.id }],
        add_invoice_items: [{ price: price.id }],
      }),
    )
    expect(error.param).toBe("add_invoice_items[0][price]")
  })
})

// --- proration_date ------------------------------------------------------------------------------

describe("proration_date on subscriptions.update", () => {
  test("prorates from the given time, and must fall within the current period", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe, 3_000)
    const { price: bigger } = await plan(h.stripe, 6_000, "Max")
    const customer = await payingCustomer(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    const start = subscription.current_period_start
    const end = subscription.current_period_end
    const outside = await expectStripeError(
      h.stripe.subscriptions.update(subscription.id, {
        items: [{ id: subscription.items.data[0]?.id as string, price: bigger.id }],
        proration_date: end + 86_400,
      }),
    )
    expect(outside.param).toBe("proration_date")
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).items.data[0]?.price.id).toBe(
      price.id,
    )
    // Prorating from the period's start charges the whole difference.
    await h.stripe.subscriptions.update(subscription.id, {
      items: [{ id: subscription.items.data[0]?.id as string, price: bigger.id }],
      proration_date: start,
    })
    const pending = await h.stripe.invoiceItems.list({ customer: customer.id, pending: true })
    expect(pending.data.map((item) => item.amount)).toEqual([3_000])
    expect(pending.data[0]?.period.start).toBe(start)
  })
})

// --- #732 schedule phase discounts --------------------------------------------------------------

describe("subscription schedule phase discounts", () => {
  test("update stores discounts on each phase and applies the current phase's to the subscription", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const first = await h.stripe.coupons.create({ percent_off: 20, duration: "forever" })
    const second = await h.stripe.coupons.create({
      amount_off: 1_000,
      currency: "usd",
      duration: "forever",
    })
    const promotion = await h.stripe.promotionCodes.create({ coupon: second.id, code: "LATER10" })
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    const schedule = await h.stripe.subscriptionSchedules.create({
      from_subscription: subscription.id,
    })
    const start = schedule.phases[0]?.start_date as number
    const end = schedule.phases[0]?.end_date as number
    const updated = await h.stripe.subscriptionSchedules.update(schedule.id, {
      phases: [
        {
          items: [{ price: price.id }],
          start_date: start,
          end_date: end,
          discounts: [{ coupon: first.id }],
        },
        { items: [{ price: price.id }], discounts: [{ promotion_code: promotion.id }] },
      ],
    })
    expect(updated.phases[0]?.discounts).toEqual([
      { coupon: first.id, discount: null, promotion_code: null },
    ])
    expect(updated.phases[1]?.discounts).toEqual([
      { coupon: null, discount: null, promotion_code: promotion.id },
    ])
    const during = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(during.discounts).toHaveLength(1)
    expect(during.discount?.coupon.id).toBe(first.id)
    await h.advance("32d")
    const later = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(later.discount?.coupon.id).toBe(second.id)
    expect(later.discount?.promotion_code).toBe(promotion.id)
    const renewal = (await h.stripe.invoices.list({ subscription: subscription.id })).data.find(
      (invoice) => invoice.billing_reason === "subscription_cycle",
    )
    expect(renewal?.total).toBe(8_900)
  })

  test("create applies the first phase's discounts to the subscription it starts", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 50, duration: "forever" })
    const schedule = await h.stripe.subscriptionSchedules.create({
      customer: customer.id,
      start_date: "now",
      phases: [{ items: [{ price: price.id }], discounts: [{ coupon: coupon.id }] }],
    })
    expect(schedule.phases[0]?.discounts).toEqual([
      { coupon: coupon.id, discount: null, promotion_code: null },
    ])
    const subscription = await h.stripe.subscriptions.retrieve(schedule.subscription as string)
    expect(subscription.discount?.coupon.id).toBe(coupon.id)
    const invoice = await latestInvoice(h, subscription)
    expect(invoice.total).toBe(4_950)
  })

  test("a phase's legacy coupon is a discount at 2024-06-20 and parameter_unknown at basil", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 10, duration: "forever" })
    const schedule = await h.stripe.subscriptionSchedules.create({
      customer: customer.id,
      start_date: "now",
      phases: [{ items: [{ price: price.id }], coupon: coupon.id }],
    })
    expect(schedule.phases[0]?.discounts).toEqual([
      { coupon: coupon.id, discount: null, promotion_code: null },
    ])
    const subscription = await h.stripe.subscriptions.retrieve(schedule.subscription as string)
    expect(subscription.discount?.coupon.id).toBe(coupon.id)
    const refused = await h.raw(
      "POST",
      "/v1/subscription_schedules",
      `customer=${customer.id}&start_date=now&phases[0][items][0][price]=${price.id}&phases[0][coupon]=${coupon.id}`,
      DAHLIA,
    )
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe("parameter_unknown")
    expect(refused.body.error.param).toBe("phases[0][coupon]")
  })

  test("an unknown coupon on a phase is refused before anything changes", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const error = await expectStripeError(
      h.stripe.subscriptionSchedules.create({
        customer: customer.id,
        start_date: "now",
        phases: [{ items: [{ price: price.id }], discounts: [{ coupon: "nope" }] }],
      }),
    )
    expect(error.code).toBe("resource_missing")
    expect(error.param).toBe("phases[0][discounts][0][coupon]")
    expect((await h.stripe.subscriptions.list({ customer: customer.id })).data).toEqual([])
  })
})

// --- #733 customer.discount.* events ------------------------------------------------------------

describe("customer.discount events", () => {
  test("adding then clearing subscription discounts emits created then deleted", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 15, duration: "forever" })
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    const discounted = await h.stripe.subscriptions.update(subscription.id, {
      discounts: [{ coupon: coupon.id }],
    })
    const discountId = discounted.discounts[0] as string
    const [created] = await h.events("customer.discount.created")
    expect(created?.object).toBe("discount")
    expect(created?.id).toBe(discountId)
    expect(created?.subscription).toBe(subscription.id)
    expect((created?.coupon as Record<string, unknown> | undefined)?.id).toBe(coupon.id)
    await h.stripe.subscriptions.update(subscription.id, { discounts: "" })
    const [deleted] = await h.events("customer.discount.deleted")
    expect(deleted?.id).toBe(discountId)
    expect(deleted?.object).toBe("discount")
    const types = (await h.allEvents()).map((event) => event.type)
    expect(types.indexOf("customer.discount.created")).toBeLessThan(
      types.indexOf("customer.discount.deleted"),
    )
  })

  test("discounts on create emit customer.discount.created", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 15, duration: "forever" })
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      discounts: [{ coupon: coupon.id }],
    })
    const created = await h.events("customer.discount.created")
    expect(created.map((discount) => discount.id)).toEqual(subscription.discounts as string[])
  })
})

// --- #736b singular coupon / promotion_code -----------------------------------------------------

describe("legacy coupon and promotion_code parameters", () => {
  test("subscriptions.create and update accept coupon / promotion_code at 2024-06-20", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 10, duration: "forever" })
    const other = await h.stripe.coupons.create({ percent_off: 30, duration: "forever" })
    const promotion = await h.stripe.promotionCodes.create({ coupon: other.id, code: "THIRTY" })
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      coupon: coupon.id,
    })
    expect(subscription.discount?.coupon.id).toBe(coupon.id)
    expect((await latestInvoice(h, subscription)).total).toBe(8_910)
    const switched = await h.stripe.subscriptions.update(subscription.id, {
      promotion_code: promotion.id,
    })
    expect(switched.discounts).toHaveLength(1)
    expect(switched.discount?.coupon.id).toBe(other.id)
    expect(switched.discount?.promotion_code).toBe(promotion.id)
    const removed = await h.stripe.subscriptions.update(subscription.id, { coupon: "" })
    expect(removed.discount).toBeNull()
    expect(removed.discounts).toEqual([])
  })

  test("coupon with discounts in one request is refused", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 10, duration: "forever" })
    const error = await expectStripeError(
      h.stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.id }],
        coupon: coupon.id,
        discounts: [{ coupon: coupon.id }],
      }),
    )
    expect(error.statusCode).toBe(400)
    expect(error.param).toBe("coupon")
  })

  test("the singular parameters are parameter_unknown from 2025-03-31.basil on", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 10, duration: "forever" })
    for (const version of ["2025-03-31.basil", DAHLIA]) {
      const created = await h.raw(
        "POST",
        "/v1/subscriptions",
        `customer=${customer.id}&items[0][price]=${price.id}&coupon=${coupon.id}`,
        version,
      )
      expect(created.status).toBe(400)
      expect(created.body.error.code).toBe("parameter_unknown")
      expect(created.body.error.param).toBe("coupon")
      const cus = await h.raw("POST", `/v1/customers/${customer.id}`, "promotion_code=x", version)
      expect(cus.body.error.code).toBe("parameter_unknown")
      expect(cus.body.error.param).toBe("promotion_code")
    }
    expect((await h.stripe.subscriptions.list({ customer: customer.id })).data).toEqual([])
    const acacia = await h.raw(
      "POST",
      "/v1/subscriptions",
      `customer=${customer.id}&items[0][price]=${price.id}&coupon=${coupon.id}`,
      "2025-02-24.acacia",
    )
    expect(acacia.status).toBe(200)
  })

  test("customers.update coupon sets the customer discount, which later subscriptions use", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 25, duration: "forever" })
    const updated = await h.stripe.customers.update(customer.id, { coupon: coupon.id })
    expect(updated.discount?.coupon.id).toBe(coupon.id)
    expect(updated.discount?.customer).toBe(customer.id)
    expect(updated.discount?.subscription).toBeNull()
    const [created] = await h.events("customer.discount.created")
    expect(created?.id).toBe(updated.discount?.id)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    expect((await latestInvoice(h, subscription)).total).toBe(7_425)
    const other = await h.stripe.coupons.create({ percent_off: 5, duration: "forever" })
    const switched = await h.stripe.customers.update(customer.id, { coupon: other.id })
    expect(switched.discount?.coupon.id).toBe(other.id)
    expect((await h.events("customer.discount.updated"))[0]?.id).toBe(switched.discount?.id)
  })

  test("customers.create accepts promotion_code at 2024-06-20", async () => {
    const h = await harness()
    const coupon = await h.stripe.coupons.create({ percent_off: 25, duration: "forever" })
    const promotion = await h.stripe.promotionCodes.create({ coupon: coupon.id, code: "WELCOME" })
    const customer = await h.stripe.customers.create({ promotion_code: promotion.id })
    expect(customer.discount?.promotion_code).toBe(promotion.id)
    expect((await h.stripe.customers.retrieve(customer.id)) as Stripe.Customer).toMatchObject({
      discount: { coupon: { id: coupon.id } },
    })
  })
})

// --- #736c DELETE …/discount ----------------------------------------------------------------------

describe("deleting discounts", () => {
  test("subscriptions.deleteDiscount removes the discount and emits customer.discount.deleted", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 15, duration: "forever" })
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      discounts: [{ coupon: coupon.id }],
    })
    const deleted = await h.stripe.subscriptions.deleteDiscount(subscription.id)
    expect(deleted.object).toBe("discount")
    expect(deleted.deleted).toBe(true)
    expect(deleted.id).toBe(subscription.discounts[0] as string)
    const after = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(after.discount).toBeNull()
    expect(after.discounts).toEqual([])
    expect((await h.events("customer.discount.deleted"))[0]?.id).toBe(deleted.id)
    const again = await expectStripeError(h.stripe.subscriptions.deleteDiscount(subscription.id))
    expect(again.statusCode).toBe(404)
  })

  test("customers.deleteDiscount removes the customer discount", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const coupon = await h.stripe.coupons.create({ percent_off: 15, duration: "forever" })
    const discounted = await h.stripe.customers.update(customer.id, { coupon: coupon.id })
    const deleted = await h.stripe.customers.deleteDiscount(customer.id)
    expect(deleted.deleted).toBe(true)
    expect(deleted.id).toBe(discounted.discount?.id as string)
    const after = (await h.stripe.customers.retrieve(customer.id)) as Stripe.Customer
    expect(after.discount).toBeNull()
    expect((await h.events("customer.discount.deleted"))[0]?.id).toBe(deleted.id)
  })
})

// --- #736a event order --------------------------------------------------------------------------

describe("subscription event order", () => {
  test("customer.subscription.created comes before the update that activates it", async () => {
    const h = await harness()
    const { price } = await plan(h.stripe)
    const customer = await payingCustomer(h.stripe)
    await h.stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] })
    const types = (await h.allEvents())
      .map((event) => event.type)
      .filter((type) => type.startsWith("customer.subscription."))
    expect(types[0]).toBe("customer.subscription.created")
  })
})
