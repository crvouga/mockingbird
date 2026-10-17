import { BILLING_TYPES, type BillingType, US_STATES } from "./lab-accounts.js"

export type LabAccountProfile = "native" | "expected-contract" | "sandbox-observed"
export type LabAccountSandboxPolicy = {
  /** Explicit billing refusals observed for this particular fixture/account. */
  rejectBilling?: Partial<Record<BillingType, string>>
  /** Explicit billing/state exceptions observed for this particular fixture/account. */
  allowBilling?: Partial<Record<BillingType, readonly string[]>>
}
export type LabAccountBehavior = {
  profile: LabAccountProfile
  accounts: Record<string, LabAccountSandboxPolicy>
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
export function labAccountBehaviorFrom(input: unknown): LabAccountBehavior {
  if (
    !record(input) ||
    !["native", "expected-contract", "sandbox-observed"].includes(String(input.profile))
  )
    throw new TypeError("lab account profile must be native, expected-contract or sandbox-observed")
  const accounts = input.accounts ?? {}
  if (!record(accounts)) throw new TypeError("lab account behavior accounts must be an object")
  const out: Record<string, LabAccountSandboxPolicy> = {}
  for (const [id, raw] of Object.entries(accounts)) {
    if (
      !id ||
      !record(raw) ||
      Object.keys(raw).some((k) => k !== "rejectBilling" && k !== "allowBilling")
    )
      throw new TypeError("invalid lab account sandbox policy")
    const policy: LabAccountSandboxPolicy = {}
    for (const field of ["rejectBilling", "allowBilling"] as const) {
      if (raw[field] === undefined) continue
      if (!record(raw[field]))
        throw new TypeError(`${field} must map billing types to observations`)
      for (const [type, value] of Object.entries(raw[field])) {
        if (!(BILLING_TYPES as readonly string[]).includes(type))
          throw new TypeError("unknown billing type in sandbox policy")
        if (field === "rejectBilling") {
          if (typeof value !== "string" || !value.trim())
            throw new TypeError("billing rejection needs a detail string")
          policy.rejectBilling ??= {}
          policy.rejectBilling[type as BillingType] = value
        } else {
          if (
            !Array.isArray(value) ||
            !value.every((v) => typeof v === "string" && US_STATES.includes(v))
          )
            throw new TypeError("billing exceptions need US state codes")
          policy.allowBilling ??= {}
          policy.allowBilling[type as BillingType] = [...value]
        }
      }
    }
    out[id] = policy
  }
  return { profile: input.profile as LabAccountProfile, accounts: out }
}
