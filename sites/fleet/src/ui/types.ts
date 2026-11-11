/** The parts of the control API's responses the dashboard reads (see `../openapi.ts`). */

export type Json = Record<string, unknown>

/** Ways to sign in, as `GET /config` reports them under `auth`. */
export const SIGN_IN_METHODS = ["oidc", "devLogin", "tokenLogin"] as const
export type Config = { auth: Record<(typeof SIGN_IN_METHODS)[number], boolean> }

/** Lowest to highest. */
export const ROLES = ["viewer", "member", "admin", "owner"] as const

export type Me = {
  kind: string
  user?: { id: string; email: string | null; name: string | null }
  orgs: Org[]
}
export type Org = {
  id: string
  slug: string
  name: string
  role?: string
  suspended: string | null
}
export type Project = { id: string; orgId: string; slug: string; name: string }
export type Emulator = {
  target: string
  durability: string
  url: string
  flushIntervalMs?: number
  status: {
    loaded: boolean
    dirty: boolean
    lastSavedAt: string | null
    storedBytes: number | null
    lastError: string | null
  }
}
export type Fleet = {
  id: string
  orgId: string
  projectId: string
  slug: string
  name: string
  access: string
  requestsPerMinute: number | null
  url: string
  emulators: Record<string, Emulator>
}
export type Key = {
  id: string
  name: string
  scope: string
  role: string | null
  projectId: string | null
  prefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  key?: string
}
export type CatalogEntry = {
  target: string
  displayName: string
  category: string
  description: string
}
export type Member = { userId: string; email: string | null; name: string | null; role: string }
export type Invite = {
  id: string
  email: string
  role: string
  expiresAt: string
  acceptUrl?: string
}
export type UsageReport = {
  limits: Record<string, number>
  usage: Record<string, number>
  daily: { day: string; requests: number }[]
}
