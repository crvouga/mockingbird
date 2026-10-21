import { expect, test } from "bun:test"
import { createRuntime, type DataRecord, WhoopAPI } from "./src/index.js"
import { createServer } from "./src/server.js"
import { refresh, synchronize } from "./test/consumer.js"

const base = "http://whoop.test"
const records: DataRecord[] = [1, 2, 3, 4].map((i) => ({
  key: `workout-${i}`,
  userId: "synthetic-user",
  collection: "workout",
  data: {
    id: `00000000-0000-4000-8000-00000000000${i}`,
    user_id: 1,
    created_at: `2026-01-0${i}T12:00:00Z`,
    updated_at: `2026-01-0${i}T12:00:00Z`,
    start: `2026-01-0${i}T09:00:00Z`,
    end: `2026-01-0${i}T10:00:00Z`,
    timezone_offset: "Z",
    sport_name: "walking",
    score_state: "PENDING_SCORE",
  },
}))
test("windows are inclusive start/exclusive end, descending and exhaust pagination", async () => {
  const api = new WhoopAPI({ records })
  const result = await synchronize((r) => api.fetch(r), base, "workout", "mock_whoop_token", {
    start: "2026-01-02T09:00:00Z",
    end: "2026-01-04T09:00:00Z",
    limit: "1",
  })
  expect(result.records).toEqual(
    records
      .slice(1, 3)
      .reverse()
      .map((r) => r.data),
  )
  expect(result.records[0]?.score_state).toBe("PENDING_SCORE")
  expect(result.records[0]).not.toHaveProperty("score")
})
test("recovery keeps cycle_id/sleep_id and filters by related sleep, not invented id/start/end", async () => {
  // The issue's generic recovery field list disagrees with WHOOP's official Recovery schema.
  const first = records[0]
  if (!first) throw new Error("missing fixture")
  const sleep: DataRecord = { ...first, key: "sleep-1", collection: "sleep" }
  const recovery: DataRecord = {
    key: "recovery-1",
    userId: "synthetic-user",
    collection: "recovery",
    data: {
      cycle_id: 1,
      sleep_id: sleep.data.id,
      user_id: 1,
      created_at: "2026-01-01T12:00:00Z",
      updated_at: "2026-01-01T12:00:00Z",
      score_state: "UNSCORABLE",
    },
  }
  const cycle: DataRecord = {
    ...first,
    key: "cycle-1",
    collection: "cycle",
    data: { ...first.data, id: 1, step_count: null },
  }
  const api = new WhoopAPI({ records: [sleep, recovery, cycle] })
  expect(
    (
      await synchronize((r) => api.fetch(r), base, "recovery", "mock_whoop_token", {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-02T00:00:00Z",
      })
    ).records,
  ).toEqual([recovery.data])
  expect(
    (
      await synchronize((r) => api.fetch(r), base, "recovery", "mock_whoop_token", {
        start: "2026-01-02T00:00:00Z",
      })
    ).records,
  ).toEqual([])
  expect(
    (await synchronize((r) => api.fetch(r), base, "sleep", "mock_whoop_token", {})).records,
  ).toEqual([sleep.data])
  expect(
    (await synchronize((r) => api.fetch(r), base, "cycle", "mock_whoop_token", {})).records[0]
      ?.step_count,
  ).toBeNull()
})
test("refresh revokes both old access and refresh and retains same user data", async () => {
  let now = Date.UTC(2026, 1, 1)
  const api = new WhoopAPI({ records, now: () => now, tokenTtlSeconds: 1 })
  const first = (await (await refresh((r) => api.fetch(r), base, "mock_whoop_refresh")).json()) as {
    access_token: string
    refresh_token: string
  }
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", "mock_whoop_token", {})).status,
  ).toBe(401)
  now += 1000
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", first.access_token, {})).status,
  ).toBe(401)
  const next = (await (await refresh((r) => api.fetch(r), base, first.refresh_token)).json()) as {
    access_token: string
  }
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", next.access_token, {})).records,
  ).toHaveLength(4)
  expect(
    await (await refresh((r) => api.fetch(r), base, first.refresh_token)).json(),
  ).toMatchObject({ error: "invalid_grant" })
})
test("code exchange requires offline to issue refresh and consumes PKCE codes once concurrently", async () => {
  const verifier = "a".repeat(43)
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  )
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  const api = new WhoopAPI({
    codes: [
      {
        code: "mock_code",
        clientId: "mock_client",
        userId: "synthetic-user",
        scopes: ["read:sleep"],
        expiresAt: 4102444800000,
        challenge,
      },
    ],
  })
  const exchange = () =>
    api.fetch(
      new Request(`${base}/oauth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "mock_code",
          code_verifier: verifier,
          client_id: "mock_client",
          client_secret: "mock_client_secret",
        }),
      }),
    )
  const responses = await Promise.all([exchange(), exchange()])
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400])
  const success = responses.find((r) => r.status === 200)
  if (!success) throw new Error("missing success")
  expect(await success.json()).not.toHaveProperty("refresh_token")
})
test("namespace reset preserves other state and journals do not expose bodies", async () => {
  const runtime = createRuntime({ records })
  const admin = (path: string, ns: string, body: unknown) =>
    runtime.fetch(
      new Request(`${base}/__admin/${path}`, {
        method: "POST",
        headers: { "x-mockingbird-namespace": ns, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  await admin("state/records", "a", { id: "extra", value: { ...records[0], key: "extra" } })
  await admin("reset", "b", {})
  expect(
    (
      await synchronize(
        (r) => runtime.fetch(r),
        `${base}/__admin/ns/a`,
        "workout",
        "mock_whoop_token",
        {},
      )
    ).records,
  ).toHaveLength(5)
  expect(
    (
      await synchronize(
        (r) => runtime.fetch(r),
        `${base}/__admin/ns/b`,
        "workout",
        "mock_whoop_token",
        {},
      )
    ).records,
  ).toHaveLength(4)
  await refresh((r) => runtime.fetch(r), base, "mock_whoop_refresh")
  const journal = await (await runtime.fetch(new Request(`${base}/__admin/requests`))).text()
  expect(journal).not.toContain("mock_client_secret")
  expect(journal).not.toContain("mock_whoop_refresh")
})
test("served HTTP propagates empty envelopes and every fault preset", async () => {
  const server = await createServer()
  try {
    expect(
      (await synchronize(fetch, server.url, "workout", "mock_whoop_token", {})).records,
    ).toEqual([])
    for (const [preset, status] of [
      ["unauthorized", 401],
      ["rate_limited", 429],
      ["server_error", 500],
    ] as const) {
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset, count: 1 }),
      })
      expect((await synchronize(fetch, server.url, "workout", "mock_whoop_token", {})).status).toBe(
        status,
      )
    }
    await fetch(`${server.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "connection_drop", count: 1 }),
    })
    await expect(
      synchronize((r) => server.runtime.fetch(r), server.url, "workout", "mock_whoop_token", {}),
    ).rejects.toThrow()
    expect(
      (await synchronize(fetch, server.url, "workout", "mock_whoop_token", { limit: "26" })).status,
    ).toBe(400)
  } finally {
    await server.close()
  }
})

