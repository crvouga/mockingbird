/**
 * Tokens: ES384 JWTs a third party can verify from `/.well-known/jwks.json`, with the
 * server's claims, lifetimes and one-time codes; refresh rotation; revocation; and the
 * checks that keep an id or refresh token from being used as an access token.
 */
import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import type { ProjectMembership } from "@medplum/fhirtypes"
import { base64UrlDecode, decodeJwt } from "./src/auth/jwt.js"
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_PROJECT_ID,
  MedplumAPI,
} from "./src/index.js"

const BASE = "http://localhost:8103/"

const call = async (api: MedplumAPI, path: string, init: RequestInit = {}) => {
  const response = await api.fetch(new Request(`${BASE}${path.replace(/^\//, "")}`, init))
  const text = await response.text()
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep text
  }
  return { status: response.status, body }
}

const token = (api: MedplumAPI, values: Record<string, string>) =>
  call(api, "/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  })

const clientCredentials = (api: MedplumAPI) =>
  token(api, {
    grant_type: "client_credentials",
    client_id: DEFAULT_CLIENT_ID,
    client_secret: DEFAULT_CLIENT_SECRET,
  })

const s256 = async (verifier: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  )
  let binary = ""
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const practitionerLogin = async (api: MedplumAPI, scope = "openid offline_access") => {
  await api.addUser({ email: "dr@example.org", password: "long-password", admin: false })
  const verifier = "a-verifier-of-sufficient-length-0123456789"
  const login = await call(api, "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "dr@example.org",
      password: "long-password",
      projectId: DEFAULT_PROJECT_ID,
      scope,
      codeChallenge: await s256(verifier),
      codeChallengeMethod: "S256",
    }),
  })
  return { code: login.body.code as string, verifier }
}

