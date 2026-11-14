import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { formatProblems, loadConfig, type Problem, type StartupError } from "../src/config.js"
import { loadTarget } from "../src/engine.js"
import { RateLimiter } from "../src/limits.js"
import { memoryObjectStore, type ObjectStore, s3ObjectStore } from "../src/objects.js"
import { checkDatabase, checkObjectStore } from "../src/preflight.js"
import { postgresDatabase } from "../src/store/postgres.js"
import { harness, ORIGIN } from "./harness.js"

const open: { close(): Promise<void> }[] = []
const start = (...args: Parameters<typeof harness>) => {
  const created = harness(...args)
  open.push(created)
  return created
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((created) => created.close()))
})

const OPERATOR = "operator-token-0123456789abcdef0123456789"
const defaults = loadConfig({ AUTH_DEV_LOGIN: "1", OPERATOR_TOKEN: OPERATOR })
type ErrorBody = { error: { code: string; message: string; details?: { limit?: string } } }
type Fleet = { id: string; slug: string; requestsPerMinute: number | null }

async function tenant(h: ReturnType<typeof harness>, emulator: Record<string, unknown> = {}) {
  const owner = await h.signIn("owner@example.test")
  const org = (await owner.api<{ id: string }>("POST", "/orgs", { name: "Acme" })).body
  const project = (
    await owner.api<{ id: string }>("POST", `/orgs/${org.id}/projects`, { name: "Web" })
  ).body
  const fleet = (
    await owner.api<Fleet>("POST", `/projects/${project.id}/fleets`, {
      name: "Staging",
      emulators: { resend: { target: "resend", durability: "strict", ...emulator } },
    })
  ).body
  return { owner, org, project, fleet }
}

const send = (
  h: ReturnType<typeof harness>,
  fleet: Fleet,
  headers: Record<string, string> = {},
  html = "<p>hi</p>",
) =>
  h.client().raw("POST", `/f/${fleet.slug}/resend/emails`, {
    headers: { authorization: "Bearer re_x", "content-type": "application/json", ...headers },
    body: JSON.stringify({ from: "a@example.test", to: "b@example.test", subject: "hi", html }),
  })
const operator = (h: ReturnType<typeof harness>) => h.client({ key: OPERATOR })

test("quotas refuse growth past each limit and name the quota to raise", async () => {
  const h = start({
    config: {
      orgsPerUser: 1,
      limits: {
        ...defaults.limits,
        projectsPerOrg: 1,
        fleetsPerOrg: 1,
        emulatorsPerFleet: 1,
        apiKeysPerOrg: 1,
        membersPerOrg: 2,
      },
    },
  })
  const { owner, org, project, fleet } = await tenant(h)
  const refused = async (method: string, path: string, body: unknown, limit: string) => {
    const response = await owner.api<ErrorBody>(method, path, body)
    expect([response.status, response.body.error.code, response.body.error.details?.limit]).toEqual(
      [403, "quota_exceeded", limit],
    )
    expect(response.body.error.message).toContain(limit)
  }
  await refused("POST", "/orgs", { name: "Second" }, "orgsPerUser")
  await refused("POST", `/orgs/${org.id}/projects`, { name: "Two" }, "projectsPerOrg")
  await refused("POST", `/projects/${project.id}/fleets`, { name: "Two" }, "fleetsPerOrg")
  await refused(
    "PUT",
    `/fleets/${fleet.id}/emulators/second`,
    { target: "resend" },
    "emulatorsPerFleet",
  )
  // Replacing an existing emulator is not growth.
  expect(
    (await owner.api("PUT", `/fleets/${fleet.id}/emulators/resend`, { target: "resend" })).status,
  ).toBe(200)
  expect((await owner.api("POST", `/orgs/${org.id}/api-keys`, { name: "one" })).status).toBe(201)
  await refused("POST", `/orgs/${org.id}/api-keys`, { name: "two" }, "apiKeysPerOrg")
  // One member plus one pending invite fills a limit of two.
  expect(
    (await owner.api("POST", `/orgs/${org.id}/invites`, { email: "a@example.test" })).status,
  ).toBe(201)
  await refused("POST", `/orgs/${org.id}/invites`, { email: "b@example.test" }, "membersPerOrg")

  const usage = (
    await owner.api<{ limits: Record<string, number>; usage: Record<string, number> }>(
      "GET",
      `/orgs/${org.id}/usage`,
    )
  ).body
  expect(usage.limits).toMatchObject({ projectsPerOrg: 1, fleetsPerOrg: 1 })
  expect(usage.usage).toMatchObject({ projects: 1, fleets: 1, members: 1, apiKeys: 1 })
})

