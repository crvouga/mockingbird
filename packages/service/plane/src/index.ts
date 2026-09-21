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
  type PlaneCommentRecord,
  type PlaneLabelRecord,
  type PlaneLinkRecord,
  PlaneState,
  type PlaneStateRecord,
  type PlaneWorkItemRecord,
  type ProjectRecord,
  type Settings,
  uuidFrom,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  PlaneCommentRecord,
  PlaneLabelRecord,
  PlaneLinkRecord,
  PlaneStateRecord,
  PlaneWorkItemRecord,
  ProjectRecord,
  Settings,
  StateGroup,
} from "./state.js"
export { DEFAULT_STATES, uuidFrom } from "./state.js"

export const PLANE_NAMESPACE = "plane"

export type PlaneAPIOptions = APIOptions & {
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
  private readonly service: Service
  private readonly now: () => number
  private readonly hits = new Map<string, number>()

  constructor(options: PlaneAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? PLANE_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new PlaneState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
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
        const key = apiKeyCredential(context.request)
        if (!key) return jsonRes(401, { detail: "Authentication credentials were not provided." })
        const settings = this.state.current()
        if (settings.apiKeys.length > 0 && !settings.apiKeys.includes(key)) {
          return jsonRes(401, { detail: "Given API token is not valid" })
        }
        if (settings.rateLimitPerMinute !== null) {
          const minute = Math.floor(this.now() / 60_000)
          const bucket = `${key}:${minute}`
          const used = (this.hits.get(bucket) ?? 0) + 1
          this.hits.set(bucket, used)
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

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.hits.clear()
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

  /** Plane's cursor paginator: `cursor=<per_page>:<page>:<is_prev>`, offset = page × per_page. */
  private paginate<T>(context: OperationContext, rows: T[]): Response {
    const perPageResult =
      context.query.per_page === undefined ? undefined : coerce.integer(context.query.per_page)
    if (perPageResult && !perPageResult.ok) {
      return jsonRes(400, { error: "Invalid per_page parameter." })
    }
    const perPage = Math.min(PAGE_SIZE, Math.max(1, perPageResult?.value ?? PAGE_SIZE))
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

  private body(context: OperationContext): Record<string, unknown> {
    const issues = bodyIssues(context)
    if (issues.length > 0) throw new HttpError(400, drfErrors(issues))
    return context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
  }

  /** Validate `state` / `labels` references against the project, DRF-style. */
  private references(
    project: ProjectRecord,
    body: Record<string, unknown>,
  ): { state?: PlaneStateRecord; labels?: string[] } {
    const out: { state?: PlaneStateRecord; labels?: string[] } = {}
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

  private createWorkItem(context: OperationContext): Response {
    const project = this.project(context)
    const body = this.body(context)
    const refs = this.references(project, body)
    const state =
      refs.state ?? this.statesOf(project.id).find((s) => s.default) ?? this.statesOf(project.id)[0]
    const now = this.iso()
    const html = typeof body.description_html === "string" ? body.description_html : "<p></p>"
    const item: PlaneWorkItemRecord = {
      id: this.state.uuid("work_item"),
      sequence_id: project.nextSequence,
      name: String(body.name).trim(),
      description_html: html,
      description_stripped: stripTags(html) || null,
      priority: (body.priority as PlaneWorkItemRecord["priority"]) ?? "none",
      state: state?.id ?? "",
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
    const next = this.applyPatch(item, {
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
