import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  ProviderExpansion,
  type ProviderOptions,
  type ResendSeedConfig,
  resendPlugin,
  seedResend,
  selectOperations,
} from "@crvouga/mockingbird-http-provider"
import {
  type APIOptions,
  annotateResponse,
  type BodyIssue,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  jsonRes,
  type OperationContext,
  requestFingerprint,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { Hono } from "hono"
import { syncFromExpanded, syncToExpanded } from "./expanded-state.js"
import { document } from "./generated/openapi.js"
import { type NativeOperationId, nativeOperationIds } from "./native-operations.js"
import {
  type ReceivedAttachmentRecord,
  type ReceivedEmail,
  ResendState,
  type SentEmail,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { ReceivedAttachmentRecord, ReceivedEmail, SentEmail } from "./state.js"

export const RESEND_NAMESPACE = "resend"

/** How long a received attachment's `download_url` is advertised to live. */
export const DOWNLOAD_URL_TTL_MS = 3_600_000

/** The `email.received` webhook body (what our `POST /messaging/inbound/email` parses). */
export type EmailReceivedEvent = {
  type: "email.received"
  created_at: string
  data: {
    email_id: string
    created_at: string
    from: string
    to: string[]
    cc: string[]
    bcc: string[]
    subject: string | null
    message_id: string
    attachments: {
      id: string
      filename: string
      content_type: string
      content_disposition: string | null
      content_id: string | null
      size?: number
      download_url?: string
    }[]
    text?: string | null
    html?: string | null
    headers?: { name: string; value: string }[]
  }
}

/** What `POST /__admin/inbound` accepts: an email arriving at one of the app's addresses. */
export type InboundInput = {
  from: string
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  replyTo?: string | string[]
  subject?: string | null
  text?: string | null
  html?: string | null
  headers?: Record<string, string>
  messageId?: string
  attachments?: {
    filename: string
    /** Base64 bytes. */
    content: string
    contentType?: string
    contentDisposition?: string | null
    contentId?: string | null
  }[]
  /**
   * Put `text`, `html`, `headers` and each attachment's `size` / `download_url` in the webhook
   * body. Default `false`, as Resend does: the receiver then hydrates them through
   * `GET /emails/receiving/{id}` and `…/attachments`.
   */
  inline?: boolean
}

export type SendOutcome = "accepted" | "lost" | "replayed"

export type SendOutcomeEvent = {
  outcome: SendOutcome
  /** Public namespace the request selected. */
  namespace: string
  emailId?: string
}

export type ResendAPIOptions = APIOptions &
  Pick<ProviderOptions, "tokens" | "baseUrl" | "publicNamespace" | "adminPrefix" | "random"> & {
    fixtures?: ResendSeedConfig
    /** The public namespace name, for `/__admin/ns/<name>` download URLs. Default: the default namespace. */
    adminPrefix?: string
    publicNamespace?: string
    /** Called after every accepted send (not replays); awaited before the response. */
    onSent?: (email: SentEmail) => Promise<void> | void
    /** Accepted-then-drop and idempotent replays. The response has already been decided. */
    onOutcome?: (event: SendOutcomeEvent) => void
  }

const error = (statusCode: number, name: string, message: string) =>
  jsonRes(statusCode, { statusCode, name, message })

const notFound = (what = "Email") => error(404, "not_found", `${what} not found`)

const ADDRESS_FIELDS = new Set(["from", "to", "cc", "bcc", "reply_to"])

/** A contract violation in Resend's words: `missing_required_field` or `validation_error`. */
const validationResponse = (issue: BodyIssue): Response => {
  const missing = /^missing required property (.+)$/.exec(issue.message)
  if (missing && issue.path === "") {
    return error(422, "missing_required_field", `Missing \`${missing[1]}\` field.`)
  }
  const field = issue.path.split(".")[0] || "body"
  if (ADDRESS_FIELDS.has(field)) {
    return error(
      422,
      "validation_error",
      `Invalid \`${field}\` field. The email address needs to follow the \`email@example.com\` or \`Name <email@example.com>\` format.`,
    )
  }
  if (field === "tags") {
    return error(
      422,
      "validation_error",
      "Invalid `tags` field. Tag names and values must only contain ASCII letters (a–z, A–Z), numbers (0–9), underscores (_), or dashes (-), and can be at most 256 characters.",
    )
  }
  return error(422, "validation_error", `Invalid \`${field}\` field.`)
}

const list = (value: unknown): string[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value.map(String)
      : [String(value)]

/** Header names and values as sent. Keys are not case-folded. */
const stringRecord = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const headers: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") headers[key] = entry
  }
  return headers
}

/** Tags in request order, including repeated name/value pairs. */
const tagsOf = (value: unknown): { name: string; value: string }[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item !== "object" || item === null) return []
        const name = (item as { name?: unknown }).name
        const tagValue = (item as { value?: unknown }).value
        return typeof name === "string" && typeof tagValue === "string"
          ? [{ name, value: tagValue }]
          : []
      })
    : []

