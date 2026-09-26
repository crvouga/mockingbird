/**
 * Ports of our Intercom consumers, driven by the acceptance tests so "the mock works" means
 * "our consumers' own logic reaches the right outcome":
 *
 * 1. `IntercomMessagingAdapter` — `apps/backend/src/modules/messaging/intercom-messaging.adapter.ts`
 *    (member inbox and Care Hub): `intercomFetch`'s error mapping (404 → NotFound, 429 → 429,
 *    other 4xx → BadRequest, 5xx → throw), the contact-id cache and the 404
 *    re-resolve-and-retry-once, ownership checks, JSON and multipart replies, the admin inbox's
 *    cursor loop (non-array → 503, repeated cursor → 503) and admin lookups.
 * 2. `IntercomApiAdapter` — `apps/backend/src/modules/intercom/sync/adapters/outbound/
 *    intercom-api.adapter.ts`: external_id-then-email lookup, create with 409 → search → PUT,
 *    conversation create with `Idempotency-Key` and the escalation PUT, the JSON transcript
 *    attachment, and the `/me` connection check.
 * 3. The backend webhook receiver (`messaging.controller.ts` `handleWebhook`) and the EMR's
 *    `IntercomWebhookService.processWebhook`: signature verification, dedupe, field reads.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

export type Fetch = (request: Request) => Promise<Response>

const INTERCOM_VERSION = "2.11"

// ─── NestJS exception stand-ins ─────────────────────────────────────────────────────────

export class HttpException extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
export class NotFoundException extends HttpException {
  constructor(message: string) {
    super(message, 404)
  }
}
export class BadRequestException extends HttpException {
  constructor(message: string) {
    super(message, 400)
  }
}
export class ForbiddenException extends HttpException {
  constructor(message: string) {
    super(message, 403)
  }
}
export class ServiceUnavailableException extends HttpException {
  constructor(message: string) {
    super(message, 503)
  }
}

/** The `CacheService` the adapter uses (Redis in production), in memory. */
export class MemoryCache {
  readonly store = new Map<string, unknown>()
  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async setWithExpiry(key: string, value: unknown, _ttlSeconds: number): Promise<void> {
    this.store.set(key, value)
  }
  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key)
  }
}

const CONTACT_ID_CACHE_PREFIX = "intercom:contact:"
const ADMIN_EMAIL_CACHE_PREFIX = "intercom:admin-email:"
const ADMIN_LIST_CACHE_KEY = "intercom:admins:list"
const ADMIN_CONVERSATIONS_PAGE_SIZE = 150

type IntercomAttachment = { name?: string; url?: string; content_type?: string }
type IntercomConversationRaw = {
  id: string
  state: string
  read: boolean
  created_at: number
  source?: {
    id?: string
    body?: string | null
    author?: { type?: string; name?: string | null }
    attachments?: IntercomAttachment[]
  }
  contacts?: { contacts?: Array<{ external_id?: string }> }
  conversation_parts?: { conversation_parts?: unknown[] }
}

export type MessageDto = {
  id: string
  body: string | null
  author: { type: string; name: string | null }
  createdAt: number
  editedAt: null
  attachments: { name: string; url: string; contentType: string }[] | undefined
}

export type ConversationDetailDto = {
  id: string
  state: string
  isRead: boolean
  messages: MessageDto[]
  userExternalId?: string | null
}

export type ConversationPreviewDto = {
  id: string
  lastMessage: string | null
  lastMessageAt: number
  isRead: boolean
  state: string
  userName?: string | null
  userEmail?: string | null
  userExternalId?: string | null
}

