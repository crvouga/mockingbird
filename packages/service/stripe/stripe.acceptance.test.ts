import { afterEach, describe, expect, test } from "bun:test"
import Stripe from "stripe"
import { createServer, type StripeServer } from "./src/server.js"
import {
  advanceTestClock,
  attachTestCard,
  backendClient,
  chargeKidsAnnual,
  chargePcOrderOffSession,
  classifySupplementRetryError,
  createCustomerOnTestClock,
  createPartnerCheckout,
  createPcCheckoutSession,
  ensureCustomerForUser,
  findSucceededPrescriptionIntents,
  isStripeDuplicateCodeError,
  isStripeIdempotencyConflict,
  isStripeNonReusablePaymentMethodError,
  PAYMENT_INTENT_HISTORY_EXPAND,
  PcCardRequiresUpdateError,
  paidInvoicesForSubscription,
  partnerCatalog,
  partnerClient,
  partnerPaymentsForUser,
  replayRecentEvents,
  retrievePrescriptionStripePaymentIntent,
  StripeAdapter,
  StripeWebhookReceiver,
  stampCheckoutSessionOnIntent,
} from "./test/consumer.js"

const KEYS = {
  legacy: "sk_test_legacyKey1",
  mso: "sk_test_msoKey1",
  msoPublishable: "pk_test_msoKey1",
  pc: "sk_test_pcKey1",
  emr: "sk_test_emrKey1",
  pp: "sk_test_ppKey1",
} as const
const SECRETS = { mso: "whsec_mso_acceptance", pc: "whsec_pc_acceptance" }

type Delivery = {
  account: "mso" | "pc"
  type: string
  id: string
  status: number
  at: number
  body: Record<string, unknown>
}

const harnesses: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of harnesses.splice(0)) await close()
})

/**
 * The mock served over HTTP with our accounts (legacy + MSO share one, EMR maps to MSO, PC and
 * partner-platform are their own), and a webhook sink running our receiver's verification.
 */
const harness = async () => {
  const receiver = new StripeWebhookReceiver(SECRETS)
  const deliveries: Delivery[] = []
  const sink = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const account = new URL(request.url).pathname.endsWith("/pc") ? "pc" : "mso"
      const raw = await request.text()
      const outcome = await receiver.receive(account, raw, request.headers.get("stripe-signature"))
      deliveries.push({
        account,
        type: outcome.event?.type ?? "",
        id: outcome.event?.id ?? "",
        status: outcome.status,
        at: performance.now(),
        body: outcome.event ? (JSON.parse(raw) as Record<string, unknown>) : {},
      })
      return Response.json(outcome.body, { status: outcome.status })
    },
  })
  const server: StripeServer = await createServer({
    accounts: [
      {
        id: "acct_mso",
        keys: [KEYS.legacy, KEYS.mso, KEYS.emr, KEYS.msoPublishable],
        corpus: true,
      },
      { id: "acct_pc", keys: [KEYS.pc] },
      { id: "acct_pp", keys: [KEYS.pp], apiVersion: "2025-02-24.acacia" },
    ],
    webhooks: { retryDelaysMs: [0, 20, 40] },
  })
  const base = new URL(server.url)
  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const sinkUrl = `http://127.0.0.1:${sink.port}`
  const endpoints = await admin("PUT", "/webhook-endpoints", [
    {
      account: "acct_mso",
      url: `${sinkUrl}/billing/webhooks/stripe/mso`,
      secret: SECRETS.mso,
      enabledEvents: ["*"],
    },
    {
      account: KEYS.pc,
      url: `${sinkUrl}/billing/webhooks/stripe/pc`,
      secret: SECRETS.pc,
      enabledEvents: ["*"],
    },
  ])
  expect(endpoints.status).toBe(200)
  const legacy = backendClient(KEYS.legacy, base)
  const mso = backendClient(KEYS.mso, base)
  const pc = backendClient(KEYS.pc, base)
  const emr = backendClient(KEYS.emr, base)
  const adapter = new StripeAdapter(mso, pc)
  const settle = async () => {
    await server.runtime.webhooks.flush()
    await server.runtime.webhooks.idle()
  }
  const close = async () => {
    await server.close()
    sink.stop(true)
  }
  harnesses.push(close)
  return { server, base, admin, legacy, mso, pc, emr, adapter, receiver, deliveries, settle }
}

const newCustomer = async (stripe: Stripe, email = "member@example.com") =>
  stripe.customers.create({ email, name: "Ada Lovelace", metadata: { userId: "1001" } })

const monthlyPrice = async (stripe: Stripe, amount = 17_999) => {
  const product = await stripe.products.create({ name: "Plus Membership" })
  return stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month" },
  })
}

