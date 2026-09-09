import type { OperationPlan } from "./plan.js"

/** Mutable walk state consulted by {@link DynamicWeightFn}. */
export type ExploreState = {
  /** operationId → times exercised in this walk. */
  coverage: Record<string, number>
  /** Recent operationIds (oldest → newest), typically capped. */
  history: readonly string[]
  /** Active resource counts by type (user, order, …). */
  resourceCounts: Record<string, number>
  phase: "warmup" | "compare" | "walk"
  step: number
  maxSteps: number
  /** Optional observed GET cache size — used to unlock geo/scheduling reads. */
  observationCacheSize?: number
}

export type WeightContext = ExploreState & {
  plan: OperationPlan
  plans: readonly OperationPlan[]
}

/** Returns a relative weight (≥ 0). Zero means the operation is skipped this step. */
export type DynamicWeightFn = (ctx: WeightContext) => number

const HISTORY_CAP = 12

/** Junction / Vital-oriented continuations: after A, boost B. */
export const JUNCTION_CONTINUATIONS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  create_user_v2_user_post: {
    patch_user_info_v2_user__user_id__info_patch: 6,
    get_user_v2_user__user_id__get: 3,
    get_user_by_client_user_id_v2_user_resolve__client_user_id__get: 3,
    create_order_v3_order_post: 10,
    get_teams_users_v2_user_get: 2,
  },
  patch_user_info_v2_user__user_id__info_patch: {
    create_order_v3_order_post: 8,
    get_latest_user_info_user_v2_user__user_id__info_latest_get: 4,
  },
  create_order_v3_order_post: {
    get_order_v3_order__order_id__get: 8,
    simulate_order_v3_order__order_id__test_post: 10,
    cancel_order_v3_order__order_id__cancel_post: 2,
    get_orders_v3_orders_get: 3,
    get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post: 7,
    get_area_info_v3_order_area_info_get: 4,
    get_psc_info_v3_order_psc_info_get: 4,
  },
  simulate_order_v3_order__order_id__test_post: {
    get_order_v3_order__order_id__get: 5,
    get_result_metadata_v3_order__order_id__result_metadata_get: 8,
    get_result_raw_v3_order__order_id__result_get: 7,
    get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post: 6,
  },
  get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post: {
    book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post: 12,
  },
  book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post: {
    get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get: 10,
    reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch: 4,
    cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch: 3,
  },
  get_area_info_v3_order_area_info_get: {
    get_psc_info_v3_order_psc_info_get: 6,
    create_order_v3_order_post: 3,
  },
  get_psc_info_v3_order_psc_info_get: {
    create_order_v3_order_post: 4,
  },
  cancel_order_v3_order__order_id__cancel_post: {
    get_order_v3_order__order_id__get: 4,
    get_orders_v3_orders_get: 3,
  },
  delete_user_v2_user__user_id__delete: {
    get_teams_users_v2_user_get: 3,
    create_user_v2_user_post: 5,
  },
}

const GEO_OPS = new Set([
  "get_area_info_v3_order_area_info_get",
  "get_psc_info_v3_order_psc_info_get",
])

const SCHEDULING_WRITE_OPS = new Set([
  "book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post",
  "reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch",
  "cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch",
  "book_psc_appointment_v3_order__order_id__psc_appointment_book_post",
  "reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch",
  "cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch",
  "get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post",
  "get_psc_appointment_availability_v3_order_psc_appointment_availability_post",
])

/**
 * Default dynamic weight: producers early, consumers when ready, continuation boosts,
 * coverage bias, anti-repeat dampening, and geo/scheduling gated on observation cache.
 */