export class IntercomMessagingAdapter {
  readonly errors: string[] = []

  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
    private readonly send: Fetch,
    readonly cache = new MemoryCache(),
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Intercom-Version": INTERCOM_VERSION,
    }
  }

  private async intercomFetch(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.send(
      new Request(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init?.headers as Record<string, string> | undefined) },
      }),
    )
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      this.errors.push(`Intercom API error: ${response.status} ${path} — ${body}`)
      const status = response.status
      if (status === 404) throw new NotFoundException(`Resource not found: ${path}`)
      if (status === 429) throw new HttpException("Too many requests", 429)
      if (status >= 400 && status < 500) {
        throw new BadRequestException(
          `Intercom API error: ${status} on ${init?.method ?? "GET"} ${path}`,
        )
      }
      throw new Error(`Intercom API error: ${status} on ${init?.method ?? "GET"} ${path}`)
    }
    return response
  }

  private stripHtml(html: string | null): string | null {
    if (!html) return null
    return html.replace(/<[^>]*>/g, "").trim()
  }

  async resolveIntercomContactId(externalId: string): Promise<string> {
    const cacheKey = `${CONTACT_ID_CACHE_PREFIX}${externalId}`
    const cached = await this.cache.get<unknown>(cacheKey)
    if (typeof cached === "string" && cached.length > 0) return cached
    const searchRes = await this.intercomFetch("/contacts/search", {
      method: "POST",
      body: JSON.stringify({ query: { field: "external_id", operator: "=", value: externalId } }),
    })
    const searchData = (await searchRes.json()) as { data?: Array<{ id?: unknown }> }
    const contactId = searchData.data?.[0]?.id
    if (typeof contactId === "string" && contactId.length > 0) {
      await this.cache.setWithExpiry(cacheKey, contactId, 3600)
      return contactId
    }
    return ""
  }

  private async withRefreshedContactId<T>(
    externalId: string,
    action: (contactId: string) => Promise<T>,
  ): Promise<T | null> {
    const contactId = await this.resolveIntercomContactId(externalId)
    if (!contactId) return null
    try {
      return await action(contactId)
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error
      await this.cache.delete([`${CONTACT_ID_CACHE_PREFIX}${externalId}`])
      const refreshedContactId = await this.resolveIntercomContactId(externalId)
      if (!refreshedContactId) throw error
      return action(refreshedContactId)
    }
  }

  private async getConversationRaw(conversationId: string): Promise<IntercomConversationRaw> {
    const res = await this.intercomFetch(`/conversations/${conversationId}?display_as=plaintext`)
    return (await res.json()) as IntercomConversationRaw
  }

  private verifyOwnershipFromData(data: IntercomConversationRaw, userExternalId: string): void {
    const ownerExternalId = data.contacts?.contacts?.[0]?.external_id ?? null
    if (ownerExternalId !== userExternalId) {
      throw new ForbiddenException("You do not have access to this conversation")
    }
  }

  async resolveUserFromConversation(conversationId: string): Promise<string | null> {
    try {
      const data = await this.getConversationRaw(conversationId)
      const contacts = data.contacts?.contacts ?? []
      if (contacts.length === 0) return null
      return contacts[0]?.external_id ?? null
    } catch {
      return null
    }
  }

  private mapAttachments(attachments?: IntercomAttachment[]) {
    if (!attachments?.length) return undefined
    return attachments
      .filter((a) => a.url)
      .map((a) => ({
        name: a.name ?? "attachment",
        url: a.url as string,
        contentType: a.content_type ?? "application/octet-stream",
      }))
  }

  private mapConversationParts(parts: unknown[]): MessageDto[] {
    return (
      parts as Array<{
        id: string
        body: string | null
        author: { type: string; name: string | null }
        created_at: number
        part_type: string
        attachments?: IntercomAttachment[]
      }>
    )
      .filter((p) => p.part_type === "comment")
      .map((part) => ({
        id: part.id,
        body: part.body,
        author: { type: part.author.type, name: part.author.name },
        createdAt: part.created_at,
        editedAt: null,
        attachments: this.mapAttachments(part.attachments),
      }))
  }

  private detail(data: IntercomConversationRaw): ConversationDetailDto {
    const sourceMessage: MessageDto = {
      id: data.source?.id ?? `source-${data.id}`,
      body: data.source?.body ?? null,
      author: {
        type: data.source?.author?.type ?? "user",
        name: data.source?.author?.name ?? null,
      },
      createdAt: data.created_at,
      editedAt: null,
      attachments: this.mapAttachments(data.source?.attachments),
    }
    return {
      id: data.id,
      state: data.state,
      isRead: data.read,
      messages: [
        sourceMessage,
        ...this.mapConversationParts(data.conversation_parts?.conversation_parts ?? []),
      ],
    }
  }

  async listConversations(params: { userExternalId: string; cursor?: string }) {
    const res = await this.withRefreshedContactId(params.userExternalId, (contactId) => {
      const pagination: Record<string, unknown> = { per_page: 20 }
      if (params.cursor) pagination.starting_after = params.cursor
      return this.intercomFetch("/conversations/search?display_as=plaintext", {
        method: "POST",
        body: JSON.stringify({
          query: { field: "contact_ids", operator: "=", value: contactId },
          pagination,
        }),
      })
    })
    if (!res) return { conversations: [], nextCursor: null }
    const data = (await res.json()) as {
      conversations?: Array<{
        id: string
        source: { body: string | null }
        updated_at: number
        read: boolean
        state: string
        conversation_parts?: { conversation_parts: Array<{ body: string | null }> }
      }>
      pages?: { next?: { starting_after?: string } }
    }
    const conversations: ConversationPreviewDto[] = (data.conversations ?? []).map((c) => {
      const parts = c.conversation_parts?.conversation_parts ?? []
      const lastPart = parts[parts.length - 1]
      const preview = lastPart?.body ?? c.source?.body ?? null
      return {
        id: c.id,
        lastMessage: preview?.trim().slice(0, 200) ?? null,
        lastMessageAt: c.updated_at,
        isRead: c.read,
        state: c.state,
      }
    })
    return { conversations, nextCursor: data.pages?.next?.starting_after ?? null }
  }

  async getConversation(params: { conversationId: string; userExternalId: string }) {
    const data = await this.getConversationRaw(params.conversationId)
    this.verifyOwnershipFromData(data, params.userExternalId)
    return this.detail(data)
  }

  async createConversation(params: { userExternalId: string; userEmail: string; body: string }) {
    let contactId = await this.resolveIntercomContactId(params.userExternalId)
    if (!contactId) {
      const createRes = await this.intercomFetch("/contacts", {
        method: "POST",
        body: JSON.stringify({
          role: "user",
          external_id: params.userExternalId,
          email: params.userEmail,
        }),
      })
      contactId = ((await createRes.json()) as { id: string }).id
      await this.cache.setWithExpiry(
        `${CONTACT_ID_CACHE_PREFIX}${params.userExternalId}`,
        contactId,
        3600,
      )
    }
    const res = await this.intercomFetch("/conversations", {
      method: "POST",
      body: JSON.stringify({ from: { type: "user", id: contactId }, body: params.body }),
    })
    const data = (await res.json()) as { conversation_id: string; created_at: number }
    return {
      id: data.conversation_id,
      lastMessage: params.body,
      lastMessageAt: data.created_at,
      isRead: true,
      state: "open",
    }
  }

  async replyToConversation(params: {
    conversationId: string
    userExternalId: string
    body: string
    attachments?: { name: string; contentType: string; data: string }[]
  }): Promise<ConversationDetailDto> {
    const existing = await this.getConversationRaw(params.conversationId)
    this.verifyOwnershipFromData(existing, params.userExternalId)
    const contactId = await this.resolveIntercomContactId(params.userExternalId)
    if (!contactId) throw new BadRequestException("Could not resolve Intercom contact")
    if (params.attachments && params.attachments.length > 0) {
      const formData = new FormData()
      formData.append("message_type", "comment")
      formData.append("type", "user")
      formData.append("intercom_user_id", contactId)
      formData.append("body", params.body)
      for (const attachment of params.attachments) {
        const bytes = Uint8Array.from(atob(attachment.data), (c) => c.charCodeAt(0))
        formData.append(
          "attachment_files[]",
          new Blob([bytes], { type: attachment.contentType }),
          attachment.name,
        )
      }
      const response = await this.send(
        new Request(`${this.baseUrl}/conversations/${params.conversationId}/reply`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: "application/json",
            "Intercom-Version": INTERCOM_VERSION,
          },
          body: formData,
        }),
      )
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        this.errors.push(`Intercom multipart reply error: ${response.status} — ${text}`)
        throw new BadRequestException(`Intercom API error: ${response.status}`)
      }
    } else {
      await this.intercomFetch(`/conversations/${params.conversationId}/reply`, {
        method: "POST",
        body: JSON.stringify({
          message_type: "comment",
          type: "user",
          intercom_user_id: contactId,
          body: params.body,
        }),
      })
    }
    return this.getConversation({
      conversationId: params.conversationId,
      userExternalId: params.userExternalId,
    })
  }

  async markAsRead(params: { conversationId: string; userExternalId: string }): Promise<void> {
    const data = await this.getConversationRaw(params.conversationId)
    this.verifyOwnershipFromData(data, params.userExternalId)
    await this.intercomFetch(`/conversations/${params.conversationId}`, {
      method: "PUT",
      body: JSON.stringify({ read: true }),
    })
  }

  async getUnreadCount(userExternalId: string): Promise<{ count: number }> {
    const res = await this.withRefreshedContactId(userExternalId, (contactId) =>
      this.intercomFetch("/conversations/search", {
        method: "POST",
        body: JSON.stringify({
          query: { field: "contact_ids", operator: "=", value: contactId },
          pagination: { per_page: 50 },
        }),
      }),
    )
    if (!res) return { count: 0 }
    const data = (await res.json()) as { conversations?: Array<{ read: boolean; state: string }> }
    return { count: (data.conversations ?? []).filter((c) => !c.read && c.state === "open").length }
  }

  private mapConversationPreview(raw: {
    id: string
    source?: {
      body?: string | null
      author?: { type?: string; name?: string | null; email?: string | null }
    }
    updated_at: number
    read: boolean
    state: string
    conversation_parts?: { conversation_parts?: Array<{ body?: string | null }> }
    contacts?: { contacts?: Array<{ external_id?: string | null }> }
  }): ConversationPreviewDto {
    const parts = raw.conversation_parts?.conversation_parts ?? []
    const lastPart = parts[parts.length - 1]
    const preview = this.stripHtml(lastPart?.body ?? raw.source?.body ?? null)
    const sourceAuthor = raw.source?.author
    return {
      id: raw.id,
      lastMessage: preview ? preview.slice(0, 200) : null,
      lastMessageAt: raw.updated_at,
      isRead: raw.read,
      state: raw.state,
      userName: sourceAuthor?.type === "user" ? (sourceAuthor.name ?? null) : null,
      userEmail: sourceAuthor?.type === "user" ? (sourceAuthor.email ?? null) : null,
      userExternalId: raw.contacts?.contacts?.[0]?.external_id ?? null,
    }
  }

  async listAdminConversations(params: {
    userExternalId?: string
    assigneeAdminId?: string
    state?: "open" | "closed" | "snoozed" | "any"
    cursor?: string
    pageLimit?: number
  }) {
    if (params.state === "any" && !params.userExternalId) {
      throw new BadRequestException("Intercom any-state search requires a member filter")
    }
    const filters: Array<Record<string, unknown>> = []
    if (params.userExternalId) {
      const contactId = await this.resolveIntercomContactId(params.userExternalId)
      if (!contactId) return { conversations: [], nextCursor: null }
      filters.push({ field: "contact_ids", operator: "=", value: contactId })
    }
    if (params.assigneeAdminId) {
      filters.push({ field: "admin_assignee_id", operator: "=", value: params.assigneeAdminId })
    }
    if (params.state !== "any") {
      filters.push({ field: "state", operator: "=", value: params.state ?? "open" })
    }
    const query = filters.length === 1 ? filters[0] : { operator: "AND", value: filters }
    const raw: Parameters<IntercomMessagingAdapter["mapConversationPreview"]>[0][] = []
    const seenCursors = new Set<string>()
    let cursor = params.cursor
    let nextCursor: string | null = null
    let pagesFetched = 0
    while (true) {
      const pagination: Record<string, unknown> = { per_page: ADMIN_CONVERSATIONS_PAGE_SIZE }
      if (cursor) pagination.starting_after = cursor
      const res = await this.intercomFetch("/conversations/search?display_as=plaintext", {
        method: "POST",
        body: JSON.stringify({
          query,
          pagination,
          sort_field: "updated_at",
          sort_order: "descending",
        }),
      })
      const data = (await res.json()) as {
        conversations?: unknown
        pages?: { next?: { starting_after?: unknown } }
      }
      if (!Array.isArray(data.conversations)) {
        throw new ServiceUnavailableException("Intercom conversation list is unavailable")
      }
      raw.push(...(data.conversations as typeof raw))
      pagesFetched += 1
      const responseCursor = data.pages?.next?.starting_after
      if (typeof responseCursor !== "string" || responseCursor.length === 0) break
      if (seenCursors.has(responseCursor)) {
        throw new ServiceUnavailableException("Intercom conversation pagination did not advance")
      }
      if (params.pageLimit !== undefined && pagesFetched >= params.pageLimit) {
        nextCursor = responseCursor
        break
      }
      seenCursors.add(responseCursor)
      cursor = responseCursor
    }
    return {
      conversations: raw.map((c) => this.mapConversationPreview(c)),
      nextCursor,
      pagesFetched,
    }
  }

  async getAdminConversation(conversationId: string): Promise<ConversationDetailDto> {
    const data = await this.getConversationRaw(conversationId)
    return {
      ...this.detail(data),
      userExternalId: data.contacts?.contacts?.[0]?.external_id ?? null,
    }
  }

  async adminReply(params: {
    conversationId: string
    adminId: string
    body: string
    messageType?: string
  }) {
    await this.intercomFetch(`/conversations/${params.conversationId}/reply`, {
      method: "POST",
      body: JSON.stringify({
        message_type: params.messageType ?? "comment",
        type: "admin",
        admin_id: params.adminId,
        body: params.body,
      }),
    })
    return this.getAdminConversation(params.conversationId)
  }

  async adminMarkAsRead(conversationId: string): Promise<void> {
    await this.intercomFetch(`/conversations/${conversationId}`, {
      method: "PUT",
      body: JSON.stringify({ read: true }),
    })
  }

  async adminCloseConversation(params: { conversationId: string; adminId: string }) {
    await this.intercomFetch(`/conversations/${params.conversationId}/parts`, {
      method: "POST",
      body: JSON.stringify({ message_type: "close", type: "admin", admin_id: params.adminId }),
    })
    return this.getAdminConversation(params.conversationId)
  }

  async adminReopenConversation(params: { conversationId: string; adminId: string }) {
    await this.intercomFetch(`/conversations/${params.conversationId}/parts`, {
      method: "POST",
      body: JSON.stringify({ message_type: "open", type: "admin", admin_id: params.adminId }),
    })
    return this.getAdminConversation(params.conversationId)
  }

  async resolveAdminIdByEmail(email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase()
    if (!normalized) return null
    const cacheKey = `${ADMIN_EMAIL_CACHE_PREFIX}${normalized}`
    const cached = await this.cache.get<string>(cacheKey)
    if (cached) return cached
    let admins = await this.cache.get<Array<{ id: string; email?: string }>>(ADMIN_LIST_CACHE_KEY)
    if (!admins) {
      const res = await this.intercomFetch("/admins")
      admins =
        ((await res.json()) as { admins?: Array<{ id: string; email?: string }> }).admins ?? []
      await this.cache.setWithExpiry(ADMIN_LIST_CACHE_KEY, admins, 600)
    }
    const match = admins.find((a) => a.email?.toLowerCase() === normalized)
    if (!match) return null
    await this.cache.setWithExpiry(cacheKey, match.id, 600)
    return match.id
  }
}

