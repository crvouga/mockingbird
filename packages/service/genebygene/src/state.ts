import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { Collection, IdSequence } from "@crvouga/mockingbird-service"

export type ProductRecord = {
  productId: string
  name: string
  description: string | null
}

export type OrderRecord = {
  orderId: string
  status: "Pending" | "Submitted" | "Completed" | "Cancelled"
  quantity: number
  productId: string
  createdAt: string
}

export class GeneByGeneState {
  readonly products: Collection<ProductRecord>
  readonly orders: Collection<OrderRecord>
  readonly ids: IdSequence

  constructor(sqlite: SqliteClient, namespace: string) {
    this.products = new Collection(sqlite, namespace, "products")
    this.orders = new Collection(sqlite, namespace, "orders")
    this.ids = new IdSequence(sqlite, namespace, "genebygene")
    this.ensureSeedProducts()
  }

  /** Sandbox always exposes at least one catalog product. */
  ensureSeedProducts() {
    if (this.products.list().length > 0) return
    this.products.insert("product_default", {
      productId: "product_default",
      name: "Mockingbird Default Kit",
      description: "Seed product for GeneByGene mock",
    })
  }

  nextOrderId(): string {
    return this.ids.next("order_")
  }

  isoNow(now: () => number): string {
    return new Date(now()).toISOString()
  }
}
