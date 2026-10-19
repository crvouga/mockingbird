import { BILLING_TYPES, type BillingType, US_STATES } from "./lab-accounts.js"

export type LabAccountProfile = "native" | "expected-contract" | "sandbox-observed" | "observed"
/** Which vendor environment an `observed` configuration reproduces. */
export type LabAccountOracle = "sandbox" | "production"
/**
 * How an order that omits `lab_account_id` and resolves to a Junction-owned (`org_id: null`)
 * account treats that account's listed `allowed_billing`: `listed` (default) enforces it,
 * `unchecked` skips the billing/state check (#467). Explicit account selection is unaffected.
 */
export type OmittedAccountBilling = "listed" | "unchecked"
export type LabAccountSandboxPolicy = {
  /** Explicit billing refusals observed for this particular fixture/account. */
  rejectBilling?: Partial<Record<BillingType, string>>
  /** Explicit billing/state exceptions observed for this particular fixture/account. */
  allowBilling?: Partial<Record<BillingType, readonly string[]>>
}
export type LabAccountBehavior = {
  profile: LabAccountProfile
  /**
   * The oracle the observations reproduce. `sandbox-observed` is the alias of `observed`
   * with `oracle: "sandbox"`; `native` and `expected-contract` have none.
   */
  oracle?: LabAccountOracle
  accounts: Record<string, LabAccountSandboxPolicy>
  /** Lab slug → omitted-account billing policy; unlisted labs are `listed`. */
  omittedAccountBilling?: Record<string, OmittedAccountBilling>
}
/** Whether the profile applies account-owned observations (`observed`, or its alias). */
export const isObservedProfile = (behavior: Pick<LabAccountBehavior, "profile">): boolean =>
  behavior.profile === "sandbox-observed" || behavior.profile === "observed"
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
export function labAccountBehaviorFrom(input: unknown): LabAccountBehavior {
  if (
    !record(input) ||
    !["native", "expected-contract", "sandbox-observed", "observed"].includes(String(input.profile))
  )
    throw new TypeError(
      "lab account profile must be native, expected-contract, observed or sandbox-observed",
    )
  const profile = input.profile as LabAccountProfile
  let oracle: LabAccountOracle | undefined
  if (profile === "observed") {
    if (input.oracle !== "sandbox" && input.oracle !== "production")
      throw new TypeError('the observed profile needs oracle "sandbox" or "production"')
    oracle = input.oracle
  } else if (profile === "sandbox-observed") {
    if (input.oracle !== undefined && input.oracle !== "sandbox")
      throw new TypeError(
        'sandbox-observed reproduces the sandbox; use profile "observed" with oracle "production"',
      )
    oracle = "sandbox"
  } else if (input.oracle !== undefined)
    throw new TypeError("oracle applies only to the observed profile")
  const omitted = input.omittedAccountBilling ?? {}
  if (!record(omitted))
    throw new TypeError("omittedAccountBilling must map lab slugs to listed or unchecked")
  const omittedAccountBilling: Record<string, OmittedAccountBilling> = {}
  for (const [lab, policy] of Object.entries(omitted)) {
    if (!lab.trim() || (policy !== "listed" && policy !== "unchecked"))
      throw new TypeError("omittedAccountBilling must map lab slugs to listed or unchecked")
    omittedAccountBilling[lab.trim().toLowerCase()] = policy
  }
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
  return {
    profile,
    ...(oracle !== undefined ? { oracle } : {}),
    accounts: out,
    omittedAccountBilling,
  }
}
