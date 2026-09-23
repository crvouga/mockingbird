/**
 * Restrictions the Junction sandbox imposes that production does not. The mock exists
 * to escape them, so every one is off unless a suite asks for it.
 */
import { HttpError } from "@crvouga/mockingbird-service"

/** Key prefixes of sandbox team keys. `corpus pull` and `verify` refuse any other key. */
export const SANDBOX_KEY_PREFIXES = ["sk_us_", "sk_eu_"] as const

export const isSandboxKey = (key: string): boolean =>
  SANDBOX_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))

export type JunctionLimits = {
  /**
   * Live users a team may hold; creating one more answers the sandbox's
   * "maximum of 50 Sandbox users" 400. Deleted users free their slot. `null`: unlimited.
   */
  maxUsers: number | null
  /** Refuse `POST /v3/order/{id}/test` unless the API key is a sandbox key (`sk_us_…`/`sk_eu_…`). */
  simulateRequiresSandbox: boolean
  /** Vendor requests per second per namespace before a 429. `null`: unlimited. */
  rateLimitPerSecond: number | null
}

export type JunctionLimitsInput = {
  [K in keyof JunctionLimits]?: JunctionLimits[K] | undefined
}

/** Every limit off: what a default instance enforces. */
export const DEFAULT_LIMITS: Readonly<JunctionLimits> = {
  maxUsers: null,
  simulateRequiresSandbox: false,
  rateLimitPerSecond: null,
}

/** The 400 the sandbox answers once a team holds its 50th user, byte for byte. */
export const sandboxUserQuotaBody = (max: number) => ({
  detail: {
    error_type: "INVALID_REQUEST",
    error_message: `You have reached the maximum of ${max} Sandbox users`,
  },
})

const positiveOrNull = (value: unknown, field: string): number | null => {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new TypeError(`${field} must be a non-negative integer, or null for unlimited`)
  return value
}

/** Apply `input` over `base`; `undefined` keeps a value, `null` lifts a numeric limit. */
export const mergeLimits = (base: JunctionLimits, input: unknown): JunctionLimits => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("limits must be an object")
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(key in DEFAULT_LIMITS))
      throw new TypeError(`unknown limit ${key}; one of ${Object.keys(DEFAULT_LIMITS).join(", ")}`)
  }
  const next = { ...base }
  if (record.maxUsers !== undefined) next.maxUsers = positiveOrNull(record.maxUsers, "maxUsers")
  if (record.rateLimitPerSecond !== undefined)
    next.rateLimitPerSecond = positiveOrNull(record.rateLimitPerSecond, "rateLimitPerSecond")
  if (record.simulateRequiresSandbox !== undefined) {
    if (typeof record.simulateRequiresSandbox !== "boolean")
      throw new TypeError("simulateRequiresSandbox must be a boolean")
    next.simulateRequiresSandbox = record.simulateRequiresSandbox
  }
  return next
}

/** Throw the sandbox's quota error when one more user would exceed `maxUsers`. */
export const checkUserQuota = (limits: JunctionLimits, liveUsers: number): void => {
  if (limits.maxUsers !== null && liveUsers >= limits.maxUsers)
    throw new HttpError(400, sandboxUserQuotaBody(limits.maxUsers))
}

/**
 * The refusal for a simulate call outside the sandbox. Shape-plausible only: production
 * has not been observed answering it, and the mock never enforces it by default.
 */
export const checkSimulateAllowed = (limits: JunctionLimits, apiKey: string | null): void => {
  if (limits.simulateRequiresSandbox && !isSandboxKey(apiKey ?? ""))
    throw new HttpError(400, { detail: "Order simulation is only available in sandbox" })
}

/** A fixed one-second window of wall time; a frozen mock clock must not stall it. */
export class RateWindow {
  private windowStart = 0
  private count = 0

  /** Whether one more request fits under `perSecond` now. */
  take(perSecond: number | null, nowMs = Date.now()): boolean {
    if (perSecond === null) return true
    if (nowMs - this.windowStart >= 1000) {
      this.windowStart = nowMs
      this.count = 0
    }
    if (this.count >= perSecond) return false
    this.count++
    return true
  }
}
