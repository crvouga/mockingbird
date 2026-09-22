/**
 * The Mockingbird service contract around the Medplum mock: `/health`, the `x-mockingbird`
 * stamp, namespaces (header, `/ns/<name>/` prefix, client credentials), per-namespace reset,
 * snapshot/restore, the controllable clock, fault presets, the request journal and metrics,
 * and the `/__admin/medplum/*` backdoors.
 */
import { describe, expect, test } from "bun:test"
import { createClock, DroppedConnectionError } from "@crvouga/mockingbird-service"
import {
  createRuntime,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_PROJECT_ID,
  MEDPLUM_PRESETS,
  type MedplumRuntime,
} from "./src/index.js"

const BASE = "http://localhost:8103"

const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
})

const call = async (runtime: MedplumRuntime, path: string, init: RequestInit = {}) => {
  const response = await runtime.fetch(new Request(`${BASE}${path}`, init))
  const text = await response.text()
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep text
  }
  return { status: response.status, headers: response.headers, body }
}

const signIn = async (
  runtime: MedplumRuntime,
  headers: Record<string, string> = {},
  clientId = DEFAULT_CLIENT_ID,
  secret = DEFAULT_CLIENT_SECRET,
) => {
  const init = form({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: secret,
  })
  const token = await call(runtime, "/oauth2/token", {
    ...init,
    headers: { ...init.headers, ...headers },
  })
  expect(token.status).toBe(200)
  return token.body.access_token as string
}

const fhir = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/fhir+json",
  ...extra,
})

const createPatient = (
  runtime: MedplumRuntime,
  token: string,
  family: string,
  extra: Record<string, string> = {},
) =>
  call(runtime, "/fhir/R4/Patient", {
    method: "POST",
    headers: fhir(token, extra),
    body: JSON.stringify({ resourceType: "Patient", name: [{ family }] }),
  })

