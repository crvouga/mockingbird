/**
 * `X-Medplum-On-Behalf-Of` (#751), after `tryAddOnBehalfOf` in oauth/utils.ts and
 * `getRepoForLogin` in fhir/accesspolicy.ts of Medplum v5.1.37: a project admin acts as another
 * member. Writes keep the caller in `meta.author` and record the member in `meta.onBehalfOf`,
 * and the member's access policy applies.
 */
import { describe, expect, test } from "bun:test"
import { DEFAULT_CLIENT_ID, DEFAULT_PROJECT_ID, MedplumAPI } from "./src/index.js"

const BASE = "http://localhost:8103/"
// biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
type Json = any

const call = async (
  api: MedplumAPI,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) => {
  const response = await api.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/fhir+json", "x-medplum": "extended", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: response.status, body: (await response.json()) as Json }
}

const communication = { resourceType: "Communication", status: "completed" }

const setup = async () => {
  const api = new MedplumAPI({ baseUrl: BASE })
  const member = await api.addUser({ email: "dr@example.org", password: "long-password" })
  const admin = await api.accessToken()
  return { api, member, admin }
}

describe("X-Medplum-On-Behalf-Of", () => {
  test("a write records the caller as meta.author and the member as meta.onBehalfOf", async () => {
    const { api, member, admin } = await setup()
    const headers = {
      authorization: `Bearer ${admin}`,
      "x-medplum-on-behalf-of": `Practitioner/${member.profile.id}`,
    }
    const created = await call(api, "POST", "fhir/R4/Communication", headers, communication)
    expect(created.status).toBe(201)
    expect(created.body.meta).toMatchObject({
      author: { reference: `ClientApplication/${DEFAULT_CLIENT_ID}` },
      onBehalfOf: { reference: `Practitioner/${member.profile.id}` },
    })
    const read = await call(api, "GET", `fhir/R4/Communication/${created.body.id}`, {
      authorization: `Bearer ${admin}`,
    })
    expect(read.body.meta.onBehalfOf).toMatchObject({
      reference: `Practitioner/${member.profile.id}`,
    })
  })

  test("a ProjectMembership reference names the member too", async () => {
    const { api, member, admin } = await setup()
    const created = await call(
      api,
      "POST",
      "fhir/R4/Communication",
      {
        authorization: `Bearer ${admin}`,
        "x-medplum-on-behalf-of": `ProjectMembership/${member.membership.id}`,
      },
      communication,
    )
    expect(created.status).toBe(201)
    expect(created.body.meta.onBehalfOf).toMatchObject({
      reference: `Practitioner/${member.profile.id}`,
    })
  })

  test("the member's access policy applies, not the admin's", async () => {
    const { api, member, admin } = await setup()
    const asAdmin = await call(api, "GET", "fhir/R4/ProjectMembership", {
      authorization: `Bearer ${admin}`,
    })
    const asMember = await call(api, "GET", "fhir/R4/ProjectMembership", {
      authorization: `Bearer ${admin}`,
      "x-medplum-on-behalf-of": `Practitioner/${member.profile.id}`,
    })
    expect(asAdmin.body.entry.length).toBeGreaterThan(0)
    expect(asMember.status).toBe(403)
  })

  test("a non-admin caller, or a profile with no membership, is an authentication error", async () => {
    const { api, member, admin } = await setup()
    const login = await api.fetch(
      new Request(`${BASE}auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "dr@example.org",
          password: "long-password",
          projectId: DEFAULT_PROJECT_ID,
          scope: "openid",
          codeChallenge: "verifier",
          codeChallengeMethod: "plain",
        }),
      }),
    )
    const { code } = (await login.json()) as Json
    const tokens = await api.fetch(
      new Request(`${BASE}oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: "verifier",
        }).toString(),
      }),
    )
    const memberToken = ((await tokens.json()) as Json).access_token
    const notAdmin = await call(
      api,
      "POST",
      "fhir/R4/Communication",
      {
        authorization: `Bearer ${memberToken}`,
        "x-medplum-on-behalf-of": `Practitioner/${member.profile.id}`,
      },
      communication,
    )
    expect(notAdmin.status).toBe(400)
    expect(notAdmin.body.issue[0]).toMatchObject({
      code: "invalid",
      details: { text: "Authentication error" },
      diagnostics: "OperationOutcomeError: Forbidden",
    })
    const unknown = await call(
      api,
      "POST",
      "fhir/R4/Communication",
      {
        authorization: `Bearer ${admin}`,
        "x-medplum-on-behalf-of": "Practitioner/00000000-0000-4000-8000-000000000000",
      },
      communication,
    )
    expect(unknown.status).toBe(400)
    expect(unknown.body.issue[0].diagnostics).toBe("OperationOutcomeError: Forbidden")
    expect(await api.resources("Communication")).toEqual([])
  })
})
