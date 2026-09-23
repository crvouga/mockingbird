import { jsonResponse, type OperationContext, opaqueToken } from "@crvouga/mockingbird-service"
import { readApiKey } from "./auth.js"
import { cardFromNumber, MAGIC_PAYMENT_METHODS, MAGIC_TOKENS, renderCard } from "./cards.js"
import { cardError, invalidRequest, parameterMissing, resourceMissing } from "./errors.js"
import { recordEvent } from "./events.js"
import { expandObject } from "./expand.js"
import { mergeMetadata, validateStatementDescriptor } from "./fields.js"
import { postBalanceTransaction } from "./ledger.js"
import { embeddedList, matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { normalizeCurrency } from "./prices.js"
import {
  type BillingDetails,
  type CardDetails,
  type ChargeRecord,
  type PaymentIntentRecord,
  type PaymentMethodRecord,
  type SetupIntentRecord,
  type Shipping,
  type StripeState,
  seconds,
} from "./state.js"

const blankBilling = (): BillingDetails => ({
  address: null,
  email: null,
  name: null,
  phone: null,
})

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const addressOf = (raw: unknown) => {
  const input = asRecord(raw) ?? {}
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null)
  return {
    city: text("city"),
    country: text("country"),
    line1: text("line1"),
    line2: text("line2"),
    postal_code: text("postal_code"),
    state: text("state"),
  }
}

const billingOf = (raw: unknown): BillingDetails => {
  const input = asRecord(raw)
  if (!input) return blankBilling()
  return {
    address: input.address === undefined || input.address === "" ? null : addressOf(input.address),
    email: typeof input.email === "string" && input.email !== "" ? input.email : null,
    name: typeof input.name === "string" && input.name !== "" ? input.name : null,
    phone: typeof input.phone === "string" && input.phone !== "" ? input.phone : null,
  }
}

const shippingOf = (raw: unknown): Shipping | null => {
  if (raw === undefined || raw === "") return null
  const input = asRecord(raw)
  if (!input || typeof input.name !== "string")
    throw invalidRequest("Invalid shipping.", "shipping")
  return {
    address: addressOf(input.address),
    name: input.name,
    phone: typeof input.phone === "string" ? input.phone : null,
  }
}

const secretFor = (id: string) => `${id}_secret_${opaqueToken(`secret:${id}`, 24)}`

const publishable = (context: OperationContext) =>
  readApiKey(context.request, context.query)?.publishable === true

export const assertClientSecret = (expected: string, provided: unknown, client: boolean) => {
  if (!client) return
  if (provided !== expected)
    throw invalidRequest(
      "The client_secret provided does not match the client_secret associated with this object.",
      "client_secret",
    )
}

const idempotencyKey = (context: OperationContext) => context.request.headers.get("idempotency-key")

export const renderPaymentMethod = (method: PaymentMethodRecord) => ({
  id: method.id,
  object: "payment_method",
  allow_redisplay: method.allow_redisplay,
  billing_details: method.billing_details,
  card: method.card ? renderCard(method.card) : undefined,
  created: method.created,
  customer: method.customer,
  livemode: false,
  metadata: method.metadata,
  type: method.type,
})

export const renderCharge = async (state: StripeState, charge: ChargeRecord) => {
  const refunds = await state.refunds.list({ where: (refund) => refund.charge === charge.id })
  const method = charge.payment_method
    ? await state.paymentMethods.get(charge.payment_method)
    : undefined
  return {
    id: charge.id,
    object: "charge",
    amount: charge.amount,
    amount_captured: charge.amount_captured,
    amount_refunded: charge.amount_refunded,
    balance_transaction: charge.balance_transaction,
    billing_details: charge.billing_details,
    calculated_statement_descriptor: charge.statement_descriptor,
    captured: charge.captured,
    created: charge.created,
    currency: charge.currency,
    customer: charge.customer,
    description: charge.description,
    disputed: false,
    failure_code: charge.failure_code,
    failure_message: charge.failure_message,
    livemode: false,
    metadata: charge.metadata,
    paid: charge.paid,
    payment_intent: charge.payment_intent,
    payment_method: charge.payment_method,
    payment_method_details: method?.card
      ? {
          type: "card",
          card: {
            brand: method.card.brand,
            country: method.card.country,
            exp_month: method.card.exp_month,
            exp_year: method.card.exp_year,
            funding: method.card.funding,
            last4: method.card.last4,
            network: method.card.brand,
          },
        }
      : charge.payment_method
        ? { type: "card" }
        : null,
    receipt_email: charge.receipt_email,
    receipt_url: charge.paid ? `https://pay.stripe.com/receipts/${charge.id}` : null,
    refunded: charge.refunded,
    refunds: embeddedList(
      `/v1/charges/${charge.id}/refunds`,
      refunds.map((entry) => renderRefund(entry.value)),
    ),
    shipping: charge.shipping,
    statement_descriptor: charge.statement_descriptor,
    statement_descriptor_suffix: charge.statement_descriptor_suffix,
    status: charge.status,
  }
}

const renderRefund = (refund: {
  id: string
  amount: number
  balance_transaction: string | null
  charge: string | null
  created: number
  currency: string
  metadata: Record<string, string>
  payment_intent: string | null
  reason: string | null
  status: string
}) => ({
  id: refund.id,
  object: "refund",
  amount: refund.amount,
  balance_transaction: refund.balance_transaction,
  charge: refund.charge,
  created: refund.created,
  currency: refund.currency,
  metadata: refund.metadata,
  payment_intent: refund.payment_intent,
  reason: refund.reason,
  status: refund.status,
})

export const renderPaymentIntent = async (_state: StripeState, intent: PaymentIntentRecord) => ({
  id: intent.id,
  object: "payment_intent",
  amount: intent.amount,
  amount_capturable: intent.amount_capturable,
  amount_received: intent.amount_received,
  automatic_payment_methods: intent.automatic_payment_methods
    ? { enabled: true, allow_redirects: "always" }
    : null,
  canceled_at: intent.canceled_at,
  cancellation_reason: intent.cancellation_reason,
  capture_method: intent.capture_method,
  client_secret: intent.client_secret,
  confirmation_method: intent.confirmation_method,
  created: intent.created,
  currency: intent.currency,
  customer: intent.customer,
  description: intent.description,
  last_payment_error: intent.last_payment_error,
  latest_charge: intent.latest_charge,
  livemode: false,
  metadata: intent.metadata,
  next_action: intent.next_action,
  payment_method: intent.payment_method,
  payment_method_types: intent.payment_method_types,
  receipt_email: intent.receipt_email,
  setup_future_usage: intent.setup_future_usage,
  shipping: intent.shipping,
  statement_descriptor: intent.statement_descriptor,
  statement_descriptor_suffix: intent.statement_descriptor_suffix,
  status: intent.status,
})

const renderSetupIntent = (intent: SetupIntentRecord) => ({
  id: intent.id,
  object: "setup_intent",
  automatic_payment_methods: intent.automatic_payment_methods
    ? { enabled: true, allow_redirects: "always" }
    : null,
  cancellation_reason: intent.cancellation_reason,
  client_secret: intent.client_secret,
  created: intent.created,
  customer: intent.customer,
  description: intent.description,
  last_setup_error: intent.last_setup_error,
  livemode: false,
  mandate: intent.mandate,
  metadata: intent.metadata,
  next_action: intent.next_action,
  payment_method: intent.payment_method,
  payment_method_types: intent.payment_method_types,
  status: intent.status,
  usage: intent.usage,
})

