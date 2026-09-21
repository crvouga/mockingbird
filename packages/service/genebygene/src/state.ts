import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { ProductDto } from "./types.js"
import {
  type BlobRecord,
  DEFAULT_SETTINGS,
  type FulfillmentRecord,
  type KitRecord,
  type LineRecord,
  type OrderRecord,
  type ResultRecord,
  type Settings,
  type SubscriptionRecord,
} from "./types.js"

const HEX = "0123456789abcdef"
const KIT_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"

/**
 * `2026-06-18T18:48:59.05Z`: how Nucleus (.NET) prints instants, trailing fractional zeros
 * trimmed.
 */
export const netIso = (ms: number): string => {
  const iso = new Date(ms).toISOString()
  const [whole, fraction = "000Z"] = iso.split(".")
  const digits = fraction.slice(0, 3).replace(/0+$/, "")
  return digits.length > 0 ? `${whole}.${digits}Z` : `${whole}Z`
}

/**
 * Everything one namespace holds. Ids are deterministic per namespace (salted with its
 * storage name, so two namespaces never mint the same kit number or result key).
 */
export class GeneByGeneState {
  readonly orders: Collection<OrderRecord>
  readonly lines: Collection<LineRecord>
  readonly fulfillments: Collection<FulfillmentRecord>
  readonly kits: Collection<KitRecord>
  readonly results: Collection<ResultRecord>
  readonly blobs: Collection<BlobRecord>
  readonly subscriptions: Collection<SubscriptionRecord>
  readonly products: Collection<ProductDto>
  /** Named result fixture (or `custom`) per kit, from `PUT /__admin/results/:kitNumber`. */
  readonly pendingResults: Collection<{ kitNumber: string; fixture: string; custom?: unknown }>
  readonly settings: Collection<Settings>
  private readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    readonly namespace: string,
    private readonly seed: { products: readonly ProductDto[]; settings: Partial<Settings> },
  ) {
    this.orders = new Collection(sqlite, namespace, "orders")
    this.lines = new Collection(sqlite, namespace, "orderLines")
    this.fulfillments = new Collection(sqlite, namespace, "fulfillments")
    this.kits = new Collection(sqlite, namespace, "kits")
    this.results = new Collection(sqlite, namespace, "results")
    this.blobs = new Collection(sqlite, namespace, "blobs")
    this.subscriptions = new Collection(sqlite, namespace, "subscriptions")
    this.products = new Collection(sqlite, namespace, "products")
    this.pendingResults = new Collection(sqlite, namespace, "pendingResults")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, `genebygene:${namespace}`)
    this.ensureSeeded()
  }

  /** Re-apply the catalog and settings after a reset. */
  ensureSeeded(): void {
    if (this.products.count() === 0) {
      for (const product of this.seed.products) this.products.insert(product.id, product)
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

  /** A v4-shaped uuid, deterministic for this namespace's sequence of `kind` ids. */
  uuid(kind: string): string {
    const raw = this.ids.next(`${kind}:`, 32).slice(kind.length + 1)
    const hex = [...raw].map((c) => HEX.charAt(c.charCodeAt(0) % 16))
    hex[12] = "4"
    hex[16] = HEX.charAt(8 + (raw.charCodeAt(16) % 4))
    const h = hex.join("")
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
  }

  /** `WB` + 6 characters, the Geviti tenant's kit prefix (`WBM824L3`, `WBGB6866`). */
  kitNumber(): string {
    for (;;) {
      const raw = this.ids.next("kit:", 6).slice(4)
      const kit = `WB${[...raw].map((c) => KIT_ALPHABET.charAt(c.charCodeAt(0) % KIT_ALPHABET.length)).join("")}`
      // WBQA… is our consumer's synthetic prefix; never mint one.
      if (!kit.startsWith("WBQA") && !this.kits.has(kit)) return kit
    }
  }

  /** A carrier-looking tracking number of `length` digits. */
  digits(kind: string, length: number): string {
    const raw = this.ids.next(`${kind}:`, length).slice(kind.length + 1)
    return [...raw].map((c) => String(c.charCodeAt(0) % 10)).join("")
  }

  secret(): string {
    return this.ids.next("secret:", 40).slice(7)
  }

  linesOf(order: OrderRecord): LineRecord[] {
    return order.lineIds.flatMap((id) => {
      const line = this.lines.get(id)
      return line ? [line] : []
    })
  }
}