// ─── The sync adapter ─────────────────────────────────────────────────────────────────

export type IntercomContactPayload = {
  external_id: string
  email: string
  name?: string
  phone?: string
  signed_up_at?: number
  custom_attributes: Record<string, unknown>
}

export class IntercomApiAdapter {
  readonly logs: string[] = []

  constructor(
    private readonly baseUrl: string,
    private readonly config: { accessToken: string; syncEnabled: boolean },
    private readonly send: Fetch,
  ) {}

  private assertOutboundSyncEnabled(operation: string): void {
    if (this.config.syncEnabled) return
    throw new Error(
      `Intercom outbound ${operation} refused: FEATURE_INTERCOM_SYNC_ENABLED is not true`,
    )
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Intercom-Version": "2.11",
    }
  }

  private post(path: string, body: unknown, method = "POST", extra: Record<string, string> = {}) {
    return this.send(
      new Request(`${this.baseUrl}${path}`, {
        method,
        headers: { ...this.headers, ...extra },
        body: JSON.stringify(body),
      }),
    )
  }

  private async search(field: "external_id" | "email", value: string) {
    const response = await this.post("/contacts/search", { query: { field, operator: "=", value } })
    if (!response.ok) {
      throw new Error(
        `Intercom search by ${field} failed: ${response.status} - ${await response.text()}`,
      )
    }
    const data = (await response.json()) as {
      data: { id: string; external_id?: string; email?: string }[]
    }
    if (field === "email" && data.data && data.data.length > 1) {
      this.logs.push(
        `warn: Multiple Intercom contacts found for email ${value} — using first match`,
      )
    }
    return data.data?.[0] ?? null
  }

  async findContact(userId: number, email: string) {
    try {
      const byExternalId = await this.search("external_id", String(userId))
      if (byExternalId) return byExternalId
    } catch (error) {
      this.logs.push(
        `warn: external_id search failed, falling back to email: ${(error as Error).message}`,
      )
    }
    return this.search("email", email.toLowerCase())
  }

  async createContact(
    payload: IntercomContactPayload,
  ): Promise<{ id: string; action: "created" | "updated" }> {
    this.assertOutboundSyncEnabled("createContact")
    const response = await this.post("/contacts", { role: "user", ...payload })
    const responseText = await response.text()
    if (response.status === 409) {
      this.logs.push(
        `warn: Contact already exists (409) for ${payload.email}, searching and updating instead`,
      )
      const existing = await this.findContact(Number(payload.external_id), payload.email)
      if (existing)
        return { id: (await this.updateContact(existing.id, payload)).id, action: "updated" }
      throw new Error("Contact exists (409) but could not be found after search")
    }
    if (!response.ok)
      throw new Error(`Intercom create failed: ${response.status} - ${responseText}`)
    return { id: (JSON.parse(responseText) as { id: string }).id, action: "created" }
  }

  async updateContact(contactId: string, payload: IntercomContactPayload): Promise<{ id: string }> {
    this.assertOutboundSyncEnabled("updateContact")
    const response = await this.post(`/contacts/${contactId}`, payload, "PUT")
    const responseText = await response.text()
    if (!response.ok)
      throw new Error(`Intercom update failed: ${response.status} - ${responseText}`)
    return JSON.parse(responseText) as { id: string }
  }

  async createConversation(params: {
    intercomContactId: string
    body: string
    idempotencyKey?: string
  }): Promise<{ intercomConversationId: string }> {
    this.assertOutboundSyncEnabled("createConversation")
    const response = await this.post(
      "/conversations",
      { from: { type: "user", id: params.intercomContactId }, body: params.body },
      "POST",
      params.idempotencyKey ? { "Idempotency-Key": params.idempotencyKey } : {},
    )
    const responseText = await response.text()
    if (!response.ok) {
      throw new Error(`Intercom create conversation failed: ${response.status} - ${responseText}`)
    }
    const intercomConversationId = (JSON.parse(responseText) as { conversation_id: string })
      .conversation_id
    try {
      const escalation = await this.post(
        `/conversations/${intercomConversationId}`,
        { custom_attributes: { chatbot_escalation: true } },
        "PUT",
      )
      if (!escalation.ok)
        this.logs.push(`warn: Failed to set escalation attributes: ${escalation.status}`)
    } catch (error) {
      this.logs.push(`warn: Failed to set escalation attributes: ${(error as Error).message}`)
    }
    return { intercomConversationId }
  }

  async attachFileToConversation(params: {
    intercomConversationId: string
    intercomContactId: string
    filename: string
    content: string
    contentType: string
  }): Promise<void> {
    this.assertOutboundSyncEnabled("attachFileToConversation")
    const response = await this.post(`/conversations/${params.intercomConversationId}/reply`, {
      message_type: "comment",
      type: "user",
      intercom_user_id: params.intercomContactId,
      body: "Full chat transcript attached.",
      attachment_files: [
        {
          content_type: params.contentType,
          name: params.filename,
          data: Buffer.from(params.content, "utf8").toString("base64"),
        },
      ],
    })
    if (!response.ok) {
      throw new Error(
        `Intercom attach file failed: ${response.status} - ${await response.text().catch(() => "")}`,
      )
    }
  }

  async checkConnection(): Promise<boolean> {
    try {
      const response = await this.send(new Request(`${this.baseUrl}/me`, { headers: this.headers }))
      return response.ok
    } catch {
      return false
    }
  }
}

