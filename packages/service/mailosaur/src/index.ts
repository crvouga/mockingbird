import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import {
  addressKey,
  htmlContent,
  parseAddress,
  parseAddresses,
  textContent,
  visibleText,
} from "./content.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type InboxRecord, MailosaurState, type Message, type Settings } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { Code, Image, Link, MessageAddress, MessageContent } from "./content.js"
export { findCodes, htmlContent, parseAddresses, textContent } from "./content.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { InboxRecord, Message, Settings } from "./state.js"
export { DEFAULT_SETTINGS } from "./state.js"

export const MAILOSAUR_NAMESPACE = "mailosaur"

/** The server a message lands in when neither `server` nor a `<id>.mailosaur.net` recipient names one. */
export const ANY_SERVER = "*"

/** Default `timeout` of the server-side `await` long-poll, and its ceiling. */
export const DEFAULT_AWAIT_TIMEOUT_MS = 10_000
export const MAX_AWAIT_TIMEOUT_MS = 300_000

/** What `POST /__admin/ingest` (and the other mocks' `--forward-to-inbox`) drops into the inbox. */
export type IngestInput = {
  /** The 8-character server id; default: from a `<server>.mailosaur.net` recipient, else any. */
  server?: string
  type?: "Email" | "SMS"
  from?: unknown
  to: unknown
  cc?: unknown
  bcc?: unknown
  subject?: string | null
  html?: string | null
  text?: string | null
  /** `{name: value}`, `[{name, value}]` or `[{field, value}]`. */
  headers?: unknown
  attachments?: {
    filename?: string
    fileName?: string
    /** Base64 bytes. */
    content?: string
    contentType?: string
    content_type?: string
    contentId?: string
  }[]
}

export type MailosaurAPIOptions = APIOptions & {
  /** Initial per-namespace settings (poll delays). */
  settings?: Partial<Settings>
}

/** Search criteria, as the SDK's `SearchCriteria` model posts them. */
export type SearchCriteria = {
  sentFrom?: string
  sentTo?: string
  subject?: string
  body?: string
  match?: "ALL" | "ANY"
}

type Waiter = {
  server: string
  criteria: SearchCriteria
  receivedAfter: number | undefined
  resolve: (record: InboxRecord | undefined) => void
}

const SERVER_DOMAIN = /^([a-z0-9]{8})\.mailosaur\.(?:net|io)$/i

const errorBody = (type: string, message: string) => ({ type, message })

/** Mailosaur's 400: the SDK reads `errors[].field` and `errors[].detail[0].description`. */
const invalid = (field: string, description: string) =>
  jsonRes(400, { type: "ValidationError", errors: [{ field, detail: [{ description }] }] })

const lower = (value: string | undefined) => value?.trim().toLowerCase() ?? ""

/** Whether a message matches search criteria (sentTo/sentFrom exact, subject/body contains). */
export const matchesCriteria = (message: Message, criteria: SearchCriteria): boolean => {
  const checks: boolean[] = []
  if (criteria.sentTo) {
    const want = lower(criteria.sentTo)
    checks.push(
      [...message.to, ...message.cc, ...message.bcc].some(
        (address) => addressKey(address) === want,
      ),
    )
  }
  if (criteria.sentFrom) {
    const want = lower(criteria.sentFrom)
    checks.push(message.from.some((address) => addressKey(address) === want))
  }
  if (criteria.subject) checks.push(lower(message.subject).includes(lower(criteria.subject)))
  if (criteria.body) {
    const want = lower(criteria.body)
    checks.push(
      lower(message.text.body ?? "").includes(want) ||
        lower(visibleText(message.html.body ?? "")).includes(want),
    )
  }
  if (checks.length === 0) return true
  return criteria.match === "ANY" ? checks.some(Boolean) : checks.every(Boolean)
}

const summaryOf = (message: Message) => {
  const text = message.text.body ?? visibleText(message.html.body ?? "")
  return {
    id: message.id,
    type: message.type,
    server: message.server,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    received: message.received,
    subject: message.subject,
    summary: text.replace(/\s+/g, " ").trim().slice(0, 100),
    attachments: message.attachments.length,
  }
}

const headerList = (value: unknown): { field: string; value: string }[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return []
      const record = entry as Record<string, unknown>
      const field = record.field ?? record.name
      return typeof field === "string" ? [{ field, value: String(record.value ?? "") }] : []
    })
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).map(([field, v]) => ({
      field,
      value: String(v),
    }))
  }
  return []
}

const criteriaFrom = (value: unknown): SearchCriteria => {
  if (typeof value !== "object" || value === null) return {}
  const record = value as Record<string, unknown>
  const text = (key: string) =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? { [key]: record[key] as string }
      : {}
  return {
    ...text("sentFrom"),
    ...text("sentTo"),
    ...text("subject"),
    ...text("body"),
    ...(record.match === "ANY" || record.match === "ALL" ? { match: record.match } : {}),
  }
}

