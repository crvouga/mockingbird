import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import prodClone from "./corpus/prod-clone.json" with { type: "json" }

/** A survey definition, passed through as Formbricks serves it (blocks, elements, logic, …). */
export type Survey = Record<string, unknown> & {
  id: string
  name: string
  type: string
  status: string
  /** `null` for the shared fixture surveys, which every configured environment serves. */
  environmentId?: string | null
}

/** One stored response, in Formbricks' `TResponse` shape. */
export type ResponseRecord = {
  id: string
  createdAt: string
  updatedAt: string
  surveyId: string
  environmentId: string
  displayId: string | null
  contact: { id: string; userId: string } | null
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
  /** Environment ids that serve the shared fixture surveys. */
  environments: string[]
  /** Accepted management API keys; empty means any non-empty `x-api-key` works. */
  apiKeys: string[]
  /** The `webhookId` put in webhook bodies. */
  webhookId: string
  /** Whether a `userId` on a response finds-or-creates a contact (the fork's behaviour). */
  contactsEnabled: boolean
}

/** Our member-app production and development Formbricks environments. */
export const PRODUCTION_ENVIRONMENT_ID = "cmlhiza9j0009lj01my5c1g0q"
export const DEVELOPMENT_ENVIRONMENT_ID = "cmlhiza9c0004lj01jbuhp0nz"

export const DEFAULT_SETTINGS: Settings = {
  environments: [PRODUCTION_ENVIRONMENT_ID, DEVELOPMENT_ENVIRONMENT_ID],
  apiKeys: [],
  webhookId: "cm0mockingbirdwebhook0001",
  contactsEnabled: true,
}

/**
 * The committed clone of our production survey definitions
 * (`packages/forms-fixtures/formbricks/prod-clone.json` in geviti-monorepo).
 */
export const PROD_CLONE_SURVEYS: readonly Survey[] = (prodClone as unknown as { surveys: Survey[] })
  .surveys

export const PROD_CLONE_EXPORTED_AT: string = (prodClone as { exportedAt: string }).exportedAt

/** The project block of the environment state (as the backend's compat shim serves it). */
export const PROJECT = {
  id: "cmlhiza930003lj01jz0hfnkz",
  recontactDays: 7,
  clickOutsideClose: true,
  overlay: "none",
  placement: "bottomRight",
  inAppSurveyBranding: true,
  styling: { brandColor: { light: "#64748b" }, allowStyleOverwrite: true },
}

export class FormbricksState {
  readonly surveys: Collection<Survey>
  readonly responses: Collection<ResponseRecord>
  readonly contacts: Collection<{ id: string; environmentId: string; userId: string }>
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
        this.surveys.insert(survey.id, { ...survey, environmentId: survey.environmentId ?? null })
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

  knownEnvironment(environmentId: string): boolean {
    return (
      this.current().environments.includes(environmentId) ||
      this.allSurveys().some((s) => s.environmentId === environmentId)
    )
  }

  allSurveys(): Survey[] {
    return this.surveys.list({ order: "oldest" }).map((row) => row.value)
  }

  /** Surveys an environment serves: its own, plus the shared fixture when it is configured. */
  surveysOf(environmentId: string): Survey[] {
    const shared = this.current().environments.includes(environmentId)
    return this.allSurveys().filter(
      (s) => s.environmentId === environmentId || (shared && (s.environmentId ?? null) === null),
    )
  }

  /** Whether a survey belongs to an environment (the fork's `survey.environmentId` check). */
  belongsTo(survey: Survey, environmentId: string): boolean {
    return (survey.environmentId ?? null) === null
      ? this.current().environments.includes(environmentId)
      : survey.environmentId === environmentId
  }

  /** The fork's find-or-create contact for a response `userId` (the member's email). */
  contactFor(environmentId: string, userId: string): { id: string; userId: string } {
    const found = this.contacts
      .list({ where: (c) => c.environmentId === environmentId && c.userId === userId })
      .at(0)?.value
    if (found) return { id: found.id, userId: found.userId }
    const created = { id: this.nextId(), environmentId, userId }
    this.contacts.insert(created.id, created)
    return { id: created.id, userId }
  }
}
