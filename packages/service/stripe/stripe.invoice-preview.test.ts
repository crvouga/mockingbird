import { afterEach, describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * Invoice previews (`POST /v1/invoices/create_preview`, `GET /v1/invoices/upcoming` and its
 * `/lines`) quoting a signup or a plan change before anything is charged, and marking an invoice
 * uncollectible. Driven through stripe-node 16.12 at 2024-06-20, as our backend calls them.
 */

const KEY = "sk_test_invoicePreview1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const harness = async () => {
  const server = await createServer({
    accounts: [{ id: "acct_preview", keys: [KEY], displayName: "Acme Fitness" }],
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  const raw = async (method: string, path: string, body?: URLSearchParams, version?: string) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        ...(version === undefined ? {} : { "stripe-version": version }),
        ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(body === undefined ? {} : { body: body.toString() }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const eventCount = async () => (await stripe.events.list({ limit: 100 })).data.length
  return { server, stripe, raw, eventCount }
}

type Harness = Awaited<ReturnType<typeof harness>>

const monthly = async (stripe: Stripe, amount: number, name: string) => {
  const product = await stripe.products.create({ name })
  return stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month" },
  })
}

const payingCustomer = async (stripe: Stripe) => {
  const customer = await stripe.customers.create({ email: "member@example.com" })
  const method = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: method.id },
  })
  return customer
}

const subscribed = async ({ stripe }: Harness) => {
  const customer = await payingCustomer(stripe)
  const basic = await monthly(stripe, 2_000, "Basic")
  const pro = await monthly(stripe, 5_000, "Pro")
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: basic.id }],
  })
  expect(subscription.status).toBe("active")
  return { customer, basic, pro, subscription, item: subscription.items.data[0]?.id ?? "" }
}

const expectStripeError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a Stripe error")
    },
    (error: unknown) => error as Stripe.errors.StripeError,
  )

/** Stripe's proration share of the period left after `at`, as the update path computes it. */
const share = (subscription: Stripe.Subscription, at: number) =>
  (subscription.current_period_end - at) /
  (subscription.current_period_end - subscription.current_period_start)

/** Stripe's proration descriptions date the change as `01 Sep 2020` (UTC). */
const day = (at: number) => {
  const date = new Date(at * 1000)
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  return `${String(date.getUTCDate()).padStart(2, "0")} ${month} ${date.getUTCFullYear()}`
}

/** What a preview must not leave behind: records, redemptions or events. */
const snapshot = async ({ stripe, eventCount }: Harness) => ({
  invoices: (await stripe.invoices.list({ limit: 100 })).data.length,
  subscriptions: (await stripe.subscriptions.list({ limit: 100, status: "all" })).data.length,
  items: (await stripe.invoiceItems.list({ limit: 100 })).data.length,
  events: await eventCount(),
})

