import type { OperationContext } from "@crvouga/mockingbird-service"
import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import {
  addInterval,
  addSubscriptionInvoiceItems,
  applyDiscountRequests,
  assertCompatiblePrices,
  billProration,
  cancelSubscription,
  createSubscription,
  cycleSubscription,
  type DiscountRequest,
  discountsRemoved,
  discountsReplaced,
  INACTIVE_PRICE,
  invoiceBillingCycleReset,
  parseAddInvoiceItems,
  parseDiscounts,
  recurringOf,
  renderDeletedDiscount,
  resolveDiscountSource,
  resumeSubscription,
  sameBillingPeriod,
  saveSubscription,
  subscriptionItems,
} from "./billing.js"
import {
  invalidRequest,
  parameterInvalidEmpty,
  parameterMissing,
  resourceMissing,
  StripeError,
} from "./errors.js"
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
import { bodyParams, deleteParams, type Params, queryParams, removedParam } from "./params.js"
import {
  renderDeletedSubscriptionItem,
  renderSubscription,
  renderSubscriptionItem,
} from "./render.js"
import type {
  PauseCollection,
  SubscriptionItemRecord,
  SubscriptionRecord,
  TrialEndBehavior,
} from "./state.js"
import { REQUEST_CHANGES } from "./version.js"

/**
 * The singular `coupon` / `promotion_code` (customers and subscriptions, before 2025-03-31.basil):
 * one discount in place of `discounts`, `""` removing it. Refused with `parameter_unknown` from
 * basil on. Validated here so a bad one names the parameter the caller sent.
 */
export const singularDiscount = (
  scope: RequestScope,
  context: OperationContext,
  params: Params,
): DiscountRequest[] | "clear" | undefined => {
  const removedAt = REQUEST_CHANGES.singularDiscountRemoved
  const coupon = removedParam(context, params.coupon, "coupon", removedAt)
  const promotion = removedParam(context, params.promotion_code, "promotion_code", removedAt)
  if (coupon === undefined && promotion === undefined) return undefined
  const param = coupon === undefined ? "promotion_code" : "coupon"
  if (params.discounts !== undefined)
    throw invalidRequest(
      `You may only specify one of these parameters: ${param}, discounts.`,
      param,
    )
  if (coupon !== undefined && promotion !== undefined && coupon !== "" && promotion !== "")
    throw invalidRequest(
      "You may only specify one of these parameters: coupon, promotion_code.",
      "coupon",
    )
  const request: DiscountRequest | undefined =
    typeof promotion === "string" && promotion !== ""
      ? { promotion_code: promotion }
      : typeof coupon === "string" && coupon !== ""
        ? { coupon }
        : undefined
  if (request === undefined) return "clear"
  const named = request.promotion_code === undefined ? "coupon" : "promotion_code"
  try {
    resolveDiscountSource(scope, request, "singular")
  } catch (error) {
    if (error instanceof StripeError) throw new StripeError({ ...error.init, param: named })
    throw error
  }
  return [request]
}

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

const FUTURE_TIMESTAMP = "Invalid timestamp: must be an integer Unix timestamp in the future."

/**
 * `proration_date`: the time a change is prorated from, which must fall within the current
 * billing period (Stripe documents that; the wording of the refusal is a best guess, not
 * oracle-verified).
 */
const prorationDateOf = (params: Params, subscription: SubscriptionRecord): number | undefined => {
  const at = intOf(params.proration_date)
  if (at === undefined) return undefined
  if (at < subscription.current_period_start || at > subscription.current_period_end)
    throw invalidRequest(
      "The `proration_date` must be within the subscription's current billing period.",
      "proration_date",
    )
  return at
}

/** `trial_settings[end_behavior][missing_payment_method]`. */
const trialSettingsOf = (raw: unknown): SubscriptionRecord["trial_settings"] | undefined => {
  const behavior = recordOf(recordOf(raw)?.end_behavior)?.missing_payment_method
  return behavior === "cancel" || behavior === "create_invoice" || behavior === "pause"
    ? { end_behavior: { missing_payment_method: behavior as TrialEndBehavior } }
    : undefined
}