const loadIntent = async (state: StripeState, id: string) => {
  const intent = await state.paymentIntents.get(id)
  if (!intent) throw resourceMissing("payment_intent", id, "intent")
  return intent
}

const loadMethod = async (state: StripeState, id: string, param = "payment_method") => {
  const method = await state.paymentMethods.get(id)
  if (!method) throw resourceMissing("payment_method", id, param, 400)
  return method
}

const cardFromToken = async (state: StripeState, tokenId: string, param: string) => {
  const magic = MAGIC_TOKENS[tokenId]
  if (magic) return cardFromNumber(magic.number, 12, 2034, "123", param, magic.funding)
  const token = await state.tokens.get(tokenId)
  if (!token) throw resourceMissing("token", tokenId, param, 400)
  if (token.used) throw invalidRequest(`The token ${tokenId} has already been used.`, param)
  if (!token.card) throw invalidRequest("The token is not a card token.", param)
  token.used = true
  await state.tokens.update(tokenId, token)
  return token.card
}

const cardFromInput = async (state: StripeState, raw: unknown, param: string) => {
  const input = asRecord(raw)
  if (!input) throw parameterMissing(param)
  if (typeof input.token === "string") return cardFromToken(state, input.token, `${param}[token]`)
  if (typeof input.number !== "string") throw parameterMissing(`${param}[number]`)
  return cardFromNumber(
    input.number,
    Number(input.exp_month),
    Number(input.exp_year),
    typeof input.cvc === "string" ? input.cvc : undefined,
    param,
  )
}

const saveMethod = async (
  state: StripeState,
  now: number,
  input: {
    type: string
    card: CardDetails | null
    billing: BillingDetails
    metadata: Record<string, string>
    customer: string | null
    allow: PaymentMethodRecord["allow_redisplay"]
    id?: string
  },
) => {
  const id = input.id ?? (await state.ids.next("pm_"))
  const method: PaymentMethodRecord = {
    id,
    allow_redisplay: input.allow,
    billing_details: input.billing,
    card: input.card,
    created: now,
    customer: input.customer,
    metadata: input.metadata,
    type: input.type,
  }
  await state.paymentMethods.insert(id, method)
  return method
}

/** Materialise `pm_card_visa` and the other fixed test payment methods. */
export const ensurePaymentMethod = async (state: StripeState, id: string, now: number) => {
  const existing = await state.paymentMethods.get(id)
  if (existing) return existing
  const magic = MAGIC_PAYMENT_METHODS[id]
  if (!magic) return undefined
  return saveMethod(state, now, {
    id,
    type: "card",
    card: cardFromNumber(magic.number, 12, 2034, "123", "card", magic.funding),
    billing: blankBilling(),
    metadata: {},
    customer: null,
    allow: "unspecified",
  })
}

const methodTypes = (params: Params, fallback: string[]) => {
  if (Array.isArray(params.payment_method_types)) return params.payment_method_types as string[]
  const automatic = asRecord(params.automatic_payment_methods)
  if (automatic?.enabled === true) return ["card"]
  return fallback
}

const requireCustomerId = async (state: StripeState, id: string, param: string) => {
  const entry = await state.customers.get(id)
  if (!entry || entry.kind !== "live") throw resourceMissing("customer", id, param, 400)
  return entry.customer
}

const attachMethod = async (
  state: StripeState,
  method: PaymentMethodRecord,
  customerId: string,
) => {
  if (method.customer !== null && method.customer !== customerId)
    throw invalidRequest(
      "The payment method you provided has already been attached to a customer.",
      "payment_method",
    )
  method.customer = customerId
  await state.paymentMethods.update(method.id, method)
  return method
}

const createCharge = async (
  state: StripeState,
  now: number,
  input: Omit<ChargeRecord, "id" | "balance_transaction" | "amount_refunded" | "refunded"> & {
    balance?: boolean
  },
) => {
  const id = await state.ids.next("ch_")
  let balanceId: string | null = null
  if (input.balance && input.status === "succeeded" && input.captured) {
    const txn = await postBalanceTransaction(state, {
      amount: input.amount,
      available_on: now,
      created: now,
      currency: input.currency,
      description: `Charge for ${id}`,
      fee: 0,
      reporting_category: "charge",
      source: id,
      status: "available",
      type: "charge",
    })
    balanceId = txn.id
  }
  const { balance: _balance, ...rest } = input
  const charge: ChargeRecord = {
    ...rest,
    id,
    amount_refunded: 0,
    balance_transaction: balanceId,
    refunded: false,
  }
  await state.charges.insert(id, charge)
  return charge
}

const failIntent = async (
  state: StripeState,
  now: number,
  intent: PaymentIntentRecord,
  method: PaymentMethodRecord,
  code: string,
  decline: string,
  message: string,
) => {
  const charge = await createCharge(state, now, {
    amount: intent.amount,
    amount_captured: 0,
    billing_details: method.billing_details,
    captured: false,
    created: now,
    currency: intent.currency,
    customer: intent.customer,
    description: intent.description,
    failure_code: code,
    failure_message: message,
    metadata: {},
    paid: false,
    payment_intent: intent.id,
    payment_method: method.id,
    receipt_email: intent.receipt_email,
    shipping: intent.shipping,
    statement_descriptor: intent.statement_descriptor,
    statement_descriptor_suffix: intent.statement_descriptor_suffix,
    status: "failed",
  })
  intent.status = "requires_payment_method"
  intent.latest_charge = charge.id
  intent.last_payment_error = {
    charge: charge.id,
    code,
    decline_code: decline,
    message,
    payment_method: { id: method.id, object: "payment_method", type: method.type },
    type: "card_error",
  }
  await state.paymentIntents.update(intent.id, intent)
  await recordEvent(
    state,
    "payment_intent.payment_failed",
    await renderPaymentIntent(state, intent),
    now,
  )
  await recordEvent(state, "charge.failed", await renderCharge(state, charge), now)
  throw cardError({
    code,
    decline_code: decline,
    message,
    charge: charge.id,
    payment_method: method.id,
    payment_intent: await renderPaymentIntent(state, intent),
  })
}

