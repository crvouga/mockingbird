import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  type BodyIssue,
  bodyIssues,
  bootSqlite,
  coerce,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  DEFAULT_STATES,
  type PlaneAttachment,
  type PlaneCommentRecord,
  type PlaneCycleRecord,
  type PlaneLabelRecord,
  type PlaneLinkRecord,
  PlaneState,
  type PlaneStateRecord,
  type PlaneWorkItemRecord,
  type PlaneWorkItemType,
  type ProjectRecord,
  type Settings,
  uuidFrom,
  type WorkItemTypeSeed,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  PlaneCommentRecord,
  PlaneCycleMembership,
  PlaneCycleRecord,
  PlaneLabelRecord,
  PlaneLinkRecord,
  PlaneStateRecord,
  PlaneWorkItemRecord,
  PlaneWorkItemType,
  ProjectRecord,
  Settings,
  StateGroup,
  WorkItemTypeSeed,
} from "./state.js"
export { DEFAULT_STATES, uuidFrom } from "./state.js"

export const PLANE_NAMESPACE = "plane"

export type PlaneAPIOptions = APIOptions & {
  adminPrefix?: string
  publicNamespace?: string
  /** Initial per-namespace settings (API keys, rate limit, fixed projects). */
  settings?: Partial<Settings>
}

/** The `X-API-Key` a request carries, how credentials map to namespaces. */
export const apiKeyCredential = (request: Request): string | undefined =>
  request.headers.get("x-api-key")?.trim() || undefined

const NOT_FOUND = { error: "The requested resource does not exist." }
const PAGE_SIZE = 100

const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