test("the operator overrides one organization's quotas and can restore the default", async () => {
  const h = start({
    config: {
      operatorTokenHash: defaults.operatorTokenHash,
      limits: { ...defaults.limits, projectsPerOrg: 1 },
    },
  })
  const { owner, org } = await tenant(h)
  expect((await owner.api("POST", `/orgs/${org.id}/projects`, { name: "Two" })).status).toBe(403)
  const raised = await operator(h).api<{ limits: Record<string, number>; limitOverrides: object }>(
    "PATCH",
    `/admin/orgs/${org.id}`,
    { limits: { projectsPerOrg: 0 } },
  )
  expect(raised.body.limitOverrides).toEqual({ projectsPerOrg: 0 })
  // 0 is unlimited.
  expect((await owner.api("POST", `/orgs/${org.id}/projects`, { name: "Two" })).status).toBe(201)
  const restored = await operator(h).api<{
    limits: Record<string, number>
    limitOverrides: object
  }>("PATCH", `/admin/orgs/${org.id}`, { limits: { projectsPerOrg: null } })
  expect([restored.body.limitOverrides, restored.body.limits.projectsPerOrg]).toEqual([{}, 1])
  expect(
    (await operator(h).api("PATCH", `/admin/orgs/${org.id}`, { limits: { projectsPerOrg: -1 } }))
      .status,
  ).toBe(400)
  expect(
    (await operator(h).api("PATCH", `/admin/orgs/${org.id}`, { limits: { made_up: 1 } })).status,
  ).toBe(400)
  expect((await operator(h).api<{ data: unknown[] }>("GET", "/admin/orgs")).body.data).toHaveLength(
    1,
  )
})

test("only the operator token reaches the operator API, and only when one is configured", async () => {
  const h = start({ config: { operatorTokenHash: defaults.operatorTokenHash } })
  const { owner, org } = await tenant(h)
  const token = (await owner.api<{ key: string }>("POST", "/tokens", { name: "mine" })).body.key
  expect((await owner.api("GET", "/admin/orgs")).status).toBe(401)
  expect(
    (await h.client({ key: token }).api("PATCH", `/admin/orgs/${org.id}`, { suspended: "x" }))
      .status,
  ).toBe(401)
  expect((await h.client({ key: `${OPERATOR}x` }).api("GET", "/admin/orgs")).status).toBe(401)
  // The operator token is not a user: it cannot be used on tenant routes.
  expect((await operator(h).api("GET", "/orgs")).status).toBe(401)

  const off = start()
  const disabled = await off.client({ key: OPERATOR }).api<ErrorBody>("GET", "/admin/orgs")
  expect([disabled.status, disabled.body.error.code]).toEqual([404, "operator_api_disabled"])
  expect(disabled.body.error.message).toContain("OPERATOR_TOKEN")
})

test("a suspended organization serves nothing and changes nothing, but can read and delete", async () => {
  const h = start({ config: { operatorTokenHash: defaults.operatorTokenHash } })
  const { owner, org, project, fleet } = await tenant(h)
  expect((await send(h, fleet)).status).toBe(200)
  await operator(h).api("PATCH", `/admin/orgs/${org.id}`, { suspended: "abuse report #12" })

  const blocked = await send(h, fleet)
  expect([blocked.status, ((await blocked.json()) as ErrorBody).error.code]).toEqual([
    403,
    "org_suspended",
  ])
  const write = await owner.api<ErrorBody>("POST", `/projects/${project.id}/fleets`, {
    name: "More",
  })
  expect([write.status, write.body.error.code]).toEqual([403, "org_suspended"])
  expect(write.body.error.message).toContain("abuse report #12")
  expect((await owner.api<{ suspended: string }>("GET", `/orgs/${org.id}`)).body.suspended).toBe(
    "abuse report #12",
  )
  expect((await owner.api("GET", `/fleets/${fleet.id}`)).status).toBe(200)

  await operator(h).api("PATCH", `/admin/orgs/${org.id}`, { suspended: null })
  expect((await send(h, fleet)).status).toBe(200)
  await operator(h).api("PATCH", `/admin/orgs/${org.id}`, { suspended: "again" })
  expect((await owner.api("DELETE", `/fleets/${fleet.id}`)).status).toBe(200)
})

