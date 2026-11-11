import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { harness, ORIGIN } from "./harness.js"

/** A minimal OpenID provider: discovery, a JWKS, and a token endpoint that enforces PKCE. */
const keys = await generateKeyPair("RS256")
const codes = new Map<
  string,
  { challenge: string; claims: Record<string, unknown>; audience?: string }
>()
let issuer = ""
let provider: ReturnType<typeof Bun.serve>

beforeAll(() => {
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        })
      if (url.pathname === "/jwks")
        return Response.json({
          keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" }],
        })
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await request.text())
        const grant = codes.get(form.get("code") ?? "")
        codes.delete(form.get("code") ?? "")
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url")
        // A public client: no secret, so the verifier is the only proof the caller began the flow.
        if (!grant || grant.challenge !== challenge || form.get("client_secret") !== null)
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        const idToken = await new SignJWT(grant.claims)
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(issuer)
          .setAudience(grant.audience ?? form.get("client_id") ?? "")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey)
        return Response.json({ id_token: idToken, token_type: "Bearer" })
      }
      return new Response("not found", { status: 404 })
    },
  })
  issuer = `http://127.0.0.1:${provider.port}`
})
afterAll(() => provider.stop(true))

const start = () =>
  harness({
    config: {
      devLogin: false,
      oidc: {
        issuer,
        clientId: "app-123",
        redirectUri: `${ORIGIN}/auth/callback`,
        scopes: "openid email profile",
      },
    },
  })

/** Begin a login and have the provider "approve" it, returning what the browser would carry back. */
async function approve(
  h: ReturnType<typeof harness>,
  claims: Record<string, unknown>,
  options: {
    returnTo?: string
    tamper?: (nonce: string) => Record<string, unknown>
    audience?: string
  } = {},
) {
  const login = await h
    .client()
    .raw(
      "GET",
      `/auth/login${options.returnTo ? `?return_to=${encodeURIComponent(options.returnTo)}` : ""}`,
    )
  expect(login.status).toBe(302)
  const redirect = new URL(login.headers.get("location") as string)
  const query = redirect.searchParams
  const code = crypto.randomUUID()
  codes.set(code, {
    challenge: query.get("code_challenge") as string,
    claims: {
      ...claims,
      nonce: query.get("nonce"),
      ...options.tamper?.(query.get("nonce") as string),
    },
    ...(options.audience ? { audience: options.audience } : {}),
  })
  return { redirect, callback: `/auth/callback?code=${code}&state=${query.get("state")}` }
}

test("sign-in is authorization code with S256 PKCE as a public client", async () => {
  const h = start()
  const { redirect, callback } = await approve(
    h,
    { sub: "google-1", email: "ada@example.test", name: "Ada" },
    { returnTo: "/orgs/org_1" },
  )
  expect(`${redirect.origin}${redirect.pathname}`).toBe(`${issuer}/authorize`)
  expect(Object.fromEntries(redirect.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "app-123",
    redirect_uri: `${ORIGIN}/auth/callback`,
    scope: "openid email profile",
    code_challenge_method: "S256",
  })

  const done = await h.client().raw("GET", callback)
  expect(done.status).toBe(302)
  expect(done.headers.get("location")).toBe("/orgs/org_1")
  const setCookie = done.headers.get("set-cookie") as string
  expect(setCookie).toContain("HttpOnly")
  expect(setCookie).toContain("SameSite=Lax")
  const me = await h
    .client({ cookie: setCookie.split(";")[0] as string })
    .api<{ user: { email: string } }>("GET", "/me")
  expect(me.body.user.email).toBe("ada@example.test")

  // The code and the transaction are single use.
  expect((await h.client().raw("GET", callback)).status).toBe(400)
  await h.close()
})

test("a callback is refused unless it finishes the login this browser started", async () => {
  const h = start()
  const claims = { sub: "google-1", email: "ada@example.test" }
  expect((await h.client().raw("GET", "/auth/callback?code=x&state=never-issued")).status).toBe(400)
  expect((await h.client().raw("GET", "/auth/callback?error=access_denied")).status).toBe(400)
  const wrongNonce = await approve(h, claims, { tamper: () => ({ nonce: "someone-elses" }) })
  expect((await h.client().raw("GET", wrongNonce.callback)).status).toBe(400)
  const wrongAudience = await approve(h, claims, { audience: "another-app" })
  expect((await h.client().raw("GET", wrongAudience.callback)).status).toBe(400)
  expect(await h.db.find("sessions", {})).toHaveLength(0)
  await h.close()
})

test("accounts are keyed by issuer and subject, never merged by email", async () => {
  const h = start()
  for (const sub of ["google-1", "google-2", "google-1"])
    expect(
      (
        await h
          .client()
          .raw("GET", (await approve(h, { sub, email: "shared@example.test" })).callback)
      ).status,
    ).toBe(302)
  expect((await h.db.find("users", {})).map((user) => user.subject).sort()).toEqual([
    "google-1",
    "google-2",
  ])
  await h.close()
})

test("the post-login redirect stays on this site, and logout ends the session", async () => {
  const h = start()
  for (const target of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
    const { callback } = await approve(h, { sub: "google-1" }, { returnTo: target })
    expect((await h.client().raw("GET", callback)).headers.get("location")).toBe("/")
  }
  const { callback } = await approve(h, { sub: "google-1" })
  const cookie = (
    (await h.client().raw("GET", callback)).headers.get("set-cookie") as string
  ).split(";")[0] as string
  const session = h.client({ cookie })
  expect((await session.api("GET", "/me")).status).toBe(200)
  expect((await session.raw("POST", "/auth/logout")).status).toBe(200)
  expect((await session.api("GET", "/me")).status).toBe(401)
  // Dev sign-in does not exist when it is not enabled.
  expect(
    (
      await h.client().raw("POST", "/auth/dev-login", {
        body: '{"email":"a@b.c"}',
        headers: { "x-mockingbird-csrf": "1" },
      })
    ).status,
  ).toBe(404)
  await h.close()
})