describe("S1.3 accounts", () => {
  test("legacy and MSO keys share state: a legacy customer accepts an MSO SetupIntent; EMR maps to MSO", async () => {
    const { legacy, mso, emr } = await harness()
    const customer = await legacy.customers.create({
      email: "legacy@example.com",
      metadata: { userId: "7" },
    })
    const setup = await mso.setupIntents.create({
      customer: customer.id,
      usage: "off_session",
      metadata: { intent: "stripe_subscription", userId: "7" },
    })
    expect(setup.customer).toBe(customer.id)
    expect(setup.client_secret?.startsWith(`${setup.id}_secret_`)).toBe(true)
    expect((await emr.customers.retrieve(customer.id)).id).toBe(customer.id)
  })

  test("account isolation: a PC key reading an MSO intent gets 404 resource_missing with Stripe's exact message", async () => {
    const { mso, pc } = await harness()
    const customer = await newCustomer(mso)
    const intent = await mso.paymentIntents.create({
      amount: 1000,
      currency: "usd",
      customer: customer.id,
    })
    const error = await pc.paymentIntents.retrieve(intent.id).then(
      () => undefined,
      (e: unknown) => e as Stripe.errors.StripeError,
    )
    expect(error?.statusCode).toBe(404)
    expect(error?.code).toBe("resource_missing")
    expect(error?.message).toBe(`No such payment_intent: '${intent.id}'`)
    // The Rx probe tries PC first, then falls back to MSO on resource_missing.
    const probed = await retrievePrescriptionStripePaymentIntent(pc, mso, intent.id)
    expect(probed?.account).toBe("mso")
    const missingCustomer = await pc.paymentIntents
      .create({ amount: 1000, currency: "usd", customer: customer.id })
      .then(
        () => undefined,
        (e: unknown) => e as Stripe.errors.StripeError,
      )
    expect(missingCustomer?.code).toBe("resource_missing")
    expect(missingCustomer?.param).toBe("customer")
    expect(missingCustomer?.message).toBe(`No such customer: '${customer.id}'`)
  })

  test("a deleted customer retrieves as a tombstone and ensureCustomerForUser recreates it", async () => {
    const { mso } = await harness()
    const first = await ensureCustomerForUser(mso, {
      id: "42",
      email: "a@example.com",
      name: "A",
      stripeCustomerId: null,
    })
    expect(first.created).toBe(true)
    await mso.customers.del(first.customerId)
    const tombstone = (await mso.customers.retrieve(first.customerId)) as Stripe.DeletedCustomer
    expect(tombstone.deleted).toBe(true)
    const again = await ensureCustomerForUser(mso, {
      id: "42",
      email: "a@example.com",
      name: "A",
      stripeCustomerId: first.customerId,
    })
    expect(again.created).toBe(true)
    const stale = await ensureCustomerForUser(mso, {
      id: "42",
      email: "a@example.com",
      name: "A",
      stripeCustomerId: "cus_neverexisted",
    })
    expect(stale.created).toBe(true)
  })

  test("namespaces by API key: PUT /__admin/credentials isolates a worker's key", async () => {
    const { admin, base } = await harness()
    const worker = backendClient("sk_test_workerOne", base)
    expect(
      (await admin("PUT", "/credentials", { credentials: { sk_test_workerOne: "w1" } })).status,
    ).toBe(200)
    const customer = await worker.customers.create({ email: "w1@example.com" })
    const inDefault = await fetch(`${base.origin}/v1/customers/${customer.id}`, {
      headers: { authorization: "Bearer sk_test_workerOne", "x-mockingbird-namespace": "default" },
    })
    expect(inDefault.status).toBe(404)
    const inW1 = await fetch(`${base.origin}/ns/w1/v1/customers/${customer.id}`, {
      headers: { authorization: "Bearer sk_test_workerOne" },
    })
    expect(inW1.status).toBe(200)
  })
})