/** DRF-style validation errors: `{field: ["message"]}`. */
const drfErrors = (issues: BodyIssue[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {}
  for (const issue of issues) {
    const missing = /^missing required property (.+)$/.exec(issue.message)
    const field = missing ? (missing[1] as string) : issue.path.split(".")[0] || "non_field_errors"
    const message = missing ? "This field is required." : `Invalid value: ${issue.message}.`
    out[field] = [...(out[field] ?? []), message]
  }
  return out
}

/**
 * Stateful mock of Plane's REST API v1 for bug-report projects: work items with Plane's cursor
 * pagination (`<per_page>:<page>:<is_prev>`), comments, links, states and labels. Projects are
 * provisioned on first use with Plane's default workflow unless `settings.projects` pins them.
 */
export class PlaneAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: PlaneState
  private readonly adminPrefix: string
  private readonly publicNamespace: string
  private readonly multipart = new WeakMap<Request, FormData>()
  private readonly service: Service
  private readonly now: () => number

  constructor(options: PlaneAPIOptions = {}) {
    this.adminPrefix = options.adminPrefix ?? "/__admin"
    this.publicNamespace = options.publicNamespace ?? ""
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? PLANE_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new PlaneState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      CreateAttachment: (context) => this.createAttachment(context),
      UploadAttachment: (context) => this.uploadAttachment(context),
      ConfirmAttachment: (context) => this.confirmAttachment(context),
      ListAttachments: (context) =>
        jsonRes(
          200,
          this.attachmentsOf(this.item(context).id)
            .filter((a) => a.is_uploaded)
            .map((a) => this.publicAttachment(a)),
        ),
      ListWorkItems: (context) => this.listWorkItems(context),
      CreateWorkItem: (context) => this.createWorkItem(context),
      GetWorkItem: (context) => {
        const item = this.item(context)
        return annotateResponse(jsonRes(200, item), { ids: { workItemId: item.id } })
      },
      UpdateWorkItem: (context) => this.updateWorkItem(context),
      ListComments: (context) => {
        const item = this.item(context)
        return this.paginate(
          context,
          this.state.comments
            .list({ order: "oldest", where: (c) => c.issue === item.id })
            .map((r) => r.value),
        )
      },
      CreateComment: (context) => this.createComment(context),
      ListLinks: (context) => {
        const item = this.item(context)
        return this.paginate(
          context,
          this.state.links.list({ where: (l) => l.issue === item.id }).map((r) => r.value),
        )
      },
      CreateLink: (context) => this.createLink(context),
      ListStates: (context) => {
        const project = this.project(context)
        return this.paginate(context, this.statesOf(project.id))
      },
      ListLabels: (context) => {
        const project = this.project(context)
        return this.paginate(context, this.labelsOf(project.id))
      },
      CreateLabel: (context) => this.createLabel(context),
      ListCycles: (context) => this.listCycles(context),
      CreateCycle: (context) => this.createCycle(context),
      ListCycleWorkItems: (context) => this.listCycleWorkItems(context),
      AddCycleWorkItems: (context) => this.addCycleWorkItems(context),
      ListWorkItemTypes: (context) => jsonRes(200, this.typesOf(this.project(context).id)),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { detail: "Not found." }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        if (context.operation.operationId === "UploadAttachment") return undefined
        const key = apiKeyCredential(context.request)
        if (!key) return jsonRes(401, { detail: "Authentication credentials were not provided." })
        const settings = this.state.current()
        if (settings.apiKeys.length > 0 && !settings.apiKeys.includes(key)) {
          return jsonRes(401, { detail: "Given API token is not valid" })
        }
        if (settings.rateLimitPerMinute !== null) {
          const minute = Math.floor(this.now() / 60_000)
          const bucket = `${key}:${minute}`
          const used = this.state.takeRateLimit(bucket)
          if (used > settings.rateLimitPerMinute) {
            const reset = (minute + 1) * 60
            return jsonRes(
              429,
              {
                detail: `Request was throttled. Expected available in ${reset - Math.floor(this.now() / 1000)} seconds.`,
              },
              { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            )
          }
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  async fetch(request: Request): Promise<Response> {
    if (
      new URL(request.url).pathname === "/__admin/blobs/plane/uploads" &&
      request.method === "POST"
    ) {
      try {
        this.multipart.set(request, await request.clone().formData())
      } catch {
        return jsonRes(400, { error: "Malformed multipart upload" })
      }
    }
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /** The project a request addresses, provisioned with the default workflow on first use. */
  ensureProject(workspace: string, projectId: string): ProjectRecord | undefined {
    const existing = this.state.projects.get(projectId)
    if (existing) return existing.workspace === workspace ? existing : undefined
    const pinned = this.state.current().projects
    if (pinned.length > 0 && !pinned.includes(`${workspace}/${projectId}`)) return undefined
    const project: ProjectRecord = {
      id: projectId,
      workspace,
      identifier: "BUGS",
      nextSequence: 1,
    }
    this.state.projects.insert(projectId, project)
    const now = this.iso()
    DEFAULT_STATES.forEach((state, index) => {
      const id = uuidFrom(`${projectId}:state:${state.name}`)
      this.state.states.insert(id, {
        id,
        name: state.name,
        group: state.group,
        color: state.color,
        sequence: (index + 1) * 15_000,
        default: index === 0,
        description: "",
        project: projectId,
        workspace,
        created_at: now,
        updated_at: now,
      })
    })
    return project
  }

  private project(context: OperationContext): ProjectRecord {
    const project = this.ensureProject(context.params.slug ?? "", context.params.project_id ?? "")
    if (!project) throw new HttpError(404, NOT_FOUND)
    return project
  }

  private item(context: OperationContext): PlaneWorkItemRecord {
    const project = this.project(context)
    const item = this.state.items.get(context.params.work_item_id ?? "")
    if (!item || item.project !== project.id) throw new HttpError(404, NOT_FOUND)
    return item
  }

  statesOf(projectId: string): PlaneStateRecord[] {
    return this.state.states
      .list({ order: "oldest", where: (s) => s.project === projectId })
      .map((r) => r.value)
  }

  labelsOf(projectId: string): PlaneLabelRecord[] {
    return this.state.labels
      .list({ order: "oldest", where: (l) => l.project === projectId })
      .map((r) => r.value)
  }

  typesOf(projectId: string): PlaneWorkItemType[] {
    return this.state.types
      .list({
        order: "oldest",
        where: (type) => type.project_ids.includes(projectId) && type.deleted_at === null,
      })
      .map((row) => row.value)
  }

  /** Idempotent fixture provisioning; type IDs remain stable when metadata is reseeded. */
  seedWorkItemTypes(
    workspace: string,
    projectId: string,
    types: WorkItemTypeSeed[],
  ): PlaneWorkItemType[] | undefined {
    const project = this.ensureProject(workspace, projectId)
    if (!project) return undefined
    const now = this.iso()
    for (const type of types) {
      const id = uuidFrom(`${projectId}:type:${type.name}`)
      const existing = this.state.types.get(id)
      this.state.types.insert(id, {
        id,
        name: type.name,
        description: type.description ?? existing?.description ?? "",
        project_ids: [project.id],
        logo_props: {},
        is_epic: false,
        is_default: type.is_default ?? existing?.is_default ?? false,
        is_active: true,
        level: 0,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        deleted_at: null,
      })
    }
    return this.typesOf(project.id)
  }

  /** Plane's cursor paginator: `cursor=<per_page>:<page>:<is_prev>`, offset = page × per_page. */
  private paginate<T>(context: OperationContext, rows: T[], defaultSize = PAGE_SIZE): Response {
    const perPageResult =
      context.query.per_page === undefined ? undefined : coerce.integer(context.query.per_page)
    if (perPageResult && !perPageResult.ok) {
      return jsonRes(400, { error: "Invalid per_page parameter." })
    }
    const perPage = Math.min(PAGE_SIZE, Math.max(1, perPageResult?.value ?? defaultSize))
    let page = 0
    let cursorSize = perPage
    if (context.query.cursor !== undefined) {
      const match = /^(\d+):(-?\d+):([01])$/.exec(String(context.query.cursor))
      if (!match || Number(match[2]) < 0 || Number(match[1]) < 1) {
        return jsonRes(400, { error: "Invalid cursor format." })
      }
      cursorSize = Number(match[1])
      page = Number(match[2])
    }
    const offset = page * cursorSize
    const results = rows.slice(offset, offset + perPage)
    const total = rows.length
    let nextCursor = `${perPage}:${page + 1}:0`
    let nextPageResults = offset + perPage < total
    if (faultEffect(context.request, "pagination_missing_cursor") !== undefined) {
      nextCursor = ""
      nextPageResults = true
    }
    if (faultEffect(context.request, "pagination_repeated_cursor") !== undefined) {
      nextCursor = `${perPage}:1:0`
      nextPageResults = true
    }
    return jsonRes(200, {
      grouped_by: null,
      sub_grouped_by: null,
      total_count: total,
      next_cursor: nextCursor,
      prev_cursor: `${perPage}:${page - 1}:1`,
      next_page_results: nextPageResults,
      prev_page_results: page > 0,
      count: results.length,
      total_pages: Math.ceil(total / perPage),
      total_results: total,
      extra_stats: null,
      results,
    })
  }

  private listWorkItems(context: OperationContext): Response {
    const project = this.project(context)
    if (context.query.external_source && context.query.external_id) {
      const matches = this.state.items
        .list({
          where: (i) =>
            i.project === project.id &&
            i.external_source === context.query.external_source &&
            i.external_id === context.query.external_id,
        })
        .map((r) => r.value)
      if (!matches.length) throw new HttpError(404, NOT_FOUND)
      if (matches.length > 1)
        return jsonRes(500, { error: "Multiple work items match the external identity." })
      return jsonRes(200, matches[0])
    }
    const orderBy =
      typeof context.query.order_by === "string" ? context.query.order_by : "-created_at"
    const descending = orderBy.startsWith("-")
    const field = (descending ? orderBy.slice(1) : orderBy) as keyof PlaneWorkItemRecord
    const rows = this.state.items
      .list({ order: "oldest", where: (i) => i.project === project.id })
      .map((r) => r.value)
      .sort((a, b) => {
        const x = a[field] ?? ""
        const y = b[field] ?? ""
        const order = x < y ? -1 : x > y ? 1 : a.sequence_id - b.sequence_id
        return descending ? -order : order
      })
    return this.paginate(context, rows)
  }

  private cycle(context: OperationContext): PlaneCycleRecord {
    const project = this.project(context)
    const cycle = this.state.cycles.get(context.params.cycle_id ?? "")
    if (!cycle || cycle.project !== project.id) throw new HttpError(404, NOT_FOUND)
    return cycle
  }

  private cycleView(cycle: PlaneCycleRecord): Record<string, unknown> {
    const members = this.state.memberships
      .list({ where: (m) => m.cycle === cycle.id })
      .map((row) => this.state.items.get(row.value.issue))
      .filter((item): item is PlaneWorkItemRecord => !!item && !item.archived_at && !item.is_draft)
    const count = (group: string) =>
      members.filter((item) => this.state.states.get(item.state)?.group === group).length
    return {
      ...cycle,
      total_issues: members.length,
      completed_issues: count("completed"),
      cancelled_issues: count("cancelled"),
      started_issues: count("started"),
      unstarted_issues: count("unstarted"),
      backlog_issues: count("backlog"),
    }
  }

  private listCycles(context: OperationContext): Response {
    const project = this.project(context)
    const view = context.query.cycle_view ?? "all"
    const now = this.now()
    const rows = this.state.cycles
      .list({
        order: "newest",
        where: (cycle) => {
          if (cycle.project !== project.id || cycle.archived_at) return false
          const start = cycle.start_date === null ? null : Date.parse(cycle.start_date)
          const end = cycle.end_date === null ? null : Date.parse(cycle.end_date)
          if (view === "current")
            return start !== null && end !== null && start <= now && end >= now
          if (view === "upcoming") return start !== null && start > now
          if (view === "completed") return end !== null && end < now
          if (view === "draft") return start === null && end === null
          if (view === "incomplete") return end === null || end >= now
          return true
        },
      })
      .map((row) => row.value)
    const orderBy =
      typeof context.query.order_by === "string" ? context.query.order_by : "-created_at"
    const descending = orderBy.startsWith("-")
    const field = (descending ? orderBy.slice(1) : orderBy) as keyof PlaneCycleRecord
    rows.sort((a, b) => {
      const x = a[field] ?? ""
      const y = b[field] ?? ""
      const order = x < y ? -1 : x > y ? 1 : 0
      return descending ? -order : order
    })
    const results = rows.map((cycle) => this.cycleView(cycle))
    return view === "current" ? jsonRes(200, results) : this.paginate(context, results, 20)
  }

  private createCycle(context: OperationContext): Response {
    const project = this.project(context)
    const body = this.body(context)
    const start = body.start_date ?? null
    const end = body.end_date ?? null
    if ((start === null) !== (end === null))
      throw new HttpError(400, {
        error: "Both start date and end date are either required or are to be null",
      })
    const date = (value: unknown, field: string): string | null => {
      if (value === null) return null
      const text = String(value)
      const day = text.slice(0, 10)
      const instant = Date.parse(text)
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(instant) ||
        new Date(Date.parse(day)).toISOString().slice(0, 10) !== day
      ) {
        throw new HttpError(400, { [field]: ["Datetime has wrong format."] })
      }
      return day
    }
    const startDay = date(start, "start_date")
    const endDay = date(end, "end_date")
    if (startDay && endDay && startDay > endDay)
      throw new HttpError(400, {
        non_field_errors: ["Start date cannot exceed end date"],
      })
    const now = this.iso()
    const existing =
      body.external_source && body.external_id
        ? this.state.cycles.list({
            where: (cycle) =>
              cycle.project === project.id &&
              cycle.external_id === body.external_id &&
              cycle.external_source === body.external_source,
          })[0]?.value
        : undefined
    if (existing)
      return jsonRes(409, {
        error: "Cycle with the same external id and external source already exists",
        id: existing.id,
      })
    const cycle: PlaneCycleRecord = {
      id: this.state.uuid("cycle"),
      name: String(body.name).trim(),
      description: typeof body.description === "string" ? body.description : "",
      start_date: startDay
        ? startDay === now.slice(0, 10)
          ? now
          : `${startDay}T00:00:01.000Z`
        : null,
      end_date: endDay ? `${endDay}T23:59:00.000Z` : null,
      owned_by: typeof body.owned_by === "string" ? body.owned_by : uuidFrom("plane-bot"),
      timezone: typeof body.timezone === "string" ? body.timezone : "UTC",
      external_id: typeof body.external_id === "string" ? body.external_id : null,
      external_source: typeof body.external_source === "string" ? body.external_source : null,
      project: project.id,
      workspace: project.workspace,
      created_at: now,
      updated_at: now,
      archived_at: null,
      deleted_at: null,
    }
    this.state.cycles.insert(cycle.id, cycle)
    return annotateResponse(jsonRes(201, cycle), { ids: { cycleId: cycle.id } })
  }

  private listCycleWorkItems(context: OperationContext): Response {
    const project = this.project(context)
    const rows = this.state.memberships
      .list({
        order: "oldest",
        where: (m) => m.cycle === context.params.cycle_id && m.project === project.id,
      })
      .flatMap((row) => {
        const item = this.state.items.get(row.value.issue)
        return item && item.project === project.id ? [{ ...item, bridge_id: row.value.id }] : []
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.sequence_id - b.sequence_id)
    return this.paginate(context, rows, 20)
  }

  private addCycleWorkItems(context: OperationContext): Response {
    const body = this.body(context)
    const ids = body.issues as string[]
    if (!ids?.length)
      throw new HttpError(400, { error: "Work items are required", code: "MISSING_WORK_ITEMS" })
    const cycle = this.cycle(context)
    if (cycle.end_date && Date.parse(cycle.end_date) < this.now())
      throw new HttpError(400, {
        code: "CYCLE_COMPLETED",
        message: "The Cycle has already been completed so no new issues can be added",
      })
    for (const id of new Set(ids)) {
      const item = this.state.items.get(id)
      if (!item || item.project !== cycle.project || item.workspace !== cycle.workspace) continue
      const membership = this.state.memberships.list({ where: (m) => m.issue === id })[0]?.value
      if (membership) {
        if (membership.cycle !== cycle.id)
          this.state.memberships.update(membership.id, { ...membership, cycle: cycle.id })
      } else {
        const membershipId = this.state.uuid("cycle_membership")
        const now = this.iso()
        this.state.memberships.insert(membershipId, {
          id: membershipId,
          cycle: cycle.id,
          issue: id,
          project: cycle.project,
          workspace: cycle.workspace,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        })
      }
    }
    const rows = this.state.memberships
      .list({ order: "newest", where: (m) => m.cycle === cycle.id })
      .map((row) => row.value)
    return jsonRes(200, rows)
  }

  private body(context: OperationContext): Record<string, unknown> {
    const issues = bodyIssues(context)
    if (issues.length > 0) throw new HttpError(400, drfErrors(issues))
    return context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
  }

  /** Validate workflow references before any part of a write is persisted, DRF-style. */
  private references(
    project: ProjectRecord,
    body: Record<string, unknown>,
  ): { state?: PlaneStateRecord; labels?: string[]; typeId?: string | null } {
    const out: { state?: PlaneStateRecord; labels?: string[]; typeId?: string | null } = {}
    if (body.type_id === null) out.typeId = null
    else if (typeof body.type_id === "string") {
      const type = this.state.types.get(body.type_id)
      if (!type?.project_ids.includes(project.id) || type.deleted_at !== null) {
        throw new HttpError(400, {
          type_id: [`Invalid pk "${body.type_id}" - object does not exist.`],
        })
      }
      out.typeId = type.id
    }
    if (typeof body.state === "string") {
      const state = this.state.states.get(body.state)
      if (!state || state.project !== project.id) {
        throw new HttpError(400, { state: [`Invalid pk "${body.state}" - object does not exist.`] })
      }
      out.state = state
    }
    if (Array.isArray(body.labels)) {
      const labels = body.labels.map(String)
      const missing = labels.find((id) => this.state.labels.get(id)?.project !== project.id)
      if (missing) {
        throw new HttpError(400, { labels: [`Invalid pk "${missing}" - object does not exist.`] })
      }
      out.labels = [...new Set(labels)]
    }
    return out
  }

  attachmentsOf(id: string): PlaneAttachment[] {
    return this.state.attachments.list({ where: (a) => a.issue === id }).map((r) => r.value)
  }

  private publicAttachment(a: PlaneAttachment) {
    return { id: a.id, attributes: a.attributes, is_uploaded: a.is_uploaded, issue: a.issue }
  }

  private createAttachment(context: OperationContext): Response {
    const item = this.item(context)
    const body = this.body(context)
    const size = Math.trunc(Number(body.size))
    if (typeof body.name !== "string" || !body.name.trim() || !Number.isFinite(size) || size <= 0) {
      return jsonRes(400, { error: "Invalid request.", status: false })
    }
    if (
      typeof body.type !== "string" ||
      ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
      ].includes(body.type)
    ) {
      return jsonRes(400, { error: "Invalid file type.", status: false })
    }
    const id = this.state.uuid("attachment")
    const fields = {
      "Content-Type": body.type,
      key: id,
      policy: `mockingbird-policy-${id}`,
      "x-amz-signature": `mockingbird-signature-${id}`,
    }
    const attachment: PlaneAttachment = {
      id,
      issue: item.id,
      attributes: { name: body.name, type: body.type, size: Math.min(size, 5 * 1024 * 1024) },
      fields,
      bytes: null,
      sha256: null,
      is_uploaded: false,
    }
    this.state.attachments.insert(id, attachment)
    const origin = new URL(context.request.url).origin
    if (faultEffect(context.request, "attachment_slot_malformed") !== undefined)
      return jsonRes(200, { asset_id: id })
    return jsonRes(200, {
      asset_id: id,
      upload_data: {
        url: `${origin}${this.adminPrefix}/blobs/plane/uploads?${new URLSearchParams({ namespace: this.publicNamespace })}`,
        fields,
      },
      attachment: this.publicAttachment(attachment),
      asset_url: `${origin}/__storage/plane/assets/${id}`,
    })
  }

  private async uploadAttachment(context: OperationContext): Promise<Response> {
    const deny = () =>
      new Response("<Error><Code>AccessDenied</Code></Error>", {
        status: 403,
        headers: { "content-type": "application/xml" },
      })
    const form = this.multipart.get(context.request)
    if (!form) return deny()
    const asset = this.state.attachments.get(String(form.get("key") ?? ""))
    if (!asset) return deny()
    const entries = [...form.entries()]
    const file = form.get("file")
    if (
      !(file instanceof Blob) ||
      entries.at(-1)?.[0] !== "file" ||
      entries.length !== Object.keys(asset.fields).length + 1
    )
      return deny()
    for (const [key, value] of Object.entries(asset.fields)) {
      if (form.getAll(key).length !== 1 || form.get(key) !== value) return deny()
    }
    if (!file.size || file.size > asset.attributes.size) return deny()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    this.state.attachments.update(asset.id, {
      ...asset,
      bytes: [...bytes],
      sha256: [...hash].map((b) => b.toString(16).padStart(2, "0")).join(""),
    })
    return new Response(null, { status: 204 })
  }

  private confirmAttachment(context: OperationContext): Response {
    const item = this.item(context)
    if (faultEffect(context.request, "attachment_confirm_failed") !== undefined)
      return jsonRes(500, { error: "Attachment confirmation failed" })
    const asset = this.state.attachments.get(context.params.asset_id ?? "")
    if (!asset || asset.issue !== item.id) throw new HttpError(404, NOT_FOUND)
    const body = this.body(context)
    if (body.is_uploaded !== true || !asset.bytes)
      return jsonRes(400, { error: "Upload the file before confirming.", status: false })
    this.state.attachments.update(asset.id, { ...asset, is_uploaded: true })
    return new Response(null, { status: 204 })
  }

  private checkExternal(project: string, source: unknown, id: unknown, exclude?: string): void {
    if (!source || !id) return
    const existing = this.state.items.list({
      where: (i) =>
        i.project === project &&
        i.id !== exclude &&
        i.external_source === source &&
        i.external_id === id,
    })[0]?.value
    if (existing)
      throw new HttpError(409, {
        error: "Issue with the same external id and external source already exists",
        id: existing.id,
      })
  }

  private createWorkItem(context: OperationContext): Response {
    const project = this.project(context)
    const body = this.body(context)
    const refs = this.references(project, body)
    const state =
      refs.state ?? this.statesOf(project.id).find((s) => s.default) ?? this.statesOf(project.id)[0]
    const now = this.iso()
    const html = typeof body.description_html === "string" ? body.description_html : "<p></p>"
    const typeId =
      refs.typeId ?? this.typesOf(project.id).find((type) => type.is_default)?.id ?? null
    this.checkExternal(project.id, body.external_source, body.external_id)
    const item: PlaneWorkItemRecord = {
      external_source: typeof body.external_source === "string" ? body.external_source : null,
      external_id: typeof body.external_id === "string" ? body.external_id : null,
      id: this.state.uuid("work_item"),
      sequence_id: project.nextSequence,
      name: String(body.name).trim(),
      description_html: html,
      description_stripped: stripTags(html) || null,
      priority: (body.priority as PlaneWorkItemRecord["priority"]) ?? "none",
      state: state?.id ?? "",
      type_id: typeId,
      type: typeId,
      labels: refs.labels ?? [],
      assignees: [],
      parent: null,
      start_date: null,
      target_date: null,
      completed_at: state?.group === "completed" ? now : null,
      archived_at: null,
      is_draft: false,
      sort_order: 65_535 * project.nextSequence,
      project: project.id,
      workspace: project.workspace,
      created_by: uuidFrom("plane-bot"),
      updated_by: uuidFrom("plane-bot"),
      created_at: now,
      updated_at: now,
    }
    this.state.items.insert(item.id, item)
    this.state.projects.update(project.id, { ...project, nextSequence: project.nextSequence + 1 })
    return annotateResponse(jsonRes(201, item), { ids: { workItemId: item.id } })
  }

  private updateWorkItem(context: OperationContext): Response {
    const item = this.item(context)
    const project = this.project(context)
    const body = this.body(context)
    const refs = this.references(project, body)
    this.checkExternal(
      project.id,
      body.external_source === undefined ? item.external_source : body.external_source,
      body.external_id === undefined ? item.external_id : body.external_id,
      item.id,
    )
    const next = this.applyPatch(item, {
      ...(body.external_source !== undefined
        ? { external_source: body.external_source as string | null }
        : {}),
      ...(body.external_id !== undefined ? { external_id: body.external_id as string | null } : {}),
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(typeof body.description_html === "string"
        ? {
            description_html: body.description_html,
            description_stripped: stripTags(body.description_html) || null,
          }
        : {}),
      ...(typeof body.priority === "string"
        ? { priority: body.priority as PlaneWorkItemRecord["priority"] }
        : {}),
      ...(refs.labels ? { labels: refs.labels } : {}),
      ...(refs.state ? { state: refs.state.id } : {}),
      ...(refs.typeId !== undefined ? { type_id: refs.typeId, type: refs.typeId } : {}),
    })
    return annotateResponse(jsonRes(200, next), { ids: { workItemId: next.id } })
  }

  /** Merge a patch, keeping `completed_at` in step with the state's group. */
  applyPatch(item: PlaneWorkItemRecord, patch: Partial<PlaneWorkItemRecord>): PlaneWorkItemRecord {
    const now = this.iso()
    const merged = { ...item, ...patch, updated_at: now }
    const group = this.state.states.get(merged.state)?.group
    merged.completed_at = group === "completed" ? (item.completed_at ?? now) : null
    this.state.items.update(item.id, merged)
    return merged
  }

  private createComment(context: OperationContext): Response {
    const item = this.item(context)
    const body = this.body(context)
    const now = this.iso()
    const html = String(body.comment_html)
    const comment: PlaneCommentRecord = {
      id: this.state.uuid("comment"),
      comment_html: html,
      comment_stripped: stripTags(html),
      access: typeof body.access === "string" ? body.access : "INTERNAL",
      issue: item.id,
      actor: uuidFrom("plane-bot"),
      project: item.project,
      workspace: item.workspace,
      created_at: now,
      updated_at: now,
    }
    this.state.comments.insert(comment.id, comment)
    return annotateResponse(jsonRes(201, comment), {
      ids: { workItemId: item.id, commentId: comment.id },
    })
  }

  private createLink(context: OperationContext): Response {
    const item = this.item(context)
    const body = this.body(context)
    const url = String(body.url)
    const duplicate = this.state.links.list({
      where: (l) => l.issue === item.id && l.url === url,
    })[0]
    if (duplicate) {
      return jsonRes(409, { error: "URL already exists for this Issue", id: duplicate.value.id })
    }
    const now = this.iso()
    const link: PlaneLinkRecord = {
      id: this.state.uuid("link"),
      url,
      title: typeof body.title === "string" ? body.title : null,
      metadata: {},
      issue: item.id,
      project: item.project,
      workspace: item.workspace,
      created_at: now,
      updated_at: now,
    }
    this.state.links.insert(link.id, link)
    return annotateResponse(jsonRes(201, link), { ids: { workItemId: item.id, linkId: link.id } })
  }

  private createLabel(context: OperationContext): Response {
    const project = this.project(context)
    const body = this.body(context)
    const name = String(body.name).trim()
    const existing = this.labelsOf(project.id).find((l) => l.name === name)
    if (existing) {
      return jsonRes(409, {
        error: "Label with the same name already exists in the project",
        id: existing.id,
      })
    }
    const now = this.iso()
    const label: PlaneLabelRecord = {
      id: this.state.uuid("label"),
      name,
      color: typeof body.color === "string" ? body.color : "#6366F1",
      description: typeof body.description === "string" ? body.description : "",
      parent: null,
      sort_order: 65_535 * (this.labelsOf(project.id).length + 1),
      project: project.id,
      workspace: project.workspace,
      created_at: now,
      updated_at: now,
    }
    this.state.labels.insert(label.id, label)
    return annotateResponse(jsonRes(201, label), { ids: { labelId: label.id } })
  }

  /**
   * Move a work item to a state (by id or name), the way a teammate would in Plane's UI:
   * e.g. `Done` makes the resolution watcher see group `completed`.
   */
  moveToState(workItemId: string, stateIdOrName: string): PlaneWorkItemRecord | undefined {
    const item = this.state.items.get(workItemId)
    if (!item) return undefined
    const state = this.statesOf(item.project).find(
      (s) => s.id === stateIdOrName || s.name.toLowerCase() === stateIdOrName.toLowerCase(),
    )
    if (!state) return undefined
    return this.applyPatch(item, { state: state.id })
  }

  workItems(): PlaneWorkItemRecord[] {
    return this.state.items.list({ order: "oldest" }).map((r) => r.value)
  }
}

export type { PlaneRuntime, PlaneRuntimeOptions } from "./runtime.js"
export { createRuntime, PLANE_PRESETS } from "./runtime.js"