export const defaultDynamicWeight: DynamicWeightFn = (ctx) => {
  const id = ctx.plan.operation.operationId
  const requires = ctx.plan.requires
  if (requires.some((type) => (ctx.resourceCounts[type] ?? 0) <= 0)) return 0

  if (GEO_OPS.has(id) && ctx.phase === "compare" && (ctx.observationCacheSize ?? 0) === 0) {
    return 0
  }

  let weight = 1

  const isProducer = ctx.plan.produces.length > 0 && requires.length === 0
  const early = ctx.step < Math.max(2, Math.floor(ctx.maxSteps * 0.35))
  if (isProducer) {
    const starving = ctx.plan.produces.some((type) => (ctx.resourceCounts[type] ?? 0) === 0)
    weight *= starving ? 8 : early ? 4 : 1.5
  }

  if (requires.length > 0) {
    const depth = requires.reduce((sum, type) => sum + (ctx.resourceCounts[type] ?? 0), 0)
    weight *= 2 + Math.min(4, depth)
    if (early && (ctx.resourceCounts[requires[0] ?? ""] ?? 0) < 2) weight *= 1.5
  }

  const last = ctx.history[ctx.history.length - 1]
  if (last) {
    const boost = JUNCTION_CONTINUATIONS[last]?.[id]
    if (boost !== undefined) weight *= boost
  }

  const prior = ctx.history[ctx.history.length - 2]
  if (prior) {
    const boost = JUNCTION_CONTINUATIONS[prior]?.[id]
    if (boost !== undefined) weight *= 1 + boost * 0.25
  }

  if ((ctx.coverage[id] ?? 0) === 0) weight *= 4
  else if ((ctx.coverage[id] ?? 0) === 1) weight *= 1.5

  const recent = ctx.history.slice(-3)
  if (recent.length === 3 && recent.every((entry) => entry === id)) weight *= 0.15
  else if (recent.filter((entry) => entry === id).length >= 2) weight *= 0.5

  if (SCHEDULING_WRITE_OPS.has(id) && (ctx.resourceCounts.order ?? 0) === 0) return 0
  if (
    (id.includes("phlebotomy_appointment_book") ||
      id.includes("psc_appointment_book") ||
      id.includes("appointment_reschedule")) &&
    (ctx.resourceCounts.booking_key ?? 0) === 0
  ) {
    return 0
  }

  const isBook = id.includes("appointment_book")
  const isReschedule = id.includes("appointment_reschedule")
  const isCancelAppt = id.includes("appointment_cancel")
  const isGetAppt =
    id.includes("phlebotomy_appointment_get") || id.includes("psc_appointment_get")
  const appointments = ctx.resourceCounts.appointment ?? 0
  const bookingKeys = ctx.resourceCounts.booking_key ?? 0

  if (isBook) {
    if (appointments > 0 && appointments >= (ctx.resourceCounts.order ?? 0)) weight *= 0.05
    if ((ctx.coverage[id] ?? 0) >= 1) weight *= 0.08
    if (last?.includes("appointment_book")) weight *= 0.05
    if (last?.includes("availability") && bookingKeys > 0) weight *= 6
  }
  if ((isReschedule || isCancelAppt || isGetAppt) && appointments === 0) return 0
  if ((isReschedule || isCancelAppt) && (ctx.coverage[id] ?? 0) >= 1) weight *= 0.2

  if (ctx.phase === "warmup" && GEO_OPS.has(id)) weight *= 3
  if (ctx.phase === "compare" && GEO_OPS.has(id) && (ctx.observationCacheSize ?? 0) > 0) {
    weight *= 2
  }

  if (ctx.phase === "warmup" && isProducer) weight *= 1.5
  if (ctx.phase === "compare" && requires.length > 0) weight *= 1.4

  return Math.max(0, weight)
}

export type WeightedPlan = { plan: OperationPlan; weight: number }

/** Compute positive weights for every plan under the current explore state. */
export const weightPlans = (
  plans: readonly OperationPlan[],
  state: ExploreState,
  weightFn: DynamicWeightFn = defaultDynamicWeight,
): WeightedPlan[] => {
  const out: WeightedPlan[] = []
  for (const plan of plans) {
    const weight = weightFn({ ...state, plan, plans })
    if (weight > 0) out.push({ plan, weight })
  }
  return out
}

/** Pick an index into `weighted` using `unit` ∈ [0, 1). */
export const pickWeightedIndex = (weighted: readonly WeightedPlan[], unit: number): number => {
  if (weighted.length === 0) throw new RangeError("no weighted plans to pick from")
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0)
  let cursor = Math.min(Math.max(unit, 0), 0.999_999_999) * total
  for (let index = 0; index < weighted.length; index += 1) {
    cursor -= weighted[index]?.weight ?? 0
    if (cursor <= 0) return index
  }
  return weighted.length - 1
}

/** Mulberry32 PRNG — deterministic from a 32-bit seed. */
export const createExploreRng = (seed: number) => {
  let state = seed >>> 0
  return {
    /** Uniform float in [0, 1). */
    next: () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    /** Uniform int in [0, max] inclusive. */
    nextInt: (max: number) => {
      if (max <= 0) return 0
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) % (max + 1)
    },
  }
}

export type ExploreRng = ReturnType<typeof createExploreRng>

export const pushHistory = (history: string[], operationId: string, cap = HISTORY_CAP) => {
  history.push(operationId)
  if (history.length > cap) history.splice(0, history.length - cap)
}

export const resourceCountsFrom = (count: (type: string) => number, types: readonly string[]) => {
  const out: Record<string, number> = {}
  for (const type of types) out[type] = count(type)
  return out
}

/** Collect every resource type mentioned by the plans (requires ∪ produces). */
export const resourceTypesOf = (plans: readonly OperationPlan[]) => {
  const types = new Set<string>()
  for (const plan of plans) {
    for (const type of plan.requires) types.add(type)
    for (const type of plan.produces) types.add(type)
  }
  return [...types].sort()
}
