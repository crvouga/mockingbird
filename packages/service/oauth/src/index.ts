import { type APIOptions, bootSqlite, Collection, seedFrom } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { type BehaviorInput, BehaviorState, type OAuthBehavior } from "./behavior.js"
import { type CredentialOptions, Credentials } from "./credentials.js"
import { halfHash, hash, type Signer, verifyAppleSecret } from "./crypto.js"
import type {
  Account,
  AppleNotificationType,
  Authorization,
  Client,
  Grant,
  GrantView,
  NotificationDelivery,
  Provider,
  RedirectPolicy,
  Token,
} from "./types.js"
import { consentPage, escapeHtml, loginPage, page, redirectPage } from "./ui.js"

export type {
  BehaviorEvent,
  BehaviorInput,
  EdgeCase,
  OAuthBehavior,
  OAuthScenario,
} from "./behavior.js"
export { OAUTH_SCENARIOS } from "./behavior.js"
export type { CredentialOptions, SigningKey } from "./credentials.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { OAuthMount, OAuthMultiRuntime, OAuthMultiRuntimeOptions } from "./multi.js"
export { createMultiRuntime } from "./multi.js"
export type { OAuthRuntime, OAuthRuntimeOptions } from "./runtime.js"
export { createRuntime, OAUTH_PRESETS } from "./runtime.js"
export type {
  Account,
  AppleNotificationType,
  Client,
  GrantView,
  NotificationDelivery,
  Provider,
  RedirectPolicy,
} from "./types.js"

export type OAuthAPIOptions = APIOptions &
  CredentialOptions & {
    /** Browser Fetch forbids Cookie/Set-Cookie; local transports may explicitly remap them. */
    cookieHeaders?: { request: string; response: string }
    provider?: Provider
    /** Public issuer including any mount prefix. Defaults to request origin plus namespace prefix. */
    issuer?: string
    /** Path at which a composed runtime is publicly mounted. */
    mountPath?: string
    adminPrefix?: string
    publicNamespace?: string
    accounts?: Account[]
    clients?: Client[]
    behavior?: BehaviorInput
    /** Replays behavior choices; also credentials when `deterministicCredentials` is set. */
    seed?: number | string
    /** CSP nonce source for callback handoff and form-post responses. Defaults to `crypto.randomUUID`. */
    nonce?: () => string
    /** Outbound delivery of Sign in with Apple server-to-server notifications. Defaults to global `fetch`. */
    webhooks?: { fetch?: (request: Request) => Promise<Response> }
  }
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } })
const fail = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status)
const scopes = (value: string) => new Set(value.split(/\s+/).filter(Boolean))
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254
const WEB_SCHEMES = new Set(["http:", "https:"])
// Browsers apply form-action to the redirect that follows a submit, so interaction pages must
// also allow the client's redirect target or the final hop back to the app is blocked.
const formTarget = (redirectUri: string) => {
  const u = new URL(redirectUri)
  return WEB_SCHEMES.has(u.protocol) ? u.origin : u.protocol
}
const formAction = (redirectUri: string) => `'self' ${formTarget(redirectUri)}`
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])
const FORBIDDEN_REDIRECT_SCHEMES = new Set(["blob:", "data:", "file:", "javascript:", "vbscript:"])
const safeRedirect = (s: string) => {
  try {
    const u = new URL(s)
    return (
      /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) &&
      !FORBIDDEN_REDIRECT_SCHEMES.has(u.protocol.toLowerCase()) &&
      !u.hash &&
      !u.username &&
      !u.password
    )
  } catch {
    return false
  }
}
// Exact registered URIs always match. An opt-in `redirectPolicy` widens that to variants of a
// registered URI (never to arbitrary URIs): same scheme, path and query, with only the loopback
// port (RFC 8252 section 7.3) or the host and port of a listed dev-client scheme free to differ.
const redirectAllowed = (client: Client, redirectUri: string) => {
  if (client.redirectUris.includes(redirectUri)) return true
  const policy = client.redirectPolicy
  if (!policy || !safeRedirect(redirectUri)) return false
  const requested = new URL(redirectUri)
  const schemes = new Set((policy.schemes ?? []).map((s) => s.toLowerCase()))
  const tail = (u: URL) => `${u.pathname}${u.search}`
  return client.redirectUris.some((registered) => {
    const base = new URL(registered)
    if (base.protocol !== requested.protocol || tail(base) !== tail(requested)) return false
    if (schemes.has(base.protocol.toLowerCase())) return true
    return (
      policy.loopbackAnyPort === true &&
      base.protocol === "http:" &&
      LOOPBACK_HOSTS.has(base.hostname) &&
      base.hostname === requested.hostname
    )
  })
}
const validRedirectPolicy = (policy: unknown): policy is RedirectPolicy => {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return false
  const { loopbackAnyPort, schemes, ...rest } = policy as Record<string, unknown>
  return (
    Object.keys(rest).length === 0 &&
    (loopbackAnyPort === undefined || typeof loopbackAnyPort === "boolean") &&
    (schemes === undefined ||
      (Array.isArray(schemes) &&
        schemes.every(
          (s) =>
            typeof s === "string" &&
            /^[a-z][a-z0-9+.-]*:$/i.test(s) &&
            !FORBIDDEN_REDIRECT_SCHEMES.has(s.toLowerCase()) &&
            s.toLowerCase() !== "http:" &&
            s.toLowerCase() !== "https:",
        )))
  )
}

