/** Synthetic lab account layouts for exercising order routing and billing. */
import { type LabAccountInput, type LabAccountRecord, labAccountFromInput } from "./lab-accounts.js"
import { deterministicUuid } from "./state.js"

export const PLATFORM_ACCOUNT_STATES: readonly string[] = ["AZ", "CA", "PA", "TX"]
export const DELEGATED_ACCOUNT_STATES: readonly string[] = ["AZ", "CO", "TX"]

type Preset = Omit<LabAccountInput, "id">

const bioreferencePlatform: Preset = {
  lab: "bioreference",
  account_name: "Example BioReference Account",
  delegated_flow: "not_delegated",
  org_id: null,
  allowed_billing: { client_bill: PLATFORM_ACCOUNT_STATES },
  team_id_allowlist: [],
}
const questPlatform: Preset = {
  lab: "quest",
  account_name: "Example Quest Account",
  delegated_flow: "not_delegated",
  org_id: null,
  allowed_billing: { client_bill: PLATFORM_ACCOUNT_STATES },
  team_id_allowlist: [],
}
const labcorpPlatform: Preset = {
  lab: "labcorp",
  account_name: "Example Labcorp Account",
  delegated_flow: "not_delegated",
  org_id: null,
  allowed_billing: { client_bill: PLATFORM_ACCOUNT_STATES },
  team_id_allowlist: [],
}

const bioreferenceCurrentPlatform: Preset = {
  lab: "bioreference",
  account_name: "Example BioReference Account",
  delegated_flow: "not_delegated",
  org_id: null,
  allowed_billing: { patient_bill_passthrough: ["NJ", "NY"] },
  team_id_allowlist: [],
}
const questSandboxPlatform: Preset = {
  ...questPlatform,
  allowed_billing: {
    client_bill: PLATFORM_ACCOUNT_STATES,
    commercial_insurance: ["AZ", "CA", "NY"],
  },
}
const sonoraQuestProductionPlatform: Preset = {
  lab: "sonora_quest",
  account_name: "Example Sonora Quest Account",
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
  bioreference_current_platform: bioreferenceCurrentPlatform,
  quest_sandbox_platform: questSandboxPlatform,
  sonora_quest_production_platform: sonoraQuestProductionPlatform,
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
export const SYNTHETIC_LAB_ACCOUNT_PRESETS: readonly string[] = Object.keys(LAB_ACCOUNT_PRESETS)

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
