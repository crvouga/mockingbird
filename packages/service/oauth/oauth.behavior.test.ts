import { expect, test } from "bun:test"
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose"
import {
  createRuntime,
  OAUTH_SCENARIOS,
  OAuthAPI,
  type OAuthAPIOptions,
  type Provider,
} from "./src/index.js"

const origin = "https://identity.test"
const callback = "https://app.test/callback"
const account = { id: "ada", name: "Ada Lovelace", email: "ada@example.test" }
const client = { id: "app", name: "App", secret: "fixture", redirectUris: [callback] }
const make = (provider: Provider = "oidc", options: OAuthAPIOptions = {}) =>
  new OAuthAPI({ provider, accounts: [account], clients: [client], ...options })
const req = (path: string, body?: Record<string, string>, accept = "application/json") =>
  new Request(
    origin + path,
    body ? { method: "POST", headers: { accept }, body: new URLSearchParams(body) } : undefined,
  )
const field = (html: string, name: string) =>
  (new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
async function login(api: OAuthAPI, params: Record<string, string> = {}, choice?: string) {
  const query = new URLSearchParams({
    client_id: "app",
    redirect_uri: callback,
    response_type: "code",
    scope:
      api.provider === "apple"
        ? "openid name email"
        : api.provider === "github"
          ? "read:user user:email"
          : api.provider === "google"
            ? "openid profile email"
            : "openid profile email offline_access",
    ...(api.provider === "apple" ? { response_mode: "form_post" } : {}),
    ...params,
  })
  const start = await api.fetch(req(`/authorize?${query}`))
  const tx = field(await start.text(), "transaction")
  expect(tx).not.toBe("")
  const consent = await api.fetch(
    req("/interaction", { transaction: tx, action: "select", account: "ada" }),
  )
  const result = await api.fetch(
    req("/interaction", {
      transaction: tx,
      action: "allow",
      ...(choice ? { email_choice: choice } : {}),
    }),
  )
  const html = await result.text()
  const url = result.headers.get("location")
  return {
    result,
    consent: await consent.text(),
    html,
    code: url ? (new URL(url).searchParams.get("code") ?? "") : field(html, "code"),
  }
}
const exchange = (api: OAuthAPI, code: string, accept = "application/json") =>
  api.fetch(
    req(
      "/token",
      {
        grant_type: "authorization_code",
        client_id: "app",
        client_secret: "fixture",
        redirect_uri: callback,
        code,
      },
      accept,
    ),
  )
const refresh = (api: OAuthAPI, token: string) =>
  api.fetch(
    req("/token", {
      grant_type: "refresh_token",
      client_id: "app",
      client_secret: "fixture",
      refresh_token: token,
    }),
  )
const tokens = async (api: OAuthAPI, params: Record<string, string> = {}, choice?: string) => {
  const authorization = await login(api, params, choice)
  const response = await exchange(api, authorization.code)
  expect(response.status).toBe(200)
  return { ...authorization, tokens: await response.json() }
}
const userinfo = (api: OAuthAPI, token: string, path = "/userinfo") =>
  api.fetch(new Request(origin + path, { headers: { authorization: `Bearer ${token}` } }))

test("Apple Hide My Email returns a stable relay in callbacks, ID tokens and refresh without leaking original email", async () => {
  const api = make("apple")
  const first = await tokens(api, {}, "hide")
  expect(first.consent).toContain("Hide my email")
  const identity = decodeJwt(first.tokens.id_token)
  expect(identity.email).toEndWith("@privaterelay.appleid.com")
  expect(identity.is_private_email).toBe("true")
  expect(first.html).not.toContain(account.email)
  expect(JSON.parse(field(first.html, "user")).email).toBe(identity.email)
  const second = await tokens(api, {}, "share")
  expect(decodeJwt(second.tokens.id_token).email).toBe(identity.email)
  expect(second.html).not.toContain('name="user"')
  expect(second.consent).not.toContain('name="email_choice"')
  const renewed = await (await refresh(api, first.tokens.refresh_token)).json()
  expect(decodeJwt(renewed.id_token).email).toBe(identity.email)
  const another = make("apple", {
    clients: [{ ...client, subjectGroup: "other-team" }],
    behavior: { preset: "apple_private_relay" },
  })
  const third = decodeJwt((await tokens(another)).tokens.id_token)
  expect(third.sub).not.toBe(identity.sub)
  expect(third.email).not.toBe(identity.email)
})

test("Apple share choice, preset relay override, boolean claims and returning-user payload", async () => {
  const shared = decodeJwt((await tokens(make("apple"), {}, "share")).tokens.id_token)
  expect(shared.email).toBe(account.email)
  expect(shared.is_private_email).toBe("false")
  const api = make("apple", {
    accounts: [
      { ...account, privateEmail: true, relayEmail: "test-relay@privaterelay.appleid.com" },
    ],
    behavior: { preset: "apple_returning_user", apple: { booleanClaims: "boolean" } },
  })
  const result = await tokens(api)
  expect(result.html).not.toContain('name="user"')
  expect(decodeJwt(result.tokens.id_token)).toMatchObject({
    email: "test-relay@privaterelay.appleid.com",
    email_verified: true,
    is_private_email: true,
  })
})

test("Apple consent revocation resets first-use data and invalidates old credentials", async () => {
  const api = make("apple")
  const first = await tokens(api, {}, "hide")
  api.revokeConsent("app", "ada")
  expect((await refresh(api, first.tokens.refresh_token)).status).toBe(400)
  const next = await tokens(api, {}, "share")
  expect(next.html).toContain('name="user"')
  expect(decodeJwt(next.tokens.id_token).sub).toBe(decodeJwt(first.tokens.id_token).sub)
  expect(decodeJwt(next.tokens.id_token).email).toBe(account.email)
})

test("Google refresh token is first-consent-only, prompt=consent reissues, never preset suppresses", async () => {
  const api = make("google")
  const first = await tokens(api, { scope: "openid email profile", access_type: "offline" })
  expect(first.tokens.refresh_token).toBeString()
  expect(
    (await tokens(api, { scope: "openid email profile", access_type: "offline" })).tokens
      .refresh_token,
  ).toBeUndefined()
  expect(
    (
      await tokens(api, {
        scope: "openid email profile",
        access_type: "offline",
        prompt: "consent",
      })
    ).tokens.refresh_token,
  ).toBeString()
  api.configureBehavior({ preset: "google_no_refresh_token" })
  expect(
    (
      await tokens(api, {
        scope: "openid email profile",
        access_type: "offline",
        prompt: "consent",
      })
    ).tokens.refresh_token,
  ).toBeUndefined()
})

test("Google partial and incremental consent restrict claims and combine already granted scopes", async () => {
  const api = make("google", { behavior: { consent: { deniedScopes: ["email"] } } })
  const first = await tokens(api, { scope: "openid profile email" })
  expect(first.tokens.scope).toBe("openid profile")
  expect(decodeJwt(first.tokens.id_token).email).toBeUndefined()
  expect((await (await userinfo(api, first.tokens.access_token)).json()).email).toBeUndefined()
  api.configureBehavior({})
  const combined = await tokens(api, { scope: "openid email", include_granted_scopes: "true" })
  expect(new Set(combined.tokens.scope.split(" "))).toEqual(new Set(["openid", "profile", "email"]))
  const onlyRequested = await tokens(api, { scope: "openid email" })
  expect(onlyRequested.tokens.scope).toBe("openid email")
})

test("Google testing refresh expiry exempts basic identity scopes; reauth returns invalid_rapt", async () => {
  let now = Date.now()
  const behavior = {
    google: { testing: true },
    additionalScopes: ["https://www.googleapis.com/auth/drive.readonly"],
  }
  const api = make("google", { now: () => now, behavior })
  const basic = await tokens(api, { scope: "openid email profile", access_type: "offline" })
  const drive = await tokens(api, {
    scope: "openid https://www.googleapis.com/auth/drive.readonly",
    access_type: "offline",
    prompt: "consent",
  })
  expect(drive.tokens.refresh_token_expires_in).toBe(604800)
  expect(basic.tokens.refresh_token_expires_in).toBeUndefined()
  now += 604801000
  expect((await refresh(api, drive.tokens.refresh_token)).status).toBe(400)
  expect((await refresh(api, basic.tokens.refresh_token)).status).toBe(200)
  api.configureBehavior({ preset: "google_reauthentication" })
  expect(await (await refresh(api, basic.tokens.refresh_token)).json()).toMatchObject({
    error: "invalid_grant",
    error_subtype: "invalid_rapt",
  })
})

test("Microsoft pairwise subject, mutable preferred_username, absent email and reusable old refresh token", async () => {
  const api = make("microsoft", {
    accounts: [
      {
        ...account,
        omitEmail: true,
        preferredUsername: "ada@old.test",
        objectId: "00000000-0000-4000-8000-000000000001",
        tenantId: "00000000-0000-4000-8000-000000000002",
      },
    ],
  })
  const first = await tokens(api)
  const identity = decodeJwt(first.tokens.id_token)
  expect(identity.email).toBeUndefined()
  expect(identity.preferred_username).toBe("ada@old.test")
  api.seedAccount({
    ...account,
    omitEmail: true,
    preferredUsername: "ada@new.test",
    objectId: String(identity.oid),
    tenantId: String(identity.tid),
  })
  const renewed = await (await refresh(api, first.tokens.refresh_token)).json()
  expect(renewed.refresh_token).toBeString()
  expect(decodeJwt(renewed.id_token)).toMatchObject({
    sub: identity.sub,
    oid: identity.oid,
    preferred_username: "ada@new.test",
  })
  expect((await refresh(api, first.tokens.refresh_token)).status).toBe(200)
})

test("GitHub OAuth has no ID token, nullable public email, multiple private emails and scope gating", async () => {
  const emails = [
    { email: "old@example.test", primary: false, verified: false, visibility: "private" as const },
    { email: account.email, primary: true, verified: true, visibility: "private" as const },
  ]
  const api = make("github", {
    accounts: [{ ...account, github: { id: 42, login: "ada", publicEmail: null, emails } }],
  })
  const result = await tokens(api)
  expect(result.tokens.id_token).toBeUndefined()
  expect(result.tokens.refresh_token).toBeUndefined()
  expect(result.tokens.token_type).toBe("bearer")
  expect(await (await userinfo(api, result.tokens.access_token, "/user")).json()).toMatchObject({
    id: 42,
    login: "ada",
    email: null,
  })
  expect(await (await userinfo(api, result.tokens.access_token, "/user/emails")).json()).toEqual(
    emails,
  )
  const limited = await tokens(api, { scope: "read:user" })
  expect((await userinfo(api, limited.tokens.access_token, "/user/emails")).status).toBe(403)
  const next = await login(api)
  const form = await exchange(api, next.code, "application/x-www-form-urlencoded")
  expect(form.headers.get("content-type")).toContain("application/x-www-form-urlencoded")
  expect(new URLSearchParams(await form.text()).get("access_token")).toBeString()
})

test("rotating refresh reuse revokes its family, isolated from other authorizations", async () => {
  const api = make("oidc", { behavior: { preset: "rotating_refresh_tokens" } })
  const first = await tokens(api)
  const other = await tokens(api)
  const rotated = await (await refresh(api, first.tokens.refresh_token)).json()
  expect(rotated.refresh_token).toBeString()
  expect((await refresh(api, first.tokens.refresh_token)).status).toBe(400)
  expect((await refresh(api, rotated.refresh_token)).status).toBe(400)
  expect((await userinfo(api, rotated.access_token)).status).toBe(401)
  expect((await refresh(api, other.tokens.refresh_token)).status).toBe(200)
})

test("transient token failures preserve codes for retries; probabilities and config are validated", async () => {
  const api = make("oidc", { behavior: { probabilities: { tokenUnavailable: 1 } } })
  const authorization = await login(api)
  const failed = await exchange(api, authorization.code)
  expect(failed.status).toBe(503)
  expect(failed.headers.get("retry-after")).toBe("1")
  api.configureBehavior({})
  expect((await exchange(api, authorization.code)).status).toBe(200)
  for (const value of [-1, 1.1, NaN, Infinity])
    expect(() => api.configureBehavior({ probabilities: { hideEmail: value } })).toThrow()
  expect(() => api.configureBehavior({ tokens: { codeTtlSeconds: 0 } })).toThrow()
})

test("seeded decisions replay across instances, reset and snapshot; behavior admin is protected and isolated", async () => {
  const runtime = createRuntime({
    seed: "regression-42",
    adminKey: "fixture",
    behavior: { probabilities: { hideEmail: 0.5, omitEmail: 0.35, denyConsent: 0.2 } },
  })
  const independent = createRuntime({
    seed: "regression-42",
    behavior: { probabilities: { hideEmail: 0.5, omitEmail: 0.35, denyConsent: 0.2 } },
  })
  const sample = (api: OAuthAPI) => Array.from({ length: 30 }, () => api.behavior.decisions())
  const original = sample(runtime.instance())
  expect(sample(independent.instance())).toEqual(original)
  expect(new Set(original.map((v) => v.hideEmail)).size).toBe(2)
  const snapshot = runtime.snapshot()
  const next = sample(runtime.instance())
  runtime.restore(snapshot)
  expect(sample(runtime.instance())).toEqual(next)
  await runtime.reset()
  expect(sample(runtime.instance())).toEqual(original)
  runtime.instance("other").configureBehavior({ preset: "missing_email" })
  expect(runtime.instance().behavior.config.claims).toBeUndefined()
  expect(
    (
      await runtime.fetch(
        new Request(`${origin}/__admin/behavior`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(401)
  const scenarios = await runtime.fetch(
    new Request(`${origin}/__admin/scenarios`, {
      headers: { "x-mockingbird-admin-key": "fixture" },
    }),
  )
  expect(Object.keys(await scenarios.json())).toEqual(Object.keys(OAUTH_SCENARIOS))
  expect(JSON.stringify(runtime.instance().behavior.events)).not.toContain("access_token")
})

test("missing identity fields, unverified string false, consent denial, and short TTLs", async () => {
  const missing = make("apple", {
    behavior: { claims: { omitEmail: true, omitName: true, unverifiedEmail: true } },
  })
  const result = await tokens(missing)
  expect(JSON.parse(field(result.html, "user"))).toEqual({})
  expect(decodeJwt(result.tokens.id_token).email).toBeUndefined()
  const unverified = await tokens(make("apple", { behavior: { preset: "unverified_email" } }))
  expect(decodeJwt(unverified.tokens.id_token).email_verified).toBe("false")
  const denied = await login(make("oidc", { behavior: { preset: "consent_denied" } }))
  expect(new URL(denied.result.headers.get("location") ?? "").searchParams.get("error")).toBe(
    "access_denied",
  )
  let now = Date.now()
  const short = make("oidc", { now: () => now, behavior: { preset: "short_lived_tokens" } })
  const live = await tokens(short)
  now += 6000
  expect((await userinfo(short, live.tokens.access_token)).status).toBe(401)
  expect((await refresh(short, live.tokens.refresh_token)).status).toBe(200)
  now += 30000
  expect((await refresh(short, live.tokens.refresh_token)).status).toBe(400)
})

test("JWKS rotation retains old keys optionally and new tokens carry the new kid", async () => {
  const api = make()
  const first = await tokens(api)
  const key = api.rotateSigningKey()
  const second = await tokens(api)
  const jwks = await (await api.fetch(req("/jwks"))).json()
  expect(jwks.keys.length).toBe(2)
  await jwtVerify(first.tokens.id_token, createLocalJWKSet(jwks))
  expect(
    (await jwtVerify(second.tokens.id_token, createLocalJWKSet(jwks))).protectedHeader.kid,
  ).toBe(key.kid)
  api.rotateSigningKey(false)
  const current = await (await api.fetch(req("/jwks"))).json()
  expect(current.keys.length).toBe(1)
  expect(jwtVerify(first.tokens.id_token, createLocalJWKSet(current))).rejects.toThrow()
})

test("GitHub token errors are provider-shaped and accept JSON request bodies", async () => {
  const api = make("github")
  const authorization = await login(api)
  const response = await api.fetch(
    new Request(`${origin}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: "app",
        client_secret: "fixture",
        code: authorization.code,
      }),
    }),
  )
  expect((await response.json()).access_token).toBeString()
  const replay = await exchange(api, authorization.code)
  expect((await replay.json()).error).toBe("bad_verification_code")
  const unverified = make("github", { accounts: [{ ...account, emailVerified: false }] })
  const pending = await login(unverified)
  expect((await (await exchange(unverified, pending.code)).json()).error).toBe(
    "unverified_user_email",
  )
})

test("Google refresh-token limit evicts oldest tokens and inactivity expires remaining ones", async () => {
  let now = Date.now()
  const api = make("google", { now: () => now, behavior: { google: { maxRefreshTokens: 2 } } })
  const first = await tokens(api, { access_type: "offline", prompt: "consent" })
  const second = await tokens(api, { access_type: "offline", prompt: "consent" })
  const third = await tokens(api, { access_type: "offline", prompt: "consent" })
  expect((await refresh(api, first.tokens.refresh_token)).status).toBe(400)
  expect((await refresh(api, second.tokens.refresh_token)).status).toBe(200)
  expect((await refresh(api, third.tokens.refresh_token)).status).toBe(200)
  now += 190 * 86400000
  expect((await refresh(api, third.tokens.refresh_token)).status).toBe(400)
})

test("Apple grouped apps share relay/subject and receive first-use user data only once", async () => {
  const api = make("apple", {
    clients: [
      { ...client, subjectGroup: "team" },
      { ...client, id: "second", subjectGroup: "team" },
    ],
    behavior: { preset: "apple_private_relay" },
  })
  const first = await tokens(api)
  const authorization = await login(api, { client_id: "second" })
  expect(authorization.html).not.toContain('name="user"')
  const result = await api.fetch(
    req("/token", {
      client_id: "second",
      client_secret: "fixture",
      redirect_uri: callback,
      grant_type: "authorization_code",
      code: authorization.code,
    }),
  )
  const identity = decodeJwt((await result.json()).id_token)
  expect(identity.sub).toBe(decodeJwt(first.tokens.id_token).sub)
  expect(identity.email).toBe(decodeJwt(first.tokens.id_token).email)
})

test("provider session reuse can be disabled and prompt=select_account always forces choice", async () => {
  const api = make("google")
  const signedIn = await login(api)
  const cookie = signedIn.result.headers.get("set-cookie")?.split(";")[0] ?? ""
  expect(cookie).toStartWith("mb_session=")
  const authorize = (prompt = "") => {
    const params = new URLSearchParams({
      client_id: "app",
      redirect_uri: callback,
      response_type: "code",
      scope: "openid profile email",
      ...(prompt ? { prompt } : {}),
    })
    return api.fetch(new Request(`${origin}/authorize?${params}`, { headers: { cookie } }))
  }
  expect((await authorize()).status).toBe(302)
  api.behavior.configure({ session: { reuseLastAccount: false } })
  expect(await (await authorize()).text()).toContain("Choose an account")
  expect(
    new URL((await authorize("none")).headers.get("location") ?? "").searchParams.get("error"),
  ).toBe("login_required")
  api.behavior.configure({ session: { reuseLastAccount: true } })
  expect((await authorize()).status).toBe(302)
  expect(await (await authorize("select_account")).text()).toContain("Choose an account")
  expect(() => api.behavior.configure({ session: { reuseLastAccount: "yes" } })).toThrow()
})

test("neutral UI offers all appearance modes and Apple form-post scripts share one CSP nonce", async () => {
  const api = make("apple")
  const { result, html, consent } = await login(api)
  expect(consent).toContain("OAuth Mock")
  expect(consent).not.toContain("Mockingbird")
  for (const mode of ["system", "light", "dark"])
    expect(consent).toContain(`name="oauth-theme" value="${mode}"`)
  const csp = result.headers.get("content-security-policy") ?? ""
  expect(csp.match(/script-src/g)?.length).toBe(1)
  const nonces = [...html.matchAll(/<script nonce="([^"]+)"/g)].map((match) => match[1])
  expect(nonces.length).toBe(2)
  expect(new Set(nonces).size).toBe(1)
  expect(csp).toContain(`script-src 'nonce-${nonces[0]}'`)
})

test("discovery advertises provider-specific endpoints, claims and client authentication", async () => {
  const cases = [
    {
      provider: "google" as const,
      authorize: "/o/oauth2/v2/auth",
      token: "/token",
      jwks: "/oauth2/v3/certs",
      subject: "public",
      auth: ["client_secret_post", "client_secret_basic"],
      claim: "hd",
      revocation: true,
      pkce: true,
    },
    {
      provider: "apple" as const,
      authorize: "/auth/authorize",
      token: "/auth/token",
      jwks: "/auth/keys",
      subject: "pairwise",
      auth: ["client_secret_post"],
      claim: "real_user_status",
      revocation: true,
      pkce: false,
    },
    {
      provider: "microsoft" as const,
      authorize: "/oauth2/v2.0/authorize",
      token: "/oauth2/v2.0/token",
      jwks: "/discovery/v2.0/keys",
      subject: "pairwise",
      auth: ["client_secret_post", "client_secret_basic"],
      claim: "preferred_username",
      revocation: false,
      pkce: true,
    },
    {
      provider: "oidc" as const,
      authorize: "/authorize",
      token: "/token",
      jwks: "/jwks",
      subject: "public",
      auth: ["client_secret_post", "client_secret_basic", "none"],
      claim: "email_verified",
      revocation: true,
      pkce: true,
    },
  ]
  for (const expected of cases) {
    const metadata = await (
      await make(expected.provider).fetch(req("/.well-known/openid-configuration"))
    ).json()
    expect(metadata.issuer).toBe(origin)
    expect(metadata.authorization_endpoint).toBe(origin + expected.authorize)
    expect(metadata.token_endpoint).toBe(origin + expected.token)
    expect(metadata.jwks_uri).toBe(origin + expected.jwks)
    expect(metadata.subject_types_supported).toEqual([expected.subject])
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(expected.auth)
    expect(metadata.claims_supported).toContain(expected.claim)
    expect(Boolean(metadata.revocation_endpoint)).toBe(expected.revocation)
    expect(Boolean(metadata.code_challenge_methods_supported)).toBe(expected.pkce)
  }
  expect((await make("github").fetch(req("/.well-known/openid-configuration"))).status).toBe(404)
})

test("Apple openid-only grants omit unrequested identity data and expose configured risk and transfer claims", async () => {
  const api = make("apple", {
    accounts: [{ ...account, realUserStatus: 2, transferSub: "transfer-subject" }],
  })
  const result = await tokens(api, { scope: "openid", response_mode: "form_post" })
  const identity = decodeJwt(result.tokens.id_token)
  expect(identity).toMatchObject({ real_user_status: 2, transfer_sub: "transfer-subject" })
  expect(identity.email).toBeUndefined()
  expect(identity.email_verified).toBeUndefined()
  expect(identity.is_private_email).toBeUndefined()
  expect(result.html).not.toContain('name="user"')
  expect(() => make("apple", { accounts: [{ ...account, realUserStatus: 3 as 2 }] })).toThrow(
    "realUserStatus",
  )
})

test("Apple rejects Basic client authentication while Microsoft emits v2 identity claims", async () => {
  const apple = make("apple")
  const authorization = await login(apple, { response_mode: "form_post" })
  const basic = await apple.fetch(
    new Request(`${origin}/auth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa("app:fixture")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        redirect_uri: callback,
        code: authorization.code,
      }),
    }),
  )
  expect(basic.status).toBe(401)
  expect((await basic.json()).error).toBe("invalid_client")

  const microsoft = decodeJwt((await tokens(make("microsoft"))).tokens.id_token)
  expect(microsoft).toMatchObject({ ver: "2.0", oid: "ada" })
  expect(microsoft.sub).not.toBe(microsoft.oid)
})

test("GitHub resource responses expose granted and accepted OAuth scopes", async () => {
  const api = make("github")
  const result = await tokens(api)
  const profile = await userinfo(api, result.tokens.access_token, "/user")
  expect(profile.headers.get("x-oauth-scopes")).toBe("read:user, user:email")
  expect(profile.headers.get("x-accepted-oauth-scopes")).toBe("")
  const emails = await userinfo(api, result.tokens.access_token, "/user/emails")
  expect(emails.headers.get("x-oauth-scopes")).toBe("read:user, user:email")
  expect(emails.headers.get("x-accepted-oauth-scopes")).toBe("user:email")
})

test("every published scenario is valid and provider-specific presets are observable", async () => {
  for (const preset of Object.keys(OAUTH_SCENARIOS))
    expect(() =>
      make("oidc", { behavior: { preset: preset as keyof typeof OAUTH_SCENARIOS } }),
    ).not.toThrow()

  expect(
    decodeJwt(
      (await tokens(make("apple", { behavior: { preset: "apple_share_email" } }))).tokens.id_token,
    ),
  ).toMatchObject({ email: account.email, is_private_email: "false" })
  expect(
    decodeJwt(
      (await tokens(make("apple", { behavior: { preset: "apple_boolean_claims" } }))).tokens
        .id_token,
    ).email_verified,
  ).toBeBoolean()

  const missingMicrosoft = decodeJwt(
    (await tokens(make("microsoft", { behavior: { preset: "microsoft_missing_email" } }))).tokens
      .id_token,
  )
  expect(missingMicrosoft.email).toBeUndefined()

  let now = Date.now()
  const spa = make("microsoft", {
    now: () => now,
    behavior: { preset: "microsoft_spa_expiry" },
  })
  const spaTokens = await tokens(spa)
  now += 86_401_000
  expect((await refresh(spa, spaTokens.tokens.refresh_token)).status).toBe(400)

  const github = make("github", { behavior: { preset: "github_unverified_email" } })
  expect((await (await exchange(github, (await login(github)).code)).json()).error).toBe(
    "unverified_user_email",
  )

  const missingEmail = await tokens(make("oidc", { behavior: { preset: "missing_email" } }))
  expect(decodeJwt(missingEmail.tokens.id_token).email).toBeUndefined()
  const missingName = await tokens(make("oidc", { behavior: { preset: "missing_name" } }))
  expect(decodeJwt(missingName.tokens.id_token).name).toBeUndefined()
  const unverified = await tokens(make("oidc", { behavior: { preset: "unverified_email" } }))
  expect(decodeJwt(unverified.tokens.id_token).email_verified).toBe(false)

  const revoked = await tokens(make("oidc", { behavior: { preset: "revoked_refresh_token" } }))
  const revokedApi = make("oidc", { behavior: { preset: "revoked_refresh_token" } })
  const revokedTokens = await tokens(revokedApi)
  expect((await refresh(revokedApi, revokedTokens.tokens.refresh_token)).status).toBe(400)
  expect(revoked.tokens.refresh_token).toBeString()

  const intermittent = make("oidc", {
    seed: "scenario-coverage",
    behavior: { preset: "intermittent_token_failure" },
  })
  const statuses: number[] = []
  for (let i = 0; i < 16; i++) {
    const authorization = await login(intermittent)
    statuses.push((await exchange(intermittent, authorization.code)).status)
  }
  expect(statuses).toContain(200)
  expect(statuses).toContain(503)
})

test("all configurable authorization errors preserve state and never issue credentials", async () => {
  for (const error of [
    "access_denied",
    "interaction_required",
    "temporarily_unavailable",
  ] as const) {
    const api = make("oidc", { behavior: { consent: { error } } })
    const result = await login(api, { state: `state-${error}` })
    const callback = new URL(result.result.headers.get("location") ?? "")
    expect(callback.searchParams.get("error")).toBe(error)
    expect(callback.searchParams.get("state")).toBe(`state-${error}`)
    expect(callback.searchParams.has("code")).toBe(false)
  }
  const denied = make("oidc", { behavior: { probabilities: { denyConsent: 1 } } })
  expect(
    new URL((await login(denied)).result.headers.get("location") ?? "").searchParams.get("error"),
  ).toBe("access_denied")
})

test("forced random claim and token outcomes are independently observable", async () => {
  const claims = await tokens(
    make("apple", {
      behavior: {
        probabilities: { hideEmail: 1, omitName: 1, unverifiedEmail: 1 },
      },
    }),
  )
  const identity = decodeJwt(claims.tokens.id_token)
  expect(identity.email).toEndWith("@privaterelay.appleid.com")
  expect(identity.email_verified).toBe("false")
  expect(JSON.parse(field(claims.html, "user"))).toEqual({ email: identity.email })

  const omitted = await tokens(
    make("oidc", { behavior: { probabilities: { omitEmail: 1, omitName: 1 } } }),
  )
  expect(decodeJwt(omitted.tokens.id_token)).not.toContainKeys(["email", "name"])

  const invalid = make("oidc", { behavior: { probabilities: { invalidGrant: 1 } } })
  const authorization = await login(invalid)
  expect(await (await exchange(invalid, authorization.code)).json()).toMatchObject({
    error: "invalid_grant",
  })
})

test("Google always-refresh mode and custom scopes behave independently from first-consent mode", async () => {
  const api = make("google", {
    behavior: {
      google: { refreshToken: "always" },
      additionalScopes: ["https://api.example.test/calendar.read"],
    },
  })
  for (let index = 0; index < 2; index++) {
    const result = await tokens(api, {
      scope: "openid email https://api.example.test/calendar.read",
      access_type: "offline",
    })
    expect(result.tokens.refresh_token).toBeString()
    expect(result.tokens.scope).toContain("https://api.example.test/calendar.read")
  }
  const unsupported = await api.fetch(
    req(
      `/authorize?${new URLSearchParams({
        client_id: "app",
        redirect_uri: callback,
        response_type: "code",
        scope: "openid unknown.scope",
      })}`,
    ),
  )
  expect(new URL(unsupported.headers.get("location") ?? "").searchParams.get("error")).toBe(
    "invalid_scope",
  )
})

test("query, fragment and form_post callbacks encode the same state safely", async () => {
  for (const responseMode of ["query", "fragment", "form_post"] as const) {
    const api = make("oidc")
    const result = await login(api, { response_mode: responseMode, state: "a & b" })
    if (responseMode === "form_post") {
      expect(field(result.html, "state")).toBe("a & b")
      expect(field(result.html, "code")).not.toBe("")
    } else {
      const callback = new URL(result.result.headers.get("location") ?? "")
      const values =
        responseMode === "fragment"
          ? new URLSearchParams(callback.hash.slice(1))
          : callback.searchParams
      expect(values.get("state")).toBe("a & b")
      expect(values.get("code")).not.toBe("")
    }
  }
})
