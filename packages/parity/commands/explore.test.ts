import { describe, expect, test } from "bun:test"
import {
  createExploreRng,
  defaultDynamicWeight,
  JUNCTION_CONTINUATIONS,
  type ExploreState,
  type OperationPlan,
  pickWeightedIndex,
  pushHistory,
  weightPlans,
} from "./src/index.js"

const stubPlan = (
  operationId: string,
  requires: string[] = [],
  produces: string[] = [],
): OperationPlan =>
  ({
    operation: { operationId },
    metadata: {},
    requires,
    produces,
    body: undefined,
  }) as unknown as OperationPlan

describe("explore weighting", () => {
  test("pickWeightedIndex respects mass", () => {
    const weighted = [
      { plan: stubPlan("a"), weight: 1 },
      { plan: stubPlan("b"), weight: 99 },
    ]
    let b = 0
    for (let i = 0; i < 200; i += 1) {
      if (weighted[pickWeightedIndex(weighted, i / 200)]?.plan.operation.operationId === "b") b += 1
    }
    expect(b).toBeGreaterThan(150)
  })

  test("createExploreRng is deterministic", () => {
    const a = createExploreRng(42)
    const b = createExploreRng(42)
    expect([a.next(), a.nextInt(10), a.next()]).toEqual([b.next(), b.nextInt(10), b.next()])
  })

  test("defaultDynamicWeight zeros consumers without resources", () => {
    const state: ExploreState = {
      coverage: {},
      history: [],
      resourceCounts: {},
      phase: "compare",
      step: 0,
      maxSteps: 20,
    }
    const producer = stubPlan("create_user_v2_user_post", [], ["user"])
    const consumer = stubPlan("get_user_v2_user__user_id__get", ["user"], [])
    expect(
      defaultDynamicWeight({ ...state, plan: producer, plans: [producer, consumer] }),
    ).toBeGreaterThan(0)
    expect(
      defaultDynamicWeight({ ...state, plan: consumer, plans: [producer, consumer] }),
    ).toBe(0)
  })

  test("continuation boosts follow create_order", () => {
    const state: ExploreState = {
      coverage: {},
      history: ["create_order_v3_order_post"],
      resourceCounts: { order: 1, user: 1 },
      phase: "compare",
      step: 5,
      maxSteps: 20,
    }
    const simulate = stubPlan("simulate_order_v3_order__order_id__test_post", ["order"])
    const listUsers = stubPlan("get_teams_users_v2_user_get")
    const simW = defaultDynamicWeight({
      ...state,
      plan: simulate,
      plans: [simulate, listUsers],
    })
    const listW = defaultDynamicWeight({
      ...state,
      plan: listUsers,
      plans: [simulate, listUsers],
    })
    expect(simW).toBeGreaterThan(listW)
    expect(JUNCTION_CONTINUATIONS.create_order_v3_order_post?.simulate_order_v3_order__order_id__test_post).toBe(
      10,
    )
  })

  test("geo ops gated without observation cache in compare", () => {
    const state: ExploreState = {
      coverage: {},
      history: [],
      resourceCounts: {},
      phase: "compare",
      step: 3,
      maxSteps: 20,
      observationCacheSize: 0,
    }
    const area = stubPlan("get_area_info_v3_order_area_info_get")
    expect(defaultDynamicWeight({ ...state, plan: area, plans: [area] })).toBe(0)
    expect(
      defaultDynamicWeight({
        ...state,
        observationCacheSize: 4,
        plan: area,
        plans: [area],
      }),
    ).toBeGreaterThan(0)
  })

  test("weightPlans + pushHistory cover untouched ops", () => {
    const plans = [
      stubPlan("create_user_v2_user_post", [], ["user"]),
      stubPlan("get_teams_users_v2_user_get"),
    ]
    const history: string[] = []
    pushHistory(history, "create_user_v2_user_post")
    const weighted = weightPlans(plans, {
      coverage: { create_user_v2_user_post: 1 },
      history,
      resourceCounts: { user: 1 },
      phase: "warmup",
      step: 1,
      maxSteps: 10,
    })
    const getTeams = weighted.find(
      (entry) => entry.plan.operation.operationId === "get_teams_users_v2_user_get",
    )
    expect(getTeams?.weight).toBeGreaterThan(0)
  })
})
