import { Collection, IdempotencyStore, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/**
 * One order as the mock tracks it. Patient details are validated but never stored: the mock
 * keeps only what it needs to emit consistent webhooks (ids, status, appointment time, zone).
 */
export type OrderRecord = {
  partner_order_id: string
  /** AHA's own order id (`ahaOrderId` in webhooks). */
  order_number: string
  /** The last status reported (`Order Placed` until a webhook goes out). */
  status: string
  drawStatus: string | null
  /** The appointment instant (ISO-8601), once scheduled or preferred. */
  scheduledAt: string | null
  /** IANA zone every local time in this order's webhooks is expressed in. */
  timeZone: string
  cancelled: boolean
  created_at: string
  updated_at: string
  /** Mock-clock epoch ms of creation, for `autoSchedule`. */
  createdAtMs: number
  autoScheduled: boolean
}

export type AutoSchedule = {
  /** Emit `Scheduled` this long (mock clock) after the order is created. */
  afterMs: number
  /** Appointment time relative to creation when the order carries no preferred time. Default 24 h. */
  leadMs?: number
}

export type ApiCredential = {
  apiKey: string
  /** HMAC secret (`AHA_API_SECRET`); omit to accept the key in legacy mode only. */
  apiSecret?: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** `raw` `{content, message, status}` (AhaService) or `wrapped` `{success, data}` (AhaLabProvider). */
  envelope: "raw" | "wrapped"
  /**
   * Known keys. Empty: any key is accepted and HMAC signatures are checked for shape only
   * (the mock cannot know the secret). Non-empty: the key must match, and a key with a
   * secret has its signature verified exactly.
   */
  credentials: ApiCredential[]
  /** Accept `X-<Partner>-Auth-Key` (legacy mode). Default true. */
  allowLegacy: boolean
  /** Reject an `X-TIMESTAMP` further than this from wall-clock time; 0 disables. Default 5 min. */
  timestampToleranceMs: number
  autoSchedule: AutoSchedule | null
  /** Zone for orders that send no `patient_timezone`. */
  defaultTimeZone: string
  /** Emit a `Cancelled` webhook when the partner cancels through the API. Default true. */
  cancelWebhook: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  envelope: "raw",
  credentials: [],
  allowLegacy: true,
  timestampToleranceMs: 300_000,
  autoSchedule: null,
  defaultTimeZone: "America/New_York",
  cancelWebhook: true,
}

export class AhaState {
  readonly orders: Collection<OrderRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence
  readonly idempotency: IdempotencyStore

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.orders = new Collection(sqlite, namespace, "orders")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "aha")
    this.idempotency = new IdempotencyStore(sqlite, namespace)
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

  /** By partner order id, then by AHA order number (our lab-provider cancels with the latter). */
  findOrder(id: string): OrderRecord | undefined {
    return (
      this.orders.get(id) ??
      this.orders.list({ where: (order) => order.order_number === id }).at(0)?.value
    )
  }

  nextOrderNumber(): string {
    return this.ids.next("AHA-", 10).toUpperCase()
  }
}
