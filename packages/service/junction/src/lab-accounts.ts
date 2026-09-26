/**
 * Team-level lab-account fixtures.
 *
 * Mirrors https://docs.junction.com/lab/overview/lab-accounts for a team-scoped API key:
 * the `ClientFacingLabAccount` shape, the account filters, the selection when
 * `lab_account_id` is omitted (as the sandbox applies it, see `selectLabAccount`), and the
 * `allowed_billing` rules.
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

export type BillingType = (typeof BILLING_TYPES)[number]

/**
 * Validate a lab slug → `billing_type` map: the billing type `create_order` evaluates for
 * that lab when the request omits `billing_type`. Junction documents `client_bill` as the
 * default, but a sandbox team was observed evaluating BioReference orders as
 * `patient_bill_passthrough`, so it is configurable per lab.
 */
export const defaultBillingTypesFrom = (input: unknown): Record<string, BillingType> => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("default billing types must map lab slugs to billing types")
  const out: Record<string, BillingType> = {}
  for (const [lab, type] of Object.entries(input)) {
    if (lab.trim() === "") throw new TypeError("default billing types: lab slug is empty")
    if (!(BILLING_TYPES as readonly unknown[]).includes(type))
      throw new TypeError(
        `default billing type for ${lab}: ${String(type)} is not a billing type (${BILLING_TYPES.join(", ")})`,
      )
    out[lab.trim().toLowerCase()] = type as BillingType
  }
  return out
}

export const LAB_ACCOUNT_STATUSES: readonly LabAccountStatus[] = [
  "active",
  "pending",
  "suspended",
  "ready_to_launch",
]

export const MOCK_ORG_ID = deterministicUuid("junction:org:mock")

/** A team the mock is not, for fixtures that model another team's account. */
export const OTHER_TEAM_ID = deterministicUuid("junction:team:other")

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
  // Exactly one active account linked for `quest`; the commercial-insurance state rule
  // lives on this account.
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
  // Several active accounts linked for `nexus`: an omitted id selects the first.
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
  // Linked accounts, none active.
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
    team_id_allowlist: [OTHER_TEAM_ID],
  }),
]

/** Every lab slug in the team lab inventory — these labs have a Junction platform account. */
export const PLATFORM_ACCOUNT_LABS: readonly string[] = TEAM_LABS.map((lab) => String(lab.slug))

/** Every caller passes the live list (`state.listLabAccounts()`), never the fixtures. */
export const labAccountById = (
  id: string,
  accounts: readonly LabAccountRecord[],
): LabAccountRecord | undefined => accounts.find((entry) => entry.id === id)

/**
 * Whether `teamId` may use an account. An empty `team_id_allowlist` counts as linked:
 * a real team's listing returns such accounts (Junction's own Quest, Labcorp and
 * BioReference accounts carry `[]`), and the sandbox places an order that names one by id
 * (corpus/lab-account-probes.json), so the mock treats them as the team's.
 */
export const isLinkedToTeam = (entry: LabAccountRecord, teamId: string): boolean =>
  entry.team_id_allowlist.length === 0 || entry.team_id_allowlist.includes(teamId)

/** Team-linked accounts for a lab, in configured order. */
export const linkedLabAccounts = (
  labSlug: string,
  teamId: string,
  accounts: readonly LabAccountRecord[],
): LabAccountRecord[] =>
  accounts.filter((entry) => entry.lab === labSlug && isLinkedToTeam(entry, teamId))

export const effectiveBilling = (
  account: LabAccountRecord | "platform",
): Record<string, readonly string[]> =>
  account === "platform" ? PLATFORM_BILLING : account.allowed_billing

/**
 * The selection rules as the sandbox applies them. An explicit id must exist, be linked to
 * the team and be active; the sandbox does **not** require it to belong to the ordered lab
 * (recorded in corpus/lab-account-probes.json: a Labcorp test ordered through Junction's
 * BioReference account was placed), although the lab-accounts guide says it must. With no id,
 * one active linked account for the lab is selected, several select the first in listing
 * order (a sandbox team with several was observed placing such an order, where the guide says
 * it "may be rejected"), and a lab with none falls back to Junction's platform account.
 */