/** `pause_collection[behavior]` / `[resumes_at]`, or `pause_collection=""` to resume. */
const pauseCollectionOf = (raw: unknown, now: number): PauseCollection | null | undefined => {
  if (raw === undefined) return undefined
  if (raw === "") return null
  const record = recordOf(raw)
  const behavior = record?.behavior
  if (behavior !== "keep_as_draft" && behavior !== "mark_uncollectible" && behavior !== "void")
    throw parameterMissing("pause_collection[behavior]")
  const resumesAt = intOf(record?.resumes_at) ?? null
  if (resumesAt !== null && resumesAt <= now)
    throw invalidRequest(FUTURE_TIMESTAMP, "pause_collection[resumes_at]")
  return { behavior, resumes_at: resumesAt }
}

/** `cancellation_details[comment]` / `[feedback]`; `""` clears either. */
const cancellationDetailsOf = (raw: unknown) => {
  const record = recordOf(raw)
  if (record === undefined) return undefined
  const text = (value: unknown) =>
    value === undefined ? undefined : typeof value === "string" && value !== "" ? value : null
  return { comment: text(record.comment), feedback: text(record.feedback) }
}

/**
 * Change a subscription's items. `proration_behavior=none` just swaps prices;
 * `always_invoice` bills the difference for the rest of the period now; the default
 * (`create_prorations`) leaves the difference as pending proration items for the next invoice.
 * Every request is validated before anything is written, so a refused change leaves no trace.
 */
const changeItems = (
  scope: RequestScope,
  subscription: SubscriptionRecord,
  requests: ItemRequest[],
  proration: string,
  /** `proration_date`: prorate as of this time instead of now. */
  prorateAt?: number,
): { itemIds: string[]; prorationAmount: number } => {
  const existing = subscriptionItems(scope, subscription)
  const itemIds = [...subscription.item_ids]
  let prorationAmount = 0
  const now = customerNow(scope, subscription.customer)
  const span = Math.max(1, subscription.current_period_end - subscription.current_period_start)
  const left = Math.max(0, subscription.current_period_end - (prorateAt ?? now)) / span
  const amountOf = (priceId: string, quantity: number) =>
    Math.round(Number(requirePrice(scope, priceId).unit_amount_decimal) * quantity)
  const writes: Array<() => void> = []
  const finalPrices = new Map(existing.map((item) => [item.id, item.price]))
  const added: string[] = []
  requests.forEach((request, index) => {
    const current =
      request.id === null ? undefined : existing.find((item) => item.id === request.id)
    if (request.id !== null && current === undefined)
      throw resourceMissing("subscription_item", request.id, `items[${index}][id]`)
    if (current && request.deleted) {
      prorationAmount -= Math.round(amountOf(current.price, current.quantity ?? 1) * left)
      finalPrices.delete(current.id)
      writes.push(() => {
        scope.account.subscriptionItems.delete(current.id)
        itemIds.splice(itemIds.indexOf(current.id), 1)
      })
      return
    }
    if (current) {
      const price = request.price ?? current.price
      // Staying on an archived price is fine; only moving to one is refused.
      if (price !== current.price) requireSubscribablePrice(scope, price, `items[${index}][price]`)
      const quantity = request.quantity ?? current.quantity ?? 1
      prorationAmount += Math.round(
        (amountOf(price, quantity) - amountOf(current.price, current.quantity ?? 1)) * left,
      )
      finalPrices.set(current.id, price)
      writes.push(() =>
        scope.account.subscriptionItems.update(current.id, {
          ...current,
          price,
          quantity,
          metadata: request.metadata ?? current.metadata,
        }),
      )
      return
    }
    if (request.price === null) throw parameterMissing(`items[${index}][price]`)
    const price = requireSubscribablePrice(scope, request.price, `items[${index}][price]`)
    const quantity = request.quantity ?? 1
    added.push(price.id)
    prorationAmount += Math.round(amountOf(price.id, quantity) * left)
    writes.push(() => {
      const itemId = scope.ids.next("si_", 14)
      const record: SubscriptionItemRecord = {
        id: itemId,
        created: now,
        metadata: request.metadata ?? {},
        price: price.id,
        quantity,
        subscription: subscription.id,
        discount_ids: [],
      }
      scope.account.subscriptionItems.insert(itemId, record)
      itemIds.push(itemId)
    })
  })
  assertCompatiblePrices(
    [...finalPrices.values(), ...added].map((price) => requirePrice(scope, price)),
  )
  for (const write of writes) write()
  if (proration === "none") prorationAmount = 0
  return { itemIds, prorationAmount }
}

