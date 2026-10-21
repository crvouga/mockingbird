import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, type ExerciseSeed, PolarAPI, type PolarAPIOptions } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  authorizeUrl,
  DEFAULT_RETRY_SECONDS,
  exchangeCode,
  followConsent,
  getExercise,
  listExercises,
  ReauthorizationRequired,
  registerUser,
  tokenRequest,
} from "./test/consumer.js"

const base = "http://polar.test"
const clientId = "mock_client",
  clientSecret = "mock_client_secret",
  redirectUri = "https://app.example.com/polar/callback"
const day = 24 * 60 * 60 * 1000
const noon = Date.UTC(2026, 0, 31, 12)
const iso = (ms: number) => new Date(ms).toISOString()

const exercise = (id: string, uploadedAt: number, xUserId = 1001): ExerciseSeed => ({
  xUserId,
  id,
  upload_time: iso(uploadedAt),
  start_time: iso(uploadedAt - 3_600_000).slice(0, 19),
  start_time_utc_offset: 120,
  duration: "PT2H44M",
  calories: 1480,
  distance: 28123.5,
  device: "Polar Vantage V",
  sport: "RUNNING",
  detailed_sport_info: "TRAIL_RUNNING",
  heart_rate: { average: 131, maximum: 171 },
})
const registeredAt = noon - 10 * day
/** A registered user (token `mock_polar_token`) with the three exercises of behavior 5. */
const registered = (extra: PolarAPIOptions = {}) =>
  new PolarAPI({
    now: () => noon,
    registrations: [{ xUserId: 1001, memberId: "m-1", registeredAt: iso(registeredAt) }],
    exercises: [
      exercise("2AC312F", noon - 3 * day),
      exercise("2AC3130", noon - 2 * day),
      exercise("2AC3131", noon - day),
    ],
    ...extra,
  })
const call = (api: { fetch: (r: Request) => Promise<Response> }) => (r: Request) => api.fetch(r)
const token = "mock_polar_token"