/** `Ada <ada@x.co>` → `ada@x.co` (lower-cased), as the outbox's `?to=` compares. */
export const bareAddress = (value: string): string =>
  (/<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim().toLowerCase()

/** Attachment bytes from base64 or a JSON-serialised Node `Buffer` (`{type: "Buffer", data}`). */
const attachmentBytes = (content: unknown): Uint8Array => {
  if (typeof content === "string") {
    try {
      return fromBase64(content)
    } catch {
      return new TextEncoder().encode(content)
    }
  }
  if (typeof content === "object" && content !== null) {
    const data = (content as { data?: unknown }).data ?? content
    if (Array.isArray(data)) return Uint8Array.from(data.map(Number))
  }
  return new Uint8Array()
}

/**
 * Stateful mock of the Resend email API: sends land in an outbox (read with
 * `GET /__admin/outbox`), `Idempotency-Key` replays return the first send's id, and inbound
 * emails (`POST /__admin/inbound`) are served by the received-email endpoints.
 */
export class ResendAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: ResendState
  private tail: Promise<unknown> = Promise.resolve()
  private readonly expansion: ProviderExpansion
  private readonly service: Service
  private readonly now: () => number
  private readonly adminPrefix: string
  private readonly publicNamespace: string | undefined
  private readonly onSent: ResendAPIOptions["onSent"]
  private readonly onOutcome: ResendAPIOptions["onOutcome"]
  /** Counts for the ambiguous-send path. Cleared with `reset`. */
  private readonly outcomeCounts: Record<SendOutcome, number> = {
    accepted: 0,
    lost: 0,
    replayed: 0,
  }

  constructor(options: ResendAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? RESEND_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.adminPrefix = options.adminPrefix ?? "/__admin"
    this.publicNamespace = options.publicNamespace
    this.onSent = options.onSent
    this.onOutcome = options.onOutcome
    this.state = new ResendState(sqlite, namespace)
    const handlers = defineOperations<NativeOperationId>({
      ListEmails: (context) => this.listEmails(context),
      ListReceivedEmails: (context) => this.listReceivedEmails(context),
      SendEmail: (context) => this.send(context),
      GetEmail: (context) => this.getEmail(context),
      GetReceivedEmail: (context) => this.getReceived(context),
      ListReceivedEmailAttachments: (context) => this.listAttachments(context),
      DownloadReceivedAttachment: (context) => this.download(context),
    })
    this.service = createService({
      document: selectOperations(document, nativeOperationIds),
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => error(404, "not_found", "The requested endpoint does not exist."),
      onError: (thrown) => {
        if (thrown instanceof HttpError) return thrown.toResponse()
        throw thrown
      },
      before: (context) => {
        if (context.operation.operationId === "DownloadReceivedAttachment") return undefined
        if (!bearerToken(context.request)) {
          return error(
            401,
            "missing_api_key",
            "Missing API key in the authorization header. Include the following header 'Authorization: Bearer YOUR_API_KEY' in the request.",
          )
        }
        return undefined
      },
    })
    this.app = new Hono().all("*", (c) => this.fetch(c.req.raw))
    this.sqlite = this.service.sqlite
    this.expansion = new ProviderExpansion(
      resendPlugin,
      selectOperations(document, nativeOperationIds),
      {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
        ...(options.random ? { random: options.random } : {}),
        ...(options.publicNamespace !== undefined
          ? { publicNamespace: options.publicNamespace }
          : {}),
        ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
        sqlite,
        namespace,
        now: this.now,
      },
    )
    if (options.fixtures) {
      this.expansion.configureFixtures(options.fixtures, seedResend)
      syncFromExpanded(this.state, this.expansion)
    }
  }

  fetch(request: Request): Promise<Response> {
    if (!this.expansion.handles(request)) return this.handleFetch(request)
    const result = this.tail.then(
      () => this.handleFetch(request),
      () => this.handleFetch(request),
    )
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  private async handleFetch(request: Request): Promise<Response> {
    if (this.expansion.handles(request)) {
      syncToExpanded(this.state, this.expansion)
      const sent = new Set(this.state.outbox.list().map((email) => email.id))
      const response = await this.expansion.fetch(request)
      syncFromExpanded(this.state, this.expansion)
      if (response.ok && new URL(request.url).pathname === "/emails/batch" && this.onSent) {
        const body = (await response.clone().json()) as { data?: { id: string }[] }
        for (const item of body.data ?? []) {
          const email = this.state.outbox.get(item.id)
          if (email && !sent.has(item.id)) await this.onSent(email)
        }
      }
      return response
    }
    const response = await this.service.fetch(request)
    if (response.headers.get("idempotent-replayed") === "true") {
      await this.recordOutcome("replayed", response)
      return response
    }
    const path = new URL(request.url).pathname
    if (
      request.method === "POST" &&
      path === "/emails" &&
      response.status === 200 &&
      faultEffect(request, "accepted_then_network_drop") !== undefined
    ) {
      // The email and its idempotency record are already stored. Drop before any bytes leave.
      await this.recordOutcome("accepted", response)
      await this.recordOutcome("lost", response)
      throw new DroppedConnectionError()
    }
    return response
  }

  async reset(): Promise<void> {
    await this.tail
    this.outcomeCounts.accepted = 0
    this.outcomeCounts.lost = 0
    this.outcomeCounts.replayed = 0
    await this.service.reset()
    await this.expansion.reset()
    syncFromExpanded(this.state, this.expansion)
  }

  /** Accepted sends whose response was lost, those lost responses, and idempotent replays. */
  sendOutcomes(): Record<SendOutcome, number> {
    return { ...this.outcomeCounts }
  }

  /** Every sent email, oldest first. */
  sent(): SentEmail[] {
    return this.state.outbox.list()
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString()
  }

  private async recordOutcome(outcome: SendOutcome, response: Response): Promise<void> {
    this.outcomeCounts[outcome] += 1
    let emailId: string | undefined
    try {
      const body = (await response.clone().json()) as { id?: unknown }
      if (typeof body.id === "string") emailId = body.id
    } catch {
      emailId = undefined
    }
    this.onOutcome?.({
      outcome,
      namespace: this.publicNamespace ?? "default",
      ...(emailId !== undefined ? { emailId } : {}),
    })
  }

  private send(context: OperationContext): Promise<Response> | Response {
    const key = context.request.headers.get("idempotency-key")
    if (key !== null && (key.length < 1 || key.length > 256)) {
      return error(
        400,
        "invalid_idempotency_key",
        "Idempotency key must be between 1-256 characters.",
      )
    }
    if (
      context.body.kind !== "json" ||
      typeof context.body.value !== "object" ||
      context.body.value === null ||
      Array.isArray(context.body.value)
    ) {
      return error(422, "validation_error", "The request body must be a JSON object.")
    }
    const body = context.body.value as Record<string, unknown>
    if (key === null) return this.create(context, body, null)
    return this.state.idempotency.run(
      key,
      requestFingerprint("POST", "/emails", body),
      {
        mismatch: () =>
          error(
            409,
            "invalid_idempotent_request",
            "Same idempotency key used with a different request payload.",
          ),
        conflict: () =>
          error(
            409,
            "concurrent_idempotent_requests",
            "Same idempotency key used while original request is still in progress.",
          ),
      },
      () => this.create(context, body, key),
      (status) => status === 200,
    )
  }

  private async create(
    context: OperationContext,
    body: Record<string, unknown>,
    idempotencyKey: string | null,
  ): Promise<Response> {
    const [issue] = bodyIssues(context)
    if (issue) return validationResponse(issue)
    const html = typeof body.html === "string" ? body.html : null
    const text = typeof body.text === "string" ? body.text : null
    if (html === null && text === null) {
      return error(422, "missing_required_field", "Missing `html` or `text` field.")
    }
    const toHeader = list(body.to)
    const email: SentEmail = {
      id: this.state.nextId("email"),
      from: String(body.from),
      to: toHeader.map(bareAddress),
      toHeader,
      cc: list(body.cc).map(bareAddress),
      bcc: list(body.bcc).map(bareAddress),
      replyTo: list(body.reply_to),
      subject: String(body.subject),
      html,
      text,
      tags: tagsOf(body.tags),
      headers: stringRecord(body.headers),
      attachments: (Array.isArray(body.attachments) ? body.attachments : []).map((raw) => {
        const attachment = raw as Record<string, unknown>
        return {
          filename: String(attachment.filename ?? "attachment"),
          contentType: typeof attachment.content_type === "string" ? attachment.content_type : null,
          size: attachmentBytes(attachment.content).length,
        }
      }),
      idempotencyKey,
      scheduledAt: typeof body.scheduled_at === "string" ? body.scheduled_at : null,
      createdAt: this.iso(),
    }
    this.state.outbox.record(email)
    await this.onSent?.(email)
    return annotateResponse(jsonRes(200, { id: email.id }), { ids: { emailId: email.id } })
  }

  private getEmail(context: OperationContext): Response {
    const email = this.state.outbox.get(context.params.email_id ?? "")
    if (!email) return notFound()
    return annotateResponse(
      jsonRes(200, {
        object: "email",
        id: email.id,
        to: email.toHeader,
        from: email.from,
        created_at: email.createdAt,
        subject: email.subject,
        html: email.html,
        text: email.text,
        bcc: email.bcc.length > 0 ? email.bcc : null,
        cc: email.cc.length > 0 ? email.cc : null,
        reply_to: email.replyTo.length > 0 ? email.replyTo : null,
        last_event: email.lastEvent ?? (email.scheduledAt ? "scheduled" : "delivered"),
        scheduled_at: email.scheduledAt,
        headers: email.headers,
        tags: email.tags,
      }),
      { ids: { emailId: email.id } },
    )
  }

  private emailPage<T extends { id: string }>(
    context: OperationContext,
    records: T[],
    defaultLimit: number,
  ) {
    const query = context.url.searchParams
    const rawLimit = query.get("limit")
    const limit = rawLimit === null ? Math.max(1, defaultLimit) : Number(rawLimit)
    const reject = (message: string): never => {
      throw new HttpError(422, { statusCode: 422, name: "validation_error", message })
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || (rawLimit !== null && limit > 100)) {
      reject("The pagination limit must be a number between 1 and 100.")
    }
    const after = query.get("after")
    const before = query.get("before")
    if (after !== null && before !== null) reject("Provide either before or after, not both.")
    let selected = records
    const cursor = after ?? before
    if (cursor !== null) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor)) {
        reject("Invalid pagination cursor format.")
      }
      const index = records.findIndex((email) => email.id === cursor)
      selected =
        index < 0 ? [] : after !== null ? records.slice(index + 1) : records.slice(0, index)
    }
    return {
      object: "list",
      has_more: selected.length > limit,
      data: before === null ? selected.slice(0, limit) : selected.slice(-limit),
    }
  }

  private listEmails(context: OperationContext): Response {
    const records = this.state.outbox
      .list()
      .reverse()
      .map((email) => ({
        id: email.id,
        message_id: `<${email.id}@mock.resend.test>`,
        to: email.toHeader,
        from: email.from,
        created_at: email.createdAt,
        subject: email.subject,
        bcc: email.bcc.length > 0 ? email.bcc : null,
        cc: email.cc.length > 0 ? email.cc : null,
        reply_to: email.replyTo.length > 0 ? email.replyTo : null,
        last_event: email.lastEvent ?? (email.scheduledAt ? "scheduled" : "delivered"),
        scheduled_at: email.scheduledAt,
      }))
    return jsonRes(200, this.emailPage(context, records, 20))
  }

  private listReceivedEmails(context: OperationContext): Response {
    const records = this.state.received.list({ order: "newest" }).map(({ value: email }) => ({
      id: email.id,
      to: email.to,
      from: email.from,
      created_at: email.createdAt,
      subject: email.subject,
      bcc: email.bcc,
      cc: email.cc,
      reply_to: email.replyTo,
      message_id: email.messageId,
      attachments: email.attachments.map((attachment) => ({
        ...this.attachmentMeta(attachment),
        size: attachment.size,
      })),
    }))
    return jsonRes(200, this.emailPage(context, records, records.length))
  }

  /** Store an inbound email and build the `email.received` event for it. */
  receive(
    input: InboundInput,
    origin: string,
  ): { email: ReceivedEmail; event: EmailReceivedEvent } {
    const id = this.state.nextId("received")
    const attachments: ReceivedAttachmentRecord[] = (input.attachments ?? []).map((attachment) => {
      const bytes = attachmentBytes(attachment.content)
      return {
        id: this.state.nextId("attachment"),
        filename: attachment.filename,
        content_type: attachment.contentType ?? "application/octet-stream",
        content_disposition: attachment.contentDisposition ?? "attachment",
        content_id: attachment.contentId ?? null,
        size: bytes.length,
        content: toBase64(bytes),
      }
    })
    const email: ReceivedEmail = {
      id,
      from: input.from,
      to: list(input.to),
      cc: list(input.cc),
      bcc: list(input.bcc),
      replyTo: list(input.replyTo),
      subject: input.subject ?? null,
      html: input.html ?? null,
      text: input.text ?? null,
      headers: input.headers ?? {},
      messageId: input.messageId ?? `<${id}@inbound.resend.mock>`,
      attachments,
      createdAt: this.iso(),
    }
    this.state.received.insert(id, email)
    for (const attachment of attachments) {
      this.state.attachmentIndex.insert(attachment.id, { emailId: id })
    }
    const event: EmailReceivedEvent = {
      type: "email.received",
      created_at: email.createdAt,
      data: {
        email_id: id,
        created_at: email.createdAt,
        from: email.from,
        to: email.to,
        cc: email.cc,
        bcc: email.bcc,
        subject: email.subject,
        message_id: email.messageId,
        attachments: attachments.map((attachment) => ({
          ...this.attachmentMeta(attachment),
          ...(input.inline
            ? { size: attachment.size, download_url: this.downloadUrl(origin, attachment.id) }
            : {}),
        })),
        ...(input.inline
          ? {
              text: email.text,
              html: email.html,
              headers: Object.entries(email.headers).map(([name, value]) => ({ name, value })),
            }
          : {}),
      },
    }
    return { email, event }
  }

  /** Every received email, oldest first. */
  inbound(): ReceivedEmail[] {
    return this.state.received.list({ order: "oldest" }).map((row) => row.value)
  }

  private attachmentMeta(attachment: ReceivedAttachmentRecord) {
    return {
      id: attachment.id,
      filename: attachment.filename,
      content_type: attachment.content_type,
      content_disposition: attachment.content_disposition,
      content_id: attachment.content_id,
    }
  }

  private downloadUrl(origin: string, attachmentId: string): string {
    const prefix =
      this.publicNamespace && this.publicNamespace !== "default"
        ? `${this.adminPrefix}/ns/${encodeURIComponent(this.publicNamespace)}`
        : ""
    return `${origin}${prefix}/downloads/inbound/${attachmentId}`
  }

  private getReceived(context: OperationContext): Response {
    const email = this.state.received.get(context.params.email_id ?? "")
    if (!email) return notFound()
    return annotateResponse(
      jsonRes(200, {
        object: "email",
        id: email.id,
        to: email.to,
        from: email.from,
        cc: email.cc,
        bcc: email.bcc,
        reply_to: email.replyTo,
        created_at: email.createdAt,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: email.headers,
        message_id: email.messageId,
        attachments: email.attachments.map((a) => this.attachmentMeta(a)),
      }),
      { ids: { receivedEmailId: email.id } },
    )
  }

  private listAttachments(context: OperationContext): Response {
    const email = this.state.received.get(context.params.email_id ?? "")
    if (!email) return notFound()
    return annotateResponse(
      jsonRes(200, {
        object: "list",
        has_more: false,
        data: email.attachments.map((attachment) => ({
          ...this.attachmentMeta(attachment),
          size: attachment.size,
          download_url: this.downloadUrl(context.url.origin, attachment.id),
          expires_at: this.iso(DOWNLOAD_URL_TTL_MS),
        })),
      }),
      { ids: { receivedEmailId: email.id } },
    )
  }

  private download(context: OperationContext): Response {
    const id = context.params.attachment_id ?? ""
    const owner = this.state.attachmentIndex.get(id)
    const attachment = owner
      ? this.state.received.get(owner.emailId)?.attachments.find((a) => a.id === id)
      : undefined
    if (!attachment) return notFound("Attachment")
    const bytes = fromBase64(attachment.content)
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "content-type": attachment.content_type,
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${attachment.filename.replace(/"/g, "")}"`,
      },
    })
  }
}

export type { ResendRuntime, ResendRuntimeOptions } from "./runtime.js"
export { createRuntime, forwardToInbox, RESEND_PRESETS } from "./runtime.js"
