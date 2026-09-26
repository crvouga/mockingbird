import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type {
  AddressRecord,
  BusinessRecord,
  CustomerRecord,
  EventRecord,
  PendingCharge,
  PriceRecord,
  ProductRecord,
  SubscriptionRecord,
  TransactionRecord,
} from "./entities.js"

/** Paddle id prefixes, per entity. */
export const ID_PREFIX = {
  customer: "ctm",
  address: "add",
  business: "biz",
  product: "pro",
  price: "pri",
  transaction: "txn",
  subscription: "sub",
  event: "evt",
  notification: "ntf",
  line_item: "txnitm",
  payment_attempt: "payatt",
  payment_method: "paymtd",
  invoice: "inv",
} as const

export type IdKind = keyof typeof ID_PREFIX

export class PaddleState {
  readonly customers: Collection<CustomerRecord>
  readonly addresses: Collection<AddressRecord>
  readonly businesses: Collection<BusinessRecord>
  readonly products: Collection<ProductRecord>
  readonly prices: Collection<PriceRecord>
  readonly transactions: Collection<TransactionRecord>
  readonly subscriptions: Collection<SubscriptionRecord>
  /** Queued one-time charges per subscription id. */
  readonly pendingCharges: Collection<PendingCharge[]>
  readonly events: Collection<EventRecord>
  private readonly ids: IdSequence

  constructor(sqlite: SqliteClient, namespace: string) {
    this.customers = new Collection(sqlite, namespace, "customers")
    this.addresses = new Collection(sqlite, namespace, "addresses")
    this.businesses = new Collection(sqlite, namespace, "businesses")
    this.products = new Collection(sqlite, namespace, "products")
    this.prices = new Collection(sqlite, namespace, "prices")
    this.transactions = new Collection(sqlite, namespace, "transactions")
    this.subscriptions = new Collection(sqlite, namespace, "subscriptions")
    this.pendingCharges = new Collection(sqlite, namespace, "pending_charges")
    this.events = new Collection(sqlite, namespace, "events")
    this.ids = new IdSequence(sqlite, namespace, "paddle")
  }

  /**
   * A Paddle-shaped id: `<prefix>_01` followed by 24 lower-case alphanumerics (Paddle ids are a
   * prefix plus a 26-character ULID), deterministic for a given history.
   */
  nextId(kind: IdKind): string {
    const prefix = ID_PREFIX[kind]
    const token = this.ids.next(`${prefix}_`, 24).slice(prefix.length + 1)
    return `${prefix}_01${token.toLowerCase()}`
  }

  /** An opaque token (auth tokens, signing material), deterministic for a given history. */
  nextToken(prefix: string, length: number): string {
    return this.ids.next(prefix, length)
  }
}
