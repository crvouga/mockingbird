import { jsonResponse, type OperationContext, opaqueToken } from "@crvouga/mockingbird-service"
import { invalidRequest, parameterMissing, resourceMissing } from "./errors.js"
import { STRIPE_VERSION } from "./events.js"
import { mergeMetadata } from "./fields.js"
import { postBalanceTransaction } from "./ledger.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, queryParams } from "./params.js"
import { normalizeCurrency } from "./prices.js"
import { type StripeState, seconds } from "./state.js"
import { validateUrl } from "./url.js"

const ACCOUNT_ID = "acct_mockingbird"

const renderEvent = (event: {
  id: string
  api_version: string
  created: number
  data: { object: Record<string, unknown> }
  pending_webhooks: number
  request: { id: string | null; idempotency_key: string | null }
  type: string
}) => ({
  id: event.id,
  object: "event",
  api_version: event.api_version,
  created: event.created,
  data: event.data,
  livemode: false,
  pending_webhooks: event.pending_webhooks,
  request: event.request,
  type: event.type,
})

const available = async (state: StripeState) => {
  const txns = await state.balanceTransactions.list()
  const byCurrency = new Map<string, number>()
  for (const txn of txns) {
    byCurrency.set(txn.value.currency, (byCurrency.get(txn.value.currency) ?? 0) + txn.value.net)
  }
  if (byCurrency.size === 0) byCurrency.set("usd", 0)
  return [...byCurrency.entries()].map(([currency, amount]) => ({
    amount,
    currency,
    source_types: { card: amount },
  }))
}