describe("OAuth consent and code exchange", () => {
  test("1. the consent page redirects with a one-time code and the state unchanged", async () => {
    const api = new PolarAPI({ now: () => noon })
    const url = authorizeUrl(base, { clientId, redirectUri, state: "s-1 /x" })
    const landed = await followConsent(call(api), url)
    expect(landed.status).toBe(302)
    expect(landed.location?.startsWith(`${redirectUri}?code=`)).toBe(true)
    expect(landed.code).toBeTruthy()
    expect(landed.state).toBe("s-1 /x")
    expect(landed.error).toBeNull()
    expect((await followConsent(call(api), url)).code).not.toBe(landed.code)
  })

  test("1. a consent-denied control redirects with error=access_denied and the state", async () => {
    const api = new PolarAPI({ now: () => noon, settings: { consent: "deny" } })
    const landed = await followConsent(
      call(api),
      authorizeUrl(base, { clientId, redirectUri, state: "s-2" }),
    )
    expect(landed).toMatchObject({ status: 302, error: "access_denied", state: "s-2", code: null })
    expect(api.codes.count()).toBe(0)
  })

  test("1. an unknown client or an unregistered redirect_uri is not redirected", async () => {
    const api = new PolarAPI({
      now: () => noon,
      clients: [{ id: clientId, secret: clientSecret, redirectUris: [redirectUri] }],
    })
    expect(
      (
        await followConsent(
          call(api),
          authorizeUrl(base, { clientId: "nope", redirectUri, state: "s" }),
        )
      ).status,
    ).toBe(400)
    const other = await followConsent(
      call(api),
      authorizeUrl(base, { clientId, redirectUri: "https://evil.example.com/cb", state: "s" }),
    )
    expect(other.status).toBe(400)
  })

  test("2. a valid code exchanges for a token with an integer expires_in and x_user_id", async () => {
    const api = new PolarAPI({ now: () => noon, users: [{ xUserId: 10579457 }] })
    const { code } = await followConsent(
      call(api),
      authorizeUrl(base, { clientId, redirectUri, state: "s" }),
    )
    const result = await exchangeCode(call(api), base, {
      clientId,
      clientSecret,
      code: code ?? "",
      redirectUri,
    })
    if (!result.ok) throw new Error("exchange failed")
    expect(result.token).toMatchObject({
      tokenType: "bearer",
      expiresIn: 31535999,
      xUserId: 10579457,
    })
    // The token works on the API.
    expect((await registerUser(call(api), base, result.token.accessToken, "m-1")).status).toBe(200)
  })

  test("2. a second use of the code, an unknown client or a wrong secret is 400", async () => {
    const api = new PolarAPI({ now: () => noon })
    const code = async () =>
      (await followConsent(call(api), authorizeUrl(base, { clientId, redirectUri, state: "s" })))
        .code ?? ""
    const first = await code()
    const used = { clientId, clientSecret, code: first, redirectUri }
    expect((await exchangeCode(call(api), base, used)).ok).toBe(true)
    expect(await exchangeCode(call(api), base, used)).toEqual({
      ok: false,
      status: 400,
      error: "invalid_grant",
    })
    expect(
      await exchangeCode(call(api), base, { ...used, code: await code(), clientId: "nope" }),
    ).toEqual({ ok: false, status: 400, error: "invalid_client" })
    expect(
      await exchangeCode(call(api), base, { ...used, code: await code(), clientSecret: "wrong" }),
    ).toEqual({ ok: false, status: 400, error: "invalid_client" })
    expect(
      await exchangeCode(call(api), base, {
        ...used,
        code: await code(),
        redirectUri: "https://app.example.com/other",
      }),
    ).toEqual({ ok: false, status: 400, error: "invalid_grant" })
  })

  test("2. a code expires after ten minutes on the emulator clock", async () => {
    let now = noon
    const api = new PolarAPI({ now: () => now })
    const { code } = await followConsent(
      call(api),
      authorizeUrl(base, { clientId, redirectUri, state: "s" }),
    )
    now += 10 * 60 * 1000
    const result = await exchangeCode(call(api), base, {
      clientId,
      clientSecret,
      code: code ?? "",
      redirectUri,
    })
    expect(result).toMatchObject({ ok: false, error: "invalid_grant" })
  })

  test("3. grant_type=refresh_token is a 400 and mints nothing", async () => {
    const api = new PolarAPI({ now: () => noon })
    const response = await api.fetch(
      tokenRequest(base, { clientId, clientSecret }, "refresh_token"),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_request" })
    expect(api.tokens.count()).toBe(1)
  })

  test("2. a body that is not form encoded is invalid_request", async () => {
    const api = new PolarAPI({ now: () => noon })
    const response = await api.fetch(
      new Request(`${base}/v2/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ grant_type: "authorization_code" }),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_request" })
  })
})

describe("registration", () => {
  test("4. registering succeeds once, then a second registration is 409", async () => {
    const api = new PolarAPI({ now: () => noon, users: [{ xUserId: 1001 }, { xUserId: 1002 }] })
    const first = await registerUser(call(api), base, token, "m-1")
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      "polar-user-id": 1001,
      "member-id": "m-1",
      "registration-date": iso(noon),
    })
    expect((await registerUser(call(api), base, token, "m-1")).status).toBe(409)
    expect((await registerUser(call(api), base, token, "m-other")).status).toBe(409)
  })

  test("4. a member-id already held by another user is 409", async () => {
    const api = new PolarAPI({
      now: () => noon,
      users: [{ xUserId: 1001 }, { xUserId: 1002 }],
      tokens: [
        { token: "t-1", clientId, xUserId: 1001, revoked: false },
        { token: "t-2", clientId, xUserId: 1002, revoked: false },
      ],
    })
    expect((await registerUser(call(api), base, "t-1", "m-1")).status).toBe(200)
    expect((await registerUser(call(api), base, "t-2", "m-1")).status).toBe(409)
    expect(api.registrations.count()).toBe(1)
  })

  test("4. a body without member-id is 400 and a non-JSON body is 415, registering nothing", async () => {
    const api = new PolarAPI({ now: () => noon })
    const post = (init: RequestInit) =>
      api.fetch(
        new Request(`${base}/v3/users`, {
          method: "POST",
          ...init,
          headers: { authorization: `Bearer ${token}`, ...init.headers },
        }),
      )
    expect(
      (await post({ headers: { "content-type": "application/json" }, body: "{}" })).status,
    ).toBe(400)
    expect(
      (await post({ headers: { "content-type": "text/plain" }, body: "member-id=m-1" })).status,
    ).toBe(415)
    expect(api.registrations.count()).toBe(0)
  })
})

describe("exercises", () => {
  test("5. three exercises uploaded after registration come back with the consumer's fields", async () => {
    const api = registered()
    const { status, exercises } = await listExercises(call(api), base, token)
    expect(status).toBe(200)
    expect(exercises).toHaveLength(3)
    expect(exercises[0]).toEqual({
      id: "2AC312F",
      device: "Polar Vantage V",
      sport: "RUNNING",
      detailedSportInfo: "TRAIL_RUNNING",
      startTime: iso(noon - 3 * day - 3_600_000).slice(0, 19),
      startTimeUtcOffsetMinutes: 120,
      durationSeconds: 9840,
      calories: 1480,
      distance: 28123.5,
      heartRateAverage: 131,
      heartRateMaximum: 171,
    })
  })

  test("5. a minimal seed still carries every field the consumer requires", async () => {
    const api = registered({
      exercises: [
        { xUserId: 1001, id: "MIN1", upload_time: iso(noon - day), start_time: iso(noon - day) },
      ],
    })
    expect((await listExercises(call(api), base, token)).exercises.map((e) => e.id)).toEqual([
      "MIN1",
    ])
  })

  test("5. samples, zones and route are absent unless asked for", async () => {
    const api = registered({
      exercises: [
        {
          ...exercise("WITH1", noon - day),
          samples: [{ "sample-type": "0", data: "1,2" }],
          heart_rate_zones: [{ index: 1 }],
          route: [{ latitude: 1, longitude: 2 }],
        },
      ],
    })
    const get = async (query: string) =>
      (await (
        await api.fetch(
          new Request(`${base}/v3/exercises?${query}`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).json()) as Record<string, unknown>[]
    const plain = (await get("samples=false&zones=false&route=false"))[0]
    expect(plain).not.toHaveProperty("samples")
    expect(plain).not.toHaveProperty("heart_rate_zones")
    expect(plain).not.toHaveProperty("route")
    const full = (await get("samples=true&zones=true&route=true"))[0]
    expect(full?.samples).toEqual([{ "sample-type": "0", data: "1,2" }])
    expect(full?.heart_rate_zones).toEqual([{ index: 1 }])
    expect(full?.route).toEqual([{ latitude: 1, longitude: 2 }])
    expect(
      (
        await api.fetch(
          new Request(`${base}/v3/exercises?samples=maybe`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(400)
  })

  test("6. exercises uploaded before registration or over 30 days ago are absent", async () => {
    const api = registered({
      registrations: [{ xUserId: 1001, memberId: "m-1", registeredAt: iso(noon - 40 * day) }],
      exercises: [
        exercise("BEFORE", noon - 41 * day),
        exercise("OLD", noon - 31 * day),
        exercise("EDGE", noon - 30 * day),
        exercise("NEW", noon - day),
      ],
    })
    expect((await listExercises(call(api), base, token)).exercises.map((e) => e.id)).toEqual([
      "EDGE",
      "NEW",
    ])
    // Registration, not only age, bounds the window.
    const late = registered({
      registrations: [{ xUserId: 1001, memberId: "m-1", registeredAt: iso(noon - 2 * day) }],
    })
    expect((await listExercises(call(late), base, token)).exercises.map((e) => e.id)).toEqual([
      "2AC3130",
      "2AC3131",
    ])
    expect((await getExercise(call(late), base, token, "2AC312F")).status).toBe(404)
  })

  test("6. the 30-day window follows the emulator clock", async () => {
    let now = noon
    const api = registered({ now: () => now })
    expect((await listExercises(call(api), base, token)).exercises).toHaveLength(3)
    now = noon + 28 * day
    // Exactly 30 days old is still visible; older is not.
    expect((await listExercises(call(api), base, token)).exercises.map((e) => e.id)).toEqual([
      "2AC3130",
      "2AC3131",
    ])
    now = noon + 29 * day
    expect((await listExercises(call(api), base, token)).exercises.map((e) => e.id)).toEqual([
      "2AC3131",
    ])
    now = noon + 40 * day
    expect((await listExercises(call(api), base, token)).exercises).toEqual([])
  })

  test("7. a registered user with no exercises gets 200 and an empty array", async () => {
    const api = registered({ exercises: [] })
    const response = await api.fetch(
      new Request(`${base}/v3/exercises`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  test("8. one exercise by id; an unknown id, or another user's, is 404", async () => {
    const api = registered({
      users: [{ xUserId: 1001 }, { xUserId: 1002 }],
      exercises: [exercise("MINE", noon - day), exercise("THEIRS", noon - day, 1002)],
    })
    expect((await getExercise(call(api), base, token, "MINE")).exercise?.id).toBe("MINE")
    expect((await getExercise(call(api), base, token, "NOPE")).status).toBe(404)
    expect((await getExercise(call(api), base, token, "THEIRS")).status).toBe(404)
    // And only the caller's exercises are listed.
    expect((await listExercises(call(api), base, token)).exercises.map((e) => e.id)).toEqual([
      "MINE",
    ])
  })

  test("9. an unregistered user's token gets 403 on the list and on a single exercise", async () => {
    const api = new PolarAPI({ now: () => noon, exercises: [exercise("A", noon - day)] })
    expect(await listExercises(call(api), base, token)).toEqual({ status: 403, exercises: [] })
    expect((await getExercise(call(api), base, token, "A")).status).toBe(403)
    // Registration unlocks it, for exercises uploaded after it only.
    await registerUser(call(api), base, token, "m-1")
    expect((await listExercises(call(api), base, token)).exercises).toEqual([])
  })
})

describe("failure modes", () => {
  test("10. an unknown, missing or revoked token is 401 and the consumer must re-authorize", async () => {
    const api = registered()
    expect((await api.fetch(new Request(`${base}/v3/exercises`))).status).toBe(401)
    await expect(listExercises(call(api), base, "bogus")).rejects.toBeInstanceOf(
      ReauthorizationRequired,
    )
    expect(api.revoke(token)).toBe(true)
    await expect(listExercises(call(api), base, token)).rejects.toBeInstanceOf(
      ReauthorizationRequired,
    )
    await expect(getExercise(call(api), base, token, "2AC312F")).rejects.toBeInstanceOf(
      ReauthorizationRequired,
    )
    expect((await registerUser(call(api), base, token, "m-1")).status).toBe(401)
  })

  test("10. the revoke control and the unauthorized preset answer 401 on the next call", async () => {
    const runtime = createRuntime({
      clock: createClock(() => noon),
      registrations: [{ xUserId: 1001, memberId: "m-1", registeredAt: iso(registeredAt) }],
    })
    const admin = (path: string, body: unknown) =>
      runtime.fetch(
        new Request(`${base}/__admin/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    await admin("faults", { preset: "unauthorized", count: 1 })
    await expect(listExercises(call(runtime), base, token)).rejects.toBeInstanceOf(
      ReauthorizationRequired,
    )
    expect((await listExercises(call(runtime), base, token)).status).toBe(200)
    expect((await admin("tokens/revoke", { token })).status).toBe(200)
    await expect(listExercises(call(runtime), base, token)).rejects.toBeInstanceOf(
      ReauthorizationRequired,
    )
    expect((await admin("tokens/revoke", { token: "nope" })).status).toBe(404)
  })

  test("11. a forced 429 carries the RateLimit headers; without Retry-After the consumer waits 5 s once", async () => {
    const runtime = createRuntime({
      clock: createClock(() => noon),
      registrations: [{ xUserId: 1001, memberId: "m-1", registeredAt: iso(registeredAt) }],
    })
    const force = (preset: string, count = 1) =>
      runtime.fetch(
        new Request(`${base}/__admin/faults`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ preset, count }),
        }),
      )
    await force("rate_limited")
    const limited = await runtime.fetch(
      new Request(`${base}/v3/exercises`, { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(limited.status).toBe(429)
    expect(limited.headers.get("ratelimit-usage")).toBe("501, 501")
    expect(limited.headers.get("ratelimit-limit")).toBe("500, 5000")
    expect(limited.headers.get("ratelimit-reset")).toBe("899, 86399")
    expect(limited.headers.get("retry-after")).toBeNull()

    const waits: number[] = []
    const sleep = async (seconds: number) => void waits.push(seconds)
    await force("rate_limited")
    expect((await listExercises(call(runtime), base, token, { sleep })).status).toBe(200)
    expect(waits).toEqual([DEFAULT_RETRY_SECONDS])

    // With a Retry-After the consumer honors it instead.
    await force("rate_limited_retry_after")
    expect((await listExercises(call(runtime), base, token, { sleep })).status).toBe(200)
    expect(waits).toEqual([5, 5])
    await runtime.fetch(
      new Request(`${base}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: 429, headers: { "retry-after": "2" }, count: 1 }),
      }),
    )
    await listExercises(call(runtime), base, token, { sleep })
    expect(waits).toEqual([5, 5, 2])

    // Retried once only: a second 429 is the answer.
    await force("rate_limited", 2)
    expect((await listExercises(call(runtime), base, token, { sleep })).status).toBe(429)
  })

  test("a forced 5xx surfaces as the status", async () => {
    const runtime = createRuntime({ clock: createClock(() => noon) })
    await runtime.fetch(
      new Request(`${base}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset: "server_error", count: 1 }),
      }),
    )
    expect((await listExercises(call(runtime), base, token)).status).toBe(500)
  })
})

