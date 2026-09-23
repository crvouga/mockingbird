/**
 * The flag model behind the mock and how it evaluates.
 *
 * A flag has an optional default (`null` = PostHog does not return the flag at all, which is
 * different from `false`: the member app's `hasFlag` falls through to static defaults only for
 * an absent key), ordered overrides by `distinct_id` or `person_properties.email`, and a
 * payload stored as the JSON string PostHog puts on the wire.
 */

/** A flag's value: on/off, or a multivariate variant key (which means "on"). */
export type FlagValue = boolean | string

export type FlagOverride = {
  distinct_id?: string
  email?: string
  value: FlagValue
  /** JSON string sent as `metadata.payload`; falls back to the flag's payload. */
  payload?: string | null
}

export type FlagRecord = {
  id: number
  key: string
  name: string
  /** Inactive (or deleted) flags are never returned, like PostHog. */
  active: boolean
  deleted: boolean
  /** Value for everyone no override matches; `null` = the flag is absent for them. */
  default: FlagValue | null
  /** JSON string sent as `metadata.payload` when the flag is enabled. */
  payload: string | null
  overrides: FlagOverride[]
  version: number
  created_at: string
  updated_at: string
}

/** What a caller identifies as on `/flags`. */
export type FlagSubject = {
  distinct_id: string
  person_properties?: Record<string, unknown>
}

export type Evaluation = {
  key: string
  value: FlagValue
  payload: string | null
  /** Which condition matched: override index, or `overrides.length` for the default. */
  conditionIndex: number
  flag: FlagRecord
}

/** The flag's value for this subject, or `undefined` when PostHog would omit the flag. */
export const evaluateFlag = (flag: FlagRecord, subject: FlagSubject): Evaluation | undefined => {
  if (!flag.active || flag.deleted) return undefined
  const email =
    typeof subject.person_properties?.email === "string"
      ? subject.person_properties.email.trim().toLowerCase()
      : undefined
  for (const [index, override] of flag.overrides.entries()) {
    const byId = override.distinct_id !== undefined && override.distinct_id === subject.distinct_id
    const byEmail =
      override.email !== undefined && email !== undefined && override.email.toLowerCase() === email
    if (byId || byEmail) {
      return {
        key: flag.key,
        value: override.value,
        payload: override.payload !== undefined ? override.payload : flag.payload,
        conditionIndex: index,
        flag,
      }
    }
  }
  if (flag.default === null) return undefined
  return {
    key: flag.key,
    value: flag.default,
    payload: flag.payload,
    conditionIndex: flag.overrides.length,
    flag,
  }
}

const enabledOf = (value: FlagValue) => value !== false

/** One entry of the `/flags?v=2` `flags` map (what `@posthog/core` `normalizeFlagsResponse` reads). */
export const flagDetail = (evaluation: Evaluation) => {
  const enabled = enabledOf(evaluation.value)
  return {
    key: evaluation.key,
    enabled,
    variant: typeof evaluation.value === "string" ? evaluation.value : null,
    reason: enabled
      ? {
          code: "condition_match",
          condition_index: evaluation.conditionIndex,
          description: `Matched condition set ${evaluation.conditionIndex + 1}`,
        }
      : {
          code: "no_condition_match",
          condition_index: null,
          description: "No matching condition set",
        },
    metadata: {
      id: evaluation.flag.id,
      version: evaluation.flag.version,
      description: evaluation.flag.name || null,
      ...(enabled && evaluation.payload !== null ? { payload: evaluation.payload } : {}),
    },
  }
}

