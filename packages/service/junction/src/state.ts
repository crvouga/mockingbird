import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { Collection, IdSequence, opaqueToken } from "@crvouga/mockingbird-service"

export type UserRecord = {
  user_id: string
  team_id: string
  client_user_id: string
  created_on: string
  connected_sources: unknown[]
  fallback_time_zone: { id: string; source_slug: string; updated_at: string } | null
  fallback_birth_date: null
  ingestion_start: null
  ingestion_end: null
}

/** Fixed mock team id — volatile on the real side, stable in the mock. */
export const MOCK_TEAM_ID = "11111111-1111-4111-8111-111111111111"

/** Deterministic UUID derived from a salt + sequence (version/variant bits fixed). */
export const deterministicUuid = (input: string): string => {
  const raw = opaqueToken(input, 32)
  let hex = ""
  for (let i = 0; i < raw.length && hex.length < 32; i++) {
    hex += (raw.charCodeAt(i) % 16).toString(16)
  }
  hex = hex.padEnd(32, "0").slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class JunctionState {
  readonly users: Collection<UserRecord>
  readonly ids: IdSequence
  readonly byClientId: Collection<{ user_id: string }>

  constructor(sqlite: SqliteClient, namespace: string) {
    this.users = new Collection(sqlite, namespace, "users")
    this.byClientId = new Collection(sqlite, namespace, "users_by_client")
    this.ids = new IdSequence(sqlite, namespace, "junction")
  }

  nextUserId(): string {
    const token = this.ids.next("usr_")
    return deterministicUuid(`junction:user:${token}`)
  }

  isoNow(now: () => number): string {
    return new Date(now()).toISOString().replace(/\.\d{3}Z$/, "+00:00")
  }
}