/**
 * Stateful mock of the Mailosaur API: servers (inboxes) are implicit, keyed by the 8-character
 * id every call names; messages arrive through `POST /__admin/ingest` (or another mock's
 * `--forward-to-inbox`) and `POST /api/messages`, and are parsed the way Mailosaur parses them
 * (`html.links`, `html.codes`, `text.codes`, …).
 */
export class MailosaurAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: MailosaurState
  private readonly service: Service
  private readonly now: () => number
  private readonly waiters = new Set<Waiter>()

  constructor(options: MailosaurAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? MAILOSAUR_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new MailosaurState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      SearchMessages: (context) => this.search(context),
      AwaitMessage: (context) => this.await(context, criteriaFrom(this.jsonBody(context))),
      AwaitMessageByQuery: (context) => this.await(context, criteriaFrom(context.query)),
      ListMessages: (context) => this.list(context),
      CreateMessage: (context) => this.create(context),
      DeleteAllMessages: (context) => this.deleteAll(context),
      GetMessage: (context) => this.get(context),
      DeleteMessage: (context) => this.remove(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, errorBody("invalid_request", "Not found")),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const key = basicAuth(context.request)?.username
        if (!key) {
          return jsonRes(
            401,
            errorBody("authentication_error", "Authentication failed, check your API key."),
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
    for (const waiter of this.waiters) waiter.resolve(undefined)
    this.waiters.clear()
  }

  /** Store a message and wake every long-poll it satisfies. */
  ingest(input: IngestInput): Message {
    const type = input.type === "SMS" ? "SMS" : "Email"
    const to = parseAddresses(input.to)
    const cc = parseAddresses(input.cc)
    const bcc = parseAddresses(input.bcc)
    if (to.length + cc.length + bcc.length === 0) throw new RangeError("to: at least one recipient")
    const from = parseAddresses(input.from)
    const derived = [...to, ...cc, ...bcc]
      .map((a) => SERVER_DOMAIN.exec(a.email?.split("@")[1] ?? "")?.[1]?.toLowerCase())
      .find((s) => s !== undefined)
    const server = input.server ?? derived ?? ANY_SERVER
    const id = this.state.nextId()
    const receivedMs = this.now()
    const attachments = (input.attachments ?? []).map((attachment, index) => {
      const bytes = attachment.content ? fromBase64(attachment.content) : new Uint8Array()
      const attachmentId = `${id.slice(0, 24)}${String(index).padStart(12, "0")}`
      return {
        id: attachmentId,
        contentType:
          attachment.contentType ?? attachment.content_type ?? "application/octet-stream",
        fileName: attachment.filename ?? attachment.fileName ?? `attachment-${index + 1}`,
        contentId: attachment.contentId ?? null,
        length: bytes.length,
        url: `https://mailosaur.com/api/files/attachments/${attachmentId}`,
      }
    })
    const message: Message = {
      id,
      type,
      from,
      to,
      cc,
      bcc,
      received: new Date(receivedMs).toISOString(),
      subject: input.subject ?? "",
      html: htmlContent(input.html),
      text: textContent(input.text),
      attachments,
      metadata: {
        headers: headerList(input.headers),
        ehlo: null,
        mailFrom: from[0]?.email ?? null,
        rcptTo: [...to, ...cc, ...bcc],
      },
      server,
    }
    const record: InboxRecord = {
      id,
      to: [...to, ...cc, ...bcc].map(addressKey),
      createdAt: message.received,
      receivedMs,
      server,
      message,
    }
    this.state.outbox.record(record)
    for (const waiter of [...this.waiters]) {
      if (this.visible(record, waiter.server, waiter.receivedAfter, waiter.criteria)) {
        this.waiters.delete(waiter)
        waiter.resolve(record)
      }
    }
    return message
  }

  /** Every stored message, newest first. */
  messages(): Message[] {
    return this.state.messages.list().map((row) => row.value.message)
  }

  private jsonBody(context: OperationContext): unknown {
    return context.body.kind === "json" ? context.body.value : undefined
  }

  private visible(
    record: InboxRecord,
    server: string,
    receivedAfter: number | undefined,
    criteria: SearchCriteria,
  ): boolean {
    if (record.server !== server && record.server !== ANY_SERVER) return false
    if (receivedAfter !== undefined && record.receivedMs < receivedAfter) return false
    return matchesCriteria(record.message, criteria)
  }

  /** `server` (required) and `receivedAfter` from the query, or a 400 response. */
  private scope(
    context: OperationContext,
  ): { server: string; after: number | undefined } | Response {
    const server = context.url.searchParams.get("server")
    if (!server) return invalid("server", "The server field is required.")
    const raw = context.url.searchParams.get("receivedAfter")
    if (raw === null || raw === "") return { server, after: undefined }
    const after = Date.parse(raw)
    if (Number.isNaN(after)) return invalid("receivedAfter", "The value is not a valid date.")
    return { server, after }
  }

  private page(context: OperationContext, records: InboxRecord[]): InboxRecord[] {
    const number = (name: string, fallback: number) => {
      const raw = context.url.searchParams.get(name)
      const value = raw === null ? Number.NaN : Number(raw)
      return Number.isInteger(value) && value >= 0 ? value : fallback
    }
    const size = Math.max(1, Math.min(1000, number("itemsPerPage", 50)))
    const page = number("page", 0)
    const ordered =
      context.url.searchParams.get("dir") === "Ascending" ? [...records].reverse() : records
    return ordered.slice(page * size, page * size + size)
  }

  private matching(server: string, after: number | undefined, criteria: SearchCriteria) {
    return this.state.messages
      .list({ where: (record) => this.visible(record, server, after, criteria) })
      .map((row) => row.value)
  }

  private search(context: OperationContext): Response {
    const scope = this.scope(context)
    if (scope instanceof Response) return scope
    if (bodyIssues(context).length > 0) {
      return invalid("criteria", "The search criteria are invalid.")
    }
    const criteria = criteriaFrom(this.jsonBody(context))
    const found =
      faultEffect(context.request, "search_never_matches") !== undefined
        ? []
        : this.matching(scope.server, scope.after, criteria)
    const items = this.page(context, found).map((record) => summaryOf(record.message))
    const response = jsonRes(200, { items })
    response.headers.set("x-ms-delay", this.state.current().pollDelaysMs.join(","))
    return annotateResponse(response, {
      ids: items[0] ? { messageId: items[0].id } : {},
    })
  }

  private async await(context: OperationContext, criteria: SearchCriteria): Promise<Response> {
    const scope = this.scope(context)
    if (scope instanceof Response) return scope
    const rawTimeout = context.url.searchParams.get("timeout")
    const timeout = rawTimeout === null ? DEFAULT_AWAIT_TIMEOUT_MS : Number(rawTimeout)
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > MAX_AWAIT_TIMEOUT_MS) {
      return invalid("timeout", `The timeout must be between 0 and ${MAX_AWAIT_TIMEOUT_MS} ms.`)
    }
    const found = this.matching(scope.server, scope.after, criteria)
    const hit =
      found[0] ??
      (await new Promise<InboxRecord | undefined>((resolve) => {
        const waiter: Waiter = {
          server: scope.server,
          criteria,
          receivedAfter: scope.after,
          resolve: (record) => {
            clearTimeout(timer)
            context.request.signal.removeEventListener("abort", abort)
            resolve(record)
          },
        }
        const abort = () => {
          this.waiters.delete(waiter)
          waiter.resolve(undefined)
        }
        const timer = setTimeout(abort, timeout)
        context.request.signal.addEventListener("abort", abort)
        this.waiters.add(waiter)
      }))
    if (!hit) {
      return jsonRes(
        404,
        errorBody(
          "search_timeout",
          `No matching messages found in time. The search criteria used for this query was [${JSON.stringify(criteria)}] which timed out after ${timeout}ms`,
        ),
      )
    }
    return annotateResponse(jsonRes(200, hit.message), { ids: { messageId: hit.id } })
  }

  private list(context: OperationContext): Response {
    const scope = this.scope(context)
    if (scope instanceof Response) return scope
    const items = this.page(context, this.matching(scope.server, scope.after, {})).map((record) =>
      summaryOf(record.message),
    )
    return jsonRes(200, { items })
  }

  private create(context: OperationContext): Response {
    const server = context.url.searchParams.get("server")
    if (!server) return invalid("server", "The server field is required.")
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      const first = issues[0] as { path: string; message: string }
      const field = /^missing required property (.+)$/.exec(first.message)?.[1] ?? first.path
      return invalid(field || "body", `The ${field || "request"} field is invalid.`)
    }
    const body = this.jsonBody(context) as Record<string, unknown>
    const message = this.ingest({
      server,
      from: parseAddress(body.from) ?? { name: "", email: `mock@${server}.mailosaur.net` },
      to: body.to,
      cc: body.cc,
      subject: String(body.subject ?? ""),
      html: typeof body.html === "string" ? body.html : null,
      text: typeof body.text === "string" ? body.text : null,
    })
    return annotateResponse(jsonRes(200, message), { ids: { messageId: message.id } })
  }

  private deleteAll(context: OperationContext): Response {
    const server = context.url.searchParams.get("server")
    if (!server) return invalid("server", "The server field is required.")
    for (const row of this.state.messages.list()) {
      if (row.value.server === server || row.value.server === ANY_SERVER) {
        this.state.messages.delete(row.id)
      }
    }
    return new Response(null, { status: 204 })
  }

  private get(context: OperationContext): Response {
    const record = this.state.messages.get(context.params.id ?? "")
    if (!record)
      return jsonRes(404, errorBody("invalid_request", "Not found, check input parameters."))
    return annotateResponse(jsonRes(200, record.message), { ids: { messageId: record.id } })
  }

  private remove(context: OperationContext): Response {
    const id = context.params.id ?? ""
    if (!this.state.messages.delete(id)) {
      return jsonRes(404, errorBody("invalid_request", "Not found, check input parameters."))
    }
    return annotateResponse(new Response(null, { status: 204 }), { ids: { messageId: id } })
  }
}

export type { MailosaurRuntime, MailosaurRuntimeOptions } from "./runtime.js"
export { createRuntime, MAILOSAUR_PRESETS } from "./runtime.js"
