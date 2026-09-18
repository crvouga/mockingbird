import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, resourceMissing } from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  findCustomer,
  mergeRecordMetadata,
  type RequestScope,
  requestScope,
  requireLiveCustomer,
  type Services,
} from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, queryParams } from "./params.js"
import { renderCustomer, renderSubscription, renderSubscriptionSchedule } from "./render.js"
import type { SubscriptionScheduleRecord } from "./state.js"
import { seconds } from "./state.js"

/** Expansion paths for a single schedule; the list form prefixes them with `data.`. */
const expanders = (scope: RequestScope): ExpandResolvers => {
  const customer = (id: string) => {
    const record = findCustomer(scope, id)
    return record === undefined ? undefined : renderCustomer(record)
  }
  const subscription = (id: string) => {
    const record = scope.account.subscriptions.get(id)
    return record === undefined ? undefined : renderSubscription(record, scope.account)
  }
  return {
    customer,
    subscription,
    "data.customer": customer,
    "data.subscription": subscription,
  }
}

const requireSchedule = (scope: RequestScope, id: string): SubscriptionScheduleRecord => {
  const record = scope.account.subscriptionSchedules.get(id)
  if (!record) throw resourceMissing("subscription_schedule", id, "schedule")
  return record
}

/** A terminal schedule cannot be canceled or released a second time. */
const rejectTerminal = (schedule: SubscriptionScheduleRecord, action: string) => {
  if (schedule.status === "released" || schedule.status === "canceled")
    throw invalidRequest(
      `This subscription schedule has already been ${schedule.status}, so it cannot be ${action}.`,
      "schedule",
    )
}

export const subscriptionScheduleHandlers = (
  services: Services,
): Record<string, OperationHandler> => ({
  PostSubscriptionSchedules: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const customerId = typeof params.customer === "string" ? params.customer : ""
    requireLiveCustomer(scope, customerId, "customer")
    const id = scope.ids.next("sub_sched_")
    const record: SubscriptionScheduleRecord = {
      id,
      created: seconds(scope.now),
      customer: customerId,
      end_behavior: typeof params.end_behavior === "string" ? params.end_behavior : "release",
      metadata: mergeRecordMetadata({}, params.metadata),
      phases: Array.isArray(params.phases) ? (params.phases as Array<Record<string, unknown>>) : [],
      released_at: null,
      released_subscription: null,
      status: "not_started",
      subscription: null,
    }
    scope.account.subscriptionSchedules.insert(id, record)
    return jsonResponse(
      200,
      applyExpand(renderSubscriptionSchedule(record), params.expand, expanders(scope)),
    )
  },

  GetSubscriptionSchedules: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
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
        render: (record) => renderSubscriptionSchedule(record),
      },
    )
    return jsonResponse(200, applyExpand(page, params.expand, expanders(scope)))
  },

  GetSubscriptionSchedulesSchedule: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const record = requireSchedule(scope, context.params.schedule ?? "")
    return jsonResponse(
      200,
      applyExpand(renderSubscriptionSchedule(record), params.expand, expanders(scope)),
    )
  },

  PostSubscriptionSchedulesSchedule: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireSchedule(scope, context.params.schedule ?? "")
    const next: SubscriptionScheduleRecord = {
      ...current,
      end_behavior:
        typeof params.end_behavior === "string" ? params.end_behavior : current.end_behavior,
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
      phases: Array.isArray(params.phases)
        ? (params.phases as Array<Record<string, unknown>>)
        : current.phases,
    }
    scope.account.subscriptionSchedules.update(next.id, next)
    return jsonResponse(
      200,
      applyExpand(renderSubscriptionSchedule(next), params.expand, expanders(scope)),
    )
  },

  PostSubscriptionSchedulesScheduleCancel: async (context) => {
    const scope = requestScope(services, context)
    bodyParams(context)
    const current = requireSchedule(scope, context.params.schedule ?? "")
    rejectTerminal(current, "canceled")
    const next: SubscriptionScheduleRecord = {
      ...current,
      status: "canceled",
      released_at: current.status === "active" ? seconds(scope.now) : current.released_at,
    }
    scope.account.subscriptionSchedules.update(next.id, next)
    return jsonResponse(200, renderSubscriptionSchedule(next))
  },

  PostSubscriptionSchedulesScheduleRelease: async (context) => {
    const scope = requestScope(services, context)
    bodyParams(context)
    const current = requireSchedule(scope, context.params.schedule ?? "")
    rejectTerminal(current, "released")
    const next: SubscriptionScheduleRecord = {
      ...current,
      status: "released",
      released_at: seconds(scope.now),
      released_subscription: current.subscription,
      subscription: null,
    }
    scope.account.subscriptionSchedules.update(next.id, next)
    return jsonResponse(200, renderSubscriptionSchedule(next))
  },
})
