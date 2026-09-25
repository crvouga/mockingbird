import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import Stripe from "stripe"
import { supportedOperationIds } from "./src/index.js"
import { createServer, type StripeServer } from "./src/server.js"
import { partnerClient, stripeClientOptions } from "./test/consumer.js"

/**
 * Drop-in proof: the official SDK our backends pin (stripe-node 16.12) pointed at the mock with
 * only `host`/`port`/`protocol`, at `2024-06-20` and at `2025-02-24.acacia`, plus the partner
 * platform's stripe-node 17.7. One scenario walks every S1.4 operation; the mock's request
 * journal proves each one was reached and answered 2xx at least once.
 */

const BROWSER_OPS = [
  "GetCheckoutPage",
  "PostCheckoutPage",
  "GetStripeJs",
  "PostThreeDSecureAuthenticate",
]

let server: StripeServer
beforeAll(async () => {
  server = await createServer()
})
afterAll(async () => {
  await server.close()
})

const expectError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a Stripe error")
    },
    (error: unknown) => error as Stripe.errors.StripeError,
  )

/** Every S1.4 operation, as our call sites make it. */
const walk = async (stripe: Stripe, tag: string) => {
  const now = Math.floor(Date.now() / 1000)
  // Customers and customer balance.
  const customer = await stripe.customers.create({
    email: `${tag}@example.com`,
    name: "Ada Lovelace",
    phone: "+15555550123",
    address: {
      line1: "1 Main St",
      city: "Austin",
      state: "TX",
      postal_code: "78701",
      country: "US",
    },
    metadata: { userId: tag, referral: "none" },
  })
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: now, name: tag })
  await stripe.testHelpers.testClocks.retrieve(clock.id)
  const clocked = await stripe.customers.create({
    email: `${tag}+clock@example.com`,
    test_clock: clock.id,
  })
  await stripe.customers.retrieve(customer.id, {
    expand: ["invoice_settings.default_payment_method"],
  })
  await stripe.customers.list({ email: `${tag}@example.com`, limit: 10 })
  const search = await stripe.customers.search({ query: `email:'${tag}@example.com'` })
  expect(search.data[0]?.id).toBe(customer.id)
  await stripe.customers.search({ query: `metadata['userId']:'${tag}'`, limit: 5 })
  await stripe.customers.createBalanceTransaction(
    customer.id,
    { amount: -300, currency: "usd", metadata: { source: "promo" } },
    { idempotencyKey: `${tag}-credit` },
  )
  const ledger = await stripe.customers
    .listBalanceTransactions(customer.id, { limit: 100 })
    .autoPagingToArray({ limit: 1000 })
  expect(ledger.length).toBe(1)

  // Payment methods.
  const tokenCard = await stripe.paymentMethods.create({
    type: "card",
    card: { token: "tok_visa" },
  })
  const attached = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: attached.id },
  })
  const retrieved = await stripe.paymentMethods.retrieve(attached.id)
  expect(retrieved.card?.last4).toBe("4242")
  await stripe.paymentMethods.list({ customer: customer.id, type: "card" })
  await stripe.paymentMethods.attach(tokenCard.id, { customer: customer.id })
  await stripe.paymentMethods.detach(tokenCard.id)

  // PaymentIntents.
  const offSession = await stripe.paymentIntents.create(
    {
      amount: 1500,
      currency: "usd",
      customer: customer.id,
      payment_method: attached.id,
      payment_method_types: ["card", "link"],
      confirm: true,
      off_session: true,
      metadata: { intent: "shop_purchase", paymentId: `${tag}-pay` },
    },
    { idempotencyKey: `${tag}-pi` },
  )
  expect(offSession.status).toBe("succeeded")
  const embedded = await stripe.paymentIntents.create({
    amount: 17_999,
    currency: "usd",
    customer: customer.id,
    setup_future_usage: "off_session",
    automatic_payment_methods: { enabled: true },
    metadata: { intent: "kb_membership" },
  })
  await stripe.paymentIntents.update(embedded.id, { metadata: { checkout: "1" } })
  await stripe.paymentIntents.confirm(embedded.id, {
    payment_method: "pm_card_visa",
    return_url: "http://localhost/return",
  })
  await stripe.paymentIntents.retrieve(offSession.id, { expand: ["latest_charge"] })
  const toCancel = await stripe.paymentIntents.create({
    amount: 900,
    currency: "usd",
    customer: customer.id,
  })
  expect(
    (
      await stripe.paymentIntents.cancel(toCancel.id, {
        cancellation_reason: "requested_by_customer",
      })
    ).status,
  ).toBe("canceled")
  const manual = await stripe.paymentIntents.create({
    amount: 700,
    currency: "usd",
    capture_method: "manual",
    payment_method: "pm_card_visa",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  })
  expect((await stripe.paymentIntents.capture(manual.id)).status).toBe("succeeded")
  await stripe.paymentIntents
    .list({
      customer: customer.id,
      limit: 100,
      created: { gte: now - 60 },
      expand: ["data.latest_charge"],
    })
    .autoPagingToArray({ limit: 1000 })
  const found = await stripe.paymentIntents.search({
    query: `metadata['paymentId']:'${tag}-pay'`,
    limit: 100,
    expand: ["data.latest_charge"],
  })
  expect(found.data.map((intent) => intent.id)).toEqual([offSession.id])

  // SetupIntents.
  const setup = await stripe.setupIntents.create({
    customer: customer.id,
    usage: "off_session",
    metadata: { intent: "kb_onboarding" },
  })
  await stripe.setupIntents.retrieve(setup.id)
  await stripe.setupIntents.confirm(setup.id, { payment_method: "pm_card_visa" })
  const abandoned = await stripe.setupIntents.create({
    customer: customer.id,
    automatic_payment_methods: { enabled: true },
  })
  await stripe.setupIntents.cancel(abandoned.id)
  await stripe.setupIntents.list({ customer: customer.id, limit: 25 })

  // Catalog, coupons, promotion codes.
  const product = await stripe.products.create({
    id: `prod_${tag}`,
    name: "Membership",
    metadata: { app: "partner-platform", catalogScope: "shared" },
  })
  await stripe.products.retrieve(product.id)
  await stripe.products.list({ limit: 100, active: true })
  await stripe.products.search({
    query: "metadata['app']:'partner-platform' AND metadata['catalogScope']:'shared'",
  })
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 17_999,
    recurring: { interval: "month" },
    lookup_key: `${tag}_monthly`,
  })
  const oneTime = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 5000,
    nickname: "kit",
  })
  await stripe.products.update(product.id, {
    default_price: price.id,
    metadata: { tierScore: "20" },
  })
  const successor = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 18_999,
    recurring: { interval: "month" },
    lookup_key: `${tag}_monthly`,
    transfer_lookup_key: true,
  })
  await stripe.prices.update(price.id, { active: false })
  const byKey = await stripe.prices.list({ lookup_keys: [`${tag}_monthly`], active: true })
  expect(byKey.data.map((entry) => entry.id)).toEqual([successor.id])
  await stripe.prices.retrieve(price.id, { expand: ["product"] })
  const coupon = await stripe.coupons.create(
    { percent_off: 10, duration: "once", name: `QA ${tag}` },
    { idempotencyKey: `coupon:${tag}` },
  )
  const credit = await stripe.coupons.create({
    amount_off: 500,
    currency: "usd",
    duration: "once",
    max_redemptions: 1,
    applies_to: { products: [product.id] },
  })
  await stripe.coupons.retrieve(credit.id, { expand: ["applies_to"] })
  await stripe.coupons.list({ limit: 100, expand: ["data.applies_to"] })
  const promo = await stripe.promotionCodes.create({
    coupon: coupon.id,
    code: `QA${tag.toUpperCase()}`,
    max_redemptions: 5,
  })
  await stripe.promotionCodes.list({
    code: promo.code,
    active: true,
    limit: 1,
    expand: ["data.coupon.applies_to"],
  })
  await stripe.promotionCodes.retrieve(promo.id, { expand: ["coupon.applies_to"] })
  await stripe.promotionCodes.update(promo.id, { active: false })
  await stripe.promotionCodes.update(promo.id, { active: true })
  const throwaway = await stripe.coupons.create({ percent_off: 5, duration: "forever" })
  await stripe.coupons.del(throwaway.id)

  // Checkout.
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      currency: "usd",
      customer: customer.id,
      line_items: [
        { price_data: { currency: "usd", product: product.id, unit_amount: 2500 }, quantity: 1 },
      ],
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: { intent: "kb_membership" },
      },
      custom_text: { submit: { message: "Thanks" } },
      discounts: [{ promotion_code: promo.id }],
      metadata: { intent: "kb_membership" },
      success_url: "http://localhost/s?id={CHECKOUT_SESSION_ID}",
      cancel_url: "http://localhost/c",
    },
    { idempotencyKey: `membership-signup:${tag}` },
  )
  expect(session.amount_total).toBe(2250)
  await stripe.checkout.sessions.retrieve(session.id, { expand: ["payment_intent"] })
  await stripe.checkout.sessions.listLineItems(session.id)
  await stripe.checkout.sessions.list({ customer: customer.id, status: "open", limit: 100 })
  const expiring = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    line_items: [{ price: successor.id, quantity: 1 }],
    payment_method_collection: "if_required",
    success_url: "http://localhost/s",
  })
  expect((await stripe.checkout.sessions.expire(expiring.id)).status).toBe("expired")

  // Subscriptions, items and schedules.
  const subscription = await stripe.subscriptions.create(
    {
      customer: customer.id,
      items: [{ price: successor.id }],
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent", "latest_invoice.lines.data.price"],
      metadata: { intent: "stripe_membership", userId: tag, workflow: "existing_user" },
      discounts: [{ coupon: coupon.id }],
    },
    { idempotencyKey: `sub-purchase-${tag}` },
  )
  expect(subscription.status).toBe("active")
  const incomplete = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: successor.id }],
    payment_behavior: "default_incomplete",
    expand: ["latest_invoice.payment_intent"],
  })
  expect(incomplete.status).toBe("incomplete")
  const trialing = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: successor.id }],
    trial_end: now + 7 * 86_400,
    proration_behavior: "none",
  })
  expect(trialing.status).toBe("trialing")
  const backdated = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: successor.id }],
    backdate_start_date: now - 10 * 86_400,
    billing_cycle_anchor: now + 20 * 86_400,
    proration_behavior: "none",
  })
  expect(backdated.status).toBe("active")
  const decliner = await stripe.customers.create({ email: `${tag}+decline@example.com` })
  const declining = await stripe.paymentMethods.attach("pm_card_chargeDeclined", {
    customer: decliner.id,
  })
  const declined = await expectError(
    stripe.subscriptions.create({
      customer: decliner.id,
      items: [{ price: successor.id }],
      default_payment_method: declining.id,
      payment_behavior: "error_if_incomplete",
    }),
  )
  expect(declined.statusCode).toBe(402)
  await stripe.subscriptions.retrieve(subscription.id, {
    expand: ["discounts", "items.data.discounts"],
  })
  const itemId = subscription.items.data[0]?.id as string
  await stripe.subscriptions.update(subscription.id, {
    items: [{ id: itemId, price: successor.id }],
    proration_behavior: "none",
    metadata: { plan: "same" },
  })
  await stripe.subscriptions.update(subscription.id, { discounts: "" })
  await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true })
  await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: false })
  await stripe.subscriptions.list({
    customer: customer.id,
    status: "all",
    limit: 100,
    expand: ["data.discounts", "data.items.data.discounts"],
  })
  await stripe.subscriptions.list({ price: successor.id, status: "incomplete", limit: 100 })
  await stripe.subscriptionItems.list({ subscription: subscription.id, expand: ["data.discounts"] })
  const addOn = await stripe.subscriptionItems.create({
    subscription: backdated.id,
    price: (
      await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: 1000,
        recurring: { interval: "month" },
      })
    ).id,
    proration_behavior: "none",
  })
  await stripe.subscriptionItems.update(addOn.id, { quantity: 2, proration_behavior: "none" })
  await stripe.subscriptionItems.del(addOn.id, { proration_behavior: "none" })
  const schedule = await stripe.subscriptionSchedules.create({ from_subscription: trialing.id })
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      {
        start_date: schedule.phases[0]?.start_date as number,
        end_date: schedule.phases[0]?.end_date as number,
        items: [{ price: successor.id, quantity: 1 }],
        proration_behavior: "none",
      },
      {
        start_date: schedule.phases[0]?.end_date as number,
        end_date: (schedule.phases[0]?.end_date as number) + 30 * 86_400,
        items: [{ price: successor.id, quantity: 1 }],
        proration_behavior: "none",
      },
    ],
  })
  await stripe.subscriptionSchedules.list({ limit: 100 })
  await stripe.subscriptionSchedules.retrieve(schedule.id)
  expect((await stripe.subscriptionSchedules.release(schedule.id)).status).toBe("released")
  const cancelable = await stripe.subscriptionSchedules.create({ from_subscription: backdated.id })
  expect((await stripe.subscriptionSchedules.cancel(cancelable.id)).status).toBe("canceled")
  expect((await stripe.subscriptions.cancel(incomplete.id)).status).toBe("canceled")
  const upcoming = await stripe.invoices.retrieveUpcoming({ subscription: subscription.id })
  expect(upcoming.next_payment_attempt).toBe(subscription.current_period_end)

  // Invoices and invoice items.
  const invoice = await stripe.invoices.create({
    customer: customer.id,
    auto_advance: false,
    collection_method: "charge_automatically",
    metadata: { reason: "lab", panelType: "basic" },
  })
  await stripe.invoiceItems.create({
    customer: customer.id,
    invoice: invoice.id,
    price: oneTime.id,
    quantity: 1,
    metadata: { cp_id: "1" },
  })
  await stripe.invoiceItems.create({
    customer: customer.id,
    invoice: invoice.id,
    price_data: { currency: "usd", product: product.id, unit_amount: 0 },
  })
  await stripe.invoices.update(invoice.id, { discounts: [{ coupon: credit.id }] })
  const voidDraft = await expectError(stripe.invoices.voidInvoice(invoice.id))
  expect(voidDraft.message).toBe("You can only pass in open invoices. This invoice isn't open.")
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id, {
    expand: ["payment_intent"],
  })
  expect(finalized.status).toBe("open")
  expect(finalized.total).toBe(4500)
  const paidInvoice = await stripe.invoices.pay(invoice.id)
  expect(paidInvoice.status).toBe("paid")
  const zero = await stripe.invoices.create({ customer: customer.id, auto_advance: false })
  expect((await stripe.invoices.finalizeInvoice(zero.id)).status).toBe("paid")
  const sendable = await stripe.invoices.create({
    customer: customer.id,
    collection_method: "send_invoice",
    days_until_due: 5,
  })
  await stripe.invoiceItems.create({
    customer: customer.id,
    invoice: sendable.id,
    price: oneTime.id,
    quantity: 1,
  })
  await stripe.invoices.finalizeInvoice(sendable.id)
  expect((await stripe.invoices.voidInvoice(sendable.id)).status).toBe("void")
  await stripe.invoices.retrieve(invoice.id, {
    expand: [
      "discount.coupon",
      "discounts.coupon",
      "discounts.promotion_code",
      "charge",
      "subscription",
    ],
  })
  await stripe.invoices.list({
    customer: customer.id,
    status: "paid",
    limit: 100,
    created: { gte: now - 60 },
    expand: ["data.charge", "data.payment_intent", "data.subscription"],
  })
  await stripe.invoices.listLineItems(invoice.id, { limit: 100 })

  // Charges, refunds, disputes, balance, events, account.
  const charge = await stripe.charges.retrieve(offSession.latest_charge as string)
  expect(charge.paid).toBe(true)
  await stripe.charges.list({
    customer: customer.id,
    limit: 100,
    expand: ["data.invoice", "data.payment_intent"],
    created: { gte: now - 60 },
  })
  const refund = await stripe.refunds.create(
    { payment_intent: offSession.id, amount: 500, metadata: { operationId: `${tag}-op` } },
    { idempotencyKey: `billing-adjustment:${tag}` },
  )
  await stripe.refunds.retrieve(refund.id)
  await stripe.refunds.list({ payment_intent: offSession.id, limit: 100 })
  await stripe.disputes.list({ payment_intent: offSession.id, limit: 100 })
  const transactions = await stripe.balanceTransactions.list({ created: { gte: now - 60 } })
  expect(transactions.data.some((entry) => entry.type === "refund")).toBe(true)
  await stripe.events.list({
    types: ["invoice.paid", "customer.subscription.updated"],
    created: { gte: now - 60 },
    limit: 100,
  })
  const account = await stripe.accounts.retrieve()
  expect(account.object).toBe("account")
  const balance = await stripe.balance.retrieve()
  expect(balance.livemode).toBe(false)
  const endpoint = await stripe.webhookEndpoints.create({
    url: "https://example.com/hooks",
    enabled_events: ["*"],
  })
  expect(endpoint.secret?.startsWith("whsec_")).toBe(true)
  await stripe.webhookEndpoints.list()
  await stripe.webhookEndpoints.retrieve(endpoint.id)
  await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: ["invoice.paid"] })
  await stripe.webhookEndpoints.del(endpoint.id)

  // The rest of the surface: single reads and the updates our scripts and dev tools make.
  const events = await stripe.events.list({ limit: 1 })
  await stripe.events.retrieve(events.data[0]?.id as string)
  await stripe.balanceTransactions.retrieve(transactions.data[0]?.id as string)
  const disputed = await stripe.paymentIntents.create({
    amount: 1200,
    currency: "usd",
    payment_method: "pm_card_createDispute",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  })
  const disputes = await stripe.disputes.list({ payment_intent: disputed.id })
  await stripe.disputes.retrieve(disputes.data[0]?.id as string)
  const pending = await stripe.invoiceItems.create({
    customer: customer.id,
    amount: 300,
    currency: "usd",
    description: "pending",
  })
  await stripe.invoiceItems.retrieve(pending.id)
  await stripe.invoiceItems.update(pending.id, { description: "updated" })
  await stripe.invoiceItems.list({ customer: customer.id, limit: 10 })
  await stripe.invoiceItems.del(pending.id)
  const draft = await stripe.invoices.create({ customer: customer.id })
  await stripe.invoices.del(draft.id)
  await stripe.refunds.update(refund.id, { metadata: { reviewed: "yes" } })
  await stripe.setupIntents
    .update(abandoned.id, { metadata: { note: "abandoned" } })
    .catch(() => undefined)
  const spare = await stripe.setupIntents.create({ customer: customer.id })
  await stripe.setupIntents.update(spare.id, { metadata: { note: "spare" } })
  await stripe.paymentMethods.update(attached.id, { metadata: { label: "primary" } })
  await stripe.coupons.update(coupon.id, { metadata: { schedulingType: "none" } })
  const bare = await stripe.products.create({ name: "Unused" })
  await stripe.products.del(bare.id)
  await stripe.subscriptionItems.retrieve(itemId)
  await stripe.testHelpers.testClocks.list()

  // Time travel and cleanup.
  await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: now + 86_400 })
  await stripe.customers.del(clocked.id)
  await stripe.testHelpers.testClocks.del(clock.id)
}