describe("POST /v1/invoices/create_preview", () => {
  test("previews a new subscription's first invoice for a customer without writing anything", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const price = await monthly(h.stripe, 2_000, "Pro")
    const before = await snapshot(h)
    const preview = await h.stripe.invoices.createPreview({
      customer: customer.id,
      subscription_details: { items: [{ price: price.id, quantity: 2 }] },
    })
    expect(preview.object).toBe("invoice")
    expect(preview.id).toStartWith("upcoming_in_")
    expect(preview.status).toBe("draft")
    expect(preview.customer).toBe(customer.id)
    expect(preview.lines.data).toHaveLength(1)
    const [line] = preview.lines.data
    expect(line?.amount).toBe(4_000)
    expect(line?.quantity).toBe(2)
    expect(line?.price?.id).toBe(price.id)
    expect(line?.proration).toBe(false)
    expect(line?.period.end).toBeGreaterThan(line?.period.start ?? 0)
    expect(preview.subtotal).toBe(4_000)
    expect(preview.total).toBe(4_000)
    expect(preview.amount_due).toBe(4_000)
    expect(await snapshot(h)).toEqual(before)
  })

  test("applies requested coupons as discounts without redeeming them", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const price = await monthly(h.stripe, 2_000, "Pro")
    const coupon = await h.stripe.coupons.create({ percent_off: 25, duration: "once" })
    const before = await snapshot(h)
    const preview = await h.stripe.invoices.createPreview({
      customer: customer.id,
      subscription_details: { items: [{ price: price.id }] },
      discounts: [{ coupon: coupon.id }],
    })
    expect(preview.subtotal).toBe(2_000)
    expect(preview.total).toBe(1_500)
    expect(preview.total_discount_amounts?.map((entry) => entry.amount)).toEqual([500])
    expect(preview.discount?.coupon.id).toBe(coupon.id)
    expect(preview.lines.data[0]?.discount_amounts?.map((entry) => entry.amount)).toEqual([500])
    expect((await h.stripe.coupons.retrieve(coupon.id)).times_redeemed).toBe(0)
    expect(await snapshot(h)).toEqual(before)
  })

  test("previews a signup for someone who is not a customer yet through customer_details", async () => {
    const h = await harness()
    const price = await monthly(h.stripe, 2_000, "Pro")
    const preview = await h.stripe.invoices.createPreview({
      customer_details: { tax_exempt: "none" },
      subscription_details: { items: [{ price: price.id }] },
    })
    expect(preview.customer).toBeNull()
    expect(preview.total).toBe(2_000)
    expect(preview.lines.data[0]?.amount).toBe(2_000)
  })

  test("previews a plan change: credit, charge for the rest of the period, then the next cycle", async () => {
    const h = await harness()
    const { subscription, item, basic, pro } = await subscribed(h)
    const at = subscription.current_period_start + 10 * 86_400
    const before = await snapshot(h)
    const preview = await h.stripe.invoices.createPreview({
      subscription: subscription.id,
      subscription_details: {
        items: [{ id: item, price: pro.id }],
        proration_behavior: "create_prorations",
        proration_date: at,
      },
    })
    const left = share(subscription, at)
    const credit = -Math.round(2_000 * left)
    const charge = Math.round((5_000 - 2_000) * left) - credit
    const lines = preview.lines.data
    expect(lines.map((line) => line.amount)).toEqual([credit, charge, 5_000])
    expect(lines.map((line) => line.proration)).toEqual([true, true, false])
    expect(lines[0]?.price?.id).toBe(basic.id)
    expect(lines[0]?.description).toBe(`Unused time on Basic after ${day(at)}`)
    expect(lines[1]?.description).toBe(`Remaining time on Pro after ${day(at)}`)
    expect(lines[0]?.period).toEqual({ start: at, end: subscription.current_period_end })
    expect(lines[0]?.subscription_item).toBe(item)
    expect(lines[2]?.period.start).toBe(subscription.current_period_end)
    expect(preview.subtotal).toBe(credit + charge + 5_000)
    expect(preview.total).toBe(credit + charge + 5_000)
    // Nothing changed: the subscription is still on Basic and no proration item is pending.
    expect(await snapshot(h)).toEqual(before)
    const after = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(after.items.data[0]?.price.id).toBe(basic.id)
  })

  test("defaults the proration date to now and matches what the update then bills", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const preview = await h.stripe.invoices.createPreview({
      subscription: subscription.id,
      subscription_details: { items: [{ id: item, price: pro.id }] },
    })
    const prorated = preview.lines.data
      .filter((line) => line.proration)
      .reduce((sum, line) => sum + line.amount, 0)
    await h.stripe.subscriptions.update(subscription.id, { items: [{ id: item, price: pro.id }] })
    const pending = (
      await h.stripe.invoiceItems.list({ customer: subscription.customer as string })
    ).data
    expect(pending).toHaveLength(1)
    // The served clock ticks in real time between the two calls: allow the cent it may move.
    expect(Math.abs((pending[0]?.amount ?? 0) - prorated)).toBeLessThanOrEqual(1)
  })

  test("proration_behavior=none previews only the next cycle at the new price", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const preview = await h.stripe.invoices.createPreview({
      subscription: subscription.id,
      subscription_details: { items: [{ id: item, price: pro.id }], proration_behavior: "none" },
    })
    expect(preview.lines.data.map((line) => [line.amount, line.proration])).toEqual([
      [5_000, false],
    ])
    expect(preview.total).toBe(5_000)
  })

  test("proration_behavior=always_invoice previews the invoice the change bills at once", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const at = subscription.current_period_start + 15 * 86_400
    const preview = await h.stripe.invoices.createPreview({
      subscription: subscription.id,
      subscription_details: {
        items: [{ id: item, price: pro.id }],
        proration_behavior: "always_invoice",
        proration_date: at,
      },
    })
    const left = share(subscription, at)
    const credit = -Math.round(2_000 * left)
    const charge = Math.round(3_000 * left) - credit
    expect(preview.lines.data.map((line) => line.amount)).toEqual([credit, charge])
    expect(preview.billing_reason).toBe("subscription_update")
    expect(preview.total).toBe(credit + charge)
  })

  test("adding and removing items prorates each one", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const at = subscription.current_period_start + 20 * 86_400
    const preview = await h.stripe.invoices.createPreview({
      subscription: subscription.id,
      subscription_details: {
        items: [
          { id: item, deleted: true },
          { price: pro.id, quantity: 2 },
        ],
        proration_date: at,
      },
    })
    const left = share(subscription, at)
    expect(preview.lines.data.map((line) => line.amount)).toEqual([
      -Math.round(2_000 * left),
      Math.round(10_000 * left),
      10_000,
    ])
    expect(preview.lines.data[1]?.description).toStartWith("Remaining time on 2 × Pro after ")
  })

  test("a subscription without changes previews its renewal with the pending prorations", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    await h.stripe.subscriptions.update(subscription.id, { items: [{ id: item, price: pro.id }] })
    const [pending] = (
      await h.stripe.invoiceItems.list({ customer: subscription.customer as string })
    ).data
    const preview = await h.stripe.invoices.createPreview({ subscription: subscription.id })
    expect(preview.lines.data.map((line) => line.amount)).toEqual([pending?.amount ?? NaN, 5_000])
    expect(preview.next_payment_attempt).toBe(subscription.current_period_end)
  })

  test("a customer without subscriptions previews their pending invoice items", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    await h.stripe.invoiceItems.create({ customer: customer.id, amount: 700, currency: "usd" })
    const preview = await h.stripe.invoices.createPreview({ customer: customer.id })
    expect(preview.billing_reason).toBe("manual")
    expect(preview.lines.data.map((line) => line.amount)).toEqual([700])
    expect(preview.total).toBe(700)
  })

  test("renders the preview in the requested API version's shape", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const price = await monthly(h.stripe, 2_000, "Pro")
    const body = new URLSearchParams({
      customer: customer.id,
      "subscription_details[items][0][price]": price.id,
    })
    const latest = await h.raw("POST", "/v1/invoices/create_preview", body)
    expect(latest.status).toBe(200)
    expect(latest.body.id).toBeString()
    expect(latest.body).not.toHaveProperty("subscription")
    expect(latest.body).not.toHaveProperty("discount")
    const legacy = await h.raw("POST", "/v1/invoices/create_preview", body, "2024-06-20")
    expect(legacy.body).toHaveProperty("subscription", null)
    expect(legacy.body).toHaveProperty("discount", null)
  })

  test("refuses a proration date outside the current period", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const error = await expectStripeError(
      h.stripe.invoices.createPreview({
        subscription: subscription.id,
        subscription_details: {
          items: [{ id: item, price: pro.id }],
          proration_date: subscription.current_period_end + 86_400,
        },
      }),
    )
    expect(error.statusCode).toBe(400)
    expect(error.param).toBe("subscription_details[proration_date]")
  })

  test("refuses a proration date with proration_behavior=none", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const error = await expectStripeError(
      h.stripe.invoices.createPreview({
        subscription: subscription.id,
        subscription_details: {
          items: [{ id: item, price: pro.id }],
          proration_behavior: "none",
          proration_date: subscription.current_period_start + 86_400,
        },
      }),
    )
    expect(error.statusCode).toBe(400)
    expect(error.param).toBe("subscription_details[proration_date]")
  })

  test("refuses an unknown subscription item and a missing price", async () => {
    const h = await harness()
    const { subscription } = await subscribed(h)
    const unknown = await expectStripeError(
      h.stripe.invoices.createPreview({
        subscription: subscription.id,
        subscription_details: { items: [{ id: "si_missing", quantity: 2 }] },
      }),
    )
    expect(unknown.code).toBe("resource_missing")
    expect(unknown.param).toBe("subscription_details[items][0][id]")
    const missing = await expectStripeError(
      h.stripe.invoices.createPreview({
        subscription: subscription.id,
        subscription_details: { items: [{ price: "price_missing" }] },
      }),
    )
    expect(missing.code).toBe("resource_missing")
    expect(missing.param).toBe("subscription_details[items][0][price]")
  })

  test("parameters the emulator does not model are refused, not ignored", async () => {
    const h = await harness()
    const { subscription, item } = await subscribed(h)
    const trial = await expectStripeError(
      h.stripe.invoices.createPreview({
        subscription: subscription.id,
        subscription_details: { items: [{ id: item, quantity: 2 }], trial_end: "now" },
      }),
    )
    expect(trial.statusCode).toBe(400)
    expect(trial.param).toBe("subscription_details[trial_end]")
    expect(trial.message).toContain("not modelled")
    const tax = await expectStripeError(
      h.stripe.invoices.createPreview({
        subscription: subscription.id,
        automatic_tax: { enabled: true },
      }),
    )
    expect(tax.param).toBe("automatic_tax[enabled]")
    expect(tax.message).toContain("not modelled")
  })
})