const STATE = "Zk3_9aB-q7LmN2xPvT0yR5uWcD8eHfJgKsAoIlXb1Qw"
const REDIRECT = "http://localhost:8000/api/v1/oauth/whoop/callback"
const SCOPES = "offline read:cycles read:sleep read:recovery read:workout"
const authorize = (
  api: { fetch(request: Request): Promise<Response> },
  params: Record<string, string | undefined> = {},
  root = base,
) => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: "mock_client",
    redirect_uri: REDIRECT,
    state: STATE,
    scope: SCOPES,
    ...params,
  }))
    if (value !== undefined) query.set(key, value)
  return api.fetch(new Request(`${root}/oauth/oauth2/auth?${query}`, { redirect: "manual" }))
}
const redirected = (response: Response) => {
  expect(response.status).toBe(302)
  const location = response.headers.get("location")
  if (!location) throw new Error("missing location")
  return new URL(location)
}
const tokenRequest = (api: WhoopAPI, fields: Record<string, string>) =>
  api.fetch(
    new Request(`${base}/oauth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "mock_client",
        client_secret: "mock_client_secret",
        redirect_uri: REDIRECT,
        ...fields,
      }),
    }),
  )

test("authorize redirects with a code and the state byte for byte, and the code exchanges once", async () => {
  const api = new WhoopAPI()
  const location = redirected(await authorize(api))
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
  expect(location.searchParams.get("state")).toBe(STATE)
  expect(location.search).toContain(`state=${STATE}`)
  const code = location.searchParams.get("code")
  if (!code) throw new Error("missing code")
  const token = await tokenRequest(api, { code })
  expect(token.status).toBe(200)
  const body = (await token.json()) as { scope: string; refresh_token?: string }
  expect(body.scope.split(" ").sort()).toEqual(SCOPES.split(" ").sort())
  expect(body.refresh_token).toBeString()
  expect((await tokenRequest(api, { code })).status).toBe(400)
})
test("a code authorized without offline exchanges to a token without refresh_token", async () => {
  const api = new WhoopAPI()
  const code = redirected(await authorize(api, { scope: "read:sleep" })).searchParams.get("code")
  const body = (await (await tokenRequest(api, { code: code ?? "" })).json()) as {
    scope: string
    refresh_token?: string
  }
  expect(body.scope).toBe("read:sleep")
  expect(body).not.toHaveProperty("refresh_token")
})
test("a code is bound to its redirect_uri and to the authorize-time PKCE challenge", async () => {
  const api = new WhoopAPI()
  const verifier = "b".repeat(64)
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  )
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  const code =
    redirected(
      await authorize(api, { code_challenge: challenge, code_challenge_method: "S256" }),
    ).searchParams.get("code") ?? ""
  expect((await tokenRequest(api, { code, redirect_uri: `${REDIRECT}/x` })).status).toBe(400)
  expect((await tokenRequest(api, { code })).status).toBe(400)
  expect((await tokenRequest(api, { code, code_verifier: verifier })).status).toBe(200)
  const plain = redirected(await authorize(api, { code_challenge: challenge }))
  expect(plain.searchParams.get("error")).toBe("invalid_request")
  expect(plain.searchParams.has("code")).toBe(false)
})
test("an unknown client or unregistered redirect_uri is answered in place and never redirected", async () => {
  const api = new WhoopAPI({
    clients: [
      { id: "mock_client", secret: "mock_client_secret" },
      { id: "web", secret: "s", redirectUris: [REDIRECT] },
    ],
  })
  const unknown = await authorize(api, { client_id: "nope" })
  expect(unknown.status).toBe(401)
  expect(unknown.headers.get("location")).toBeNull()
  expect(await unknown.json()).toMatchObject({ error: "invalid_client" })
  for (const redirect_uri of ["https://evil.example/cb", `${REDIRECT}/`, `${REDIRECT}?x=1`]) {
    const response = await authorize(api, { client_id: "web", redirect_uri })
    expect(response.status).toBe(400)
    expect(response.headers.get("location")).toBeNull()
    expect(await response.json()).toMatchObject({ error: "invalid_request" })
  }
  expect((await authorize(api, { client_id: "web" })).status).toBe(302)
  expect((await authorize(api, { client_id: undefined })).status).toBe(400)
  expect((await authorize(api, { client_id: "web", redirect_uri: undefined })).status).toBe(400)
  expect((await authorize(api, { redirect_uri: "javascript:alert(1)" })).status).toBe(400)
  expect(api.codes.list()).toHaveLength(1)
})
test("a bad response_type, scope or state redirects an error with the state and issues no code", async () => {
  const api = new WhoopAPI({
    clients: [
      { id: "mock_client", secret: "mock_client_secret" },
      { id: "narrow", secret: "s", scopes: ["offline", "read:sleep"] },
    ],
  })
  const cases: [Record<string, string | undefined>, string][] = [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ response_type: undefined }, "invalid_request"],
    [{ scope: "offline read:everything" }, "invalid_scope"],
    [{ client_id: "narrow", scope: "read:workout" }, "invalid_scope"],
    [{ state: "short" }, "invalid_state"],
    [{ state: undefined }, "invalid_state"],
  ]
  for (const [params, error] of cases) {
    const location = redirected(await authorize(api, params))
    expect(location.searchParams.get("error")).toBe(error)
    expect(location.searchParams.get("error_description")).toBeString()
    expect(location.searchParams.has("code")).toBe(false)
    if (params.state !== undefined || !("state" in params))
      expect(location.searchParams.get("state")).toBe(params.state ?? STATE)
  }
  expect(api.codes.list()).toHaveLength(0)
  // the narrow client may request its own scopes
  expect(
    redirected(await authorize(api, { client_id: "narrow", scope: "read:sleep" })).search,
  ).toContain("code=")
})
test("a state of any length of at least 8 characters is echoed unchanged", async () => {
  const api = new WhoopAPI()
  for (const state of ["12345678", "a".repeat(200), "a b&c=d/é?#"]) {
    const location = redirected(await authorize(api, { state }))
    expect(location.searchParams.get("state")).toBe(state)
  }
})
test("consent controls decide approve, deny or error per client with a default and a chosen user", async () => {
  const runtime = createRuntime({
    records: [
      {
        key: "p",
        userId: "second-user",
        collection: "profile",
        data: { user_id: 2, email: "a@example.com", first_name: "A", last_name: "B" },
      },
    ],
    clients: [
      { id: "mock_client", secret: "mock_client_secret" },
      { id: "other", secret: "s" },
    ],
  })
  const put = (id: string, value: unknown) =>
    runtime.fetch(
      new Request(`${base}/__admin/state/consents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, value: { id, ...(value as object) } }),
      }),
    )
  expect((await put("*", { decision: "deny" })).status).toBeLessThan(300)
  for (const client_id of ["mock_client", "other"]) {
    const denied = redirected(await authorize(runtime, { client_id }))
    expect(denied.searchParams.get("error")).toBe("access_denied")
    expect(denied.searchParams.get("state")).toBe(STATE)
    expect(denied.searchParams.has("code")).toBe(false)
  }
  await put("other", { decision: "error", error: "temporarily_unavailable" })
  expect(
    redirected(await authorize(runtime, { client_id: "other" })).searchParams.get("error"),
  ).toBe("temporarily_unavailable")
  await put("mock_client", { decision: "approve", userId: "second-user", codeTtlSeconds: 5 })
  const code =
    redirected(await authorize(runtime, { scope: "read:profile" })).searchParams.get("code") ?? ""
  const issued = await runtime.fetch(new Request(`${base}/__admin/state/codes`))
  expect(await issued.text()).toContain(code)
  const token = (await (
    await runtime.fetch(
      new Request(`${base}/oauth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: "mock_client",
          client_secret: "mock_client_secret",
        }),
      }),
    )
  ).json()) as { access_token: string }
  const profile = await runtime.fetch(
    new Request(`${base}/developer/v2/user/profile/basic`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
  )
  // the code was issued for the user the consent row chose
  expect(profile.status).toBe(200)
  expect(await profile.json()).toMatchObject({ user_id: 2 })
})
test("a code expires after the configured lifetime", async () => {
  let now = Date.UTC(2026, 1, 1)
  const api = new WhoopAPI({
    now: () => now,
    consents: [{ id: "*", decision: "approve", codeTtlSeconds: 5 }],
  })
  const code = redirected(await authorize(api)).searchParams.get("code") ?? ""
  now += 5000
  expect((await tokenRequest(api, { code })).status).toBe(400)
})
test("a browser connect flow runs end to end over served HTTP with namespaces isolated", async () => {
  const server = await createServer()
  try {
    const other = await fetch(
      `${server.url}/oauth/oauth2/auth?${new URLSearchParams({ response_type: "code", client_id: "mock_client", redirect_uri: REDIRECT, state: STATE })}`,
      { redirect: "manual", headers: { "x-mockingbird-namespace": "b" } },
    )
    expect(other.status).toBe(302)
    expect(other.headers.get("location")).toStartWith(`${REDIRECT}?code=`)
    const location = new URL(other.headers.get("location") ?? "")
    // a code from namespace b does not exchange in the default namespace
    const exchange = await fetch(`${server.url}/oauth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        client_id: "mock_client",
        client_secret: "mock_client_secret",
      }),
    })
    expect(exchange.status).toBe(400)
  } finally {
    await server.close()
  }
})

