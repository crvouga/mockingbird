import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  type BodyIssue,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  fromBase64,
  HttpError,
  jsonRes,
  type OperationContext,
  requestFingerprint,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
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

export type ResendAPIOptions = APIOptions & {
  /** The public namespace name, for `/ns/<name>` download URLs. Default: the default namespace. */
  publicNamespace?: string
  /** Called after every accepted send (not replays); awaited before the response. */
  onSent?: (email: SentEmail) => Promise<void> | void
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
  private readonly service: Service
  private readonly now: () => number
  private readonly publicNamespace: string | undefined
  private readonly onSent: ResendAPIOptions["onSent"]

  constructor(options: ResendAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? RESEND_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.publicNamespace = options.publicNamespace
    this.onSent = options.onSent
    this.state = new ResendState(sqlite, namespace)
    const handlers = defineOperations<SupportedOperationId>({
      SendEmail: (context) => this.send(context),
      GetEmail: (context) => this.getEmail(context),
      GetReceivedEmail: (context) => this.getReceived(context),
      ListReceivedEmailAttachments: (context) => this.listAttachments(context),
      DownloadReceivedAttachment: (context) => this.download(context),
    })
    this.service = createService({
      document,
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
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
  }

  /** Every sent email, oldest first. */
  sent(): SentEmail[] {
    return this.state.outbox.list()
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString()
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
      tags: Array.isArray(body.tags) ? (body.tags as SentEmail["tags"]) : [],
      headers: (body.headers as Record<string, string> | undefined) ?? {},
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
        last_event: email.scheduledAt ? "scheduled" : "delivered",
        scheduled_at: email.scheduledAt,
        tags: email.tags,
      }),
      { ids: { emailId: email.id } },
    )
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
        ? `/ns/${encodeURIComponent(this.publicNamespace)}`
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
