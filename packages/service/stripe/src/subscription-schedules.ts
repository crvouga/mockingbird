import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import {
  advanceSchedule,
  applyPhase,
  cancelSubscription,
  createSubscription,
  phaseBounds,
  releaseSchedule,
  saveSubscription,
  subscriptionItems,
} from "./billing.js"
import { invalidRequest, resourceMissing } from "./errors.js"
import {
  customerNow,
  mergeRecordMetadata,
  type RequestScope,
  recordOf,
  requestScope,
  requireLiveCustomer,
  type Services,
  stringOf,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, queryParams } from "./params.js"
import { renderSubscriptionSchedule } from "./render.js"
import type { SubscriptionScheduleRecord } from "./state.js"

type RecordValue = Record<string, unknown>

const requireSchedule = (scope: RequestScope, id: string): SubscriptionScheduleRecord => {
  const record = scope.account.subscriptionSchedules.get(id)
  if (!record) throw resourceMissing("subscription_schedule", id, "schedule")
  return record
}

/** A terminal schedule cannot be canceled or released a second time. */
const rejectTerminal = (schedule: SubscriptionScheduleRecord, action: string) => {
  if (!["not_started", "active"].includes(schedule.status))
    throw invalidRequest(
      `You cannot ${action} a subscription schedule that is currently in the \`${schedule.status}\` status. It must be in one of the following statuses: \`not_started\`, \`active\`.`,
      "schedule",
    )
}

const numeric = (value: unknown): number | undefined => {
  if (typeof value === "number") return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return undefined
}

/**
 * Normalise requested phases: `start_date` (a timestamp or `now`), `end_date`, and items as
 * `{price, quantity}`; consecutive phases start where the previous one ends.
 */
const normalisePhases = (raw: unknown, now: number, firstStart: number): RecordValue[] => {
  const phases = Array.isArray(raw) ? raw.map((entry) => recordOf(entry) ?? {}) : []
  let cursor = firstStart
  return phases.map((phase, index) => {
    const start =
      phase.start_date === "now"
        ? now
        : (numeric(phase.start_date) ?? (index === 0 ? firstStart : cursor))
    const end = numeric(phase.end_date) ?? null
    if (end !== null) cursor = end
    const items = Array.isArray(phase.items)
      ? phase.items.map((entry) => {
          const item = recordOf(entry) ?? {}
          return {
            discounts: [],
            metadata: {},
            price: typeof item.price === "string" ? item.price : null,
            quantity: numeric(item.quantity) ?? 1,
            tax_rates: [],
          }
        })
      : []
    return {
      add_invoice_items: [],
      application_fee_percent: null,
      billing_cycle_anchor: null,
      collection_method: null,
      currency: "usd",
      default_payment_method: null,
      description: null,
      discounts: [],
      end_date: end,
      invoice_settings: null,
      items,
      metadata: (recordOf(phase.metadata) as RecordValue | undefined) ?? {},
      proration_behavior:
        typeof phase.proration_behavior === "string"
          ? phase.proration_behavior
          : "create_prorations",
      start_date: start,
      trial_end: null,
    }
  })
}