const profileRecord = (userId: string, user_id: number): DataRecord => ({
  key: `profile-${userId}`,
  userId,
  collection: "profile",
  data: { user_id, email: "jane@example.com", first_name: "Jane", last_name: "Doe" },
})
const profileGrant = (token: string, userId: string, scopes: string[]) => ({
  token,
  refreshToken: "",
  clientId: "mock_client",
  userId,
  scopes,
  expiresAt: 4102444800000,
})
const getProfile = (
  api: { fetch(request: Request): Promise<Response> },
  token: string,
  root = base,
) =>
  api.fetch(
    new Request(`${root}/developer/v2/user/profile/basic`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  )

test("profile/basic returns the token user's profile with read:profile", async () => {
  const api = new WhoopAPI({
    records: [profileRecord("u1", 10129), profileRecord("u2", 7)],
    grants: [profileGrant("t1", "u1", ["read:profile"])],
  })
  const response = await getProfile(api, "t1")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    user_id: 10129,
    email: "jane@example.com",
    first_name: "Jane",
    last_name: "Doe",
  })
})
test("profile/basic is 403 without read:profile, 401 for unknown or expired tokens, 404 without a fixture", async () => {
  let now = Date.UTC(2026, 1, 1)
  const api = new WhoopAPI({
    now: () => now,
    records: [profileRecord("u1", 1)],
    grants: [
      profileGrant("no-scope", "u1", ["read:cycles", "offline"]),
      profileGrant("no-fixture", "u3", ["read:profile"]),
      { ...profileGrant("short", "u1", ["read:profile"]), expiresAt: now + 1000 },
    ],
  })
  const denied = await getProfile(api, "no-scope")
  expect(denied.status).toBe(403)
  expect(await denied.json()).not.toHaveProperty("user_id")
  expect((await getProfile(api, "unknown")).status).toBe(401)
  expect((await getProfile(api, "no-fixture")).status).toBe(404)
  now += 1000
  expect((await getProfile(api, "short")).status).toBe(401)
})
test("profile/basic honors a forced 429 and isolates namespaces", async () => {
  const runtime = createRuntime({ grants: [profileGrant("t1", "u1", ["read:profile"])] })
  await runtime.fetch(
    new Request(`${base}/__admin/state/records`, {
      method: "POST",
      headers: { "x-mockingbird-namespace": "a", "content-type": "application/json" },
      body: JSON.stringify({ id: "p", value: profileRecord("u1", 5) }),
    }),
  )
  const inNamespace = (ns: string) =>
    runtime.fetch(
      new Request(`${base}/developer/v2/user/profile/basic`, {
        headers: { authorization: "Bearer t1", "x-mockingbird-namespace": ns },
      }),
    )
  expect((await inNamespace("a")).status).toBe(200)
  expect((await inNamespace("b")).status).toBe(404)
  await runtime.fetch(
    new Request(`${base}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "rate_limited", count: 1 }),
    }),
  )
  const limited = await getProfile(runtime, "t1")
  expect(limited.status).toBe(429)
  expect(limited.headers.get("retry-after")).toBe("1")
})