// ─── Webhook receivers ─────────────────────────────────────────────────────────────────

/** `messaging.controller.ts` `handleWebhook`: verify, dedupe on `delivery_id ?? id`, notify. */
export class BackendWebhookReceiver {
  readonly seen = new Set<string>()
  readonly notifications: { userId: number; conversationId: string; preview: string }[] = []

  constructor(
    private readonly secret: string,
    private readonly messaging: IntercomMessagingAdapter,
  ) {}

  async handle(
    signature: string | null,
    rawBody: string,
  ): Promise<{ status: number; body: unknown }> {
    if (!signature || !rawBody)
      return { status: 401, body: { message: "Missing webhook signature" } }
    const computed = `sha1=${createHmac("sha1", this.secret).update(rawBody).digest("hex")}`
    const computedBuf = Buffer.from(computed)
    const signatureBuf = Buffer.from(signature)
    if (computedBuf.length !== signatureBuf.length || !timingSafeEqual(computedBuf, signatureBuf)) {
      return { status: 401, body: { message: "Invalid webhook signature" } }
    }
    const payload = JSON.parse(rawBody) as {
      topic: string
      delivery_id?: string
      id?: string
      data?: {
        item?: {
          id?: string
          conversation_id?: string
          conversation_parts?: { conversation_parts?: Array<{ body?: string | null }> }
        }
      }
    }
    const deliveryId = payload.delivery_id ?? payload.id
    if (this.seen.has(String(deliveryId))) return { status: 201, body: { status: "duplicate" } }
    this.seen.add(String(deliveryId))
    if (payload.topic === "conversation.admin.replied") {
      const conversationId = String(
        payload.data?.item?.conversation_id ?? payload.data?.item?.id ?? "",
      )
      const userExternalId = await this.messaging.resolveUserFromConversation(conversationId)
      if (userExternalId) {
        const userId = Number(userExternalId)
        if (!Number.isNaN(userId)) {
          const parts = payload.data?.item?.conversation_parts?.conversation_parts ?? []
          const lastPartBody = parts[parts.length - 1]?.body ?? null
          const preview = lastPartBody
            ? lastPartBody
                .replace(/<[^>]*>/g, "")
                .trim()
                .slice(0, 100)
            : "You have a new message from support"
          this.notifications.push({ userId, conversationId, preview })
        }
      }
    }
    return { status: 201, body: { status: "ok" } }
  }
}

