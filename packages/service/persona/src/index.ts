import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bootSqlite,
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
import { type InquiryRecord, type InquiryStatus, PersonaState, type Settings } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { InquiryRecord, InquiryStatus, Settings } from "./state.js"
export { DEFAULT_SETTINGS } from "./state.js"

export const PERSONA_NAMESPACE = "persona"

/** The API version our consumer pins (`Persona-Version`). */
export const PERSONA_VERSION = "2023-01-05"

/** Persona's event names, one per lifecycle step. */
export type PersonaEventName =
  | "inquiry.created"
  | "inquiry.started"
  | "inquiry.completed"
  | "inquiry.approved"
  | "inquiry.declined"
  | "inquiry.marked-for-review"
  | "inquiry.failed"
  | "inquiry.expired"

/** The event envelope Persona posts: `{data: {type: "event", id, attributes: {name, payload}}}`. */
export type PersonaWebhook = {
  data: {
    type: "event"
    id: string
    attributes: {
      name: PersonaEventName
      payload: { data: ReturnType<typeof inquiryResource>; included: unknown[]; meta: object }
      "created-at": string
    }
  }
}

/** Admin actions on an inquiry (`POST /__admin/inquiries/:id/<action>`). */
export type InquiryAction =
  | "start"
  | "complete"
  | "approve"
  | "decline"
  | "needs_review"
  | "fail"
  | "expire"

export const INQUIRY_ACTIONS: readonly InquiryAction[] = [
  "start",
  "complete",
  "approve",
  "decline",
  "needs_review",
  "fail",
  "expire",
]

export type PersonaAPIOptions = APIOptions & {
  /** Initial per-namespace settings (accepted API keys, known templates). */
  settings?: Partial<Settings>
  /** The public namespace, so hosted-flow links carry `/ns/<name>` when it is not the default. */
  publicNamespace?: string
  /** Called for every lifecycle event; the runtime signs and delivers it. */
  onWebhook?: (event: PersonaWebhook) => void
}

/** A JSON:API error document; `status` is a string, as Persona sends it. */
export const personaErrors = (status: number, title: string, detail: string) =>
  jsonRes(status, { errors: [{ title, detail, status: String(status) }] })

const OPEN: readonly InquiryStatus[] = ["created", "pending"]

const empty = { data: [] }