const journaled = async (namespace: string) => {
  const response = await fetch(`${server.url}/__admin/requests?namespace=${namespace}`)
  const { requests } = (await response.json()) as {
    requests: Array<{ operationId?: string; status: number }>
  }
  return new Set(requests.filter((entry) => entry.status < 300).map((entry) => entry.operationId))
}

const register = async (key: string, namespace: string) => {
  await fetch(`${server.url}/__admin/credentials`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credentials: { [key]: namespace } }),
  })
}

describe("stripe-node drop-in (every S1.4 operation)", () => {
  const expected = supportedOperationIds.filter((id) => !BROWSER_OPS.includes(id))

  test(
    "stripe-node 16.12 at 2024-06-20",
    async () => {
      await register("sk_test_sdkLegacy", "sdk-legacy")
      const stripe = new Stripe("sk_test_sdkLegacy", {
        apiVersion: "2024-06-20",
        ...stripeClientOptions(new URL(server.url)),
      })
      await walk(stripe, "legacy")
      const seen = await journaled("sdk-legacy")
      expect(expected.filter((id) => !seen.has(id))).toEqual([])
    },
    { timeout: 60_000 },
  )

  test(
    "stripe-node 16.12 at 2025-02-24.acacia",
    async () => {
      await register("sk_test_sdkAcacia", "sdk-acacia")
      const stripe = new Stripe("sk_test_sdkAcacia", {
        apiVersion: "2025-02-24.acacia" as "2024-06-20",
        ...stripeClientOptions(new URL(server.url)),
      })
      await walk(stripe, "acacia")
      const seen = await journaled("sdk-acacia")
      expect(expected.filter((id) => !seen.has(id))).toEqual([])
    },
    { timeout: 60_000 },
  )

  test(
    "stripe-node 17.7 (partner platform) at 2025-02-24.acacia",
    async () => {
      await register("sk_test_sdkV17", "sdk-v17")
      await walk(partnerClient("sk_test_sdkV17", new URL(server.url)), "vseventeen")
      const seen = await journaled("sdk-v17")
      expect(expected.filter((id) => !seen.has(id))).toEqual([])
    },
    { timeout: 60_000 },
  )
})

