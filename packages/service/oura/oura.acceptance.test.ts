import { expect, test } from "bun:test"
import { createRuntime, type DataRecord, OuraAPI } from "./src/index.js"
import { createServer } from "./src/server.js"
import { refresh, synchronize } from "./test/consumer.js"

const base = "http://oura.test"
const records: DataRecord[] = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"].map(
  (day, i) => ({
    key: `row-${i}`,
    userId: "synthetic-user",
    collection: "workout",
    data: {
      id: `synthetic-workout-${i}`,
      day,
      activity: "walking",
      calories: null,
      distance: null,
      intensity: "moderate",
      source: "manual",
      label: null,
      start_datetime: `${day}T09:00:00Z`,
      end_datetime: `${day}T10:00:00Z`,
    },
  }),
)
test("bounded day windows paginate once and preserve null metrics and ids", async () => {
  const api = new OuraAPI({ records, pageSize: 1 })
  const result = await synchronize((r) => api.fetch(r), base, "workout", "mock_oura_token", {
    start_date: "2026-01-02",
    end_date: "2026-01-03",
  })
  expect(result.records).toEqual(records.slice(1, 3).map((r) => r.data))
  expect(result.records[0]?.calories).toBeNull()
  const empty = await synchronize((r) => api.fetch(r), base, "sleep", "mock_oura_token", {})
  expect(empty.records).toEqual([])
})
test("heart rate uses timestamps without invented ids; all daily collections filter day", async () => {
  const api = new OuraAPI({
    records: [
      {
        key: "heart-1",
        userId: "synthetic-user",
        collection: "heartrate",
        data: { timestamp: "2026-01-02T10:00:00Z", bpm: 60, source: "rest" },
      },
      ...["daily_activity", "daily_spo2", "daily_readiness", "daily_sleep", "sleep"].map(
        (collection) =>
          ({
            key: collection,
            collection,
            userId: "synthetic-user",
            data: { id: `synthetic-${collection}`, day: "2026-01-02", score: null },
          }) as DataRecord,
      ),
    ],
  })
  const heart = await synchronize((r) => api.fetch(r), base, "heartrate", "mock_oura_token", {
    start_datetime: "2026-01-02T09:00:00Z",
    end_datetime: "2026-01-02T11:00:00Z",
  })
  expect(heart.records).toEqual([{ timestamp: "2026-01-02T10:00:00Z", bpm: 60, source: "rest" }])
  for (const collection of [
    "daily_activity",
    "daily_spo2",
    "daily_readiness",
    "daily_sleep",
    "sleep",
  ])
    expect(
      (
        await synchronize((r) => api.fetch(r), base, collection, "mock_oura_token", {
          start_date: "2026-01-02",
          end_date: "2026-01-02",
        })
      ).records,
    ).toHaveLength(1)
})
test("expired access refreshes for same user and refresh is single use", async () => {
  let now = 1000
  const api = new OuraAPI({ now: () => now, records, tokenTtlSeconds: 1 })
  const first = await refresh((r) => api.fetch(r), base, "mock_oura_refresh")
  const token = (await first.json()) as { access_token: string; refresh_token: string }
  now += 1000
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", token.access_token, {})).status,
  ).toBe(401)
  const renewed = (await (
    await refresh((r) => api.fetch(r), base, token.refresh_token)
  ).json()) as { access_token: string }
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", renewed.access_token, {})).records,
  ).toHaveLength(4)
  expect(
    await (await refresh((r) => api.fetch(r), base, token.refresh_token)).json(),
  ).toMatchObject({ error: "invalid_grant" })
})
test("authorization code is client and redirect bound; Basic credentials work", async () => {
  const api = new OuraAPI({
    now: () => 1000,
    codes: [
      {
        code: "mock_code",
        clientId: "mock_client",
        userId: "synthetic-user",
        scopes: ["daily"],
        expiresAt: 2000,
        redirectUri: "https://example.invalid/callback",
      },
    ],
  })
  const exchange = (redirect: string) =>
    api.fetch(
      new Request(`${base}/oauth/token`, {
        method: "POST",
        headers: { authorization: `Basic ${btoa("mock_client:mock_client_secret")}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "mock_code",
          redirect_uri: redirect,
        }),
      }),
    )
  expect((await exchange("https://example.invalid/wrong")).status).toBe(400)
  const token = (await (await exchange("https://example.invalid/callback")).json()) as {
    access_token: string
  }
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", token.access_token, {})).status,
  ).toBe(403)
  expect((await exchange("https://example.invalid/callback")).status).toBe(400)
})
test("concurrent PKCE exchanges consume one code exactly once", async () => {
  const verifier = "a".repeat(43)
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  )
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  const api = new OuraAPI({
    codes: [
      {
        code: "mock_code",
        clientId: "mock_client",
        userId: "synthetic-user",
        scopes: ["daily"],
        expiresAt: 4102444800000,
        challenge,
      },
    ],
  })
  const exchange = () =>
    api.fetch(
      new Request(`${base}/oauth/token`, {
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
})
test("namespace reset, admin seeding, clock and journal redact credentials", async () => {
  const runtime = createRuntime({ records, pageSize: 1 })
  const request = (path: string, namespace: string, init: RequestInit = {}) =>
    runtime.fetch(
      new Request(`${base}${path}`, {
        ...init,
        headers: { "x-mockingbird-namespace": namespace, ...init.headers },
      }),
    )
  await request("/__admin/state/records", "a", {
    method: "POST",
    body: JSON.stringify({
      id: "extra",
      value: { ...records[0], key: "extra", data: { id: "extra", day: "2026-01-02" } },
    }),
    headers: { "content-type": "application/json" },
  })
  await request("/__admin/reset", "b", { method: "POST" })
  expect(
    (
      await synchronize(
        (r) => runtime.fetch(r),
        `${base}/__admin/ns/a`,
        "workout",
        "mock_oura_token",
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
        "mock_oura_token",
        {},
      )
    ).records,
  ).toHaveLength(4)
  await refresh((r) => runtime.fetch(r), `${base}/__admin/ns/a`, "mock_oura_refresh")
  const journal = JSON.stringify(await (await request("/__admin/requests", "a")).json())
  expect(journal).not.toContain("mock_client_secret")
  expect(journal).not.toContain("mock_oura_refresh")
})
test("served HTTP retains failures, malformed cursors and all presets", async () => {
  const server = await createServer({ records })
  try {
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
      expect((await synchronize(fetch, server.url, "workout", "mock_oura_token", {})).status).toBe(
        status,
      )
    }
    await fetch(`${server.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "connection_drop", count: 1 }),
    })
    await expect(
      synchronize((r) => server.runtime.fetch(r), server.url, "workout", "mock_oura_token", {}),
    ).rejects.toThrow()
    expect(
      (
        await synchronize(fetch, server.url, "workout", "mock_oura_token", {
          next_token: "unknown",
        })
      ).status,
    ).toBe(400)
  } finally {
    await server.close()
  }
})

