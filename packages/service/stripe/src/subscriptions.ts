import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import {
  applyDiscountRequests,
  cancelSubscription,
  createDraftInvoice,
  createSubscription,
  cycleSubscription,
  finalizeInvoice,
  lineFromPrice,
  parseDiscounts,
  payInvoice,
  saveSubscription,
  subscriptionItems,
} from "./billing.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import {
  booleanOf,
  customerNow,
  intOf,
  mergeRecordMetadata,
  type RequestScope,
  recordOf,
  requestScope,
  requirePrice,
  type Services,
  stringOf,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import {
  renderDeletedSubscriptionItem,
  renderSubscription,
  renderSubscriptionItem,
} from "./render.js"
import { type SubscriptionItemRecord, type SubscriptionRecord, seconds } from "./state.js"

const listOf = (params: Params, key: string): string[] => {
  const value = params[key]
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string")
  if (typeof value === "string" && value !== "") return value.split(",")
  return []
}

type ItemRequest = {
  id: string | null
  price: string | null
  quantity: number | undefined
  deleted: boolean
  metadata: Record<string, string> | undefined
}

/** `items[0][price]`, `items[0][id]`, `items[0][quantity]`, `items[0][deleted]`. */
const requestedItems = (params: Params): ItemRequest[] => {
  const raw = params.items
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => recordOf(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      id: typeof entry.id === "string" && entry.id !== "" ? entry.id : null,
      price: typeof entry.price === "string" && entry.price !== "" ? entry.price : null,
      quantity: intOf(entry.quantity),
      deleted: booleanOf(entry.deleted) === true,
      metadata: recordOf(entry.metadata) as Record<string, string> | undefined,
    }))
}

const requireSubscriptionRecord = (scope: RequestScope, id: string) => {
  const record = scope.account.subscriptions.get(id)
  if (!record) throw resourceMissing("subscription", id, "id")
  return record
}

/**
 * Change a subscription's items. `proration_behavior=none` just swaps prices;
 * `always_invoice` bills the difference for the rest of the period now; the default
 * (`create_prorations`) leaves the difference as pending proration items for the next invoice.
 */
const changeItems = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  requests: ItemRequest[],
  proration: string,
): { itemIds: string[]; prorationAmount: number } => {
  const existing = subscriptionItems(scope, subscription)
  const itemIds = [...subscription.item_ids]
  let prorationAmount = 0
  const now = customerNow(scope, subscription.customer)
  const span = Math.max(1, subscription.current_period_end - subscription.current_period_start)
  const left = Math.max(0, subscription.current_period_end - now) / span
  const amountOf = (priceId: string, quantity: number) =>
    Math.round(Number(requirePrice(scope, priceId).unit_amount_decimal) * quantity)
  requests.forEach((request, index) => {
    const current =
      request.id === null ? undefined : existing.find((item) => item.id === request.id)
    if (request.id !== null && current === undefined)
      throw resourceMissing("subscription_item", request.id, `items[${index}][id]`)
    if (current && request.deleted) {
      prorationAmount -= Math.round(amountOf(current.price, current.quantity ?? 1) * left)
      scope.account.subscriptionItems.delete(current.id)
      itemIds.splice(itemIds.indexOf(current.id), 1)
      return
    }
    if (current) {
      const price = request.price ?? current.price
      requirePrice(scope, price, `items[${index}][price]`)
      const quantity = request.quantity ?? current.quantity ?? 1
      prorationAmount += Math.round(
        (amountOf(price, quantity) - amountOf(current.price, current.quantity ?? 1)) * left,
      )
      scope.account.subscriptionItems.update(current.id, {
        ...current,
        price,
        quantity,
        metadata: request.metadata ?? current.metadata,
      })
      return
    }
    if (request.price === null) throw parameterMissing(`items[${index}][price]`)
    const price = requirePrice(scope, request.price, `items[${index}][price]`)
    const itemId = scope.ids.next("si_", 14)
    const record: SubscriptionItemRecord = {
      id: itemId,
      created: now,
      metadata: request.metadata ?? {},
      price: price.id,
      quantity: request.quantity ?? 1,
      subscription: subscription.id,
      discount_ids: [],
    }
    scope.account.subscriptionItems.insert(itemId, record)
    itemIds.push(itemId)
    prorationAmount += Math.round(amountOf(price.id, record.quantity ?? 1) * left)
  })
  if (proration === "none") prorationAmount = 0
  return { itemIds, prorationAmount }
}

