import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import corpus from "./corpus/surveys.json" with { type: "json" }

/** A survey definition, passed through as Formbricks serves it (blocks, elements, endings, …). */
export type Survey = Record<string, unknown> & {
  id: string
  name: string
  type: string
  status: string
  /** `null` for the shared corpus surveys, which every configured workspace serves. */
  workspaceId?: string | null
}

/** A contact (`PUT /__admin/contacts`); `attributes.userId` becomes the response's `contact.userId`. */
export type Contact = { id: string; workspaceId: string | null; attributes: Record<string, string> }

/** One stored response, in Formbricks' `TResponse` shape. */
export type ResponseRecord = {
  id: string
  createdAt: string
  updatedAt: string
  surveyId: string
  workspaceId: string
  displayId: string | null
  contact: { id: string; userId?: string } | null
  contactAttributes: Record<string, string> | null
  finished: boolean
  endingId: string | null
  data: Record<string, unknown>
  variables: Record<string, unknown>
  ttc: Record<string, number>
  tags: unknown[]
  meta: Record<string, unknown>
  singleUseId: string | null
  language: string | null
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Workspace ids that exist and serve the shared corpus surveys. */
  workspaces: string[]
  /** Pre-Formbricks-5 environment ids, each an alias of a workspace (`{envId: workspaceId}`). */
  legacyEnvironmentIds: Record<string, string>
  /** Accepted management API keys; empty means any non-empty `x-api-key` works. */
  apiKeys: string[]
  /** The `webhookId` put in webhook bodies. */
  webhookId: string
  /** Contacts are an Enterprise feature: when off, a response with a `contactId` is 403. */
  contactsEnabled: boolean
}

/** The default workspace every namespace starts with. */
export const WORKSPACE_ID = "cworkspace000000000000001"
/** A legacy environment id that resolves to {@link WORKSPACE_ID} (older SDKs still send one). */
export const ENVIRONMENT_ID = "cenvironment0000000000001"

export const DEFAULT_SETTINGS: Settings = {
  workspaces: [WORKSPACE_ID],
  legacyEnvironmentIds: { [ENVIRONMENT_ID]: WORKSPACE_ID },
  apiKeys: [],
  webhookId: "cwebhook00000000000000001",
  contactsEnabled: false,
}

/** The synthetic survey corpus every namespace is seeded with (`src/corpus/surveys.json`). */
export const CORPUS_SURVEYS: readonly Survey[] = (corpus as unknown as { surveys: Survey[] })
  .surveys

/** The workspace settings block of the environment state (`workspace`, and legacy `project`). */
export const workspaceSettings = (workspaceId: string) => ({
  id: workspaceId,
  recontactDays: 7,
  clickOutsideClose: true,
  overlay: "none",
  placement: "bottomRight",
  inAppSurveyBranding: true,
  styling: { allowStyleOverwrite: true },
})

export class FormbricksState {
  readonly surveys: Collection<Survey>
  readonly responses: Collection<ResponseRecord>
  readonly contacts: Collection<Contact>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { surveys: readonly Survey[]; settings: Partial<Settings> },
  ) {
    this.surveys = new Collection(sqlite, namespace, "surveys")
    this.responses = new Collection(sqlite, namespace, "responses")
    this.contacts = new Collection(sqlite, namespace, "contacts")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "formbricks")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (this.surveys.count() === 0) {
      for (const survey of this.seed.surveys) {
        this.surveys.insert(survey.id, { ...survey, workspaceId: survey.workspaceId ?? null })
      }
    }
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** Formbricks ids are cuid2: lower-case alphanumerics starting with a letter, 25 long. */
  nextId(): string {
    return `c${this.ids.next("", 24).toLowerCase()}`
  }

  /**
   * `resolveClientApiIds`: a workspace id, or a legacy environment id, to its workspace id
   * (`undefined` when neither is known).
   */
  resolveWorkspace(id: string): string | undefined {
    const settings = this.current()
    if (settings.workspaces.includes(id)) return id
    const aliased = settings.legacyEnvironmentIds[id]
    if (aliased !== undefined) return aliased
    return this.allSurveys().some((s) => s.workspaceId === id) ? id : undefined
  }

  /** The v1 `environmentId` of a workspace: its legacy environment id, else its own id. */
  legacyEnvironmentId(workspaceId: string): string {
    const entry = Object.entries(this.current().legacyEnvironmentIds).find(
      ([, target]) => target === workspaceId,
    )
    return entry?.[0] ?? workspaceId
  }

  allSurveys(): Survey[] {
    return this.surveys.list({ order: "oldest" }).map((row) => row.value)
  }

  /** Surveys a workspace serves: its own, plus the shared corpus when it is configured. */
  surveysOf(workspaceId: string): Survey[] {
    return this.allSurveys().filter((s) => this.belongsTo(s, workspaceId))
  }

  /** Whether a survey belongs to a workspace (`survey.workspaceId !== workspaceId` check). */
  belongsTo(survey: Survey, workspaceId: string): boolean {
    return (survey.workspaceId ?? null) === null
      ? this.current().workspaces.includes(workspaceId)
      : survey.workspaceId === workspaceId
  }

  /** `getContact(contactId, workspaceId)`: a contact of that workspace (or a shared one). */
  contactOf(contactId: string, workspaceId: string): Contact | undefined {
    const contact = this.contacts.get(contactId)
    if (!contact) return undefined
    return contact.workspaceId === null || contact.workspaceId === workspaceId ? contact : undefined
  }
}
