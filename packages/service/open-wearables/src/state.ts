import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export const PROVIDERS = ["garmin", "polar", "whoop", "suunto", "oura", "apple", "fitbit"] as const
export type Provider = {
  provider: string
  name: string
  icon_url: null
  is_enabled: boolean
  has_cloud_api: boolean
}
export type User = {
  id: string
  external_user_id: string | null
  email: string | null
  created_at: string
}
export type Connection = {
  id: string
  user_id: string
  provider: string
  provider_user_id: string | null
  status: "active" | "revoked" | "expired"
  last_synced_at: string | null
  created_at: string
}
export type Task = {
  id: string
  user_id: string
  provider: string
  status: "pending" | "completed"
  created_at_ms: number
  completed_at_ms: number | null
}
export type Settings = { apiKeys: string[]; autoCompleteAfterMs: number | null }
export class WearablesState {
  readonly users: Collection<User>
  readonly providers: Collection<Provider>
  readonly connections: Collection<Connection>
  readonly tasks: Collection<Task>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.users = new Collection(sqlite, namespace, "users")
    this.providers = new Collection(sqlite, namespace, "providers")
    this.connections = new Collection(sqlite, namespace, "connections")
    this.tasks = new Collection(sqlite, namespace, "tasks")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace)
    this.init()
  }
  init() {
    if (!this.settings.get("current"))
      this.settings.insert("current", {
        apiKeys: ["open_wearables_test"],
        autoCompleteAfterMs: null,
        ...this.seed,
      })
    for (const provider of PROVIDERS)
      if (!this.providers.get(provider))
        this.providers.insert(provider, {
          provider,
          name:
            provider === "apple" ? "Apple Health" : provider[0]?.toUpperCase() + provider.slice(1),
          icon_url: null,
          is_enabled: true,
          has_cloud_api: provider !== "apple",
        })
  }
  current(): Settings {
    return this.settings.get("current") as Settings
  }
}