describe("tokens", () => {
  test("access tokens verify against the published JWKS with plain WebCrypto", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { body } = await clientCredentials(api)
    const jwks = await call(api, "/.well-known/jwks.json")
    const [jwk] = jwks.body.keys
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-384", alg: "ES384", use: "sig" })
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["verify"],
    )
    const [header, payload, signature] = body.access_token.split(".")
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-384" },
      key,
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(ok).toBe(true)
    expect(decodeJwt(body.access_token)?.header).toMatchObject({
      alg: "ES384",
      kid: jwk.kid,
      typ: "JWT",
    })
  })

  test("claims match the server's: issuer, audience, client, subject, profile, lifetime", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { body } = await clientCredentials(api)
    const claims = decodeJwt(body.access_token)?.payload ?? {}
    expect(claims).toMatchObject({
      iss: BASE,
      aud: BASE,
      client_id: DEFAULT_CLIENT_ID,
      sub: DEFAULT_CLIENT_ID,
      username: DEFAULT_CLIENT_ID,
      scope: "openid",
      profile: `ClientApplication/${DEFAULT_CLIENT_ID}`,
    })
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600)
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "openid" })
    expect(body.refresh_token).toBeUndefined()
    const id = decodeJwt(body.id_token)?.payload ?? {}
    expect(id).toMatchObject({
      aud: DEFAULT_CLIENT_ID,
      fhirUser: `ClientApplication/${DEFAULT_CLIENT_ID}`,
    })
  })

  test("an id token or a refresh token is not accepted as an access token", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { code, verifier } = await practitionerLogin(api)
    const issued = await token(api, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    })
    expect(issued.status).toBe(200)
    for (const wrong of [issued.body.id_token, issued.body.refresh_token]) {
      expect(
        (await call(api, "/fhir/R4/Patient", { headers: { authorization: `Bearer ${wrong}` } }))
          .status,
      ).toBe(401)
    }
    expect(
      (
        await call(api, "/fhir/R4/Patient", {
          headers: { authorization: `Bearer ${issued.body.access_token}` },
        })
      ).status,
    ).toBe(200)
  })

  test("a tampered token is refused", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { body } = await clientCredentials(api)
    const [header, payload, signature] = body.access_token.split(".")
    const forged = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")))
    forged.scope = "openid system/*.*"
    const tampered = `${header}.${btoa(JSON.stringify(forged)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.${signature}`
    expect(
      (await call(api, "/fhir/R4/Patient", { headers: { authorization: `Bearer ${tampered}` } }))
        .status,
    ).toBe(401)
  })

  test("tokens expire with the clock", async () => {
    const clock = createClock()
    const api = new MedplumAPI({ baseUrl: BASE, now: clock.now })
    const { body } = await clientCredentials(api)
    const auth = { authorization: `Bearer ${body.access_token}` }
    expect((await call(api, "/fhir/R4/Patient", { headers: auth })).status).toBe(200)
    clock.advance(3601 * 1000)
    expect((await call(api, "/fhir/R4/Patient", { headers: auth })).status).toBe(401)
  })

  test("PKCE S256: the right verifier exchanges once; a wrong one never", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { code, verifier } = await practitionerLogin(api)
    const wrong = await token(api, {
      grant_type: "authorization_code",
      code,
      code_verifier: `${verifier}x`,
    })
    expect(wrong.body).toEqual({
      error: "invalid_request",
      error_description: "Invalid code verifier",
    })
    const right = await token(api, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    })
    expect(right.status).toBe(200)
    expect(decodeJwt(right.body.access_token)?.payload.profile).toStartWith("Practitioner/")
    const replay = await token(api, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    })
    expect(replay.body).toEqual({
      error: "invalid_grant",
      error_description: "Token already granted",
    })
    // Replaying a granted code revokes the login it came from.
    expect(
      (
        await call(api, "/fhir/R4/Patient", {
          headers: { authorization: `Bearer ${right.body.access_token}` },
        })
      ).status,
    ).toBe(401)
  })

  test("refresh tokens rotate: each works once, and the new pair works", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { code, verifier } = await practitionerLogin(api)
    const first = await token(api, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    })
    expect(first.body.refresh_token).toBeString()
    const second = await token(api, {
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
    })
    expect(second.status).toBe(200)
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token)
    const reused = await token(api, {
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
    })
    expect(reused.body).toEqual({ error: "invalid_request", error_description: "Invalid token" })
    expect(
      (
        await call(api, "/fhir/R4/Patient", {
          headers: { authorization: `Bearer ${second.body.access_token}` },
        })
      ).status,
    ).toBe(200)
  })

  test("logout revokes the login, and every token it issued", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { code, verifier } = await practitionerLogin(api)
    const issued = await token(api, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    })
    const auth = { authorization: `Bearer ${issued.body.access_token}` }
    expect((await call(api, "/oauth2/logout", { method: "POST", headers: auth })).status).toBe(200)
    expect((await call(api, "/auth/me", { headers: auth })).status).toBe(401)
    const refreshed = await token(api, {
      grant_type: "refresh_token",
      refresh_token: issued.body.refresh_token,
    })
    expect(refreshed.body).toEqual({ error: "invalid_grant", error_description: "Token revoked" })
  })

  test("a deactivated membership stops Basic and bearer access", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { body } = await clientCredentials(api)
    const memberships = await api.resources<ProjectMembership>("ProjectMembership")
    const membership = memberships.find(
      (m) => m.user?.reference === `ClientApplication/${DEFAULT_CLIENT_ID}`,
    )
    await api.putResource({ ...membership, active: false } as never)
    expect(
      (
        await call(api, "/fhir/R4/Patient", {
          headers: { authorization: `Bearer ${body.access_token}` },
        })
      ).status,
    ).toBe(401)
    const basic = {
      authorization: `Basic ${btoa(`${DEFAULT_CLIENT_ID}:${DEFAULT_CLIENT_SECRET}`)}`,
    }
    expect((await call(api, "/fhir/R4/Patient", { headers: basic })).status).toBe(401)
  })
})
