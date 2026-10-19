/**
 * RFC 8693 token exchange (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`), after
 * `exchangeExternalAuthToken` in Medplum's oauth/token.ts (v5.1.37): the subject token is an access
 * token of the client application's `identityProvider`, verified through its userinfo endpoint.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { decodeJwt } from "./src/auth/jwt.js"
import { DEFAULT_PROJECT_ID, MedplumAPI } from "./src/index.js"

const BASE = "http://localhost:8103/"
const FEDERATED = "0c0f2f6e-8f3d-4c5c-a0a1-0d9d6f6f0001"
const PLAIN = "0c0f2f6e-8f3d-4c5c-a0a1-0d9d6f6f0002"
const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
const ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token"

// biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
type Json = any

const exchange = async (api: MedplumAPI, values: Record<string, string>) => {
  const response = await api.fetch(
    new Request(`${BASE}oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
    }),
  )
  return { status: response.status, body: (await response.json()) as Json }
}

/** A local OIDC provider: `GET /userinfo` answers for the tokens in `claims`. */
let provider: ReturnType<typeof Bun.serve>
let userInfoUrl = ""
const claims = new Map<string, Record<string, unknown>>()
let seeded: Awaited<ReturnType<MedplumAPI["addUser"]>>
let mode: "json" | "jwt" | "html" | "limited" | "down" = "json"

beforeAll(() => {
  provider = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (mode === "limited") return new Response("slow down", { status: 429 })
      if (mode === "down") return new Response("nope", { status: 500 })
      const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? ""
      const body = claims.get(token)
      if (!body) return new Response("unauthorized", { status: 401 })
      if (mode === "html")
        return new Response("<html/>", { headers: { "content-type": "text/html" } })
      if (mode === "jwt") {
        const encode = (value: object) =>
          btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
        return new Response(`${encode({ alg: "none" })}.${encode(body)}.sig`, {
          headers: { "content-type": "application/jwt" },
        })
      }
      return Response.json(body)
    },
  })
  userInfoUrl = `http://localhost:${provider.port}/userinfo`
})
afterAll(() => provider.stop(true))

const setup = async (identityProvider: Record<string, unknown> = { userInfoUrl }) => {
  mode = "json"
  claims.clear()
  claims.set("good-token", { sub: "idp-user-1", email: "Dr.Who@Example.org" })
  const api = new MedplumAPI({ baseUrl: BASE })
  seeded = await api.addUser({
    email: "dr.who@example.org",
    password: "long-password",
    firstName: "Dr",
  })
  await api.putClient({ id: FEDERATED, identityProvider })
  return api
}

const valid = {
  grant_type: GRANT,
  client_id: FEDERATED,
  subject_token: "good-token",
  subject_token_type: ACCESS_TOKEN,
}

