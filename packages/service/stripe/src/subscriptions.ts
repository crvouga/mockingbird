import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, parameterMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  changedFields,
  invoiceLineFromPrice,
  mergeRecordMetadata,
  openInvoice,
  type RequestScope,
  requestScope,
  requirePrice,
  type Services,
  subscriptionPeriod,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  priceOrId,
  renderCustomer,
  renderInvoice,
  renderSubscription,
  renderSubscriptionItem,
} from "./render.js"
import {
  type Metadata,
  type SubscriptionItemRecord,
  type SubscriptionRecord,
  seconds,
} from "./state.js"

const stringOf = (params: Params, key: string): string | null => {
  const value = params[key]
  return typeof value === "string" && value !== "" ? value : null
}

const numberList = (params: Params, key: string): string[] => {
  const value = params[key]
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string")
  if (typeof value === "string" && value !== "") return value.split(",")
  return []
}

const intOf = (value: unknown): number | undefined => {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined
}

/** `items[0][price]`, `items[0][quantity]`, … as decoded by the form codec. */
const requestedItems = (params: Params): Array<{ price: string; quantity: number }> => {
  const raw = params.items
  if (!Array.isArray(raw)) throw parameterMissing("items")
  const items: Array<{ price: string; quantity: number }> = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const price = typeof record.price === "string" ? record.price : null
    if (price === null || price === "") throw parameterMissing("items[0][price]")
    items.push({ price, quantity: intOf(record.quantity) ?? 1 })
  }
  if (items.length === 0) throw parameterMissing("items")
  return items
}

export type SubscriptionInput = {
  customer: string
  items: Array<{ price: string; quantity: number }>
  metadata: Metadata
  defaultPaymentMethod: string | null
  paymentBehavior: string | null
  trialEnd: number | null
  schedule?: string | null
  startDate?: number | undefined
}

/**
 * Create a subscription with its items and first invoice. Shared with checkout sessions creating a
 * `subscription`-mode session.
 */
export const createSubscriptionRecord = (
  scope: RequestScope,
  input: SubscriptionInput,
): SubscriptionRecord => {
  const priced = input.items.map((item) => ({ item, price: requirePrice(scope, item.price) }))
  const recurring = priced[0]?.price.recurring
  const period = recurring
    ? subscriptionPeriod(scope.now, recurring.interval, recurring.interval_count)
    : { start: seconds(scope.now), end: seconds(scope.now) + 2_592_000 }
  const start = input.startDate ?? period.start
  const id = scope.ids.next("sub_")
  const itemIds: string[] = []
  for (const entry of priced) {
    const itemId = scope.ids.next("si_")
    const record: SubscriptionItemRecord = {
      id: itemId,
      created: seconds(scope.now),
      metadata: {},
      price: entry.price.id,
      quantity: entry.item.quantity,
      subscription: id,
    }
    scope.account.subscriptionItems.insert(itemId, record)
    itemIds.push(itemId)
  }
  const record: SubscriptionRecord = {
    id,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    collection_method: "charge_automatically",
    created: seconds(scope.now),
    currency: priced[0]?.price.currency ?? "usd",
    customer: input.customer,
    current_period_end: period.end,
    current_period_start: start,
    days_until_due: null,
    default_payment_method: input.defaultPaymentMethod,
    discount_ids: [],
    ended_at: null,
    item_ids: itemIds,
    latest_invoice: null,
    metadata: input.metadata,
    pause_collection: null,
    schedule: input.schedule ?? null,
    start_date: start,
    status: input.paymentBehavior === "default_incomplete" ? "incomplete" : "active",
    trial_end: input.trialEnd,
    trial_start: input.trialEnd === null ? null : seconds(scope.now),
  }
  scope.account.subscriptions.insert(id, record)
  const invoice = openInvoice(scope, {
    billingReason: "subscription_create",
    customer: input.customer,
    lines: priced.map((entry) => invoiceLineFromPrice(scope, entry.price, entry.item.quantity)),
    period,
    subscription: id,
  })
  const withInvoice: SubscriptionRecord = { ...record, latest_invoice: invoice.id }
  scope.account.subscriptions.update(id, withInvoice)
  scope.emit("customer.subscription.created", renderSubscription(withInvoice, scope.account))
  return withInvoice
}

const renderItems = (scope: RequestScope, subscription: SubscriptionRecord) =>
  subscription.item_ids
    .map((id) => scope.account.subscriptionItems.get(id))
    .filter((record): record is SubscriptionItemRecord => record !== undefined)
    .map((record) => renderSubscriptionItem(record, scope.account))