const succeedIntent = async (
  state: StripeState,
  now: number,
  intent: PaymentIntentRecord,
  method: PaymentMethodRecord,
) => {
  const manual = intent.capture_method === "manual"
  const charge = await createCharge(state, now, {
    amount: intent.amount,
    amount_captured: manual ? 0 : intent.amount,
    billing_details: method.billing_details,
    captured: !manual,
    created: now,
    currency: intent.currency,
    customer: intent.customer,
    description: intent.description,
    failure_code: null,
    failure_message: null,
    metadata: {},
    paid: true,
    payment_intent: intent.id,
    payment_method: method.id,
    receipt_email: intent.receipt_email,
    shipping: intent.shipping,
    statement_descriptor: intent.statement_descriptor,
    statement_descriptor_suffix: intent.statement_descriptor_suffix,
    status: "succeeded",
    balance: !manual,
  })
  intent.latest_charge = charge.id
  intent.last_payment_error = null
  intent.next_action = null
  if (manual) {
    intent.status = "requires_capture"
    intent.amount_capturable = intent.amount
    intent.amount_received = 0
  } else {
    intent.status = "succeeded"
    intent.amount_capturable = 0
    intent.amount_received = intent.amount
  }
  if (intent.setup_future_usage && intent.customer)
    await attachMethod(state, method, intent.customer)
  await state.paymentIntents.update(intent.id, intent)
  await recordEvent(state, "charge.succeeded", await renderCharge(state, charge), now)
  if (intent.status === "succeeded")
    await recordEvent(
      state,
      "payment_intent.succeeded",
      await renderPaymentIntent(state, intent),
      now,
    )
  else
    await recordEvent(
      state,
      "payment_intent.amount_capturable_updated",
      await renderPaymentIntent(state, intent),
      now,
    )
}

export const confirmPaymentIntent = async (
  state: StripeState,
  now: number,
  intent: PaymentIntentRecord,
  params: Params,
  client: boolean,
) => {
  assertClientSecret(intent.client_secret, params.client_secret, client)
  if (intent.status === "succeeded")
    throw invalidRequest("This PaymentIntent has already succeeded and cannot be confirmed again.")
  if (intent.status === "canceled")
    throw invalidRequest("This PaymentIntent has been canceled and cannot be confirmed.")
  if (typeof params.payment_method === "string" && params.payment_method !== "") {
    const method =
      (await ensurePaymentMethod(state, params.payment_method, now)) ??
      (await loadMethod(state, params.payment_method))
    intent.payment_method = method.id
  }
  const data = asRecord(params.payment_method_data)
  if (data) {
    const type = typeof data.type === "string" ? data.type : "card"
    const card =
      type === "card" ? await cardFromInput(state, data.card, "payment_method_data[card]") : null
    const method = await saveMethod(state, now, {
      type,
      card,
      billing: billingOf(data.billing_details),
      metadata: {},
      customer: intent.customer,
      allow: "unspecified",
    })
    intent.payment_method = method.id
  }
  if (typeof params.confirmation_token === "string" && params.confirmation_token !== "") {
    const token = await state.confirmationTokens.get(params.confirmation_token)
    if (!token)
      throw resourceMissing(
        "confirmation_token",
        params.confirmation_token,
        "confirmation_token",
        400,
      )
    if (!token.payment_method)
      throw invalidRequest(
        "The confirmation token is missing a payment method.",
        "confirmation_token",
      )
    intent.payment_method = token.payment_method
    if (token.return_url) params.return_url = token.return_url
  }
  if (!intent.payment_method)
    throw invalidRequest(
      "You cannot confirm this PaymentIntent because it's missing a payment method.",
      "payment_method",
    )
  const method = await loadMethod(state, intent.payment_method)
  if (method.card?.outcome.kind === "decline") {
    await failIntent(
      state,
      now,
      intent,
      method,
      method.card.outcome.code,
      method.card.outcome.decline_code,
      method.card.outcome.message,
    )
  }
  if (
    method.card?.outcome.kind === "authenticate" &&
    params.off_session !== true &&
    params.error_on_requires_action !== true
  ) {
    intent.status = "requires_action"
    intent.next_action = {
      type: "use_stripe_sdk",
      use_stripe_sdk: {
        type: "stripe_3ds2_fingerprint",
        directory_server_name: method.card.brand,
        merchant: "acct_mockingbird",
        server_transaction_id: opaqueToken(`3ds:${intent.id}`, 16),
        three_d_secure_2_source: await state.ids.next("setatt_"),
        three_ds_method_url: "",
      },
    }
    await state.paymentIntents.update(intent.id, intent)
    await recordEvent(
      state,
      "payment_intent.requires_action",
      await renderPaymentIntent(state, intent),
      now,
    )
    return intent
  }
  if (method.card?.outcome.kind === "authenticate") {
    await failIntent(
      state,
      now,
      intent,
      method,
      "authentication_required",
      "authentication_required",
      "Your card was declined. This transaction requires authentication.",
    )
  }
  await succeedIntent(state, now, intent, method)
  return intent
}

const newIntent = async (state: StripeState, now: number, params: Params) => {
  if (typeof params.amount !== "number") throw parameterMissing("amount")
  if (params.amount < 0) throw invalidRequest("Invalid positive integer", "amount")
  if (typeof params.currency !== "string") throw parameterMissing("currency")
  const currency = normalizeCurrency(params.currency)
  if (typeof params.customer === "string" && params.customer !== "")
    await requireCustomerId(state, params.customer, "customer")
  const descriptor = params.statement_descriptor
  if (typeof descriptor === "string" && descriptor !== "") validateStatementDescriptor(descriptor)
  const id = await state.ids.next("pi_")
  const intent: PaymentIntentRecord = {
    id,
    amount: params.amount,
    amount_capturable: 0,
    amount_received: 0,
    automatic_payment_methods: asRecord(params.automatic_payment_methods)?.enabled === true,
    canceled_at: null,
    cancellation_reason: null,
    capture_method:
      params.capture_method === "manual" || params.capture_method === "automatic"
        ? params.capture_method
        : "automatic_async",
    client_secret: secretFor(id),
    confirmation_method: params.confirmation_method === "manual" ? "manual" : "automatic",
    created: now,
    currency,
    customer:
      typeof params.customer === "string" && params.customer !== "" ? params.customer : null,
    description: typeof params.description === "string" ? params.description : null,
    last_payment_error: null,
    latest_charge: null,
    metadata: mergeMetadata({}, params.metadata),
    next_action: null,
    payment_method:
      typeof params.payment_method === "string" && params.payment_method !== ""
        ? params.payment_method
        : null,
    payment_method_types: methodTypes(params, ["card"]),
    receipt_email: typeof params.receipt_email === "string" ? params.receipt_email : null,
    setup_future_usage:
      params.setup_future_usage === "off_session" || params.setup_future_usage === "on_session"
        ? params.setup_future_usage
        : null,
    shipping: params.shipping === undefined ? null : shippingOf(params.shipping),
    statement_descriptor: typeof descriptor === "string" && descriptor !== "" ? descriptor : null,
    statement_descriptor_suffix:
      typeof params.statement_descriptor_suffix === "string"
        ? params.statement_descriptor_suffix
        : null,
    status: "requires_payment_method",
  }
  if (intent.payment_method) {
    const method =
      (await ensurePaymentMethod(state, intent.payment_method, now)) ??
      (await loadMethod(state, intent.payment_method))
    intent.payment_method = method.id
    intent.status = "requires_confirmation"
  }
  await state.paymentIntents.insert(id, intent)
  await recordEvent(state, "payment_intent.created", await renderPaymentIntent(state, intent), now)
  if (params.confirm === true) await confirmPaymentIntent(state, now, intent, params, false)
  return intent
}

