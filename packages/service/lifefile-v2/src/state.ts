import { Collection, IdSequence, idBaseOf, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import {
  DEFAULT_API_USER_ID,
  DEFAULT_CLIENT,
  DEFAULT_PRIVILEGE_IDS,
  DEFAULT_SETTINGS,
} from "./corpus.js"
import type { ApiUser, OrderRecord, Settings, TokenRecord } from "./types.js"

const ORDER_BASE = 50_000_000
const TOKEN_BASE = 9_000
const USER_BASE = 200_000

type Counter = { value: number }

export type StateSeed = { settings: Partial<Settings>; apiUsers: readonly Partial<ApiUser>[] }

export class LifeFileState {
  readonly orders: Collection<OrderRecord>
  readonly rxIndex: Collection<{ orderIds: number[] }>
  readonly tokens: Collection<TokenRecord>
  readonly apiUsers: Collection<ApiUser>
  readonly settings: Collection<Settings>
  readonly counters: Collection<Counter>
  readonly pendingIntake: Collection<{ orderId: number; dueAt: number }>
  private readonly ids: IdSequence

  constructor(
    private readonly sqlite: SqliteClient,
    readonly namespace: string,
    private readonly seed: StateSeed,
    private readonly now: () => number,
  ) {
    this.orders = new Collection(sqlite, namespace, "orders")
    this.rxIndex = new Collection(sqlite, namespace, "rxIndex")
    this.tokens = new Collection(sqlite, namespace, "tokens")
    this.apiUsers = new Collection(sqlite, namespace, "apiUsers")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.pendingIntake = new Collection(sqlite, namespace, "pendingIntake")
    this.ids = new IdSequence(sqlite, namespace, `lifefile-v2:${namespace}`)
    this.ensureSeeded()
  }

  seedIfNeeded(): void {
    if (!this.settings.has("settings") || this.apiUsers.count() === 0) this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
    if (this.apiUsers.count() === 0) {
      const users = this.seed.apiUsers.length > 0 ? this.seed.apiUsers : [{}]
      for (const user of users) this.registerUser(user)
    }
  }

  clockNow(): number {
    return this.now()
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  registerUser(input: Partial<ApiUser>, origin: { enrolled?: boolean } = {}): ApiUser {
    const settings = this.current()
    const user: ApiUser = {
      clientId: input.clientId ?? DEFAULT_CLIENT.clientId,
      secret: input.secret ?? DEFAULT_CLIENT.secret,
      secretIssuedAt: input.secretIssuedAt ?? this.now(),
      generation: input.generation ?? 0,
      userId:
        input.userId ??
        (this.apiUsers.count() === 0 ? DEFAULT_API_USER_ID : USER_BASE + this.next("user")),
      vendorId: input.vendorId ?? settings.vendorId,
      practiceId: input.practiceId ?? settings.practice.id,
      userGroup: input.userGroup ?? "api-practice",
      privileges: input.privileges ?? [...DEFAULT_PRIVILEGE_IDS],
    }
    this.apiUsers.insert(user.clientId, user)
    if (origin.enrolled) this.next("enrolled")
    return user
  }

  user(clientId: string): ApiUser | undefined {
    return this.apiUsers.get(clientId)
  }

  saveUser(user: ApiUser): ApiUser {
    this.apiUsers.insert(user.clientId, user)
    return user
  }

  private next(name: string): number {
    const value = (this.counters.get(name)?.value ?? 0) + 1
    this.counters.insert(name, { value })
    return value
  }

  private base(): number {
    return (idBaseOf(this.sqlite) % 10_000) * 100_000
  }

  enrolledCount(): number {
    return this.counters.get("enrolled")?.value ?? 0
  }

  orderCount(): number {
    return this.counters.get("order")?.value ?? 0
  }

  nextOrderId(): { id: number; sequence: number } {
    const sequence = this.next("order")
    return { id: ORDER_BASE + this.base() + sequence, sequence }
  }

  nextTokenId(): number {
    return TOKEN_BASE + this.next("token")
  }

  uuid(): string {
    const raw = this.ids.next("uuid:", 32).slice("uuid:".length)
    const hex = [...raw].map((c) => "0123456789abcdef".charAt(c.charCodeAt(0) % 16))
    hex[12] = "4"
    hex[16] = "89ab".charAt(raw.charCodeAt(16) % 4)
    const h = hex.join("")
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
  }

  secret(): string {
    return this.ids.next("secret:", 43).slice("secret:".length)
  }

  signature(payload: string): string {
    return opaqueToken(`lifefile-v2:${payload}`, 43)
  }

  saveOrder(order: OrderRecord): OrderRecord {
    this.orders.insert(String(order.id), order)
    return order
  }

  order(id: number): OrderRecord | undefined {
    return this.orders.get(String(id))
  }

  indexRx(uuid: string, orderId: number): void {
    const key = uuid.toLowerCase()
    const entry = this.rxIndex.get(key)
    this.rxIndex.insert(key, { orderIds: [...(entry?.orderIds ?? []), orderId] })
  }

  ordersByRx(uuid: string): OrderRecord[] {
    const entry = this.rxIndex.get(uuid.toLowerCase())
    return (entry?.orderIds ?? []).flatMap((id) => {
      const order = this.order(id)
      return order ? [order] : []
    })
  }
}