export const subscriptionHandlers = (services: Services): Record<string, OperationHandler> => {
  const expanders = (scope: RequestScope): ExpandResolvers => ({
    discounts: (id) => {
      const discount = scope.account.discounts.get(id)
      return discount ? { id: discount.id, coupon: discount.coupon } : undefined
    },
    latest_invoice: (id) => {
      const invoice = scope.account.invoices.get(id)
      return invoice ? renderInvoice(invoice, scope.account) : undefined
    },
    default_payment_method: (id) => scope.account.paymentMethods.get(id),
    customer: (id) => {
      const entry = scope.account.customers.get(id)
      return entry?.kind === "live" ? renderCustomer(entry.customer) : undefined
    },
    schedule: (id) => scope.account.subscriptionSchedules.get(id),
    price: (id) => priceOrId(scope.account, id),
  })

  const render = (scope: RequestScope, record: SubscriptionRecord, params: Params) => {
    const rendered = {
      ...renderSubscription(record, scope.account),
      items: {
        object: "list",
        data: renderItems(scope, record),
        has_more: false,
        url: `/v1/subscription_items?subscription=${record.id}`,
      },
    }
    return applyExpand(rendered, params.expand, expanders(scope))
  }

  const requireSubscription = (scope: RequestScope, id: string) => {
    const record = scope.account.subscriptions.get(id)
    if (!record)
      throw invalidRequest(
        `No such subscription: '${id}'`,
        "subscription_exposed_id",
        "resource_missing",
      )
    return record
  }

  return {
    GetSubscriptions: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const customer = stringOf(params, "customer")
      const statuses = numberList(params, "status")
      return jsonResponse(
        200,
        await paginate<SubscriptionRecord>(scope.account.subscriptions, params, {
          url: "/v1/subscriptions",
          kind: "subscription",
          where: (record) =>
            matchesCreated(record.created, params.created) &&
            (customer === null || record.customer === customer) &&
            (statuses.length === 0 || statuses.includes("all") || statuses.includes(record.status)),
          render: (record) => render(scope, record, params),
        }),
      )
    },
    PostSubscriptions: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const customer = stringOf(params, "customer")
      if (customer === null) throw parameterMissing("customer")
      const entry = scope.account.customers.get(customer)
      if (!entry || entry.kind === "deleted")
        throw invalidRequest(`No such customer: '${customer}'`, "customer", "resource_missing")
      const record = createSubscriptionRecord(scope, {
        customer,
        defaultPaymentMethod: stringOf(params, "default_payment_method"),
        items: requestedItems(params),
        metadata: (params.metadata as Record<string, string> | undefined) ?? {},
        paymentBehavior: stringOf(params, "payment_behavior"),
        trialEnd: intOf(params.trial_end) ?? null,
        startDate: intOf(params.backdate_start_date),
      })
      return jsonResponse(200, render(scope, record, params))
    },
    GetSubscriptionsSubscriptionExposedId: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      return jsonResponse(
        200,
        render(
          scope,
          requireSubscription(scope, context.params.subscription_exposed_id ?? ""),
          params,
        ),
      )
    },
    PostSubscriptionsSubscriptionExposedId: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireSubscription(scope, context.params.subscription_exposed_id ?? "")
      const items = params.items === undefined ? undefined : requestedItems(params)
      const next: SubscriptionRecord = {
        ...current,
        cancel_at_period_end:
          params.cancel_at_period_end === undefined
            ? current.cancel_at_period_end
            : params.cancel_at_period_end === true || params.cancel_at_period_end === "true",
        default_payment_method:
          stringOf(params, "default_payment_method") ?? current.default_payment_method,
        metadata: mergeRecordMetadata(current.metadata, params.metadata),
        trial_end: intOf(params.trial_end) ?? current.trial_end,
      }
      scope.account.subscriptions.update(next.id, next)
      if (items) {
        for (const entry of items) {
          const price = requirePrice(scope, entry.price)
          const itemId = current.item_ids[0] ?? scope.ids.next("si_")
          scope.account.subscriptionItems.update(itemId, {
            id: itemId,
            created: seconds(scope.now),
            metadata: {},
            price: price.id,
            quantity: entry.quantity,
            subscription: current.id,
          })
        }
      }
      const previous = changedFields(
        current as unknown as Record<string, unknown>,
        next as unknown as Record<string, unknown>,
      )
      scope.emit("customer.subscription.updated", renderSubscription(next, scope.account), previous)
      return jsonResponse(200, render(scope, next, params))
    },
    DeleteSubscriptionsSubscriptionExposedId: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireSubscription(scope, context.params.subscription_exposed_id ?? "")
      const next: SubscriptionRecord = {
        ...current,
        cancel_at_period_end: false,
        canceled_at: seconds(scope.now),
        ended_at: seconds(scope.now),
        status: "canceled",
      }
      scope.account.subscriptions.update(next.id, next)
      scope.emit("customer.subscription.deleted", renderSubscription(next, scope.account))
      return jsonResponse(200, render(scope, next, params))
    },
    GetSubscriptionItems: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const subscription = stringOf(params, "subscription")
      return jsonResponse(
        200,
        await paginate<SubscriptionItemRecord>(scope.account.subscriptionItems, params, {
          url: "/v1/subscription_items",
          kind: "subscription_item",
          where: (record) => subscription === null || record.subscription === subscription,
          render: (record) => renderSubscriptionItem(record, scope.account),
        }),
      )
    },
    GetSubscriptionItemsItem: async (context) => {
      const scope = requestScope(services, context)
      queryParams(context)
      const id = context.params.item ?? ""
      const record = scope.account.subscriptionItems.get(id)
      if (!record)
        throw invalidRequest(`No such subscription_item: '${id}'`, "item", "resource_missing")
      return jsonResponse(200, renderSubscriptionItem(record, scope.account))
    },
  }
}
