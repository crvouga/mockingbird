import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** Lab order states, in the only order they may move (forward). */
export const LAB_ORDER_STATES = [
  "not_purchased",
  "purchased",
  "schedule_appointment",
  "upcoming_appointment",
  "processing",
  "partial_results",
  "results_ready",
  "interpretation_shared",
  "results_amended",
] as const

export type LabOrderState = (typeof LAB_ORDER_STATES)[number]

export const isLabOrderState = (value: unknown): value is LabOrderState =>
  typeof value === "string" && (LAB_ORDER_STATES as readonly string[]).includes(value)

export const stateRank = (state: LabOrderState) => LAB_ORDER_STATES.indexOf(state)

export type Practitioner = { id: string; type: "Practitioner" | "Staff"; clinicId: string }
export type Clinic = { id: string; name: string; created_at: string }

export type LabResult = { id: string; name: string; state: string; artifactId: string }

export type LabOrderRecord = {
  id: string
  clinicId: string
  patientId: string
  treatmentPlanId: string | null
  name: string
  collectionMethod: string
  state: LabOrderState
  tests: { id: string; name: string; lab_type: string }[]
  results: LabResult[]
  aggregated: { id: string; artifactId: string; status: string } | null
  created_at: string
  updated_at: string
}

export type EventRecord = {
  id: string
  type: "lab_order.updated" | "order.placed"
  clinic_id: string
  created_at: string
  data: Record<string, unknown>
  /** Insertion order, for ASC / DESC paging. */
  seq: number
}

export type CodeRecord = {
  code: string
  practitionerId: string
  clientId: string
  redirectUri: string | null
  expiresAtMs: number
  used: boolean
}

export type RefreshRecord = {
  token: string
  practitionerId: string
  clientId: string
  revoked: boolean
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these OAuth clients authenticate; empty means any id/secret pair does. */
  clients: { clientId: string; clientSecret: string }[]
  /** Access-token lifetime on the mock clock. Default 7200 s (2 h). */
  accessTokenTtlSeconds: number
  /** Authorization-code lifetime. Default 600 s. */
  codeTtlSeconds: number
  /** Lifetime of a result PDF URL. Default 900 s. */
  pdfUrlTtlSeconds: number
  /** Origin (plus optional path) result PDF URLs point at; default: the request's own origin. */
  resultsBaseUrl: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  clients: [],
  accessTokenTtlSeconds: 7_200,
  codeTtlSeconds: 600,
  pdfUrlTtlSeconds: 900,
  resultsBaseUrl: null,
}

export const DEFAULT_CLINIC: Clinic = {
  id: "clinic_mock_1",
  name: "Acme Mock Clinic",
  created_at: "2025-01-01T00:00:00.000Z",
}
export const DEFAULT_PRACTITIONER: Practitioner = {
  id: "prac_mock_1",
  type: "Practitioner",
  clinicId: DEFAULT_CLINIC.id,
}

type Counters = { code: number; refresh: number; order: number; event: number; artifact: number }

export class FullscriptState {
  readonly practitioners: Collection<Practitioner>
  readonly clinics: Collection<Clinic>
  readonly codes: Collection<CodeRecord>
  readonly refresh: Collection<RefreshRecord>
  readonly revoked: Collection<{ token: string }>
  readonly orders: Collection<LabOrderRecord>
  readonly events: Collection<EventRecord>
  readonly settings: Collection<Settings>
  private readonly counters: Collection<Counters>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.practitioners = new Collection(sqlite, namespace, "practitioners")
    this.clinics = new Collection(sqlite, namespace, "clinics")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.refresh = new Collection(sqlite, namespace, "refresh_tokens")
    this.revoked = new Collection(sqlite, namespace, "revoked_tokens")
    this.orders = new Collection(sqlite, namespace, "lab_orders")
    this.events = new Collection(sqlite, namespace, "events")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (this.clinics.count() === 0) this.clinics.insert(DEFAULT_CLINIC.id, DEFAULT_CLINIC)
    if (this.practitioners.count() === 0) {
      this.practitioners.insert(DEFAULT_PRACTITIONER.id, DEFAULT_PRACTITIONER)
    }
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed })
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

  next(kind: keyof Counters): number {
    const current = this.counters.get("counters") ?? {
      code: 0,
      refresh: 0,
      order: 0,
      event: 0,
      artifact: 0,
    }
    const next = { ...current, [kind]: current[kind] + 1 }
    this.counters.insert("counters", next)
    return next[kind]
  }
}
