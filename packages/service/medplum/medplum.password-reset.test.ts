/**
 * `POST /auth/resetpassword` and `POST /auth/setpassword` with `UserSecurityRequest`, after
 * auth/resetpassword.ts and auth/setpassword.ts of Medplum v5.1.37.
 */
import { describe, expect, test } from "bun:test"
import type { User, UserSecurityRequest } from "@medplum/fhirtypes"
import {
  createRuntime,
  DEFAULT_PROJECT_ID,
  MedplumAPI,
  type MedplumSecurityRequest,
} from "./src/index.js"

const BASE = "http://localhost:8103/"
// biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
type Json = any

const post = async (
  api: { fetch(request: Request): Promise<Response> },
  path: string,
  body: unknown,
) => {
  const response = await api.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: (await response.json()) as Json }
}

const detail = (result: { body: Json }) => result.body.issue?.[0]?.details?.text

const signIn = (api: MedplumAPI, email: string, password: string) =>
  post(api, "auth/login", { email, password, projectId: DEFAULT_PROJECT_ID, scope: "openid" })

const setup = async () => {
  const emails: MedplumSecurityRequest[] = []
  const api = new MedplumAPI({
    baseUrl: BASE,
    onSecurityRequest: (request) => emails.push(request),
  })
  await api.addUser({ email: "dr@example.org", password: "old-password" })
  return { api, emails }
}

