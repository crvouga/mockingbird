/**
 * Account endpoints a signed-in member or a project admin calls (#750): `POST /auth/changepassword`
 * (auth/changepassword.ts), `POST /auth/google` (auth/google.ts) and
 * `POST /fhir/R4/User/{id}/$update-email` (fhir/operations/update-user-email.ts), after
 * Medplum v5.1.37.
 */
import { describe, expect, test } from "bun:test"
import type { Practitioner, User, UserSecurityRequest } from "@medplum/fhirtypes"
import { base64UrlEncode } from "./src/auth/jwt.js"
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_PROJECT_ID,
  MedplumAPI,
  type MedplumAPIOptions,
  type MedplumSecurityRequest,
} from "./src/index.js"

const BASE = "http://localhost:8103/"
// biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
type Json = any

const call = async (
  api: MedplumAPI,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await api.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  const text = await response.text()
  let parsed: Json = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // keep text
  }
  return { status: response.status, body: parsed, headers: response.headers }
}

const PKCE = {
  codeChallenge: "a-verifier-of-sufficient-length-0123456789",
  codeChallengeMethod: "plain",
}

const detail = (result: { body: Json }) => result.body.issue?.[0]?.details?.text

/** Password login, then the code exchanged for tokens. */
const signIn = async (api: MedplumAPI, email: string, password: string) => {
  const login = await call(api, "POST", "auth/login", {
    email,
    password,
    projectId: DEFAULT_PROJECT_ID,
    scope: "openid",
    ...PKCE,
  })
  if (login.status !== 200) return { status: login.status, body: login.body, token: "" }
  return exchange(api, login.body.code)
}