export const platformHandlers = (state: StripeState) => ({
  GetAccount: async (context: OperationContext) => {
    queryParams(context)
    return jsonResponse(200, {
      id: ACCOUNT_ID,
      object: "account",
      charges_enabled: true,
      country: "US",
      default_currency: "usd",
      details_submitted: true,
      email: "mockingbird@example.com",
      payouts_enabled: true,
      type: "standard",
    })
  },

  GetBalance: async (context: OperationContext) => {
    queryParams(context)
    const amounts = await available(state)
    return jsonResponse(200, {
      object: "balance",
      livemode: false,
      available: amounts,
      pending: amounts.map((entry) => ({ ...entry, amount: 0, source_types: { card: 0 } })),
    })
  },

  GetBalanceTransactions: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.balanceTransactions, params, {
      url: "/v1/balance_transactions",
      kind: "balance_transaction",
      where: (txn) =>
        matchesCreated(txn.created, params.created) &&
        (params.type === undefined || params.type === "" || txn.type === params.type),
      render: (txn) => ({
        id: txn.id,
        object: "balance_transaction",
        amount: txn.amount,
        available_on: txn.available_on,
        balance_type: "payments",
        created: txn.created,
        currency: txn.currency,
        description: txn.description,
        fee: txn.fee,
        fee_details: [],
        net: txn.net,
        reporting_category: txn.reporting_category,
        source: txn.source,
        status: txn.status,
        type: txn.type,
      }),
    })
    return jsonResponse(200, page)
  },

  GetBalanceTransactionsId: async (context: OperationContext) => {
    const txn = await state.balanceTransactions.get(context.params.id ?? "")
    if (!txn) throw resourceMissing("balance_transaction", context.params.id ?? "", "id")
    return jsonResponse(200, {
      id: txn.id,
      object: "balance_transaction",
      amount: txn.amount,
      available_on: txn.available_on,
      balance_type: "payments",
      created: txn.created,
      currency: txn.currency,
      description: txn.description,
      fee: txn.fee,
      fee_details: [],
      net: txn.net,
      reporting_category: txn.reporting_category,
      source: txn.source,
      status: txn.status,
      type: txn.type,
    })
  },

  GetEvents: async (context: OperationContext) => {
    const params = queryParams(context)
    const types = Array.isArray(params.types) ? (params.types as string[]) : undefined
    const page = await paginate(state.events, params, {
      url: "/v1/events",
      kind: "event",
      where: (event) =>
        matchesCreated(event.created, params.created) &&
        (params.type === undefined || params.type === "" || event.type === params.type) &&
        (types === undefined || types.includes(event.type)),
      render: renderEvent,
    })
    return jsonResponse(200, page)
  },

  GetEventsId: async (context: OperationContext) => {
    const event = await state.events.get(context.params.id ?? "")
    if (!event) throw resourceMissing("event", context.params.id ?? "", "id")
    return jsonResponse(200, renderEvent(event))
  },

  PostWebhookEndpoints: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (!Array.isArray(params.enabled_events) || params.enabled_events.length === 0)
      throw parameterMissing("enabled_events")
    if (typeof params.url !== "string" || params.url === "") throw parameterMissing("url")
    validateUrl(params.url, "url")
    const id = await state.ids.next("we_")
    const endpoint = {
      id,
      api_version: typeof params.api_version === "string" ? params.api_version : STRIPE_VERSION,
      created: now,
      description: typeof params.description === "string" ? params.description : null,
      enabled_events: params.enabled_events as string[],
      metadata: mergeMetadata({}, params.metadata),
      secret: `whsec_${opaqueToken(`whsec:${id}`, 32)}`,
      status: "enabled" as const,
      url: params.url,
    }
    await state.webhookEndpoints.insert(id, endpoint)
    return jsonResponse(200, renderEndpoint(endpoint, true))
  },

  GetWebhookEndpoints: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.webhookEndpoints, params, {
      url: "/v1/webhook_endpoints",
      kind: "webhook_endpoint",
      where: () => true,
      render: (endpoint) => renderEndpoint(endpoint, false),
    })
    return jsonResponse(200, page)
  },

  GetWebhookEndpointsWebhookEndpoint: async (context: OperationContext) => {
    const endpoint = await state.webhookEndpoints.get(context.params.webhook_endpoint ?? "")
    if (!endpoint)
      throw resourceMissing(
        "webhook_endpoint",
        context.params.webhook_endpoint ?? "",
        "webhook_endpoint",
      )
    return jsonResponse(200, renderEndpoint(endpoint, false))
  },

  PostWebhookEndpointsWebhookEndpoint: async (context: OperationContext) => {
    const params = bodyParams(context)
    const endpoint = await state.webhookEndpoints.get(context.params.webhook_endpoint ?? "")
    if (!endpoint)
      throw resourceMissing(
        "webhook_endpoint",
        context.params.webhook_endpoint ?? "",
        "webhook_endpoint",
      )
    if (typeof params.url === "string" && params.url !== "") {
      validateUrl(params.url, "url")
      endpoint.url = params.url
    }
    if (Array.isArray(params.enabled_events))
      endpoint.enabled_events = params.enabled_events as string[]
    if (typeof params.disabled === "boolean")
      endpoint.status = params.disabled ? "disabled" : "enabled"
    if (typeof params.description === "string") endpoint.description = params.description || null
    endpoint.metadata = mergeMetadata(endpoint.metadata, params.metadata)
    await state.webhookEndpoints.update(endpoint.id, endpoint)
    return jsonResponse(200, renderEndpoint(endpoint, false))
  },

  DeleteWebhookEndpointsWebhookEndpoint: async (context: OperationContext) => {
    const id = context.params.webhook_endpoint ?? ""
    if (!(await state.webhookEndpoints.get(id)))
      throw resourceMissing("webhook_endpoint", id, "webhook_endpoint")
    await state.webhookEndpoints.delete(id)
    return jsonResponse(200, { id, object: "webhook_endpoint", deleted: true })
  },

  PostPayouts: async (context: OperationContext) => {
    const params = bodyParams(context)
    const now = seconds(context.now)
    if (typeof params.amount !== "number") throw parameterMissing("amount")
    if (typeof params.currency !== "string") throw parameterMissing("currency")
    const currency = normalizeCurrency(params.currency)
    const balances = await available(state)
    const funds = balances.find((entry) => entry.currency === currency)?.amount ?? 0
    if (params.amount > funds)
      throw invalidRequest(
        "You have insufficient funds in your Stripe account for this payout.",
        "amount",
      )
    const id = await state.ids.next("po_")
    await postBalanceTransaction(state, {
      amount: -params.amount,
      available_on: now,
      created: now,
      currency,
      description: `Payout ${id}`,
      fee: 0,
      reporting_category: "payout",
      source: id,
      status: "available",
      type: "payout",
    })
    const payout = {
      id,
      amount: params.amount,
      arrival_date: now,
      created: now,
      currency,
      description: typeof params.description === "string" ? params.description : null,
      metadata: mergeMetadata({}, params.metadata),
      method: params.method === "instant" ? ("instant" as const) : ("standard" as const),
      statement_descriptor:
        typeof params.statement_descriptor === "string" ? params.statement_descriptor : null,
      status: "paid" as const,
      type: "bank_account" as const,
    }
    await state.payouts.insert(id, payout)
    return jsonResponse(200, renderPayout(payout))
  },

  GetPayouts: async (context: OperationContext) => {
    const params = queryParams(context)
    const page = await paginate(state.payouts, params, {
      url: "/v1/payouts",
      kind: "payout",
      where: (payout) =>
        params.status === undefined || params.status === "" || payout.status === params.status,
      render: renderPayout,
    })
    return jsonResponse(200, page)
  },

  GetPayoutsPayout: async (context: OperationContext) => {
    const payout = await state.payouts.get(context.params.payout ?? "")
    if (!payout) throw resourceMissing("payout", context.params.payout ?? "", "payout")
    return jsonResponse(200, renderPayout(payout))
  },

  PostPayoutsPayout: async (context: OperationContext) => {
    const params = bodyParams(context)
    const payout = await state.payouts.get(context.params.payout ?? "")
    if (!payout) throw resourceMissing("payout", context.params.payout ?? "", "payout")
    payout.metadata = mergeMetadata(payout.metadata, params.metadata)
    await state.payouts.update(payout.id, payout)
    return jsonResponse(200, renderPayout(payout))
  },

  PostPayoutsPayoutCancel: async (context: OperationContext) => {
    const payout = await state.payouts.get(context.params.payout ?? "")
    if (!payout) throw resourceMissing("payout", context.params.payout ?? "", "payout")
    if (payout.status === "paid")
      throw invalidRequest(
        "This payout cannot be canceled because it has already been paid.",
        "payout",
      )
    payout.status = "canceled"
    await state.payouts.update(payout.id, payout)
    return jsonResponse(200, renderPayout(payout))
  },

  GetDisputes: async (context: OperationContext) => {
    const params = queryParams(context)
    return jsonResponse(200, {
      object: "list",
      data: [],
      has_more: false,
      url: "/v1/disputes",
      ...(params.limit === undefined ? {} : {}),
    })
  },

  GetDisputesDispute: async (context: OperationContext) => {
    throw resourceMissing("dispute", context.params.dispute ?? "", "dispute")
  },
})

