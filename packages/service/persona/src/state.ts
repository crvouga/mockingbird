import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type InquiryStatus =
  | "created"
  | "pending"
  | "completed"
  | "approved"
  | "declined"
  | "needs_review"
  | "failed"
  | "expired"

/**
 * One inquiry as Persona tracks it. Prefill `fields` are kept because Persona echoes them
 * back on reads; they never reach the request journal.
 */
export type InquiryRecord = {
  id: string
  status: InquiryStatus
  reference_id: string | null
  template_id: string
  redirect_uri: string | null
  note: string | null
  platform: string | null
  fields: Record<string, string>
  created_at: string
  started_at: string | null
  completed_at: string | null
  failed_at: string | null
  decisioned_at: string | null
  expired_at: string | null
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these API keys are accepted; empty means any bearer token is. */
  apiKeys: string[]
  /** Only these inquiry template ids exist; empty means any `itmpl_…` / `tmpl_…` id does. */
  templates: string[]
}

export const DEFAULT_SETTINGS: Settings = { apiKeys: [], templates: [] }

export class PersonaState {
  readonly inquiries: Collection<InquiryRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { settings: Partial<Settings> },
  ) {
    this.inquiries = new Collection(sqlite, namespace, "inquiries")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "persona")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
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

  /** `inq_` + 24 opaque characters, as Persona's ids look. */
  nextInquiryId(): string {
    return this.ids.next("inq_", 24)
  }

  nextEventId(): string {
    return this.ids.next("evt_", 24)
  }
}
