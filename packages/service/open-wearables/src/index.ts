import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type Connection, type Settings, WearablesState } from "./state.js"
import { completionPage, consentPage, html, pairingPage } from "./ui.js"

export { document, supportedOperationIds } from "./generated/openapi.js"
export type { WearablesRuntime, WearablesRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export type { Connection, Provider, Settings, Task, User } from "./state.js"
export const WEARABLES_NAMESPACE = "open-wearables"
export const apiKeyCredential = (request: Request) =>
  request.headers.get("X-Open-Wearables-API-Key")?.trim() || undefined
export type WearablesAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  browserPrefix?: string
}
const queryString = (value: unknown) => {
  if (value === undefined || typeof value === "string") return value
  throw new HttpError(422, { detail: "Expected a single query value" })
}
const unsupported = () =>
  jsonRes(501, {
    detail: {
      code: "mockingbird_unsupported",
      message: "This deployment extension is not modelled. See the Open Wearables emulator README.",
    },
  })
export class WearablesAPI implements FetchAPI {
  readonly state: WearablesState
  private readonly service: Service
  private readonly now: () => number
  private readonly browserPrefix: string
  constructor(options: WearablesAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? WEARABLES_NAMESPACE
    this.now = options.now ?? Date.now
    this.browserPrefix = options.browserPrefix ?? ""
    this.state = new WearablesState(sqlite, namespace, options.settings ?? {})
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      handlers: defineOperations<SupportedOperationId>({
        AuthorizeProvider: (c) =>
          jsonRes(
            200,
            this.authorize(
              c,
              c.params.provider,
              queryString(c.query.user_id),
              queryString(c.query.redirect_uri),
            ),
          ),
        PairUser: (c) => {
          const user = this.user(c.params.user_id)
          const redirect = this.redirectUrl(queryString(c.query.redirect_url))
          const providers = this.state.providers
            .list({ where: (p) => p.is_enabled && p.has_cloud_api })
            .map((row) => row.value)
          return html(pairingPage(providers, user.id, redirect ?? "", this.browserPrefix))
        },
        PairProvider: (c) =>
          new Response(null, {
            status: 303,
            headers: {
              location: this.authorize(
                c,
                c.params.provider,
                c.params.user_id,
                queryString(c.query.redirect_url),
              ).authorization_url,
            },
          }),
        ConsentPage: (c) => {
          const authorization = this.authorization(c.params.state)
          const action = new URL(c.request.url)
          action.pathname = `${this.browserPrefix}${action.pathname}`
          return html(consentPage(this.provider(authorization.provider).name, action.href))
        },
        DecideConsent: (c) => {
          const authorization = this.authorization(c.params.state)
          const form = c.body.kind === "form" ? (c.body.value as Record<string, unknown>) : {}
          if (form.decision !== "allow" && form.decision !== "deny")
            return jsonRes(422, { detail: "Expected allow or deny" })
          this.state.authorizations.update(authorization.id, { ...authorization, used: true })
          if (form.decision === "deny") return html(completionPage(false))
          const provider = this.provider(authorization.provider)
          if (!provider.is_enabled) return jsonRes(409, { detail: "Provider is disabled" })
          this.seedConnection(authorization.userId, authorization.provider)
          return authorization.redirectUrl
            ? new Response(null, { status: 303, headers: { location: authorization.redirectUrl } })
            : html(completionPage(true))
        },
        ListProviders: (c) =>
          jsonRes(
            200,
            this.state.providers
              .list({
                order: "oldest",
                where: (p) =>
                  (c.query.cloud_only !== "true" || p.has_cloud_api) &&
                  (c.query.enabled_only !== "true" || p.is_enabled),
              })
              .map((r) => r.value),
          ),
        CreateUser: (c) => this.createUser(c),
        GetUser: (c) => jsonRes(200, this.user(c.params.user_id)),
        ListConnections: (c) => {
          const user = this.user(c.params.user_id)
          return jsonRes(
            200,
            this.state.connections
              .list({ where: (r) => r.user_id === user.id })
              .map((r) => r.value),
          )
        },
        DisconnectProvider: (c) => {
          const user = this.user(c.params.user_id)
          const provider = this.provider(c.params.provider)
          const connection = this.state.connections.list({
            where: (r) => r.user_id === user.id && r.provider === provider.provider,
          })[0]?.value
          if (!connection) throw new HttpError(404, { detail: "Connection not found" })
          this.state.connections.update(connection.id, { ...connection, status: "revoked" })
          return new Response(null, { status: 204 })
        },
        QueueSync: (c) => this.queueSync(c),
      }),
      before: (c) => {
        this.tick()
        if (new URL(c.request.url).pathname.startsWith("/api/v1/")) {
          const key = apiKeyCredential(c.request)
          if (!key || !this.state.current().apiKeys.includes(key))
            return jsonRes(401, { detail: "Invalid or missing API key" })
        }
        return undefined
      },
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      unsupported: (request) => {
        const key = apiKeyCredential(request)
        if (
          new URL(request.url).pathname.startsWith("/api/v1/") &&
          (!key || !this.state.current().apiKeys.includes(key))
        )
          return jsonRes(401, { detail: "Invalid or missing API key" })
        return unsupported()
      },
      notFound: () => jsonRes(404, { detail: "Not Found" }),
    })
  }
  fetch(request: Request) {
    return this.service.fetch(request)
  }
  async reset() {
    await this.service.reset()
    this.state.init()
  }
  private id(kind: string) {
    const hex = [...this.state.ids.next(kind, 32).slice(kind.length)]
      .map((c) => (c.charCodeAt(0) % 16).toString(16))
      .join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
  }
  user(id: string | undefined) {
    const user = this.state.users.get(id ?? "")
    if (!user) throw new HttpError(404, { detail: "User not found" })
    return user
  }
  provider(id: string | undefined) {
    const provider = this.state.providers.get(id ?? "")
    if (!provider)
      throw new HttpError(422, {
        detail: [{ loc: ["path", "provider"], msg: "Unknown provider", type: "enum" }],
      })
    return provider
  }
  private redirectUrl(value: string | undefined) {
    if (!value) return null
    try {
      const url = new URL(value)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("invalid redirect")
      return url.href
    } catch {
      throw new HttpError(422, {
        detail: "redirect URI must be an HTTP(S) URL without credentials",
      })
    }
  }
  private authorize(
    c: OperationContext,
    providerId: string | undefined,
    userId: string | undefined,
    redirect: string | undefined,
  ) {
    const user = this.user(userId)
    const provider = this.provider(providerId)
    if (!provider.has_cloud_api || !provider.is_enabled)
      throw new HttpError(409, { detail: "Cloud provider is unavailable" })
    const redirectUrl = this.redirectUrl(redirect)
    const state = this.id("authorization")
    this.state.authorizations.insert(state, {
      id: state,
      userId: user.id,
      provider: provider.provider,
      redirectUrl,
      expiresAt: this.now() + 600000,
      used: false,
    })
    return {
      authorization_url: new URL(
        `${this.browserPrefix}/mockingbird/oauth/${encodeURIComponent(state)}`,
        c.request.url,
      ).href,
      state,
    }
  }
  private authorization(state: string | undefined) {
    const found = this.state.authorizations.get(state ?? "")
    if (!found) throw new HttpError(404, { detail: "Authorization not found" })
    if (found.used || found.expiresAt <= this.now())
      throw new HttpError(409, { detail: "Authorization already used or expired" })
    return found
  }
  private body(c: OperationContext): Record<string, unknown> {
    return c.body.kind === "json" &&
      c.body.value !== null &&
      typeof c.body.value === "object" &&
      !Array.isArray(c.body.value)
      ? (c.body.value as Record<string, unknown>)
      : {}
  }
  private createUser(c: OperationContext) {
    const body = this.body(c)
    if (typeof body.external_user_id !== "string" || !body.external_user_id)
      return jsonRes(422, {
        detail: [{ loc: ["body", "external_user_id"], msg: "Field required", type: "missing" }],
      })
    if (
      this.state.users.list({ where: (u) => u.external_user_id === body.external_user_id }).length
    )
      return jsonRes(409, { detail: "User already exists" })
    const user = {
      id: this.id("user"),
      external_user_id: body.external_user_id,
      email: typeof body.email === "string" ? body.email : null,
      created_at: new Date(this.now()).toISOString(),
    }
    this.state.users.insert(user.id, user)
    return jsonRes(201, user)
  }
  seedConnection(userId: string, providerId: string, status: Connection["status"] = "active") {
    this.user(userId)
    this.provider(providerId)
    const existing = this.state.connections.list({
      where: (r) => r.user_id === userId && r.provider === providerId,
    })[0]?.value
    const connection: Connection = {
      id: existing?.id ?? this.id("connection"),
      user_id: userId,
      provider: providerId,
      status,
      provider_user_id: existing?.provider_user_id ?? null,
      created_at: existing?.created_at ?? new Date(this.now()).toISOString(),
      last_synced_at: existing?.last_synced_at ?? null,
    }
    if (existing) this.state.connections.update(existing.id, connection)
    else this.state.connections.insert(connection.id, connection)
    return connection
  }
  private queueSync(c: OperationContext) {
    const user = this.user(c.params.user_id)
    const provider = this.provider(c.params.provider)
    if (
      Object.entries(c.query).some(
        ([key, value]) =>
          !(key === "data_type" && value === "all") && !(key === "async" && value === "true"),
      )
    )
      return unsupported()
    if (
      !this.state.connections.list({
        where: (r) =>
          r.user_id === user.id && r.provider === provider.provider && r.status === "active",
      }).length
    )
      return jsonRes(409, { detail: "Active connection required" })
    const id = this.id("task")
    this.state.tasks.insert(id, {
      id,
      user_id: user.id,
      provider: provider.provider,
      status: "pending",
      created_at_ms: this.now(),
      completed_at_ms: null,
    })
    return jsonRes(200, {
      success: true,
      async: true,
      task_id: id,
      message: `Sync task queued for ${provider.provider}. Check task status for results.`,
    })
  }
  completeTask(id: string) {
    const task = this.state.tasks.get(id)
    if (!task) throw new HttpError(404, { detail: "Task not found" })
    if (task.status === "completed") return task
    const completed = { ...task, status: "completed" as const, completed_at_ms: this.now() }
    this.state.tasks.update(id, completed)
    for (const row of this.state.connections.list({
      where: (c) => c.user_id === task.user_id && c.provider === task.provider,
    }))
      this.state.connections.update(row.id, {
        ...row.value,
        last_synced_at: new Date(this.now()).toISOString(),
      })
    return completed
  }
  tick() {
    const delay = this.state.current().autoCompleteAfterMs
    if (delay === null) return
    for (const row of this.state.tasks.list({
      where: (t) => t.status === "pending" && t.created_at_ms + delay <= this.now(),
    }))
      this.completeTask(row.id)
  }
}
