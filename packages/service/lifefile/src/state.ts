import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type Settings = {
  accounts: { username: string; password: string }[]
  refusedShippingStates: string[]
  cancelStatus: string | null
  pushFormat: "consumer" | "vendor"
  pushBeforeResponse: boolean
}
export type OrderRecord = {
  orderId: string
  messageId: number
  referenceId: string | null
  status: string
  updatedAt: string
}
export class LifeFileState {
  readonly orders: Collection<OrderRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly initial: Partial<Settings>,
  ) {
    this.orders = new Collection(sqlite, namespace, "orders")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "lifefile")
    this.ensureSeeded()
  }
  ensureSeeded(): void {
    if (!this.settings.has("settings"))
      this.settings.insert("settings", {
        accounts: [],
        refusedShippingStates: [],
        cancelStatus: null,
        pushFormat: "consumer",
        pushBeforeResponse: false,
        ...this.initial,
      })
  }
  current(): Settings {
    return this.settings.get("settings") as Settings
  }
}