const STATE = "Zk3_9aB-q7LmN2xPvT0yR5uWcD8eHfJgKsAoIlXb1Qw"
const REDIRECT = "http://localhost:8000/api/v1/oauth/oura/callback"
const SCOPES = "daily heartrate session spo2 workout personal"
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
  return api.fetch(new Request(`${root}/oauth/authorize?${query}`, { redirect: "manual" }))
}
const redirected = (response: Response) => {
  expect(response.status).toBe(302)
  const location = response.headers.get("location")
  if (!location) throw new Error("missing location")
  return new URL(location)
}
const tokenRequest = (api: OuraAPI, fields: Record<string, string | undefined>) => {
  const body = new URLSearchParams({ grant_type: "authorization_code" })
  for (const [key, value] of Object.entries({ redirect_uri: REDIRECT, ...fields }))
    if (value !== undefined) body.set(key, value)
  return api.fetch(
    new Request(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
      },
      body,
    }),
  )
}

test("authorize redirects with a code and the state byte for byte, and the code exchanges once", async () => {
  const api = new OuraAPI()
  const location = redirected(await authorize(api))
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
  expect(location.searchParams.get("state")).toBe(STATE)
  expect(location.search).toContain(`state=${STATE}`)
  const code = location.searchParams.get("code")
  if (!code) throw new Error("missing code")
  const token = await tokenRequest(api, { code })
  expect(token.status).toBe(200)
  const { access_token } = (await token.json()) as { access_token: string }
  expect(api.grants.get(access_token)?.scopes).toEqual(SCOPES.split(" "))
  expect((await tokenRequest(api, { code })).status).toBe(400)
})
test("an omitted scope grants every scope, and an omitted state is not invented", async () => {
  const api = new OuraAPI()
  const location = redirected(await authorize(api, { scope: undefined, state: undefined }))
  expect(location.searchParams.has("state")).toBe(false)
  const token = (await (
    await tokenRequest(api, { code: location.searchParams.get("code") ?? "" })
  ).json()) as { access_token: string }
  expect(api.grants.get(token.access_token)?.scopes).toEqual([
    "email",
    "personal",
    "daily",
    "heartrate",
    "workout",
    "tag",
    "session",
    "spo2",
  ])
})
test("a client with exactly one registered redirect URI may omit redirect_uri", async () => {
  const api = new OuraAPI({
    clients: [
      { id: "mock_client", secret: "mock_client_secret", redirectUris: [REDIRECT] },
      { id: "two", secret: "s", redirectUris: [REDIRECT, "http://localhost:9000/cb"] },
      { id: "none", secret: "s" },
    ],
  })
  const location = redirected(await authorize(api, { redirect_uri: undefined }))
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
  // the caller did not send a redirect_uri, so the token exchange must not either
  const code = location.searchParams.get("code") ?? ""
  expect((await tokenRequest(api, { code })).status).toBe(400)
  const again = redirected(await authorize(api, { redirect_uri: undefined }))
  expect(
    (
      await tokenRequest(api, {
        code: again.searchParams.get("code") ?? "",
        redirect_uri: undefined,
      })
    ).status,
  ).toBe(200)
  for (const client_id of ["two", "none"]) {
    const response = await authorize(api, { client_id, redirect_uri: undefined })
    expect(response.status).toBe(400)
    expect(response.headers.get("location")).toBeNull()
  }
})
test("a code sent with a redirect_uri is bound to it and to the PKCE challenge", async () => {
  const api = new OuraAPI()
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
  expect((await tokenRequest(api, { code, code_verifier: "c".repeat(64) })).status).toBe(400)
  expect((await tokenRequest(api, { code, code_verifier: verifier })).status).toBe(200)
  const plain = redirected(await authorize(api, { code_challenge: challenge }))
  expect(plain.searchParams.get("error")).toBe("invalid_request")
  expect(plain.searchParams.has("code")).toBe(false)
})
test("an unknown client or unregistered redirect_uri is answered in place and never redirected", async () => {
  const api = new OuraAPI({
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
  expect((await authorize(api, { client_id: undefined })).status).toBe(400)
  expect((await authorize(api, { redirect_uri: "javascript:alert(1)" })).status).toBe(400)
  expect((await authorize(api, { redirect_uri: undefined })).status).toBe(400)
  expect(api.codes.list()).toHaveLength(0)
})
test("a bad response_type or scope redirects an error with the state and issues no code", async () => {
  const api = new OuraAPI({
    clients: [
      { id: "mock_client", secret: "mock_client_secret" },
      { id: "narrow", secret: "s", scopes: ["daily"] },
    ],
  })
  const cases: [Record<string, string | undefined>, string][] = [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ response_type: undefined }, "invalid_request"],
    [{ scope: "daily everything" }, "invalid_scope"],
    [{ client_id: "narrow", scope: "workout" }, "invalid_scope"],
  ]
  for (const [params, error] of cases) {
    const location = redirected(await authorize(api, params))
    expect(location.searchParams.get("error")).toBe(error)
    expect(location.searchParams.get("error_description")).toBeString()
    expect(location.searchParams.get("state")).toBe(STATE)
    expect(location.searchParams.has("code")).toBe(false)
  }
  expect(api.codes.list()).toHaveLength(0)
  expect(
    redirected(await authorize(api, { client_id: "narrow", scope: "daily" })).search,
  ).toContain("code=")
})
test("a state of any length is echoed unchanged", async () => {
  const api = new OuraAPI()
  for (const state of ["x", "12345678", "a".repeat(200), "a b&c=d/é?#"])
    expect(redirected(await authorize(api, { state })).searchParams.get("state")).toBe(state)
})
test("consent controls decide approve, deny or error per client with a default and a chosen user", async () => {
  const runtime = createRuntime({
    clients: [
      { id: "mock_client", secret: "mock_client_secret" },
      { id: "other", secret: "s" },
    ],
    records: [
      {
        key: "pi",
        userId: "second-user",
        collection: "personal_info",
        data: { id: "second-user", age: 30 },
      },
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
  await put("mock_client", { decision: "approve", userId: "second-user" })
  const code = redirected(await authorize(runtime)).searchParams.get("code") ?? ""
  expect(await (await runtime.fetch(new Request(`${base}/__admin/state/codes`))).text()).toContain(
    code,
  )
  const token = (await (
    await runtime.fetch(
      new Request(`${base}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
        }),
      }),
    )
  ).json()) as { access_token: string }
  const info = await runtime.fetch(
    new Request(`${base}/v2/usercollection/personal_info`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
  )
  // the code was issued for the user the consent row chose
  expect(info.status).toBe(200)
  expect(await info.json()).toMatchObject({ id: "second-user" })
})
test("a code expires after the configured lifetime", async () => {
  let now = Date.UTC(2026, 1, 1)
  const api = new OuraAPI({
    now: () => now,
    consents: [{ id: "*", decision: "approve", codeTtlSeconds: 5 }],
  })
  const code = redirected(await authorize(api)).searchParams.get("code") ?? ""
  now += 5000
  expect((await tokenRequest(api, { code })).status).toBe(400)
})
test("a browser connect flow runs over served HTTP and a code stays in its namespace", async () => {
  const server = await createServer()
  try {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "mock_client",
      redirect_uri: REDIRECT,
      state: STATE,
    })
    const other = await fetch(`${server.url}/oauth/authorize?${query}`, {
      redirect: "manual",
      headers: { "x-mockingbird-namespace": "b" },
    })
    expect(other.status).toBe(302)
    expect(other.headers.get("location")).toStartWith(`${REDIRECT}?code=`)
    const location = new URL(other.headers.get("location") ?? "")
    const exchange = await fetch(`${server.url}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
      }),
    })
    expect(exchange.status).toBe(400)
  } finally {
    await server.close()
  }
})

const personalRecord = (userId: string, id: string): DataRecord => ({
  key: `personal-${userId}`,
  userId,
  collection: "personal_info",
  data: {
    id,
    age: 34,
    weight: 70.5,
    height: 1.75,
    biological_sex: "female",
    email: "jane@example.com",
  },
})
const personalGrant = (token: string, userId: string, scopes: string[]) => ({
  token,
  refreshToken: "",
  clientId: "mock_client",
  userId,
  scopes,
  expiresAt: 4102444800000,
})
const getInfo = (api: { fetch(request: Request): Promise<Response> }, token: string) =>
  api.fetch(
    new Request(`${base}/v2/usercollection/personal_info`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  )

test("personal_info returns the token user's info with the personal scope", async () => {
  const api = new OuraAPI({
    records: [personalRecord("u1", "user-1"), personalRecord("u2", "user-2")],
    grants: [personalGrant("t1", "u1", ["personal"])],
  })
  const response = await getInfo(api, "t1")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    id: "user-1",
    age: 34,
    weight: 70.5,
    height: 1.75,
    biological_sex: "female",
    email: "jane@example.com",
  })
})
test("personal_info is 403 without personal, 401 for unknown or expired tokens, 404 without a fixture", async () => {
  let now = Date.UTC(2026, 1, 1)
  const api = new OuraAPI({
    now: () => now,
    records: [personalRecord("u1", "user-1")],
    grants: [
      personalGrant("no-scope", "u1", ["daily"]),
      personalGrant("no-fixture", "u3", ["personal"]),
      { ...personalGrant("short", "u1", ["personal"]), expiresAt: now + 1000 },
    ],
  })
  const denied = await getInfo(api, "no-scope")
  expect(denied.status).toBe(403)
  expect(await denied.json()).not.toHaveProperty("id")
  const unknown = await getInfo(api, "unknown")
  expect(unknown.status).toBe(401)
  const list = await api.fetch(
    new Request(`${base}/v2/usercollection/workout`, {
      headers: { authorization: "Bearer unknown" },
    }),
  )
  expect(await unknown.json()).toEqual(await list.json())
  expect((await getInfo(api, "no-fixture")).status).toBe(404)
  now += 1000
  expect((await getInfo(api, "short")).status).toBe(401)
})
test("personal_info honors a forced 429 and isolates namespaces", async () => {
  const runtime = createRuntime({ grants: [personalGrant("t1", "u1", ["personal"])] })
  await runtime.fetch(
    new Request(`${base}/__admin/state/records`, {
      method: "POST",
      headers: { "x-mockingbird-namespace": "a", "content-type": "application/json" },
      body: JSON.stringify({ id: "p", value: personalRecord("u1", "user-1") }),
    }),
  )
  const inNamespace = (ns: string) =>
    runtime.fetch(
      new Request(`${base}/v2/usercollection/personal_info`, {
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
  const limited = await getInfo(runtime, "t1")
  expect(limited.status).toBe(429)
  expect(limited.headers.get("retry-after")).toBe("1")
})
