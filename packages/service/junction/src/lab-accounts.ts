/**
 * Team-level lab-account fixtures.
 *
 * Mirrors https://docs.junction.com/lab/overview/lab-accounts for a team-scoped API key:
 * the `ClientFacingLabAccount` shape, the account filters, the four documented selection
 * branches when `lab_account_id` is omitted, and the `allowed_billing` rules.
 *
 * No fixture is placed on `ussl` — an account there would flip that lab from the
 * platform branch to the linked branches and change shipped order behavior. The
 * branch-fixture labs (`nexus`, `mtl`, `crl`, `ihd`) have no catalog lab tests, so the
 * property suite seeds synthetic tests for them.
 */
import { HttpError, opaqueToken } from "@crvouga/mockingbird-service"
import { TEAM_LABS } from "./catalog.js"
import { deterministicUuid, MOCK_TEAM_ID } from "./state.js"

export type LabAccountStatus = "active" | "pending" | "suspended" | "ready_to_launch"
export type LabAccountDelegatedFlow =
  | "order_delegated"
  | "result_delegated"
  | "fully_delegated"
  | "not_delegated"

export type LabAccountRecord = {
  id: string
  lab: string
  org_id: string | null
  status: LabAccountStatus
  delegated_flow: LabAccountDelegatedFlow
  provider_account_id: string
  account_name: string | null
  default_clinical_notes: string | null
  business_units: string[] | null
  allowed_billing: Record<string, readonly string[]>
  team_id_allowlist: readonly string[]
}

/** The 50 `USState` values from the docs, alphabetical by state name. */
export const US_STATES: readonly string[] = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]

export const ALL_BILLING_STATES: readonly string[] = US_STATES

/** `billing_type` values the vendored create-order body accepts. */
export const BILLING_TYPES = [
  "client_bill",
  "commercial_insurance",
  "patient_bill_passthrough",
  "patient_bill",
  "upfront_payment",
] as const

export const LAB_ACCOUNT_STATUSES: readonly LabAccountStatus[] = [
  "active",
  "pending",
  "suspended",
  "ready_to_launch",
]

export const MOCK_ORG_ID = deterministicUuid("junction:org:mock")

/** Junction platform accounts support every billing type in every state. */
const PLATFORM_BILLING: Record<string, readonly string[]> = Object.fromEntries(
  BILLING_TYPES.map((type) => [type, ALL_BILLING_STATES]),
)

const CLIENT_BILL_ONLY: Record<string, readonly string[]> = { client_bill: ALL_BILLING_STATES }

const account = (
  key: string,
  lab: string,
  fields: Pick<LabAccountRecord, "status" | "allowed_billing" | "team_id_allowlist"> &
    Partial<Pick<LabAccountRecord, "account_name" | "business_units" | "org_id">>,
): LabAccountRecord => ({
  id: deterministicUuid(`junction:lab-account:${key}`),
  lab,
  org_id: fields.org_id ?? MOCK_ORG_ID,
  status: fields.status,
  delegated_flow: "not_delegated",
  provider_account_id: opaqueToken(`junction:lab-account-provider:${key}`, 16),
  account_name: fields.account_name ?? null,
  default_clinical_notes: null,
  business_units: fields.business_units ?? null,
  allowed_billing: fields.allowed_billing,
  team_id_allowlist: fields.team_id_allowlist,
})