const updateIntent = (intent: PaymentIntentRecord, params: Params) => {
  if (params.metadata !== undefined)
    intent.metadata = mergeMetadata(intent.metadata, params.metadata)
  if (typeof params.description === "string")
    intent.description = params.description === "" ? null : params.description
  if (typeof params.receipt_email === "string")
    intent.receipt_email = params.receipt_email === "" ? null : params.receipt_email
  if (params.shipping !== undefined) intent.shipping = shippingOf(params.shipping)
  if (typeof params.amount === "number") {
    if (intent.status !== "requires_payment_method" && intent.status !== "requires_confirmation")
      throw invalidRequest(
        "You cannot update the amount on a PaymentIntent after it has been confirmed.",
        "amount",
      )
    if (params.amount < 0) throw invalidRequest("Invalid positive integer", "amount")
    intent.amount = params.amount
  }
  if (typeof params.customer === "string")
    intent.customer = params.customer === "" ? null : params.customer
}

const renderToken = (token: {
  id: string
  card: CardDetails | null
  client_ip: string | null
  created: number
  type: string
  used: boolean
}) => ({
  id: token.id,
  object: "token",
  card: token.card
    ? { ...renderCard(token.card), id: token.id.replace(/^tok_/, "card_"), object: "card" }
    : undefined,
  client_ip: token.client_ip,
  created: token.created,
  livemode: false,
  type: token.type,
  used: token.used,
})

const renderConfirmation = async (
  state: StripeState,
  token: {
    id: string
    created: number
    expires_at: number
    payment_method: string | null
    return_url: string | null
    setup_future_usage: "off_session" | "on_session" | null
    shipping: Shipping | null
  },
) => ({
  id: token.id,
  object: "confirmation_token",
  created: token.created,
  expires_at: token.expires_at,
  livemode: false,
  payment_method_preview: token.payment_method
    ? renderPaymentMethod(await loadMethod(state, token.payment_method))
    : null,
  return_url: token.return_url,
  setup_future_usage: token.setup_future_usage,
  shipping: token.shipping,
  use_stripe_sdk: true,
})