describe("invoice items with inline price_data", () => {
  test("generate an inactive one-time Price that the item and the invoice line carry", async () => {
    await register("sk_test_sdkPriceData", "sdk-price-data")
    const stripe = new Stripe("sk_test_sdkPriceData", {
      apiVersion: "2024-06-20",
      ...stripeClientOptions(new URL(server.url)),
    })
    const customer = await stripe.customers.create({ email: "inline@example.com" })
    const product = await stripe.products.create({ id: "prod_free_panel", name: "Free panel" })
    const draft = await stripe.invoices.create({
      customer: customer.id,
      auto_advance: false,
      collection_method: "charge_automatically",
    })
    const item = await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: draft.id,
      quantity: 1,
      price_data: { currency: "usd", product: product.id, unit_amount: 0 },
    })
    const price = item.price as Stripe.Price
    expect(price.id).toStartWith("price_")
    expect(price).toMatchObject({
      object: "price",
      active: false,
      currency: "usd",
      product: product.id,
      type: "one_time",
      unit_amount: 0,
      recurring: null,
    })
    expect((await stripe.prices.retrieve(price.id)).active).toBe(false)
    const listedItem = (await stripe.invoiceItems.list({ customer: customer.id })).data[0]
    expect(listedItem?.price?.id).toBe(price.id)

    const finalized = await stripe.invoices.finalizeInvoice(draft.id)
    expect(finalized.status).toBe("paid")
    expect(finalized.total).toBe(0)
    const paid = await stripe.invoices.list({ customer: customer.id, status: "paid" })
    const line = paid.data[0]?.lines.data[0]
    expect(line?.price?.id).toBe(price.id)
    expect(line?.price?.product).toBe(product.id)

    const priced = await stripe.invoiceItems.create({
      customer: customer.id,
      quantity: 3,
      price_data: { currency: "usd", product: product.id, unit_amount_decimal: "250.5" },
    })
    expect(priced.amount).toBe(752)
    expect(priced.price?.unit_amount_decimal).toBe("250.5")
  })
})