test("without an identity provider, the operator issues a token that signs a person in", async () => {
  const h = start({ config: { operatorTokenHash: defaults.operatorTokenHash, devLogin: false } })
  const issued = (
    await operator(h).api<{ token: { key: string }; user: { email: string } }>(
      "POST",
      "/admin/users",
      { email: "Ada@Example.test" },
    )
  ).body
  expect(issued.token.key).toMatch(/^mbf_u_/)
  const login = (token: string) =>
    h.client().raw("POST", "/auth/token-login", {
      headers: { "x-mockingbird-csrf": "1" },
      body: JSON.stringify({ token }),
    })
  const session = await login(issued.token.key)
  expect(session.status).toBe(200)
  const browser = h.client({
    cookie: (session.headers.get("set-cookie") as string).split(";")[0] as string,
  })
  expect((await browser.api<{ user: { email: string } }>("GET", "/me")).body.user.email).toBe(
    "Ada@Example.test",
  )
  const org = (await browser.api<{ id: string }>("POST", "/orgs", { name: "Acme" })).body
  // Asking again for the same email returns the same person, not a second account.
  const again = (
    await operator(h).api<{ user: { id: string } }>("POST", "/admin/users", {
      email: "ada@example.test",
    })
  ).body
  expect((await h.db.find("users", {})).length).toBe(1)
  expect(again.user.id).toBeString()
  // An organization key is not a person and cannot open a browser session.
  const orgKey = (
    await browser.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, { name: "ci" })
  ).body.key
  expect((await login(orgKey)).status).toBe(401)
  expect((await login("mbf_u_nope")).status).toBe(401)
})

test("the API is rate limited per credential, with standard headers, and refills over time", async () => {
  let clock = 1_800_000_000_000
  const h = start({
    now: () => clock,
    config: { rateLimits: { ...defaults.rateLimits, apiPerMinute: 3 } },
  })
  const one = await h.signIn("one@example.test")
  const two = await h.signIn("two@example.test")
  const first = await one.raw("GET", "/api/v1/me")
  expect([first.headers.get("ratelimit-limit"), first.headers.get("ratelimit-remaining")]).toEqual([
    "3",
    "2",
  ])
  await one.raw("GET", "/api/v1/me")
  await one.raw("GET", "/api/v1/me")
  const limited = await one.raw("GET", "/api/v1/me")
  expect(limited.status).toBe(429)
  expect(((await limited.json()) as ErrorBody).error.code).toBe("rate_limited")
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
  // Someone else's budget is untouched.
  expect((await two.raw("GET", "/api/v1/me")).status).toBe(200)
  clock += 20_000
  expect((await one.raw("GET", "/api/v1/me")).status).toBe(200)
  expect((await one.raw("GET", "/api/v1/me")).status).toBe(429)
})

test("a fleet can lower its own request rate, never raise it past the organization's ceiling", async () => {
  let clock = 1_800_000_000_000
  const h = start({
    now: () => clock,
    config: { limits: { ...defaults.limits, fleetRequestsPerMinute: 5 } },
  })
  const { owner, fleet } = await tenant(h)
  expect((await owner.api("PATCH", `/fleets/${fleet.id}`, { requestsPerMinute: 6 })).status).toBe(
    400,
  )
  expect(
    (await owner.api<Fleet>("PATCH", `/fleets/${fleet.id}`, { requestsPerMinute: 2 })).body
      .requestsPerMinute,
  ).toBe(2)
  expect([(await send(h, fleet)).status, (await send(h, fleet)).status]).toEqual([200, 200])
  const limited = await send(h, fleet)
  expect([limited.status, ((await limited.json()) as ErrorBody).error.code]).toEqual([
    429,
    "fleet_rate_limited",
  ])
  expect(limited.headers.get("retry-after")).toBeString()
  clock += 60_000
  expect((await send(h, fleet)).status).toBe(200)
})

