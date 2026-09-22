import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** Every `status` a Tracker can report (EasyPost's documented enum). */
export const TRACKER_STATUSES = [
  "unknown",
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "available_for_pickup",
  "return_to_sender",
  "failure",
  "cancelled",
  "error",
] as const

export type TrackerStatus = (typeof TRACKER_STATUSES)[number]

export type TrackingDetail = {
  object: "TrackingDetail"
  message: string
  status: TrackerStatus
  status_detail: string
  datetime: string
  source: string
  tracking_location: {
    object: "TrackingLocation"
    city: string | null
    state: string | null
    country: string | null
    zip: string | null
  }
}

/** One tracker exactly as EasyPost returns it. */
export type TrackerRecord = {
  id: string
  object: "Tracker"
  mode: "test" | "production"
  tracking_code: string
  status: TrackerStatus
  status_detail: string
  carrier: string
  signed_by: string | null
  weight: number | null
  est_delivery_date: string | null
  shipment_id: string | null
  tracking_details: TrackingDetail[]
  carrier_detail: null
  public_url: string
  fees: never[]
  created_at: string
  updated_at: string
}

/**
 * EasyPost's documented test tracking codes: in test mode each answers a fixed status, the
 * carrier is always USPS. https://docs.easypost.com/docs/trackers#test-tracking-codes
 */
export const TEST_TRACKING_CODES: Record<string, { status: TrackerStatus; status_detail: string }> =
  {
    EZ1000000001: { status: "pre_transit", status_detail: "status_update" },
    EZ2000000002: { status: "in_transit", status_detail: "arrived_at_facility" },
    EZ3000000003: { status: "out_for_delivery", status_detail: "out_for_delivery" },
    EZ4000000004: { status: "delivered", status_detail: "arrived_at_destination" },
    EZ5000000005: { status: "return_to_sender", status_detail: "return" },
    EZ6000000006: { status: "failure", status_detail: "unknown" },
    EZ7000000007: { status: "unknown", status_detail: "unknown" },
  }

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these API keys authenticate; empty means any non-empty key does. */
  apiKeys: string[]
}

export const DEFAULT_SETTINGS: Settings = { apiKeys: [] }

export class EasyPostState {
  readonly trackers: Collection<TrackerRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.trackers = new Collection(sqlite, namespace, "trackers")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "easypost")
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

  /** By tracker id, or by tracking code (newest tracker for it). */
  find(idOrCode: string): TrackerRecord | undefined {
    return (
      this.trackers.get(idOrCode) ??
      this.trackers.list({ where: (t) => t.tracking_code === idOrCode }).at(0)?.value
    )
  }

  /** The tracker EasyPost re-uses for this code and carrier (same code, same carrier). */
  existing(code: string, carrier: string): TrackerRecord | undefined {
    return this.trackers
      .list({ where: (t) => t.tracking_code === code && t.carrier === carrier })
      .at(0)?.value
  }

  nextId(): string {
    return this.ids.next("trk_", 32).toLowerCase()
  }
}