export const selectLabAccount = (
  labSlug: string,
  requestedId: string | null,
  teamId: string,
  accounts: readonly LabAccountRecord[],
): LabAccountRecord | "platform" => {
  if (requestedId !== null) {
    const linked = labAccountById(requestedId, accounts)
    if (!linked) throw new HttpError(400, { detail: "Lab account does not exist" })
    if (!isLinkedToTeam(linked, teamId))
      throw new HttpError(400, { detail: "Lab account is not linked to your team" })
    if (linked.status !== "active")
      throw new HttpError(400, { detail: "Lab account is not active" })
    return linked
  }
  const candidates = linkedLabAccounts(labSlug, teamId, accounts)
  if (candidates.length === 0) {
    if (PLATFORM_ACCOUNT_LABS.includes(labSlug)) return "platform"
    throw new HttpError(400, { detail: `No active lab account is available for lab ${labSlug}` })
  }
  const active = candidates.find((entry) => entry.status === "active")
  if (active) return active
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

/**
 * A lab account as a consumer configures it. Mirrors `ClientFacingLabAccount`, with
 * every field but `id` and `lab` optional, plus a `states` shorthand for the common
 * case of an account that client-bills in a fixed set of states.
 */
export type LabAccountInput = {
  id: string
  /** Lab slug, e.g. `"quest"`, `"labcorp"`, `"bioreference"`. */
  lab: string
  status?: LabAccountStatus
  delegated_flow?: LabAccountDelegatedFlow
  account_name?: string | null
  provider_account_id?: string
  org_id?: string | null
  business_units?: string[] | null
  default_clinical_notes?: string | null
  /** Billing type → states it is allowed in. Takes precedence over `states`. */
  allowed_billing?: Record<string, readonly string[]>
  /** Shorthand for `allowed_billing: { client_bill: states }`. Default: every state. */
  states?: readonly string[]
  /** Teams the account is linked to. Default: the configured team, so it is selectable. */
  team_id_allowlist?: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const DELEGATED_FLOWS: readonly LabAccountDelegatedFlow[] = [
  "order_delegated",
  "result_delegated",
  "fully_delegated",
  "not_delegated",
]

const checkStates = (value: unknown, where: string): void => {
  if (!Array.isArray(value)) throw new TypeError(`${where} must be an array of US state codes`)
  for (const state of value) {
    if (typeof state !== "string" || !US_STATES.includes(state))
      throw new TypeError(`${where}: ${String(state)} is not a US state code`)
  }
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...(value as string[])]
    : undefined

/**
 * Normalize a consumer's configuration into the record the ordering rules read.
 * `teamId` is the default allowlist, so an account is selectable unless told otherwise.
 */
export const labAccountFromInput = (
  input: LabAccountInput,
  teamId: string = MOCK_TEAM_ID,
): LabAccountRecord => {
  if (!isRecord(input)) throw new TypeError("lab account must be an object")
  if (typeof input.id !== "string" || input.id === "")
    throw new TypeError("lab account needs a non-empty id")
  const where = `lab account ${input.id}`
  if (typeof input.lab !== "string" || input.lab === "")
    throw new TypeError(`${where}: lab must be a lab slug such as "quest"`)
  if (input.status !== undefined && !LAB_ACCOUNT_STATUSES.includes(input.status))
    throw new TypeError(`${where}: status must be one of ${LAB_ACCOUNT_STATUSES.join(", ")}`)
  if (input.delegated_flow !== undefined && !DELEGATED_FLOWS.includes(input.delegated_flow))
    throw new TypeError(`${where}: delegated_flow must be one of ${DELEGATED_FLOWS.join(", ")}`)
  if (input.states !== undefined) checkStates(input.states, `${where}: states`)
  if (input.allowed_billing !== undefined) {
    if (!isRecord(input.allowed_billing))
      throw new TypeError(`${where}: allowed_billing must map billing types to state lists`)
    for (const [type, states] of Object.entries(input.allowed_billing)) {
      if (!(BILLING_TYPES as readonly string[]).includes(type))
        throw new TypeError(
          `${where}: allowed_billing.${type} is not a billing type (${BILLING_TYPES.join(", ")})`,
        )
      checkStates(states, `${where}: allowed_billing.${type}`)
    }
  }
  if (input.team_id_allowlist !== undefined && stringList(input.team_id_allowlist) === undefined)
    throw new TypeError(`${where}: team_id_allowlist must be an array of team ids`)
  if (input.business_units != null && stringList(input.business_units) === undefined)
    throw new TypeError(`${where}: business_units must be an array of strings or null`)
  for (const field of [
    "account_name",
    "provider_account_id",
    "org_id",
    "default_clinical_notes",
  ] as const) {
    const value = input[field]
    if (value != null && typeof value !== "string")
      throw new TypeError(`${where}: ${field} must be a string`)
  }
  return {
    id: input.id,
    lab: input.lab.toLowerCase(),
    org_id: input.org_id === undefined ? MOCK_ORG_ID : input.org_id,
    status: input.status ?? "active",
    delegated_flow: input.delegated_flow ?? "not_delegated",
    provider_account_id:
      input.provider_account_id ?? opaqueToken(`junction:lab-account-provider:${input.id}`, 16),
    account_name: input.account_name ?? null,
    default_clinical_notes: input.default_clinical_notes ?? null,
    business_units: input.business_units ?? null,
    allowed_billing: input.allowed_billing ?? { client_bill: input.states ?? ALL_BILLING_STATES },
    team_id_allowlist: input.team_id_allowlist ?? [teamId],
  }
}

/**
 * Merge `patch` onto a stored account. `states` replaces only the `client_bill` states,
 * so an account's other billing types survive a state change.
 */
export const patchLabAccount = (
  existing: LabAccountRecord,
  patch: Partial<LabAccountInput>,
  teamId: string,
): LabAccountRecord => {
  if (!isRecord(patch)) throw new TypeError("lab account patch must be an object")
  if (patch.id !== undefined && patch.id !== existing.id)
    throw new TypeError(`lab account ${existing.id}: id cannot be changed`)
  const { states, ...rest } = patch
  if (states !== undefined) checkStates(states, `lab account ${existing.id}: states`)
  const allowed_billing =
    rest.allowed_billing ??
    (states !== undefined
      ? { ...existing.allowed_billing, client_bill: states }
      : existing.allowed_billing)
  return labAccountFromInput(
    {
      ...existing,
      business_units: existing.business_units,
      ...rest,
      id: existing.id,
      allowed_billing,
    },
    teamId,
  )
}

/**
 * Read a `ClientFacingLabAccount` from a real team's listing (a pulled corpus).
 *
 * With `recordedTeamId` (a corpus that recorded its team) the allowlist is kept verbatim,
 * so an account the real team is not linked to stays unlinked. Without it (a version-1
 * corpus) the mock cannot tell, so each account is linked to the mock team as well — the
 * recorded ids are kept alongside, never replaced.
 */
export const labAccountFromClientFacing = (
  value: Record<string, unknown>,
  recordedTeamId?: string,
): LabAccountRecord | undefined => {
  if (typeof value.id !== "string" || typeof value.lab !== "string") return undefined
  const billing: Record<string, readonly string[]> = {}
  if (isRecord(value.allowed_billing)) {
    for (const [type, states] of Object.entries(value.allowed_billing)) {
      const list = stringList(states)
      if (list) billing[type] = list
    }
  }
  const allowlist = stringList(value.team_id_allowlist) ?? []
  return {
    id: value.id,
    lab: value.lab.toLowerCase(),
    org_id: typeof value.org_id === "string" ? value.org_id : null,
    status: LAB_ACCOUNT_STATUSES.includes(value.status as LabAccountStatus)
      ? (value.status as LabAccountStatus)
      : "active",
    delegated_flow:
      typeof value.delegated_flow === "string"
        ? (value.delegated_flow as LabAccountDelegatedFlow)
        : "not_delegated",
    provider_account_id:
      typeof value.provider_account_id === "string"
        ? value.provider_account_id
        : opaqueToken(`junction:lab-account-provider:${value.id}`, 16),
    account_name: typeof value.account_name === "string" ? value.account_name : null,
    default_clinical_notes:
      typeof value.default_clinical_notes === "string" ? value.default_clinical_notes : null,
    business_units: stringList(value.business_units) ?? null,
    allowed_billing: billing,
    team_id_allowlist:
      recordedTeamId !== undefined || allowlist.includes(MOCK_TEAM_ID)
        ? allowlist
        : [...allowlist, MOCK_TEAM_ID],
  }
}
