import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import {
  type Clinic,
  DEFAULT_CLINICS,
  DEFAULT_TEMPLATES,
  type MedicationTemplate,
} from "./catalog.js"

/**
 * One medication order as the pharmacy tracks it, keyed by our UUIDv7
 * `medication_order_identifier`. Patient demographics and sigs are validated, never stored:
 * the order keeps only the ids and statuses the order-lookup API returns.
 */
export type OrderRecord = {
  medication_order_identifier: string
  clinic_identifier: string
  practitioner_identifier: string | null
  patient_id: number
  product_identifiers: string[]
  /** Highest DEA schedule on the order, 0 when none is controlled. */
  controlled: number
  workflow_status: string
  tracking_id: string | null
  created_at: string
  updated_at: string
  /** Mock-clock epoch ms of creation, for auto-advance. */
  createdAtMs: number
  /** Steps of `autoAdvance.path` already applied. */
  advanced: number
}

/**
 * A patient on the provider's roster. `patient/provider/patient_list` echoes these
 * demographics back (our client matches on them), so the mock has to keep them.
 */
export type PatientRecord = {
  patient_id: number
  clinic_identifier: string
  demographics: {
    first_name: string
    last_name: string
    DOB: string
    email: string
    phone_primary: string
    line_1: string
    postal_code: string
  }
}

/**
 * The sandbox's standing test patient (id 1): a sandbox roster is never empty, and orders
 * need a patient that exists. Our adapter matches patients by name and date of birth, so this
 * one never captures a real request.
 */
export const SANDBOX_PATIENT: PatientRecord = {
  patient_id: 1,
  clinic_identifier: "clinic-acme-0001",
  demographics: {
    first_name: "Sandbox",
    last_name: "Patient",
    DOB: "1970-01-01",
    email: "sandbox.patient@example.com",
    phone_primary: "6025550100",
    line_1: "100 Test Ave",
    postal_code: "85004",
  },
}

export type AutoAdvance = {
  /** Mock-clock delay between steps. */
  afterMs: number
  /** Workflow statuses to walk through, e.g. `["data_entry", "shipped", "completed"]`. */
  path: string[]
}

/** Which of the receiver's field fallbacks the status webhook exercises. */
export type WebhookVariant = "workflow_status" | "status" | "flat"

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Accepted `x-pmk-authentication-token` values; empty means any non-empty token. */
  tokens: string[]
  /** Accepted Basic credentials for the catalog; empty means any pair. */
  basic: { username: string; password: string }[]
  /** Serve the medication-template catalog without credentials (our client's last fallback). */
  anonymousCatalog: boolean
  webhookVariant: WebhookVariant
  autoAdvance: AutoAdvance | null
}

export const DEFAULT_SETTINGS: Settings = {
  tokens: [],
  basic: [],
  anonymousCatalog: true,
  webhookVariant: "workflow_status",
  autoAdvance: null,
}

export class PharmetikaState {
  readonly orders: Collection<OrderRecord>
  readonly patients: Collection<PatientRecord>
  readonly clinics: Collection<Clinic>
  readonly templates: Collection<MedicationTemplate>
  readonly settings: Collection<Settings>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: {
      templates: readonly MedicationTemplate[]
      clinics: readonly Clinic[]
      patients: readonly PatientRecord[]
      settings: Partial<Settings>
    },
  ) {
    this.orders = new Collection(sqlite, namespace, "orders")
    this.patients = new Collection(sqlite, namespace, "patients")
    this.clinics = new Collection(sqlite, namespace, "clinics")
    this.templates = new Collection(sqlite, namespace, "templates")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ensureSeeded()
  }

  /** Re-apply the catalog, clinics and settings after a reset. */
  ensureSeeded(): void {
    if (this.templates.count() === 0) {
      const rows = this.seed.templates.length > 0 ? this.seed.templates : DEFAULT_TEMPLATES
      for (const row of rows) this.templates.insert(row.template_identifier, row)
    }
    if (this.clinics.count() === 0) {
      const rows = this.seed.clinics.length > 0 ? this.seed.clinics : DEFAULT_CLINICS
      for (const row of rows) this.clinics.insert(row.identifier, row)
    }
    if (this.patients.count() === 0) {
      for (const row of this.seed.patients) this.patients.insert(String(row.patient_id), row)
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

  /** The template (and dose) a `product_identifier` belongs to. */
  product(productIdentifier: string): { template: MedicationTemplate; dose: string } | undefined {
    for (const { value: template } of this.templates.list({ order: "oldest" })) {
      for (const [dose, id] of Object.entries(template.map_dose_to_product)) {
        if (id === productIdentifier) return { template, dose }
      }
    }
    return undefined
  }

  nextPatientId(): number {
    return 1 + this.patients.count()
  }
}