describe("/auth/resetpassword", () => {
  test("answers all-OK whether or not the account exists", async () => {
    const { api, emails } = await setup()
    const known = await post(api, "auth/resetpassword", {
      email: "dr@example.org",
      projectId: DEFAULT_PROJECT_ID,
    })
    const unknown = await post(api, "auth/resetpassword", {
      email: "nobody@example.org",
      projectId: DEFAULT_PROJECT_ID,
    })
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(known.body.issue).toEqual(unknown.body.issue)
    expect(known.body.issue[0].details.text).toBe("All OK")
    expect(emails).toHaveLength(1)
  })

  test("creates a reset UserSecurityRequest with a secret, and hands its link to the harness", async () => {
    const { api, emails } = await setup()
    await post(api, "auth/resetpassword", {
      email: "Dr@Example.org",
      projectId: DEFAULT_PROJECT_ID,
      redirectUri: "https://app.example/after",
    })
    const [stored] = await api.resources<UserSecurityRequest>("UserSecurityRequest")
    expect(stored).toMatchObject({ type: "reset", redirectUri: "https://app.example/after" })
    expect(stored?.secret).toMatch(/\S{16,}/)
    expect(stored?.user?.reference).toMatch(/^User\//)
    expect(emails[0]).toMatchObject({
      id: stored?.id,
      type: "reset",
      secret: stored?.secret,
      email: "dr@example.org",
      url: `http://localhost:3000/setpassword/${stored?.id}/${stored?.secret}`,
      used: false,
    })
    expect(await api.securityRequests()).toHaveLength(1)
  })

  test("sendEmail:false creates the request without notifying", async () => {
    const { api, emails } = await setup()
    await post(api, "auth/resetpassword", {
      email: "dr@example.org",
      projectId: DEFAULT_PROJECT_ID,
      sendEmail: false,
    })
    expect(emails).toHaveLength(0)
    expect(await api.securityRequests()).toHaveLength(1)
  })

  test("without a projectId only project-less users match, like the server", async () => {
    const { api, emails } = await setup()
    await post(api, "auth/resetpassword", { email: "dr@example.org" })
    expect(emails).toHaveLength(0)
    await post(api, "auth/resetpassword", { email: "admin@example.com" })
    expect(emails).toHaveLength(1)
  })

  test("rejects an invalid email", async () => {
    const { api } = await setup()
    const result = await post(api, "auth/resetpassword", { email: "nope" })
    expect(result.status).toBe(400)
    expect(detail(result)).toBe("Valid email address between 3 and 72 characters is required")
  })

  test("refuses domains configured for external auth", async () => {
    const { api } = await setup()
    await api.putResource({
      resourceType: "DomainConfiguration",
      domain: "example.org",
      identityProvider: { authorizeUrl: "https://idp.example/authorize", clientId: "x" },
    })
    const result = await post(api, "auth/resetpassword", { email: "dr@example.org" })
    expect(result.status).toBe(400)
    expect(detail(result)).toBe(
      "Cannot reset password for external auth. Contact your system administrator.",
    )
  })
})

describe("/auth/setpassword", () => {
  const requested = async () => {
    const { api, emails } = await setup()
    await post(api, "auth/resetpassword", {
      email: "dr@example.org",
      projectId: DEFAULT_PROJECT_ID,
    })
    return { api, request: emails[0] as MedplumSecurityRequest }
  }

  test("changes the password once, and the request is single-use", async () => {
    const { api, request } = await requested()
    const set = await post(api, "auth/setpassword", {
      id: request.id,
      secret: request.secret,
      password: "brand-new-password",
    })
    expect(set.status).toBe(200)
    expect((await signIn(api, "dr@example.org", "old-password")).status).toBe(400)
    expect((await signIn(api, "dr@example.org", "brand-new-password")).status).toBe(200)
    expect((await api.securityRequests())[0]?.used).toBe(true)
    const again = await post(api, "auth/setpassword", {
      id: request.id,
      secret: request.secret,
      password: "another-password",
    })
    expect(again.status).toBe(400)
    expect(detail(again)).toBe("Already used")
  })

  test("verifies the email address and revokes existing sessions", async () => {
    const { api, request } = await requested()
    const login = await post(api, "auth/login", {
      email: "dr@example.org",
      password: "old-password",
      projectId: DEFAULT_PROJECT_ID,
      scope: "openid offline_access",
      codeChallenge: "a-verifier-of-sufficient-length-0123456789",
      codeChallengeMethod: "plain",
    })
    const tokens = await api.fetch(
      new Request(`${BASE}oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: login.body.code,
          code_verifier: "a-verifier-of-sufficient-length-0123456789",
        }).toString(),
      }),
    )
    const { refresh_token } = (await tokens.json()) as Json
    expect(refresh_token).toBeString()
    await post(api, "auth/setpassword", {
      id: request.id,
      secret: request.secret,
      password: "brand-new-password",
    })
    const [user] = (await api.resources<User>("User")).filter((u) => u.email === "dr@example.org")
    expect(user?.emailVerified).toBe(true)
    const refreshed = await api.fetch(
      new Request(`${BASE}oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }).toString(),
      }),
    )
    expect(refreshed.status).toBe(400)
    expect(((await refreshed.json()) as Json).error_description).toBe("Token revoked")
  })

  test("refuses an unknown request with 404", async () => {
    const { api } = await requested()
    const result = await post(api, "auth/setpassword", {
      id: "0c0f2f6e-8f3d-4c5c-a0a1-0d9d6f6f0009",
      secret: "x",
      password: "long-enough",
    })
    expect(result.status).toBe(404)
  })

  test("refuses a wrong secret", async () => {
    const { api, request } = await requested()
    const result = await post(api, "auth/setpassword", {
      id: request.id,
      secret: "wrong",
      password: "long-enough",
    })
    expect(result.status).toBe(400)
    expect(detail(result)).toBe("Incorrect secret")
    expect((await signIn(api, "dr@example.org", "old-password")).status).toBe(200)
  })

  test("refuses a verify-email request", async () => {
    const { api } = await requested()
    const [user] = (await api.resources<User>("User")).filter((u) => u.email === "dr@example.org")
    const verify = await api.putResource({
      resourceType: "UserSecurityRequest",
      type: "verify-email",
      secret: "s3cret",
      user: { reference: `User/${user?.id}` },
    })
    const result = await post(api, "auth/setpassword", {
      id: verify.id,
      secret: "s3cret",
      password: "long-enough",
    })
    expect(result.status).toBe(400)
    expect(detail(result)).toBe("Invalid request type")
  })

  test("validates id, secret and password length", async () => {
    const { api, request } = await requested()
    const short = await post(api, "auth/setpassword", {
      id: request.id,
      secret: request.secret,
      password: "short",
    })
    expect(short.status).toBe(400)
    expect(detail(short)).toBe("Password must be at least 8 characters")
    const long = await post(api, "auth/setpassword", {
      id: request.id,
      secret: request.secret,
      password: "x".repeat(73),
    })
    expect(detail(long)).toBe("Password must be no more than 72 characters")
    const bad = await post(api, "auth/setpassword", { id: "not-a-uuid", password: "long-enough" })
    expect(bad.body.issue.map((i: Json) => i.details.text)).toEqual([
      "Invalid request ID",
      "Missing secret",
    ])
  })
})

describe("security-request journal", () => {
  test("GET /__admin/medplum/security-requests lists what the emails would have carried", async () => {
    const runtime = createRuntime()
    const reset = await runtime.fetch(
      new Request(`${BASE}auth/resetpassword`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com" }),
      }),
    )
    expect(reset.status).toBe(200)
    const listed = await runtime.fetch(new Request(`${BASE}__admin/medplum/security-requests`))
    const body = (await listed.json()) as Json
    expect(body.securityRequests).toHaveLength(1)
    expect(body.securityRequests[0]).toMatchObject({
      type: "reset",
      email: "admin@example.com",
      used: false,
    })
    const set = await runtime.fetch(
      new Request(`${BASE}auth/setpassword`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: body.securityRequests[0].id,
          secret: body.securityRequests[0].secret,
          password: "brand-new-password",
        }),
      }),
    )
    expect(set.status).toBe(200)
  })
})
