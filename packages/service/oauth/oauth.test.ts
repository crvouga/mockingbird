import { describe, expect, test } from "bun:test"
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose"
import { hash } from "./src/crypto.js"
import {
  createMultiRuntime,
  createRuntime,
  OAuthAPI,
  type OAuthMount,
  type Provider,
} from "./src/index.js"
import { createMultiServer, createServer } from "./src/server.js"

const issuer = "https://identity.test"
const callback = "https://app.test/callback"
const account = { id: "ada", name: "Ada Lovelace", email: "ada@example.test" }
const client = {
  id: "app",
  name: "Example application",
  redirectUris: [callback],
  secret: "fixture-client-secret",
}
const verifier = "a".repeat(43)
const request = (
  path: string,
  body?: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  new Request(
    issuer + path,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams(body),
        }
      : { headers },
  )
function transaction(html: string): string {
  const id = /name="transaction" value="([^"]+)"/.exec(html)?.[1]
  if (!id) throw new Error(`No transaction in ${html.slice(0, 120)}`)
  return id
}
type Fetcher = { fetch(r: Request): Promise<Response> }
async function authorize(
  api: Fetcher,
  extra: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  return api.fetch(
    request(
      `/authorize?${new URLSearchParams({ client_id: "app", redirect_uri: callback, response_type: "code", scope: "openid email profile", state: "round-trip", nonce: "nonce", ...extra })}`,
      undefined,
      headers,
    ),
  )
}
async function complete(api: Fetcher, extra: Record<string, string> = {}) {
  const tx = transaction(await (await authorize(api, extra)).text())
  const selected = await api.fetch(
    request("/interaction", { transaction: tx, action: "select", account: "ada" }),
  )
  expect(await selected.text()).toContain("Review access")
  return api.fetch(request("/interaction", { transaction: tx, action: "allow" }))
}
const code = (r: Response) =>
  new URL(r.headers.get("location") ?? "https://invalid").searchParams.get("code") ?? ""
const exchange = (api: Fetcher, value: string, extra: Record<string, string> = {}) =>
  api.fetch(
    request("/token", {
      grant_type: "authorization_code",
      code: value,
      client_id: "app",
      client_secret: client.secret,
      redirect_uri: callback,
      ...extra,
    }),
  )
const api = (provider: Provider = "oidc") =>
  new OAuthAPI({ provider, accounts: [account], clients: [client] })
