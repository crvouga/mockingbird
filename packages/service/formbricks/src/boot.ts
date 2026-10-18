import type { ResponseValidation, Settings, Survey } from "./state.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const strings = (value: unknown, where: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${where} must be an array of strings`)
  return value as string[]
}

const KEYS = [
  "workspaces",
  "legacyEnvironmentIds",
  "apiKeys",
  "webhookId",
  "contactsEnabled",
  "validation",
]

/**
 * Check boot settings (`serve --settings`, `MOCKINGBIRD_SETTINGS`, a fleet entry's `settings`):
 * the fields `GET|PUT /__admin/settings` carry, each with its type. Unlike the admin route,
 * which ignores what it does not know, a misspelled key or a wrong type is an error that names
 * the field, so a typo is not mistaken for a setting that took.
 */
export const parseBootSettings = (input: Record<string, unknown>): Partial<Settings> => {
  for (const key of Object.keys(input))
    if (!KEYS.includes(key)) throw new Error(`unknown setting ${JSON.stringify(key)}`)
  const out: Partial<Settings> = {}
  if (input.workspaces !== undefined) out.workspaces = strings(input.workspaces, "workspaces")
  if (input.legacyEnvironmentIds !== undefined) {
    const aliases = input.legacyEnvironmentIds
    if (!isRecord(aliases) || Object.values(aliases).some((id) => typeof id !== "string"))
      throw new Error("legacyEnvironmentIds must be an object of workspace ids by environment id")
    out.legacyEnvironmentIds = aliases as Record<string, string>
  }
  if (input.apiKeys !== undefined) out.apiKeys = strings(input.apiKeys, "apiKeys")
  if (input.webhookId !== undefined) {
    if (typeof input.webhookId !== "string") throw new Error("webhookId must be a string")
    out.webhookId = input.webhookId
  }
  if (input.contactsEnabled !== undefined) {
    if (typeof input.contactsEnabled !== "boolean")
      throw new Error("contactsEnabled must be a boolean")
    out.contactsEnabled = input.contactsEnabled
  }
  if (input.validation !== undefined) {
    if (input.validation !== "present-only" && input.validation !== "finished-validates-all")
      throw new Error('validation must be "present-only" or "finished-validates-all"')
    out.validation = input.validation as ResponseValidation
  }
  return out
}

/**
 * Check a surveys document (a list, or `{surveys: [...]}` as `PUT /__admin/surveys` takes) and
 * give each survey what the admin route gives it: `type` `app`, `status` `inProgress`, and a
 * workspace (`workspaceId`, or the legacy `environmentId` resolved through `legacyEnvironmentIds`).
 * A survey with neither is shared: every configured workspace serves it.
 */
export const parseSurveysDocument = (
  input: unknown,
  legacyEnvironmentIds: Record<string, string> = {},
): Survey[] => {
  const list = Array.isArray(input) ? input : isRecord(input) ? input.surveys : undefined
  if (!Array.isArray(list)) throw new Error("expected [survey] or {surveys: [survey]}")
  return list.map((entry, index): Survey => {
    const where = `surveys[${index}]`
    if (!isRecord(entry)) throw new Error(`${where} must be an object`)
    if (typeof entry.id !== "string" || entry.id === "")
      throw new Error(`${where}.id must be a non-empty string`)
    if (typeof entry.name !== "string") throw new Error(`${where}.name must be a string`)
    const { environmentId, ...rest } = entry
    for (const key of ["workspaceId", "environmentId", "type", "status"])
      if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== "string")
        throw new Error(`${where}.${key} must be a string`)
    const owner = (entry.workspaceId ?? environmentId) as string | null | undefined
    return {
      ...rest,
      id: entry.id,
      name: entry.name,
      type: (entry.type as string | undefined) ?? "app",
      status: (entry.status as string | undefined) ?? "inProgress",
      workspaceId: owner ? (legacyEnvironmentIds[owner] ?? owner) : null,
    }
  })
}

/**
 * Lay `extra` after `base`, skipping a survey whose id is already taken (the first survey with an
 * id wins, so a corpus survey is never overridden and a file's repeats collapse to one).
 */
export const appendSurveys = (base: readonly Survey[], extra: readonly Survey[]): Survey[] => {
  const seen = new Set(base.map((survey) => survey.id))
  const out = [...base]
  for (const survey of extra) {
    if (seen.has(survey.id)) continue
    seen.add(survey.id)
    out.push(survey)
  }
  return out
}