export const paymentHandlers = (state: StripeState) => ({
  PostPaymentMethods: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const type = typeof params.type === "string" && params.type !== "" ? params.type : undefined
    if (!type) throw parameterMissing("type")
    const card = type === "card" ? await cardFromInput(state, params.card, "card") : null
    let customer: string | null = null
    if (typeof params.customer === "string" && params.customer !== "") {
      await requireCustomerId(state, params.customer, "customer")
      customer = params.customer
    }
    const method = await saveMethod(state, now, {
      type,
      card,
      billing: billingOf(params.billing_details),
      metadata: mergeMetadata({}, params.metadata),
      customer,
      allow:
        params.allow_redisplay === "always" || params.allow_redisplay === "limited"
          ? params.allow_redisplay
          : "unspecified",
    })
    if (customer)
      await recordEvent(
        state,
        "payment_method.attached",
        renderPaymentMethod(method),
        now,
        idempotencyKey(context),
      )
    return jsonResponse(200, await expandObject(state, params.expand, renderPaymentMethod(method)))
  },

  GetPaymentMethods: async (context: OperationContext) => {
    const params = queryParams(context)
    if (typeof params.customer !== "string" || params.customer === "")
      throw parameterMissing("customer")
    await requireCustomerId(state, params.customer, "customer")
    const page = await paginate(state.paymentMethods, params, {
      url: "/v1/payment_methods",
      kind: "payment_method",
      where: (method) =>
        method.customer === params.customer &&
        (params.type === undefined || params.type === "" || method.type === params.type) &&
        (params.allow_redisplay === undefined || method.allow_redisplay === params.allow_redisplay),
      render: renderPaymentMethod,
    })
    return jsonResponse(200, page)
  },

  GetPaymentMethodsPaymentMethod: async (context: OperationContext) => {
    const params = queryParams(context)
    const id = context.params.payment_method ?? ""
    const method =
      (await ensurePaymentMethod(state, id, seconds(context.now))) ??
      (await loadMethod(state, id, "payment_method"))
    return jsonResponse(200, await expandObject(state, params.expand, renderPaymentMethod(method)))
  },

  PostPaymentMethodsPaymentMethod: async (context: OperationContext) => {
    const params = bodyParams(context)
    const id = context.params.payment_method ?? ""
    const method = await loadMethod(state, id)
    method.metadata = mergeMetadata(method.metadata, params.metadata)
    if (params.billing_details !== undefined)
      method.billing_details = billingOf(params.billing_details)
    if (
      params.allow_redisplay === "always" ||
      params.allow_redisplay === "limited" ||
      params.allow_redisplay === "unspecified"
    )
      method.allow_redisplay = params.allow_redisplay
    if (asRecord(params.card) && method.card) {
      const card = asRecord(params.card)
      if (card && typeof card.exp_month === "number") method.card.exp_month = card.exp_month
      if (card && typeof card.exp_year === "number") method.card.exp_year = card.exp_year
    }
    await state.paymentMethods.update(id, method)
    return jsonResponse(200, renderPaymentMethod(method))
  },

  PostPaymentMethodsPaymentMethodAttach: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.customer !== "string" || params.customer === "")
      throw parameterMissing("customer")
    await requireCustomerId(state, params.customer, "customer")
    const method = await loadMethod(state, context.params.payment_method ?? "")
    await attachMethod(state, method, params.customer)
    await recordEvent(state, "payment_method.attached", renderPaymentMethod(method), now)
    return jsonResponse(200, renderPaymentMethod(method))
  },

  PostPaymentMethodsPaymentMethodDetach: async (context: OperationContext) => {
    const now = seconds(context.now)
    const method = await loadMethod(state, context.params.payment_method ?? "")
    if (method.customer === null)
      throw invalidRequest(
        "The payment method you provided is not attached to a customer so detachment is impossible.",
        "payment_method",
      )
    const customerId = method.customer
    method.customer = null
    await state.paymentMethods.update(method.id, method)
    const entry = await state.customers.get(customerId)
    if (
      entry?.kind === "live" &&
      entry.customer.invoice_settings.default_payment_method === method.id
    ) {
      entry.customer.invoice_settings.default_payment_method = null
      await state.customers.update(customerId, entry)
    }
    await recordEvent(state, "payment_method.detached", renderPaymentMethod(method), now)
    return jsonResponse(200, renderPaymentMethod(method))
  },

  PostPaymentIntents: async (context: OperationContext) => {
    const params = bodyParams(context)
    const intent = await newIntent(state, seconds(context.now), params)
    const fresh = await loadIntent(state, intent.id)
    return jsonResponse(
      200,
      await expandObject(state, params.expand, await renderPaymentIntent(state, fresh)),
    )
  },

  GetPaymentIntents: async (context: OperationContext) => {
    const params = queryParams(context)
    const customer = params.customer
    if (typeof customer === "string" && customer !== "")
      await requireCustomerId(state, customer, "customer")
    const page = await paginate(state.paymentIntents, params, {
      url: "/v1/payment_intents",
      kind: "payment_intent",
      where: (intent) =>
        matchesCreated(intent.created, params.created) &&
        (typeof customer !== "string" || customer === "" || intent.customer === customer),
      render: (intent) => renderPaymentIntent(state, intent),
    })
    return jsonResponse(200, page)
  },

  GetPaymentIntentsIntent: async (context: OperationContext) => {
    const params = queryParams(context)
    const intent = await loadIntent(state, context.params.intent ?? "")
    assertClientSecret(
      intent.client_secret,
      params.client_secret ?? context.query.client_secret,
      publishable(context),
    )
    return jsonResponse(
      200,
      await expandObject(state, params.expand, await renderPaymentIntent(state, intent)),
    )
  },

  PostPaymentIntentsIntent: async (context: OperationContext) => {
    const params = bodyParams(context)
    const intent = await loadIntent(state, context.params.intent ?? "")
    updateIntent(intent, params)
    await state.paymentIntents.update(intent.id, intent)
    return jsonResponse(200, await renderPaymentIntent(state, intent))
  },

  PostPaymentIntentsIntentConfirm: async (context: OperationContext) => {
    const params = bodyParams(context)
    const intent = await loadIntent(state, context.params.intent ?? "")
    await confirmPaymentIntent(state, seconds(context.now), intent, params, publishable(context))
    const fresh = await loadIntent(state, intent.id)
    return jsonResponse(
      200,
      await expandObject(state, params.expand, await renderPaymentIntent(state, fresh)),
    )
  },

  PostPaymentIntentsIntentCapture: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const intent = await loadIntent(state, context.params.intent ?? "")
    if (intent.status !== "requires_capture")
      throw invalidRequest(
        "This PaymentIntent could not be captured because it has a status of " +
          intent.status +
          ".",
      )
    const amount =
      typeof params.amount_to_capture === "number" ? params.amount_to_capture : intent.amount
    if (amount <= 0 || amount > intent.amount_capturable)
      throw invalidRequest(
        "The amount to capture must be less than or equal to the capturable amount.",
        "amount_to_capture",
      )
    const charge = intent.latest_charge ? await state.charges.get(intent.latest_charge) : undefined
    if (charge) {
      charge.captured = true
      charge.amount_captured = amount
      const txn = await postBalanceTransaction(state, {
        amount,
        available_on: now,
        created: now,
        currency: charge.currency,
        description: `Capture of ${charge.id}`,
        fee: 0,
        reporting_category: "charge",
        source: charge.id,
        status: "available",
        type: "charge",
      })
      charge.balance_transaction = txn.id
      await state.charges.update(charge.id, charge)
    }
    intent.amount_received = amount
    intent.amount_capturable = 0
    intent.status = "succeeded"
    await state.paymentIntents.update(intent.id, intent)
    await recordEvent(
      state,
      "payment_intent.succeeded",
      await renderPaymentIntent(state, intent),
      now,
    )
    return jsonResponse(200, await renderPaymentIntent(state, intent))
  },

  PostPaymentIntentsIntentCancel: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const intent = await loadIntent(state, context.params.intent ?? "")
    if (intent.status === "succeeded" || intent.status === "canceled")
      throw invalidRequest(
        `You cannot cancel this PaymentIntent because it has a status of ${intent.status}.`,
      )
    intent.status = "canceled"
    intent.canceled_at = now
    intent.cancellation_reason =
      typeof params.cancellation_reason === "string" ? params.cancellation_reason : null
    intent.amount_capturable = 0
    await state.paymentIntents.update(intent.id, intent)
    await recordEvent(
      state,
      "payment_intent.canceled",
      await renderPaymentIntent(state, intent),
      now,
    )
    return jsonResponse(200, await renderPaymentIntent(state, intent))
  },

  GetPaymentIntentsSearch: async (context: OperationContext) => {
    const params = queryParams(context)
    const { parseSearch, matchesSearch, searchPage } = await import("./search.js")
    const clauses = parseSearch(String(params.query ?? ""))
    const rows = await state.paymentIntents.list({
      where: (intent) =>
        matchesSearch(
          clauses,
          (field) => {
            if (field === "status") return intent.status
            if (field === "currency") return intent.currency
            if (field === "customer") return intent.customer
            return undefined
          },
          intent.metadata,
        ),
    })
    const data = await Promise.all(rows.map((row) => renderPaymentIntent(state, row.value)))
    return jsonResponse(200, searchPage("/v1/payment_intents/search", data))
  },

  PostSetupIntents: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.customer === "string" && params.customer !== "")
      await requireCustomerId(state, params.customer, "customer")
    const id = await state.ids.next("seti_")
    const intent: SetupIntentRecord = {
      id,
      automatic_payment_methods: asRecord(params.automatic_payment_methods)?.enabled === true,
      cancellation_reason: null,
      client_secret: secretFor(id),
      created: now,
      customer:
        typeof params.customer === "string" && params.customer !== "" ? params.customer : null,
      description: typeof params.description === "string" ? params.description : null,
      last_setup_error: null,
      mandate: null,
      metadata: mergeMetadata({}, params.metadata),
      next_action: null,
      payment_method:
        typeof params.payment_method === "string" && params.payment_method !== ""
          ? params.payment_method
          : null,
      payment_method_types: methodTypes(params, ["card"]),
      status: "requires_payment_method",
      usage: params.usage === "on_session" ? "on_session" : "off_session",
    }
    if (intent.payment_method) intent.status = "requires_confirmation"
    await state.setupIntents.insert(id, intent)
    await recordEvent(state, "setup_intent.created", renderSetupIntent(intent), now)
    if (params.confirm === true) await confirmSetup(state, now, intent, params, false)
    const fresh = await state.setupIntents.get(id)
    return jsonResponse(200, renderSetupIntent(fresh ?? intent))
  },

  GetSetupIntents: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.setupIntents, params, {
      url: "/v1/setup_intents",
      kind: "setup_intent",
      where: (intent) =>
        matchesCreated(intent.created, params.created) &&
        (typeof params.customer !== "string" ||
          params.customer === "" ||
          intent.customer === params.customer),
      render: renderSetupIntent,
    })
    return jsonResponse(200, page)
  },

  GetSetupIntentsIntent: async (context: OperationContext) => {
    const params = queryParams(context)
    const intent = await state.setupIntents.get(context.params.intent ?? "")
    if (!intent) throw resourceMissing("setup_intent", context.params.intent ?? "", "intent")
    assertClientSecret(
      intent.client_secret,
      params.client_secret ?? context.query.client_secret,
      publishable(context),
    )
    return jsonResponse(200, renderSetupIntent(intent))
  },

  PostSetupIntentsIntent: async (context: OperationContext) => {
    const params = bodyParams(context)
    const intent = await state.setupIntents.get(context.params.intent ?? "")
    if (!intent) throw resourceMissing("setup_intent", context.params.intent ?? "", "intent")
    intent.metadata = mergeMetadata(intent.metadata, params.metadata)
    if (typeof params.description === "string") intent.description = params.description || null
    if (typeof params.payment_method === "string" && params.payment_method !== "") {
      intent.payment_method = params.payment_method
      if (intent.status === "requires_payment_method") intent.status = "requires_confirmation"
    }
    await state.setupIntents.update(intent.id, intent)
    return jsonResponse(200, renderSetupIntent(intent))
  },

  PostSetupIntentsIntentConfirm: async (context: OperationContext) => {
    const params = bodyParams(context)
    const intent = await state.setupIntents.get(context.params.intent ?? "")
    if (!intent) throw resourceMissing("setup_intent", context.params.intent ?? "", "intent")
    await confirmSetup(state, seconds(context.now), intent, params, publishable(context))
    const fresh = await state.setupIntents.get(intent.id)
    return jsonResponse(200, renderSetupIntent(fresh ?? intent))
  },

  PostSetupIntentsIntentCancel: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const intent = await state.setupIntents.get(context.params.intent ?? "")
    if (!intent) throw resourceMissing("setup_intent", context.params.intent ?? "", "intent")
    if (intent.status === "succeeded" || intent.status === "canceled")
      throw invalidRequest(
        `You cannot cancel this SetupIntent because it has a status of ${intent.status}.`,
      )
    intent.status = "canceled"
    intent.cancellation_reason =
      typeof params.cancellation_reason === "string" ? params.cancellation_reason : null
    await state.setupIntents.update(intent.id, intent)
    await recordEvent(state, "setup_intent.canceled", renderSetupIntent(intent), now)
    return jsonResponse(200, renderSetupIntent(intent))
  },

  PostCharges: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.amount !== "number") throw parameterMissing("amount")
    if (typeof params.currency !== "string") throw parameterMissing("currency")
    const currency = normalizeCurrency(params.currency)
    let methodId: string | null = null
    let billing = blankBilling()
    if (typeof params.source === "string" && params.source !== "") {
      const method = await methodFromSource(state, params.source, now)
      methodId = method.id
      billing = method.billing_details
      if (method.card?.outcome.kind === "decline") {
        const charge = await createCharge(state, now, {
          amount: params.amount,
          amount_captured: 0,
          billing_details: billing,
          captured: false,
          created: now,
          currency,
          customer: typeof params.customer === "string" ? params.customer : null,
          description: typeof params.description === "string" ? params.description : null,
          failure_code: method.card.outcome.code,
          failure_message: method.card.outcome.message,
          metadata: mergeMetadata({}, params.metadata),
          paid: false,
          payment_intent: null,
          payment_method: methodId,
          receipt_email: null,
          shipping: null,
          statement_descriptor: null,
          statement_descriptor_suffix: null,
          status: "failed",
        })
        throw cardError({
          code: method.card.outcome.code,
          decline_code: method.card.outcome.decline_code,
          message: method.card.outcome.message,
          charge: charge.id,
        })
      }
    }
    const capture = params.capture !== false
    const charge = await createCharge(state, now, {
      amount: params.amount,
      amount_captured: capture ? params.amount : 0,
      billing_details: billing,
      captured: capture,
      created: now,
      currency,
      customer:
        typeof params.customer === "string" && params.customer !== "" ? params.customer : null,
      description: typeof params.description === "string" ? params.description : null,
      failure_code: null,
      failure_message: null,
      metadata: mergeMetadata({}, params.metadata),
      paid: true,
      payment_intent: null,
      payment_method: methodId,
      receipt_email: typeof params.receipt_email === "string" ? params.receipt_email : null,
      shipping: params.shipping === undefined ? null : shippingOf(params.shipping),
      statement_descriptor: null,
      statement_descriptor_suffix: null,
      status: "succeeded",
      balance: capture,
    })
    await recordEvent(state, "charge.succeeded", await renderCharge(state, charge), now)
    return jsonResponse(200, await renderCharge(state, charge))
  },

  GetCharges: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.charges, params, {
      url: "/v1/charges",
      kind: "charge",
      where: (charge) =>
        matchesCreated(charge.created, params.created) &&
        (typeof params.customer !== "string" ||
          params.customer === "" ||
          charge.customer === params.customer) &&
        (typeof params.payment_intent !== "string" ||
          params.payment_intent === "" ||
          charge.payment_intent === params.payment_intent),
      render: (charge) => renderCharge(state, charge),
    })
    return jsonResponse(200, page)
  },

  GetChargesCharge: async (context: OperationContext) => {
    queryParams(context)
    const charge = await state.charges.get(context.params.charge ?? "")
    if (!charge) throw resourceMissing("charge", context.params.charge ?? "", "charge")
    return jsonResponse(200, await renderCharge(state, charge))
  },

  PostChargesCharge: async (context: OperationContext) => {
    const params = bodyParams(context)
    const charge = await state.charges.get(context.params.charge ?? "")
    if (!charge) throw resourceMissing("charge", context.params.charge ?? "", "charge")
    charge.metadata = mergeMetadata(charge.metadata, params.metadata)
    if (typeof params.description === "string") charge.description = params.description || null
    if (typeof params.receipt_email === "string")
      charge.receipt_email = params.receipt_email || null
    await state.charges.update(charge.id, charge)
    return jsonResponse(200, await renderCharge(state, charge))
  },

  PostChargesChargeCapture: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const charge = await state.charges.get(context.params.charge ?? "")
    if (!charge) throw resourceMissing("charge", context.params.charge ?? "", "charge")
    if (charge.captured) throw invalidRequest("Charge has already been captured.", "charge")
    const amount = typeof params.amount === "number" ? params.amount : charge.amount
    charge.captured = true
    charge.amount_captured = amount
    const txn = await postBalanceTransaction(state, {
      amount,
      available_on: now,
      created: now,
      currency: charge.currency,
      description: `Capture of ${charge.id}`,
      fee: 0,
      reporting_category: "charge",
      source: charge.id,
      status: "available",
      type: "charge",
    })
    charge.balance_transaction = txn.id
    await state.charges.update(charge.id, charge)
    return jsonResponse(200, await renderCharge(state, charge))
  },

  GetChargesSearch: async (context: OperationContext) => {
    const params = queryParams(context)
    const { parseSearch, matchesSearch, searchPage } = await import("./search.js")
    const clauses = parseSearch(String(params.query ?? ""))
    const rows = await state.charges.list({
      where: (charge) =>
        matchesSearch(
          clauses,
          (field) => {
            if (field === "status") return charge.status
            if (field === "currency") return charge.currency
            if (field === "customer") return charge.customer
            return undefined
          },
          charge.metadata,
        ),
    })
    const data = await Promise.all(rows.map((row) => renderCharge(state, row.value)))
    return jsonResponse(200, searchPage("/v1/charges/search", data))
  },

  GetChargesChargeRefunds: async (context: OperationContext) => {
    const params = queryParams(context)
    const chargeId = context.params.charge ?? ""
    if (!(await state.charges.get(chargeId))) throw resourceMissing("charge", chargeId, "charge")
    const page = await paginate(state.refunds, params, {
      url: `/v1/charges/${chargeId}/refunds`,
      kind: "refund",
      where: (refund) => refund.charge === chargeId,
      render: renderRefund,
    })
    return jsonResponse(200, page)
  },

  PostChargesChargeRefunds: async (context: OperationContext) => {
    const params = bodyParams(context)
    const refund = await createRefund(state, seconds(context.now), {
      ...params,
      charge: context.params.charge,
    })
    return jsonResponse(200, renderRefund(refund))
  },

  GetChargesChargeRefundsRefund: async (context: OperationContext) => {
    const refund = await state.refunds.get(context.params.refund ?? "")
    if (!refund || refund.charge !== context.params.charge)
      throw resourceMissing("refund", context.params.refund ?? "", "refund")
    return jsonResponse(200, renderRefund(refund))
  },

  PostChargesChargeRefundsRefund: async (context: OperationContext) => {
    const params = bodyParams(context)
    const refund = await state.refunds.get(context.params.refund ?? "")
    if (!refund) throw resourceMissing("refund", context.params.refund ?? "", "refund")
    refund.metadata = mergeMetadata(refund.metadata, params.metadata)
    await state.refunds.update(refund.id, refund)
    return jsonResponse(200, renderRefund(refund))
  },

  PostRefunds: async (context: OperationContext) => {
    const params = bodyParams(context)
    const refund = await createRefund(state, seconds(context.now), params)
    return jsonResponse(200, await expandObject(state, params.expand, renderRefund(refund)))
  },

  GetRefunds: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.refunds, params, {
      url: "/v1/refunds",
      kind: "refund",
      where: (refund) =>
        (typeof params.charge !== "string" ||
          params.charge === "" ||
          refund.charge === params.charge) &&
        (typeof params.payment_intent !== "string" ||
          params.payment_intent === "" ||
          refund.payment_intent === params.payment_intent),
      render: renderRefund,
    })
    return jsonResponse(200, page)
  },

  GetRefundsRefund: async (context: OperationContext) => {
    const refund = await state.refunds.get(context.params.refund ?? "")
    if (!refund) throw resourceMissing("refund", context.params.refund ?? "", "refund")
    return jsonResponse(200, renderRefund(refund))
  },

  PostRefundsRefund: async (context: OperationContext) => {
    const params = bodyParams(context)
    const refund = await state.refunds.get(context.params.refund ?? "")
    if (!refund) throw resourceMissing("refund", context.params.refund ?? "", "refund")
    refund.metadata = mergeMetadata(refund.metadata, params.metadata)
    await state.refunds.update(refund.id, refund)
    return jsonResponse(200, renderRefund(refund))
  },

  PostRefundsRefundCancel: async (context: OperationContext) => {
    const refund = await state.refunds.get(context.params.refund ?? "")
    if (!refund) throw resourceMissing("refund", context.params.refund ?? "", "refund")
    if (refund.status !== "pending")
      throw invalidRequest(
        `This refund cannot be canceled because it has a status of ${refund.status}.`,
      )
    refund.status = "canceled"
    await state.refunds.update(refund.id, refund)
    return jsonResponse(200, renderRefund(refund))
  },

  PostTokens: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (params.card === undefined && params.bank_account === undefined)
      throw invalidRequest(
        "You must supply either a card, customer, pii, bank_account, or account to create a token.",
      )
    const card = params.card === undefined ? null : await cardFromInput(state, params.card, "card")
    const id = await state.ids.next("tok_")
    const token = {
      id,
      card,
      client_ip: context.request.headers.get("x-forwarded-for"),
      created: now,
      type: "card" as const,
      used: false,
    }
    await state.tokens.insert(id, token)
    return jsonResponse(200, renderToken(token))
  },

  GetTokensToken: async (context: OperationContext) => {
    const token = await state.tokens.get(context.params.token ?? "")
    if (!token) throw resourceMissing("token", context.params.token ?? "", "token")
    return jsonResponse(200, renderToken(token))
  },

  PostSources: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    const requested = typeof params.type === "string" && params.type !== "" ? params.type : "card"
    const sourceTypes = new Set([
      "ach_credit_transfer",
      "ach_debit",
      "acss_debit",
      "alipay",
      "au_becs_debit",
      "bancontact",
      "card",
      "card_present",
      "eps",
      "giropay",
      "ideal",
      "klarna",
      "multibanco",
      "p24",
      "sepa_debit",
      "sofort",
      "three_d_secure",
      "wechat",
    ])
    if (!sourceTypes.has(requested))
      throw invalidRequest(`Invalid type: must be one of ${[...sourceTypes].join(", ")}`, "type")
    const type = requested
    const card =
      type !== "card"
        ? null
        : typeof params.token === "string"
          ? await cardFromToken(state, params.token, "token")
          : params.card
            ? await cardFromInput(state, params.card, "card")
            : null
    const id = await state.ids.next("src_")
    const source = {
      id,
      client_secret: secretFor(id),
      created: now,
      currency: typeof params.currency === "string" ? normalizeCurrency(params.currency) : null,
      customer: null,
      flow: "none" as const,
      status: "chargeable" as const,
      type,
      card,
    }
    await state.sources.insert(id, source)
    return jsonResponse(200, {
      id,
      object: "source",
      client_secret: source.client_secret,
      created: now,
      currency: source.currency,
      flow: source.flow,
      livemode: false,
      status: source.status,
      type,
      usage: "reusable",
    })
  },

  GetSourcesSource: async (context: OperationContext) => {
    const source = await state.sources.get(context.params.source ?? "")
    if (!source) throw resourceMissing("source", context.params.source ?? "", "source")
    return jsonResponse(200, {
      id: source.id,
      object: "source",
      client_secret: source.client_secret,
      created: source.created,
      currency: source.currency,
      flow: source.flow,
      livemode: false,
      status: source.status,
      type: source.type,
    })
  },

  PostSourcesSource: async (context: OperationContext) => {
    bodyParams(context)
    const source = await state.sources.get(context.params.source ?? "")
    if (!source) throw resourceMissing("source", context.params.source ?? "", "source")
    return jsonResponse(200, {
      id: source.id,
      object: "source",
      client_secret: source.client_secret,
      created: source.created,
      flow: source.flow,
      livemode: false,
      status: source.status,
      type: source.type,
    })
  },

  GetConfirmationTokensConfirmationToken: async (context: OperationContext) => {
    const token = await state.confirmationTokens.get(context.params.confirmation_token ?? "")
    if (!token)
      throw resourceMissing(
        "confirmation_token",
        context.params.confirmation_token ?? "",
        "confirmation_token",
      )
    return jsonResponse(200, await renderConfirmation(state, token))
  },

  PostTestHelpersConfirmationTokens: async (context: OperationContext) => {
    const params = bodyParams(context)
    return jsonResponse(
      200,
      await renderConfirmation(
        state,
        await createConfirmationToken(state, seconds(context.now), params),
      ),
    )
  },

  GetMandatesMandate: async (context: OperationContext) => {
    const mandate = await state.mandates.get(context.params.mandate ?? "")
    if (!mandate) throw resourceMissing("mandate", context.params.mandate ?? "", "mandate")
    const method = await state.paymentMethods.get(mandate.payment_method)
    return jsonResponse(200, {
      id: mandate.id,
      object: "mandate",
      customer_acceptance: {
        accepted_at: mandate.created,
        online: { ip_address: "127.0.0.1", user_agent: "mockingbird" },
        type: "online",
      },
      livemode: false,
      payment_method: mandate.payment_method,
      payment_method_details: { type: method?.type ?? "card", card: {} },
      status: mandate.status,
      type: mandate.type,
    })
  },
})

