import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  IdSequence,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import { digest, Signer } from "./crypto.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { WorkOSRuntime, WorkOSRuntimeOptions } from "./runtime.js"
export { createRuntime, WORKOS_PRESETS } from "./runtime.js"
export const WORKOS_NAMESPACE = "workos"
export type WorkOSUser = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  metadata: Record<string, string>
  email_verified?: boolean
}
export type WorkOSClient = { id: string; secret: string; redirectUris: string[]; userId: string }
export type Membership = {
  userId: string
  organizationId: string
  role: string
  permissions: string[]
}
type Code = {
  clientId: string
  userId: string
  expiresAt: number
  used: boolean
  challenge: string | null
  organizationId: string | null
}
type Session = {
  id: string
  clientId: string
  userId: string
  organizationId: string | null
  revoked: boolean
  expiresAt: number
  /** Started by a PKCE exchange without a client secret; it may refresh without one too. */
  public?: boolean
}
type Refresh = { sessionId: string; used: boolean; expiresAt: number }
export type WorkOSAPIOptions = APIOptions & {
  users?: readonly WorkOSUser[]
  clients?: readonly WorkOSClient[]
  memberships?: readonly Membership[]
  accessTtlMs?: number
  refreshTtlMs?: number
  codeTtlMs?: number
}
export const DEFAULT_USERS: readonly WorkOSUser[] = [
  {
    id: "user_mock",
    email: "synthetic@example.test",
    first_name: "Synthetic",
    last_name: "User",
    metadata: { fixture: "true" },
    email_verified: true,
  },
]
export const DEFAULT_CLIENTS: readonly WorkOSClient[] = [
  {
    id: "client_mock",
    secret: "mock_workos_key",
    redirectUris: ["http://localhost:3000/callback"],
    userId: "user_mock",
  },
]
const fail = (status: number, error: string, error_description: string) =>
  jsonRes(status, { error, error_description })
