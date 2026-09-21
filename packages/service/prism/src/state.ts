import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type Quantity = { value: number; unit: string }

/** A scan subject, keyed by the non-PII token our backend mints per member. */
export type UserRecord = {
  id: string
  token: string
  sex: "male" | "female" | "neutral" | "undefined"
  region: string
  birthDate: string
  weight: Quantity
  height: Quantity
  researchConsent: boolean
  termsOfService: { accepted: boolean; version: string }
  createdAt: string
  updatedAt: string
}

export type ScanStatus = "CREATED" | "PROCESSING" | "READY" | "FAILED"
export type StageStatus = "started" | "succeeded" | "failed"
export const STAGES = ["captureData", "body", "fittedBody", "measurement"] as const
export type Stage = (typeof STAGES)[number]

export type ScanRecord = {
  id: string
  status: ScanStatus
  userToken: string
  deviceConfigName: string
  bodyfatMethod: string
  assetConfigId: string | null
  /** The subject's weight and height when the scan was created, in the units they were given. */
  weight: Quantity
  height: Quantity
  stages: Partial<Record<Stage, { status: StageStatus; updatedAt: string }>>
  /** Upload signature and expiry (mock-clock ms) of the last minted upload URL. */
  upload: { signature: string; expiresAtMs: number } | null
  uploadedBytes: number | null
  /** Mock-clock ms of the upload, for auto-advance. */
  uploadedAtMs: number | null
  createdAt: string
  updatedAt: string
}

export type AutoAdvance = {
  /** Mock-clock delay between processing stages after the upload. */
  afterMs: number
  /** Fail the scan at this stage instead of completing it. */
  failAt?: Stage
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these API keys authenticate; empty means any bearer does. */
  apiKeys: string[]
  /** Walk uploaded scans through the stages to READY on the mock clock. `null`: admin only. */
  autoAdvance: AutoAdvance | null
  /** Lifetime of a minted upload URL. Default 15 minutes. */
  uploadUrlTtlMs: number
}

export const DEFAULT_SETTINGS: Settings = {
  apiKeys: [],
  autoAdvance: null,
  uploadUrlTtlMs: 15 * 60_000,
}

export class PrismState {
  readonly users: Collection<UserRecord>
  readonly scans: Collection<ScanRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.users = new Collection(sqlite, namespace, "users")
    this.scans = new Collection(sqlite, namespace, "scans")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "prism")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
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

  user(token: string): UserRecord | undefined {
    return this.users.get(token)
  }
}