const methodFromSource = async (state: StripeState, source: string, now: number) => {
  const magic = MAGIC_TOKENS[source]
  if (magic || source.startsWith("tok_")) {
    const card = await cardFromToken(state, source, "source")
    return saveMethod(state, now, {
      type: "card",
      card,
      billing: blankBilling(),
      metadata: {},
      customer: null,
      allow: "unspecified",
    })
  }
  const ensured = await ensurePaymentMethod(state, source, now)
  if (ensured) return ensured
  const method = await state.paymentMethods.get(source)
  if (method) return method
  const stored = await state.sources.get(source)
  if (stored?.card)
    return saveMethod(state, now, {
      type: "card",
      card: stored.card,
      billing: blankBilling(),
      metadata: {},
      customer: stored.customer,
      allow: "unspecified",
    })
  throw resourceMissing("source", source, "source", 400)
}

const confirmSetup = async (
  state: StripeState,
  now: number,
  intent: SetupIntentRecord,
  params: Params,
  client: boolean,
) => {
  assertClientSecret(intent.client_secret, params.client_secret, client)
  if (intent.status === "succeeded" || intent.status === "canceled")
    throw invalidRequest(
      `This SetupIntent cannot be confirmed because it has a status of ${intent.status}.`,
    )
  if (typeof params.payment_method === "string" && params.payment_method !== "") {
    const method =
      (await ensurePaymentMethod(state, params.payment_method, now)) ??
      (await loadMethod(state, params.payment_method))
    intent.payment_method = method.id
  }
  const data = asRecord(params.payment_method_data)
  if (data) {
    const type = typeof data.type === "string" ? data.type : "card"
    const card =
      type === "card" ? await cardFromInput(state, data.card, "payment_method_data[card]") : null
    const method = await saveMethod(state, now, {
      type,
      card,
      billing: billingOf(data.billing_details),
      metadata: {},
      customer: intent.customer,
      allow: "unspecified",
    })
    intent.payment_method = method.id
  }
  if (!intent.payment_method)
    throw invalidRequest(
      "You cannot confirm this SetupIntent because it's missing a payment method.",
      "payment_method",
    )
  const method = await loadMethod(state, intent.payment_method)
  if (method.card?.outcome.kind === "decline") {
    intent.status = "requires_payment_method"
    intent.last_setup_error = {
      code: method.card.outcome.code,
      decline_code: method.card.outcome.decline_code,
      message: method.card.outcome.message,
      type: "card_error",
    }
    await state.setupIntents.update(intent.id, intent)
    throw cardError({
      code: method.card.outcome.code,
      decline_code: method.card.outcome.decline_code,
      message: method.card.outcome.message,
      setup_intent: renderSetupIntent(intent),
      payment_method: method.id,
    })
  }
  if (method.card?.outcome.kind === "authenticate") {
    intent.status = "requires_action"
    intent.next_action = {
      type: "use_stripe_sdk",
      use_stripe_sdk: { type: "stripe_3ds2_fingerprint" },
    }
    await state.setupIntents.update(intent.id, intent)
    return intent
  }
  if (intent.customer) await attachMethod(state, method, intent.customer)
  const mandateId = await state.ids.next("mandate_")
  await state.mandates.insert(mandateId, {
    id: mandateId,
    created: now,
    customer: intent.customer,
    payment_method: method.id,
    status: "active",
    type: "multi_use",
  })
  intent.mandate = mandateId
  intent.status = "succeeded"
  intent.next_action = null
  intent.last_setup_error = null
  await state.setupIntents.update(intent.id, intent)
  await recordEvent(state, "setup_intent.succeeded", renderSetupIntent(intent), now)
  return intent
}