export class WorkOSAPI implements FetchAPI {
  readonly sqlite
  readonly app
  readonly users: Collection<WorkOSUser>
  readonly clients: Collection<WorkOSClient>
  readonly memberships: Collection<Membership>
  readonly codes: Collection<Code>
  readonly sessions: Collection<Session>
  readonly refreshTokens: Collection<Refresh>
  private readonly initialized: Collection<boolean>
  private readonly ids: IdSequence
  private readonly signer = new Signer()
  private readonly service: Service
  private readonly now: () => number
  constructor(private readonly options: WorkOSAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? WORKOS_NAMESPACE
    this.now = options.now ?? Date.now
    this.users = new Collection(this.sqlite, namespace, "users")
    this.clients = new Collection(this.sqlite, namespace, "clients")
    this.memberships = new Collection(this.sqlite, namespace, "memberships")
    this.codes = new Collection(this.sqlite, namespace, "codes")
    this.sessions = new Collection(this.sqlite, namespace, "sessions")
    this.refreshTokens = new Collection(this.sqlite, namespace, "refreshTokens")
    this.initialized = new Collection(this.sqlite, namespace, "initialized")
    this.ids = new IdSequence(this.sqlite, namespace, `workos:${namespace}`)
    this.seed()
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { message: "Not Found" }),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        Authorize: (c) => this.authorize(c),
        Authenticate: (c) => this.authenticate(c),
        ListUsers: (c) => this.listUsers(c),
        GetJwks: async (c) =>
          this.clients.has(c.params.clientId ?? "")
            ? jsonRes(200, await this.signer.jwks())
            : fail(404, "not_found", "Client not found"),
      }),
    })
    this.app = this.service.app
  }
  private seed() {
    if (this.initialized.has("seed")) return
    for (const row of this.options.users ?? DEFAULT_USERS) this.users.insert(row.id, row)
    for (const row of this.options.clients ?? DEFAULT_CLIENTS) this.clients.insert(row.id, row)
    for (const row of this.options.memberships ?? [])
      this.memberships.insert(`${row.userId}:${row.organizationId}`, row)
    this.initialized.insert("seed", true)
  }
  fetch(request: Request) {
    this.seed()
    return this.service.fetch(request)
  }
  async reset() {
    await this.service.reset()
    this.seed()
  }
  private async authorize(c: OperationContext) {
    const q = c.url.searchParams
    const client = this.clients.get(q.get("client_id") ?? "")
    const redirect = q.get("redirect_uri") ?? ""
    if (!client?.redirectUris.includes(redirect))
      return fail(400, "invalid_request", "Invalid client or redirect URI")
    if (q.get("response_type") !== "code" || !q.get("provider"))
      return fail(400, "invalid_request", "Expected response_type=code and provider")
    if (q.has("code_challenge") && q.get("code_challenge_method") !== "S256")
      return fail(400, "invalid_request", "Expected S256 challenge")
    const user = this.users.get(client.userId)
    if (!user) return fail(400, "invalid_request", "No configured synthetic user")
    const organizationId = q.get("organization_id")
    if (organizationId && !this.memberships.has(`${user.id}:${organizationId}`))
      return fail(403, "access_denied", "Organization membership required")
    const code = this.ids.next("mock_code")
    this.codes.insert(code, {
      clientId: client.id,
      userId: user.id,
      expiresAt: this.now() + (this.options.codeTtlMs ?? 600_000),
      used: false,
      challenge: q.get("code_challenge"),
      organizationId,
    })
    const target = new URL(redirect)
    target.searchParams.set("code", code)
    if (q.has("state")) target.searchParams.set("state", q.get("state") ?? "")
    return new Response(null, { status: 302, headers: { location: target.toString() } })
  }
  private async authenticate(c: OperationContext) {
    if (c.body.kind !== "json" || bodyIssues(c).length)
      return fail(400, "invalid_request", "Invalid authentication parameters")
    const b = c.body.value as Record<string, unknown>
    const client = this.clients.get(String(b.client_id ?? ""))
    // A public (browser or native) client sends no secret and proves itself with PKCE instead.
    const secretless = b.client_secret === undefined
    if (!client || (!secretless && b.client_secret !== client.secret))
      return fail(401, "invalid_client", "Invalid client credentials")
    let session: Session
    if (b.grant_type === "authorization_code") {
      if (secretless && typeof b.code_verifier !== "string")
        return fail(401, "invalid_client", "Invalid client credentials")
      const codeId = String(b.code ?? "")
      const code = this.codes.get(codeId)
      if (!code || code.used || code.clientId !== client.id || code.expiresAt <= this.now())
        return fail(400, "invalid_grant", "The code is invalid or has expired")
      if (
        (code.challenge || secretless) &&
        (typeof b.code_verifier !== "string" ||
          !code.challenge ||
          (await digest(b.code_verifier)) !== code.challenge)
      )
        return fail(400, "invalid_grant", "Invalid code verifier")
      // PKCE hashing yields; another exchange may have consumed the code meanwhile.
      const latest = this.codes.get(codeId)
      if (!latest || latest.used || latest.expiresAt <= this.now())
        return fail(400, "invalid_grant", "The code is invalid or has expired")
      if (!this.users.has(code.userId)) return fail(400, "invalid_grant", "User unavailable")
      session = {
        id: this.ids.next("session"),
        clientId: client.id,
        userId: code.userId,
        organizationId: code.organizationId,
        revoked: false,
        expiresAt: this.now() + (this.options.refreshTtlMs ?? 30 * 86400_000),
        ...(secretless ? { public: true } : {}),
      }
      this.codes.update(codeId, { ...code, used: true })
      this.sessions.insert(session.id, session)
    } else if (b.grant_type === "refresh_token") {
      const refreshId = String(b.refresh_token ?? "")
      const refresh = this.refreshTokens.get(refreshId)
      const previous = refresh && this.sessions.get(refresh.sessionId)
      if (
        !refresh ||
        refresh.used ||
        refresh.expiresAt <= this.now() ||
        !previous ||
        previous.revoked ||
        previous.expiresAt <= this.now() ||
        previous.clientId !== client.id ||
        !this.users.has(previous.userId)
      )
        return fail(400, "invalid_grant", "The refresh token is invalid or has expired")
      if (secretless && !previous.public)
        return fail(401, "invalid_client", "Invalid client credentials")
      const organizationId =
        typeof b.organization_id === "string" ? b.organization_id : previous.organizationId
      if (organizationId && !this.memberships.has(`${previous.userId}:${organizationId}`))
        return fail(403, "access_denied", "Organization membership required")
      session = { ...previous, organizationId }
      this.refreshTokens.update(refreshId, { ...refresh, used: true })
      this.sessions.update(session.id, session)
    } else return fail(400, "unsupported_grant_type", "Grant type is not supported")
    const refresh = this.ids.next("mock_refresh")
    this.refreshTokens.insert(refresh, {
      sessionId: session.id,
      used: false,
      expiresAt: session.expiresAt,
    })
    const membership = session.organizationId
      ? this.memberships.get(`${session.userId}:${session.organizationId}`)
      : undefined
    const access = await this.signer.sign({
      iss: `${c.url.origin}/user_management/${client.id}`,
      sub: session.userId,
      sid: session.id,
      iat: Math.floor(this.now() / 1000),
      exp: Math.floor((this.now() + (this.options.accessTtlMs ?? 300_000)) / 1000),
      ...(session.organizationId
        ? {
            org_id: session.organizationId,
            role: membership?.role ?? "member",
            permissions: membership?.permissions ?? [],
          }
        : {}),
    })
    const user = this.users.get(session.userId)
    if (!user) return fail(400, "invalid_grant", "User unavailable")
    return annotateResponse(
      jsonRes(200, {
        user: this.user(user),
        access_token: access,
        refresh_token: refresh,
        ...(session.organizationId ? { organization_id: session.organizationId } : {}),
      }),
      { ids: { userId: session.userId, sessionId: session.id } },
    )
  }
  private user(value: WorkOSUser) {
    return {
      object: "user",
      ...value,
      email_verified: value.email_verified ?? true,
      profile_picture_url: null,
      external_id: null,
      last_sign_in_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }
  }
  private listUsers(c: OperationContext) {
    if (!this.clients.list().some((row) => row.value.secret === bearerToken(c.request)))
      return jsonRes(401, { message: "Unauthorized" })
    const q = c.url.searchParams
    const limit = Number(q.get("limit") ?? 10)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return jsonRes(400, { message: "limit must be between 1 and 100" })
    const rows = this.users
      .list({ order: "oldest" })
      .map((row) => row.value)
      .filter((row) => !q.get("email") || row.email === q.get("email"))
    const index = q.get("after") ? rows.findIndex((row) => row.id === q.get("after")) : -1
    if (q.has("after") && index < 0) return jsonRes(400, { message: "Invalid cursor" })
    const page = rows.slice(index + 1, index + 1 + limit)
    return jsonRes(200, {
      object: "list",
      data: page.map((row) => this.user(row)),
      list_metadata: {
        before: index >= 0 ? (page[0]?.id ?? null) : null,
        after: index + 1 + page.length < rows.length ? (page.at(-1)?.id ?? null) : null,
      },
    })
  }
}
