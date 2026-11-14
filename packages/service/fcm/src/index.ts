import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  faultEffect,
  jsonRes,
  type OperationContext,
  parseDuration,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { rpcResponse } from "./errors.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  FCM_FIXTURE_PROJECT,
  type FcmState,
  FcmState as FcmStateClass,
  type InboxItem,
  isPlatform,
  isRecord,
  isTokenState,
  type MessageRecord,
  type NotificationFields,
  type Platform,
  type ScriptRecord,
  type Settings,
  type TokenRecord,
  type TokenState,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  CredentialRecord,
  InboxItem,
  MessageRecord,
  MessageState,
  Platform,
  ScriptRecord,
  Settings,
  TokenRecord,
  TokenState,
} from "./state.js"
export { FCM_FIXTURE_BEARER, FCM_FIXTURE_PROJECT, FCM_FIXTURE_TOKEN } from "./state.js"

export const FCM_NAMESPACE = "fcm"

export type FcmAccessCredential = {
  getAccessToken(): Promise<{ access_token: string; expires_in: number }>
}

/** A fixture access token. Structurally a firebase-admin `Credential` without importing that package. */
export const fcmCredential = (accessToken = "fixture-token"): FcmAccessCredential => ({
  getAccessToken: async () => ({ access_token: accessToken, expires_in: 3_600 }),
})