const ONE_TIME_ONLY =
  "The price specified is set to `type=one_time` but this field only accepts prices with `type=recurring`."

/** A price a subscription item may move to: it exists, recurs, and is still for sale. */
const requireSubscribablePrice = (scope: RequestScope, id: string, param: string) => {
  const price = requirePrice(scope, id, param)
  if (price.recurring === null) throw invalidRequest(ONE_TIME_ONLY, param)
  if (!price.active) throw invalidRequest(INACTIVE_PRICE, param)
  return price
}

/**
 * `POST /v1/subscriptions/:id` — shared by the API and the customer portal, which posts the
 * same parameters a merchant would.
 */
export const updateSubscription = (
  scope: RequestScope,
  current: SubscriptionRecord,
  params: Params,
  /** The legacy singular `coupon` / `promotion_code`, read by `singularDiscount`. */
  singular?: DiscountRequest[] | "clear",
): SubscriptionRecord => {
  if (current.status === "canceled" || current.status === "incomplete_expired") {
    const onlyMetadata = Object.keys(params).every((key) =>
      ["metadata", "cancellation_details", "expand"].includes(key),
    )
    if (!onlyMetadata)
      throw invalidRequest(
        "A canceled subscription can only update its cancellation_details and metadata.",
      )
  }
  const now = customerNow(scope, current.customer)
  const trialEnd = params.trial_end
  const trialEndAt =
    typeof trialEnd === "number" || (typeof trialEnd === "string" && /^\d+$/.test(trialEnd))
      ? Number(trialEnd)
      : undefined
  if (trialEndAt !== undefined && trialEndAt <= now)
    throw invalidRequest(FUTURE_TIMESTAMP, "trial_end")
  const pauseCollection = pauseCollectionOf(params.pause_collection, now)
  const discounts = singular ?? parseDiscounts(params.discounts)
  const addInvoiceItems = parseAddInvoiceItems(scope, params.add_invoice_items, current.currency)
  // Refuse bad discounts before any item changes; applying them happens after.
  if (discounts !== undefined && discounts !== "clear")
    discounts.forEach((request, index) => {
      if (request.discount !== undefined) {
        if (!current.discount_ids.includes(request.discount))
          throw resourceMissing("discount", request.discount, `discounts[${index}][discount]`)
      } else resolveDiscountSource(scope, request, `discounts[${index}]`)
    })
  const previousItems = { items: renderSubscription(current, scope.account).items }
  const proration = stringOf(params, "proration_behavior") ?? "create_prorations"
  const itemRequests = requestedItems(params)
  const prorateAt = prorationDateOf(params, current)
  const previousBilling = {
    items: subscriptionItems(scope, current),
    recurring: recurringOf(scope, current),
    period: { start: current.current_period_start, end: current.current_period_end },
  }
  const changed =
    itemRequests.length === 0
      ? { itemIds: current.item_ids, prorationAmount: 0 }
      : changeItems(scope, current, itemRequests, proration, prorateAt)
  const itemIds = changed.itemIds
  // A trial is free: changing plans during one prorates nothing.
  const prorationAmount = current.status === "trialing" ? 0 : changed.prorationAmount
  const cancelAtPeriodEnd = booleanOf(params.cancel_at_period_end)
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
            "discounts",
            false,
          )
  const details = cancellationDetailsOf(params.cancellation_details)
  const trialSettings = trialSettingsOf(params.trial_settings)
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
    ...(params.description === undefined ? {} : { description: stringOf(params, "description") }),
    ...(pauseCollection === undefined ? {} : { pause_collection: pauseCollection }),
    ...(trialSettings === undefined ? {} : { trial_settings: trialSettings }),
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
  if (details !== undefined) {
    const base = next.cancellation_details ?? { comment: null, feedback: null, reason: null }
    next = {
      ...next,
      cancellation_details: {
        ...base,
        ...(details.comment === undefined ? {} : { comment: details.comment }),
        ...(details.feedback === undefined ? {} : { feedback: details.feedback }),
      },
    }
  }
  const endTrialNow = trialEnd === "now" && current.status === "trialing"
  if (trialEndAt !== undefined)
    next = {
      ...next,
      trial_end: trialEndAt,
      trial_start: next.status === "trialing" ? next.trial_start : now,
      current_period_end: trialEndAt,
      ...(next.status === "active" ? { status: "trialing" as const } : {}),
    }
  // A price on a different billing period resets the billing cycle anchor to now: a new period
  // starts and is invoiced at once. A trial keeps its end instead.
  const nextRecurring = recurringOf(scope, next)
  const resetsAnchor =
    itemRequests.length > 0 &&
    trialEndAt === undefined &&
    (current.status === "active" || current.status === "past_due") &&
    !sameBillingPeriod(previousBilling.recurring, nextRecurring)
  if (resetsAnchor)
    next = {
      ...next,
      billing_cycle_anchor: now,
      current_period_start: now,
      current_period_end: addInterval(now, nextRecurring.interval, nextRecurring.interval_count),
    }
  saveSubscription(scope, current, next, previousItems)
  discountsReplaced(scope, current.discount_ids, discountIds, singular !== undefined)
  // Pending until the next invoice this subscription produces, which may be the one below.
  addSubscriptionInvoiceItems(scope, next, addInvoiceItems)
  if (resetsAnchor) invoiceBillingCycleReset(scope, next, previousBilling, proration !== "none")
  else
    billProration(scope, next, prorationAmount, proration, {
      period: { start: prorateAt ?? now, end: current.current_period_end },
      description:
        proration === "always_invoice"
          ? "Remaining time on the new price (prorated)"
          : "Proration for subscription change",
      failOnDecline: stringOf(params, "payment_behavior") === "error_if_incomplete",
    })
  if (endTrialNow) {
    const trialing = scope.account.subscriptions.get(current.id) ?? next
    const ended = { ...trialing, trial_end: now, current_period_end: now }
    scope.account.subscriptions.update(current.id, ended)
    // Stripe sends the trial reminder when a trial is ended immediately, too.
    scope.emit("customer.subscription.trial_will_end", renderSubscription(ended, scope.account))
    cycleSubscription(scope, ended)
  }
  return scope.account.subscriptions.get(current.id) ?? next
}

