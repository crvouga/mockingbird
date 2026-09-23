import { invalidRequest } from "./errors.js"
import type { StripeState } from "./state.js"

type Expander = (state: StripeState, id: string) => Promise<Record<string, unknown> | undefined>

const expanders = new Map<string, Expander>()

/** Field name (customer, latest_charge, …) to a renderer. Registered from index to avoid cycles. */
export const registerExpander = (field: string, expander: Expander) => {
  expanders.set(field, expander)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const expandPath = async (
  state: StripeState,
  value: Record<string, unknown>,
  segments: string[],
  full: string,
): Promise<Record<string, unknown>> => {
  const [head, ...rest] = segments
  if (head === undefined) return value
  if (head === "data" && Array.isArray(value.data)) {
    const data = []
    for (const item of value.data) {
      data.push(isRecord(item) ? await expandPath(state, item, rest, full) : item)
    }
    return { ...value, data }
  }
  const current = value[head]
  if (rest.length === 0) {
    if (typeof current !== "string") return value
    const expander = expanders.get(head)
    if (!expander) throw invalidRequest(`This property cannot be expanded (${full}).`, "expand")
    const expanded = await expander(state, current)
    return expanded ? { ...value, [head]: expanded } : value
  }
  if (!isRecord(current)) return value
  return { ...value, [head]: await expandPath(state, current, rest, full) }
}

/** Replace id strings named in `expand` with the rendered objects SDKs request. */
export const expandObject = async (
  state: StripeState,
  expand: unknown,
  value: Record<string, unknown>,
) => {
  if (!Array.isArray(expand)) return value
  let current = value
  for (const path of expand) {
    if (typeof path !== "string" || path === "") continue
    current = await expandPath(state, current, path.split("."), path)
  }
  return current
}
