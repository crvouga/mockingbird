export type AdminApiConfig = {
  /** Stable key used by the global emulator selector. */
  id: string
  /** Human-readable selector label. Defaults to `service`. */
  label?: string
  service: string
  adminPrefix: string
  adminKeyHeader: string
  standardRoutes: readonly string[]
}
export type AdminConfig = {
  standardRoutes: readonly string[]
  adminPrefix: string
  adminKeyHeader: string
  brandsUrl: string
  service: string
  /** Admin APIs presented by this shell. Omit for the service-local API above. */
  apis?: readonly AdminApiConfig[]
}
export type MembersConfig = {
  currentUserId: string
  roles: readonly string[]
  permissions: Readonly<Record<string, readonly string[]>>
  apiPrefix: string
  dark: boolean
}
export type Api = {
  get<T>(path: string, signal?: AbortSignal): Promise<T>
  send<T = unknown>(method: string, path: string, body?: unknown): Promise<T>
  namespace(): string
}
export type Collection = {
  name: string
  label: string
  description?: string
  count: number
  source: string
  fields: { name: string; kind: string; optional: boolean; description?: string }[]
}
export type StateView = { namespace: string; collections: Collection[] }
export type StateRecord = { id: string; seq: number; value: unknown }
export type StatePage = {
  collection: string
  count: number
  records: StateRecord[]
  next: number | null
}
export type Clock = {
  now: number
  iso: string
  frozen: boolean
  offsetMs: number
  autoAdvanceMs: number
}
export type LatencyRule = { delayMs: number; jitterMs: number }
export type Latency = LatencyRule & { operations: Record<string, LatencyRule> }
export type Snapshot = {
  id: string
  namespace: string
  records: number
  at: number
  portable: boolean
}
export type Controls = {
  namespace: string
  seed: number | string
  clock: Clock
  virtualTime: boolean
  latency: Latency
  faults: Record<string, unknown>[]
  snapshots: Snapshot[]
}
export type FaultPreset = { name: string; description: string; rules?: Record<string, unknown>[] }
export type Journal = { requests: Record<string, unknown>[] }
export type Panel = {
  kind?: "panel"
  id: string
  title: string
  description?: string
  html: string
  script?: string
}
export type SqlExtension = { kind: "sql"; id: string; title: string; description?: string }
export type RouteExtension = {
  kind: "route"
  id: string
  title: string
  description?: string
  route: string
  body?: unknown
}
export type Manifest = {
  standardRoutes?: string[]
  panels: Panel[]
  extensions: (Panel | SqlExtension | RouteExtension)[]
}
export type SqlTable = {
  schema: string
  name: string
  kind: string
  columns: { name: string; type: string; primaryKey?: boolean }[]
}
export type SqlResult = {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount?: number
  total?: number
  truncated?: boolean
}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
export const text = (value: unknown): string => {
  if (value === null) return "NULL"
  if (value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? ""
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