describe("S1.3 API versions", () => {
  test("2024-06-20 keeps invoice.discount, charge links and subscription periods; the latest version drops them", async () => {
    const { mso, base } = await harness()
    const customer = await newCustomer(mso)
    await attachTestCard(mso, customer.id)
    const coupon = await mso.coupons.create({ percent_off: 10, duration: "once" })
    const price = await monthlyPrice(mso)
    const subscription = await mso.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      discounts: [{ coupon: coupon.id }],
      expand: ["latest_invoice.payment_intent", "latest_invoice.lines.data.price"],
    })
    expect(subscription.status).toBe("active")
    expect(typeof subscription.current_period_end).toBe("number")
    expect(subscription.discount?.coupon.id).toBe(coupon.id)
    const invoice = subscription.latest_invoice as Stripe.Invoice
    expect(invoice.discount?.coupon.percent_off).toBe(10)
    expect(invoice.total).toBe(Math.round(17_999 * 0.9))
    expect(invoice.total_discount_amounts?.[0]?.amount).toBe(17_999 - Math.round(17_999 * 0.9))
    expect((invoice.payment_intent as Stripe.PaymentIntent).status).toBe("succeeded")
    expect(typeof invoice.charge).toBe("string")
    expect(invoice.lines.data[0]?.price?.id).toBe(price.id)
    // The payment-history expand list is accepted at 2024-06-20.
    const intent = await mso.paymentIntents.retrieve(
      (invoice.payment_intent as Stripe.PaymentIntent).id,
      {
        expand: PAYMENT_INTENT_HISTORY_EXPAND,
      },
    )
    expect((intent.invoice as Stripe.Invoice).id).toBe(invoice.id)
    expect(((intent.invoice as Stripe.Invoice).subscription as Stripe.Subscription).id).toBe(
      subscription.id,
    )
    const paid = await paidInvoicesForSubscription(mso, subscription.id)
    expect(paid.data[0]?.id).toBe(invoice.id)
    // Refunds are embedded only when expanded, at every version we pin.
    const charge = await mso.charges.retrieve(invoice.charge as string)
    expect(charge.refunds).toBeUndefined()
    const expanded = await mso.charges.retrieve(invoice.charge as string, { expand: ["refunds"] })
    expect(expanded.refunds?.object).toBe("list")
    // The vendored latest version (no Stripe-Version header) has no invoice.discount.
    const latest = (await (
      await fetch(`${base.origin}/v1/invoices/${invoice.id}`, {
        headers: { authorization: `Bearer ${KEYS.mso}` },
      })
    ).json()) as Record<string, unknown>
    expect("discount" in latest).toBe(false)
    expect("charge" in latest).toBe(false)
    expect(Array.isArray(latest.discounts)).toBe(true)
    // Stripe rejects only non-expandable first segments and paths deeper than four levels.
    const rejected = await mso.paymentIntents.retrieve(intent.id, { expand: ["metadata"] }).then(
      () => undefined,
      (e: unknown) => e as Stripe.errors.StripeError,
    )
    expect(rejected?.message).toBe("This property cannot be expanded (metadata).")
  })

  test("2025-02-24.acacia (stripe-node 17.7, partner platform): checkout with {CHECKOUT_SESSION_ID}, search and catalog paging", async () => {
    const { base, admin } = await harness()
    const pp = partnerClient(KEYS.pp, base)
    const product = await pp.products.create({
      name: "[Partner Platform] At-home bloodwork",
      metadata: { app: "partner-platform", catalogScope: "shared" },
    })
    const price = await pp.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: 14_900,
    })
    const session = await createPartnerCheckout(pp, {
      priceId: price.id,
      successUrl: "http://localhost:4000/labs/continue?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:4000/labs",
      metadata: { app: "partner-platform", authProviderUserId: "auth0|abc", empty: "" },
    })
    expect(session?.url).toContain(`/c/pay/${session?.id}`)
    const completed = await admin("POST", `/checkout/sessions/${session?.id}/complete`, {
      card: "4242424242424242",
    })
    expect(completed.status).toBe(200)
    const stamped = await stampCheckoutSessionOnIntent(pp, session?.id as string)
    expect(stamped?.metadata.checkoutSessionId).toBe(session?.id)
    const payments = await partnerPaymentsForUser(pp, "partner-platform", "auth0|abc")
    expect(payments.map((payment) => payment.id)).toEqual([stamped?.id as string])
    const catalog = await partnerCatalog(pp)
    expect(catalog.map((entry) => entry.id)).toEqual([product.id])
    const invoiceLatest = await pp.invoices.list({ limit: 1 })
    expect(invoiceLatest.object).toBe("list")
  })
})