export const createRefund = async (state: StripeState, now: number, params: Params) => {
  const chargeId =
    typeof params.charge === "string" && params.charge !== "" ? params.charge : undefined
  const intentId =
    typeof params.payment_intent === "string" && params.payment_intent !== ""
      ? params.payment_intent
      : undefined
  if (chargeId && intentId)
    throw invalidRequest("You may only supply one of `charge` or `payment_intent`.", "charge")
  let charge = chargeId ? await state.charges.get(chargeId) : undefined
  if (!charge && intentId) {
    const intent = await loadIntent(state, intentId)
    charge = intent.latest_charge ? await state.charges.get(intent.latest_charge) : undefined
  }
  if (!charge) {
    if (chargeId) throw resourceMissing("charge", chargeId, "charge", 400)
    if (intentId)
      throw invalidRequest("This PaymentIntent does not have a charge to refund.", "payment_intent")
    throw invalidRequest("You must supply either `charge` or `payment_intent`.")
  }
  if (!charge.captured) throw invalidRequest("This charge has not been captured.", "charge")
  const remaining = charge.amount - charge.amount_refunded
  const amount = typeof params.amount === "number" ? params.amount : remaining
  if (amount <= 0 || amount > remaining)
    throw invalidRequest("Refund amount exceeds the unrefunded amount on this charge.", "amount")
  const txn = await postBalanceTransaction(state, {
    amount: -amount,
    available_on: now,
    created: now,
    currency: charge.currency,
    description: `Refund for ${charge.id}`,
    fee: 0,
    reporting_category: "refund",
    source: charge.id,
    status: "available",
    type: "refund",
  })
  const id = await state.ids.next("re_")
  const refund = {
    id,
    amount,
    balance_transaction: txn.id,
    charge: charge.id,
    created: now,
    currency: charge.currency,
    metadata: mergeMetadata({}, params.metadata),
    payment_intent: charge.payment_intent,
    reason: typeof params.reason === "string" ? params.reason : null,
    status: "succeeded" as const,
  }
  await state.refunds.insert(id, refund)
  charge.amount_refunded += amount
  charge.refunded = charge.amount_refunded >= charge.amount
  await state.charges.update(charge.id, charge)
  await recordEvent(state, "charge.refunded", await renderCharge(state, charge), now)
  await recordEvent(state, "refund.created", renderRefund(refund), now)
  return refund
}

