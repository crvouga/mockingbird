import { createHash, randomBytes } from "node:crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"
import type { Config } from "./config.js"
import { badRequest, HttpError, unauthorized } from "./errors.js"
import { newId, newSecret, sha256 } from "./ids.js"
import type { Database, Row } from "./store/schema.js"

export type Principal =
  | { kind: "user"; user: Row<"users">; via: "session" | "token"; key?: Row<"api_keys"> }
  | { kind: "key"; key: Row<"api_keys"> }

const SESSION_DAYS = 30
const TRANSACTION_MS = 10 * 60 * 1000
const KEY_PATTERN = /^mbf_[uop]_[a-z0-9]{20}_[A-Za-z0-9_-]{43}$/

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")

export const sessionCookieName = (config: Pick<Config, "publicUrl">) =>
  // `__Host-` pins the cookie to this exact host over HTTPS; a sibling subdomain cannot set it.
  config.publicUrl.startsWith("https:") ? "__Host-mbf_session" : "mbf_session"

export function readCookie(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const index = pair.indexOf("=")
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim()
  }
  return undefined
}

function cookie(config: Pick<Config, "publicUrl">, value: string, maxAgeSeconds: number): string {
  const secure = config.publicUrl.startsWith("https:") ? "; Secure" : ""
  return `${sessionCookieName(config)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
}

/** Only same-site paths are valid places to return to after sign-in. */
const safeReturn = (value: string | null) =>
  value && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) ? value : "/"

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

/**
 * Sign-in and credentials. People sign in through an OpenID Connect provider as a public client
 * (authorization code with S256 PKCE, no client secret), the profile the chrisvouga.dev auth relay
 * supports. Sessions and login transactions are rows in the database, so the service holds no
 * signing secret and any replica can finish a login another one started.
 */
export function createAuth(deps: {
  db: Database
  config: Pick<Config, "publicUrl" | "oidc" | "devLogin">
  now?: () => number
  fetch?: typeof fetch
}) {
  const { db, config } = deps
  const now = deps.now ?? Date.now
  const send = deps.fetch ?? fetch
  const iso = (ms: number) => new Date(ms).toISOString()

  let discovery: Promise<Discovery> | undefined
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined
  const discover = async (): Promise<Discovery> => {
    if (!config.oidc) throw new HttpError(404, "not_found", "Sign-in is not configured")
    discovery ??= (async () => {
      const issuer = config.oidc?.issuer.replace(/\/+$/, "")
      const response = await send(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}`)
      const document = (await response.json()) as Discovery & { issuer?: string }
      if (document.issuer !== config.oidc?.issuer) throw new Error("OIDC discovery issuer mismatch")
      return document
    })()
    try {
      return await discovery
    } catch (error) {
      discovery = undefined
      throw new HttpError(503, "identity_provider_unavailable", (error as Error).message)
    }
  }

  const startSession = async (user: Row<"users">) => {
    const token = newSecret()
    await db.removeExpired("sessions", "expires_at", iso(now()))
    await db.insert("sessions", {
      id: newId("ses"),
      token_hash: sha256(token),
      user_id: user.id,
      expires_at: iso(now() + SESSION_DAYS * 86_400_000),
      created_at: iso(now()),
    })
    return cookie(config, token, SESSION_DAYS * 86_400)
  }

  /** People are identified by issuer and subject only; an email never links two accounts. */
  const upsertUser = async (
    issuer: string,
    subject: string,
    profile: { email?: string | undefined; name?: string | undefined },
  ) => {
    const [existing] = await db.find("users", { issuer, subject })
    if (existing) {
      const updated = await db.update("users", existing.id, {
        email: profile.email ?? existing.email,
        name: profile.name ?? existing.name,
      })
      return updated ?? existing
    }
    const user: Row<"users"> = {
      id: newId("usr"),
      issuer,
      subject,
      email: profile.email ?? null,
      name: profile.name ?? null,
      created_at: iso(now()),
    }
    await db.insert("users", user)
    return user
  }

  return {
    /** Resolve the caller from an API key or the session cookie; `undefined` when anonymous. */
    async authenticate(request: Request): Promise<Principal | undefined> {
      const header = request.headers.get("authorization")
      const presented =
        request.headers.get("x-mockingbird-api-key") ??
        (header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined)
      if (presented !== undefined) {
        if (!KEY_PATTERN.test(presented)) throw unauthorized("Malformed API key")
        const [key] = await db.find("api_keys", { key_hash: sha256(presented) })
        if (!key || (key.expires_at && key.expires_at < iso(now())))
          throw unauthorized("Unknown or expired API key")
        if (!key.last_used_at || now() - Date.parse(key.last_used_at) > 60_000)
          await db.update("api_keys", key.id, { last_used_at: iso(now()) })
        if (key.scope !== "user") return { kind: "key", key }
        const user = key.user_id ? await db.get("users", key.user_id) : undefined
        if (!user) throw unauthorized("Unknown or expired API key")
        return { kind: "user", user, via: "token", key }
      }
      const token = readCookie(request, sessionCookieName(config))
      if (!token) return undefined
      const [session] = await db.find("sessions", { token_hash: sha256(token) })
      if (!session || session.expires_at < iso(now())) return undefined
      const user = await db.get("users", session.user_id)
      return user ? { kind: "user", user, via: "session" } : undefined
    },

    /** Mint a key. The secret is returned here and never stored. */
    async createKey(input: {
      scope: "user" | "org" | "project"
      name: string
      createdBy: string
      userId?: string
      orgId?: string
      projectId?: string
      role?: string
      expiresInDays?: number
    }): Promise<{ row: Row<"api_keys">; secret: string }> {
      const id = newId("key")
      const secret = `mbf_${input.scope[0]}_${id.slice(4)}_${newSecret()}`
      const row: Row<"api_keys"> = {
        id,
        scope: input.scope,
        user_id: input.userId ?? null,
        org_id: input.orgId ?? null,
        project_id: input.projectId ?? null,
        role: input.role ?? null,
        name: input.name,
        prefix: secret.slice(0, 14),
        key_hash: sha256(secret),
        created_by: input.createdBy,
        last_used_at: null,
        expires_at: input.expiresInDays ? iso(now() + input.expiresInDays * 86_400_000) : null,
        created_at: iso(now()),
      }
      await db.insert("api_keys", row)
      return { row, secret }
    },

    /** `GET /auth/login`: start an authorization-code flow and redirect to the provider. */
    async login(request: Request): Promise<Response> {
      const oidc = config.oidc
      if (!oidc) throw new HttpError(404, "not_found", "Sign-in is not configured")
      const endpoints = await discover()
      const state = base64url(randomBytes(24))
      const nonce = base64url(randomBytes(24))
      const verifier = base64url(randomBytes(32))
      await db.removeExpired("auth_transactions", "expires_at", iso(now()))
      await db.insert("auth_transactions", {
        id: sha256(state),
        nonce,
        verifier,
        return_to: safeReturn(new URL(request.url).searchParams.get("return_to")),
        expires_at: iso(now() + TRANSACTION_MS),
      })
      const url = new URL(endpoints.authorization_endpoint)
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: oidc.clientId,
        redirect_uri: oidc.redirectUri,
        scope: oidc.scopes,
        state,
        nonce,
        code_challenge: base64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      }).toString()
      return new Response(null, { status: 302, headers: { location: url.toString() } })
    },

    /** `GET /auth/callback`: finish the flow, verify the ID token and start a session. */
    async callback(request: Request): Promise<Response> {
      const oidc = config.oidc
      if (!oidc) throw new HttpError(404, "not_found", "Sign-in is not configured")
      const params = new URL(request.url).searchParams
      const state = params.get("state")
      const code = params.get("code")
      if (!state || !code) throw badRequest(params.get("error") ?? "Sign-in was not completed")
      // Single use: the transaction is deleted before the code is exchanged, never retried.
      const transaction = await db.get("auth_transactions", sha256(state))
      if (!transaction || (await db.remove("auth_transactions", { id: transaction.id })) !== 1)
        throw badRequest("This sign-in link was already used or has expired")
      if (transaction.expires_at < iso(now())) throw badRequest("This sign-in attempt has expired")
      const endpoints = await discover()
      const exchange = await send(endpoints.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: oidc.redirectUri,
          client_id: oidc.clientId,
          code_verifier: transaction.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!exchange.ok) {
        await exchange.body?.cancel()
        throw badRequest("The identity provider rejected the sign-in")
      }
      const { id_token: idToken } = (await exchange.json()) as { id_token?: string }
      if (!idToken) throw badRequest("The identity provider returned no ID token")
      jwks ??= createRemoteJWKSet(new URL(endpoints.jwks_uri))
      let claims: Record<string, unknown>
      try {
        claims = (
          await jwtVerify(idToken, jwks, {
            issuer: oidc.issuer,
            audience: oidc.clientId,
            currentDate: new Date(now()),
          })
        ).payload
      } catch {
        throw badRequest("The identity provider's token could not be verified")
      }
      if (claims.nonce !== transaction.nonce || typeof claims.sub !== "string")
        throw badRequest("The identity provider's token does not belong to this sign-in")
      const user = await upsertUser(oidc.issuer, claims.sub, {
        email: typeof claims.email === "string" ? claims.email : undefined,
        name: typeof claims.name === "string" ? claims.name : undefined,
      })
      return new Response(null, {
        status: 302,
        headers: { location: transaction.return_to, "set-cookie": await startSession(user) },
      })
    },

    /** Loopback development only: sign in as a named local user without an identity provider. */
    async devLogin(email: string): Promise<string> {
      if (!config.devLogin) throw new HttpError(404, "not_found", "Not found")
      return startSession(await upsertUser("dev", email.toLowerCase(), { email, name: email }))
    },

    /** A user who signs in with a personal token instead of an identity provider. */
    localUser: (email: string, name?: string) =>
      upsertUser("local", email.toLowerCase(), { email, name: name ?? email }),

    /** Exchange a personal token for a browser session, so the dashboard works without OIDC. */
    async tokenLogin(token: string): Promise<string> {
      const principal = await this.authenticate(
        new Request("http://localhost/", { headers: { "x-mockingbird-api-key": token } }),
      )
      if (principal?.kind !== "user")
        throw unauthorized("Sign in with a personal token (mbf_u_…), not an organization key")
      return startSession(principal.user)
    },

    async logout(request: Request): Promise<string> {
      const token = readCookie(request, sessionCookieName(config))
      if (token) await db.remove("sessions", { token_hash: sha256(token) })
      return cookie(config, "", 0)
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