describe("S1.8 idempotency", () => {
  test("replay returns an identical body; a param change is idempotency_error; a concurrent key is 409", async () => {
    const { mso, base, admin } = await harness()
    const customer = await newCustomer(mso)
    const first = await mso.customers.createBalanceTransaction(
      customer.id,
      { amount: -500, currency: "usd", metadata: { source: "promo" } },
      { idempotencyKey: "credit-1" },
    )
    const replay = await mso.customers.createBalanceTransaction(
      customer.id,
      { amount: -500, currency: "usd", metadata: { source: "promo" } },
      { idempotencyKey: "credit-1" },
    )
    expect(replay).toEqual(first)
    expect(((await mso.customers.retrieve(customer.id)) as Stripe.Customer).balance).toBe(-500)
    const changed = await mso.customers
      .createBalanceTransaction(
        customer.id,
        { amount: -700, currency: "usd" },
        { idempotencyKey: "credit-1" },
      )
      .then(
        () => undefined,
        (e: unknown) => e as Stripe.errors.StripeError,
      )
    expect(changed?.type).toBe("StripeIdempotencyError")
    expect(changed?.rawType).toBe("idempotency_error")
    expect(classifySupplementRetryError(changed as never)).toEqual({
      status: 409,
      error: "retry_parameters_changed",
    })
    await admin("POST", "/faults", { preset: "idempotency_in_flight", count: 1 })
    const request = () =>
      fetch(`${base.origin}/v1/customers`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEYS.mso}`,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": "rx-payment:9:1",
        },
        body: "email=rx%40example.com",
      })
    const [a, b] = await Promise.all([request(), request()])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
    const conflict = (await (a.status === 409 ? a : b).json()) as {
      error: { code: string; type: string }
    }
    expect(conflict.error.code).toBe("idempotency_key_in_use")
    expect(isStripeIdempotencyConflict(conflict.error)).toBe(true)
  })
})

describe("S1.5 / S1.8 declines and card reuse", () => {
  test("tok_chargeCustomerFail attaches, then declines with 402 and the payment_intent", async () => {
    const { mso, adapter } = await harness()
    const customer = await newCustomer(mso)
    const method = await mso.paymentMethods.create({
      type: "card",
      card: { token: "tok_chargeCustomerFail" },
    })
    const attached = await mso.paymentMethods.attach(method.id, { customer: customer.id })
    expect(attached.customer).toBe(customer.id)
    const error = await adapter
      .charge({
        account: "mso",
        amountCents: 1500,
        customerId: customer.id,
        paymentMethodId: method.id,
        idempotencyKey: "charge-1",
      })
      .then(
        () => undefined,
        (e: unknown) => e as Stripe.errors.StripeCardError,
      )
    expect(error?.statusCode).toBe(402)
    expect(error?.type).toBe("StripeCardError")
    expect(error?.code).toBe("card_declined")
    expect(error?.decline_code).toBe("generic_decline")
    expect(error?.payment_intent?.id?.startsWith("pi_")).toBe(true)
    expect(error?.payment_intent?.status).toBe("requires_payment_method")
    const kids = await chargeKidsAnnual(mso, {
      customerId: customer.id,
      paymentMethodId: method.id,
      amountCents: 9900,
      familyCheckoutId: "fam_1",
    })
    expect(kids.ok).toBe(false)
    if (!kids.ok) {
      expect(kids.attachedIntentId?.startsWith("pi_")).toBe(true)
      expect(kids.code).toBe("KIDS_PAYMENT_FAILED")
    }
  })

  test("PC off-session charge: card_declined and authentication_required become PcCardRequiresUpdateError", async () => {
    const { pc } = await harness()
    const customer = await pc.customers.create({
      email: "rx@example.com",
      metadata: { source: "rx_payment" },
    })
    await attachTestCard(pc, customer.id, "pm_card_chargeDeclined")
    const declined = await chargePcOrderOffSession(pc, {
      pcCustomerId: customer.id,
      userId: "5",
      orderId: "ord_1",
      amountCents: 2500,
      description: "Rx order",
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(declined).toBeInstanceOf(PcCardRequiresUpdateError)
    const other = await pc.customers.create({ email: "rx2@example.com" })
    await attachTestCard(pc, other.id, "pm_card_authenticationRequired")
    const auth = await chargePcOrderOffSession(pc, {
      pcCustomerId: other.id,
      userId: "6",
      orderId: "ord_2",
      amountCents: 2500,
      description: "Rx order",
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(auth).toBeInstanceOf(PcCardRequiresUpdateError)
    const ok = await pc.customers.create({ email: "rx3@example.com" })
    await attachTestCard(pc, ok.id)
    const paid = await chargePcOrderOffSession(pc, {
      pcCustomerId: ok.id,
      userId: "7",
      orderId: "ord_3",
      amountCents: 2500,
      description: "Rx order",
    })
    expect(paid.status).toBe("succeeded")
  })

  test("magic payment methods clone to new pm_ ids; reuse and detach errors carry Stripe's messages", async () => {
    const { legacy } = await harness()
    const customer = await newCustomer(legacy)
    const attached = await legacy.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    expect(attached.id).not.toBe("pm_card_visa")
    expect(attached.id.startsWith("pm_")).toBe(true)
    const loose = await legacy.paymentMethods.create({ type: "card", card: { token: "tok_visa" } })
    const detach = await legacy.paymentMethods.detach(loose.id).then(
      () => undefined,
      (e: unknown) => e as Stripe.errors.StripeError,
    )
    expect(detach?.message).toContain("not attached to a customer")
    await legacy.paymentIntents.create({
      amount: 500,
      currency: "usd",
      payment_method: loose.id,
      confirm: true,
    })
    const reuse = await legacy.paymentMethods.attach(loose.id, { customer: customer.id }).then(
      () => undefined,
      (e: unknown) => e as Stripe.errors.StripeError,
    )
    expect(reuse !== undefined && isStripeNonReusablePaymentMethodError(reuse)).toBe(true)
  })
})

describe("S1.6 webhooks", () => {
  test("every delivery verifies with constructEvent; one event fans out to every matching endpoint", async () => {
    const { mso, pc, deliveries, settle, admin, server } = await harness()
    const customer = await newCustomer(mso)
    await attachTestCard(mso, customer.id)
    await mso.paymentIntents.create({
      amount: 2000,
      currency: "usd",
      customer: customer.id,
      confirm: true,
      off_session: true,
      payment_method: (await mso.paymentMethods.list({ customer: customer.id })).data[0]
        ?.id as string,
    })
    await pc.customers.create({ email: "pc@example.com" })
    await settle()
    expect(deliveries.length).toBeGreaterThan(0)
    expect(deliveries.every((delivery) => delivery.status === 200)).toBe(true)
    expect(
      deliveries.some((d) => d.account === "mso" && d.type === "payment_intent.succeeded"),
    ).toBe(true)
    expect(deliveries.some((d) => d.account === "pc" && d.type === "customer.created")).toBe(true)
    expect(
      deliveries.some((d) => d.account === "pc" && d.type === "payment_intent.succeeded"),
    ).toBe(false)
    // Add a second MSO endpoint with an event filter: the next MSO event reaches both.
    const sinkUrl = (server.runtime.webhooks.endpoints("default")[0]?.url ?? "").replace(
      /\/billing.*$/,
      "",
    )
    await admin("PUT", "/webhook-endpoints", [
      { account: "acct_mso", url: `${sinkUrl}/billing/webhooks/stripe/mso`, secret: SECRETS.mso },
      {
        account: "acct_mso",
        url: `${sinkUrl}/copy/mso`,
        secret: SECRETS.mso,
        enabledEvents: ["customer.updated"],
      },
    ])
    deliveries.length = 0
    await mso.customers.update(customer.id, { name: "Grace" })
    await settle()
    const updated = deliveries.filter((d) => d.type === "customer.updated")
    expect(updated.length).toBe(2)
    expect(new Set(updated.map((d) => d.id)).size).toBe(1)
  })

  test("a bad signature is a 500 at the receiver; duplicate, reorder and drop faults reach it", async () => {
    const { mso, deliveries, settle, admin, receiver, base } = await harness()
    const bad = await receiver.receive(
      "mso",
      JSON.stringify({ id: "evt_x" }),
      `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`,
    )
    expect(bad.status).toBe(500)
    await admin("POST", "/faults", { preset: "webhook_duplicate" })
    const first = await newCustomer(mso, "dup@example.com")
    await settle()
    const created = deliveries.filter((d) => d.type === "customer.created")
    expect(created.length).toBe(2)
    expect(created[0]?.id).toBe(created[1]?.id as string)
    deliveries.length = 0
    await admin("POST", "/faults", { preset: "webhook_reorder" })
    await mso.customers.update(first.id, { name: "One" })
    await mso.customers.update(first.id, { name: "Two" })
    await settle()
    const names = deliveries
      .filter((d) => d.type === "customer.updated")
      .map((d) => (d.body.data as { object: { name: string } }).object.name)
    expect(names).toEqual(["Two", "One"])
    deliveries.length = 0
    await admin("POST", "/faults", { preset: "webhook_drop" })
    const dropped = await mso.customers.update(first.id, { name: "Three" })
    await settle()
    expect(deliveries.filter((d) => d.type === "customer.updated")).toEqual([])
    // Still in the event log, so the replay worker finds what the webhook missed.
    const events = await mso.events.list({ types: ["customer.updated"], limit: 1 })
    expect((events.data[0]?.data.object as Stripe.Customer | undefined)?.name).toBe(dropped.name)
    void base
  })

  test("the PC route quarantines an unattributable paid session and not a pc_order one", async () => {
    const { pc, admin, settle, receiver } = await harness()
    const good = await createPcCheckoutSession(pc, {
      orderId: "o1",
      userId: "u1",
      amountCents: 3000,
      quoteVersion: 1,
      description: "Rx",
    })
    await admin("POST", `/checkout/sessions/${good.id}/complete`, {})
    const stray = await pc.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: { currency: "usd", unit_amount: 100, product_data: { name: "?" } },
          quantity: 1,
        },
      ],
      success_url: "http://localhost/s",
    })
    await admin("POST", `/checkout/sessions/${stray.id}/complete`, {})
    await settle()
    const completed = receiver.handled.filter(
      (event) => event.type === "checkout.session.completed",
    )
    expect(completed.map((event) => (event.data.object as Stripe.Checkout.Session).id)).toEqual([
      good.id,
    ])
    expect(receiver.quarantined.length).toBe(1)
  })
})

describe("S1.9 hosted Checkout page and Stripe.js", () => {
  test("Pay completes the session, substitutes {CHECKOUT_SESSION_ID}, and checkout.session.completed arrives within 100 ms", async () => {
    const { mso, deliveries, settle, base } = await harness()
    const customer = await newCustomer(mso)
    const session = await mso.checkout.sessions.create({
      mode: "payment",
      customer: customer.id,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product: (await mso.products.create({ name: "Membership" })).id,
            unit_amount: 17_999,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: { intent: "kb_membership" },
      },
      metadata: { intent: "kb_membership", paymentRailReferenceType: "checkout_session" },
      success_url:
        "http://localhost:3000/done?raw={CHECKOUT_SESSION_ID}&enc=%7BCHECKOUT_SESSION_ID%7D",
      cancel_url: "http://localhost:3000/cancel",
    })
    expect(session.url).toBe(`${base.origin}/c/pay/${session.id}`)
    expect(session.payment_intent).toBeNull()
    const page = await (await fetch(session.url as string)).text()
    for (const id of ["card", "exp", "cvc", "zip", "pay", "cancel"])
      expect(page).toContain(`data-testid="stripe-mock-${id}"`)
    const declined = await fetch(session.url as string, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        card: "4000000000000002",
        exp: "12/34",
        cvc: "123",
        zip: "94107",
        action: "pay",
      }),
    })
    expect(declined.status).toBe(200)
    expect(await declined.text()).toContain('data-testid="stripe-mock-error"')
    const started = performance.now()
    const paid = await fetch(session.url as string, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        card: "4242 4242 4242 4242",
        exp: "12/34",
        cvc: "123",
        zip: "94107",
        action: "pay",
      }),
    })
    expect(paid.status).toBe(302)
    expect(paid.headers.get("location")).toBe(
      `http://localhost:3000/done?raw=${session.id}&enc=${session.id}`,
    )
    const deadline = started + 100
    while (
      !deliveries.some((d) => d.type === "checkout.session.completed") &&
      performance.now() < deadline + 400
    )
      await Bun.sleep(2)
    const completedAt =
      deliveries.find((d) => d.type === "checkout.session.completed")?.at ??
      Number.POSITIVE_INFINITY
    expect(completedAt - started).toBeLessThan(100)
    await settle()
    const completed = await mso.checkout.sessions.retrieve(session.id, {
      expand: ["payment_intent"],
    })
    expect(completed.status).toBe("complete")
    expect(completed.payment_status).toBe("paid")
    const intent = completed.payment_intent as Stripe.PaymentIntent
    expect(intent.metadata.intent).toBe("kb_membership")
    expect((await mso.paymentMethods.list({ customer: customer.id })).data.length).toBe(1)
    const cancel = await mso.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: { currency: "usd", unit_amount: 100, product_data: { name: "x" } },
          quantity: 1,
        },
      ],
      success_url: "http://localhost/s",
      cancel_url: "http://localhost/c",
    })
    const canceled = await fetch(cancel.url as string, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ action: "cancel" }),
    })
    expect(canceled.status).toBe(302)
    expect(canceled.headers.get("location")).toBe("http://localhost/c")
  })

  test("subscription and setup modes complete through the page; PC customer_creation creates a customer", async () => {
    const { mso, pc, admin, settle, receiver } = await harness()
    const price = await monthlyPrice(mso)
    const customer = await newCustomer(mso)
    const subscriptionSession = await mso.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: price.id, quantity: 1 }],
      payment_method_collection: "if_required",
      metadata: { userId: "1001", intent: "stripe_membership" },
      subscription_data: {
        metadata: { userId: "1001", firstPurchaseConversionOwner: "checkout_session" },
      },
      success_url: "http://localhost/s",
    })
    const done = await admin("POST", `/checkout/sessions/${subscriptionSession.id}/complete`, {})
    expect(done.status).toBe(200)
    const subscription = await mso.subscriptions.retrieve(done.body.subscription as string)
    expect(subscription.status).toBe("active")
    expect(subscription.metadata.firstPurchaseConversionOwner).toBe("checkout_session")
    const setup = await mso.checkout.sessions.create({
      mode: "setup",
      customer: customer.id,
      currency: "usd",
      success_url: "http://localhost/s",
    })
    const setupDone = await admin("POST", `/checkout/sessions/${setup.id}/complete`, {})
    expect(setupDone.body.payment_status).toBe("no_payment_required")
    const pcSession = await createPcCheckoutSession(pc, {
      orderId: "o9",
      userId: "u9",
      amountCents: 4200,
      quoteVersion: 2,
      description: "Rx",
    })
    const pcDone = await admin("POST", `/checkout/sessions/${pcSession.id}/complete`, {})
    expect(typeof pcDone.body.customer).toBe("string")
    await settle()
    const event = receiver.handled.find(
      (e) =>
        e.type === "checkout.session.completed" &&
        (e.data.object as Stripe.Checkout.Session).id === pcSession.id,
    )
    expect((event?.data.object as Stripe.Checkout.Session | undefined)?.metadata?.intent).toBe(
      "pc_order",
    )
  })

  test("the Stripe.js stand-in confirms with the publishable key and client secret, including 3-D Secure", async () => {
    const { mso, base } = await harness()
    const source = await (await fetch(`${base.origin}/v3`)).text()
    const customer = await newCustomer(mso)
    const intent = await mso.paymentIntents.create({
      amount: 17_999,
      currency: "usd",
      customer: customer.id,
      setup_future_usage: "off_session",
      automatic_payment_methods: { enabled: true },
      metadata: { intent: "kb_membership" },
    })
    const assigned: string[] = []
    const window = {
      location: { assign: (url: string) => assigned.push(url) },
    } as unknown as Record<string, unknown>
    new Function("window", "document", source)(window, {})
    const StripeJs = window.Stripe as (key: string) => {
      elements: (options?: { clientSecret: string }) => {
        create: (type: string) => { card: () => Record<string, unknown> }
        getElement: (type: string | { __elementType: string }) => unknown
      }
      createToken: (element: { card: () => Record<string, unknown> }) => Promise<{
        token?: {
          id: string
          object: string
          type: string
          card: { last4: string; exp_month: number; exp_year: number }
        }
        error?: { type: string; code: string; message: string }
      }>
      confirmPayment: (
        args: unknown,
      ) => Promise<{ paymentIntent?: { status: string }; error?: { code: string } }>
      confirmCardPayment: (
        secret: string,
        data: unknown,
      ) => Promise<{
        paymentIntent?: { status: string }
        error?: { code: string; payment_intent?: unknown }
      }>
      retrievePaymentIntent: (secret: string) => Promise<{ paymentIntent: { status: string } }>
    }
    const stripe = StripeJs(KEYS.msoPublishable)
    const elements = stripe.elements({ clientSecret: intent.client_secret as string })
    const paymentElement = elements.create("payment")
    expect(elements.getElement("payment")).toBe(paymentElement)
    expect(elements.getElement({ __elementType: "payment" })).toBe(paymentElement)
    expect(elements.getElement({ __elementType: "card" })).toBeNull()

    const cards = stripe.elements()
    const cardElement = cards.create("cardNumber")
    expect(cards.getElement("cardNumber")).toBe(cardElement)
    expect(cards.getElement({ __elementType: "cardNumber" })).toBe(cardElement)
    const magicCards = [
      ["4242424242424242", "tok_visa"],
      ["4000056655665556", "tok_visa_debit"],
      ["5555555555554444", "tok_mastercard"],
      ["4000000000000002", "tok_chargeDeclined"],
      ["4000000000009995", "tok_chargeDeclinedInsufficientFunds"],
    ] as const
    for (const [number, token] of magicCards) {
      cardElement.card = () => ({ number, exp_month: 9, exp_year: 2035, cvc: "123" })
      const tokenized = await stripe.createToken(cardElement)
      expect(tokenized.token).toMatchObject({
        id: token,
        object: "token",
        type: "card",
        card: { last4: number.slice(-4), exp_month: 9, exp_year: 2035 },
      })
    }
    cardElement.card = () => ({
      number: "1234567890123456",
      exp_month: 9,
      exp_year: 2035,
      cvc: "123",
    })
    expect(await stripe.createToken(cardElement)).toEqual({
      error: {
        type: "card_error",
        code: "incorrect_number",
        message: "Your card number is incorrect.",
      },
    })
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: "http://localhost:3000/after" },
    })
    expect(result.paymentIntent?.status).toBe("succeeded")
    expect(assigned[0]).toContain(`payment_intent=${intent.id}`)
    expect(
      (await stripe.retrievePaymentIntent(intent.client_secret as string)).paymentIntent.status,
    ).toBe("succeeded")
    const threeDs = await mso.paymentIntents.create({
      amount: 500,
      currency: "usd",
      customer: customer.id,
    })
    const challenged = await stripe.confirmCardPayment(threeDs.client_secret as string, {
      payment_method: "pm_card_threeDSecure2Required",
    })
    expect(challenged.paymentIntent?.status).toBe("succeeded")
    const declinedIntent = await mso.paymentIntents.create({
      amount: 500,
      currency: "usd",
      customer: customer.id,
    })
    const declined = await stripe.confirmCardPayment(declinedIntent.client_secret as string, {
      payment_method: "pm_card_chargeDeclined",
    })
    expect(declined.error?.code).toBe("card_declined")
    // A publishable key cannot read anything a client secret does not unlock.
    const forbidden = await fetch(`${base.origin}/v1/customers`, {
      headers: { authorization: `Bearer ${KEYS.msoPublishable}` },
    })
    expect(forbidden.status).toBe(401)
  })
})