describe("token exchange", () => {
  test("signs in the user whose email the identity provider returns", async () => {
    const api = await setup()
    const { status, body } = await exchange(api, valid)
    expect(status).toBe(200)
    expect(body).toMatchObject({ token_type: "Bearer", scope: "openid offline_access" })
    expect(body.project.reference).toBe(`Project/${DEFAULT_PROJECT_ID}`)
    expect(body.profile.reference).toMatch(/^Practitioner\//)
    expect(body.refresh_token).toBeString()
    const claimsOf = decodeJwt(body.access_token)?.payload
    expect(claimsOf?.client_id).toBe(FEDERATED)
    // The issued access token works against the FHIR API as that user.
    const me = await api.fetch(
      new Request(`${BASE}auth/me`, { headers: { authorization: `Bearer ${body.access_token}` } }),
    )
    expect(((await me.json()) as Json).user.email).toBe("dr.who@example.org")
  })

  test("a requested scope without offline_access issues no refresh token", async () => {
    const api = await setup()
    const { body } = await exchange(api, { ...valid, scope: "openid" })
    expect(body.scope).toBe("openid")
    expect(body.refresh_token).toBeUndefined()
  })

  test("a refresh token from the exchange can be redeemed", async () => {
    const api = await setup()
    const { body } = await exchange(api, valid)
    const refreshed = await exchange(api, {
      grant_type: "refresh_token",
      refresh_token: body.refresh_token,
    })
    expect(refreshed.status).toBe(200)
  })

  test("validates the request in the server's order", async () => {
    const api = await setup()
    expect(await exchange(api, { grant_type: GRANT })).toEqual({
      status: 400,
      body: { error: "invalid_request", error_description: "Invalid client" },
    })
    expect((await exchange(api, { ...valid, subject_token: "" })).body.error_description).toBe(
      "Invalid subject_token",
    )
    expect(
      (
        await exchange(api, {
          ...valid,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        })
      ).body.error_description,
    ).toBe("Invalid subject_token_type")
    expect(
      (await exchange(api, { ...valid, client_id: "0c0f2f6e-8f3d-4c5c-a0a1-0d9d6f6f00ff" })).body
        .error_description,
    ).toBe("Invalid client")
  })

  test("a client without an identityProvider cannot exchange", async () => {
    const api = await setup()
    await api.putClient({ id: PLAIN })
    const { status, body } = await exchange(api, { ...valid, client_id: PLAIN })
    expect(status).toBe(400)
    expect(body.error_description).toBe("Invalid client")
  })

  test("an identityProvider without userInfoUrl is refused", async () => {
    const api = await setup({ clientId: "idp" })
    expect((await exchange(api, valid)).body.error_description).toBe("Missing user info URL")
  })

  test("a token the provider rejects fails with the provider-verification error", async () => {
    const api = await setup()
    const { status, body } = await exchange(api, { ...valid, subject_token: "forged" })
    expect(status).toBe(400)
    expect(body).toEqual({
      error: "invalid_request",
      error_description: "Failed to verify code - check your identity provider configuration",
    })
    mode = "down"
    expect((await exchange(api, valid)).status).toBe(400)
  })

  test("a rate-limited provider answers 429", async () => {
    const api = await setup()
    mode = "limited"
    const { status, body } = await exchange(api, valid)
    expect(status).toBe(429)
    expect(body.error).toBe("invalid_request")
  })

  test("an unsupported userinfo content type is refused", async () => {
    const api = await setup()
    mode = "html"
    expect((await exchange(api, valid)).body.error_description).toBe(
      "Failed to verify code - unsupported content type: text/html",
    )
  })

  test("a JWT userinfo response is accepted", async () => {
    const api = await setup()
    mode = "jwt"
    expect((await exchange(api, valid)).status).toBe(200)
  })

  test("an unknown email, or a userinfo without one, is a 'User not found' / missing-identity outcome", async () => {
    const api = await setup()
    claims.set("stranger", { sub: "x", email: "stranger@example.org" })
    const unknown = await exchange(api, { ...valid, subject_token: "stranger" })
    expect(unknown.status).toBe(400)
    expect(unknown.body.resourceType).toBe("OperationOutcome")
    expect(unknown.body.issue[0].details.text).toBe("User not found")
    claims.set("no-email", { sub: "x" })
    const missing = await exchange(api, { ...valid, subject_token: "no-email" })
    expect(missing.body.issue[0].details.text).toBe("Missing email or externalId")
  })

  test("useSubject finds the user by the membership's externalId", async () => {
    const api = await setup({ userInfoUrl, useSubject: true })
    expect((await exchange(api, valid)).body.issue[0].details.text).toBe("User not found")
    await api.putResource({ ...seeded.membership, externalId: "idp-user-1" } as never)
    expect((await exchange(api, valid)).status).toBe(200)
  })

  test("membership_id restricts the sign-in to that membership", async () => {
    const api = await setup()
    const { status, body } = await exchange(api, { ...valid, membership_id: "no-such-membership" })
    expect(status).toBe(400)
    expect(body.issue[0].details.text).toBe("User not found")
  })

  test("an injected externalFetch replaces the network", async () => {
    const api = new MedplumAPI({
      baseUrl: BASE,
      externalFetch: async (input, init) => {
        expect(String(input)).toBe("https://idp.invalid/userinfo")
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t")
        return Response.json({ email: "a@example.org" })
      },
    })
    await api.addUser({ email: "a@example.org", password: "long-password" })
    await api.putClient({
      id: PLAIN,
      identityProvider: { userInfoUrl: "https://idp.invalid/userinfo" },
    })
    const { status } = await exchange(api, { ...valid, client_id: PLAIN, subject_token: "t" })
    expect(status).toBe(200)
  })
})