export const subscriptionHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (scope: RequestScope, record: SubscriptionRecord) =>
    renderSubscription(record, scope.account)

  return {
    GetSubscriptions: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const customer = stringOf(params, "customer")
      if (customer !== null && !scope.account.customers.get(customer))
        throw resourceMissing("customer", customer, "customer", 400)
      const price = stringOf(params, "price")
      if (price !== null && !scope.account.prices.get(price))
        throw resourceMissing("price", price, "price", 400)
      const clock = stringOf(params, "test_clock")
      if (clock !== null && !scope.account.testClocks.get(clock))
        throw resourceMissing("billingclock", clock, "test_clock", 400)
      const statuses = listOf(params, "status")
      const visible = (record: SubscriptionRecord) =>
        statuses.length === 0
          ? record.status !== "canceled"
          : statuses.includes("all") ||
            statuses.includes(record.status) ||
            (statuses.includes("ended") &&
              ["canceled", "incomplete_expired"].includes(record.status))
      return jsonResponse(
        200,
        await paginate<SubscriptionRecord>(scope.account.subscriptions, params, {
          url: "/v1/subscriptions",
          kind: "subscription",
          where: (record) =>
            matchesCreated(record.created, params.created) &&
            (customer === null || record.customer === customer) &&
            (price === null ||
              subscriptionItems(scope, record).some((item) => item.price === price)) &&
            visible(record),
          render: (record) => render(scope, record),
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
      const items = requestedItems(params)
      if (items.length === 0) throw parameterMissing("items")
      const discounts = parseDiscounts(params.discounts)
      const addInvoiceItems = Array.isArray(params.add_invoice_items)
        ? params.add_invoice_items
            .map((entry) => recordOf(entry))
            .filter((entry): entry is Record<string, unknown> => typeof entry?.price === "string")
            .map((entry) => ({
              price: entry.price as string,
              quantity: intOf(entry.quantity) ?? 1,
            }))
        : []
      const defaultMethod = stringOf(params, "default_payment_method")
      if (defaultMethod !== null && !scope.account.paymentMethods.get(defaultMethod))
        throw resourceMissing("PaymentMethod", defaultMethod, "default_payment_method")
      const { subscription } = createSubscription(scope, {
        customer,
        items: items.map((item, index) => {
          if (item.price === null) throw parameterMissing(`items[${index}][price]`)
          return { price: item.price, quantity: item.quantity ?? 1, metadata: item.metadata ?? {} }
        }),
        metadata: (params.metadata as Record<string, string> | undefined) ?? {},
        defaultPaymentMethod: defaultMethod,
        paymentBehavior: stringOf(params, "payment_behavior"),
        trialEnd: params.trial_end === "now" ? "now" : (intOf(params.trial_end) ?? null),
        trialPeriodDays: intOf(params.trial_period_days) ?? null,
        ...(intOf(params.backdate_start_date) === undefined
          ? {}
          : { backdateStartDate: intOf(params.backdate_start_date) }),
        ...(intOf(params.billing_cycle_anchor) === undefined
          ? {}
          : { billingCycleAnchor: intOf(params.billing_cycle_anchor) }),
        prorationBehavior: stringOf(params, "proration_behavior"),
        ...(discounts === undefined || discounts === "clear" ? {} : { discounts }),
        addInvoiceItems,
        paymentSettings: recordOf(params.payment_settings) ?? null,
        collectionMethod:
          stringOf(params, "collection_method") === "send_invoice"
            ? "send_invoice"
            : "charge_automatically",
        daysUntilDue: intOf(params.days_until_due) ?? null,
        offSession: booleanOf(params.off_session) === true,
        cancelAtPeriodEnd: booleanOf(params.cancel_at_period_end) === true,
      })
      return jsonResponse(200, render(scope, subscription))
    },
    GetSubscriptionsSubscriptionExposedId: async (context) => {
      const scope = requestScope(services, context)
      queryParams(context)
      return jsonResponse(
        200,
        render(
          scope,
          requireSubscriptionRecord(scope, context.params.subscription_exposed_id ?? ""),
        ),
      )
    },
    PostSubscriptionsSubscriptionExposedId: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const current = requireSubscriptionRecord(scope, context.params.subscription_exposed_id ?? "")
      if (current.status === "canceled" || current.status === "incomplete_expired") {
        const onlyMetadata = Object.keys(params).every((key) =>
          ["metadata", "cancellation_details", "expand"].includes(key),
        )
        if (!onlyMetadata)
          throw invalidRequest(
            "A canceled subscription can only update its cancellation_details and metadata.",
          )
      }
      const previousItems = { items: renderSubscription(current, scope.account).items }
      const proration = stringOf(params, "proration_behavior") ?? "create_prorations"
      const itemRequests = requestedItems(params)
      const { itemIds, prorationAmount } =
        itemRequests.length === 0
          ? { itemIds: current.item_ids, prorationAmount: 0 }
          : changeItems(scope, current, itemRequests, proration)
      const now = customerNow(scope, current.customer)
      const cancelAtPeriodEnd = booleanOf(params.cancel_at_period_end)
      const discounts = parseDiscounts(params.discounts)
      const discountIds =
        discounts === undefined
          ? current.discount_ids
          : discounts === "clear"
            ? []
            : applyDiscountRequests(
                scope,
                discounts,
                { customer: current.customer, subscription: current.id },
                current.discount_ids,
              )
      let next: SubscriptionRecord = {
        ...current,
        item_ids: itemIds,
        discount_ids: discountIds,
        default_payment_method:
          params.default_payment_method === ""
            ? null
            : (stringOf(params, "default_payment_method") ?? current.default_payment_method),
        metadata: mergeRecordMetadata(current.metadata, params.metadata),
        payment_settings: recordOf(params.payment_settings) ?? current.payment_settings ?? null,
      }
      if (cancelAtPeriodEnd !== undefined) {
        next = {
          ...next,
          cancel_at_period_end: cancelAtPeriodEnd,
          cancel_at: cancelAtPeriodEnd ? current.current_period_end : null,
          canceled_at: cancelAtPeriodEnd ? now : null,
          cancellation_details: {
            comment: null,
            feedback: null,
            reason: cancelAtPeriodEnd ? "cancellation_requested" : null,
          },
        }
      }
      if (params.cancel_at !== undefined) {
        const at = intOf(params.cancel_at)
        next = { ...next, cancel_at: at ?? null, canceled_at: at === undefined ? null : now }
      }
      const trialEnd = params.trial_end
      const endTrialNow = trialEnd === "now" && current.status === "trialing"
      if (typeof trialEnd === "number" || (typeof trialEnd === "string" && /^\d+$/.test(trialEnd)))
        next = { ...next, trial_end: Number(trialEnd), current_period_end: Number(trialEnd) }
      saveSubscription(scope, current, next, previousItems)
      if (prorationAmount !== 0 && proration === "always_invoice") {
        const period = { start: now, end: current.current_period_end }
        const firstItem = scope.account.subscriptionItems.get(itemIds[0] ?? "")
        const price = requirePrice(scope, firstItem?.price ?? "")
        const line = {
          ...lineFromPrice(scope, price, 1, period, {
            subscription: current.id,
            subscriptionItem: firstItem?.id ?? null,
            amount: prorationAmount,
            description: "Remaining time on the new price (prorated)",
          }),
          proration: true,
        }
        const invoice = finalizeInvoice(
          scope,
          createDraftInvoice(scope, {
            customer: current.customer,
            subscription: current.id,
            lines: [line],
            billingReason: "subscription_update",
            period,
            subscriptionMetadata: next.metadata,
          }),
        )
        let settled = invoice
        if (invoice.status === "open") {
          try {
            settled = payInvoice(scope, invoice, { offSession: true })
          } catch (error) {
            if (
              !(error instanceof StripeError) ||
              stringOf(params, "payment_behavior") === "error_if_incomplete"
            )
              throw error
            settled = scope.account.invoices.get(invoice.id) ?? invoice
          }
        }
        const latest = scope.account.subscriptions.get(current.id) ?? next
        saveSubscription(scope, latest, { ...latest, latest_invoice: settled.id })
      } else if (prorationAmount !== 0 && proration === "create_prorations") {
        const itemId = scope.ids.next("ii_", 24)
        scope.account.invoiceItems.insert(itemId, {
          id: itemId,
          amount: prorationAmount,
          created: seconds(scope.now),
          currency: current.currency,
          customer: current.customer,
          date: now,
          description: "Proration for subscription change",
          discountable: false,
          invoice: null,
          metadata: {},
          period: { start: now, end: current.current_period_end },
          price: null,
          proration: true,
          quantity: 1,
          unit_amount: prorationAmount,
        })
      }
      if (endTrialNow) {
        const trialing = scope.account.subscriptions.get(current.id) ?? next
        const ended = { ...trialing, trial_end: now, current_period_end: now }
        scope.account.subscriptions.update(current.id, ended)
        cycleSubscription(scope, ended)
      }
      return jsonResponse(200, render(scope, scope.account.subscriptions.get(current.id) ?? next))
    },
    DeleteSubscriptionsSubscriptionExposedId: async (context) => {
      const scope = requestScope(services, context)
      bodyParams(context)
      const current = requireSubscriptionRecord(scope, context.params.subscription_exposed_id ?? "")
      if (current.status === "canceled")
        throw invalidRequest(
          `No such subscription: '${current.id}'`,
          "subscription_exposed_id",
          "resource_missing",
        )
      return jsonResponse(200, render(scope, cancelSubscription(scope, current)))
    },
    GetSubscriptionItems: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const subscription = stringOf(params, "subscription")
      if (subscription === null) throw parameterMissing("subscription")
      return jsonResponse(
        200,
        await paginate<SubscriptionItemRecord>(scope.account.subscriptionItems, params, {
          url: "/v1/subscription_items",
          kind: "subscription_item",
          where: (record) => record.subscription === subscription,
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
        throw new StripeError({ status: 404, message: `Invalid subscription_item id: ${id}` })
      return jsonResponse(200, renderSubscriptionItem(record, scope.account))
    },
    PostSubscriptionItems: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const subscriptionId = stringOf(params, "subscription")
      if (subscriptionId === null) throw parameterMissing("subscription")
      const current = requireSubscriptionRecord(scope, subscriptionId)
      const price = stringOf(params, "price")
      if (price === null) throw parameterMissing("price")
      const { itemIds } = changeItems(
        scope,
        current,
        [
          {
            id: null,
            price,
            quantity: intOf(params.quantity),
            deleted: false,
            metadata: params.metadata as Record<string, string> | undefined,
          },
        ],
        stringOf(params, "proration_behavior") ?? "create_prorations",
      )
      const previousItems = { items: renderSubscription(current, scope.account).items }
      saveSubscription(scope, current, { ...current, item_ids: itemIds }, previousItems)
      const created = scope.account.subscriptionItems.get(itemIds[itemIds.length - 1] ?? "")
      if (!created) throw resourceMissing("subscription_item", "", "item")
      return jsonResponse(200, renderSubscriptionItem(created, scope.account))
    },
    PostSubscriptionItemsItem: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const id = context.params.item ?? ""
      const item = scope.account.subscriptionItems.get(id)
      if (!item)
        throw new StripeError({ status: 404, message: `Invalid subscription_item id: ${id}` })
      const current = requireSubscriptionRecord(scope, item.subscription)
      const previousItems = { items: renderSubscription(current, scope.account).items }
      changeItems(
        scope,
        current,
        [
          {
            id,
            price: stringOf(params, "price"),
            quantity: intOf(params.quantity),
            deleted: false,
            metadata:
              params.metadata === undefined
                ? undefined
                : mergeRecordMetadata(item.metadata, params.metadata),
          },
        ],
        stringOf(params, "proration_behavior") ?? "create_prorations",
      )
      saveSubscription(scope, current, { ...current }, previousItems)
      const updated = scope.account.subscriptionItems.get(id) ?? item
      return jsonResponse(200, renderSubscriptionItem(updated, scope.account))
    },
    DeleteSubscriptionItemsItem: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const id = context.params.item ?? ""
      const item = scope.account.subscriptionItems.get(id)
      if (!item)
        throw new StripeError({ status: 404, message: `Invalid subscription_item id: ${id}` })
      const current = requireSubscriptionRecord(scope, item.subscription)
      if (current.item_ids.length <= 1)
        throw invalidRequest(
          "A subscription must have at least one active plan. To cancel a subscription, please use the cancel API endpoint on /v1/subscriptions.",
        )
      const previousItems = { items: renderSubscription(current, scope.account).items }
      const { itemIds } = changeItems(
        scope,
        current,
        [{ id, price: null, quantity: undefined, deleted: true, metadata: undefined }],
        stringOf(params, "proration_behavior") ?? "create_prorations",
      )
      saveSubscription(scope, current, { ...current, item_ids: itemIds }, previousItems)
      return jsonResponse(200, renderDeletedSubscriptionItem(id))
    },
  }
}
