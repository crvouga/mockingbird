import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type Address = {
  city: string | null
  country: string | null
  line1: string | null
  line2: string | null
  postal_code: string | null
  state: string | null
}

export type CustomField = { name: string; value: string }

export type CustomerRecord = {
  id: string
  address: Address | null
  balance: number
  created: number
  currency: string | null
  description: string | null
  email: string | null
  invoice_prefix: string
  invoice_settings: {
    custom_fields: CustomField[] | null
    footer: string | null
  }
  metadata: Record<string, string>
  name: string | null
  phone: string | null
  preferred_locales: string[]
  shipping: { address: Address; name: string; phone: string | null } | null
  tax_exempt: "none" | "exempt" | "reverse"
}

/** Deleted customers stay retrievable as tombstones. */
export type CustomerEntry =
  | { kind: "live"; customer: CustomerRecord }
  | { kind: "deleted"; id: string }

export type PackageDimensions = { height: number; length: number; weight: number; width: number }

export type ProductRecord = {
  id: string
  active: boolean
  created: number
  description: string | null
  images: string[]
  marketing_features: Array<{ name: string }>
  metadata: Record<string, string>
  name: string
  package_dimensions: PackageDimensions | null
  shippable: boolean | null
  statement_descriptor: string | null
  unit_label: string | null
  updated: number
  url: string | null
}

export type Recurring = {
  interval: "day" | "week" | "month" | "year"
  interval_count: number
  usage_type: "licensed" | "metered"
}

export type PriceRecord = {
  id: string
  active: boolean
  created: number
  currency: string
  lookup_key: string | null
  metadata: Record<string, string>
  nickname: string | null
  product: string
  recurring: Recurring | null
  tax_behavior: "exclusive" | "inclusive" | "unspecified"
  /** Canonical decimal string in cents (no trailing zeros), e.g. "100" or "100.5". */
  unit_amount_decimal: string
}

export class StripeState {
  readonly customers: Collection<CustomerEntry>
  readonly products: Collection<ProductRecord>
  readonly prices: Collection<PriceRecord>
  readonly ids: IdSequence

  constructor(sqlite: SqliteClient, namespace: string) {
    this.customers = new Collection(sqlite, namespace, "customers")
    this.products = new Collection(sqlite, namespace, "products")
    this.prices = new Collection(sqlite, namespace, "prices")
    this.ids = new IdSequence(sqlite, namespace, "stripe")
  }

  async requestLogUrl() {
    const id = this.ids.next("req_")
    return `https://dashboard.stripe.com/acct_mockingbird/test/workbench/logs?object=${id}`
  }
}

export const seconds = (now: () => number) => Math.floor(now() / 1000)