/** The inquiry resource exactly as Persona serializes it for API version 2023-01-05. */
export const inquiryResource = (inquiry: InquiryRecord) => ({
  type: "inquiry" as const,
  id: inquiry.id,
  attributes: {
    status: inquiry.status,
    "reference-id": inquiry.reference_id,
    note: inquiry.note,
    behaviors: null,
    tags: [] as string[],
    creator: "API",
    "reviewer-comment": null,
    "created-at": inquiry.created_at,
    "started-at": inquiry.started_at,
    "completed-at": inquiry.completed_at,
    "failed-at": inquiry.failed_at,
    "decisioned-at": inquiry.decisioned_at,
    "expired-at": inquiry.expired_at,
    "redacted-at": null,
    "previous-step-name": inquiry.completed_at ? "selfie" : "start",
    "next-step-name": inquiry.completed_at ? "success" : "start",
    "name-first": inquiry.fields["name-first"] ?? null,
    "name-middle": inquiry.fields["name-middle"] ?? null,
    "name-last": inquiry.fields["name-last"] ?? null,
    birthdate: inquiry.fields.birthdate ?? null,
    "email-address": inquiry.fields["email-address"] ?? null,
    "phone-number": inquiry.fields["phone-number"] ?? null,
    fields: Object.fromEntries(
      Object.entries(inquiry.fields).map(([key, value]) => [key, { type: "string", value }]),
    ),
  },
  relationships: {
    account: { data: null },
    template: { data: null },
    "inquiry-template": { data: { type: "inquiry-template", id: inquiry.template_id } },
    reports: empty,
    verifications: empty,
    sessions: empty,
    documents: empty,
    selfies: empty,
  },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  )

const html = (status: number, body: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Persona (mock)</title></head><body>${body}</body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  )

/**
 * Stateful mock of Persona's inquiry API (the surface our EMR calls).
 *
 * Inquiries start `created` and move through admin actions or the hosted flow page; every
 * step emits the Persona event our webhook receiver verifies.
 */
export class PersonaAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: PersonaState
  private readonly service: Service
  private readonly now: () => number
  private readonly publicNamespace: string
  private readonly onWebhook: ((event: PersonaWebhook) => void) | undefined

  constructor(options: PersonaAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? PERSONA_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.publicNamespace = options.publicNamespace ?? "default"
    this.onWebhook = options.onWebhook
    this.state = new PersonaState(sqlite, namespace, { settings: options.settings ?? {} })
    const handlers = defineOperations<SupportedOperationId>({
      CreateInquiry: (context) => this.createInquiry(context),
      ListInquiries: (context) => this.listInquiries(context),
      GetInquiry: (context) => this.getInquiry(context),
      HostedFlow: (context) => this.hostedFlow(context),
      HostedFlowComplete: (context) => this.hostedFlowComplete(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => personaErrors(404, "Not Found", "The requested resource was not found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const op = context.operation.operationId
        if (op === "HostedFlow" || op === "HostedFlowComplete") return undefined
        const token = bearerToken(context.request)
        const keys = this.state.current().apiKeys
        if (!token || (keys.length > 0 && !keys.includes(token))) {
          return personaErrors(
            401,
            "Must be authenticated to access this endpoint",
            "Provide a valid API key in the Authorization header as `Bearer <key>`",
          )
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
    this.state.ensureSeeded()
  }

  inquiries(): InquiryRecord[] {
    return this.state.inquiries.list({ order: "oldest" }).map((row) => row.value)
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private emit(name: PersonaEventName, inquiry: InquiryRecord) {
    this.onWebhook?.({
      data: {
        type: "event",
        id: this.state.nextEventId(),
        attributes: {
          name,
          payload: { data: inquiryResource(inquiry), included: [], meta: {} },
          "created-at": this.iso(),
        },
      },
    })
  }

  private knownTemplate(id: string): boolean {
    const templates = this.state.current().templates
    return templates.length > 0 ? templates.includes(id) : /^(itmpl|tmpl)_\S+$/.test(id)
  }

  private createInquiry(context: OperationContext): Response {
    const body = context.body.kind === "json" ? context.body.value : undefined
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined
    const attributes = data && isRecord(data.attributes) ? data.attributes : undefined
    if (!attributes) {
      return personaErrors(400, "Bad Request", "Request body must include data.attributes")
    }
    const template =
      typeof attributes["inquiry-template-id"] === "string"
        ? attributes["inquiry-template-id"]
        : typeof attributes["template-id"] === "string"
          ? attributes["template-id"]
          : undefined
    if (!template) {
      return personaErrors(
        400,
        "Bad Request",
        "Must provide either inquiry-template-id or template-id",
      )
    }
    if (!this.knownTemplate(template)) {
      return personaErrors(422, "Invalid inquiry template", `Could not find template ${template}`)
    }
    const text = (key: string) => (typeof attributes[key] === "string" ? attributes[key] : null)
    const fields: Record<string, string> = {}
    if (isRecord(attributes.fields)) {
      for (const [key, value] of Object.entries(attributes.fields)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          fields[key] = String(value)
        } else if (isRecord(value) && value.value !== undefined) fields[key] = String(value.value)
      }
    }
    const inquiry: InquiryRecord = {
      id: this.state.nextInquiryId(),
      status: "created",
      reference_id: text("reference-id"),
      template_id: template,
      redirect_uri: text("redirect-uri"),
      note: text("note"),
      platform: text("platform"),
      fields,
      created_at: this.iso(),
      started_at: null,
      completed_at: null,
      failed_at: null,
      decisioned_at: null,
      expired_at: null,
    }
    this.state.inquiries.insert(inquiry.id, inquiry)
    this.emit("inquiry.created", inquiry)
    return annotateResponse(jsonRes(201, { data: inquiryResource(inquiry), included: [] }), {
      ids: { inquiryId: inquiry.id },
    })
  }

  private listInquiries(context: OperationContext): Response {
    const params = context.url.searchParams
    const reference = params.get("filter[reference-id]")
    const template = params.get("filter[inquiry-template-id]")
    const statuses = params
      .get("filter[status]")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const sizeText = params.get("page[size]")
    const size = sizeText === null ? 10 : Number(sizeText)
    if (!Number.isInteger(size) || size < 1 || size > 100) {
      return personaErrors(400, "Bad Request", "page[size] must be between 1 and 100")
    }
    const rows = this.state.inquiries
      .list({ order: "newest" })
      .map((row) => row.value)
      .filter((i) => reference === null || i.reference_id === reference)
      .filter((i) => template === null || i.template_id === template)
      .filter((i) => !statuses || statuses.length === 0 || statuses.includes(i.status))
    const after = params.get("page[after]")
    const start = after === null ? 0 : rows.findIndex((i) => i.id === after) + 1
    const page = start === 0 && after !== null ? [] : rows.slice(start, start + size)
    const last = page.at(-1)
    const more = last !== undefined && rows.indexOf(last) < rows.length - 1
    const link = (cursor: string) => {
      const next = new URLSearchParams(params)
      next.set("page[after]", cursor)
      return `/inquiries?${next.toString()}`
    }
    return annotateResponse(
      jsonRes(200, {
        data: page.map(inquiryResource),
        links: { prev: null, next: more && last ? link(last.id) : null },
      }),
      { ids: page[0] ? { inquiryId: page[0].id } : {} },
    )
  }

  private getInquiry(context: OperationContext): Response {
    if (faultEffect(context.request, "not_found") !== undefined) {
      return personaErrors(404, "Record not found", "Could not find the requested inquiry")
    }
    const inquiry = this.state.inquiries.get(context.params.inquiryId ?? "")
    if (!inquiry) {
      return personaErrors(404, "Record not found", "Could not find the requested inquiry")
    }
    return annotateResponse(jsonRes(200, { data: inquiryResource(inquiry), included: [] }), {
      ids: { inquiryId: inquiry.id },
    })
  }

  /**
   * Move an inquiry the way Persona would, emitting one event per step. Decisions
   * (`approve`, `decline`, `needs_review`) on an open inquiry pass through `completed` first,
   * as a member finishing the flow and a workflow deciding would. Returns an error string when
   * the move is not allowed.
   */
  transition(id: string, action: InquiryAction): InquiryRecord | string {
    let inquiry = this.state.inquiries.get(id)
    if (!inquiry) return `no inquiry ${id}`
    const save = (patch: Partial<InquiryRecord>, event: PersonaEventName) => {
      inquiry = { ...(inquiry as InquiryRecord), ...patch }
      this.state.inquiries.update(inquiry.id, inquiry)
      this.emit(event, inquiry)
    }
    const at = this.iso()
    const open = OPEN.includes(inquiry.status)
    const finish = () => {
      if (inquiry?.status === "created")
        save({ status: "pending", started_at: at }, "inquiry.started")
      save({ status: "completed", completed_at: at }, "inquiry.completed")
    }
    const decidable = ["completed", "needs_review"]
    switch (action) {
      case "start":
        if (inquiry.status !== "created")
          return `cannot start an inquiry in status ${inquiry.status}`
        save({ status: "pending", started_at: at }, "inquiry.started")
        break
      case "complete":
        if (!open) return `cannot complete an inquiry in status ${inquiry.status}`
        finish()
        break
      case "fail":
        if (!open) return `cannot fail an inquiry in status ${inquiry.status}`
        if (inquiry.status === "created")
          save({ status: "pending", started_at: at }, "inquiry.started")
        save({ status: "failed", failed_at: at }, "inquiry.failed")
        break
      case "expire":
        if (!open) return `cannot expire an inquiry in status ${inquiry.status}`
        save({ status: "expired", expired_at: at }, "inquiry.expired")
        break
      case "approve":
      case "decline":
      case "needs_review": {
        if (open) finish()
        else if (!decidable.includes(inquiry.status)) {
          return `cannot ${action} an inquiry in status ${inquiry.status}`
        }
        if (action === "approve")
          save({ status: "approved", decisioned_at: at }, "inquiry.approved")
        else if (action === "decline") {
          save({ status: "declined", decisioned_at: at }, "inquiry.declined")
        } else if (inquiry.status !== "needs_review") {
          save({ status: "needs_review" }, "inquiry.marked-for-review")
        }
        break
      }
    }
    return inquiry
  }

  private hostedFlow(context: OperationContext): Response {
    const id = context.url.searchParams.get("inquiry-id") ?? ""
    const inquiry = this.state.inquiries.get(id)
    if (!inquiry) return html(404, "<h1>Inquiry not found</h1>")
    if (inquiry.status === "created") this.transition(id, "start")
    const redirect = context.url.searchParams.get("redirect-uri") ?? inquiry.redirect_uri ?? ""
    const link = (outcome: InquiryAction, label: string) => {
      const query = new URLSearchParams({ "inquiry-id": id, outcome })
      if (redirect) query.set("redirect-uri", redirect)
      // Relative to `…/verify`, so an `/ns/<name>` prefix survives.
      return `<li><a data-outcome="${outcome}" href="verify/complete?${escapeHtml(query.toString())}">${label}</a></li>`
    }
    const prefix =
      this.publicNamespace === "default" ? "" : ` (namespace ${escapeHtml(this.publicNamespace)})`
    return annotateResponse(
      html(
        200,
        `<h1>Verify your identity</h1><p>Mock Persona hosted flow for <code>${escapeHtml(id)}</code>${prefix}.</p><ul>${[
          link("approve", "Approve"),
          link("decline", "Decline"),
          link("needs_review", "Send to review"),
          link("complete", "Complete (no decision)"),
          link("fail", "Fail"),
        ].join("")}</ul>`,
      ),
      { ids: { inquiryId: id } },
    )
  }

  private hostedFlowComplete(context: OperationContext): Response {
    const params = context.url.searchParams
    const id = params.get("inquiry-id") ?? ""
    const outcome = params.get("outcome") as InquiryAction
    if (!this.state.inquiries.get(id)) return html(404, "<h1>Inquiry not found</h1>")
    if (!["approve", "decline", "needs_review", "complete", "fail"].includes(outcome)) {
      return html(409, "<h1>Unknown outcome</h1>")
    }
    const moved = this.transition(id, outcome)
    if (typeof moved === "string") return html(409, `<h1>${escapeHtml(moved)}</h1>`)
    const redirect = params.get("redirect-uri") ?? moved.redirect_uri
    if (!redirect) return html(200, `<h1>Done: ${moved.status}</h1>`)
    let target: URL
    try {
      target = new URL(redirect)
    } catch {
      return html(200, `<h1>Done: ${moved.status}</h1>`)
    }
    target.searchParams.set("inquiry-id", moved.id)
    target.searchParams.set("status", moved.status)
    if (moved.reference_id) target.searchParams.set("reference-id", moved.reference_id)
    return annotateResponse(
      new Response(null, { status: 302, headers: { location: target.toString() } }),
      { ids: { inquiryId: moved.id } },
    )
  }
}

export type { PersonaRuntime, PersonaRuntimeOptions } from "./runtime.js"
export { createRuntime, PERSONA_PRESETS, PERSONA_SIGNATURE_HEADER } from "./runtime.js"
