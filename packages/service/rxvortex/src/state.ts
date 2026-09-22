import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type CatalogItem, DEFAULT_CATALOG } from "./catalog.js"

/**
 * One order as the vendor tracks it. Patient and prescriber details are validated but never
 * stored: the mock keeps only what the status API returns.
 */
export type OrderRecord = {
  order_tracking_id: string
  sender_order_id: string
  rxstatus: string
  orderstatus: string
  shipping_status: string
  delivered_date: string | null
  trackingnumber: string | null
  shippingservice: string | null
  shippingcarrier: string | null
  shipmenttrackingurl: string | null
  cancellable: boolean
  created_at: string
  updated_at: string
  /** Mock-clock epoch ms of creation, for auto-advance. */
  createdAtMs: number
  preset_catalog_ids: string[]
  /** Steps of `autoAdvance.path` already applied. */
  advanced: number
}

export type AutoAdvance = {
  /** Mock-clock delay between steps. */
  afterMs: number
  /** Vendor statuses to walk through, e.g. `["Fill", "Shipping", "Delivered"]`. */
  path: string[]
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Token lifetime. Default 24 h, which our client assumes and never refreshes early. */
  tokenTtlSeconds: number
  /** Static bearer tokens accepted as-is (`RXVORTEX_API_TOKEN` for the catalog client). */
  staticTokens: string[]
  /** Only these client credentials get a token; empty means any pair does. */
  clients: { client_id: string; client_secret: string }[]
  autoAdvance: AutoAdvance | null
}

export const DEFAULT_SETTINGS: Settings = {
  tokenTtlSeconds: 86_400,
  staticTokens: [],
  clients: [],
  autoAdvance: null,
}

export class RxVortexState {
  readonly orders: Collection<OrderRecord>
  readonly catalog: Collection<CatalogItem>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { catalog: readonly CatalogItem[]; settings: Partial<Settings> },
  ) {
    this.orders = new Collection(sqlite, namespace, "orders")
    this.catalog = new Collection(sqlite, namespace, "catalog")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "rxvortex")
    this.ensureSeeded()
  }

  /** Re-apply the catalog and settings after a reset. */
  ensureSeeded(): void {
    if (this.catalog.count() === 0) {
      for (const item of this.seed.catalog.length > 0 ? this.seed.catalog : DEFAULT_CATALOG) {
        this.catalog.insert(item.catalog_id, item)
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

  /** By vendor tracking id first, then by our sender order id (the recovery lookup). */
  findOrder(id: string): OrderRecord | undefined {
    return (
      this.orders.get(id) ??
      this.orders.list({ where: (order) => order.sender_order_id === id }).at(0)?.value
    )
  }

  nextTrackingId(): string {
    return this.ids.next("RXV-", 12).toUpperCase()
  }
}
