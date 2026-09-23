import { describe, expect, test } from "bun:test"
import { createRuntime, DEFAULT_CLINIC_LOCATION_ID, DEFAULT_USER_ID } from "./src/index.js"

const API = "http://vpi.mock"

const call = (
  runtime: ReturnType<typeof createRuntime>,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) =>
  runtime.fetch(
    new Request(`${API}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )

const login = async (runtime: ReturnType<typeof createRuntime>, prefix = "") => {
  const response = await call(runtime, `${prefix}/accounts/authenticate`, {
    body: { email: "clinic@example.com", password: "s", isPatientLogin: false },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { jwtToken: string }).jwtToken
}

const incomplete = (jwt: string) => ({
  body: {
    clinicLocationId: DEFAULT_CLINIC_LOCATION_ID,
    userId: DEFAULT_USER_ID,
    limit: 5,
    currentPage: 1,
  },
  headers: { authorization: `Bearer ${jwt}` },
})

describe("the Mockingbird service contract", () => {
  test("/health, the x-mockingbird header, and /__admin lists the VPI routes", async () => {
    const runtime = createRuntime()
    const health = await call(runtime, "/health")
    expect(health.status).toBe(200)
    expect(((await health.json()) as { service: string }).service).toBe("vpi")
    expect(health.headers.get("x-mockingbird")).toMatch(/^vpi@.+; ns=default$/)
    const index = await (await call(runtime, "/__admin")).text()
    for (const route of ["/prescriptions/:id/transition", "/patients", "/settings", "/catalog"]) {
      expect(index).toContain(route)
    }
  })

  test("JWT claims: sub is the user id, exp follows the mock clock and the TTL knob", async () => {
    const runtime = createRuntime({ settings: { tokenTtlSeconds: 120 } })
    const jwt = await login(runtime)
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] as string, "base64url").toString()) as {
      sub: string
      exp: number
      iat: number
    }
    expect(claims.sub).toBe(DEFAULT_USER_ID)
    expect(claims.exp - claims.iat).toBe(120)
    expect(claims.iat).toBe(Math.floor(runtime.clock.now() / 1000))
    const tampered = `${jwt.slice(0, -2)}xx`
    expect(
      (
        await call(runtime, "/admin/rxOrdering/getShippingStates", {
          headers: { authorization: `Bearer ${tampered}` },
        })
      ).status,
    ).toBe(401)
    expect((await call(runtime, "/admin/rxOrdering/getShippingStates")).status).toBe(401)
  })

  test("namespaces by header and by /ns/ prefix are isolated; reset restores the seed", async () => {
    const runtime = createRuntime()
    const jwt = await login(runtime)
    const save = await call(runtime, "/__admin/patients", {
      body: { firstName: "Only", lastName: "InA", dateOfBirth: "1990-01-01" },
      headers: { "x-mockingbird-namespace": "a" },
    })
    expect(save.status).toBe(201)
    const roster = async (prefix: string, headers: Record<string, string> = {}) =>
      (
        (await (
          await call(runtime, `${prefix}/patients/getPatientsInClinic`, {
            body: {
              clinicId: "65a1c0de00000000000000c1",
              userId: DEFAULT_USER_ID,
              limit: 100,
              currentPage: 1,
            },
            headers: { authorization: `Bearer ${jwt}`, ...headers },
          })
        ).json()) as { patients: unknown[] }
      ).patients.length
    expect(await roster("/ns/a")).toBe(2)
    expect(await roster("", { "x-mockingbird-namespace": "a" })).toBe(2)
    expect(await roster("/ns/b")).toBe(1)
    expect(await roster("")).toBe(1)
    await call(runtime, "/__admin/reset?namespace=a", { method: "POST" })
    expect(await roster("/ns/a")).toBe(1)
    const list = await call(
      runtime,
      "/clinic/rxOrdering/getIncompleteSavedPrescriptionsInClinicLocation",
      incomplete(jwt),
    )
    expect(await list.json()).toEqual([])
  })

  test("admin errors use the mockingbird_admin shape; settings validate", async () => {
    const runtime = createRuntime()
    const missing = await call(runtime, "/__admin/prescriptions/nope/transition", {
      body: { to: "Cancelled" },
    })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { type: string } }).error.type).toBe(
      "mockingbird_admin",
    )
    expect(
      (await call(runtime, "/__admin/settings", { method: "PUT", body: { statusEnvelope: "xml" } }))
        .status,
    ).toBe(400)
    expect((await call(runtime, "/__admin/patients", { body: { firstName: "x" } })).status).toBe(
      400,
    )
    const presets = (await (await call(runtime, "/__admin/faults/presets")).json()) as unknown
    expect(JSON.stringify(presets)).toContain("token_expired")
  })

  test("preset through the admin API is scoped to the calling namespace", async () => {
    const runtime = createRuntime()
    const jwt = await login(runtime)
    await call(runtime, "/__admin/faults", {
      body: { preset: "server_error" },
      headers: { "x-mockingbird-namespace": "broken" },
    })
    expect(
      (
        await call(runtime, "/ns/broken/admin/rxOrdering/getShippingStates", {
          headers: { authorization: `Bearer ${jwt}` },
        })
      ).status,
    ).toBe(500)
    expect(
      (
        await call(runtime, "/admin/rxOrdering/getShippingStates", {
          headers: { authorization: `Bearer ${jwt}` },
        })
      ).status,
    ).toBe(200)
  })
})