export const subscriptionHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (scope: RequestScope, record: SubscriptionRecord) =>
    renderSubscription(record, scope.account)

  return {
    GetSubscriptions: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      if (context.query.customer_account === "") throw parameterInvalidEmpty("customer_account")
      const customer = stringOf(params, "customer")
      if (customer !== null && !scope.account.customers.get(customer))
        throw resourceMissing("customer", customer, "customer", 400)
      if (params.price === "") throw parameterInvalidEmpty("price")
      const price = stringOf(params, "price")
      if (price !== null && !scope.account.prices.get(price))
        throw resourceMissing("price", price, "price", 400)
      const clock = stringOf(params, "test_clock")
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
          // Stripe resolves the cursors before it complains about an unknown test clock.
          check: () => {
            if (clock !== null && !scope.account.testClocks.get(clock))
              throw resourceMissing("billingclock", clock, "test_clock", 400)
          },
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
      const discounts = singularDiscount(scope, context, params) ?? parseDiscounts(params.discounts)
      const firstPrice = items[0]?.price
      const addInvoiceItems = parseAddInvoiceItems(
        scope,
        params.add_invoice_items,
        (firstPrice ? scope.account.prices.get(firstPrice)?.currency : undefined) ?? null,
      )
      const defaultMethod = stringOf(params, "default_payment_method")
      if (defaultMethod !== null && !scope.account.paymentMethods.get(defaultMethod))
        throw resourceMissing("PaymentMethod", defaultMethod, "default_payment_method")
      const trialEndAt = intOf(params.trial_end)
      if (
        params.trial_end !== "now" &&
        trialEndAt !== undefined &&
        trialEndAt <= customerNow(scope, customer)
      )
        throw invalidRequest(FUTURE_TIMESTAMP, "trial_end")
      if (booleanOf(params.trial_from_plan) === true && params.trial_end !== undefined)
        throw invalidRequest(
          "You may not specify `trial_end` when `trial_from_plan` is true.",
          "trial_from_plan",
        )
      const trialSettings = trialSettingsOf(params.trial_settings)
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
        trialFromPlan: booleanOf(params.trial_from_plan) === true,
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
        description: stringOf(params, "description"),
        ...(trialSettings === undefined ? {} : { trialSettings }),
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
      const singular = singularDiscount(scope, context, params)
      return jsonResponse(200, render(scope, updateSubscription(scope, current, params, singular)))
    },
    DeleteSubscriptionsSubscriptionExposedIdDiscount: async (context) => {
      const scope = requestScope(services, context)
      deleteParams(context)
      const id = context.params.subscription_exposed_id ?? ""
      const current = requireSubscriptionRecord(scope, id)
      const [first] = current.discount_ids
      // Best guess, not oracle-verified: with stackable discounts every subscription-level one
      // goes, and the answer is the first of them; none at all is a 404.
      if (first === undefined)
        throw new StripeError({
          status: 404,
          code: "resource_missing",
          message: `No active discount for subscription: '${id}'`,
          param: "subscription_exposed_id",
        })
      saveSubscription(scope, current, { ...current, discount_ids: [] })
      discountsRemoved(scope, current.discount_ids, [])
      return jsonResponse(200, renderDeletedDiscount(scope, first))
    },
    DeleteSubscriptionsSubscriptionExposedId: async (context) => {
      const scope = requestScope(services, context)
      const params = deleteParams(context)
      const current = requireSubscriptionRecord(scope, context.params.subscription_exposed_id ?? "")
      if (current.status === "canceled")
        throw invalidRequest(
          `No such subscription: '${current.id}'`,
          "subscription_exposed_id",
          "resource_missing",
        )
      const details = cancellationDetailsOf(params.cancellation_details)
      return jsonResponse(
        200,
        render(
          scope,
          cancelSubscription(scope, current, "cancellation_requested", undefined, {
            ...(details?.comment === undefined ? {} : { comment: details.comment }),
            ...(details?.feedback === undefined ? {} : { feedback: details.feedback }),
            prorate: booleanOf(params.prorate) === true,
            invoiceNow: booleanOf(params.invoice_now) === true,
          }),
        ),
      )
    },
    PostSubscriptionsSubscriptionResume: async (context) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context)
      const id = context.params.subscription ?? ""
      const current = scope.account.subscriptions.get(id)
      if (!current) throw resourceMissing("subscription", id, "subscription")
      if (current.status !== "paused")
        throw invalidRequest(
          `Only a paused subscription can be resumed; this subscription's status is ${current.status}.`,
        )
      const anchor = stringOf(params, "billing_cycle_anchor") === "unchanged" ? "unchanged" : "now"
      const proration = stringOf(params, "proration_behavior")
      const prorationDate = intOf(params.proration_date)
      return jsonResponse(
        200,
        render(
          scope,
          resumeSubscription(scope, current, {
            billingCycleAnchor: anchor,
            prorationBehavior:
              proration === "always_invoice" || proration === "none"
                ? proration
                : "create_prorations",
            prorationDate,
          }),
        ),
      )
    },
    GetSubscriptionItems: async (context) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const subscription = stringOf(params, "subscription")
      if (subscription === null) throw parameterMissing("subscription")
      if (!scope.account.subscriptions.get(subscription))
        throw resourceMissing("subscription", subscription, "subscription")
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
      if (queryParams(context).expand === "") throw parameterInvalidEmpty("expand")
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
        prorationDateOf(params, current),
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
        prorationDateOf(params, current),
      )
      saveSubscription(scope, current, { ...current }, previousItems)
      const updated = scope.account.subscriptionItems.get(id) ?? item
      return jsonResponse(200, renderSubscriptionItem(updated, scope.account))
    },
    DeleteSubscriptionItemsItem: async (context) => {
      const scope = requestScope(services, context)
      const params = deleteParams(context)
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
        prorationDateOf(params, current),
      )
      saveSubscription(scope, current, { ...current, item_ids: itemIds }, previousItems)
      return jsonResponse(200, renderDeletedSubscriptionItem(id))
    },
  }
}