export const TEAM_LAB_ACCOUNTS: readonly LabAccountRecord[] = [
  // Branch 2: exactly one active account linked for `quest`; the commercial-insurance
  // state rule lives on this account.
  account("quest-primary", "quest", {
    status: "active",
    account_name: "Quest Diagnostics — primary",
    business_units: ["core", "specialty"],
    allowed_billing: {
      client_bill: ALL_BILLING_STATES,
      commercial_insurance: ["AZ", "CA"],
    },
    team_id_allowlist: [MOCK_TEAM_ID],
  }),
  // Listed but never selected; exercises `status` filters and the explicit-id rejection.
  account("quest-pending", "quest", {
    status: "pending",
    account_name: "Quest Diagnostics — pending",
    allowed_billing: CLIENT_BILL_ONLY,
    team_id_allowlist: [MOCK_TEAM_ID],
  }),
  // Branch 3: multiple active accounts linked for `nexus`.
  account("nexus-a", "nexus", {
    status: "active",
    account_name: "Nexus — A",
    allowed_billing: CLIENT_BILL_ONLY,
    team_id_allowlist: [MOCK_TEAM_ID],
  }),
  account("nexus-b", "nexus", {
    status: "active",
    account_name: "Nexus — B",
    allowed_billing: CLIENT_BILL_ONLY,
    team_id_allowlist: [MOCK_TEAM_ID],
  }),
  // Branch 4: linked accounts, none active.
  account("mtl-suspended", "mtl", {
    status: "suspended",
    account_name: "Molecular Testing Labs — suspended",
    allowed_billing: CLIENT_BILL_ONLY,
    team_id_allowlist: [MOCK_TEAM_ID],
  }),
  account("mtl-pending", "mtl", {
    status: "pending",
    allowed_billing: CLIENT_BILL_ONLY,
    team_id_allowlist: [MOCK_TEAM_ID],
  }),
  // `status` filter coverage for the enum's last value.
  account("crl-ready", "crl", {
    status: "ready_to_launch",
    allowed_billing: CLIENT_BILL_ONLY,
    team_id_allowlist: [MOCK_TEAM_ID],
  }),
  // Org-owned account of another team: absent from the team listing, rejected when used.
  account("ihd-other-team", "ihd", {
    status: "active",
    account_name: "IHD — other team",
    allowed_billing: CLIENT_BILL_ONLY,
    team_id_allowlist: [],
  }),
]

/** Every lab slug in the team lab inventory — these labs have a Junction platform account. */
export const PLATFORM_ACCOUNT_LABS: readonly string[] = TEAM_LABS.map((lab) => String(lab.slug))

export const labAccountById = (id: string): LabAccountRecord | undefined =>
  TEAM_LAB_ACCOUNTS.find((entry) => entry.id === id)

/** Team-linked accounts for a lab, in fixture order. */
export const linkedLabAccounts = (labSlug: string, teamId: string): LabAccountRecord[] =>
  TEAM_LAB_ACCOUNTS.filter(
    (entry) => entry.lab === labSlug && entry.team_id_allowlist.includes(teamId),
  )

export const effectiveBilling = (
  account: LabAccountRecord | "platform",
): Record<string, readonly string[]> =>
  account === "platform" ? PLATFORM_BILLING : account.allowed_billing

/**
 * The documented selection rules, in order: an explicit id must exist, be linked to the
 * team, match the ordered lab and be active; with no id, linked accounts are evaluated
 * against the four documented branches.
 */
export const selectLabAccount = (
  labSlug: string,
  requestedId: string | null,
  teamId: string,
): LabAccountRecord | "platform" => {
  if (requestedId !== null) {
    const linked = labAccountById(requestedId)
    if (!linked) throw new HttpError(400, { detail: "Lab account does not exist" })
    if (!linked.team_id_allowlist.includes(teamId))
      throw new HttpError(400, { detail: "Lab account is not linked to your team" })
    if (linked.lab !== labSlug)
      throw new HttpError(400, { detail: `Lab account is not associated with lab ${labSlug}` })
    if (linked.status !== "active")
      throw new HttpError(400, { detail: "Lab account is not active" })
    return linked
  }
  const candidates = linkedLabAccounts(labSlug, teamId)
  if (candidates.length === 0) {
    if (PLATFORM_ACCOUNT_LABS.includes(labSlug)) return "platform"
    throw new HttpError(400, { detail: `No active lab account is available for lab ${labSlug}` })
  }
  const active = candidates.filter((entry) => entry.status === "active")
  if (active.length === 1) return active[0] as LabAccountRecord
  if (active.length > 1)
    throw new HttpError(400, {
      detail:
        "Multiple active lab accounts are linked to your team for this lab; provide lab_account_id",
    })
  throw new HttpError(400, { detail: "No active lab account is available for this lab" })
}

/** Render only the documented `ClientFacingLabAccount` keys. */
export const renderLabAccount = (entry: LabAccountRecord): Record<string, unknown> => ({
  id: entry.id,
  lab: entry.lab,
  org_id: entry.org_id,
  status: entry.status,
  delegated_flow: entry.delegated_flow,
  provider_account_id: entry.provider_account_id,
  account_name: entry.account_name,
  default_clinical_notes: entry.default_clinical_notes,
  business_units: entry.business_units === null ? null : [...entry.business_units],
  allowed_billing: Object.fromEntries(
    Object.entries(entry.allowed_billing).map(([type, states]) => [type, [...states]]),
  ),
  team_id_allowlist: [...entry.team_id_allowlist],
})