/** The legacy (`/decide`, `/flags?v=1`) maps: values and JSON-string payloads. */
export const legacyMaps = (evaluations: Evaluation[]) => {
  const featureFlags: Record<string, FlagValue> = {}
  const featureFlagPayloads: Record<string, string> = {}
  for (const evaluation of evaluations) {
    featureFlags[evaluation.key] = evaluation.value
    if (enabledOf(evaluation.value) && evaluation.payload !== null) {
      featureFlagPayloads[evaluation.key] = evaluation.payload
    }
  }
  return { featureFlags, featureFlagPayloads }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Store a payload as PostHog sends it: a JSON string. `undefined` / `null` mean none. */
export const payloadString = (payload: unknown): string | null =>
  payload === undefined || payload === null ? null : JSON.stringify(payload)

const parsePayload = (payload: string | null): unknown => {
  if (payload === null) return null
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}

/** The admin view of a flag (payloads parsed back). */
export const adminView = (flag: FlagRecord) => ({
  key: flag.key,
  id: flag.id,
  name: flag.name,
  active: flag.active,
  default: flag.default,
  payload: parsePayload(flag.payload),
  overrides: flag.overrides.map((o) => ({
    ...(o.distinct_id !== undefined ? { distinct_id: o.distinct_id } : {}),
    ...(o.email !== undefined ? { email: o.email } : {}),
    value: o.value,
    ...(o.payload !== undefined ? { payload: parsePayload(o.payload) } : {}),
  })),
  version: flag.version,
  updated_at: flag.updated_at,
})

/** Body of `PUT /__admin/flags/:key`, validated. */
export type FlagSpec = {
  name?: string
  active?: boolean
  default: FlagValue | null
  payload: string | null
  overrides: FlagOverride[]
}

const isValue = (value: unknown): value is FlagValue =>
  typeof value === "boolean" || (typeof value === "string" && value.length > 0)

/** Parse `{default?, payload?, overrides?, active?, name?}`; a string is the error. */
export const parseFlagSpec = (body: unknown): FlagSpec | string => {
  if (body === undefined) return { default: null, payload: null, overrides: [] }
  if (!isRecord(body)) return "expected a JSON object"
  const value = body.default ?? body.value
  if (value !== undefined && value !== null && !isValue(value)) {
    return "default must be true, false, a variant string, or null (absent)"
  }
  const overrides: FlagOverride[] = []
  if (body.overrides !== undefined) {
    if (!Array.isArray(body.overrides)) return "overrides must be a list"
    for (const each of body.overrides) {
      if (!isRecord(each)) return "each override is {distinct_id?|email?, value, payload?}"
      const id = each.distinct_id ?? each.distinctId
      const email = each.email
      if (id === undefined && email === undefined) return "each override needs distinct_id or email"
      if (id !== undefined && typeof id !== "string" && typeof id !== "number")
        return "override distinct_id must be a string"
      if (email !== undefined && typeof email !== "string") return "override email must be a string"
      const overrideValue = each.value ?? true
      if (!isValue(overrideValue)) return "override value must be true, false or a variant string"
      overrides.push({
        ...(id !== undefined ? { distinct_id: String(id) } : {}),
        ...(typeof email === "string" ? { email } : {}),
        value: overrideValue,
        ...("payload" in each ? { payload: payloadString(each.payload) } : {}),
      })
    }
  }
  if (body.active !== undefined && typeof body.active !== "boolean") return "active must be boolean"
  if (body.name !== undefined && typeof body.name !== "string") return "name must be a string"
  return {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.active === "boolean" ? { active: body.active } : {}),
    default: value === undefined ? null : (value as FlagValue | null),
    payload: payloadString(body.payload),
    overrides,
  }
}

// ---- The management API's `filters` shape (tooling/feature-flags-cli reads it) ----

type RestGroup = {
  properties: { key: string; type: string; operator: string; value: string[] }[]
  rollout_percentage: number
  variant: string | null
}