describe("OAuth protocol", () => {
  test("Google discovery, PKCE, independent JWT verification, userinfo and replay", async () => {
    const service = api("google")
    const discovery = await (
      await service.fetch(request("/.well-known/openid-configuration"))
    ).json()
    expect(discovery.authorization_endpoint).toBe(`${issuer}/o/oauth2/v2/auth`)
    const finished = await complete(service, {
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
      access_type: "offline",
    })
    expect(new URL(finished.headers.get("location") ?? "").searchParams.get("state")).toBe(
      "round-trip",
    )
    const response = await exchange(service, code(finished), { code_verifier: verifier })
    expect(response.status).toBe(200)
    const tokens = await response.json()
    expect(tokens.refresh_token).toBeString()
    const jwks = await (await service.fetch(request("/oauth2/v3/certs"))).json()
    const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer,
      audience: "app",
    })
    expect(payload).toMatchObject({
      sub: "ada",
      email: account.email,
      email_verified: true,
      nonce: "nonce",
      name: account.name,
    })
    const user = await service.fetch(
      request("/v1/userinfo", undefined, { authorization: `Bearer ${tokens.access_token}` }),
    )
    expect(await user.json()).toMatchObject({ sub: "ada", email: account.email })
    expect((await exchange(service, code(finished), { code_verifier: verifier })).status).toBe(400)
  })
  test("untrusted callbacks, duplicate parameters and unsupported flows", async () => {
    const service = api()
    for (const redirect_uri of ["https://evil.test", `${callback}/`, `${callback}#fragment`]) {
      const r = await authorize(service, { redirect_uri })
      expect(r.status).toBe(400)
      expect(r.headers.has("location")).toBe(false)
    }
    const r = await authorize(service, { response_type: "token" })
    expect(new URL(r.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "unsupported_response_type",
    )
    expect((await service.fetch(request(`/authorize?client_id=app&client_id=evil`))).status).toBe(
      400,
    )
  })
  test("bad credentials/PKCE preserve code; concurrent redemption has one winner", async () => {
    const service = api()
    const value = code(
      await complete(service, {
        code_challenge: await hash(verifier),
        code_challenge_method: "S256",
      }),
    )
    expect((await exchange(service, value, { client_secret: "wrong" })).status).toBe(401)
    expect((await exchange(service, value, { redirect_uri: "https://evil.test" })).status).toBe(400)
    expect((await exchange(service, value, { code_verifier: "b".repeat(43) })).status).toBe(400)
    const responses = await Promise.all([
      exchange(service, value, { code_verifier: verifier }),
      exchange(service, value, { code_verifier: verifier }),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400])
  })
  test("public clients require S256 and redeem without secret", async () => {
    const service = new OAuthAPI({
      accounts: [account],
      clients: [{ id: "app", name: "Public app", redirectUris: [callback] }],
    })
    expect(
      new URL((await authorize(service)).headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("invalid_request")
    const finish = await complete(service, {
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    })
    const r = await service.fetch(
      request("/token", {
        grant_type: "authorization_code",
        client_id: "app",
        redirect_uri: callback,
        code: code(finish),
        code_verifier: verifier,
      }),
    )
    expect(r.status).toBe(200)
  })
  test("native public clients use exact registered private-scheme callbacks with S256 PKCE", async () => {
    const nativeCallback = "acme://Callback/expo%2Freturn?channel=native"
    const service = new OAuthAPI({
      provider: "google",
      accounts: [account],
      clients: [{ id: "app", name: "Native app", redirectUris: [nativeCallback] }],
    })
    const finished = await complete(service, {
      redirect_uri: nativeCallback,
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    })
    const location = finished.headers.get("location") ?? ""
    expect(location).toStartWith(`${nativeCallback}&code=`)
    expect(location).toContain("&state=round-trip")
    const authorizationCode = new URL(location).searchParams.get("code") ?? ""
    const tokens = await service.fetch(
      request("/token", {
        grant_type: "authorization_code",
        client_id: "app",
        redirect_uri: nativeCallback,
        code: authorizationCode,
        code_verifier: verifier,
      }),
    )
    expect(tokens.status).toBe(200)
    expect(await tokens.json()).toMatchObject({ token_type: "Bearer" })

    for (const redirect_uri of [
      `${nativeCallback}/`,
      nativeCallback.replace("Callback", "callback"),
      "attacker://Callback/expo%2Freturn?channel=native",
    ]) {
      const rejected = await authorize(service, {
        redirect_uri,
        code_challenge: await hash(verifier),
        code_challenge_method: "S256",
      })
      expect(rejected.status).toBe(400)
      expect(rejected.headers.has("location")).toBe(false)
    }
    expect(
      () =>
        new OAuthAPI({
          clients: [{ id: "bad", name: "Bad", redirectUris: ["javascript:alert(1)"] }],
        }),
    ).toThrow()
  })
  test("Apple form_post exposes a deterministic private-scheme continuation", async () => {
    const nativeCallback = "com.acme.app:/oauth2redirect"
    const service = new OAuthAPI({
      provider: "apple",
      accounts: [account],
      clients: [{ id: "app", name: "Native app", redirectUris: [nativeCallback] }],
      nonce: () => "fixed-csp-nonce",
    })
    const response = await complete(service, {
      redirect_uri: nativeCallback,
      response_mode: "form_post",
      scope: "openid email",
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    })
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain(`method="post" action="${nativeCallback}"`)
    expect(html).toContain('name="code"')
    expect(html).toContain('name="state" value="round-trip"')
    expect(response.headers.get("content-security-policy")).toContain("form-action com.acme.app:")
  })
  test("refresh scope restriction and token-family revocation", async () => {
    const service = api()
    const tokens = await (
      await exchange(
        service,
        code(await complete(service, { scope: "openid email offline_access" })),
      )
    ).json()
    const refresh = (scope: string) =>
      service.fetch(
        request("/token", {
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: "app",
          client_secret: client.secret,
          scope,
        }),
      )
    expect((await refresh("openid email profile")).status).toBe(400)
    const renewed = await (await refresh("openid")).json()
    expect(decodeJwt(renewed.id_token).email).toBeUndefined()
    await service.fetch(
      request("/revoke", {
        token: tokens.refresh_token,
        client_id: "app",
        client_secret: client.secret,
      }),
    )
    expect((await refresh("openid")).status).toBe(400)
    expect(
      (
        await service.fetch(
          request("/userinfo", undefined, { authorization: `Bearer ${renewed.access_token}` }),
        )
      ).status,
    ).toBe(401)
  })
  test("Apple hybrid form_post, c_hash, string claims and first-consent-only user", async () => {
    const service = api("apple")
    const extra = {
      scope: "openid name email",
      response_type: "code id_token",
      response_mode: "form_post",
    }
    const first = await complete(service, extra)
    const html = await first.text()
    const field = (name: string) =>
      new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? ""
    expect(field("state")).toBe("round-trip")
    expect(field("user")).toContain("Ada")
    const jwks = await (await service.fetch(request("/auth/keys"))).json()
    const { payload } = await jwtVerify(field("id_token"), createLocalJWKSet(jwks), {
      issuer,
      audience: "app",
    })
    expect(payload.email_verified).toBe("true")
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(field("code"))),
    )
    expect(payload.c_hash).toBe(Buffer.from(digest.slice(0, 16)).toString("base64url"))
    expect((await (await exchange(service, field("code"))).json()).refresh_token).toBeString()
    expect(await (await complete(service, extra)).text()).not.toContain('name="user"')
    expect((await service.fetch(request("/userinfo"))).status).toBe(404)
  })
  test("silent login, session reuse, max_age, cancellation and expiry", async () => {
    let now = Date.now()
    const service = new OAuthAPI({ accounts: [account], clients: [client], now: () => now })
    expect(
      new URL(
        (await authorize(service, { prompt: "none" })).headers.get("location") ?? "",
      ).searchParams.get("error"),
    ).toBe("login_required")
    const done = await complete(service)
    const cookie = done.headers.get("set-cookie")?.split(";")[0] ?? ""
    expect(code(await authorize(service, { prompt: "none" }, { cookie }))).not.toBe("")
    expect(await (await authorize(service, { max_age: "0" }, { cookie })).text()).toContain(
      "Choose an account",
    )
    const tx = transaction(await (await authorize(service)).text())
    const deny = await service.fetch(request("/interaction", { transaction: tx, action: "deny" }))
    expect(new URL(deny.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    )
    expect(
      (await service.fetch(request("/interaction", { transaction: tx, action: "allow" }))).status,
    ).toBe(400)
    now += 3600001
    expect((await exchange(service, code(done))).status).toBe(400)
  })
  test("signup, duplicate email, HTML escaping, CSRF and transaction replay", async () => {
    const service = api()
    const tx = transaction(await (await authorize(service)).text())
    const signup = () =>
      service.fetch(
        request("/interaction", {
          transaction: tx,
          action: "signup",
          name: '<script>alert("x")</script>',
          email: "new@example.test",
        }),
      )
    expect(await (await signup()).text()).toContain("&lt;script&gt;")
    expect(service.accounts.count()).toBe(2)
    expect((await signup()).status).toBe(400)
    expect(
      (
        await service.fetch(
          request(
            "/interaction",
            { transaction: tx, action: "allow" },
            { origin: "https://evil.test" },
          ),
        )
      ).status,
    ).toBe(403)
    expect(
      (await service.fetch(request("/interaction", { transaction: tx, action: "allow" }))).status,
    ).toBe(302)
    expect(
      (await service.fetch(request("/interaction", { transaction: tx, action: "allow" }))).status,
    ).toBe(400)
  })
})
describe("service integration", () => {
  test("accounts, namespace isolation, snapshot, reset and admin protection", async () => {
    const runtime = createRuntime({
      accounts: [account],
      clients: [client],
      adminKey: "fixture-admin",
    })
    expect((await runtime.fetch(request("/health"))).status).toBe(200)
    expect((await runtime.fetch(request("/__admin/accounts"))).status).toBe(401)
    runtime
      .instance("suite")
      .seedAccount({ id: "grace", name: "Grace Hopper", email: "grace@example.test" })
    expect(runtime.instance().accounts.count()).toBe(1)
    const snapshot = runtime.snapshot("suite")
    await runtime.reset("suite")
    expect(runtime.instance("suite").accounts.count()).toBe(1)
    runtime.restore(snapshot, "suite")
    expect(runtime.instance("suite").accounts.count()).toBe(2)
    const discovery = await (
      await runtime.fetch(request("/ns/suite/.well-known/openid-configuration"))
    ).json()
    expect(discovery.issuer).toBe(`${issuer}/ns/suite`)
    const start = await runtime.fetch(
      request(
        `/ns/suite/authorize?${new URLSearchParams({ client_id: "app", redirect_uri: callback, response_type: "code", scope: "openid" })}`,
      ),
    )
    expect(await start.text()).toContain(`${issuer}/ns/suite/interaction`)

    const adminHeaders = {
      "content-type": "application/json",
      "x-mockingbird-admin-key": "fixture-admin",
    }
    const registered = await runtime.fetch(
      new Request(`${issuer}/ns/native/__admin/clients`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          id: "native-app",
          name: "Native app",
          redirectUris: ["acme://callback"],
        }),
      }),
    )
    expect(registered.status).toBe(201)
    const nativeClients = await (
      await runtime.fetch(
        new Request(`${issuer}/ns/native/__admin/clients`, { headers: adminHeaders }),
      )
    ).json()
    expect(
      nativeClients.clients.find((entry: { id: string }) => entry.id === "native-app"),
    ).toEqual({
      id: "native-app",
      name: "Native app",
      redirectUris: ["acme://callback"],
      requirePkce: true,
    })
    const defaultClients = await (
      await runtime.fetch(new Request(`${issuer}/__admin/clients`, { headers: adminHeaders }))
    ).json()
    expect(defaultClients.clients.map((entry: { id: string }) => entry.id)).not.toContain(
      "native-app",
    )
  })
  test("HTTP adapter serves HTML and discovery", async () => {
    const server = await createServer({ accounts: [account], clients: [client] })
    try {
      const discovery = await (await fetch(`${server.url}/.well-known/openid-configuration`)).json()
      expect(discovery.issuer).toBe(server.url)
      expect(await (await fetch(server.url)).text()).toContain("Make sign-in")
    } finally {
      await server.close()
    }
  })
})