describe("service contract", () => {
  test("/health needs no credentials and names the Medplum version", async () => {
    const runtime = createRuntime()
    const health = await call(runtime, "/health")
    expect(health.status).toBe(200)
    expect(health.body.status).toBe("ok")
    expect(health.body.medplum).toMatch(/^5\.1\.37/)
    expect((await call(runtime, "/healthcheck")).body.ok).toBe(true)
  })

  test("every response is stamped x-mockingbird with the namespace", async () => {
    const runtime = createRuntime()
    const response = await runtime.fetch(
      new Request(`${BASE}/healthcheck`, { headers: { "x-mockingbird-namespace": "w1" } }),
    )
    expect(response.headers.get("x-mockingbird")).toMatch(/^medplum@.+; ns=w1$/)
  })

  test("namespaces keep workers apart, and tokens do not cross them", async () => {
    const runtime = createRuntime()
    const one = await signIn(runtime, { "x-mockingbird-namespace": "one" })
    const two = await signIn(runtime, { "x-mockingbird-namespace": "two" })
    await createPatient(runtime, one, "OnlyInOne", { "x-mockingbird-namespace": "one" })
    const inTwo = await call(runtime, "/fhir/R4/Patient?name=onlyinone&_total=accurate", {
      headers: fhir(two, { "x-mockingbird-namespace": "two" }),
    })
    expect(inTwo.body.total).toBe(0)
    const crossed = await call(runtime, "/fhir/R4/Patient", {
      headers: fhir(one, { "x-mockingbird-namespace": "two" }),
    })
    expect(crossed.status).toBe(401)
  })

  test("/ns/<name>/ selects a namespace for SDKs that only take a base URL", async () => {
    const runtime = createRuntime()
    const token = await signIn(runtime)
    const prefixed = await call(
      runtime,
      "/ns/p1/oauth2/token",
      form({
        grant_type: "client_credentials",
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
      }),
    )
    await call(runtime, "/ns/p1/fhir/R4/Patient", {
      method: "POST",
      headers: fhir(prefixed.body.access_token),
      body: JSON.stringify({ resourceType: "Patient", name: [{ family: "Prefixed" }] }),
    })
    expect(
      (
        await call(runtime, "/ns/p1/fhir/R4/Patient?name=prefixed&_total=accurate", {
          headers: fhir(prefixed.body.access_token),
        })
      ).body.total,
    ).toBe(1)
    expect(
      (
        await call(runtime, "/fhir/R4/Patient?name=prefixed&_total=accurate", {
          headers: fhir(token),
        })
      ).body.total,
    ).toBe(0)
  })

  test("client ids map to namespaces, including the form-body token request", async () => {
    const runtime = createRuntime()
    const client = await call(
      runtime,
      "/__admin/medplum/clients/7d0f5b8e-1c1c-4c1c-8c1c-0000000000a1?namespace=mapped",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "worker-secret" }),
      },
    )
    expect(client.status).toBe(200)
    await call(runtime, "/__admin/credentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentials: { "7d0f5b8e-1c1c-4c1c-8c1c-0000000000a1": "mapped" } }),
    })
    const token = await signIn(runtime, {}, "7d0f5b8e-1c1c-4c1c-8c1c-0000000000a1", "worker-secret")
    const created = await createPatient(runtime, token, "Mapped")
    expect(created.status).toBe(201)
    expect(created.headers.get("x-mockingbird")).toContain("ns=mapped")
    const basic = await call(runtime, "/fhir/R4/Patient?name=mapped&_total=accurate", {
      headers: {
        authorization: `Basic ${btoa("7d0f5b8e-1c1c-4c1c-8c1c-0000000000a1:worker-secret")}`,
      },
    })
    expect(basic.body.total).toBe(1)
  })

  test("reset clears one namespace and reseeds it; the other keeps its data", async () => {
    const runtime = createRuntime()
    const a = await signIn(runtime, { "x-mockingbird-namespace": "a" })
    const b = await signIn(runtime, { "x-mockingbird-namespace": "b" })
    await createPatient(runtime, a, "Keep", { "x-mockingbird-namespace": "a" })
    await createPatient(runtime, b, "Drop", { "x-mockingbird-namespace": "b" })
    expect((await call(runtime, "/__admin/reset?namespace=b", { method: "POST" })).status).toBe(200)
    const again = await signIn(runtime, { "x-mockingbird-namespace": "b" })
    expect(
      (
        await call(runtime, "/fhir/R4/Patient?_total=accurate", {
          headers: fhir(again, { "x-mockingbird-namespace": "b" }),
        })
      ).body.total,
    ).toBe(0)
    expect(
      (
        await call(runtime, "/fhir/R4/Patient?_total=accurate", {
          headers: fhir(a, { "x-mockingbird-namespace": "a" }),
        })
      ).body.total,
    ).toBe(1)
  })

  test("a snapshot rolls a namespace back", async () => {
    const runtime = createRuntime()
    const token = await signIn(runtime)
    await createPatient(runtime, token, "Before")
    const snapshot = runtime.snapshot()
    await createPatient(runtime, token, "After")
    runtime.restore(snapshot)
    const all = await call(runtime, "/fhir/R4/Patient?_total=accurate", { headers: fhir(token) })
    expect(
      all.body.entry.map(
        (e: { resource: { name: { family: string }[] } }) => e.resource.name[0]?.family,
      ),
    ).toEqual(["Before"])
  })

  test("the clock drives lastUpdated and token expiry", async () => {
    const clock = createClock(() => Date.parse("2030-01-01T00:00:00Z"))
    clock.freeze()
    const runtime = createRuntime({ clock })
    const token = await signIn(runtime)
    const created = await createPatient(runtime, token, "Clocked")
    expect(created.body.meta.lastUpdated).toBe("2030-01-01T00:00:00.000Z")
    clock.advance(2 * 60 * 60 * 1000)
    const expired = await call(runtime, "/fhir/R4/Patient", { headers: fhir(token) })
    expect(expired.status).toBe(401)
  })

  test("fault presets reproduce Medplum's failure shapes", async () => {
    const runtime = createRuntime()
    const token = await signIn(runtime)
    expect(Object.keys(MEDPLUM_PRESETS)).toContain("rate_limited")
    await call(runtime, "/__admin/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "rate_limited", count: 1 }),
    })
    const limited = await call(runtime, "/fhir/R4/Patient", { headers: fhir(token) })
    expect(limited.status).toBe(429)
    expect(limited.body.issue[0].code).toBe("throttled")
    expect((await call(runtime, "/fhir/R4/Patient", { headers: fhir(token) })).status).toBe(200)

    await call(runtime, "/__admin/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "write_drop", count: 1 }),
    })
    await expect(createPatient(runtime, token, "Dropped")).rejects.toBeInstanceOf(
      DroppedConnectionError,
    )
  })

  test("the journal names each Medplum operation", async () => {
    const runtime = createRuntime()
    const token = await signIn(runtime)
    const created = await createPatient(runtime, token, "Journal")
    await call(runtime, `/fhir/R4/Patient/${created.body.id}`, { headers: fhir(token) })
    await call(runtime, "/fhir/R4/Observation?code=x", { headers: fhir(token) })
    const journal = await call(runtime, "/__admin/requests")
    const operations = journal.body.requests.map((r: { operationId: string }) => r.operationId)
    expect(operations).toContain("PostOauth2Token")
    expect(operations).toContain("CreatePatient")
    expect(operations).toContain("ReadPatient")
    expect(operations).toContain("FhirSearch")
  })

  test("/__admin/medplum describes the seeded credentials", async () => {
    const runtime = createRuntime({ baseUrl: "https://medplum.test/" })
    const info = await call(runtime, "/__admin/medplum")
    expect(info.body.baseUrl).toBe("https://medplum.test/")
    expect(info.body.project).toEqual({
      id: DEFAULT_PROJECT_ID,
      clientId: DEFAULT_CLIENT_ID,
      clientSecret: DEFAULT_CLIENT_SECRET,
    })
    expect(info.body.superAdmin.email).toBe("admin@example.com")
  })

  test("/__admin/medplum/resources seeds resources with their ids; /users adds a password login", async () => {
    const runtime = createRuntime()
    const seeded = await call(runtime, "/__admin/medplum/resources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          resourceType: "Patient",
          id: "11111111-1111-4111-8111-111111111111",
          name: [{ family: "Seeded" }],
        },
        { resourceType: "Organization", name: "Seed Org" },
      ]),
    })
    expect(seeded.status).toBe(200)
    expect(seeded.body.resources[0].id).toBe("11111111-1111-4111-8111-111111111111")
    const token = await signIn(runtime)
    expect(
      (
        await call(runtime, "/fhir/R4/Patient/11111111-1111-4111-8111-111111111111", {
          headers: fhir(token),
        })
      ).body.name[0].family,
    ).toBe("Seeded")

    const invalid = await call(runtime, "/__admin/medplum/resources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "Observation" }),
    })
    expect(invalid.status).toBe(400)

    const user = await call(runtime, "/__admin/medplum/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "nurse@example.org",
        password: "correct-horse",
        firstName: "Flo",
        lastName: "Nightingale",
      }),
    })
    expect(user.status).toBe(201)
    const login = await call(runtime, "/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "nurse@example.org",
        password: "correct-horse",
        projectId: DEFAULT_PROJECT_ID,
        codeChallenge: "c",
        codeChallengeMethod: "plain",
      }),
    })
    expect(login.body.code).toBeString()
  })

  test("/__admin/medplum/token mints a token; logins/revoke invalidates every token", async () => {
    const runtime = createRuntime()
    const minted = await call(runtime, "/__admin/medplum/token", { method: "POST" })
    expect(
      (await call(runtime, "/fhir/R4/Patient", { headers: fhir(minted.body.access_token) })).status,
    ).toBe(200)
    const revoked = await call(runtime, "/__admin/medplum/logins/revoke", { method: "POST" })
    expect(revoked.body.revoked).toBeGreaterThan(0)
    expect(
      (await call(runtime, "/fhir/R4/Patient", { headers: fhir(minted.body.access_token) })).status,
    ).toBe(401)
  })

  test("an admin key locks /__admin but not the Medplum API", async () => {
    const runtime = createRuntime({ adminKey: "sekrit" })
    expect((await call(runtime, "/__admin/medplum")).status).toBe(401)
    expect(
      (
        await call(runtime, "/__admin/medplum", {
          headers: { "x-mockingbird-admin-key": "sekrit" },
        })
      ).status,
    ).toBe(200)
    expect((await call(runtime, "/healthcheck")).status).toBe(200)
  })
})