describe("namespaces and controls", () => {
  const post = (
    runtime: ReturnType<typeof createRuntime>,
    path: string,
    ns: string,
    body: unknown,
  ) =>
    runtime.fetch(
      new Request(`${base}/__admin/${path}`, {
        method: "POST",
        headers: { "x-mockingbird-namespace": ns, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )

  test("12. seeding and resetting one namespace leaves the other's users, registrations and exercises", async () => {
    const runtime = createRuntime({ clock: createClock(() => noon) })
    await post(runtime, "registrations", "a", {
      xUserId: 1001,
      memberId: "m-a",
      registeredAt: iso(registeredAt),
    })
    await post(runtime, "exercises", "a", exercise("A1", noon - day))
    await post(runtime, "users", "a", { xUserId: 2002 })
    await post(runtime, "registrations", "b", {
      xUserId: 1001,
      memberId: "m-b",
      registeredAt: iso(registeredAt),
    })
    await post(runtime, "exercises", "b", exercise("B1", noon - day))
    const list = async (ns: string) =>
      (
        await listExercises(
          (r) => {
            r.headers.set("x-mockingbird-namespace", ns)
            return runtime.fetch(r)
          },
          base,
          token,
        )
      ).exercises.map((e) => e.id)
    expect(await list("a")).toEqual(["A1"])
    expect(await list("b")).toEqual(["B1"])
    await post(runtime, "reset", "a", {})
    // `a` is back to its seed (user unregistered => 403 => no exercises); `b` is untouched.
    expect(await list("a")).toEqual([])
    expect(await list("b")).toEqual(["B1"])
  })

  test("12. the /__admin/ns/<name> prefix selects a namespace for the browser's consent page", async () => {
    const runtime = createRuntime({ clock: createClock(() => noon) })
    await runtime.fetch(
      new Request(`${base}/__admin/settings`, {
        method: "PUT",
        headers: { "x-mockingbird-namespace": "denied", "content-type": "application/json" },
        body: JSON.stringify({ consent: "deny" }),
      }),
    )
    const landed = (ns: string) =>
      followConsent(
        (r) => runtime.fetch(r),
        authorizeUrl(`${base}/__admin/ns/${ns}`, { clientId, redirectUri, state: "s" }),
      )
    expect((await landed("denied")).error).toBe("access_denied")
    expect((await landed("approved")).code).toBeTruthy()
  })

  test("consent controls: approve as a chosen user, deny, or fail the page", async () => {
    const api = new PolarAPI({ now: () => noon, users: [{ xUserId: 1001 }, { xUserId: 2002 }] })
    const url = authorizeUrl(base, { clientId, redirectUri, state: "s" })
    api.updateSettings({ consentUser: 2002 })
    const { code } = await followConsent(call(api), url)
    const exchanged = await exchangeCode(call(api), base, {
      clientId,
      clientSecret,
      code: code ?? "",
      redirectUri,
    })
    expect(exchanged.ok && exchanged.token.xUserId).toBe(2002)
    api.updateSettings({ consent: "error" })
    expect(await followConsent(call(api), url)).toMatchObject({ error: "server_error", state: "s" })
  })

  test("a bad scope is redirected as invalid_scope; the settings control validates", async () => {
    const runtime = createRuntime({ clock: createClock(() => noon) })
    const landed = await followConsent(
      (r) => runtime.fetch(r),
      `${authorizeUrl(base, { clientId, redirectUri, state: "s" }).replace("accesslink.read_all", "other")}`,
    )
    expect(landed.error).toBe("invalid_scope")
    const bad = await runtime.fetch(
      new Request(`${base}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: "maybe" }),
      }),
    )
    expect(bad.status).toBe(400)
  })

  test("journals never hold the client secret, tokens or member ids", async () => {
    const runtime = createRuntime({ clock: createClock(() => noon) })
    await runtime.fetch(tokenRequest(base, { clientId, clientSecret, code: "x" }))
    await registerUser((r) => runtime.fetch(r), base, token, "member-secret-1")
    const journal = await (await runtime.fetch(new Request(`${base}/__admin/requests`))).text()
    expect(journal).not.toContain(clientSecret)
    expect(journal).not.toContain(btoa(`${clientId}:${clientSecret}`))
    expect(journal).not.toContain("member-secret-1")
  })
})

test("served over HTTP: authorize, exchange, register, list, with a browser-style redirect", async () => {
  const server = await createServer({
    clock: createClock(() => noon),
    exercises: [exercise("HTTP1", noon + 1000)],
  })
  try {
    const landed = await followConsent(
      fetch,
      authorizeUrl(server.url, { clientId, redirectUri, state: "s-http" }),
    )
    expect(landed.state).toBe("s-http")
    const exchanged = await exchangeCode(fetch, server.url, {
      clientId,
      clientSecret,
      code: landed.code ?? "",
      redirectUri,
    })
    if (!exchanged.ok) throw new Error("exchange failed")
    const access = exchanged.token.accessToken
    expect((await registerUser(fetch, server.url, access, "m-http")).status).toBe(200)
    expect((await registerUser(fetch, server.url, access, "m-http")).status).toBe(409)
    expect((await listExercises(fetch, server.url, access)).exercises.map((e) => e.id)).toEqual([
      "HTTP1",
    ])
    expect(await (await fetch(`${server.url}/__admin/health`)).json()).toMatchObject({
      status: "ok",
    })
  } finally {
    await server.close()
  }
})