const createConfirmationToken = async (state: StripeState, now: number, params: Params) => {
  let paymentMethod: string | null = null
  if (typeof params.payment_method === "string" && params.payment_method !== "") {
    const method =
      (await ensurePaymentMethod(state, params.payment_method, now)) ??
      (await loadMethod(state, params.payment_method))
    paymentMethod = method.id
  }
  const data = asRecord(params.payment_method_data)
  if (data) {
    const type = typeof data.type === "string" ? data.type : "card"
    const card =
      type === "card" ? await cardFromInput(state, data.card, "payment_method_data[card]") : null
    const method = await saveMethod(state, now, {
      type,
      card,
      billing: billingOf(data.billing_details),
      metadata: {},
      customer: null,
      allow: "unspecified",
    })
    paymentMethod = method.id
  }
  const id = await state.ids.next("ctoken_")
  let setupFutureUsage: "off_session" | "on_session" | null = null
  if (params.setup_future_usage === "off_session") setupFutureUsage = "off_session"
  else if (params.setup_future_usage === "on_session") setupFutureUsage = "on_session"
  const token = {
    id,
    created: now,
    expires_at: now + 12 * 60 * 60,
    payment_method: paymentMethod,
    return_url: typeof params.return_url === "string" ? params.return_url : null,
    setup_future_usage: setupFutureUsage,
    shipping: params.shipping === undefined ? null : shippingOf(params.shipping),
  }
  await state.confirmationTokens.insert(id, token)
  return token
}

export const createConfirmationTokenForElements = createConfirmationToken
