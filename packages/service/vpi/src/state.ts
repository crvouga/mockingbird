import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import {
  type ClinicLocation,
  DEFAULT_CLINIC_LOCATION,
  DEFAULT_PATIENTS,
  DEFAULT_PRODUCTS,
  DEFAULT_PROVIDERS,
  type Patient,
  type Product,
  type Provider,
} from "./catalog.js"
import type { PrescriptionList } from "./statuses.js"

/**
 * One saved prescription as VPI tracks it. Only ids and status are kept: the product and
 * shipping details of the save payload are validated, never stored or echoed back.
 */
export type PrescriptionRecord = {
  prescriptionId: string
  clinicId: string
  clinicLocationId: string
  patientId: string
  providerId: string
  productIds: string[]
  prescriptionStatus: string
  list: PrescriptionList
  trackingNumber: string | null
  createdAt: string
  updatedAt: string
}

/** A login `POST /accounts/authenticate` accepts, and the user id its JWT carries. */
export type Account = { email: string; password: string; id: string }

/**
 * The envelope the three status lists answer in. `vendor` mirrors what our client's spec
 * records per endpoint (submitted `{message: {prescriptions}}`, archived `{message: [...]}` with
 * `id` rows, incomplete a bare array); the others force one envelope everywhere.
 */
export type StatusEnvelope =
  | "vendor"
  | "array"
  | "prescriptions"
  | "message"
  | "message.prescriptions"

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** JWT lifetime on the mock clock. Our client caches until `exp` minus 30 s. */
  tokenTtlSeconds: number
  /** Only these logins authenticate; empty means any email/password pair does. */
  accounts: Account[]
  statusEnvelope: StatusEnvelope
  /** What the duplicate check reports for `isProviderSignatureNeeded`. */
  isProviderSignatureNeeded: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  tokenTtlSeconds: 3_600,
  accounts: [],
  statusEnvelope: "vendor",
  isProviderSignatureNeeded: true,
}

/** Replaceable seed data (defaults in `catalog.ts`). */
export type Seed = {
  products?: readonly Product[]
  providers?: readonly Provider[]
  clinicLocations?: readonly ClinicLocation[]
  patients?: readonly Patient[]
}

export class VpiState {
  readonly products: Collection<Product>
  readonly providers: Collection<Provider>
  readonly locations: Collection<ClinicLocation>
  readonly patients: Collection<Patient>
  readonly prescriptions: Collection<PrescriptionRecord>
  readonly settings: Collection<Settings>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { data: Seed; settings: Partial<Settings> },
  ) {
    this.products = new Collection(sqlite, namespace, "products")
    this.providers = new Collection(sqlite, namespace, "providers")
    this.locations = new Collection(sqlite, namespace, "clinic_locations")
    this.patients = new Collection(sqlite, namespace, "patients")
    this.prescriptions = new Collection(sqlite, namespace, "prescriptions")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ensureSeeded()
  }

  /** Re-apply the seed after a reset. */
  ensureSeeded(): void {
    const { data } = this.seed
    if (this.products.count() === 0) {
      for (const p of data.products ?? DEFAULT_PRODUCTS) this.products.insert(p.id, p)
    }
    if (this.providers.count() === 0) {
      for (const p of data.providers ?? DEFAULT_PROVIDERS) this.providers.insert(p.id, p)
    }
    if (this.locations.count() === 0) {
      for (const l of data.clinicLocations ?? [DEFAULT_CLINIC_LOCATION]) {
        this.locations.insert(l.id, l)
      }
    }
    if (this.patients.count() === 0) {
      for (const p of data.patients ?? DEFAULT_PATIENTS) this.patients.insert(p.id, p)
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

  /** Clinic ids that exist (every location's clinic). */
  hasClinic(clinicId: string): boolean {
    return this.locations.list().some((row) => row.value.clinicId === clinicId)
  }

  /** A Mongo-looking prescription id, deterministic per namespace history. */
  nextPrescriptionId(): string {
    return `66b2${this.prescriptions.nextSequence().toString(16).padStart(20, "0")}`
  }

  /** A patient id for seeded patients that omit one. */
  nextPatientId(): string {
    return `66b4${this.patients.nextSequence().toString(16).padStart(20, "0")}`
  }

  /** A patient-address id for seeded addresses that omit one. */
  nextAddressId(): string {
    return `66b3${this.patients.nextSequence().toString(16).padStart(20, "0")}`
  }

  /**
   * A list's rows, newest first. The incomplete and submitted lists are per clinic location;
   * the archived list is per clinic (`getArchivedPrescriptionsInClinic`).
   */
  list(list: PrescriptionList, location: ClinicLocation): PrescriptionRecord[] {
    return this.prescriptions
      .list({
        where: (row) =>
          row.list === list &&
          (list === "archived"
            ? row.clinicId === location.clinicId
            : row.clinicLocationId === location.id),
      })
      .map((row) => row.value)
  }
}