test("per-address limits use the address the trusted proxy saw, not one the client claims", async () => {
  const h = start({
    config: { trustedProxyHops: 1, rateLimits: { ...defaults.rateLimits, clientPerMinute: 2 } },
  })
  const { fleet } = await tenant(h)
  const from = (forwarded: string) => send(h, fleet, { "x-forwarded-for": forwarded })
  expect([(await from("203.0.113.9")).status, (await from("203.0.113.9")).status]).toEqual([
    200, 200,
  ])
  expect((await from("203.0.113.9")).status).toBe(429)
  // Prepending a made-up address does not buy a fresh budget: the proxy appends the real one.
  expect((await from("198.51.100.1, 203.0.113.9")).status).toBe(429)
  expect((await from("203.0.113.10")).status).toBe(200)
})

test("repeated bad credentials from one address are cut off before they are even checked", async () => {
  const h = start({
    config: { trustedProxyHops: 1, rateLimits: { ...defaults.rateLimits, authPerMinute: 3 } },
  })
  const { owner, org, fleet } = await tenant(h)
  const key = (await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, { name: "ci" }))
    .body.key
  await owner.api("PATCH", `/fleets/${fleet.id}`, { access: "key" })
  const guess = (address: string, value: string) =>
    send(h, fleet, { "x-forwarded-for": address, "x-mockingbird-api-key": value })
  const bad = `mbf_o_${"a".repeat(20)}_${"b".repeat(43)}`
  for (let attempt = 0; attempt < 3; attempt++)
    expect((await guess("203.0.113.5", bad)).status).toBe(401)
  // Now even the right key is refused from that address until the window passes…
  const cut = await guess("203.0.113.5", key)
  expect([cut.status, ((await cut.json()) as ErrorBody).error.code]).toEqual([
    429,
    "auth_rate_limited",
  ])
  // …while everyone else carries on.
  expect((await guess("203.0.113.6", key)).status).toBe(200)
  const api = await h.app.fetch(
    new Request(`${ORIGIN}/api/v1/me`, {
      headers: { authorization: `Bearer ${bad}`, "x-forwarded-for": "203.0.113.5" },
    }),
  )
  expect(api.status).toBe(429)
})

test("the monthly request quota stops a fleet, is reported in usage, and resets next month", async () => {
  let clock = Date.UTC(2026, 10, 28)
  const h = start({
    now: () => clock,
    config: { limits: { ...defaults.limits, requestsPerMonth: 3 } },
  })
  const { owner, org, fleet } = await tenant(h)
  for (let index = 0; index < 3; index++) expect((await send(h, fleet)).status).toBe(200)
  const over = await send(h, fleet)
  const body = (await over.json()) as ErrorBody
  expect([over.status, body.error.code, body.error.details?.limit]).toEqual([
    429,
    "quota_exceeded",
    "requestsPerMonth",
  ])
  const usage = (
    await owner.api<{
      usage: { requestsThisMonth: number }
      daily: { day: string; requests: number }[]
    }>("GET", `/orgs/${org.id}/usage`)
  ).body
  expect(usage.usage.requestsThisMonth).toBe(3)
  expect(usage.daily).toEqual([{ day: "2026-11-28", requests: 3 }])
  clock = Date.UTC(2026, 11, 1, 0, 5)
  expect((await send(h, fleet)).status).toBe(200)
})