/** Portable OAuth/OIDC provider. State is isolated and included in runtime snapshots. */
export class OAuthAPI {
  readonly accounts: Collection<Account>
  readonly clients: Collection<Client>
  private readonly transactions: Collection<Authorization>
  private readonly codes: Collection<Grant>
  private readonly tokens: Collection<Token>
  private readonly sessions: Collection<{ accountId: string; expires: number; authTime: number }>
  private readonly consents: Collection<{ scope: string }>
  private signer: Signer
  private readonly credentials: Credentials
  private previousSigners: Signer[] = []
  /** Never published: signs ID tokens for `tokens.idTokenSigningKey: "unpublished"`. */
  private unpublishedSigner: Signer | undefined
  readonly behavior: BehaviorState
  private readonly identities: Collection<Grant["identity"]>
  private readonly appleDisclosures: Collection<{ disclosed: boolean }>
  private readonly refreshIssued: Collection<{ issued: boolean }>
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  readonly provider: Provider
  constructor(private readonly options: OAuthAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? "oauth"
    this.now = options.now ?? Date.now
    this.provider = options.provider ?? "oidc"
    if (options.issuer) {
      const url = new URL(options.issuer)
      if (!safeRedirect(options.issuer) || url.search)
        throw new Error("issuer must be an HTTP(S) URL without query or fragment")
    }
    this.accounts = new Collection(this.sqlite, this.namespace, "accounts")
    this.clients = new Collection(this.sqlite, this.namespace, "clients")
    this.transactions = new Collection(this.sqlite, this.namespace, "transactions")
    this.codes = new Collection(this.sqlite, this.namespace, "codes")
    this.tokens = new Collection(this.sqlite, this.namespace, "tokens")
    this.sessions = new Collection(this.sqlite, this.namespace, "sessions")
    this.consents = new Collection(this.sqlite, this.namespace, "consents")
    this.identities = new Collection(this.sqlite, this.namespace, "identities")
    this.appleDisclosures = new Collection(this.sqlite, this.namespace, "apple_disclosures")
    this.refreshIssued = new Collection(this.sqlite, this.namespace, "refresh_issued")
    this.behavior = new BehaviorState(
      this.sqlite,
      this.namespace,
      options.seed ?? 0,
      options.behavior ?? {},
    )
    this.credentials = new Credentials(this.sqlite, this.namespace, options.seed, options)
    this.signer = this.credentials.signer()
    this.seed()
  }
  private seed() {
    for (const client of this.options.clients ?? []) this.registerClient(client)
    for (const account of this.options.accounts ?? []) this.seedAccount(account)
  }
  seedAccount(account: Account): Account {
    if (
      !account ||
      typeof account.id !== "string" ||
      !account.id ||
      typeof account.name !== "string" ||
      !account.name.trim() ||
      typeof account.email !== "string" ||
      !validEmail(account.email)
    )
      throw new Error("Account requires id, name and a valid email")
    const email = account.email.toLowerCase().trim()
    if (this.accounts.list().some((a) => a.value.email === email && a.id !== account.id))
      throw new Error("An account with this email already exists")
    if (
      account.relayEmail !== undefined &&
      (typeof account.relayEmail !== "string" ||
        !/^[a-zA-Z0-9._-]+@privaterelay\.appleid\.com$/.test(account.relayEmail))
    )
      throw new Error("relayEmail must be an Apple private relay address")
    if (account.realUserStatus !== undefined && ![0, 1, 2].includes(account.realUserStatus))
      throw new Error("realUserStatus must be 0, 1 or 2")
    if (
      account.transferSub !== undefined &&
      (typeof account.transferSub !== "string" || !account.transferSub)
    )
      throw new Error("transferSub must be a nonempty string")
    if (
      account.github &&
      (!Number.isSafeInteger(account.github.id) ||
        account.github.id < 1 ||
        typeof account.github.login !== "string" ||
        !account.github.login)
    )
      throw new Error("GitHub account requires a positive integer id and login")
    if (
      account.github?.emails &&
      (!Array.isArray(account.github.emails) ||
        account.github.emails.some(
          (e) =>
            !e ||
            typeof e.email !== "string" ||
            !validEmail(e.email) ||
            typeof e.primary !== "boolean" ||
            typeof e.verified !== "boolean" ||
            !["public", "private", null].includes(e.visibility),
        ))
    )
      throw new Error("Invalid GitHub email records")
    const value = { ...account, email }
    this.accounts.insert(account.id, value)
    return value
  }
  registerClient(client: Client): Client {
    if (
      !client ||
      typeof client.id !== "string" ||
      !client.id ||
      typeof client.name !== "string" ||
      !client.name ||
      !Array.isArray(client.redirectUris) ||
      !client.redirectUris.length ||
      !client.redirectUris.every((s) => typeof s === "string" && safeRedirect(s))
    )
      throw new Error(
        "Client requires id, name and exact safe redirectUris without fragments or credentials",
      )
    if (client.redirectPolicy !== undefined && !validRedirectPolicy(client.redirectPolicy))
      throw new Error(
        "redirectPolicy accepts loopbackAnyPort (boolean) and schemes (custom schemes such as exp:, never http: or https:)",
      )
    if (
      client.pkceOptional !== undefined &&
      (typeof client.pkceOptional !== "boolean" ||
        (client.pkceOptional &&
          (client.requirePkce === true || client.secret !== undefined || client.apple)))
    )
      throw new Error(
        "pkceOptional is a boolean for public clients: it conflicts with requirePkce, secret and apple",
      )
    if (
      client.alwaysIssueRefreshToken !== undefined &&
      (typeof client.alwaysIssueRefreshToken !== "boolean" ||
        (client.alwaysIssueRefreshToken && ["google", "apple", "github"].includes(this.provider)))
    )
      throw new Error(
        "alwaysIssueRefreshToken is a boolean for the oidc and microsoft profiles; google, apple and github keep their own refresh rules",
      )
    if (
      client.apple &&
      (client.secret !== undefined ||
        !client.apple.teamId ||
        !client.apple.keyId ||
        client.apple.publicKey?.kty !== "EC" ||
        client.apple.publicKey.crv !== "P-256" ||
        client.apple.publicKey.d)
    )
      throw new Error(
        "Apple client requires teamId, keyId and a public P-256 JWK, without a static secret",
      )
    if (
      client.apple?.notificationUrl !== undefined &&
      !(
        typeof client.apple.notificationUrl === "string" &&
        safeRedirect(client.apple.notificationUrl) &&
        WEB_SCHEMES.has(new URL(client.apple.notificationUrl).protocol)
      )
    )
      throw new Error(
        "apple.notificationUrl must be an HTTP(S) URL without fragment or credentials",
      )
    this.clients.insert(client.id, structuredClone(client))
    return client
  }
  async reset(): Promise<void> {
    clearNamespace(this.sqlite, this.namespace)
    this.behavior.configure(this.options.behavior ?? {})
    if (this.options.deterministicCredentials || this.options.signingKeys) {
      this.credentials.restart()
      this.previousSigners = []
      this.unpublishedSigner = undefined
      this.signer = this.credentials.signer()
    }
    this.seed()
  }
  issuer(request: Request): string {
    const prefix =
      this.options.publicNamespace && this.options.publicNamespace !== "default"
        ? `${this.options.adminPrefix ?? "/__admin"}/ns/${encodeURIComponent(this.options.publicNamespace)}`
        : ""
    return (
      this.options.issuer ??
      `${new URL(request.url).origin}${prefix}${this.options.mountPath ?? ""}`
    ).replace(/\/$/, "")
  }
  configureBehavior(input: BehaviorInput): OAuthBehavior {
    return this.behavior.configure(input)
  }
  rotateSigningKey(retainPrevious = true): { kid: string } {
    this.previousSigners = retainPrevious ? [this.signer, ...this.previousSigners].slice(0, 4) : []
    this.signer = this.credentials.signer()
    return { kid: this.signer.kid }
  }
  /**
   * Withdraws one client's consent. When the client registered `apple.notificationUrl` and held
   * the consent, Apple's `consent-revoked` notification is delivered before this resolves.
   */
  async revokeConsent(
    clientId: string,
    accountId: string,
    issuer?: string,
  ): Promise<NotificationDelivery[]> {
    const targets = this.notifiable(accountId).filter((t) => t.client.id === clientId)
    this.forget(clientId, accountId)
    return this.notify(targets, "consent-revoked", issuer)
  }
  /**
   * Deletes an account with its grants and sessions, after telling every client that held a
   * consent (`account-delete`).
   */
  async deleteAccount(accountId: string, issuer?: string): Promise<NotificationDelivery[]> {
    if (!this.accounts.has(accountId)) throw new Error("Unknown account")
    const targets = this.notifiable(accountId)
    for (const { value: client } of this.clients.list()) this.forget(client.id, accountId)
    for (const row of this.codes.list({ where: (c) => c.accountId === accountId }))
      this.codes.delete(row.id)
    for (const row of this.tokens.list({ where: (t) => t.accountId === accountId }))
      this.tokens.delete(row.id)
    for (const row of this.transactions.list({ where: (t) => t.accountId === accountId }))
      this.transactions.delete(row.id)
    for (const row of this.sessions.list({ where: (s) => s.accountId === accountId }))
      this.sessions.delete(row.id)
    this.accounts.delete(accountId)
    return this.notify(targets, "account-delete", issuer)
  }
  /**
   * Tells every client whose identity for the account is a private relay address that the user
   * turned forwarding off (`email-disabled`) or on (`email-enabled`).
   */
  async setRelayForwarding(
    accountId: string,
    forwarding: boolean,
    issuer?: string,
  ): Promise<NotificationDelivery[]> {
    if (!this.accounts.has(accountId)) throw new Error("Unknown account")
    return this.notify(
      this.notifiable(accountId).filter((t) => t.relay),
      forwarding ? "email-enabled" : "email-disabled",
      issuer,
      true,
    )
  }
  /** Clients with a notification endpoint that hold a consent for the account. */
  private notifiable(accountId: string) {
    return this.clients.list({ order: "oldest" }).flatMap(({ value: client }) => {
      const identity = this.identities.get(this.identityKey(client, accountId))
      return client.apple?.notificationUrl &&
        identity &&
        this.consents.has(JSON.stringify([client.id, accountId]))
        ? [{ client, sub: identity.sub, email: identity.email, relay: identity.privateEmail }]
        : []
    })
  }
  private async notify(
    targets: { client: Client; sub: string; email: string }[],
    type: AppleNotificationType,
    issuer: string | undefined,
    withEmail = false,
  ): Promise<NotificationDelivery[]> {
    if (!targets.length) return []
    const iss = issuer ?? this.options.issuer
    if (!iss) throw new Error("A notification needs the issuer option or an issuer argument")
    const send = this.options.webhooks?.fetch ?? ((r: Request) => fetch(r))
    const deliveries: NotificationDelivery[] = []
    for (const { client, sub, email } of targets) {
      const payload = await this.signer.sign({
        iss: iss.replace(/\/$/, ""),
        aud: client.id,
        iat: Math.floor(this.now() / 1000),
        jti: this.credentials.token(),
        events: JSON.stringify({
          type,
          sub,
          ...(withEmail ? { email, is_private_email: "true" } : {}),
          event_time: this.now(),
        }),
      })
      try {
        const response = await send(
          new Request(client.apple?.notificationUrl ?? "", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payload }),
          }),
        )
        deliveries.push({
          clientId: client.id,
          type,
          delivered: response.ok,
          status: response.status,
        })
      } catch (error) {
        deliveries.push({ clientId: client.id, type, delivered: false, error: String(error) })
      }
    }
    return deliveries
  }
  /** Drops one client's grant for an account: consent, identity, first-use disclosure, codes, tokens. */
  private forget(clientId: string, accountId: string): void {
    const key = JSON.stringify([clientId, accountId])
    this.consents.delete(key)
    this.refreshIssued.delete(key)
    const client = this.clients.get(clientId)
    if (client) {
      this.identities.delete(this.identityKey(client, accountId))
      this.appleDisclosures.delete(this.identityKey(client, accountId))
    }
    for (const row of this.codes.list({
      where: (c) => c.clientId === clientId && c.accountId === accountId,
    }))
      this.codes.delete(row.id)
    for (const row of this.tokens.list({
      where: (t) => t.clientId === clientId && t.accountId === accountId,
    }))
      this.tokens.delete(row.id)
  }
  /**
   * What `clientId` sees for `accountId` (a test control mirroring private provider state), or
   * `null` for an unknown client or account. For a client that never authorized the account,
   * `subject` is the id token `sub` it would receive and `email` the real address.
   */
  async grant(clientId: string, accountId: string): Promise<GrantView | null> {
    const client = this.clients.get(clientId)
    const account = this.accounts.get(accountId)
    if (!client || !account) return null
    const key = this.identityKey(client, account.id)
    const identity = this.identities.get(key)
    const consent = this.consents.get(JSON.stringify([clientId, accountId]))
    return {
      subject:
        identity?.sub ??
        (this.provider === "apple" || this.provider === "microsoft" ? await hash(key) : account.id),
      granted: consent !== undefined,
      scopes: [...scopes(consent?.scope ?? "")],
      emailChoice:
        this.provider === "apple" && identity ? (identity.privateEmail ? "hide" : "share") : null,
      email: identity?.email ?? account.email,
      isPrivateEmail: identity?.privateEmail ?? false,
      userDisclosed: this.appleDisclosures.has(key),
    }
  }
  /** The grant view of every account that has authorized `clientId`, oldest account first. */
  async grants(clientId: string): Promise<(GrantView & { accountId: string })[] | null> {
    if (!this.clients.has(clientId)) return null
    const rows: (GrantView & { accountId: string })[] = []
    for (const { id, value } of this.accounts.list({ order: "oldest" })) {
      if (!this.consents.has(JSON.stringify([clientId, id]))) continue
      const view = await this.grant(clientId, value.id)
      if (view) rows.push({ accountId: value.id, ...view })
    }
    return rows
  }
  private paths() {
    const paths = {
      google: {
        authorize: "/o/oauth2/v2/auth",
        token: "/token",
        jwks: "/oauth2/v3/certs",
        userinfo: "/v1/userinfo",
        revoke: "/revoke",
      },
      apple: {
        authorize: "/auth/authorize",
        token: "/auth/token",
        jwks: "/auth/keys",
        userinfo: "/userinfo",
        revoke: "/auth/revoke",
      },
      microsoft: {
        authorize: "/oauth2/v2.0/authorize",
        token: "/oauth2/v2.0/token",
        jwks: "/discovery/v2.0/keys",
        userinfo: "/oidc/userinfo",
        revoke: "/revoke",
      },
      github: {
        authorize: "/login/oauth/authorize",
        token: "/login/oauth/access_token",
        jwks: "/jwks",
        userinfo: "/user",
        revoke: "/revoke",
      },
      oidc: {
        authorize: "/authorize",
        token: "/token",
        jwks: "/jwks",
        userinfo: "/userinfo",
        revoke: "/revoke",
      },
    }
    return paths[this.provider]
  }
  private supportedScopes(): string[] {
    const base =
      this.provider === "apple"
        ? ["openid", "email", "name"]
        : this.provider === "github"
          ? ["read:user", "user:email", "user"]
          : [
              "openid",
              "email",
              "profile",
              ...(this.provider !== "google" ? ["offline_access"] : []),
              ...(this.provider === "microsoft" ? ["User.Read"] : []),
            ]
    return [
      ...new Set([
        ...base,
        ...(this.provider === "google"
          ? [
              "https://www.googleapis.com/auth/userinfo.email",
              "https://www.googleapis.com/auth/userinfo.profile",
            ]
          : []),
        ...(this.behavior.config.additionalScopes ?? []),
      ]),
    ]
  }
  private identityKey(client: Client, accountId: string): string {
    return JSON.stringify([
      this.provider,
      client.subjectGroup ?? client.apple?.teamId ?? client.id,
      accountId,
    ])
  }
  private async identity(account: Account, auth: Authorization): Promise<Grant["identity"]> {
    const client = this.clients.get(auth.clientId)
    if (!client) throw new Error("Client no longer exists")
    const key = this.identityKey(client, account.id)
    const previous = this.identities.get(key)
    const digest = await hash(key)
    // Recheck after hashing so concurrent first authorizations agree on the privacy choice.
    const existing = this.identities.get(key) ?? previous
    const hide =
      existing?.privateEmail ??
      (auth.emailChoice
        ? auth.emailChoice === "hide"
        : (account.privateEmail ??
          (this.behavior.config.apple?.emailMode === "hide" ||
            ((this.behavior.config.apple?.emailMode ?? "choose") === "choose" &&
              auth.decisions.hideEmail))))
    const identity = {
      sub: this.provider === "apple" || this.provider === "microsoft" ? digest : account.id,
      email:
        this.provider === "apple" && hide
          ? (existing?.email ??
            account.relayEmail ??
            `${digest.slice(0, 20).toLowerCase()}@privaterelay.appleid.com`)
          : account.email,
      privateEmail: this.provider === "apple" && hide,
    }
    this.identities.insert(key, identity)
    return identity
  }
  private profile(account: Account, grant: Grant): Record<string, unknown> {
    const requested = scopes(grant.scope)
    if (requested.has("https://www.googleapis.com/auth/userinfo.email")) requested.add("email")
    if (requested.has("https://www.googleapis.com/auth/userinfo.profile")) requested.add("profile")
    const omitEmail = grant.decisions.omitEmail || account.omitEmail
    const omitName = grant.decisions.omitName || account.omitName
    const claims: Record<string, unknown> = { sub: grant.identity.sub }
    if (requested.has("email") && !omitEmail)
      Object.assign(claims, {
        email: grant.identity.privateEmail ? grant.identity.email : account.email,
        ...(this.provider !== "microsoft"
          ? {
              email_verified:
                this.provider === "apple" && this.behavior.config.apple?.booleanClaims !== "boolean"
                  ? String(!grant.decisions.unverifiedEmail && (account.emailVerified ?? true))
                  : !grant.decisions.unverifiedEmail && (account.emailVerified ?? true),
            }
          : {}),
      })
    if (this.provider !== "apple" && requested.has("profile"))
      Object.assign(claims, {
        ...(!omitName
          ? {
              name: account.name,
              given_name: account.givenName ?? account.name.split(" ")[0],
              family_name: account.familyName ?? account.name.split(" ").slice(1).join(" "),
            }
          : {}),
        ...(account.picture ? { picture: account.picture } : {}),
        locale: account.locale ?? "en",
      })
    if (this.provider === "google" && account.hostedDomain) claims.hd = account.hostedDomain
    if (this.provider === "apple") {
      if (requested.has("email") && !omitEmail)
        claims.is_private_email =
          this.behavior.config.apple?.booleanClaims === "boolean"
            ? grant.identity.privateEmail
            : String(grant.identity.privateEmail)
      if (account.realUserStatus !== undefined) claims.real_user_status = account.realUserStatus
      if (account.transferSub) claims.transfer_sub = account.transferSub
    }
    if (this.provider === "microsoft" && requested.has("profile"))
      Object.assign(claims, {
        ver: "2.0",
        oid: account.objectId ?? account.id,
        tid: account.tenantId ?? "9188040d-6c67-4c5b-b112-36a304b66dad",
        preferred_username: account.preferredUsername ?? account.email,
      })
    return claims
  }
  private async idToken(grant: Grant, issuer: string, extra: Record<string, unknown> = {}) {
    const account = this.accounts.get(grant.accountId)
    if (!account) throw new Error("Account no longer exists")
    const tokens = this.behavior.config.tokens
    const skew = tokens?.idTokenClockSkewSeconds ?? 0
    const iat = Math.floor(this.now() / 1000) + skew
    const unpublished = tokens?.idTokenSigningKey === "unpublished"
    if (unpublished) this.unpublishedSigner ??= this.credentials.unpublishedSigner()
    return ((unpublished && this.unpublishedSigner) || this.signer).sign({
      ...this.profile(account, grant),
      iss: issuer,
      aud: grant.clientId,
      iat,
      exp: iat + (tokens?.accessTtlSeconds ?? 3600),
      auth_time: Math.floor(grant.authTime / 1000) + skew,
      ...(grant.nonce ? { nonce: grant.nonce } : {}),
      ...extra,
    })
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const issuer = this.issuer(request)
    const mount = new URL(issuer).pathname.replace(/\/$/, "")
    const path =
      mount && url.pathname.startsWith(`${mount}/`)
        ? url.pathname.slice(mount.length)
        : url.pathname
    const paths = this.paths()
    // Browser clients (SPA + PKCE) call these directly, so they answer CORS like real providers.
    const cors = [
      "/.well-known/openid-configuration",
      paths.jwks,
      "/jwks",
      paths.token,
      "/token",
      paths.userinfo,
      "/userinfo",
      "/oauth2/v3/userinfo",
      "/user/emails",
      paths.revoke,
      "/revoke",
    ].includes(path)
    if (!cors) return this.route(request, url, issuer, path)
    const origin = request.headers.get("origin")
    const response =
      request.method === "OPTIONS"
        ? new Response(null, {
            status: 204,
            headers: {
              "access-control-allow-methods": "GET, POST, OPTIONS",
              "access-control-allow-headers":
                request.headers.get("access-control-request-headers") ??
                "authorization, content-type",
              "access-control-max-age": "600",
            },
          })
        : await this.route(request, url, issuer, path)
    if (origin) {
      response.headers.set("access-control-allow-origin", origin)
      response.headers.set("access-control-expose-headers", "www-authenticate")
      response.headers.append("vary", "Origin")
    }
    return response
  }
  private async route(request: Request, url: URL, issuer: string, path: string): Promise<Response> {
    const paths = this.paths()
    if (
      request.method === "GET" &&
      path === "/.well-known/openid-configuration" &&
      this.provider !== "github"
    )
      return json({
        issuer,
        authorization_endpoint: issuer + paths.authorize,
        token_endpoint: issuer + paths.token,
        jwks_uri: issuer + paths.jwks,
        ...(this.provider !== "apple" ? { userinfo_endpoint: issuer + paths.userinfo } : {}),
        ...(this.provider !== "microsoft" ? { revocation_endpoint: issuer + paths.revoke } : {}),
        response_types_supported: this.provider === "apple" ? ["code", "code id_token"] : ["code"],
        response_modes_supported: ["query", "form_post", "fragment"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        subject_types_supported: [
          this.provider === "apple" || this.provider === "microsoft" ? "pairwise" : "public",
        ],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported:
          this.provider === "apple"
            ? ["client_secret_post"]
            : this.provider === "oidc"
              ? ["client_secret_post", "client_secret_basic", "none"]
              : ["client_secret_post", "client_secret_basic"],
        ...(this.provider !== "apple" ? { code_challenge_methods_supported: ["S256"] } : {}),
        scopes_supported: this.supportedScopes(),
        claims_supported:
          this.provider === "apple"
            ? [
                "aud",
                "email",
                "email_verified",
                "exp",
                "iat",
                "is_private_email",
                "iss",
                "nonce",
                "real_user_status",
                "sub",
                "transfer_sub",
              ]
            : this.provider === "microsoft"
              ? [
                  "aud",
                  "auth_time",
                  "email",
                  "exp",
                  "family_name",
                  "given_name",
                  "iat",
                  "iss",
                  "name",
                  "nonce",
                  "oid",
                  "preferred_username",
                  "sub",
                  "tid",
                  "ver",
                ]
              : [
                  "aud",
                  "auth_time",
                  "email",
                  "email_verified",
                  "exp",
                  "family_name",
                  "given_name",
                  "iat",
                  "iss",
                  "locale",
                  "name",
                  "nonce",
                  "picture",
                  "sub",
                  ...(this.provider === "google" ? ["hd"] : []),
                ],
      })
    if (request.method === "GET" && [paths.jwks, "/jwks"].includes(path))
      return json({
        keys: (
          await Promise.all([this.signer, ...this.previousSigners].map((s) => s.jwks()))
        ).flatMap((j) => j.keys),
      })
    if (
      request.method === "GET" &&
      [
        paths.authorize,
        "/authorize",
        ...(this.provider === "google" ? ["/o/oauth2/auth"] : []),
      ].includes(path)
    )
      return this.authorize(request, url.searchParams, issuer)
    if (path === "/interaction" && ["GET", "POST"].includes(request.method))
      return this.interact(request, issuer)
    if (request.method === "POST" && [paths.token, "/token"].includes(path)) {
      const response = await this.token(request, issuer)
      return this.provider === "github" ? this.githubTokenResponse(request, response) : response
    }
    if (
      ["GET", "POST"].includes(request.method) &&
      [
        paths.userinfo,
        "/userinfo",
        ...(this.provider === "google" ? ["/oauth2/v3/userinfo"] : []),
        ...(this.provider === "github" ? ["/user/emails"] : []),
      ].includes(path) &&
      this.provider !== "apple"
    ) {
      const token = this.tokens.get(
        request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
      )
      const account = token && this.accounts.get(token.accountId)
      if (token?.kind !== "access" || token.expires <= this.now() || !account || account.disabled) {
        const res =
          this.provider === "github"
            ? json(
                { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" },
                401,
              )
            : fail("invalid_token", "Invalid or expired access token", 401)
        res.headers.set("www-authenticate", 'Bearer error="invalid_token"')
        return res
      }
      if (this.provider === "github") {
        const granted = scopes(token.scope)
        const scopeHeaders = {
          "x-oauth-scopes": [...granted].sort().join(", "),
          "x-accepted-oauth-scopes": path === "/user/emails" ? "user:email" : "",
        }
        if (path === "/user/emails") {
          if (!granted.has("user:email") && !granted.has("user"))
            return new Response(
              JSON.stringify({ message: "Resource not accessible by integration" }),
              {
                status: 403,
                headers: { "content-type": "application/json", ...scopeHeaders },
              },
            )
          const emails =
            token.decisions.omitEmail || account.omitEmail
              ? []
              : (account.github?.emails ?? [
                  {
                    email: account.email,
                    primary: true,
                    verified: !token.decisions.unverifiedEmail && (account.emailVerified ?? true),
                    visibility: "private",
                  },
                ])
          const response = json(emails)
          for (const [key, value] of Object.entries(scopeHeaders)) response.headers.set(key, value)
          return response
        }
        const response = json({
          login: account.github?.login ?? account.id,
          id: account.github?.id ?? seedFrom(account.id) + 1,
          node_id: btoa(`User:${account.github?.id ?? seedFrom(account.id) + 1}`),
          name: token.decisions.omitName || account.omitName ? null : account.name,
          email:
            token.decisions.omitEmail || account.omitEmail
              ? null
              : (account.github?.publicEmail ?? null),
          avatar_url: account.picture ?? "",
          type: "User",
        })
        for (const [key, value] of Object.entries(scopeHeaders)) response.headers.set(key, value)
        return response
      }
      return json(this.profile(account, token))
    }
    if (request.method === "POST" && [paths.revoke, "/revoke"].includes(path)) {
      const data = await this.form(request)
      if (!data) return fail("invalid_request", "Expected form-encoded body")
      const client = await this.authenticate(request, data)
      if (client instanceof Response) return client
      const token = this.tokens.get(data.get("token") ?? "")
      if (token && token.clientId === client.id)
        for (const row of this.tokens.list({ where: (t) => t.family === token.family }))
          this.tokens.delete(row.id)
      return json({})
    }
    if (request.method === "GET" && path === "/")
      return page(
        "Identity sandbox",
        '<span class="eyebrow">Mockingbird Identity</span><h1 id="title">Make sign-in<br>feel real.</h1><p>Your identity sandbox is ready. Start sign-in from your application to choose an account, create a new identity, and review access.</p><div class="account"><span class="avatar" aria-hidden="true">✓</span><span class="identity"><strong>Ready when you are</strong><small>OAuth 2.0 · OpenID Connect</small></span></div>',
        200,
        undefined,
        this.credentials.nonce(),
      )
    return fail("not_found", "Unknown endpoint", 404)
  }
  private async form(request: Request): Promise<URLSearchParams | undefined> {
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
      return undefined
    const body = await request.text()
    if (body.length > 16384) return undefined
    const params = new URLSearchParams(body)
    if ([...params.keys()].some((k) => params.getAll(k).length !== 1)) return undefined
    return params
  }
  private async authenticate(request: Request, data: URLSearchParams): Promise<Client | Response> {
    let id = data.get("client_id") ?? "",
      secret = data.get("client_secret") ?? ""
    const auth = request.headers.get("authorization")
    if (auth) {
      if (this.provider === "apple")
        return fail("invalid_client", "Apple requires client_secret_post", 401)
      if (!auth.startsWith("Basic ") || data.has("client_secret"))
        return fail("invalid_client", "Invalid client authentication", 401)
      try {
        const decoded = atob(auth.slice(6))
        const colon = decoded.indexOf(":")
        if (colon < 0) throw new Error()
        id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "))
        secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "))
      } catch {
        return fail("invalid_client", "Malformed client authentication", 401)
      }
      if (data.has("client_id") && data.get("client_id") !== id)
        return fail("invalid_client", "Conflicting client identities", 401)
    }
    const client = this.clients.get(id)
    if (
      !client ||
      (client.secret !== undefined && client.secret !== secret) ||
      (client.secret === undefined && !client.apple && secret)
    )
      return fail("invalid_client", "Client authentication failed", 401)
    if (client.apple && !(await verifyAppleSecret(secret, client.id, client.apple, this.now())))
      return fail("invalid_client", "Invalid Apple client-secret JWT", 401)
    return client
  }
  private async authorize(request: Request, p: URLSearchParams, issuer: string): Promise<Response> {
    if ([...p.keys()].some((k) => p.getAll(k).length !== 1))
      return fail("invalid_request", "Duplicate parameters")
    const client = this.clients.get(p.get("client_id") ?? "")
    const redirectUri =
      p.get("redirect_uri") ?? (this.provider === "github" ? (client?.redirectUris[0] ?? "") : "")
    // Never redirect errors until both the client and exact callback are trusted.
    if (!client || !redirectAllowed(client, redirectUri))
      return fail("invalid_request", "Unknown client or redirect_uri mismatch")
    const mode = p.get("response_mode") ?? "query"
    const auth: Authorization = {
      clientId: client.id,
      redirectUri,
      scope:
        p.get("scope") ??
        (this.provider === "github" ? "read:user" : this.provider === "apple" ? "openid" : ""),
      state: p.get("state") ?? "",
      nonce: p.get("nonce") ?? "",
      responseType: p.get("response_type") ?? (this.provider === "github" ? "code" : ""),
      responseMode: ["query", "form_post", "fragment"].includes(mode) ? mode : "query",
      challenge: p.get("code_challenge") ?? "",
      expires: this.now() + 600000,
      offline: p.get("access_type") === "offline",
      forceConsent: scopes(p.get("prompt") ?? "").has("consent"),
      includeGrantedScopes: p.get("include_granted_scopes") === "true",
      decisions: this.behavior.decisions(),
      authTime: this.now(),
    }
    const error = (code: string, message: string) =>
      this.callback(auth, { error: code, error_description: message })
    if (!["query", "form_post", "fragment"].includes(mode))
      return error("invalid_request", "Unsupported response_mode")
    if (
      auth.responseType !== "code" &&
      !(this.provider === "apple" && auth.responseType === "code id_token")
    )
      return error("unsupported_response_type", "Unsupported response_type")
    if (auth.responseType.includes("id_token") && (!auth.nonce || mode === "query"))
      return error("invalid_request", "Hybrid flow requires nonce and form_post or fragment")
    if (this.provider === "apple" && /\b(email|name)\b/.test(auth.scope) && mode !== "form_post")
      return error("invalid_request", "Apple name/email scopes require form_post")
    const supported = this.supportedScopes()
    if (!auth.scope || [...scopes(auth.scope)].some((s) => !supported.includes(s)))
      return error("invalid_scope", "Unsupported scope")
    if (
      (client.requirePkce ||
        (client.secret === undefined && !client.apple && !client.pkceOptional)) &&
      !auth.challenge
    )
      return error("invalid_request", "PKCE is required for this client")
    if (
      auth.challenge &&
      (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(auth.challenge))
    )
      return error("invalid_request", "PKCE requires a valid S256 challenge")
    const prompt = scopes(p.get("prompt") ?? "")
    if (
      [...prompt].some((s) => !["none", "login", "consent", "select_account"].includes(s)) ||
      (prompt.has("none") && prompt.size > 1)
    )
      return error("invalid_request", "Invalid prompt")
    const maxAge = p.get("max_age")
    if (maxAge !== null && !/^\d+$/.test(maxAge)) return error("invalid_request", "Invalid max_age")
    const cookie = request.headers
      .get(this.options.cookieHeaders?.request ?? "cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("mb_session="))
      ?.slice(11)
    const session = cookie ? this.sessions.get(cookie) : undefined
    const account =
      session && session.expires > this.now() ? this.accounts.get(session.accountId) : undefined
    const current =
      this.behavior.config.session?.reuseLastAccount !== false &&
      account &&
      !account.disabled &&
      session &&
      maxAge !== "0" &&
      (maxAge === null || this.now() - session.authTime <= Number(maxAge) * 1000)
        ? account
        : undefined
    const consent = current ? this.consents.get(JSON.stringify([client.id, current.id])) : undefined
    const granted = consent && [...scopes(auth.scope)].every((s) => scopes(consent.scope).has(s))
    if (prompt.has("none")) {
      if (!current || !session) return error("login_required", "An active session is required")
      if (!granted) return error("consent_required", "Consent is required")
      return this.finish({ ...auth, accountId: current.id, authTime: session.authTime }, issuer)
    }
    const id = this.credentials.token()
    if (current && session && !prompt.has("login") && !prompt.has("select_account")) {
      auth.accountId = current.id
      auth.authTime = session.authTime
      if (granted && !prompt.has("consent"))
        return this.finish(auth as Authorization & { accountId: string }, issuer)
    }
    this.transactions.insert(id, auth)
    if (auth.accountId && current) return this.consent(id, client, current, auth, issuer)
    const accounts = this.accounts
      .list({ order: "oldest", where: (a) => !a.disabled })
      .map((a) => a.value)
    const hint = p.get("login_hint")
    if (hint)
      accounts.sort(
        (a, b) =>
          Number(b.email === hint || b.id === hint) - Number(a.email === hint || a.id === hint),
      )
    return loginPage(
      id,
      client.name,
      accounts,
      issuer,
      formAction(auth.redirectUri),
      false,
      "",
      this.credentials.nonce(),
    )
  }
  private consent(
    id: string,
    client: Client,
    account: Account,
    auth: Authorization,
    issuer: string,
  ): Response {
    const existing = this.identities.get(this.identityKey(client, account.id))
    const denied = new Set(this.behavior.config.consent?.deniedScopes ?? [])
    const allowed = [...scopes(auth.scope)].filter((s) => !denied.has(s)).join(" ")
    return consentPage(
      id,
      client.name,
      account,
      allowed,
      issuer,
      formAction(auth.redirectUri),
      this.provider === "apple" && scopes(auth.scope).has("email") && !existing
        ? {
            hideEmail:
              account.privateEmail ??
              (this.behavior.config.apple?.emailMode === "hide" ||
                ((this.behavior.config.apple?.emailMode ?? "choose") === "choose" &&
                  auth.decisions.hideEmail)),
            choice: (this.behavior.config.apple?.emailMode ?? "choose") === "choose",
          }
        : undefined,
      this.credentials.nonce(),
    )
  }
  private async interact(request: Request, issuer: string): Promise<Response> {
    const p =
      request.method === "GET" ? new URL(request.url).searchParams : await this.form(request)
    if (!p) return fail("invalid_request", "Expected form-encoded body")
    if (
      request.method === "POST" &&
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(issuer).origin
    )
      return fail("invalid_request", "Cross-origin interaction rejected", 403)
    const id = p.get("transaction") ?? ""
    const auth = this.transactions.get(id)
    const client = auth && this.clients.get(auth.clientId)
    if (!auth || auth.expires <= this.now() || !client)
      return page(
        "Session expired",
        '<span class="eyebrow">Let’s try again</span><h1 id="title">This sign-in expired</h1><p>Return to your application and start sign-in again.</p>',
        400,
        undefined,
        this.credentials.nonce(),
        "oauth-mock-error",
      )
    const accounts = () =>
      this.accounts.list({ order: "oldest", where: (a) => !a.disabled }).map((a) => a.value)
    if (request.method === "GET")
      return loginPage(
        id,
        client.name,
        accounts(),
        issuer,
        formAction(auth.redirectUri),
        p.get("screen") === "signup",
        "",
        this.credentials.nonce(),
      )
    const action = p.get("action")
    if (action === "deny") {
      this.transactions.delete(id)
      return this.browserHandoff(
        request,
        this.callback(auth, {
          error: "access_denied",
          error_description: "The user denied access",
        }),
      )
    }
    if (action === "signup") {
      const email = (p.get("email") ?? "").trim().toLowerCase(),
        name = (p.get("name") ?? "").trim()
      if (!validEmail(email) || !name || name.length > 120)
        return loginPage(
          id,
          client.name,
          [],
          issuer,
          formAction(auth.redirectUri),
          true,
          "Enter a full name and a valid email address.",
          this.credentials.nonce(),
        )
      if (
        accounts().some((a) => a.email === email) ||
        this.accounts.list().some((a) => a.value.email === email)
      )
        return loginPage(
          id,
          client.name,
          [],
          issuer,
          formAction(auth.redirectUri),
          true,
          "This email already has an account. Go back to choose it.",
          this.credentials.nonce(),
        )
      const account = this.seedAccount({
        id: this.credentials.token(),
        email,
        name,
        emailVerified: true,
      })
      auth.accountId = account.id
      auth.authTime = this.now()
      this.transactions.update(id, auth)
      return this.consent(id, client, account, auth, issuer)
    }
    if (action === "select") {
      const account = this.accounts.get(p.get("account") ?? "")
      if (!account || account.disabled)
        return loginPage(
          id,
          client.name,
          accounts(),
          issuer,
          formAction(auth.redirectUri),
          false,
          "Choose an available account.",
          this.credentials.nonce(),
        )
      auth.accountId = account.id
      auth.authTime = this.now()
      // Google skips the consent card once this account already granted every requested scope to
      // the client; only prompt=consent or a new scope asks again.
      const granted = this.consents.get(JSON.stringify([client.id, account.id]))
      if (
        this.provider === "google" &&
        !auth.forceConsent &&
        granted &&
        [...scopes(auth.scope)].every((s) => scopes(granted.scope).has(s))
      ) {
        this.transactions.delete(id)
        return this.startSession(
          this.browserHandoff(
            request,
            await this.finish(auth as Authorization & { accountId: string }, issuer),
          ),
          account.id,
          auth.authTime,
          issuer,
        )
      }
      this.transactions.update(id, auth)
      return this.consent(id, client, account, auth, issuer)
    }
    if (action === "allow" && auth.accountId) {
      const account = this.accounts.get(auth.accountId)
      if (!account || account.disabled) return fail("access_denied", "Account is unavailable")
      const choice = p.get("email_choice")
      if (choice !== null && choice !== "hide" && choice !== "share")
        return fail("invalid_request", "Invalid email choice")
      if (
        choice &&
        this.provider === "apple" &&
        (this.behavior.config.apple?.emailMode ?? "choose") === "choose" &&
        !this.identities.has(this.identityKey(client, account.id))
      )
        auth.emailChoice = choice
      this.transactions.delete(id)
      return this.startSession(
        this.browserHandoff(
          request,
          await this.finish(auth as Authorization & { accountId: string }, issuer),
        ),
        account.id,
        auth.authTime,
        issuer,
      )
    }
    return fail("invalid_request", "Invalid interaction action")
  }
  private browserHandoff(request: Request, result: Response): Response {
    const location = result.headers.get("location")
    if (
      request.headers.get("sec-fetch-mode")?.toLowerCase() !== "navigate" ||
      !location ||
      result.status < 300 ||
      result.status >= 400
    )
      return result
    return redirectPage(location, this.options.nonce?.() ?? this.credentials.nonce())
  }
  private startSession(
    result: Response,
    accountId: string,
    authTime: number,
    issuer: string,
  ): Response {
    const session = this.credentials.token()
    this.sessions.insert(session, { accountId, authTime, expires: this.now() + 86400000 })
    result.headers.append(
      this.options.cookieHeaders?.response ?? "set-cookie",
      `mb_session=${session}; Path=${new URL(issuer).pathname.replace(/\/$/, "") || "/"}; HttpOnly; SameSite=Lax; Max-Age=86400${issuer.startsWith("https:") ? "; Secure" : ""}`,
    )
    return result
  }
  private async finish(
    auth: Authorization & { accountId: string },
    issuer: string,
  ): Promise<Response> {
    const behavior = this.behavior.config
    if (auth.decisions.denyConsent || behavior.consent?.error)
      return this.callback(auth, {
        error: behavior.consent?.error ?? "access_denied",
        error_description: "The authorization request was declined",
      })
    const account = this.accounts.get(auth.accountId)
    if (!account || account.disabled)
      return this.callback(auth, {
        error: "access_denied",
        error_description: "Account is unavailable",
      })
    const identity = await this.identity(account, auth)
    const key = JSON.stringify([auth.clientId, auth.accountId])
    const previous = this.consents.get(key)
    const denied = new Set(behavior.consent?.deniedScopes ?? [])
    const scope = [
      ...scopes(
        `${this.provider === "google" && auth.includeGrantedScopes ? (previous?.scope ?? "") : ""} ${auth.scope}`,
      ),
    ]
      .filter((s) => !denied.has(s))
      .join(" ")
    if (!scope || (scopes(auth.scope).has("openid") && !scopes(scope).has("openid")))
      return this.callback(auth, {
        error: "access_denied",
        error_description: "Required identity scope was declined",
      })
    const googleRefresh = behavior.google?.refreshToken ?? "first-consent"
    const issueRefresh =
      this.clients.get(auth.clientId)?.alwaysIssueRefreshToken === true ||
      (this.provider === "google"
        ? auth.offline &&
          googleRefresh !== "never" &&
          (googleRefresh === "always" || auth.forceConsent || !previous)
        : this.provider === "apple" || scopes(scope).has("offline_access"))
    const code = this.credentials.token()
    const grant: Grant = {
      ...auth,
      scope,
      identity,
      issueRefresh,
      expires: this.now() + (behavior.tokens?.codeTtlSeconds ?? 300) * 1000,
      family: this.credentials.token(),
    }
    this.codes.insert(code, grant)
    this.consents.insert(key, { scope: [...scopes(`${previous?.scope ?? ""} ${scope}`)].join(" ") })
    const values: Record<string, string> = { code }
    if (this.provider === "google" || this.provider === "github") values.scope = scope
    if (auth.responseType.includes("id_token"))
      values.id_token = await this.idToken(grant, issuer, { c_hash: await halfHash(code) })
    const appleClient = this.clients.get(auth.clientId)
    const appleKey = appleClient ? this.identityKey(appleClient, account.id) : ""
    const disclosed = this.appleDisclosures.has(appleKey)
    if (this.provider === "apple") this.appleDisclosures.insert(appleKey, { disclosed: true })
    if (
      this.provider === "apple" &&
      !disclosed &&
      !behavior.apple?.omitUser &&
      (scopes(scope).has("name") || scopes(scope).has("email"))
    ) {
      values.user = JSON.stringify({
        ...(scopes(scope).has("name") && !auth.decisions.omitName && !account.omitName
          ? {
              name: {
                firstName: account.givenName ?? account.name.split(" ")[0],
                lastName: account.familyName ?? account.name.split(" ").slice(1).join(" "),
              },
            }
          : {}),
        ...(scopes(scope).has("email") && !auth.decisions.omitEmail && !account.omitEmail
          ? { email: identity.email }
          : {}),
      })
    }
    return this.callback(auth, values)
  }
  private callback(auth: Authorization, values: Record<string, string>): Response {
    if (auth.state) values.state = auth.state
    const redirect = new URL(auth.redirectUri)
    if (auth.responseMode === "form_post") {
      const nonce = this.options.nonce?.() ?? this.credentials.nonce()
      const result = page(
        "Continue to your app",
        `<span class="eyebrow">All set</span><h1 id="title">Back to your app</h1><p>Your sign-in response is ready.</p><form id="callback" method="post" action="${escapeHtml(auth.redirectUri)}">${Object.entries(
          values,
        )
          .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
          .join(
            "",
          )}<button class="primary" data-testid="oauth-mock-form-post-continue">Continue</button></form><script nonce="${nonce}">document.getElementById('callback').submit()</script>`,
        200,
        // The callback may answer this POST with a redirect to an origin only it knows (its web
        // app), and form-action would be applied to that hop too. No source list can allow it.
        null,
        nonce,
        "oauth-mock-form-post",
      )
      return result
    }
    let location: string
    if (!WEB_SCHEMES.has(redirect.protocol)) {
      const encoded = new URLSearchParams(values).toString()
      location = `${auth.redirectUri}${auth.responseMode === "fragment" ? "#" : auth.redirectUri.includes("?") ? "&" : "?"}${encoded}`
    } else {
      if (auth.responseMode === "fragment") redirect.hash = new URLSearchParams(values).toString()
      else for (const [k, v] of Object.entries(values)) redirect.searchParams.set(k, v)
      location = redirect.href
    }
    return new Response(null, {
      status: 302,
      headers: {
        location,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    })
  }
  private async githubTokenResponse(request: Request, response: Response): Promise<Response> {
    if (!response.headers.get("content-type")?.includes("application/json")) return response
    const body = (await response.json()) as Record<string, unknown>
    if (body.error === "invalid_client") body.error = "incorrect_client_credentials"
    else if (body.error === "invalid_grant")
      body.error = String(body.error_description).includes("redirect_uri")
        ? "redirect_uri_mismatch"
        : "bad_verification_code"
    if (body.error && response.status < 500)
      body.error_uri = `https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors#${String(body.error).replace(/_/g, "-")}`
    const status = body.error && response.status < 500 ? 200 : response.status
    if (request.headers.get("accept")?.includes("application/json")) return json(body, status)
    return new Response(
      new URLSearchParams(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]))),
      {
        status,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cache-control": "no-store",
          ...(response.headers.has("retry-after")
            ? { "retry-after": response.headers.get("retry-after") ?? "1" }
            : {}),
        },
      },
    )
  }
  private async token(request: Request, issuer: string): Promise<Response> {
    let p: URLSearchParams | undefined
    if (
      this.provider === "github" &&
      request.headers.get("content-type")?.startsWith("application/json")
    ) {
      try {
        const text = await request.text()
        if (text.length <= 16384) {
          const body = JSON.parse(text)
          if (
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            Object.values(body).every((v) => typeof v === "string")
          )
            p = new URLSearchParams(body)
        }
      } catch {
        /* handled below */
      }
    } else p = await this.form(request)
    if (!p)
      return fail("invalid_request", "Expected form-encoded body without duplicate parameters")
    const client = await this.authenticate(request, p)
    if (client instanceof Response) return client
    const type = p.get("grant_type") ?? (this.provider === "github" ? "authorization_code" : null)
    if (type !== "authorization_code" && type !== "refresh_token")
      return fail("unsupported_grant_type", "Unsupported grant_type")
    const key = p.get(type === "authorization_code" ? "code" : "refresh_token") ?? ""
    const stored = type === "authorization_code" ? this.codes.get(key) : this.tokens.get(key)
    const account = stored && this.accounts.get(stored.accountId)
    if (
      !stored ||
      stored.clientId !== client.id ||
      stored.expires <= this.now() ||
      !account ||
      account.disabled ||
      (type === "refresh_token" && (!("kind" in stored) || stored.kind !== "refresh"))
    )
      return fail("invalid_grant", "Invalid, expired or consumed grant")
    if (
      type === "refresh_token" &&
      this.provider === "google" &&
      "lastUsed" in stored &&
      typeof stored.lastUsed === "number"
    ) {
      const inactiveUntil = new Date(stored.lastUsed)
      inactiveUntil.setUTCMonth(inactiveUntil.getUTCMonth() + 6)
      if (this.now() >= inactiveUntil.getTime()) {
        this.tokens.delete(key)
        return fail("invalid_grant", "Refresh token expired after six months of inactivity")
      }
    }
    if (
      this.provider === "github" &&
      (account.emailVerified === false ||
        account.github?.emails?.find((e) => e.primary)?.verified === false ||
        stored.decisions.unverifiedEmail)
    )
      return fail("unverified_user_email", "The user must have a verified primary email.")
    const behavior = this.behavior.config
    const effects = this.behavior.sample("token", ["tokenUnavailable", "invalidGrant"])
    if (effects.tokenUnavailable) {
      const response = fail(
        "temporarily_unavailable",
        "Authorization server temporarily unavailable",
        503,
      )
      response.headers.set("retry-after", "1")
      return response
    }
    if (type === "refresh_token" && (behavior.tokens?.refreshError || effects.invalidGrant)) {
      if (behavior.tokens?.refreshError === "invalid_grant" || effects.invalidGrant)
        for (const row of this.tokens.list({ where: (t) => t.family === stored.family }))
          this.tokens.delete(row.id)
      return json(
        {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
          ...(behavior.tokens?.refreshError === "invalid_rapt"
            ? { error_subtype: "invalid_rapt" }
            : {}),
        },
        400,
      )
    }
    if (effects.invalidGrant) {
      this.codes.delete(key)
      return fail("invalid_grant", "Token has been expired or revoked.")
    }
    if (type === "refresh_token" && "consumed" in stored && stored.consumed) {
      for (const row of this.tokens.list({ where: (t) => t.family === stored.family }))
        this.tokens.delete(row.id)
      return fail("invalid_grant", "Refresh token reuse detected; token family revoked")
    }
    if (type === "authorization_code") {
      if (
        (this.provider !== "github" || p.has("redirect_uri")) &&
        p.get("redirect_uri") !== stored.redirectUri
      )
        return fail("invalid_grant", "redirect_uri mismatch")
      if (stored.challenge) {
        const verifier = p.get("code_verifier") ?? ""
        if (
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          (await hash(verifier)) !== stored.challenge
        )
          return fail("invalid_grant", "PKCE verification failed")
      }
      // Recheck after async hashing: concurrent redemptions may have consumed it.
      if (!this.codes.delete(key))
        return fail("invalid_grant", "Authorization code already consumed")
    }
    const grant = { ...stored }
    if (type === "refresh_token" && p.has("scope")) {
      const requested = p.get("scope") ?? ""
      if ([...scopes(requested)].some((s) => !scopes(stored.scope).has(s)))
        return fail("invalid_scope", "Cannot expand granted scope")
      grant.scope = requested
    }
    if (type === "refresh_token")
      this.tokens.update(key, { ...stored, kind: "refresh", lastUsed: this.now() })
    const accessTtl = behavior.tokens?.accessTtlSeconds ?? 3600
    const access = this.credentials.token()
    const result: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: accessTtl,
      scope: grant.scope,
    }
    if (this.provider === "apple") {
      result.token_type = "bearer"
      delete result.scope
    }
    if (this.provider === "microsoft") result.ext_expires_in = accessTtl
    if (this.provider === "github") {
      delete result.expires_in
      result.token_type = "bearer"
      result.scope = [...scopes(grant.scope)].sort().join(",")
    }
    const rotating = type === "refresh_token" && behavior.tokens?.refreshRotation === "rotate"
    const microsoftRefresh = type === "refresh_token" && this.provider === "microsoft"
    if (rotating) this.tokens.update(key, { ...stored, kind: "refresh", consumed: true })
    this.tokens.insert(access, {
      ...grant,
      expires:
        this.provider === "github" && !behavior.tokens?.accessTtlSeconds
          ? Number.MAX_SAFE_INTEGER
          : this.now() + accessTtl * 1000,
      kind: "access",
      consumed: false,
    })
    const refreshKey = JSON.stringify([grant.clientId, grant.accountId])
    const googleEligible =
      this.provider !== "google" ||
      behavior.google?.refreshToken === "always" ||
      grant.forceConsent ||
      !this.refreshIssued.has(refreshKey)
    if (
      (type === "authorization_code" && grant.issueRefresh && googleEligible) ||
      rotating ||
      microsoftRefresh
    ) {
      const refresh = this.credentials.token()
      const basicScopes = [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ]
      const testingExpiry =
        this.provider === "google" &&
        behavior.google?.testing &&
        [...scopes(grant.scope)].some((s) => !basicScopes.includes(s))
      const refreshTtl =
        behavior.tokens?.refreshTtlSeconds ??
        (testingExpiry ? 604800 : this.provider === "microsoft" ? 7776000 : 2592000)
      const unbounded =
        behavior.tokens?.refreshTtlSeconds === undefined &&
        !testingExpiry &&
        (this.provider === "google" || this.provider === "apple")
      this.tokens.insert(refresh, {
        ...grant,
        expires:
          rotating || microsoftRefresh
            ? stored.expires
            : unbounded
              ? Number.MAX_SAFE_INTEGER
              : this.now() + refreshTtl * 1000,
        lastUsed: this.now(),
        kind: "refresh",
        consumed: false,
      })
      if (this.provider === "google") {
        const outstanding = this.tokens.list({
          order: "oldest",
          where: (t) =>
            t.kind === "refresh" &&
            t.accountId === grant.accountId &&
            t.clientId === grant.clientId,
        })
        for (const row of outstanding.slice(
          0,
          Math.max(0, outstanding.length - (behavior.google?.maxRefreshTokens ?? 100)),
        ))
          this.tokens.delete(row.id)
      }
      this.refreshIssued.insert(refreshKey, { issued: true })
      result.refresh_token = refresh
      if (testingExpiry) result.refresh_token_expires_in = refreshTtl
    }
    if (
      this.provider !== "github" &&
      (scopes(grant.scope).has("openid") || this.provider === "apple")
    )
      result.id_token = await this.idToken(grant, issuer, { at_hash: await halfHash(access) })
    if (this.provider === "github" && !request.headers.get("accept")?.includes("application/json"))
      return new Response(
        new URLSearchParams(
          Object.fromEntries(Object.entries(result).map(([k, v]) => [k, String(v)])),
        ),
        {
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "cache-control": "no-store",
          },
        },
      )
    return json(result)
  }
}