describe("GET /v1/invoices/upcoming", () => {
  test("previews prorations from subscription_items and subscription_proration_date", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const at = subscription.current_period_start + 10 * 86_400
    const before = await snapshot(h)
    const upcoming = await h.stripe.invoices.retrieveUpcoming({
      subscription: subscription.id,
      subscription_items: [{ id: item, price: pro.id }],
      subscription_proration_date: at,
      subscription_proration_behavior: "create_prorations",
    })
    const left = share(subscription, at)
    const credit = -Math.round(2_000 * left)
    const charge = Math.round(3_000 * left) - credit
    expect(upcoming.lines.data.map((line) => line.amount)).toEqual([credit, charge, 5_000])
    expect(upcoming.lines.data[0]?.type).toBe("invoiceitem")
    expect(upcoming.lines.data[0]?.discountable).toBe(false)
    expect(await snapshot(h)).toEqual(before)
  })

  test("accepts subscription_details like create_preview", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const upcoming = await h.stripe.invoices.retrieveUpcoming({
      subscription: subscription.id,
      subscription_details: {
        items: [{ id: item, price: pro.id, quantity: 3 }],
        proration_behavior: "none",
      },
    })
    expect(upcoming.lines.data.map((line) => line.amount)).toEqual([15_000])
  })

  test("refuses subscription_* parameters it does not model", async () => {
    const h = await harness()
    const { subscription } = await subscribed(h)
    const error = await expectStripeError(
      h.stripe.invoices.retrieveUpcoming({
        subscription: subscription.id,
        subscription_cancel_now: true,
      }),
    )
    expect(error.statusCode).toBe(400)
    expect(error.param).toBe("subscription_cancel_now")
  })

  test("GET /v1/invoices/upcoming/lines pages the same preview's lines", async () => {
    const h = await harness()
    const { subscription, item, pro } = await subscribed(h)
    const first = await h.stripe.invoices.listUpcomingLines({
      subscription: subscription.id,
      subscription_items: [{ id: item, price: pro.id }],
      limit: 2,
    })
    expect(first.object).toBe("list")
    expect(first.data).toHaveLength(2)
    expect(first.has_more).toBe(true)
    const rest = await h.stripe.invoices.listUpcomingLines({
      subscription: subscription.id,
      subscription_items: [{ id: item, price: pro.id }],
      starting_after: first.data[1]?.id ?? "",
    })
    expect(rest.data.map((line) => line.amount)).toEqual([5_000])
    expect(rest.has_more).toBe(false)
  })
})

