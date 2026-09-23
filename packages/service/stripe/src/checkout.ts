import { jsonResponse, type OperationContext, opaqueToken } from "@crvouga/mockingbird-service"
import { createSubscription } from "./billing.js"
import { invalidRequest, parameterMissing, resourceMissing } from "./errors.js"
import { expandObject } from "./expand.js"
import { mergeMetadata, unitAmountOf } from "./fields.js"
import { embeddedList, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { normalizeCurrency } from "./prices.js"
import {
  type CheckoutSessionRecord,
  type PaymentLinkRecord,
  type StripeState,
  seconds,
} from "./state.js"

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const requireCustomer = async (state: StripeState, id: string) => {
  const entry = await state.customers.get(id)
  if (!entry || entry.kind !== "live") throw resourceMissing("customer", id, "customer", 400)
  return entry.customer
}

const lineAmount = async (state: StripeState, params: Params) => {
  const items = Array.isArray(params.line_items) ? params.line_items : []
  let currency: string | null =
    typeof params.currency === "string" ? normalizeCurrency(params.currency) : null
  let total = 0
  for (const [index, item] of items.entries()) {
    const record = asRecord(item)
    if (!record) continue
    const quantity = typeof record.quantity === "number" ? record.quantity : 1
    if (typeof record.price === "string") {
      const price = await state.prices.get(record.price)
      if (!price) throw resourceMissing("price", record.price, `line_items[${index}][price]`, 400)
      currency = currency ?? price.currency
      const unit =
        unitAmountOf(price.unit_amount_decimal) ?? Math.round(Number(price.unit_amount_decimal))
      total += unit * quantity
    }
    const data = asRecord(record.price_data)
    if (data) {
      if (typeof data.currency === "string") currency = normalizeCurrency(data.currency)
      const unit = typeof data.unit_amount === "number" ? data.unit_amount : 0
      total += unit * quantity
    }
  }
  return { currency, total, count: items.length }
}

const renderSession = (session: CheckoutSessionRecord) => ({
  id: session.id,
  object: "checkout.session",
  amount_total: session.amount_total,
  automatic_tax: { enabled: false },
  cancel_url: session.cancel_url,
  client_reference_id: session.client_reference_id,
  created: session.created,
  currency: session.currency,
  custom_fields: [],
  custom_text: {},
  customer: session.customer,
  customer_email: session.customer_email,
  expires_at: session.expires_at,
  livemode: false,
  metadata: session.metadata,
  mode: session.mode,
  payment_intent: session.payment_intent,
  payment_method_types: session.payment_method_types,
  payment_status: session.payment_status,
  setup_intent: session.setup_intent,
  shipping_options: [],
  status: session.status,
  submit_type: session.submit_type,
  subscription: session.subscription,
  success_url: session.success_url,
  ui_mode: session.ui_mode,
  url: session.url,
})

const renderLink = (link: PaymentLinkRecord) => ({
  id: link.id,
  object: "payment_link",
  active: link.active,
  after_completion: { type: "hosted_confirmation" },
  allow_promotion_codes: link.allow_promotion_codes,
  automatic_tax: { enabled: false },
  billing_address_collection: link.billing_address_collection,
  currency: link.currency,
  custom_fields: [],
  custom_text: {},
  customer_creation: link.customer_creation,
  livemode: false,
  metadata: link.metadata,
  payment_method_collection: link.payment_method_collection,
  phone_number_collection: { enabled: false },
  shipping_options: [],
  submit_type: link.submit_type,
  tax_id_collection: { enabled: false, required: "never" },
  url: link.url,
})

const component = (enabled: boolean) => ({ enabled })

export const checkoutHandlers = (state: StripeState) => ({
  PostCheckoutSessions: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const mode = params.mode
    if (mode !== "payment" && mode !== "setup" && mode !== "subscription")
      throw parameterMissing("mode")
    const uiMode =
      params.ui_mode === "embedded_page" || params.ui_mode === "elements"
        ? params.ui_mode
        : "hosted_page"
    if (
      uiMode === "hosted_page" &&
      (typeof params.success_url !== "string" || params.success_url === "")
    )
      throw parameterMissing("success_url")
    if (typeof params.customer === "string" && params.customer !== "")
      await requireCustomer(state, params.customer)
    const priced = await lineAmount(state, params)
    if ((mode === "payment" || mode === "subscription") && priced.count === 0)
      throw invalidRequest("You must provide at least one line item.", "line_items")
    const id = await state.ids.next("cs_")
    let paymentIntent: string | null = null
    let setupIntent: string | null = null
    let subscription: string | null = null
    if (mode === "payment") {
      const pi = await state.ids.next("pi_")
      await state.paymentIntents.insert(pi, {
        id: pi,
        amount: priced.total,
        amount_capturable: 0,
        amount_received: 0,
        automatic_payment_methods: true,
        canceled_at: null,
        cancellation_reason: null,
        capture_method: "automatic_async",
        client_secret: `${pi}_secret_${opaqueToken(pi, 16)}`,
        confirmation_method: "automatic",
        created: now,
        currency: priced.currency ?? "usd",
        customer: typeof params.customer === "string" ? params.customer : null,
        description: null,
        last_payment_error: null,
        latest_charge: null,
        metadata: mergeMetadata({}, params.metadata),
        next_action: null,
        payment_method: null,
        payment_method_types: ["card"],
        receipt_email: null,
        setup_future_usage: null,
        shipping: null,
        statement_descriptor: null,
        statement_descriptor_suffix: null,
        status: "requires_payment_method",
      })
      paymentIntent = pi
    }
    if (mode === "setup") {
      const si = await state.ids.next("seti_")
      await state.setupIntents.insert(si, {
        id: si,
        automatic_payment_methods: true,
        cancellation_reason: null,
        client_secret: `${si}_secret_${opaqueToken(si, 16)}`,
        created: now,
        customer: typeof params.customer === "string" ? params.customer : null,
        description: null,
        last_setup_error: null,
        mandate: null,
        metadata: {},
        next_action: null,
        payment_method: null,
        payment_method_types: ["card"],
        status: "requires_payment_method",
        usage: "off_session",
      })
      setupIntent = si
    }
    if (mode === "subscription" && typeof params.customer === "string") {
      const created = await createSubscription(state, now, {
        customer: params.customer,
        items: params.line_items,
        metadata: params.metadata,
      })
      subscription = created.id
    }
    const session: CheckoutSessionRecord = {
      id,
      amount_total: priced.total,
      cancel_url: typeof params.cancel_url === "string" ? params.cancel_url : null,
      client_reference_id:
        typeof params.client_reference_id === "string" ? params.client_reference_id : null,
      created: now,
      currency: priced.currency,
      customer:
        typeof params.customer === "string" && params.customer !== "" ? params.customer : null,
      customer_email: typeof params.customer_email === "string" ? params.customer_email : null,
      expires_at: typeof params.expires_at === "number" ? params.expires_at : now + 24 * 60 * 60,
      metadata: mergeMetadata({}, params.metadata),
      mode,
      payment_intent: paymentIntent,
      payment_method_types: Array.isArray(params.payment_method_types)
        ? (params.payment_method_types as string[])
        : ["card"],
      payment_status: mode === "setup" ? "no_payment_required" : "unpaid",
      setup_intent: setupIntent,
      status: "open",
      submit_type:
        params.submit_type === "auto" ||
        params.submit_type === "book" ||
        params.submit_type === "donate" ||
        params.submit_type === "pay" ||
        params.submit_type === "subscribe"
          ? params.submit_type
          : null,
      subscription,
      success_url: typeof params.success_url === "string" ? params.success_url : null,
      ui_mode: uiMode,
      url: uiMode === "hosted_page" ? `https://checkout.stripe.com/c/pay/${id}` : null,
    }
    await state.checkoutSessions.insert(id, session)
    return jsonResponse(200, await expandObject(state, params.expand, renderSession(session)))
  },

  GetCheckoutSessions: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.checkoutSessions, params, {
      url: "/v1/checkout/sessions",
      kind: "checkout.session",
      where: (session) =>
        params.status === undefined || params.status === "" || session.status === params.status,
      render: renderSession,
    })
    return jsonResponse(200, page)
  },

  GetCheckoutSessionsSession: async (context: OperationContext) => {
    const params = queryParams(context)
    const session = await state.checkoutSessions.get(context.params.session ?? "")
    if (!session) throw resourceMissing("checkout.session", context.params.session ?? "", "session")
    return jsonResponse(200, await expandObject(state, params.expand, renderSession(session)))
  },

  PostCheckoutSessionsSession: async (context: OperationContext) => {
    const params = bodyParams(context)
    const session = await state.checkoutSessions.get(context.params.session ?? "")
    if (!session) throw resourceMissing("checkout.session", context.params.session ?? "", "session")
    session.metadata = mergeMetadata(session.metadata, params.metadata)
    await state.checkoutSessions.update(session.id, session)
    return jsonResponse(200, renderSession(session))
  },

  PostCheckoutSessionsSessionExpire: async (context: OperationContext) => {
    const session = await state.checkoutSessions.get(context.params.session ?? "")
    if (!session) throw resourceMissing("checkout.session", context.params.session ?? "", "session")
    if (session.status !== "open")
      throw invalidRequest("Only open Checkout Sessions can be expired.", "session")
    session.status = "expired"
    await state.checkoutSessions.update(session.id, session)
    return jsonResponse(200, renderSession(session))
  },

  GetCheckoutSessionsSessionLineItems: async (context: OperationContext) => {
    const session = await state.checkoutSessions.get(context.params.session ?? "")
    if (!session) throw resourceMissing("checkout.session", context.params.session ?? "", "session")
    return jsonResponse(200, embeddedList(`/v1/checkout/sessions/${session.id}/line_items`, []))
  },

  PostPaymentLinks: async (context: OperationContext) => {
    const params = bodyParams(context)
    const priced = await lineAmount(state, params)
    if (priced.count === 0)
      throw invalidRequest("You must provide at least one line item.", "line_items")
    const id = await state.ids.next("plink_")
    const items = (Array.isArray(params.line_items) ? params.line_items : []).flatMap((item) => {
      const record = asRecord(item)
      if (!record || typeof record.price !== "string") return []
      return [
        {
          price: record.price,
          quantity: typeof record.quantity === "number" ? record.quantity : 1,
        },
      ]
    })
    const link: PaymentLinkRecord = {
      id,
      active: params.active !== false,
      allow_promotion_codes: params.allow_promotion_codes === true,
      billing_address_collection:
        params.billing_address_collection === "required" ? "required" : "auto",
      currency: priced.currency ?? "usd",
      customer_creation: params.customer_creation === "always" ? "always" : "if_required",
      line_items: items,
      metadata: mergeMetadata({}, params.metadata),
      payment_method_collection:
        params.payment_method_collection === "if_required" ? "if_required" : "always",
      submit_type:
        params.submit_type === "book" ||
        params.submit_type === "donate" ||
        params.submit_type === "pay" ||
        params.submit_type === "subscribe"
          ? params.submit_type
          : "auto",
      url: `https://buy.stripe.com/${id}`,
    }
    await state.paymentLinks.insert(id, link)
    return jsonResponse(200, renderLink(link))
  },

  GetPaymentLinks: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.paymentLinks, params, {
      url: "/v1/payment_links",
      kind: "payment_link",
      where: (link) => params.active === undefined || link.active === params.active,
      render: renderLink,
    })
    return jsonResponse(200, page)
  },

  GetPaymentLinksPaymentLink: async (context: OperationContext) => {
    const link = await state.paymentLinks.get(context.params.payment_link ?? "")
    if (!link)
      throw resourceMissing("payment_link", context.params.payment_link ?? "", "payment_link")
    return jsonResponse(200, renderLink(link))
  },

  PostPaymentLinksPaymentLink: async (context: OperationContext) => {
    const params = bodyParams(context)
    const link = await state.paymentLinks.get(context.params.payment_link ?? "")
    if (!link)
      throw resourceMissing("payment_link", context.params.payment_link ?? "", "payment_link")
    if (typeof params.active === "boolean") link.active = params.active
    link.metadata = mergeMetadata(link.metadata, params.metadata)
    await state.paymentLinks.update(link.id, link)
    return jsonResponse(200, renderLink(link))
  },

  GetPaymentLinksPaymentLinkLineItems: async (context: OperationContext) => {
    const link = await state.paymentLinks.get(context.params.payment_link ?? "")
    if (!link)
      throw resourceMissing("payment_link", context.params.payment_link ?? "", "payment_link")
    const data = []
    for (const item of link.line_items) {
      const price = await state.prices.get(item.price)
      data.push({
        id: `li_${item.price}`,
        object: "item",
        price: price ? { id: price.id, object: "price" } : item.price,
        quantity: item.quantity,
      })
    }
    return jsonResponse(200, embeddedList(`/v1/payment_links/${link.id}/line_items`, data))
  },

  PostBillingPortalSessions: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.customer !== "string" || params.customer === "")
      throw parameterMissing("customer")
    await requireCustomer(state, params.customer)
    const id = await state.ids.next("bps_")
    const configuration =
      typeof params.configuration === "string" && params.configuration !== ""
        ? params.configuration
        : "bpc_mockingbird"
    const session = {
      id,
      configuration,
      created: now,
      customer: params.customer,
      return_url: typeof params.return_url === "string" ? params.return_url : null,
      url: `https://billing.stripe.com/p/session/${id}`,
    }
    await state.portalSessions.insert(id, session)
    return jsonResponse(200, {
      id,
      object: "billing_portal.session",
      configuration,
      created: now,
      customer: session.customer,
      livemode: false,
      return_url: session.return_url,
      url: session.url,
    })
  },

  PostCustomerSessions: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.customer !== "string" || params.customer === "")
      throw parameterMissing("customer")
    await requireCustomer(state, params.customer)
    const components = asRecord(params.components) ?? {}
    const enabled = (name: string) => asRecord(components[name])?.enabled === true
    const secret = `cuss_${opaqueToken(`cuss:${params.customer}:${now}`, 24)}`
    const record = {
      client_secret: secret,
      components: {
        payment_element: component(enabled("payment_element")),
        customer_sheet: component(enabled("customer_sheet")),
        mobile_payment_element: component(enabled("mobile_payment_element")),
        pricing_table: component(enabled("pricing_table")),
        buy_button: component(enabled("buy_button")),
        customer_portal: component(enabled("customer_portal")),
        active_entitlements: component(enabled("active_entitlements")),
      },
      created: now,
      customer: params.customer,
      expires_at: now + 30 * 60,
    }
    await state.customerSessions.insert(secret, record)
    return jsonResponse(200, { ...record, object: "customer_session", livemode: false })
  },

  PostEphemeralKeys: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (!context.request.headers.get("stripe-version"))
      throw invalidRequest(
        "You must pass a Stripe-Version header to create an ephemeral key.",
        "stripe_version",
      )
    if (typeof params.customer !== "string" || params.customer === "")
      throw parameterMissing("customer")
    await requireCustomer(state, params.customer)
    const id = await state.ids.next("ephkey_")
    const record = {
      id,
      created: now,
      expires: now + 60 * 60,
      secret: opaqueToken(`eph:${id}`, 32),
      customer: params.customer,
    }
    await state.ephemeralKeys.insert(id, record)
    return jsonResponse(200, {
      id,
      object: "ephemeral_key",
      created: now,
      expires: record.expires,
      livemode: false,
      secret: record.secret,
    })
  },

  DeleteEphemeralKeysKey: async (context: OperationContext) => {
    const id = context.params.key ?? ""
    const key = await state.ephemeralKeys.get(id)
    if (!key) throw resourceMissing("ephemeral_key", id, "key")
    await state.ephemeralKeys.delete(id)
    return jsonResponse(200, { id, object: "ephemeral_key", deleted: true })
  },
})