test("strict: a write that would outgrow the state quota is refused and rolled back", async () => {
  const h = start({ config: { limits: { ...defaults.limits, stateBytes: 900 } } })
  const { fleet } = await tenant(h)
  const small = await send(h, fleet, {}, "small")
  expect(small.status).toBe(200)
  const { id } = (await small.json()) as { id: string }
  const big = await send(h, fleet, {}, crypto.getRandomValues(new Uint8Array(4000)).toHex())
  const body = (await big.json()) as ErrorBody
  expect([big.status, body.error.code, body.error.details?.limit]).toEqual([
    507,
    "state_too_large",
    "stateBytes",
  ])
  // The refused write left no trace, and the emulator still works.
  const stored = [...h.objects.objects.values()][0] as Uint8Array
  expect(stored.length).toBeLessThanOrEqual(900)
  const read = await h.client().raw("GET", `/f/${fleet.slug}/resend/emails/${id}`, {
    headers: { authorization: "Bearer re_x" },
  })
  expect(read.status).toBe(200)
  expect((await send(h, fleet, {}, "still small")).status).toBe(200)
})

test("buffered: an emulator that outgrows the quota stops serving until it is reset", async () => {
  const h = start({ config: { limits: { ...defaults.limits, stateBytes: 900 } } })
  const { owner, fleet } = await tenant(h, { durability: "buffered", flushIntervalMs: 100 })
  expect(
    (await send(h, fleet, {}, crypto.getRandomValues(new Uint8Array(4000)).toHex())).status,
  ).toBe(200)
  expect((await owner.api("POST", `/fleets/${fleet.id}/emulators/resend/flush`)).status).toBe(503)
  const blocked = await send(h, fleet)
  expect([blocked.status, ((await blocked.json()) as ErrorBody).error.code]).toEqual([
    507,
    "state_too_large",
  ])
  expect(h.objects.objects.size).toBe(0)
  expect((await owner.api("POST", `/fleets/${fleet.id}/emulators/resend/reset`)).status).toBe(200)
  expect((await send(h, fleet)).status).toBe(200)
})

test("anonymous callers cannot send emulator control headers; a member key can", async () => {
  const h = start({ config: { fleetRequestTimeoutMs: 150 } })
  const { owner, org, fleet } = await tenant(h)
  const member = (
    await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, { name: "ci" })
  ).body.key
  const viewer = (
    await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, {
      name: "ro",
      role: "viewer",
    })
  ).body.key
  const { id } = (await (await send(h, fleet)).json()) as { id: string }
  const read = (headers: Record<string, string>) =>
    h.client().raw("GET", `/f/${fleet.slug}/resend/emails/${id}`, {
      headers: { authorization: "Bearer re_x", ...headers },
    })
  // A reset header from a stranger (or a read-only key) is dropped: the email survives.
  expect((await read({ "x-mockingbird-reset": "1" })).status).toBe(200)
  expect((await read({ "x-mockingbird-reset": "1", "x-mockingbird-api-key": viewer })).status).toBe(
    200,
  )
  // A delay header from a stranger cannot hold the connection open…
  expect((await read({ "x-mockingbird-delay": "600ms" })).status).toBe(200)
  // …and when a member really does make the emulator slow, the request is cut off.
  const slow = await read({ "x-mockingbird-delay": "600ms", "x-mockingbird-api-key": member })
  expect([slow.status, ((await slow.json()) as ErrorBody).error.code]).toEqual([
    504,
    "emulator_timeout",
  ])
  await new Promise((resolve) => setTimeout(resolve, 700))
  expect((await read({ "x-mockingbird-reset": "1", "x-mockingbird-api-key": member })).status).toBe(
    404,
  )
  // A key from another organization is refused outright, even on an open fleet.
  const stranger = await h.signIn("stranger@example.test")
  const other = (await stranger.api<{ id: string }>("POST", "/orgs", { name: "Other" })).body
  const foreign = (
    await stranger.api<{ key: string }>("POST", `/orgs/${other.id}/api-keys`, { name: "x" })
  ).body.key
  expect((await read({ "x-mockingbird-api-key": foreign })).status).toBe(403)
})

test("a fleet serves a bounded number of requests at once", async () => {
  const h = start({ config: { fleetMaxConcurrent: 2, fleetRequestTimeoutMs: 5000 } })
  const { owner, org, fleet } = await tenant(h, { durability: "ephemeral" })
  const key = (await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, { name: "ci" }))
    .body.key
  const slow = () =>
    send(h, fleet, { "x-mockingbird-delay": "300ms", "x-mockingbird-api-key": key })
  const statuses = (await Promise.all([slow(), slow(), slow(), slow()]))
    .map((response) => response.status)
    .sort()
  expect(statuses).toEqual([200, 200, 429, 429])
  // Slots are released when requests finish.
  expect((await send(h, fleet)).status).toBe(200)
})

