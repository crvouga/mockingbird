import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { DEFAULT_FORMS, type FullFormDto } from "./forms.js"

/** A patient as CareTalk echoes it back from `POST /externalapi/Patients`. */
export type PatientRecord = Record<string, unknown> & {
  id: number
  eligibilityId: number
  programId: number
  firstName: string | null
  lastName: string | null
  zipCode: string | null
  dateOfBirth: string | null
  createdAt: string
}

/** One saved round of a form (`SavePatientForm`). */
export type FormRoundRecord = {
  formRoundId: number
  formId: number
  patientId: number
  patientAppointmentId: number | null
  submitDate: string
  answers: { questionId: number; answerIds: number[]; freeAnswerText: Record<string, string> }[]
}

export type AppointmentRecord = {
  id: number
  eligibilityId: number
  physicianId: number
  appointmentStatus: number
  startDateTime: string
  endDateTime: string
  createdAt: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Token lifetime. Default 3600 s (our client caches the token for exactly that long). */
  tokenTtlSeconds: number
  /** Only these API users log in; empty means any userName/password pair does. */
  users: { userName: string; password: string }[]
  /** Static bearer keys accepted as-is (`CARETALK_API_KEY`); empty accepts any non-token bearer. */
  apiKeys: string[]
  /** The program every patient belongs to (the app's `CARETALK_PROGRAM_ID`). */
  programId: number
}

export const DEFAULT_SETTINGS: Settings = {
  tokenTtlSeconds: 3_600,
  users: [],
  apiKeys: [],
  programId: 21,
}

type Counters = { patient: number; round: number; appointment: number }

export class CareTalkState {
  readonly forms: Collection<FullFormDto>
  readonly patients: Collection<PatientRecord>
  readonly rounds: Collection<FormRoundRecord>
  readonly appointments: Collection<AppointmentRecord>
  readonly settings: Collection<Settings>
  private readonly counters: Collection<Counters>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { forms: readonly FullFormDto[]; settings: Partial<Settings> },
  ) {
    this.forms = new Collection(sqlite, namespace, "forms")
    this.patients = new Collection(sqlite, namespace, "patients")
    this.rounds = new Collection(sqlite, namespace, "form_rounds")
    this.appointments = new Collection(sqlite, namespace, "appointments")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (this.forms.count() === 0) {
      for (const form of this.seed.forms.length > 0 ? this.seed.forms : DEFAULT_FORMS) {
        this.forms.insert(String(form.id), form)
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

  /** CareTalk ids are integers: one counter per kind. */
  next(kind: keyof Counters): number {
    const current = this.counters.get("counters") ?? { patient: 0, round: 0, appointment: 0 }
    const next = { ...current, [kind]: current[kind] + 1 }
    this.counters.insert("counters", next)
    return next[kind]
  }

  /** A form by name or slug, case-insensitively (the app passes either). */
  findForm(nameOrSlug: string): FullFormDto | undefined {
    const wanted = nameOrSlug.trim().toLowerCase()
    return this.forms
      .list({ order: "oldest" })
      .map((r) => r.value)
      .find((f) => f.name.toLowerCase() === wanted || f.slug.toLowerCase() === wanted)
  }
}