describe("multi-provider runtime", () => {
  const mounts = [
    { path: "/google", provider: "google" as const, accounts: [account], clients: [client] },
    { path: "/apple", provider: "apple" as const, accounts: [account], clients: [client] },
    { path: "/oauth2", provider: "microsoft" as const, accounts: [account], clients: [client] },
  ] satisfies [OAuthMount, OAuthMount, OAuthMount]

  test("mounts exact independent issuers, keys and state", async () => {
    const runtime = createMultiRuntime({ mounts })
    const google = await (
      await runtime.fetch(new Request(`${issuer}/google/.well-known/openid-configuration`))
    ).json()
    const apple = await (
      await runtime.fetch(new Request(`${issuer}/apple/.well-known/openid-configuration`))
    ).json()
    expect(google.issuer).toBe(`${issuer}/google`)
    expect(google.authorization_endpoint).toBe(`${issuer}/google/o/oauth2/v2/auth`)
    expect(apple.issuer).toBe(`${issuer}/apple`)
    const googleKeys = await (await runtime.fetch(new Request(google.jwks_uri))).json()
    const appleKeys = await (await runtime.fetch(new Request(apple.jwks_uri))).json()
    expect(googleKeys.keys[0].kid).not.toBe(appleKeys.keys[0].kid)

    const added = await runtime.fetch(
      new Request(`${issuer}/google/__admin/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "grace", name: "Grace Hopper", email: "grace@example.test" }),
      }),
    )
    expect(added.status).toBe(201)
    const appleAccounts = await (
      await runtime.fetch(new Request(`${issuer}/apple/__admin/accounts`))
    ).json()
    expect(appleAccounts.accounts.map((entry: { id: string }) => entry.id)).not.toContain("grace")
  })

  test("mount and namespace routing compose without prefix confusion", async () => {
    const runtime = createMultiRuntime({ mounts })
    const discovery = await (
      await runtime.fetch(
        new Request(`${issuer}/ns/worker/google/.well-known/openid-configuration`),
      )
    ).json()
    expect(discovery.issuer).toBe(`${issuer}/ns/worker/google`)
    expect((await runtime.fetch(new Request(`${issuer}/googler/authorize`))).status).toBe(404)
    expect((await runtime.fetch(new Request(`${issuer}/googleish/authorize`))).status).toBe(404)
    expect((await runtime.fetch(new Request(`${issuer}/missing/authorize`))).status).toBe(404)
  })

  test("aggregate health, reset, controls and startup validation", async () => {
    const runtime = createMultiRuntime({ mounts })
    const health = await (await runtime.fetch(new Request(`${issuer}/health`))).json()
    expect(Object.keys(health.mounts)).toEqual(["/google", "/apple", "/oauth2"])
    expect((await runtime.fetch(new Request(`${issuer}/__admin/mounts`))).status).toBe(200)
    expect(
      (
        await runtime.fetch(
          new Request(`${issuer}/__admin/clock?mount=/google`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ set: "2030-01-01T00:00:00Z", freeze: true }),
          }),
        )
      ).status,
    ).toBe(200)
    expect(runtime.clock.state().frozen).toBe(true)
    expect(
      (await runtime.fetch(new Request(`${issuer}/__admin/reset?all=1`, { method: "POST" })))
        .status,
    ).toBe(200)
    expect(() => createMultiRuntime({ mounts: [mounts[0], mounts[0]] })).toThrow(
      "duplicate OAuth mount path",
    )
    expect(() =>
      createMultiRuntime({ mounts: [{ ...mounts[0], path: "/google/../apple" }] }),
    ).toThrow("invalid OAuth mount path")
  })

  test("HTTP adapter serves all mounts on one listener", async () => {
    const server = await createMultiServer({ mounts })
    try {
      const discovery = await (
        await fetch(`${server.url}/oauth2/.well-known/openid-configuration`)
      ).json()
      expect(discovery.issuer).toBe(`${server.url}/oauth2`)
    } finally {
      await server.close()
    }
  })
})
