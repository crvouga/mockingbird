/**
 * Named lab accounts a suite can add in one call, modelled on a real team's recorded
 * listing (a BioReference-linked team, recorded 2026-09-21 from the Junction sandbox).
 *
 * Where a preset copies a recorded account, its states and billing types are the
 * recording's. `bioreference_ny_nj_delegated` is not a recorded account: it is the
 * NY/NJ client-bill shape a consumer asked for, kept because suites depend on it, and
 * listed in `SYNTHETIC_LAB_ACCOUNT_PRESETS`.
 *
 * `*_platform` presets are Junction's own accounts (`org_id: null`, allowlist `[]`); every
 * other active preset is customer-owned (it belongs to an Org and is linked to the team).
 */
import {
  type LabAccountInput,
  type LabAccountRecord,
  labAccountFromInput,
  US_STATES,
} from "./lab-accounts.js"
import { deterministicUuid } from "./state.js"

const except = (...excluded: string[]): readonly string[] =>
  US_STATES.filter((state) => !excluded.includes(state))

/** Junction's own Quest, Labcorp and BioReference accounts client-bill in these 47 states. */
export const PLATFORM_ACCOUNT_STATES: readonly string[] = except("NJ", "NY", "RI")

/** The recorded order-delegated BioReference account: every state but New York and New Jersey. */
export const DELEGATED_ACCOUNT_STATES: readonly string[] = except("NJ", "NY")

type Preset = Omit<LabAccountInput, "id">

const bioreferencePlatform: Preset = {
  lab: "bioreference",
  account_name: "Junction BioReference Account",
  delegated_flow: "not_delegated",
  org_id: null,
  allowed_billing: { client_bill: PLATFORM_ACCOUNT_STATES },
  team_id_allowlist: [],
}
const questPlatform: Preset = {
  lab: "quest",
  account_name: "Junction Quest Account",
  delegated_flow: "not_delegated",
  org_id: null,
  allowed_billing: { client_bill: PLATFORM_ACCOUNT_STATES },
  team_id_allowlist: [],
}
const labcorpPlatform: Preset = {
  lab: "labcorp",
  account_name: "Junction Labcorp Account",
  delegated_flow: "not_delegated",
  org_id: null,
  allowed_billing: { client_bill: PLATFORM_ACCOUNT_STATES },
  team_id_allowlist: [],
}

/**
 * Every preset, without its id. A preset with no `team_id_allowlist` is linked to the
 * configured team; the platform presets carry `[]`, as Junction's own accounts do.
 */
export const LAB_ACCOUNT_PRESETS: Readonly<Record<string, Preset>> = {
  bioreference_ny_nj_delegated: {
    lab: "bioreference",
    delegated_flow: "order_delegated",
    allowed_billing: { client_bill: ["NY", "NJ"] },
  },
  bioreference_delegated_multi_state: {
    lab: "bioreference",
    delegated_flow: "order_delegated",
    allowed_billing: { client_bill: DELEGATED_ACCOUNT_STATES },
  },
  bioreference_platform: bioreferencePlatform,
  bioreference_patient_bill_passthrough: {
    lab: "bioreference",
    delegated_flow: "not_delegated",
    allowed_billing: { patient_bill_passthrough: ["NJ", "NY"] },
  },
  quest_platform: questPlatform,
  labcorp_platform: labcorpPlatform,
  suspended_bioreference: { ...bioreferencePlatform, status: "suspended" },
  suspended_quest: { ...questPlatform, status: "suspended" },
  suspended_labcorp: { ...labcorpPlatform, status: "suspended" },
}

/**
 * Deprecated preset names and the preset each stands for. An alias keeps its own default id,
 * so a suite that pinned `presetAccountId(alias)` still finds its account.
 */
export const LAB_ACCOUNT_PRESET_ALIASES: Readonly<Record<string, string>> = {
  /** Misnamed: the record is Junction's platform account, not a customer-owned one. */
  bioreference_customer_multi_state: "bioreference_platform",
}

/** Presets that model a shape consumers asked for, not an account recorded from a real team. */
export const SYNTHETIC_LAB_ACCOUNT_PRESETS: readonly string[] = ["bioreference_ny_nj_delegated"]

const presetNamed = (name: string): Preset | undefined => {
  const target = Object.hasOwn(LAB_ACCOUNT_PRESET_ALIASES, name)
    ? LAB_ACCOUNT_PRESET_ALIASES[name]
    : name
  return target !== undefined && Object.hasOwn(LAB_ACCOUNT_PRESETS, target)
    ? LAB_ACCOUNT_PRESETS[target]
    : undefined
}

/** A preset's id when none is given: stable across runs and namespaces. */
export const presetAccountId = (name: string): string =>
  deterministicUuid(`junction:lab-account:${name}`)

/** The account a preset adds, or `undefined` for an unknown name. */
export const labAccountFromPreset = (
  name: string,
  options: { id?: string; teamId: string },
): LabAccountRecord | undefined => {
  const preset = presetNamed(name)
  if (!preset) return undefined
  return labAccountFromInput({ ...preset, id: options.id ?? presetAccountId(name) }, options.teamId)
}

/**
 * A lab-account layout as a file or option declares it: a bare list of accounts, or
 * presets (by name, or `{ name, id }`) plus accounts, added in that order.
 */
export type LabAccountLayout =
  | readonly LabAccountInput[]
  | {
      presets?: readonly (string | { name: string; id?: string })[]
      accounts?: readonly LabAccountInput[]
    }

/** Expand a layout into the records it declares. Throws naming the first bad entry. */
export const expandLabAccountLayout = (
  layout: LabAccountLayout,
  teamId: string,
): LabAccountRecord[] => {
  if (Array.isArray(layout))
    return (layout as LabAccountInput[]).map((input) => labAccountFromInput(input, teamId))
  if (typeof layout !== "object" || layout === null)
    throw new TypeError('lab accounts must be an array, or { "presets": [...], "accounts": [...] }')
  const { presets = [], accounts = [] } = layout as Exclude<
    LabAccountLayout,
    readonly LabAccountInput[]
  >
  if (!Array.isArray(presets)) throw new TypeError("presets must be an array of preset names")
  if (!Array.isArray(accounts)) throw new TypeError("accounts must be an array of lab accounts")
  const records: LabAccountRecord[] = []
  for (const entry of presets) {
    const name = typeof entry === "string" ? entry : entry?.name
    const id = typeof entry === "string" ? undefined : entry?.id
    const record =
      typeof name === "string"
        ? labAccountFromPreset(name, { teamId, ...(id !== undefined ? { id } : {}) })
        : undefined
    if (!record)
      throw new TypeError(
        `no lab-account preset ${JSON.stringify(name)}; one of ${Object.keys(LAB_ACCOUNT_PRESETS).join(", ")}`,
      )
    records.push(record)
  }
  for (const input of accounts) records.push(labAccountFromInput(input, teamId))
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id)) throw new TypeError(`lab account ${record.id} is declared twice`)
    seen.add(record.id)
  }
  return records
}