/** FNV-1a hex. Sync so the send handler can stamp the journal without a later await. */
const hashToken = (token: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export type FcmAPIOptions = APIOptions & {
  settings?: Partial<Settings>
}

export type OutboxQuery = {
  token?: string
  platform?: string
  project?: string
  since?: number
  collapseKey?: string
  state?: string
}

const TARGET_MESSAGE = "Exactly one registration token must be specified."

/**
 * Stateful FCM HTTP v1 send. Acceptance and device delivery are separate: `validate_only`
 * stores nothing, and a registration-token error stores nothing either.
 */
export class FcmAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: FcmState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: FcmAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? FCM_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new FcmStateClass(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      SendMessage: (context) => this.send(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => rpcResponse("INVALID_ARGUMENT", "Not Found"),
      onError: (error) => {
        if (error instanceof DroppedConnectionError) throw error
        return rpcResponse("INTERNAL")
      },
      before: (context) => this.authenticate(context),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensure()
  }

  logicalNow(): number {
    return this.now() + this.state.ensure().clockOffsetMs
  }

  /** Capture only a successful real send; never deliver to fixture devices or change tokens. */
  async recordForwarded(request: Request, response: Response): Promise<void> {
    const payload: unknown = await request.json().catch(() => undefined)
    if (!isRecord(payload) || payload.validate_only || !isRecord(payload.message)) return
    const result: unknown = await response.json().catch(() => undefined)
    if (!isRecord(result) || typeof result.name !== "string") return
    const project = decodeURIComponent(new URL(request.url).pathname.split("/")[3] ?? "")
    const id = result.name.split("/").at(-1) as string
    const token = String(payload.message.token ?? "")
    const message = this.buildMessage(
      `upstream:${id}`,
      result.name,
      project,
      token,
      "unknown",
      payload.message,
    )
    this.state.messages.insert(message.id, { ...message, upstream: true, sentForReal: true })
  }

  outbox(query: OutboxQuery = {}): MessageRecord[] {
    return this.state.messages
      .list({
        order: "oldest",
        where: (message) =>
          (query.token === undefined || message.token === query.token) &&
          (query.platform === undefined || message.platform === query.platform) &&
          (query.project === undefined || message.project === query.project) &&
          (query.collapseKey === undefined || message.collapseKey === query.collapseKey) &&
          (query.state === undefined || message.state === query.state) &&
          (query.since === undefined || message.acceptedAt >= query.since),
      })
      .map((row) => row.value)
  }

  inbox(token: string): InboxItem[] | undefined {
    return this.state.tokens.get(token)?.inbox
  }

  registerToken(input: {
    token: string
    platform?: string
    project?: string
    state?: string
    appId?: string
    replacement?: string
  }): TokenRecord | string {
    if (!input.token) return "token is required"
    const platform = input.platform ?? "android"
    if (!isPlatform(platform)) return "platform must be ios or android"
    const state = input.state ?? "active"
    if (!isTokenState(state))
      return "state must be active, expired, unregistered, or sender_mismatch"
    const record: TokenRecord = {
      token: input.token,
      project: input.project ?? FCM_FIXTURE_PROJECT,
      platform,
      state,
      inbox: this.state.tokens.get(input.token)?.inbox ?? [],
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.replacement ? { replacement: input.replacement } : {}),
    }
    this.state.tokens.insert(input.token, record)
    return record
  }

  setTokenState(token: string, state: TokenState, replacement?: string): TokenRecord | undefined {
    const current = this.state.tokens.get(token)
    if (!current) return undefined
    const next: TokenRecord = {
      ...current,
      state,
      ...(replacement !== undefined ? { replacement } : {}),
    }
    this.state.tokens.update(token, next)
    return next
  }

  ackInbox(token: string, action: "ack" | "clear"): InboxItem[] | undefined {
    const current = this.state.tokens.get(token)
    if (!current) return undefined
    const inbox = action === "clear" ? [] : current.inbox.slice(1)
    const next = { ...current, inbox }
    this.state.tokens.update(token, next)
    return inbox
  }

  /**
   * Deliver accepted messages. With collapse on, only the latest undelivered message for a
   * token and Android collapse key reaches the inbox; older accepts stay in the outbox
   * marked `collapsed`. Messages with no collapse key stay ordered and distinct.
   */
  deliverPending(onlyId?: string): { delivered: string[]; expired: string[]; collapsed: string[] } {
    const now = this.logicalNow()
    const collapse = this.state.ensure().collapse
    const pending = this.state.messages.list({
      order: "oldest",
      where: (message) =>
        !message.upstream &&
        message.state === "accepted" &&
        (onlyId === undefined || message.id === onlyId),
    })
    const delivered: string[] = []
    const expired: string[] = []
    const collapsed: string[] = []
    const groups = new Map<string, MessageRecord[]>()
    for (const row of pending) {
      const message = row.value
      if (message.expiresAtMs !== null && now >= message.expiresAtMs) {
        this.state.messages.update(message.id, { ...message, state: "expired" })
        expired.push(message.id)
        continue
      }
      const key =
        collapse && message.collapseKey
          ? `${message.token}\0${message.collapseKey}`
          : `solo:${message.id}`
      const list = groups.get(key) ?? []
      list.push(message)
      groups.set(key, list)
    }
    for (const group of groups.values()) {
      const latest = group[group.length - 1]
      if (!latest) continue
      for (const older of group.slice(0, -1)) {
        this.state.messages.update(older.id, { ...older, state: "collapsed" })
        collapsed.push(older.id)
      }
      if (this.deliverOne(latest)) delivered.push(latest.id)
      else expired.push(latest.id)
    }
    return { delivered, expired, collapsed }
  }

  dropMessage(id: string): MessageRecord | undefined {
    const message = this.state.messages.get(id)
    if (!message) return undefined
    const next = { ...message, state: "dropped" as const }
    this.state.messages.update(id, next)
    return next
  }

  duplicateMessage(id: string): MessageRecord | string {
    const message = this.state.messages.get(id)
    if (!message) return "no message"
    if (message.upstream) return "cannot duplicate a real upstream send"
    if (
      message.state === "dropped" ||
      message.state === "expired" ||
      message.state === "collapsed"
    ) {
      return `cannot duplicate a ${message.state} message`
    }
    if (message.state === "accepted") {
      const outcome = this.deliverPending(id)
      if (!outcome.delivered.includes(id)) return "message expired before it could be duplicated"
    }
    const latest = this.state.messages.get(id)
    if (!latest) return "no message"
    this.pushInbox(latest)
    return latest
  }

  putScript(id: string, script: ScriptRecord): void {
    this.state.scripts.insert(id, script)
  }

  private authenticate(context: OperationContext): Response | undefined {
    const projectId = context.params.project_id
    if (!projectId) return rpcResponse("INVALID_ARGUMENT", "project_id is required")
    const token = bearerToken(context.request)
    if (!token) return this.noted(rpcResponse("UNAUTHENTICATED"), projectId)
    const settings = this.state.ensure()
    const mapped = settings.credentials[token]
    if (mapped?.expired || (settings.strict && !mapped)) {
      return this.noted(rpcResponse("UNAUTHENTICATED"), projectId)
    }
    if (mapped && mapped.project !== projectId) {
      return this.noted(rpcResponse("PERMISSION_DENIED"), projectId)
    }
    return undefined
  }

  private send(context: OperationContext): Response {
    const projectId = context.params.project_id ?? ""
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      return this.noted(
        rpcResponse(
          "INVALID_ARGUMENT",
          issues[0]?.message ?? "Request contains an invalid argument.",
        ),
        projectId,
      )
    }
    const payload = context.body.kind === "json" ? context.body.value : undefined
    if (!isRecord(payload) || !isRecord(payload.message)) {
      return this.noted(rpcResponse("INVALID_ARGUMENT", "message must be an object"), projectId)
    }
    const message = payload.message
    const structural = this.validateMessage(message)
    if (structural) return this.noted(rpcResponse("INVALID_ARGUMENT", structural), projectId)
    const token = message.token
    if (typeof token !== "string") {
      return this.noted(rpcResponse("INVALID_ARGUMENT", TARGET_MESSAGE), projectId)
    }
    const registration = this.state.tokens.get(token)
    if (!registration) {
      return this.noted(rpcResponse("UNREGISTERED"), projectId, token)
    }
    if (registration.project !== projectId) {
      return this.noted(rpcResponse("SENDER_ID_MISMATCH"), projectId, token)
    }
    const stateError = tokenStateError(registration.state)
    if (stateError) return this.noted(rpcResponse(stateError), projectId, token)

    const validateOnly = payload.validate_only === true
    const id = this.state.ids.next("m", 20)
    const name = `projects/${projectId}/messages/${id}`
    if (validateOnly) return this.noted(jsonName(name), projectId, token, id)

    const script = this.consumeScript(token)
    if (script) {
      return this.noted(
        rpcResponse(script.errorCode, undefined, script.httpStatus),
        projectId,
        token,
      )
    }

    const built = this.buildMessage(id, name, projectId, token, registration.platform, message)
    this.state.messages.insert(id, built)
    if (this.state.ensure().automaticDelivery) this.deliverPending()
    // The accept is already stored. Dropping here is an ambiguous outcome, distinct from a
    // `drop` fault, which never reaches this handler.
    if (faultEffect(context.request, "accepted_then_network_drop") !== undefined) {
      throw new DroppedConnectionError()
    }
    return this.noted(jsonName(name), projectId, token, id)
  }

  private validateMessage(message: Record<string, unknown>): string | undefined {
    const present = ["token", "topic", "condition"].filter((key) => {
      const value = message[key]
      return typeof value === "string" && value.length > 0
    })
    if (present.length !== 1 || typeof message.token !== "string" || message.token.length === 0) {
      return TARGET_MESSAGE
    }
    if (message.notification !== undefined && !isRecord(message.notification)) {
      return "notification must be an object"
    }
    if (message.android !== undefined && !isRecord(message.android))
      return "android must be an object"
    if (message.apns !== undefined && !isRecord(message.apns)) return "apns must be an object"
    if (message.data !== undefined) {
      if (!isRecord(message.data)) return "data must be a map of strings"
      for (const value of Object.values(message.data)) {
        if (typeof value !== "string") return "data values must be strings"
      }
    }
    return undefined
  }

  private buildMessage(
    id: string,
    name: string,
    project: string,
    token: string,
    platform: Platform | "unknown",
    message: Record<string, unknown>,
  ): MessageRecord {
    const notification = notificationOf(message.notification)
    const data = dataOf(message.data)
    const android = isRecord(message.android) ? message.android : null
    const apns = isRecord(message.apns) ? message.apns : null
    const collapseKey = collapseKeyOf(android)
    const ttl = ttlOf(android)
    const apnsExpiration = apnsExpirationOf(apns)
    return {
      id,
      name,
      project,
      token,
      platform,
      acceptedAt: this.logicalNow(),
      notification,
      data,
      android,
      apns,
      collapseKey,
      ttl,
      apnsExpiration,
      expiresAtMs: this.expiresAt(android, apnsExpiration),
      state: "accepted",
      wire: message,
    }
  }

  private expiresAt(
    android: Record<string, unknown> | null,
    apnsExpiration: string | null,
  ): number | null {
    let expiresAt: number | null = null
    if (android && android.ttl !== undefined) {
      const ttlMs = parseDuration(android.ttl)
      if (ttlMs !== undefined) expiresAt = this.logicalNow() + ttlMs
    }
    if (apnsExpiration && /^\d+$/.test(apnsExpiration)) {
      const at = Number(apnsExpiration) * 1000
      expiresAt = expiresAt === null ? at : Math.min(expiresAt, at)
    }
    return expiresAt
  }

  private consumeScript(token: string): ScriptRecord | undefined {
    const specific = this.state.scripts.get(token)
    const id = specific ? token : "*"
    const chosen = specific ?? this.state.scripts.get("*")
    if (!chosen || chosen.count <= 0) return undefined
    if (chosen.count - 1 <= 0) this.state.scripts.delete(id)
    else this.state.scripts.update(id, { ...chosen, count: chosen.count - 1 })
    return chosen
  }

  private deliverOne(message: MessageRecord): boolean {
    if (message.expiresAtMs !== null && this.logicalNow() >= message.expiresAtMs) {
      this.state.messages.update(message.id, { ...message, state: "expired" })
      return false
    }
    this.pushInbox(message)
    this.state.messages.update(message.id, { ...message, state: "delivered" })
    return true
  }

  private pushInbox(message: MessageRecord): void {
    const token = this.state.tokens.get(message.token)
    if (!token) return
    const item: InboxItem = {
      id: message.id,
      messageId: message.id,
      title: message.notification?.title ?? null,
      body: message.notification?.body ?? null,
      image: message.notification?.image ?? null,
      data: message.data,
      android: message.android,
      apns: message.apns,
      platform: message.platform,
    }
    this.state.tokens.update(message.token, { ...token, inbox: [...token.inbox, item] })
  }

  private noted(response: Response, project: string, token?: string, messageId?: string): Response {
    const ids: Record<string, string> = { project }
    if (token) ids.tokenHash = hashToken(token)
    if (messageId) ids.messageId = messageId
    return annotateResponse(response, { ids })
  }
}

