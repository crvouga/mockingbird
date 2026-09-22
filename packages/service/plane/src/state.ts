import { Collection, IdSequence, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled" | "triage"

export type PlaneStateRecord = {
  id: string
  name: string
  group: StateGroup
  color: string
  sequence: number
  default: boolean
  description: string
  project: string
  workspace: string
  created_at: string
  updated_at: string
}

export type PlaneLabelRecord = {
  id: string
  name: string
  color: string
  description: string
  parent: string | null
  sort_order: number
  project: string
  workspace: string
  created_at: string
  updated_at: string
}

export type PlaneWorkItemRecord = {
  id: string
  sequence_id: number
  name: string
  description_html: string
  description_stripped: string | null
  priority: "urgent" | "high" | "medium" | "low" | "none"
  state: string
  labels: string[]
  assignees: string[]
  parent: string | null
  start_date: string | null
  target_date: string | null
  completed_at: string | null
  archived_at: string | null
  is_draft: boolean
  sort_order: number
  project: string
  workspace: string
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type PlaneCommentRecord = {
  id: string
  comment_html: string
  comment_stripped: string
  access: string
  issue: string
  actor: string | null
  project: string
  workspace: string
  created_at: string
  updated_at: string
}

export type PlaneLinkRecord = {
  id: string
  url: string
  title: string | null
  metadata: Record<string, unknown>
  issue: string
  project: string
  workspace: string
  created_at: string
  updated_at: string
}

/** One project: its workspace slug and the per-project work-item sequence. */
export type ProjectRecord = {
  id: string
  workspace: string
  identifier: string
  nextSequence: number
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these API keys authenticate; empty means any non-empty key does. */
  apiKeys: string[]
  /** Requests per mock-clock minute per key before 429 (Plane allows 60). `null`: unlimited. */
  rateLimitPerMinute: number | null
  /** Only these `workspace/project` pairs exist; empty means any is provisioned on first use. */
  projects: string[]
}

export const DEFAULT_SETTINGS: Settings = { apiKeys: [], rateLimitPerMinute: null, projects: [] }

/** The workflow every new Plane project starts with. */
export const DEFAULT_STATES: readonly { name: string; group: StateGroup; color: string }[] = [
  { name: "Backlog", group: "backlog", color: "#A3A3A3" },
  { name: "Todo", group: "unstarted", color: "#3A3A3A" },
  { name: "In Progress", group: "started", color: "#F59E0B" },
  { name: "Done", group: "completed", color: "#16A34A" },
  { name: "Cancelled", group: "cancelled", color: "#EF4444" },
]

const HEX = "0123456789abcdef"

/** A deterministic, well-formed v4 UUID derived from `input` (our client validates uuids). */
export const uuidFrom = (input: string): string => {
  const token = opaqueToken(input, 32)
  const hex = [...token].map((c) => HEX.charAt(c.charCodeAt(0) % 16))
  hex[12] = "4"
  hex[16] = HEX.charAt(8 + (token.charCodeAt(16) % 4))
  const s = hex.join("")
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

export class PlaneState {
  readonly projects: Collection<ProjectRecord>
  readonly states: Collection<PlaneStateRecord>
  readonly labels: Collection<PlaneLabelRecord>
  readonly items: Collection<PlaneWorkItemRecord>
  readonly comments: Collection<PlaneCommentRecord>
  readonly links: Collection<PlaneLinkRecord>
  readonly settings: Collection<Settings>
  readonly rateLimits: Collection<number>
  private readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.projects = new Collection(sqlite, namespace, "projects")
    this.states = new Collection(sqlite, namespace, "states")
    this.labels = new Collection(sqlite, namespace, "labels")
    this.items = new Collection(sqlite, namespace, "work_items")
    this.comments = new Collection(sqlite, namespace, "comments")
    this.links = new Collection(sqlite, namespace, "links")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.rateLimits = new Collection(sqlite, namespace, "rate_limits")
    this.ids = new IdSequence(sqlite, namespace, "plane")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed })
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

  takeRateLimit(bucket: string): number {
    const used = (this.rateLimits.get(bucket) ?? 0) + 1
    if (!this.rateLimits.update(bucket, used)) this.rateLimits.insert(bucket, used)
    return used
  }

  uuid(kind: string): string {
    return uuidFrom(this.ids.next(`${kind}:`, 32))
  }
}