describe("S1.7 lifecycles", () => {
  test("advancing the clock one interval runs a cycle: invoice.paid and customer.subscription.updated with previous_attributes", async () => {
    const { mso, pc, admin, settle, receiver } = await harness()
    const customer = await newCustomer(mso)
    await attachTestCard(mso, customer.id)
    const price = await monthlyPrice(mso)
    const subscription = await mso.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      payment_behavior: "error_if_incomplete",
    })
    await settle()
    receiver.handled.length = 0
    await admin("POST", "/clock", { advance: "32d" })
    await settle()
    const paid = receiver.handled.filter((e) => e.type === "invoice.paid")
    expect(paid.length).toBe(1)
    const invoice = paid[0]?.data.object as Stripe.Invoice
    expect(invoice.billing_reason).toBe("subscription_cycle")
    expect(invoice.subscription).toBe(subscription.id)
    const updated = receiver.handled.find((e) => e.type === "customer.subscription.updated")
    expect(updated?.data.previous_attributes).toMatchObject({
      current_period_end: subscription.current_period_end,
    })
    const renewed = await mso.subscriptions.retrieve(subscription.id)
    expect(renewed.current_period_start).toBe(subscription.current_period_end)
    // The replay worker finds the same events.
    const replay = await replayRecentEvents(mso, pc, 0)
    expect(replay.mso.some((event) => event.type === "invoice.paid")).toBe(true)
    expect(replay.pc).toEqual([])
  })

  test("a declining renewal goes past_due with invoice.payment_failed; incomplete expires after 23 h", async () => {
    const { mso, admin, settle, receiver } = await harness()
    const customer = await newCustomer(mso)
    const card = await mso.paymentMethods.create({
      type: "card",
      card: { token: "tok_chargeCustomerFail" },
    })
    await mso.paymentMethods.attach(card.id, { customer: customer.id })
    const price = await monthlyPrice(mso)
    const trial = await mso.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      default_payment_method: card.id,
      trial_end: Math.floor(Date.now() / 1000) + 3 * 86_400,
    })
    expect(trial.status).toBe("trialing")
    const incomplete = await mso.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
    })
    expect(incomplete.status).toBe("incomplete")
    const secret = (
      (incomplete.latest_invoice as Stripe.Invoice).payment_intent as Stripe.PaymentIntent
    ).client_secret
    expect(secret?.includes("_secret_")).toBe(true)
    await admin("POST", "/clock", { advance: "4d" })
    await settle()
    expect((await mso.subscriptions.retrieve(trial.id)).status).toBe("past_due")
    expect(receiver.handled.some((e) => e.type === "invoice.payment_failed")).toBe(true)
    expect((await mso.subscriptions.retrieve(incomplete.id)).status).toBe("incomplete_expired")
  })

  test("refunds move by PUT /__admin/refunds/:id and disputes open by POST /__admin/disputes", async () => {
    const { mso, adapter, admin, settle, receiver } = await harness()
    const customer = await newCustomer(mso)
    await attachTestCard(mso, customer.id)
    const charge = await adapter.charge({
      account: "mso",
      amountCents: 5000,
      customerId: customer.id,
      idempotencyKey: "c-1",
    })
    const refund = await adapter.refund(charge.id, 2000, "mso", "billing-adjustment:op1")
    expect(refund.status).toBe("succeeded")
    const moved = await admin("PUT", `/refunds/${refund.id}`, {
      status: "failed",
      failure_reason: "expired_or_canceled_card",
    })
    expect(moved.body.status).toBe("failed")
    const dispute = await admin("POST", "/disputes", { payment_intent: charge.id })
    expect(dispute.status).toBe(201)
    await settle()
    const types: string[] = receiver.handled.map((e) => e.type)
    expect(types).toContain("refund.created")
    expect(types).toContain("refund.failed")
    expect(types).toContain("charge.dispute.created")
    const disputes = await mso.disputes.list({ payment_intent: charge.id, limit: 100 })
    expect(disputes.data[0]?.status).toBe("needs_response")
    const intent = await mso.paymentIntents.retrieve(charge.id, { expand: ["latest_charge"] })
    const latest = intent.latest_charge as Stripe.Charge
    expect(latest.amount_refunded).toBe(0)
    expect(latest.disputed).toBe(true)
  })

  test("test clocks: a dev-tools customer on a clock renews when the clock advances and reports ready", async () => {
    const { legacy } = await harness()
    const start = Math.floor(Date.now() / 1000)
    const { clockId, customerId } = await createCustomerOnTestClock(
      legacy,
      "clock@example.com",
      start,
    )
    await attachTestCard(legacy, customerId)
    const price = await monthlyPrice(legacy)
    const subscription = await legacy.subscriptions.create({
      customer: customerId,
      items: [{ price: price.id }],
    })
    const clock = await advanceTestClock(legacy, clockId, start + 32 * 86_400, 1)
    expect(clock.status).toBe("ready")
    const invoices = await legacy.invoices.list({ subscription: subscription.id })
    expect(invoices.data.map((invoice) => invoice.billing_reason)).toEqual([
      "subscription_cycle",
      "subscription_create",
    ])
    const upcoming = await legacy.invoices.retrieveUpcoming({ subscription: subscription.id })
    expect(upcoming.next_payment_attempt).toBe(
      (await legacy.subscriptions.retrieve(subscription.id)).current_period_end,
    )
  })
})