/** A flag as `GET /api/projects/{id}/feature_flags/` lists it. */
export const restView = (flag: FlagRecord) => {
  const groups: RestGroup[] = flag.overrides.map((o) => ({
    properties: [
      {
        key: o.distinct_id !== undefined ? "distinct_id" : "email",
        type: "person",
        operator: "exact",
        value: [o.distinct_id ?? o.email ?? ""],
      },
    ],
    rollout_percentage: o.value === false ? 0 : 100,
    variant: typeof o.value === "string" ? o.value : null,
  }))
  if (flag.default !== null) {
    groups.push({
      properties: [],
      rollout_percentage: flag.default === false ? 0 : 100,
      variant: typeof flag.default === "string" ? flag.default : null,
    })
  }
  const variants = [
    ...new Set(
      [flag.default, ...flag.overrides.map((o) => o.value)].filter(
        (v): v is string => typeof v === "string",
      ),
    ),
  ]
  const payloads: Record<string, unknown> = {}
  if (flag.payload !== null) {
    payloads[typeof flag.default === "string" ? flag.default : "true"] = flag.payload
  }
  return {
    id: flag.id,
    key: flag.key,
    name: flag.name,
    active: flag.active,
    deleted: flag.deleted,
    created_at: flag.created_at,
    updated_at: flag.updated_at,
    version: flag.version,
    filters: {
      groups,
      multivariate:
        variants.length > 0
          ? {
              variants: variants.map((key, index) => ({
                key,
                rollout_percentage:
                  Math.floor(100 / variants.length) + (index < 100 % variants.length ? 1 : 0),
              })),
            }
          : null,
      payloads,
    },
  }
}

const propertyValues = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v) => typeof v === "string" || typeof v === "number").map(String)
    : typeof value === "string" || typeof value === "number"
      ? [String(value)]
      : []

/**
 * The flag model a management-API `filters` object describes. Only what evaluates
 * deterministically is kept: `distinct_id` / `email` property groups become overrides; a
 * property-less group at 100 % is the default (at 0 %, or partial, it is `false`); cohort and
 * other property groups are ignored.
 */
export const fromFilters = (
  filters: unknown,
): Pick<FlagSpec, "default" | "payload" | "overrides"> => {
  const record = isRecord(filters) ? filters : {}
  const groups = Array.isArray(record.groups) ? record.groups.filter(isRecord) : []
  const multivariate = isRecord(record.multivariate) ? record.multivariate : undefined
  const variants = Array.isArray(multivariate?.variants)
    ? multivariate.variants.filter(isRecord)
    : []
  const topVariant = [...variants]
    .sort((a, b) => Number(b.rollout_percentage ?? 0) - Number(a.rollout_percentage ?? 0))
    .map((v) => v.key)
    .find((key): key is string => typeof key === "string" && key.length > 0)
  const on = (group: Record<string, unknown>): FlagValue => {
    const rollout = group.rollout_percentage ?? 100
    if (typeof rollout === "number" && rollout <= 0) return false
    if (typeof group.variant === "string" && group.variant) return group.variant
    return topVariant ?? true
  }
  const overrides: FlagOverride[] = []
  let fallback: FlagValue | null = groups.length === 0 ? false : null
  for (const group of groups) {
    const properties = Array.isArray(group.properties) ? group.properties.filter(isRecord) : []
    if (properties.length === 0) {
      const rollout = group.rollout_percentage ?? 100
      const value = typeof rollout === "number" && rollout < 100 ? false : on(group)
      if (fallback === null || fallback === false) fallback = value
      continue
    }
    for (const property of properties) {
      if (property.key !== "distinct_id" && property.key !== "email") continue
      for (const each of propertyValues(property.value)) {
        overrides.push(
          property.key === "distinct_id"
            ? { distinct_id: each, value: on(group) }
            : { email: each, value: on(group) },
        )
      }
    }
  }
  if (fallback === null) fallback = false
  const payloads = isRecord(record.payloads) ? record.payloads : {}
  const rawPayload =
    typeof fallback === "string" && fallback in payloads ? payloads[fallback] : payloads.true
  const payload =
    rawPayload === undefined || rawPayload === null
      ? null
      : typeof rawPayload === "string"
        ? rawPayload
        : JSON.stringify(rawPayload)
  return { default: fallback, payload, overrides }
}
