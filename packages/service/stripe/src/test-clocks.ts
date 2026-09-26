import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { type LifecycleSettings, runLifecycle } from "./billing.js"
import { invalidRequest, parameterMissing, resourceMissing } from "./errors.js"
import { intOf, type RequestScope, requestScope, type Services, stringOf } from "./internal.js"
import { paginate } from "./list.js"
import { bodyParams, queryParams } from "./params.js"
import { renderTestClock } from "./render.js"
import { seconds, type TestClockRecord } from "./state.js"

const DELETES_AFTER = 30 * 86_400
const MAX_ADVANCE_INTERVALS = 2

const requireClock = (scope: RequestScope, id: string): TestClockRecord => {
  const clock = scope.account.testClocks.get(id)
  if (!clock) throw resourceMissing("billingclock", id, "test_clock")
  return clock
}

/**
 * Test clocks: customers created with `test_clock` (and their subscriptions and invoices) live on
 * the clock's frozen time instead of the mock clock. Advancing a clock runs every renewal,
 * expiry and schedule phase its customers pass through, then reports `ready` — at once, where
 * Stripe takes seconds.
 */
export const testClockHandlers = (
  services: Services,
  settings: LifecycleSettings,
): Record<string, OperationHandler> => ({
  PostTestHelpersTestClocks: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const frozen = intOf(params.frozen_time)
    if (frozen === undefined) throw parameterMissing("frozen_time")
    const id = scope.ids.next("clock_", 24)
    const clock: TestClockRecord = {
      id,
      created: seconds(scope.now),
      deletes_after: seconds(scope.now) + DELETES_AFTER,
      frozen_time: frozen,
      name: stringOf(params, "name"),
      status: "ready",
    }
    scope.account.testClocks.insert(id, clock)
    scope.emit("test_helpers.test_clock.created", renderTestClock(clock))
    return jsonResponse(200, renderTestClock(clock))
  },
  GetTestHelpersTestClocks: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    return jsonResponse(
      200,
      await paginate<TestClockRecord>(scope.account.testClocks, params, {
        url: "/v1/test_helpers/test_clocks",
        kind: "billingclock",
        where: () => true,
        render: renderTestClock,
      }),
    )
  },
  GetTestHelpersTestClocksTestClock: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    return jsonResponse(200, renderTestClock(requireClock(scope, context.params.test_clock ?? "")))
  },
  PostTestHelpersTestClocksTestClockAdvance: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireClock(scope, context.params.test_clock ?? "")
    const target = intOf(params.frozen_time)
    if (target === undefined) throw parameterMissing("frozen_time")
    if (target <= current.frozen_time)
      throw invalidRequest(
        "The frozen_time must be after the test clock's current frozen_time.",
        "frozen_time",
      )
    const customers = new Set(
      scope.account.customers
        .list()
        .map((entry) => entry.value)
        .filter((entry) => entry.kind === "live" && entry.customer.test_clock === current.id)
        .map((entry) => (entry.kind === "live" ? entry.customer.id : "")),
    )
    const longestInterval = scope.account.subscriptions
      .list({ where: (subscription) => customers.has(subscription.customer) })
      .reduce(
        (longest, entry) =>
          Math.max(longest, entry.value.current_period_end - entry.value.current_period_start),
        0,
      )
    if (
      longestInterval > 0 &&
      target - current.frozen_time > longestInterval * MAX_ADVANCE_INTERVALS
    )
      throw invalidRequest(
        "Cannot advance a test clock more than two intervals beyond the shortest subscription interval.",
        "frozen_time",
      )
    const advancing: TestClockRecord = { ...current, status: "advancing" }
    scope.account.testClocks.update(current.id, advancing)
    scope.emit("test_helpers.test_clock.advancing", renderTestClock(advancing))
    scope.account.testClocks.update(current.id, { ...advancing, frozen_time: target })
    runLifecycle(scope, settings, customers)
    const ready: TestClockRecord = { ...advancing, frozen_time: target, status: "ready" }
    scope.account.testClocks.update(current.id, ready)
    scope.emit("test_helpers.test_clock.ready", renderTestClock(ready))
    return jsonResponse(200, renderTestClock({ ...ready, status: "advancing" }))
  },
  DeleteTestHelpersTestClocksTestClock: async (context) => {
    const scope = requestScope(services, context)
    const clock = requireClock(scope, context.params.test_clock ?? "")
    for (const entry of scope.account.customers.list()) {
      const value = entry.value
      if (value.kind === "live" && value.customer.test_clock === clock.id)
        scope.account.customers.update(entry.id, { kind: "deleted", id: entry.id })
    }
    scope.account.testClocks.delete(clock.id)
    return jsonResponse(200, { id: clock.id, object: "test_helpers.test_clock", deleted: true })
  },
})