export const subscriptionScheduleHandlers = (
  services: Services,
): Record<string, OperationHandler> => ({
  PostSubscriptionSchedules: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const fromSubscription = stringOf(params, "from_subscription")
    const id = scope.ids.next("sub_sched_", 24)
    let record: SubscriptionScheduleRecord
    if (fromSubscription !== null) {
      const subscription = scope.account.subscriptions.get(fromSubscription)
      if (!subscription)
        throw resourceMissing("subscription", fromSubscription, "from_subscription")
      if (subscription.schedule !== null)
        throw invalidRequest(
          `You cannot migrate a subscription that is already attached to a schedule: \`${subscription.schedule}\`.`,
          "from_subscription",
        )
      record = {
        id,
        created: customerNow(scope, subscription.customer),
        customer: subscription.customer,
        end_behavior: "release",
        metadata: {},
        phases: [
          {
            ...normalisePhases(
              [
                {
                  start_date: subscription.current_period_start,
                  end_date: subscription.current_period_end,
                  items: subscriptionItems(scope, subscription).map((item) => ({
                    price: item.price,
                    quantity: item.quantity,
                  })),
                },
              ],
              subscription.current_period_start,
              subscription.current_period_start,
            )[0],
            current: true,
          },
        ],
        released_at: null,
        released_subscription: null,
        status: "active",
        subscription: subscription.id,
      }
      scope.account.subscriptionSchedules.insert(id, record)
      saveSubscription(scope, subscription, { ...subscription, schedule: id })
    } else {
      const customerId = stringOf(params, "customer") ?? ""
      requireLiveCustomer(scope, customerId, "customer")
      const now = customerNow(scope, customerId)
      const startRaw = params.start_date
      const start = startRaw === "now" ? now : (numeric(startRaw) ?? now)
      record = {
        id,
        created: now,
        customer: customerId,
        end_behavior: stringOf(params, "end_behavior") ?? "release",
        metadata: mergeRecordMetadata({}, params.metadata),
        phases: normalisePhases(params.phases, now, start),
        released_at: null,
        released_subscription: null,
        status: "not_started",
        subscription: null,
      }
      scope.account.subscriptionSchedules.insert(id, record)
      const first = record.phases[0]
      if (first !== undefined && phaseBounds(first).start <= now) {
        const items = (first.items as RecordValue[]).filter(
          (item) => typeof item.price === "string",
        )
        const { subscription } = createSubscription(scope, {
          customer: customerId,
          items: items.map((item) => ({
            price: item.price as string,
            quantity: Number(item.quantity ?? 1),
          })),
          metadata: {},
          defaultPaymentMethod: null,
          paymentBehavior: "allow_incomplete",
          trialEnd: null,
          schedule: id,
        })
        record = {
          ...record,
          status: "active",
          subscription: subscription.id,
          phases: record.phases.map((phase, index) => ({ ...phase, current: index === 0 })),
        }
        scope.account.subscriptionSchedules.update(id, record)
      }
    }
    scope.emit("subscription_schedule.created", renderSubscriptionSchedule(record))
    return jsonResponse(200, renderSubscriptionSchedule(record))
  },

  GetSubscriptionSchedules: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    // `scheduled` excludes the timestamp filters; Stripe names the first conflict in this order.
    if (params.scheduled !== undefined) {
      const conflict = ["completed_at", "released_at", "canceled_at"].find(
        (key) => params[key] !== undefined,
      )
      if (conflict)
        throw invalidRequest(
          `You may only specify one of these parameters: ${conflict}, scheduled.`,
          conflict,
        )
    }
    const customer = typeof params.customer === "string" ? params.customer : undefined
    const page = await paginate<SubscriptionScheduleRecord>(
      scope.account.subscriptionSchedules,
      params,
      {
        url: "/v1/subscription_schedules",
        kind: "subscription_schedule",
        where: (record) =>
          matchesCreated(record.created, params.created) &&
          (customer === undefined || customer === "" || record.customer === customer),
        render: renderSubscriptionSchedule,
      },
    )
    return jsonResponse(200, page)
  },

  GetSubscriptionSchedulesSchedule: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const record = requireSchedule(scope, context.params.schedule ?? "")
    return jsonResponse(200, renderSubscriptionSchedule(record))
  },

  PostSubscriptionSchedulesSchedule: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireSchedule(scope, context.params.schedule ?? "")
    if (!["not_started", "active"].includes(current.status))
      throw invalidRequest(
        `You cannot update a subscription schedule that is currently in the \`${current.status}\` status.`,
        "schedule",
      )
    const now = customerNow(scope, current.customer)
    const firstStart = phaseBounds(current.phases[0] ?? {}).start || now
    const phases =
      params.phases === undefined
        ? current.phases
        : normalisePhases(params.phases, now, firstStart).map((phase) => {
            const bounds = phaseBounds(phase)
            return {
              ...phase,
              current: bounds.start <= now && (bounds.end === null || bounds.end > now),
            }
          })
    const next: SubscriptionScheduleRecord = {
      ...current,
      end_behavior: stringOf(params, "end_behavior") ?? current.end_behavior,
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
      phases,
    }
    scope.account.subscriptionSchedules.update(next.id, next)
    const active = phases.find((phase) => phase.current === true)
    if (params.phases !== undefined && active !== undefined) applyPhase(scope, next, active)
    advanceSchedule(scope, next, now)
    const saved = scope.account.subscriptionSchedules.get(next.id) ?? next
    scope.emit("subscription_schedule.updated", renderSubscriptionSchedule(saved))
    return jsonResponse(200, renderSubscriptionSchedule(saved))
  },

  PostSubscriptionSchedulesScheduleCancel: async (context) => {
    const scope = requestScope(services, context)
    bodyParams(context)
    const current = requireSchedule(scope, context.params.schedule ?? "")
    rejectTerminal(current, "cancel")
    const now = customerNow(scope, current.customer)
    if (current.subscription !== null) {
      const subscription = scope.account.subscriptions.get(current.subscription)
      if (subscription && subscription.status !== "canceled")
        cancelSubscription(scope, subscription)
    }
    const next: SubscriptionScheduleRecord = {
      ...current,
      status: "canceled",
      canceled_at: now,
      phases: current.phases.map(({ current: _current, ...phase }) => phase),
    }
    scope.account.subscriptionSchedules.update(next.id, next)
    scope.emit("subscription_schedule.canceled", renderSubscriptionSchedule(next))
    return jsonResponse(200, renderSubscriptionSchedule(next))
  },

  PostSubscriptionSchedulesScheduleRelease: async (context) => {
    const scope = requestScope(services, context)
    bodyParams(context)
    const current = requireSchedule(scope, context.params.schedule ?? "")
    rejectTerminal(current, "release")
    const next = releaseSchedule(scope, current, customerNow(scope, current.customer))
    scope.emit("subscription_schedule.released", renderSubscriptionSchedule(next))
    return jsonResponse(200, renderSubscriptionSchedule(next))
  },
})