export type EmrUser = { id: number; email: string; medplumUserId: string | null }

/** The EMR's `IntercomWebhookService.processWebhook` (Redis locks as an in-memory set). */
export class EmrWebhookReceiver {
  readonly processed = new Set<string>()
  readonly notifications: {
    userId: number
    conversationId: string
    message: string
    title: string
  }[] = []

  constructor(
    private readonly secret: string,
    private readonly users: EmrUser[],
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async handle(
    signature: string | null,
    rawBody: string,
  ): Promise<{ statusCode: number; message: string }> {
    if (!signature) return { statusCode: 401, message: "Missing webhook signature" }
    const expected = `sha1=${createHmac("sha1", this.secret).update(rawBody).digest("hex")}`
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return { statusCode: 401, message: "Invalid webhook signature" }
    }
    type Item = {
      id?: string
      created_at?: number
      source?: { delivered_as?: string; body?: string; author?: { email?: string } }
      contacts?: { contacts?: { external_id?: string }[] }
      conversation_parts?: {
        conversation_parts?: { id?: string; body?: string; created_at?: number }[]
      }
    }
    let payload: { type: string; id?: string; item?: Item; data?: { item?: Item } }
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return { statusCode: 400, message: "Invalid webhook payload format" }
    }
    const isData = payload.type === "notification_event_data"
    const item = isData ? payload.item : payload.data?.item
    const timestamp =
      item?.conversation_parts?.conversation_parts?.[0]?.created_at ?? item?.created_at
    if (timestamp) {
      const age = Math.floor(this.clock() / 1000) - timestamp
      if (age < 0 || age > 300)
        return { statusCode: 400, message: "Webhook timestamp is invalid or too old" }
    }
    if (!item) return { statusCode: 200, message: "No message ID found" }
    const prefix = isData ? "intercom:webhook:data" : `intercom:webhook:${payload.id}`
    const parts = item.conversation_parts?.conversation_parts
    const lastPart = parts?.[parts.length - 1]
    const messageId = lastPart?.id
      ? `${prefix}:part:${lastPart.id}`
      : item.id
        ? `${prefix}:conversation:${item.id}`
        : prefix
    if (this.processed.has(messageId)) {
      return { statusCode: 200, message: "Message already being processed or already processed" }
    }
    if (payload.type !== "notification_event" && payload.type !== "notification_event_data") {
      return { statusCode: 200, message: "Event type not supported" }
    }
    this.processed.add(messageId)
    const conversationId = item.id
    if (!conversationId) return { statusCode: 200, message: "Webhook processed successfully" }
    let user: EmrUser | undefined
    if (item.source?.delivered_as === "admin_initiated") {
      const externalId = item.contacts?.contacts?.[0]?.external_id
      user = externalId
        ? this.users.find((u) => u.id === Number.parseInt(externalId, 10))
        : undefined
    } else {
      const email = item.source?.author?.email
      user = email ? this.users.find((u) => u.email === email) : undefined
    }
    if (user?.medplumUserId) {
      const strip = (html?: string) =>
        (html ?? "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      this.notifications.push({
        userId: user.id,
        conversationId,
        message: strip(parts && parts.length > 0 ? lastPart?.body : item.source?.body),
        title: strip(item.source?.body).substring(0, 50),
      })
    }
    return { statusCode: 200, message: "Webhook processed successfully" }
  }
}