describe("POST /v1/invoices/:id/mark_uncollectible", () => {
  const openInvoice = async ({ stripe }: Harness) => {
    const customer = await stripe.customers.create({ email: "owed@example.com" })
    await stripe.invoiceItems.create({ customer: customer.id, amount: 1_200, currency: "usd" })
    const draft = await stripe.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: 30,
      pending_invoice_items_behavior: "include",
    })
    return stripe.invoices.finalizeInvoice(draft.id)
  }

  test("marks an open invoice uncollectible and announces it", async () => {
    const h = await harness()
    const open = await openInvoice(h)
    expect(open.status).toBe("open")
    const marked = await h.stripe.invoices.markUncollectible(open.id)
    expect(marked.status).toBe("uncollectible")
    expect(marked.status_transitions.marked_uncollectible_at).toBeNumber()
    const events = (await h.stripe.events.list({ limit: 100 })).data.map((event) => event.type)
    expect(events).toContain("invoice.marked_uncollectible")
    expect(events).toContain("invoice.updated")
    expect((await h.stripe.invoices.retrieve(open.id)).status).toBe("uncollectible")
  })

  test("refuses an invoice that is not open", async () => {
    const h = await harness()
    const customer = await h.stripe.customers.create({ email: "draft@example.com" })
    const draft = await h.stripe.invoices.create({ customer: customer.id })
    const error = await expectStripeError(h.stripe.invoices.markUncollectible(draft.id))
    expect(error.statusCode).toBe(400)
    expect(error.message).toBe("You can only mark open invoices as uncollectible.")
    const missing = await expectStripeError(h.stripe.invoices.markUncollectible("in_missing"))
    expect(missing.statusCode).toBe(404)
  })
})