test("every change is in the organization's audit log with who made it", async () => {
  const h = start({ config: { operatorTokenHash: defaults.operatorTokenHash } })
  const { owner, org, fleet } = await tenant(h)
  const key = (
    await owner.api<{ key: string; id: string }>("POST", `/orgs/${org.id}/api-keys`, { name: "ci" })
  ).body
  await h
    .client({ key: key.key })
    .api("PATCH", `/fleets/${fleet.id}/emulators/resend`, { durability: "buffered" })
  await operator(h).api("PATCH", `/admin/orgs/${org.id}`, { limits: { fleetsPerOrg: 9 } })
  await owner.api("GET", `/fleets/${fleet.id}`)
  const log = (
    await owner.api<{ data: { actor: string; action: string; target: string }[] }>(
      "GET",
      `/orgs/${org.id}/audit`,
    )
  ).body.data
  expect(log.map((entry) => entry.action)).toEqual([
    "adminUpdateOrg",
    "updateEmulator",
    "createApiKey",
    "createFleet",
    "createProject",
    "createOrg",
  ])
  expect(log[0]?.actor).toBe("operator")
  expect(log[1]).toMatchObject({ actor: `key:${key.id}:ci`, target: `${fleet.id}/resend` })
  expect(log[5]?.actor).toContain("owner@example.test")
  // Secrets never reach the log.
  expect(JSON.stringify(log)).not.toContain(key.key)
  const viewer = (
    await owner.api<{ key: string }>("POST", `/orgs/${org.id}/api-keys`, {
      name: "ro",
      role: "viewer",
    })
  ).body.key
  expect((await h.client({ key: viewer }).api("GET", `/orgs/${org.id}/audit`)).status).toBe(403)
})

test("allowed browser origins may call the API with a key; others get no CORS headers", async () => {
  const h = start({ config: { corsOrigins: ["https://app.example.com"] } })
  const preflight = (origin: string) =>
    h.client().raw("OPTIONS", "/api/v1/orgs", {
      headers: { origin, "access-control-request-method": "POST" },
    })
  const allowed = await preflight("https://app.example.com")
  expect([allowed.status, allowed.headers.get("access-control-allow-origin")]).toEqual([
    204,
    "https://app.example.com",
  ])
  expect(allowed.headers.get("access-control-allow-credentials")).toBeNull()
  expect(
    (await preflight("https://evil.example")).headers.get("access-control-allow-origin"),
  ).toBeNull()
  const actual = await h
    .client()
    .raw("GET", "/api/v1/config", { headers: { origin: "https://app.example.com" } })
  expect(actual.headers.get("access-control-allow-origin")).toBe("https://app.example.com")
})

test("responses carry a request id, and /llms.txt tells an agent how to integrate", async () => {
  const h = start()
  const response = await h.client().raw("GET", "/api/v1/me")
  expect(response.headers.get("x-request-id")).toMatch(/^req_[a-z0-9]{16}$/)
  const echoed = await h
    .client()
    .raw("GET", "/api/v1/me", { headers: { "x-request-id": "trace-me-12345" } })
  expect(echoed.headers.get("x-request-id")).toBe("trace-me-12345")
  const guide = await (await h.client().raw("GET", "/llms.txt")).text()
  for (const expected of [
    `${ORIGIN}/api/v1`,
    "/api/openapi.json",
    "POST /projects/{projectId}/fleets",
    "quota_exceeded",
    "Retry-After",
    "x-mockingbird-api-key",
  ])
    expect(guide).toContain(expected)
})