describe("S1.4 search, promotion codes and presets", () => {
  test("Rx search is consistent by default; search_lag hides fresh intents; has_more drives manual review", async () => {
    const { pc, admin } = await harness()
    const customer = await pc.customers.create({ email: "rx@example.com" })
    await attachTestCard(pc, customer.id)
    const created = await pc.paymentIntents.create({
      amount: 900,
      currency: "usd",
      customer: customer.id,
      confirm: true,
      off_session: true,
      payment_method: (await pc.paymentMethods.list({ customer: customer.id })).data[0]
        ?.id as string,
      metadata: { paymentId: "pay_1", userId: "1" },
    })
    const found = await findSucceededPrescriptionIntents(pc, "pay_1", ["paymentId", "orderId"])
    expect(found.matches.map((intent) => intent.id)).toEqual([created.id])
    expect(found.truncated).toBe(false)
    await admin("POST", "/faults", { preset: "search_lag" })
    const lagging = await findSucceededPrescriptionIntents(pc, "pay_1", ["paymentId"])
    expect(lagging.matches).toEqual([])
  })

  test("promotion codes are unique among active codes, with Stripe's real wording", async () => {
    const { legacy } = await harness()
    const coupon = await legacy.coupons.create({ percent_off: 100, duration: "forever" })
    await legacy.promotionCodes.create({
      coupon: coupon.id,
      code: "QAPROMO0123456789",
      max_redemptions: 1,
    })
    const duplicate = await legacy.promotionCodes
      .create({ coupon: coupon.id, code: "QAPROMO0123456789" })
      .then(
        () => undefined,
        (e: unknown) => e as Stripe.errors.StripeError,
      )
    expect(duplicate?.message).toBe(
      "An active promotion code with `code: QAPROMO0123456789` already exists.",
    )
    // Our EMR check keys on code/param; Stripe sends neither on this error (see README).
    expect(isStripeDuplicateCodeError(duplicate as never)).toBe(false)
    const listed = await legacy.promotionCodes.list({
      code: "QAPROMO0123456789",
      active: true,
      expand: ["data.coupon.applies_to"],
    })
    expect(listed.data[0]?.coupon.id).toBe(coupon.id)
  })

  test("card_declined, rate_limited and api_error presets answer Stripe-shaped errors", async () => {
    const { mso, adapter, admin, base } = await harness()
    const customer = await newCustomer(mso)
    await attachTestCard(mso, customer.id)
    await admin("POST", "/faults", { preset: "card_declined", count: 1 })
    const declined = await adapter
      .charge({ account: "mso", amountCents: 100, customerId: customer.id, idempotencyKey: "p-1" })
      .then(
        () => undefined,
        (e: unknown) => e as Stripe.errors.StripeCardError,
      )
    expect(declined?.decline_code).toBe("generic_decline")
    const noRetry = new Stripe(KEYS.mso, {
      apiVersion: "2024-06-20",
      maxNetworkRetries: 0,
      host: base.hostname,
      port: Number(base.port),
      protocol: "http",
    })
    await admin("POST", "/faults", { preset: "rate_limited", count: 1 })
    const limited = await noRetry.customers.retrieve(customer.id).then(
      () => undefined,
      (e: unknown) => e as Stripe.errors.StripeError,
    )
    expect(limited?.type).toBe("StripeRateLimitError")
    expect(classifySupplementRetryError(limited as never).status).toBe(503)
    await admin("POST", "/faults", { preset: "api_error", count: 1 })
    const broken = await noRetry.customers.retrieve(customer.id).then(
      () => undefined,
      (e: unknown) => e as Stripe.errors.StripeError,
    )
    expect(broken?.type).toBe("StripeAPIError")
    expect((await noRetry.customers.retrieve(customer.id)).id).toBe(customer.id)
  })
})

describe("S1.10 corpus", () => {
  test("recorded fixture ids resolve on a corpus account", async () => {
    const { mso } = await harness()
    const product = await mso.products.retrieve("prod_SNj3rQYHrHNS0H")
    expect(product.id).toBe("prod_SNj3rQYHrHNS0H")
    const price = await mso.prices.retrieve("price_1StxtjGBBGmxLhdL8PzNSEgX", {
      expand: ["product"],
    })
    expect(price.unit_amount).toBe(17_999)
    const byLookup = await mso.prices.list({ lookup_keys: ["membership_plus_annually"] })
    expect(byLookup.data.length).toBe(1)
  })
})