const renderEndpoint = (
  endpoint: {
    id: string
    api_version: string | null
    created: number
    description: string | null
    enabled_events: string[]
    metadata: Record<string, string>
    secret: string
    status: string
    url: string
  },
  includeSecret: boolean,
) => ({
  id: endpoint.id,
  object: "webhook_endpoint",
  api_version: endpoint.api_version,
  created: endpoint.created,
  description: endpoint.description,
  enabled_events: endpoint.enabled_events,
  livemode: false,
  metadata: endpoint.metadata,
  status: endpoint.status,
  url: endpoint.url,
  ...(includeSecret ? { secret: endpoint.secret } : {}),
})

const renderPayout = (payout: {
  id: string
  amount: number
  arrival_date: number
  created: number
  currency: string
  description: string | null
  metadata: Record<string, string>
  method: string
  statement_descriptor: string | null
  status: string
  type: string
}) => ({
  id: payout.id,
  object: "payout",
  amount: payout.amount,
  arrival_date: payout.arrival_date,
  automatic: false,
  created: payout.created,
  currency: payout.currency,
  description: payout.description,
  livemode: false,
  metadata: payout.metadata,
  method: payout.method,
  reconciliation_status: "not_applicable",
  source_type: "card",
  statement_descriptor: payout.statement_descriptor,
  status: payout.status,
  type: payout.type,
})