const exchange = async (api: MedplumAPI, code: string) => {
  const response = await api.fetch(
    new Request(`${BASE}oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: PKCE.codeChallenge,
      }).toString(),
    }),
  )
  const body = (await response.json()) as Json
  return { status: response.status, body, token: body.access_token as string }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe("POST /auth/changepassword", () => {
  const setup = async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    await api.addUser({ email: "member@example.org", password: "old-password" })
    const { token } = await signIn(api, "member@example.org", "old-password")
    return { api, token }
  }

  test("changes the caller's password and revokes their sessions", async () => {
    const { api, token } = await setup()
    const result = await call(
      api,
      "POST",
      "auth/changepassword",
      { oldPassword: "old-password", newPassword: "new-password" },
      bearer(token),
    )
    expect(result.status).toBe(200)
    expect(detail(result)).toBe("All OK")
    expect((await signIn(api, "member@example.org", "new-password")).status).toBe(200)
    const old = await signIn(api, "member@example.org", "old-password")
    expect(old.status).toBe(400)
    expect(detail(old)).toBe("Email or password is invalid")
    expect((await call(api, "GET", "auth/me", undefined, bearer(token))).status).toBe(401)
  })

  test("refuses a wrong old password", async () => {
    const { api, token } = await setup()
    const result = await call(
      api,
      "POST",
      "auth/changepassword",
      { oldPassword: "not-my-password", newPassword: "new-password" },
      bearer(token),
    )
    expect(result.status).toBe(400)
    expect(result.body.issue[0]).toMatchObject({
      code: "invalid",
      details: { text: "Incorrect password" },
      expression: ["oldPassword"],
    })
    expect((await signIn(api, "member@example.org", "old-password")).status).toBe(200)
  })

  test("validates the body as the server does", async () => {
    const { api, token } = await setup()
    const result = await call(
      api,
      "POST",
      "auth/changepassword",
      { newPassword: "short" },
      bearer(token),
    )
    expect(result.status).toBe(400)
    expect(result.body.issue).toEqual([
      {
        severity: "error",
        code: "invalid",
        expression: ["oldPassword"],
        details: { text: "Missing oldPassword" },
      },
      {
        severity: "error",
        code: "invalid",
        expression: ["newPassword"],
        details: { text: "Password must be at least 8 characters" },
      },
    ])
  })

  test("needs a signed-in caller", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const result = await call(api, "POST", "auth/changepassword", {
      oldPassword: "old-password",
      newPassword: "new-password",
    })
    expect(result.status).toBe(401)
    expect(result.body.resourceType).toBe("OperationOutcome")
  })
})

// ------------------------------------------------------------------ Google sign-in

const GOOGLE_CLIENT_ID = "1234-mockingbird.apps.googleusercontent.com"
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs"

/** A stand-in for Google's signing key: the emulator fetches its JWKS through `externalFetch`. */
const fakeGoogle = async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const fetched: string[] = []
  const externalFetch: MedplumAPIOptions["externalFetch"] = async (url) => {
    fetched.push(url)
    if (url !== GOOGLE_CERTS) return new Response("not found", { status: 404 })
    return Response.json({
      keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid: "google-kid", alg: "RS256", use: "sig" }],
    })
  }
  const credential = async (claims: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000)
    const encode = (value: unknown) =>
      base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
    const unsigned = `${encode({ alg: "RS256", kid: "google-kid", typ: "JWT" })}.${encode({
      iss: "https://accounts.google.com",
      aud: GOOGLE_CLIENT_ID,
      iat: now,
      exp: now + 3600,
      sub: "10769150350006150715113082367",
      email: "member@example.org",
      email_verified: true,
      given_name: "Grace",
      family_name: "Hopper",
      ...claims,
    })}`
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(unsigned),
    )
    return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`
  }
  return { externalFetch, credential, fetched }
}

describe("POST /auth/google", () => {
  const setup = async () => {
    const google = await fakeGoogle()
    const api = new MedplumAPI({
      baseUrl: BASE,
      googleClientId: GOOGLE_CLIENT_ID,
      externalFetch: google.externalFetch,
    })
    await api.addUser({ email: "member@example.org", password: "old-password" })
    return { api, google }
  }

  test("signs a member in with a Google credential and answers a code to exchange", async () => {
    const { api, google } = await setup()
    const result = await call(api, "POST", "auth/google", {
      googleClientId: GOOGLE_CLIENT_ID,
      googleCredential: await google.credential({ email: "Member@Example.org" }),
      clientId: DEFAULT_CLIENT_ID,
      ...PKCE,
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ login: expect.any(String), code: expect.any(String) })
    expect(google.fetched).toEqual([GOOGLE_CERTS])
    const tokens = await exchange(api, result.body.code)
    expect(tokens.status).toBe(200)
    expect(tokens.body.scope).toBe("openid offline_access")
    expect(tokens.body.refresh_token).toEqual(expect.any(String))
    const me = await call(api, "GET", "auth/me", undefined, bearer(tokens.token))
    expect(me.body.user.email).toBe("member@example.org")
  })

  test("refuses a credential for another audience, or not signed by Google", async () => {
    const { api, google } = await setup()
    const audience = await call(api, "POST", "auth/google", {
      googleClientId: GOOGLE_CLIENT_ID,
      googleCredential: await google.credential({ aud: "someone-else" }),
      projectId: DEFAULT_PROJECT_ID,
    })
    expect(audience.status).toBe(400)
    expect(detail(audience)).toBe('unexpected "aud" claim value')
    const forged = (await google.credential({})).replace(/\.[^.]+$/, ".AAAA")
    const signature = await call(api, "POST", "auth/google", {
      googleClientId: GOOGLE_CLIENT_ID,
      googleCredential: forged,
      projectId: DEFAULT_PROJECT_ID,
    })
    expect(signature.status).toBe(400)
    expect(detail(signature)).toBe("signature verification failed")
  })

  test("refuses a Google client id that is neither the server's nor a project site's", async () => {
    const { api, google } = await setup()
    const result = await call(api, "POST", "auth/google", {
      googleClientId: "unknown.apps.googleusercontent.com",
      googleCredential: await google.credential({}),
    })
    expect(result.status).toBe(400)
    expect(detail(result)).toBe("Invalid googleClientId")
  })

  test("answers User not found, or creates the user with createUser", async () => {
    const { api, google } = await setup()
    const credential = await google.credential({ email: "new@example.org" })
    const missing = await call(api, "POST", "auth/google", {
      googleClientId: GOOGLE_CLIENT_ID,
      googleCredential: credential,
      projectId: DEFAULT_PROJECT_ID,
    })
    expect(missing.status).toBe(400)
    expect(detail(missing)).toBe("User not found")
    const created = await call(api, "POST", "auth/google", {
      googleClientId: GOOGLE_CLIENT_ID,
      googleCredential: credential,
      projectId: DEFAULT_PROJECT_ID,
      createUser: true,
    })
    expect(created.status).toBe(200)
    expect(created.body).toEqual({ login: expect.any(String), memberships: [] })
    const users = await api.resources<User>("User")
    expect(users.find((u) => u.email === "new@example.org")).toMatchObject({
      firstName: "Grace",
      lastName: "Hopper",
      project: { reference: `Project/${DEFAULT_PROJECT_ID}` },
    })
  })

  test("validates the body as the server does", async () => {
    const { api } = await setup()
    const result = await call(api, "POST", "auth/google", {})
    expect(result.status).toBe(400)
    expect(result.body.issue.map((issue: Json) => issue.details.text)).toEqual([
      "Missing googleClientId",
      "Missing googleCredential",
    ])
  })
})

// ------------------------------------------------------------------ $update-email

describe("POST /fhir/R4/User/{id}/$update-email", () => {
  const setup = async () => {
    const emails: MedplumSecurityRequest[] = []
    const api = new MedplumAPI({
      baseUrl: BASE,
      onSecurityRequest: (request) => emails.push(request),
    })
    const member = await api.addUser({ email: "member@example.org", password: "old-password" })
    const admin = await api.accessToken()
    return { api, member, admin, emails }
  }

  test("changes the login email, updates the profile telecom and sends a verification", async () => {
    const { api, member, admin, emails } = await setup()
    const result = await call(
      api,
      "POST",
      `fhir/R4/User/${member.user.id}/$update-email`,
      { email: "renamed@example.org", updateProfileTelecom: true },
      bearer(admin),
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      resourceType: "User",
      id: member.user.id,
      email: "renamed@example.org",
      emailVerified: false,
    })
    // As on the server, the answer is the User as the system wrote it, password hash included.
    expect(result.body.passwordHash).toEqual(expect.any(String))
    expect(result.body.meta.author).toEqual({ reference: "system" })
    expect((await signIn(api, "renamed@example.org", "old-password")).status).toBe(200)
    expect((await signIn(api, "member@example.org", "old-password")).status).toBe(400)

    const [profile] = await api
      .resources<Practitioner>("Practitioner")
      .then((all) => all.filter((p) => p.id === member.profile.id))
    expect(profile?.telecom).toEqual([
      { system: "email", use: "old", value: "member@example.org" },
      { system: "email", use: "work", value: "renamed@example.org" },
    ])

    const requests = await api.resources<UserSecurityRequest>("UserSecurityRequest")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      type: "verify-email",
      user: { reference: `User/${member.user.id}` },
    })
    expect(emails).toEqual([
      expect.objectContaining({
        type: "verify-email",
        email: "renamed@example.org",
        url: `http://localhost:3000/verifyemail/${requests[0]?.id}/${requests[0]?.secret}`,
      }),
    ])
  })

  test("skipEmailVerification sends nothing and leaves the profile alone", async () => {
    const { api, member, admin, emails } = await setup()
    const result = await call(
      api,
      "POST",
      `fhir/R4/User/${member.user.id}/%24update-email`,
      {
        resourceType: "Parameters",
        parameter: [
          { name: "email", valueString: "quiet@example.org" },
          { name: "skipEmailVerification", valueBoolean: true },
        ],
      },
      bearer(admin),
    )
    expect(result.status).toBe(200)
    expect(result.body.email).toBe("quiet@example.org")
    expect(emails).toEqual([])
    expect(await api.resources("UserSecurityRequest")).toEqual([])
    const profile = (await api.resources<Practitioner>("Practitioner")).find(
      (p) => p.id === member.profile.id,
    )
    expect(profile?.telecom).toEqual([
      { system: "email", use: "work", value: "member@example.org" },
    ])
  })

  test("is for project admins only, and needs an email", async () => {
    const { api, member, admin } = await setup()
    const { token } = await signIn(api, "member@example.org", "old-password")
    const forbidden = await call(
      api,
      "POST",
      `fhir/R4/User/${member.user.id}/$update-email`,
      { email: "mine@example.org" },
      bearer(token),
    )
    expect(forbidden.status).toBe(403)
    expect(detail(forbidden)).toBe("Forbidden")
    const missing = await call(
      api,
      "POST",
      `fhir/R4/User/${member.user.id}/$update-email`,
      {},
      bearer(admin),
    )
    expect(missing.status).toBe(400)
    expect(detail(missing)).toBe(
      "Expected at least 1 value(s) for required input parameter 'email'",
    )
  })
})