const jsonName = (name: string) => jsonRes(200, { name })

const tokenStateError = (state: TokenState): string | undefined => {
  if (state === "active") return undefined
  if (state === "sender_mismatch") return "SENDER_ID_MISMATCH"
  return "UNREGISTERED"
}

const notificationOf = (value: unknown): NotificationFields | null => {
  if (!isRecord(value)) return null
  const notification: NotificationFields = {}
  if (typeof value.title === "string") notification.title = value.title
  if (typeof value.body === "string") notification.body = value.body
  const image =
    typeof value.image === "string"
      ? value.image
      : typeof value.imageUrl === "string"
        ? value.imageUrl
        : undefined
  if (image !== undefined) notification.image = image
  return notification
}

const dataOf = (value: unknown): Record<string, string> | null => {
  if (!isRecord(value)) return null
  const data: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") data[key] = entry
  }
  return data
}

const collapseKeyOf = (android: Record<string, unknown> | null): string | null => {
  if (!android) return null
  if (typeof android.collapse_key === "string") return android.collapse_key
  if (typeof android.collapseKey === "string") return android.collapseKey
  return null
}

const ttlOf = (android: Record<string, unknown> | null): string | null => {
  if (!android || android.ttl === undefined) return null
  return typeof android.ttl === "string" ? android.ttl : String(android.ttl)
}

const apnsExpirationOf = (apns: Record<string, unknown> | null): string | null => {
  if (!apns || !isRecord(apns.headers)) return null
  const value = apns.headers["apns-expiration"]
  return typeof value === "string" ? value : null
}

export type { FcmRuntime, FcmRuntimeOptions } from "./runtime.js"
export { createRuntime, FCM_PRESETS } from "./runtime.js"
