import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  IdempotencyStore,
  jsonRes,
  type OperationContext,
  requestFingerprint,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  encodeCursor,
  matches,
  paginate,
  parseQuery,
  QueryError,
  toHtml,
  toPlaintext,
} from "./query.js"
import {
  type AdminRecord,
  type AttachmentRecord,
  type Author,
  type ContactRecord,
  type ConversationRecord,
  DEFAULT_ADMINS,
  IntercomState,
  type OutboxRecord,
  type PartRecord,
  type Settings,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { Query } from "./query.js"
export { decodeCursor, encodeCursor, toHtml, toPlaintext } from "./query.js"
export type {
  AdminRecord,
  AttachmentRecord,
  Author,
  ContactRecord,
  ConversationRecord,
  OutboxRecord,
  PartRecord,
  Settings,
} from "./state.js"
export { DEFAULT_ADMINS, DEFAULT_SETTINGS } from "./state.js"

export const INTERCOM_NAMESPACE = "intercom"

/** The webhook topics the mock sends. */
export const INTERCOM_TOPICS = [
  "conversation.admin.replied",
  "conversation.admin.closed",
  "conversation.admin.opened",
  "conversation.admin.snoozed",
  "conversation.admin.assigned",
  "conversation.admin.single.created",
  "conversation.user.created",
  "conversation.user.replied",
] as const
export type IntercomTopic = (typeof INTERCOM_TOPICS)[number]

/** The body Intercom posts to a webhook subscription (`type: notification_event`). */
export type IntercomNotification = {
  type: "notification_event"
  app_id: string
  data: { type: "notification_event_data"; item: Record<string, unknown> }
  links: Record<string, never>
  id: string
  topic: IntercomTopic
  delivery_status: "pending"
  delivery_attempts: number
  delivered_at: number
  first_sent_at: number
  created_at: number
  self: null
}

export type IntercomAPIOptions = APIOptions & {
  /** Admins every namespace starts with. Default: {@link DEFAULT_ADMINS}. */
  admins?: readonly AdminRecord[]
  /** Initial per-namespace settings (accepted tokens, defined custom attributes). */
  settings?: Partial<Settings>
  /** Called for every webhook-worthy event; the runtime signs and delivers it. */
  onWebhook?: (notification: IntercomNotification) => void
  /** Wall clock used for receiver freshness checks. Defaults to `Date.now`. */
  wallClock?: () => number
}

const CONTACT_FIELDS = [
  "id",
  "external_id",
  "email",
  "name",
  "phone",
  "role",
  "created_at",
  "updated_at",
  "signed_up_at",
  "last_seen_at",
  "custom_attributes.*",
]

const CONVERSATION_FIELDS = [
  "id",
  "contact_ids",
  "teammate_ids",
  "admin_assignee_id",
  "team_assignee_id",
  "state",
  "open",
  "read",
  "priority",
  "title",
  "created_at",
  "updated_at",
  "waiting_since",
  "source.id",
  "source.type",
  "source.delivered_as",
  "source.subject",
  "source.body",
  "source.author.id",
  "source.author.type",
  "source.author.name",
  "source.author.email",
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

/** Admin-side outcomes of a reply or state change, surfaced to admin routes. */
export class IntercomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Stateful mock of the Intercom REST API (2.11): contacts, conversations, admins.
 *
 * Admin replies and close/open (from the API or from the admin plane) emit the signed
 * `notification_event` webhooks our backend and EMR receivers verify.
 */
export class IntercomAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: IntercomState
  private readonly service: Service
  private readonly idempotency: IdempotencyStore
  private readonly now: () => number
  private readonly wallClock: () => number
  private readonly onWebhook: ((notification: IntercomNotification) => void) | undefined

  constructor(options: IntercomAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? INTERCOM_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.wallClock = options.wallClock ?? Date.now
    this.onWebhook = options.onWebhook
    this.state = new IntercomState(sqlite, namespace, {
      admins: options.admins ?? DEFAULT_ADMINS,
      settings: options.settings ?? {},
    })
    this.idempotency = new IdempotencyStore(sqlite, namespace)
    const handlers = defineOperations<SupportedOperationId>({
      SearchContacts: (context) => this.searchContacts(context),
      CreateContact: (context) => this.createContact(context),
      GetContact: (context) => {
        const contact = this.state.contacts.get(context.params.contact_id ?? "")
        return contact
          ? annotateResponse(jsonRes(200, this.contactBody(contact)), {
              ids: { contactId: contact.id },
            })
          : this.error(404, "not_found", "User Not Found")
      },
      UpdateContact: (context) => this.updateContact(context),
      CreateConversation: (context) => this.createConversation(context),
      UpdateConversation: (context) => this.updateConversation(context),
      ReplyConversation: (context) => this.reply(context),
      ManageConversation: (context) => this.manageConversation(context),
      GetConversation: (context) =>
        this.withConversation(context, (conversation) =>
          jsonRes(
            200,
            this.conversationBody(conversation, {
              plaintext: context.query.display_as === "plaintext",
              parts: conversation.parts,
            }),
          ),
        ),
      SearchConversations: (context) => this.searchConversations(context),
      ListAdmins: () =>
        jsonRes(200, {
          type: "admin.list",
          admins: this.state.admins.list({ order: "oldest" }).map((row) => row.value),
        }),
      GetMe: () =>
        jsonRes(200, {
          type: "admin",
          id: "1000000",
          name: "Mockingbird API",
          email: "api@mock.intercom.local",
          email_verified: true,
          has_inbox_seat: false,
          avatar: { type: "avatar", image_url: null },
          app: {
            type: "app",
            id_code: this.state.workspaceId,
            name: "Mockingbird",
            created_at: 1_600_000_000,
            secure: false,
            identity_verification: false,
            timezone: "America/Los_Angeles",
            region: "US",
          },
        }),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => this.error(404, "not_found", "Resource Not Found"),
      onError: (thrown) => {
        if (thrown instanceof HttpError) return thrown.toResponse()
        if (thrown instanceof QueryError)
          return this.error(400, "parameter_invalid", thrown.message)
        if (thrown instanceof IntercomError)
          return this.error(thrown.status, thrown.code, thrown.message)
        throw thrown
      },
      before: (context) => {
        const token = bearerToken(context.request)
        if (!token) return this.error(401, "unauthorized", "Access Token Required")
        const tokens = this.state.current().tokens
        if (tokens.length > 0 && !tokens.includes(token)) {
          return this.error(401, "unauthorized", "Access Token Invalid")
        }
        const version = context.request.headers.get("intercom-version")
        if (version !== null && !/^(\d+\.\d+|Unstable)$/.test(version.trim())) {
          return this.error(
            400,
            "intercom_version_invalid",
            "The requested version could not be found",
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

  private seconds(): number {
    return Math.floor(this.now() / 1000)
  }

  /** Intercom's error envelope. */
  error(status: number, code: string, message: string): Response {
    return jsonRes(status, {
      type: "error.list",
      request_id: this.state.nextRequestId(),
      errors: [{ code, message }],
    })
  }

  private json(context: OperationContext): Record<string, unknown> {
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      const first = issues[0] as { path: string; message: string }
      const missing = /^missing required property (.+)$/.exec(first.message)
      throw missing
        ? new IntercomError(
            400,
            "parameter_not_found",
            `${[first.path, missing[1]].filter(Boolean).join(".")} is required`,
          )
        : new IntercomError(400, "parameter_invalid", `${first.path || "body"} ${first.message}`)
    }
    return context.body.kind === "json" && isRecord(context.body.value) ? context.body.value : {}
  }

  // ─── Contacts ───────────────────────────────────────────────────────────────────────────

  contactBody(contact: ContactRecord) {
    const list = (url: string) => ({ type: "list", data: [], url, total_count: 0, has_more: false })
    return {
      type: "contact",
      id: contact.id,
      workspace_id: this.state.workspaceId,
      external_id: contact.external_id,
      role: contact.role,
      email: contact.email,
      phone: contact.phone,
      name: contact.name,
      avatar: null,
      owner_id: null,
      social_profiles: { type: "list", data: [] },
      has_hard_bounced: false,
      marked_email_as_spam: false,
      unsubscribed_from_emails: false,
      created_at: contact.created_at,
      updated_at: contact.updated_at,
      signed_up_at: contact.signed_up_at,
      last_seen_at: contact.last_seen_at,
      last_replied_at: null,
      last_contacted_at: null,
      last_email_opened_at: null,
      last_email_clicked_at: null,
      language_override: null,
      browser: null,
      browser_version: null,
      browser_language: null,
      os: null,
      location: { type: "location", country: null, region: null, city: null },
      custom_attributes: contact.custom_attributes,
      tags: list(`/contacts/${contact.id}/tags`),
      notes: list(`/contacts/${contact.id}/notes`),
      companies: list(`/contacts/${contact.id}/companies`),
    }
  }

  private contactField(contact: ContactRecord, field: string): unknown {
    if (field.startsWith("custom_attributes.")) {
      return contact.custom_attributes[field.slice("custom_attributes.".length)]
    }
    return (contact as unknown as Record<string, unknown>)[field]
  }

  private searchContacts(context: OperationContext): Response {
    const body = this.json(context)
    const query = parseQuery(body.query, CONTACT_FIELDS)
    const found = this.state.contacts
      .list({ order: "oldest" })
      .map((row) => row.value)
      .filter((contact) => matches(query, (field) => this.contactField(contact, field)))
    const page = paginate(found, body.pagination, 50)
    return jsonRes(200, {
      type: "list",
      data: page.items.map((contact) => this.contactBody(contact)),
      total_count: found.length,
      pages: page.pages,
    })
  }

  private checkCustomAttributes(attributes: unknown): Record<string, unknown> {
    if (attributes === undefined) return {}
    const defined = this.state.current().customAttributes
    const given = isRecord(attributes) ? attributes : {}
    if (defined !== null) {
      const unknown = Object.keys(given).find((key) => !defined.includes(key))
      if (unknown !== undefined) {
        throw new IntercomError(
          400,
          "parameter_invalid",
          `Custom attribute '${unknown}' does not exist`,
        )
      }
    }
    return given
  }

  /** The contact another contact's identifiers would collide with (users only). */
  private duplicateOf(
    candidate: { role: string; external_id: string | null; email: string | null },
    except?: string,
  ): ContactRecord | undefined {
    if (candidate.role !== "user") return undefined
    return this.state.findContact(
      (other) =>
        other.id !== except &&
        other.role === "user" &&
        ((candidate.external_id !== null && other.external_id === candidate.external_id) ||
          (candidate.email !== null &&
            other.email !== null &&
            other.email.toLowerCase() === candidate.email.toLowerCase())),
    )
  }

  private createContact(context: OperationContext): Response {
    const body = this.json(context)
    const role = body.role === "lead" ? "lead" : "user"
    const externalId = str(body.external_id) ?? null
    const email = str(body.email) ?? null
    if (role === "user" && externalId === null && email === null) {
      return this.error(400, "parameter_invalid", "A user contact requires an email or external_id")
    }
    const customAttributes = this.checkCustomAttributes(body.custom_attributes)
    const duplicate = this.duplicateOf({ role, external_id: externalId, email })
    if (duplicate) {
      return annotateResponse(
        this.error(
          409,
          "conflict",
          `A contact matching those details already exists with id=${duplicate.id}`,
        ),
        { ids: { contactId: duplicate.id } },
      )
    }
    const now = this.seconds()
    const contact: ContactRecord = {
      id: this.state.nextContactId(),
      external_id: externalId,
      role,
      email,
      phone: str(body.phone) ?? null,
      name: str(body.name) ?? null,
      created_at: now,
      updated_at: now,
      signed_up_at: typeof body.signed_up_at === "number" ? body.signed_up_at : null,
      last_seen_at: typeof body.last_seen_at === "number" ? body.last_seen_at : null,
      custom_attributes: customAttributes,
    }
    this.state.contacts.insert(contact.id, contact)
    return annotateResponse(jsonRes(200, this.contactBody(contact)), {
      ids: { contactId: contact.id },
    })
  }

  private updateContact(context: OperationContext): Response {
    const existing = this.state.contacts.get(context.params.contact_id ?? "")
    if (!existing) return this.error(404, "not_found", "User Not Found")
    const body = this.json(context)
    const customAttributes = this.checkCustomAttributes(body.custom_attributes)
    const next: ContactRecord = {
      ...existing,
      ...(body.role === "user" || body.role === "lead" ? { role: body.role } : {}),
      ...("external_id" in body ? { external_id: str(body.external_id) ?? null } : {}),
      ...("email" in body ? { email: str(body.email) ?? null } : {}),
      ...("name" in body ? { name: str(body.name) ?? null } : {}),
      ...("phone" in body ? { phone: str(body.phone) ?? null } : {}),
      ...(typeof body.signed_up_at === "number" || body.signed_up_at === null
        ? { signed_up_at: body.signed_up_at }
        : {}),
      ...(typeof body.last_seen_at === "number" || body.last_seen_at === null
        ? { last_seen_at: body.last_seen_at }
        : {}),
      custom_attributes: { ...existing.custom_attributes, ...customAttributes },
      updated_at: this.seconds(),
    }
    const duplicate = this.duplicateOf(next, existing.id)
    if (duplicate) {
      return this.error(
        409,
        "conflict",
        `A contact matching those details already exists with id=${duplicate.id}`,
      )
    }
    this.state.contacts.update(existing.id, next)
    return annotateResponse(jsonRes(200, this.contactBody(next)), { ids: { contactId: next.id } })
  }

  // ─── Conversations ──────────────────────────────────────────────────────────────────────

  private withConversation(
    context: OperationContext,
    handle: (conversation: ConversationRecord) => Response | Promise<Response>,
  ): Response | Promise<Response> {
    const conversation = this.state.conversations.get(context.params.conversation_id ?? "")
    if (!conversation) return this.error(404, "not_found", "Resource Not Found")
    return handle(conversation)
  }

  /**
   * A conversation as Intercom serializes it. `parts` is omitted in search results, as the
   * real API does; `plaintext` renders bodies for `?display_as=plaintext`.
   */
  conversationBody(
    conversation: ConversationRecord,
    options: { plaintext?: boolean; parts?: readonly PartRecord[] } = {},
  ) {
    const render = (body: string | null) => (options.plaintext ? toPlaintext(body) : body)
    const contact = this.state.contacts.get(conversation.contactId)
    return {
      type: "conversation",
      id: conversation.id,
      title: conversation.title,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at,
      waiting_since: conversation.waiting_since,
      snoozed_until: conversation.snoozed_until,
      open: conversation.state !== "closed",
      state: conversation.state,
      read: conversation.read,
      priority: "not_priority",
      admin_assignee_id: conversation.admin_assignee_id,
      team_assignee_id: null,
      tags: { type: "tag.list", tags: [] },
      conversation_rating: null,
      source: { ...conversation.source, body: render(conversation.source.body) },
      contacts: {
        type: "contact.list",
        contacts: [
          {
            type: "contact",
            id: conversation.contactId,
            external_id: contact?.external_id ?? null,
          },
        ],
      },
      teammates: {
        type: "admin.list",
        admins: conversation.teammates.map((id) => ({ type: "admin", id })),
      },
      custom_attributes: conversation.custom_attributes,
      first_contact_reply: null,
      sla_applied: null,
      statistics: null,
      ai_agent_participated: false,
      ...(options.parts
        ? {
            conversation_parts: {
              type: "conversation_part.list",
              conversation_parts: options.parts.map((part) => ({
                ...part,
                body: render(part.body),
              })),
              total_count: options.parts.length,
            },
          }
        : {}),
    }
  }

  private authorOf(contact: ContactRecord): Author {
    return { type: "user", id: contact.id, name: contact.name, email: contact.email }
  }

  private adminAuthor(adminId: unknown): Author {
    const admin = typeof adminId === "string" ? this.state.admins.get(adminId) : undefined
    if (!admin) throw new IntercomError(404, "not_found", "Admin Not Found")
    return { type: "admin", id: admin.id, name: admin.name, email: admin.email }
  }

  private createConversation(context: OperationContext): Promise<Response> | Response {
    const body = this.json(context)
    const create = () => {
      const from = body.from as { type: string; id: string }
      const contact = this.state.contacts.get(from.id)
      if (!contact) return this.error(404, "not_found", "User Not Found")
      const now = this.seconds()
      const conversation: ConversationRecord = {
        id: this.state.nextConversationId(),
        contactId: contact.id,
        created_at: now,
        updated_at: now,
        waiting_since: now,
        snoozed_until: null,
        state: "open",
        read: true,
        title: null,
        admin_assignee_id: null,
        teammates: [],
        custom_attributes: {},
        source: {
          type: "conversation",
          id: this.state.nextMessageId(),
          delivered_as: "customer_initiated",
          subject: "",
          body: toHtml(String(body.body)),
          author: this.authorOf(contact),
          attachments: [],
          url: null,
          redacted: false,
        },
        parts: [],
      }
      this.state.conversations.insert(conversation.id, conversation)
      const text = String(body.body)
      this.recordSent({
        operation: "CreateConversation",
        conversation,
        partId: null,
        partType: "source",
        author: conversation.source.author,
        bodyLength: text.length,
        attachmentCount: 0,
      })
      this.notify("conversation.user.created", conversation, [])
      return annotateResponse(
        jsonRes(200, {
          type: "user_message",
          id: conversation.source.id,
          created_at: now,
          body: conversation.source.body,
          message_type: "inapp",
          conversation_id: conversation.id,
        }),
        { ids: { contactId: contact.id, conversationId: conversation.id } },
      )
    }
    const key = context.request.headers.get("idempotency-key")
    if (!key) return create()
    return this.idempotency.run(
      key,
      requestFingerprint("POST", "/conversations", body),
      {
        mismatch: () =>
          this.error(409, "conflict", "Idempotency-Key was already used with different parameters"),
        conflict: () =>
          this.error(409, "conflict", "A request with this Idempotency-Key is still in progress"),
      },
      create,
    )
  }

  private updateConversation(context: OperationContext): Response | Promise<Response> {
    return this.withConversation(context, (conversation) => {
      const body = this.json(context)
      const next: ConversationRecord = {
        ...conversation,
        ...(typeof body.read === "boolean" ? { read: body.read } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        custom_attributes: {
          ...conversation.custom_attributes,
          ...(isRecord(body.custom_attributes) ? body.custom_attributes : {}),
        },
        updated_at: this.seconds(),
      }
      this.state.conversations.update(conversation.id, next)
      return annotateResponse(
        jsonRes(
          200,
          this.conversationBody(next, {
            plaintext: context.query.display_as === "plaintext",
            parts: next.parts,
          }),
        ),
        { ids: { conversationId: next.id } },
      )
    })
  }

  private async readReply(context: OperationContext): Promise<{
    fields: Record<string, unknown>
    attachments: Omit<AttachmentRecord, "url">[]
    urls: string[]
  }> {
    if (context.body.kind === "bytes" || context.body.kind === "text") {
      const contentType = context.request.headers.get("content-type") ?? ""
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        throw new IntercomError(400, "parameter_invalid", "Unsupported content type")
      }
      let form: FormData
      try {
        const raw =
          context.body.kind === "bytes"
            ? context.body.value
            : new TextEncoder().encode(context.body.value)
        form = await new Response(raw as BodyInit, {
          headers: { "content-type": contentType },
        }).formData()
      } catch {
        throw new IntercomError(400, "parameter_invalid", "Malformed multipart body")
      }
      const fields: Record<string, unknown> = {}
      const attachments: Omit<AttachmentRecord, "url">[] = []
      for (const [name, value] of form.entries()) {
        const entry = value as unknown as string | Blob
        if (typeof entry === "string") {
          fields[name] = entry
        } else if (name === "attachment_files[]" || name === "attachment_files") {
          attachments.push({
            type: "upload",
            name: (entry as Blob & { name?: string }).name || "attachment",
            content_type: entry.type || "application/octet-stream",
            filesize: entry.size,
            width: null,
            height: null,
          })
        }
      }
      return { fields, attachments, urls: [] }
    }
    const fields = this.json(context)
    const attachments = (Array.isArray(fields.attachment_files) ? fields.attachment_files : []).map(
      (file) => {
        const entry = file as { content_type: string; name: string; data: string }
        let size: number
        try {
          size = fromBase64(entry.data).byteLength
        } catch {
          throw new IntercomError(
            400,
            "parameter_invalid",
            `attachment ${entry.name} is not valid base64`,
          )
        }
        return {
          type: "upload" as const,
          name: entry.name,
          content_type: entry.content_type,
          filesize: size,
          width: null,
          height: null,
        }
      },
    )
    const urls = (Array.isArray(fields.attachment_urls) ? fields.attachment_urls : []).map(String)
    return { fields, attachments, urls }
  }

  private async reply(context: OperationContext): Promise<Response> {
    const conversation = this.state.conversations.get(context.params.conversation_id ?? "")
    if (!conversation) return this.error(404, "not_found", "Resource Not Found")
    const { fields, attachments, urls } = await this.readReply(context)
    const messageType = fields.message_type
    if (messageType !== "comment" && messageType !== "note" && messageType !== "quick_reply") {
      return this.error(
        400,
        "parameter_invalid",
        "message_type must be comment, note or quick_reply",
      )
    }
    let author: Author
    if (fields.type === "user") {
      if (messageType !== "comment") {
        return this.error(
          400,
          "parameter_invalid",
          "A user can only reply with message_type comment",
        )
      }
      const contact =
        (str(fields.intercom_user_id) &&
          this.state.contacts.get(fields.intercom_user_id as string)) ||
        (str(fields.user_id) && this.state.findContact((c) => c.external_id === fields.user_id)) ||
        (str(fields.email) &&
          this.state.findContact(
            (c) => c.email?.toLowerCase() === String(fields.email).toLowerCase(),
          )) ||
        undefined
      if (!contact) return this.error(404, "not_found", "User Not Found")
      author = this.authorOf(contact)
    } else if (fields.type === "admin") {
      author = this.adminAuthor(fields.admin_id)
    } else {
      return this.error(400, "parameter_invalid", "type must be user or admin")
    }
    const total = attachments.length + urls.length
    if (total > 10) return this.error(400, "parameter_invalid", "At most 10 attachments per reply")
    const body = str(fields.body)
    if (body === undefined && total === 0)
      return this.error(400, "parameter_not_found", "Body is required")
    const partId = this.state.nextPartId()
    const stored: AttachmentRecord[] = [
      ...attachments.map((a, index) => ({
        ...a,
        url: `https://downloads.intercomcdn.com/i/o/${partId}/${index}/${encodeURIComponent(a.name)}`,
      })),
      ...urls.map((url) => ({
        type: "upload" as const,
        name: url.split("/").pop() || "attachment",
        url,
        content_type: "application/octet-stream",
        filesize: 0,
        width: null,
        height: null,
      })),
    ]
    const next = this.appendPart(conversation, {
      id: partId,
      partType: messageType,
      author,
      body: body === undefined ? null : toHtml(body),
      attachments: stored,
    })
    this.recordSent({
      operation: "ReplyConversation",
      conversation: next,
      partId,
      partType: messageType,
      author,
      bodyLength: body?.length ?? 0,
      attachmentCount: stored.length,
    })
    return annotateResponse(jsonRes(200, this.conversationBody(next, { parts: next.parts })), {
      ids: { conversationId: next.id, partId },
    })
  }

  /** Add a comment/note part, update read/state, and fire `conversation.admin.replied`. */
  appendPart(
    conversation: ConversationRecord,
    input: {
      id?: string
      partType: "comment" | "note" | "quick_reply"
      author: Author
      body: string | null
      attachments?: AttachmentRecord[]
    },
  ): ConversationRecord {
    const now = this.seconds()
    const part: PartRecord = {
      type: "conversation_part",
      id: input.id ?? this.state.nextPartId(),
      part_type: input.partType,
      body: input.body,
      created_at: now,
      updated_at: now,
      notified_at: now,
      assigned_to: null,
      author: input.author,
      attachments: input.attachments ?? [],
      external_id: null,
      redacted: false,
    }
    const byAdmin = input.author.type === "admin"
    const visible = input.partType !== "note"
    const next: ConversationRecord = {
      ...conversation,
      parts: [...conversation.parts, part],
      updated_at: now,
      ...(byAdmin
        ? {
            teammates: conversation.teammates.includes(input.author.id)
              ? conversation.teammates
              : [...conversation.teammates, input.author.id],
            ...(visible ? { read: false, waiting_since: null } : {}),
          }
        : { read: true, waiting_since: now, state: "open" as const, snoozed_until: null }),
    }
    this.state.conversations.update(conversation.id, next)
    if (byAdmin && visible) this.notify("conversation.admin.replied", next, [part])
    if (input.author.type === "user") this.notify("conversation.user.replied", next, [part])
    return next
  }

  /** Record what the API client sent, for `GET /__admin/outbox`: metadata only, never the body. */
  private recordSent(input: {
    operation: OutboxRecord["operation"]
    conversation: ConversationRecord
    partId: string | null
    partType: OutboxRecord["partType"]
    author: Author
    bodyLength: number
    attachmentCount: number
  }): void {
    const at = new Date(this.now()).toISOString()
    this.state.outbox.record({
      id: `sent_${this.state.next("sent")}`,
      to: [input.conversation.id, input.conversation.contactId],
      createdAt: at,
      at,
      operation: input.operation,
      conversationId: input.conversation.id,
      contactId: input.conversation.contactId,
      partId: input.partId,
      partType: input.partType,
      authorType: input.author.type === "admin" ? "admin" : "user",
      authorId: input.author.id,
      hasBody: input.bodyLength > 0,
      bodyLength: input.bodyLength,
      attachmentCount: input.attachmentCount,
    })
  }

  private manageConversation(context: OperationContext): Response | Promise<Response> {
    return this.withConversation(context, (conversation) => {
      const body = this.json(context)
      const next = this.manage(conversation, {
        action: body.message_type as "close" | "open" | "snoozed" | "assignment",
        adminId: String(body.admin_id),
        ...(str(body.body) ? { body: body.body as string } : {}),
        ...(typeof body.snoozed_until === "number" ? { snoozedUntil: body.snoozed_until } : {}),
        ...(body.assignee_id !== undefined ? { assigneeId: String(body.assignee_id) } : {}),
      })
      return annotateResponse(jsonRes(200, this.conversationBody(next, { parts: next.parts })), {
        ids: { conversationId: next.id, partId: next.parts.at(-1)?.id ?? "" },
      })
    })
  }

  /** Close, open, snooze or assign as an admin; close and open fire their webhooks. */
  manage(
    conversation: ConversationRecord,
    input: {
      action: "close" | "open" | "snoozed" | "assignment"
      adminId: string
      body?: string
      snoozedUntil?: number
      assigneeId?: string
    },
  ): ConversationRecord {
    const author = this.adminAuthor(input.adminId)
    const now = this.seconds()
    if (input.action === "snoozed" && input.snoozedUntil === undefined) {
      throw new IntercomError(400, "parameter_not_found", "snoozed_until is required")
    }
    let assignee: AdminRecord | undefined
    if (input.action === "assignment") {
      if (input.assigneeId === undefined) {
        throw new IntercomError(400, "parameter_not_found", "assignee_id is required")
      }
      assignee = input.assigneeId === "0" ? undefined : this.state.admins.get(input.assigneeId)
      if (input.assigneeId !== "0" && !assignee) {
        throw new IntercomError(404, "not_found", "Admin Not Found")
      }
    }
    const part: PartRecord = {
      type: "conversation_part",
      id: this.state.nextPartId(),
      part_type: input.action,
      body: input.body === undefined ? null : toHtml(input.body),
      created_at: now,
      updated_at: now,
      notified_at: now,
      assigned_to: assignee ? { type: "admin", id: assignee.id } : null,
      author,
      attachments: [],
      external_id: null,
      redacted: false,
    }
    const next: ConversationRecord = {
      ...conversation,
      parts: [...conversation.parts, part],
      updated_at: now,
      ...(input.action === "close" ? { state: "closed" as const, snoozed_until: null } : {}),
      ...(input.action === "open" ? { state: "open" as const, snoozed_until: null } : {}),
      ...(input.action === "snoozed"
        ? { state: "snoozed" as const, snoozed_until: input.snoozedUntil ?? null }
        : {}),
      ...(input.action === "assignment"
        ? { admin_assignee_id: assignee ? Number(assignee.id) : null }
        : {}),
    }
    this.state.conversations.update(conversation.id, next)
    const topic = {
      close: "conversation.admin.closed",
      open: "conversation.admin.opened",
      snoozed: "conversation.admin.snoozed",
      assignment: "conversation.admin.assigned",
    }[input.action] as IntercomTopic
    this.notify(topic, next, [part])
    return next
  }

  /** An admin-initiated conversation (Intercom's outbound message): fires `admin.single.created`. */
  startAdminConversation(input: {
    contactId: string
    adminId: string
    body: string
  }): ConversationRecord {
    const contact = this.state.contacts.get(input.contactId)
    if (!contact) throw new IntercomError(404, "not_found", "User Not Found")
    const author = this.adminAuthor(input.adminId)
    const now = this.seconds()
    const conversation: ConversationRecord = {
      id: this.state.nextConversationId(),
      contactId: contact.id,
      created_at: now,
      updated_at: now,
      waiting_since: null,
      snoozed_until: null,
      state: "open",
      read: false,
      title: null,
      admin_assignee_id: null,
      teammates: [author.id],
      custom_attributes: {},
      source: {
        type: "conversation",
        id: this.state.nextMessageId(),
        delivered_as: "admin_initiated",
        subject: "",
        body: toHtml(input.body),
        author,
        attachments: [],
        url: null,
        redacted: false,
      },
      parts: [],
    }
    this.state.conversations.insert(conversation.id, conversation)
    this.notify("conversation.admin.single.created", conversation, [])
    return conversation
  }

  private conversationField(conversation: ConversationRecord, field: string): unknown {
    switch (field) {
      case "contact_ids":
        return [conversation.contactId]
      case "teammate_ids":
        return conversation.teammates
      case "open":
        return conversation.state !== "closed"
      case "team_assignee_id":
        return null
      case "priority":
        return "not_priority"
      default: {
        if (field.startsWith("source.")) {
          let value: unknown = conversation.source
          for (const key of field.slice("source.".length).split(".")) {
            value = isRecord(value) ? value[key] : undefined
          }
          return value
        }
        return (conversation as unknown as Record<string, unknown>)[field]
      }
    }
  }

  private searchConversations(context: OperationContext): Response {
    const body = this.json(context)
    const query = parseQuery(body.query, CONVERSATION_FIELDS)
    const sortField = str(body.sort_field) ?? "updated_at"
    const descending = body.sort_order !== "ascending"
    const found = this.state.conversations
      .list({ order: "oldest" })
      .map((row) => row.value)
      .filter((conversation) =>
        matches(query, (field) => this.conversationField(conversation, field)),
      )
      .sort((a, b) => {
        const x = Number(this.conversationField(a, sortField) ?? 0)
        const y = Number(this.conversationField(b, sortField) ?? 0)
        return (
          (descending ? y - x : x - y) ||
          (descending ? Number(b.id) - Number(a.id) : Number(a.id) - Number(b.id))
        )
      })
    const page = paginate(found, body.pagination, 20)
    const plaintext = context.query.display_as === "plaintext"
    if (faultEffect(context.request, "search_unavailable") !== undefined) {
      return jsonRes(200, {
        type: "conversation.list",
        pages: page.pages,
        total_count: found.length,
        conversations: null,
      })
    }
    const pages =
      faultEffect(context.request, "repeated_cursor") !== undefined
        ? {
            ...page.pages,
            next: { page: page.pages.page + 1, starting_after: encodeCursor(1_000_000) },
          }
        : page.pages
    return jsonRes(200, {
      type: "conversation.list",
      pages,
      total_count: found.length,
      conversations: page.items.map((conversation) =>
        this.conversationBody(conversation, { plaintext }),
      ),
    })
  }

  /**
   * Build and emit a `notification_event`. The item is the conversation with only the new
   * part(s), whose timestamps — like the envelope's — are wall-clock time, never the mock
   * clock: the EMR receiver rejects parts older than 5 minutes against its own clock.
   */
  private notify(
    topic: IntercomTopic,
    conversation: ConversationRecord,
    parts: PartRecord[],
  ): void {
    if (!this.onWebhook) return
    const wall = Math.floor(this.wallClock() / 1000)
    const item = this.conversationBody(conversation, {
      parts: parts.map((part) => ({
        ...part,
        created_at: wall,
        updated_at: wall,
        notified_at: wall,
      })),
    })
    this.onWebhook({
      type: "notification_event",
      app_id: this.state.workspaceId,
      data: { type: "notification_event_data", item },
      links: {},
      id: this.state.nextNotificationId(),
      topic,
      delivery_status: "pending",
      delivery_attempts: 1,
      delivered_at: 0,
      first_sent_at: wall,
      created_at: wall,
      self: null,
    })
  }

  /** Every conversation, oldest first (admin inspection). */
  conversations(): ConversationRecord[] {
    return this.state.conversations.list({ order: "oldest" }).map((row) => row.value)
  }

  contacts(): ContactRecord[] {
    return this.state.contacts.list({ order: "oldest" }).map((row) => row.value)
  }
}

export type { IntercomRuntime, IntercomRuntimeOptions } from "./runtime.js"
export { createRuntime, HUB_SIGNATURE_HEADER, INTERCOM_PRESETS, signHub } from "./runtime.js"
