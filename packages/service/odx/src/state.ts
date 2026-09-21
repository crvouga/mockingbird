import { Collection, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { ImportLog, ResultElement } from "./results.js"

/** A practice patient as `OdxPatient` (our consumer's type) plus the partner (our) user id. */
export type PatientRecord = {
  patientId: number
  practiceId: string
  createdDate: string
  lastUpdatedDate: string
  userTitle: string | null
  userFirstName: string | null
  userLastName: string | null
  firstName: string
  lastName: string
  nickname: string | null
  dateOfBirth: string | null
  gender: string
  homePhone: string | null
  workPhone: string | null
  mobile: string | null
  email: string
  address: string | null
  address2: string | null
  address3: string | null
  city: string | null
  province: string | null
  postalCode: string | null
  country: string | null
  userId: string | null
  workspaceId: number
  /** Set by `POST …/partner/{localUserId}`; admin-visible only. */
  partnerUserId: string | null
}

/** One imported lab test. The HL7 text itself is never stored (its PID segment is PHI). */
export type PatientTestRecord = {
  patientTestId: number
  patientId: number
  labProfileId: number
  testDate: string
  unitType: string
  createdDate: string
  lastUpdatedDate: string
  userId: string | null
  practiceId: string
  labId: number
  externalReference: string | null
  externalMessageControlId: string | null
  externalPatientTestId: string | null
  results: ResultElement[]
  importLogs: ImportLog[] | null
  menstrualPhase: string
  isFasting: boolean
}

export type WebhookRecord = {
  partnerWebhookId: number
  signingKey: string
  createDate: string
  entityEvents: { PatientTest: string[] }
  webhookUrl: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Accepted `ApiKey` values; empty accepts any non-empty key. */
  apiKeys: string[]
  /** A webhook registered in every namespace from the start (`--webhook-url`, `--signing-key`). */
  presetWebhook: { url: string; signingKey: string } | null
}

export const DEFAULT_SETTINGS: Settings = { apiKeys: [], presetWebhook: null }

const ID_BASES = { patient: 100_000, test: 700_000, webhook: 0, message: 0 } as const

export class OdxState {
  readonly patients: Collection<PatientRecord>
  readonly tests: Collection<PatientTestRecord>
  readonly webhooks: Collection<WebhookRecord>
  readonly settings: Collection<Settings>
  private readonly counters: Collection<number>

  constructor(
    sqlite: SqliteClient,
    private readonly namespace: string,
    private readonly seed: { settings: Partial<Settings>; timestamp: () => string },
  ) {
    this.patients = new Collection(sqlite, namespace, "patients")
    this.tests = new Collection(sqlite, namespace, "tests")
    this.webhooks = new Collection(sqlite, namespace, "webhooks")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.ensureSeeded()
  }

  /** Numeric ids per kind: patients 100001…, tests 700001…, webhooks 1…. */
  nextId(kind: keyof typeof ID_BASES): number {
    const next = (this.counters.get(kind) ?? 0) + 1
    this.counters.insert(kind, next)
    return ID_BASES[kind] + next
  }

  current(): Settings {
    return this.settings.get("settings") ?? { ...DEFAULT_SETTINGS, ...this.seed.settings }
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
    const preset = this.current().presetWebhook
    if (preset && this.webhooks.count() === 0) {
      this.addWebhook(preset.url, ["Created", "Updated", "Deleted"], preset.signingKey)
    }
  }

  addWebhook(url: string, events: string[], signingKey?: string): WebhookRecord {
    const id = this.nextId("webhook")
    const webhook: WebhookRecord = {
      partnerWebhookId: id,
      signingKey: signingKey ?? opaqueToken(`odx:signing-key:${this.namespace}:${id}`, 44),
      createDate: this.seed.timestamp(),
      entityEvents: { PatientTest: events },
      webhookUrl: url,
    }
    this.webhooks.insert(String(id), webhook)
    return webhook
  }

  patient(practiceId: string, patientId: string | number): PatientRecord | undefined {
    const found = this.patients.get(String(patientId))
    return found && found.practiceId === practiceId ? found : undefined
  }
}
