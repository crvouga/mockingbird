import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type Catalog, DEFAULT_CATALOG } from "./catalog.js"

export type Tracking = { trackingNumber: string; carrier: string; trackingUrl?: string }

/**
 * One order as Wholescripts reports it on `GET /api/Orders/Status`. The shipping address and
 * recipient (PHI) are validated on submit but never stored; only the SKUs and quantities are
 * kept, to price the order.
 */
export type OrderRecord = {
  orderNumber: string
  orderDate: string
  salesOrder: string
  status: string
  tracking: Tracking[]
  message: string
  subTotal: number
  shipMethod: string
  shipCharge: number
  discount: number
  tax: number
  serviceFee: number
  orderTotal: number
  items: { sku: string; quantity: number }[]
  /** Mock-clock epoch ms of creation, for auto-advance. */
  createdAtMs: number
  /** Steps of `autoAdvance.path` already applied. */
  advanced: number
}

export type AutoAdvance = {
  /** Mock-clock delay between steps. */
  afterMs: number
  /** Statuses to walk through, e.g. `["Processing", "Complete"]`. */
  path: string[]
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these Basic credentials are accepted; empty means any non-empty pair is. */
  accounts: { username: string; password: string }[]
  autoAdvance: AutoAdvance | null
}

export const DEFAULT_SETTINGS: Settings = { accounts: [], autoAdvance: null }

/** Order numbers start here, like the vendor's numeric web order numbers. */
const FIRST_ORDER_NUMBER = 700_001

export class WholescriptsState {
  readonly orders: Collection<OrderRecord>
  readonly catalogs: Collection<Catalog>
  readonly settings: Collection<Settings>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { catalog: Catalog | undefined; settings: Partial<Settings> },
  ) {
    this.orders = new Collection(sqlite, namespace, "orders")
    this.catalogs = new Collection(sqlite, namespace, "catalog")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ensureSeeded()
  }

  /** Re-apply the catalog and settings after a reset. */
  ensureSeeded(): void {
    if (!this.catalogs.has("catalog")) {
      this.catalogs.insert("catalog", this.seed.catalog ?? DEFAULT_CATALOG)
    }
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
  }

  catalog(): Catalog {
    return this.catalogs.get("catalog") ?? DEFAULT_CATALOG
  }

  replaceCatalog(catalog: Catalog): Catalog {
    this.catalogs.insert("catalog", catalog)
    return catalog
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  nextOrderNumber(): string {
    return String(FIRST_ORDER_NUMBER + this.orders.count())
  }
}