test("the limiter forgets old keys instead of growing without bound", () => {
  const limiter = new RateLimiter(() => 0, 100)
  for (let index = 0; index < 1000; index++) limiter.take(`address:${index}`, 10)
  expect(
    (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size,
  ).toBeLessThanOrEqual(100)
  expect(limiter.take("anything", 0).allowed).toBe(true)
})

// ---- failing fast and loud ---------------------------------------------------------------

const problemsOf = (env: Record<string, string>): Problem[] => {
  try {
    loadConfig(env)
    return []
  } catch (error) {
    return (error as StartupError).problems
  }
}

test("a misconfigured boot reports every problem at once, each with the variable to set", () => {
  const problems = problemsOf({
    PUBLIC_URL: "https://fleet.example.com",
    S3_BUCKET: "state",
    PORT: "eighty",
  })
  expect(problems.map((problem) => problem.what)).toEqual([
    "PORT is invalid: it must be a whole number of at least 1",
    "DATABASE_URL is not set",
    "S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY are not set",
    "No way to sign in is configured",
  ])
  const report = formatProblems(problems)
  for (const expected of [
    "cannot start: 4 problems to fix",
    "set: DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>",
    "set: S3_ENDPOINT=https://",
    "set: OPERATOR_TOKEN=<output of: openssl rand -hex 32>",
    "bun dist/main.js check",
  ])
    expect(report).toContain(expected)
  for (const problem of problems) {
    expect(problem.why.length).toBeGreaterThan(20)
    expect(problem.fix.length).toBeGreaterThan(20)
    expect(problem.env.length).toBeGreaterThan(0)
  }
})

test("unsafe or half-set configuration is refused with the reason", () => {
  const hosted = {
    PUBLIC_URL: "https://fleet.example.com",
    DATABASE_URL: "postgres://x",
    S3_ENDPOINT: "https://s3.example",
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: "a",
    S3_SECRET_ACCESS_KEY: "b",
    S3_BUCKET: "c",
    OPERATOR_TOKEN: OPERATOR,
  }
  expect(problemsOf(hosted)).toEqual([])
  const codes = (extra: Record<string, string>) =>
    problemsOf({ ...hosted, ...extra }).map((problem) => `${problem.code}: ${problem.what}`)
  expect(codes({ AUTH_DEV_LOGIN: "1" })).toEqual([
    "unsafe_env: AUTH_DEV_LOGIN=1 is set on a non-loopback PUBLIC_URL",
  ])
  expect(codes({ OPERATOR_TOKEN: "short" })[0]).toContain("OPERATOR_TOKEN is invalid")
  expect(codes({ OIDC_ISSUER: "https://idp.example" })).toEqual([
    "missing_env: OIDC_CLIENT_ID is not set, but OIDC_ISSUER is",
  ])
  expect(codes({ S3_ENDPOINT: "https://key:secret@s3.example" })[0]).toContain(
    "S3_ENDPOINT is invalid",
  )
  expect(codes({ CORS_ORIGINS: "https://ok.example,*" })[0]).toContain('"*" is not an origin')
  expect(codes({ LIMIT_FLEETS_PER_ORG: "-1" })[0]).toContain("LIMIT_FLEETS_PER_ORG is invalid")
  // Secrets given in the environment never appear in the report.
  expect(
    formatProblems(problemsOf({ ...hosted, OPERATOR_TOKEN: "short-secret", PORT: "x" })),
  ).not.toContain("short-secret")
})

test("preflight explains object-store failures by cause", async () => {
  const config = {
    s3: {
      endpoint: "https://s3.example",
      region: "auto",
      accessKeyId: "a",
      secretAccessKey: "b",
      bucket: "state",
    },
    s3Prefix: "mockingbird-fleet/",
  }
  const answering = (status: number, code: string) =>
    s3ObjectStore({
      ...config.s3,
      prefix: config.s3Prefix,
      fetch: (async () =>
        new Response(`<Error><Code>${code}</Code></Error>`, { status })) as unknown as typeof fetch,
    })
  const code = async (store: ObjectStore) => (await checkObjectStore(store, config))?.code
  expect(await code(answering(404, "NoSuchBucket"))).toBe("object_store_no_bucket")
  expect(await code(answering(403, "SignatureDoesNotMatch"))).toBe("object_store_bad_signature")
  expect(await code(answering(403, "AccessDenied"))).toBe("object_store_denied")
  expect(await code(answering(500, "InternalError"))).toBe("object_store_error")
  const unreachable = s3ObjectStore({
    ...config.s3,
    prefix: config.s3Prefix,
    fetch: (async () => {
      throw new Error("getaddrinfo ENOTFOUND s3.example")
    }) as unknown as typeof fetch,
  })
  const problem = await checkObjectStore(unreachable, config)
  expect(problem?.code).toBe("object_store_unreachable")
  expect(problem?.why).toContain("ENOTFOUND")
  expect(problem?.fix).toContain("host.docker.internal")

  // A store that accepts every write, ignoring If-None-Match, would let replicas clobber each other.
  const memory = memoryObjectStore()
  const careless: ObjectStore = {
    ...memory,
    put: async (key, bytes) => {
      memory.objects.set(key, bytes)
      return '"etag"'
    },
  }
  expect(await code(careless)).toBe("object_store_no_conditional_writes")

  // Another replica probing at the same time keeps its probe object until it finishes.
  const shared = memoryObjectStore()
  shared.objects.set("preflight/other-replica.txt", new TextEncoder().encode("probe"))
  expect(await checkObjectStore(shared, config)).toBeUndefined()
  expect([...shared.objects.keys()]).toEqual(["preflight/other-replica.txt"])

  // Against a real S3 API the probe passes and cleans up after itself.
  const s3 = (await (
    await loadTarget("s3")
  ).create({}, { adminKey: undefined, seed: undefined, onLog: undefined })) as {
    fetch(request: Request): Promise<Response>
  }
  await s3.fetch(new Request("https://s3.example/state", { method: "PUT" }))
  const real = s3ObjectStore({
    ...config.s3,
    prefix: config.s3Prefix,
    fetch: ((input: string, init: RequestInit) =>
      s3.fetch(new Request(input, init))) as unknown as typeof fetch,
  })
  expect(await checkObjectStore(real, config)).toBeUndefined()
  expect(
    await (await s3.fetch(new Request("https://s3.example/state?list-type=2"))).text(),
  ).not.toContain("<Key>")
})

test("preflight explains an unreachable database", async () => {
  const db = postgresDatabase("postgres://fleet:fleet@127.0.0.1:1/fleet", "mockingbird_fleet")
  const problem = await checkDatabase(db, { databaseSchema: "mockingbird_fleet" })
  expect(problem?.code).toBe("database_unreachable")
  expect(problem?.env).toEqual(["DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>"])
  expect(problem?.what).toBe(
    "PostgreSQL did not accept a connection at the host and port in DATABASE_URL",
  )
  expect(problem?.fix).toContain("host.docker.internal")
  await db.close().catch(() => {})
})

test("the real entrypoint exits non-zero with the report, and `check` passes when all is well", async () => {
  const run = async (args: string[], env: Record<string, string>) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  }
  const failed = await run([], {
    PUBLIC_URL: "https://fleet.example.com",
    DATABASE_URL: "postgres://fleet:hunter2@127.0.0.1:1/fleet",
  })
  expect(failed.code).toBe(78)
  expect(failed.stderr).toContain("mockingbird-fleet cannot start: 2 problems to fix")
  expect(failed.stderr).toContain("set: S3_BUCKET=<an existing bucket name>")
  // The last line is the same report for machines; the password is in neither.
  const last = JSON.parse(failed.stderr.trim().split("\n").at(-1) as string) as {
    event: string
    problems: Problem[]
  }
  expect([last.event, last.problems.length]).toEqual(["startup_failed", 2])
  expect(failed.stderr + failed.stdout).not.toContain("hunter2")

  const unreachable = await run(["check"], {
    AUTH_DEV_LOGIN: "1",
    DATABASE_URL: "postgres://fleet:hunter2@127.0.0.1:1/fleet",
  })
  expect(unreachable.code).toBe(78)
  expect(unreachable.stderr).toContain("PostgreSQL did not accept a connection")
  expect(unreachable.stderr).not.toContain("hunter2")

  const ok = await run(["check"], { AUTH_DEV_LOGIN: "1" })
  expect(ok.code).toBe(0)
  expect(ok.stdout).toContain("configuration is valid")
}, 60_000)
