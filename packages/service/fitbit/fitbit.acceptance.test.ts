import { describe, expect, test } from "bun:test"
import {
  type ActivityLog,
  createRuntime,
  type FitbitRuntimeOptions,
  type SleepLog,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  authorizeUrl,
  type Config,
  consent,
  days,
  exchangeCode,
  type Fetcher,
  get,
  getRetrying,
  pkce,
  profileId,
  refresh,
  revoke,
  SCOPE,
  syncActivities,
  syncSleep,
  syncSummaries,
} from "./test/consumer.js"

const base = "http://fitbit.test"
const config: Config = { base, clientId: "mock_client", clientSecret: "mock_client_secret" }
const redirectUri = "http://localhost:8000/api/v1/oauth/fitbit/callback"
const state = "s".repeat(43)

// 45 logs after 2026-09-01, seeded newest first so ascending order has to come from the emulator.
const logTime = (i: number) =>
  `${new Date(Date.UTC(2026, 8, 2, 6) + i * 6 * 3600_000).toISOString().slice(0, 19)}.000-07:00`
const activityLogs: ActivityLog[] = Array.from({ length: 45 }, (_, i) => ({
  userId: "ABC123",
  log: {
    logId: 1000 + i,
    activityName: "Walk",
    activityTypeId: 90013,
    activeDuration: 1800000,
    duration: 1800000,
    startTime: logTime(i),
    calories: 150 + i,
    distance: 2.5,
    distanceUnit: "Kilometer",
    steps: 3000 + i,
    speed: 5,
    elevationGain: 12,
    logType: "auto_detected",
    averageHeartRate: 110,
    heartRateZones: [{ name: "Fat Burn", min: 91, max: 127, minutes: 20 }],
    source: { id: "1", name: "Charge 6", type: "tracker" },
  },
})).reverse()
const crossing: SleepLog = {
  userId: "ABC123",
  log: {
    logId: 5001,
    dateOfSleep: "2026-09-10",
    startTime: "2026-09-09T23:30:00.000",
    endTime: "2026-09-10T07:15:00.000",
    duration: 27900000,
    efficiency: 94,
    isMainSleep: true,
    minutesAsleep: 430,
    timeInBed: 465,
    levels: {
      summary: {
        deep: { count: 4, minutes: 80 },
        light: { count: 20, minutes: 250 },
        rem: { count: 5, minutes: 100 },
        wake: { count: 22, minutes: 35 },
      },
    },
  },
}
const setup = (options: FitbitRuntimeOptions = {}) => {
  const runtime = createRuntime({
    activityLogs,
    sleepLogs: [crossing],
    dailySummaries: [
      {
        userId: "ABC123",
        date: "2026-09-10",
        activities: [{ logId: 1001, name: "Walk" }],
        summary: {
          steps: 9876,
          floors: 12,
          activityCalories: 640,
          restingHeartRate: 58,
          distances: [
            { activity: "total", distance: 7.2 },
            { activity: "tracker", distance: 7.2 },
          ],
        },
      },
    ],
    ...options,
  })
  const fetcher: Fetcher = (request) => runtime.fetch(request)
  const admin = async (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    runtime.fetch(
      new Request(`${base}/__admin${path}`, {
        method: body === undefined ? "GET" : path === "/consent" ? "PUT" : "POST",
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, fetcher, admin }
}
/** The full browser round trip: consent redirect, then the code exchange. */
const login = async (fetcher: Fetcher, scope = SCOPE) => {
  const pair = await pkce()
  const redirected = await consent(
    fetcher,
    authorizeUrl(config, { redirectUri, state, challenge: pair.challenge, scope }),
  )
  if (!redirected.code) throw new Error(`no code: ${JSON.stringify(redirected)}`)
  const tokens = await exchangeCode(fetcher, config, {
    code: redirected.code,
    redirectUri,
    verifier: pair.verifier,
  })
  return {
    ...tokens,
    access: tokens.body.access_token as string,
    refreshToken: tokens.body.refresh_token as string,
  }
}

describe("1. authorize", () => {
  test("redirects to the redirect URI with a one-time code and the state unchanged", async () => {
    const { fetcher } = setup()
    const pair = await pkce()
    const result = await consent(
      fetcher,
      authorizeUrl(config, { redirectUri, state, challenge: pair.challenge }),
    )
    expect(result).toMatchObject({ status: 302, redirected: true, origin: redirectUri, state })
    expect(result.code).toBeTruthy()
    expect(result.error).toBeUndefined()
  })
  test("a denied consent redirects with access_denied and the same state", async () => {
    const { fetcher, admin } = setup()
    expect((await admin("/consent", { mode: "deny" })).status).toBe(200)
    const pair = await pkce()
    const result = await consent(
      fetcher,
      authorizeUrl(config, { redirectUri, state, challenge: pair.challenge }),
    )
    expect(result).toMatchObject({ error: "access_denied", state, origin: redirectUri })
    expect(result.code).toBeUndefined()
    expect(result.errorDescription).toBeTruthy()
  })
  test("an error consent redirects with server_error; admin consent keeps its mode until changed", async () => {
    const { fetcher, admin } = setup()
    await admin("/consent", { mode: "error" })
    const pair = await pkce()
    const url = authorizeUrl(config, { redirectUri, state, challenge: pair.challenge })
    expect(await consent(fetcher, url)).toMatchObject({ error: "server_error", state })
    await admin("/consent", { mode: "approve" })
    expect((await consent(fetcher, url)).code).toBeTruthy()
  })
  test("a code belongs to the seeded user the consent control picks", async () => {
    const { fetcher, admin } = setup()
    await admin("/users", { encodedId: "XYZ789", profile: { displayName: "Second User" } })
    await admin("/consent", { mode: "approve", userId: "XYZ789" })
    const tokens = await login(fetcher)
    expect(tokens.body.user_id).toBe("XYZ789")
    expect(await profileId(fetcher, config, tokens.access)).toBe("XYZ789")
  })
  test("an unregistered client cannot be redirected; bad parameters redirect with an error", async () => {
    const { fetcher } = setup()
    const pair = await pkce()
    const url = authorizeUrl(config, { redirectUri, state, challenge: pair.challenge })
    const unknown = await consent(fetcher, url.replace("mock_client", "nobody"))
    expect(unknown).toEqual({ status: 400, redirected: false })
    expect(
      await consent(fetcher, url.replace("response_type=code", "response_type=token")),
    ).toMatchObject({
      error: "unsupported_response_type",
      state,
    })
    expect(
      await consent(fetcher, url.replace("scope=activity", "scope=bogus%20activity")),
    ).toMatchObject({
      error: "invalid_scope",
    })
    expect(
      await consent(
        fetcher,
        url.replace("code_challenge_method=S256", "code_challenge_method=plain"),
      ),
    ).toMatchObject({
      error: "invalid_request",
    })
  })
})

describe("2. authorization code exchange", () => {
  test("returns the full token response", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    expect(tokens.status).toBe(200)
    expect(tokens.body).toMatchObject({
      expires_in: 28800,
      token_type: "Bearer",
      scope: SCOPE,
      user_id: "ABC123",
    })
    expect(tokens.body.access_token).toBeTruthy()
    expect(tokens.body.refresh_token).toBeTruthy()
  })
  test("a second exchange, a wrong verifier, a wrong redirect URI and an expired code are 400 invalid_grant", async () => {
    const { fetcher, admin } = setup()
    const code = async () => {
      const pair = await pkce()
      const redirected = await consent(
        fetcher,
        authorizeUrl(config, { redirectUri, state, challenge: pair.challenge }),
      )
      return { code: redirected.code as string, verifier: pair.verifier }
    }
    const errorType = (body: Record<string, unknown>) =>
      (body.errors as { errorType: string }[])[0]?.errorType
    const a = await code()
    expect((await exchangeCode(fetcher, config, { ...a, redirectUri })).status).toBe(200)
    const replay = await exchangeCode(fetcher, config, { ...a, redirectUri })
    expect(replay.status).toBe(400)
    expect(errorType(replay.body)).toBe("invalid_grant")
    expect(replay.body.success).toBe(false)

    const b = await code()
    const wrongVerifier = await exchangeCode(fetcher, config, {
      ...b,
      redirectUri,
      verifier: "v".repeat(43),
    })
    expect(wrongVerifier.status).toBe(400)
    const wrongRedirect = await exchangeCode(fetcher, config, {
      ...b,
      redirectUri: "http://localhost:8000/elsewhere",
    })
    expect(wrongRedirect.status).toBe(400)
    // A failed attempt does not burn the code (documented best guess): the right call still works.
    expect((await exchangeCode(fetcher, config, { ...b, redirectUri })).status).toBe(200)

    const c = await code()
    await admin("/clock", { advance: 10 * 60_000 + 1000 })
    expect((await exchangeCode(fetcher, config, { ...c, redirectUri })).status).toBe(400)
  })
  test("missing or wrong client credentials are 401 invalid_client", async () => {
    const { fetcher } = setup()
    const response = await fetcher(
      new Request(`${base}/oauth2/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x" }),
      }),
    )
    expect(response.status).toBe(401)
    expect(
      ((await response.json()) as { errors: { errorType: string }[] }).errors[0]?.errorType,
    ).toBe("invalid_client")
    const wrong = await exchangeCode(
      fetcher,
      { ...config, clientSecret: "nope" },
      { code: "c", redirectUri, verifier: "v" },
    )
    expect(wrong.status).toBe(401)
  })
})

describe("3. refresh rotation", () => {
  test("issues a new pair, kills the old access token and refuses the old refresh token", async () => {
    const { fetcher } = setup()
    const first = await login(fetcher)
    const second = await refresh(fetcher, config, first.refreshToken)
    expect(second.status).toBe(200)
    expect(second.body.access_token).not.toBe(first.access)
    expect(second.body.refresh_token).not.toBe(first.refreshToken)
    expect(second.body).toMatchObject({
      expires_in: 28800,
      token_type: "Bearer",
      user_id: "ABC123",
      scope: SCOPE,
    })
    expect((await get(fetcher, config, first.access, "/1/user/-/profile.json")).status).toBe(401)
    expect(
      (await get(fetcher, config, second.body.access_token as string, "/1/user/-/profile.json"))
        .status,
    ).toBe(200)
    const reuse = await refresh(fetcher, config, first.refreshToken)
    expect(reuse.status).toBe(400)
    expect((reuse.body.errors as { errorType: string }[])[0]?.errorType).toBe("invalid_grant")
  })
})

describe("4. profile", () => {
  test("returns the encoded id and seeded profile fields", async () => {
    const { fetcher, admin } = setup()
    await admin("/users", { encodedId: "ABC123", profile: { displayName: "Sam", timezone: "UTC" } })
    const tokens = await login(fetcher)
    const response = await get(fetcher, config, tokens.access, "/1/user/-/profile.json")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { encodedId: "ABC123", displayName: "Sam", timezone: "UTC" },
    })
    expect(await profileId(fetcher, config, tokens.access)).toBe("ABC123")
    const named = await get(fetcher, config, tokens.access, "/1/user/ABC123/profile.json")
    expect(named.status).toBe(200)
    expect((await get(fetcher, config, tokens.access, "/1/user/OTHER/profile.json")).status).toBe(
      403,
    )
  })
})

describe("5-6. activity list pagination", () => {
  test("pages 20 / 20 / 5 in ascending startTime order, then pagination.next is empty", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const first = await get(
      fetcher,
      config,
      tokens.access,
      "/1/user/-/activities/list.json?afterDate=2026-09-01&sort=asc&limit=20&offset=0",
    )
    const body = (await first.json()) as {
      activities: { logId: number; startTime: string }[]
      pagination: Record<string, unknown>
    }
    expect(body.activities).toHaveLength(20)
    expect(body.activities.map((a) => a.startTime)).toEqual(
      body.activities.map((a) => a.startTime).sort(),
    )
    expect(body.activities[0]?.logId).toBe(1000)
    expect(body.pagination).toMatchObject({
      afterDate: "2026-09-01",
      limit: 20,
      offset: 0,
      sort: "asc",
      previous: "",
    })
    expect(body.pagination.next).toBe(
      `${base}/1/user/-/activities/list.json?afterDate=2026-09-01&offset=20&limit=20&sort=asc`,
    )
    const synced = await syncActivities(fetcher, config, tokens.access, "2026-09-01")
    expect(synced.requests.map((r) => r.match(/offset=(\d+)/)?.[1])).toEqual(["0", "20", "40"])
    expect(synced.logs.map((l) => l.logId)).toEqual(Array.from({ length: 45 }, (_, i) => 1000 + i))
    expect(synced.logs[0]).toMatchObject({
      activityName: "Walk",
      source: { id: "1", name: "Charge 6", type: "tracker" },
      heartRateZones: [{ name: "Fat Burn" }],
    })
    const last = (await (
      await get(
        fetcher,
        config,
        tokens.access,
        "/1/user/-/activities/list.json?afterDate=2026-09-01&sort=asc&limit=20&offset=40",
      )
    ).json()) as { activities: unknown[]; pagination: { next: string; previous: string } }
    expect(last.activities).toHaveLength(5)
    expect(last.pagination.next).toBe("")
    expect(last.pagination.previous).toContain("offset=20")
  })
  test("afterDate filters on the local start time and beforeDate pairs with sort=desc", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const later = await syncActivities(fetcher, config, tokens.access, "2026-09-10")
    expect(later.logs.every((l) => String(l.startTime) >= "2026-09-10")).toBe(true)
    expect(later.logs.length).toBeGreaterThan(0)
    expect(later.logs.length).toBeLessThan(45)
    const desc = await (
      await get(
        fetcher,
        config,
        tokens.access,
        "/1/user/-/activities/list.json?beforeDate=2026-09-04&sort=desc&limit=100&offset=0",
      )
    ).json()
    expect((desc as { activities: { logId: number }[] }).activities.map((a) => a.logId)).toEqual([
      1006, 1005, 1004, 1003, 1002, 1001, 1000,
    ])
  })
  test("missing or inconsistent parameters are 400 validation errors", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    for (const query of [
      "sort=asc&limit=20&offset=0",
      "afterDate=2026-09-01&beforeDate=2026-10-01&sort=asc&limit=20&offset=0",
      "afterDate=2026-09-01&sort=desc&limit=20&offset=0",
      "afterDate=2026-09-1&sort=asc&limit=20&offset=0",
      "afterDate=2026-09-01&sort=asc&limit=101&offset=0",
      "afterDate=2026-09-01&sort=asc&limit=20&offset=-1",
    ]) {
      const response = await get(
        fetcher,
        config,
        tokens.access,
        `/1/user/-/activities/list.json?${query}`,
      )
      expect(response.status).toBe(400)
      expect(
        ((await response.json()) as { errors: { errorType: string }[] }).errors[0]?.errorType,
      ).toBe("validation")
    }
  })
})

describe("7. sleep by date", () => {
  test("a log that began the previous evening is returned on the day it ended", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const response = await get(
      fetcher,
      config,
      tokens.access,
      "/1/user/-/sleep/date/2026-09-10.json",
    )
    const body = (await response.json()) as {
      sleep: { logId: number; levels: unknown }[]
      summary: Record<string, unknown>
    }
    expect(body.sleep).toHaveLength(1)
    expect(body.sleep[0]).toMatchObject({
      logId: 5001,
      startTime: "2026-09-09T23:30:00.000",
      endTime: "2026-09-10T07:15:00.000",
      duration: 27900000,
      efficiency: 94,
      isMainSleep: true,
    })
    expect(body.summary).toMatchObject({
      totalSleepRecords: 1,
      totalMinutesAsleep: 430,
      totalTimeInBed: 465,
      stages: { deep: 80, light: 250, rem: 100, wake: 35 },
    })
    const eve = (await (
      await get(fetcher, config, tokens.access, "/1/user/-/sleep/date/2026-09-09.json")
    ).json()) as { sleep: unknown[] }
    expect(eve.sleep).toEqual([])
  })
  test("a day with no logs is 200 with an empty list and zero totals", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const response = await get(
      fetcher,
      config,
      tokens.access,
      "/1/user/-/sleep/date/2026-09-11.json",
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sleep: [],
      summary: { totalMinutesAsleep: 0, totalSleepRecords: 0, totalTimeInBed: 0 },
    })
  })
  test("a 30-day window is one request per day", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const result = await syncSleep(fetcher, config, tokens.access, days("2026-08-25", 30))
    expect(result.status).toBe(200)
    expect(result.sleep.map((s) => s.logId)).toEqual([5001])
  })
})

describe("8. daily activity summary", () => {
  test("returns activities, goals and the summary fields the consumer reads", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const response = await get(
      fetcher,
      config,
      tokens.access,
      "/1/user/-/activities/date/2026-09-10.json",
    )
    const body = (await response.json()) as Record<string, Record<string, unknown>>
    expect(Object.keys(body).sort()).toEqual(["activities", "goals", "summary"])
    expect(body.summary).toMatchObject({
      steps: 9876,
      floors: 12,
      activityCalories: 640,
      restingHeartRate: 58,
    })
    expect(body.goals).toMatchObject({ steps: 10000 })
    const synced = await syncSummaries(fetcher, config, tokens.access, days("2026-09-01", 30))
    expect(synced.summaries["2026-09-10"]).toEqual({ steps: 9876, floors: 12, total: 7.2 })
    expect(synced.summaries["2026-09-11"]).toEqual({ steps: 0, floors: 0 })
  })
})

describe("9. sleep path versions", () => {
  test("/1/ and /1.2/ both serve the day, with the stage totals", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const v1 = await (
      await get(fetcher, config, tokens.access, "/1/user/-/sleep/date/2026-09-10.json")
    ).json()
    const v12 = await get(fetcher, config, tokens.access, "/1.2/user/-/sleep/date/2026-09-10.json")
    expect(v12.status).toBe(200)
    expect(await v12.json()).toEqual(v1)
    expect(
      (v1 as { sleep: { levels: { summary: { deep: { minutes: number } } } }[] }).sleep[0]?.levels
        .summary.deep.minutes,
    ).toBe(80)
  })
})

describe("10. token expiry", () => {
  test("an access token older than 28800 seconds answers 401 expired_token; refresh and retry work", async () => {
    const { fetcher, admin } = setup()
    const tokens = await login(fetcher)
    await admin("/clock", { advance: 28800 * 1000 - 1000 })
    expect((await get(fetcher, config, tokens.access, "/1/user/-/profile.json")).status).toBe(200)
    await admin("/clock", { advance: 1000 })
    for (const path of [
      "/1/user/-/profile.json",
      "/1/user/-/activities/list.json?afterDate=2026-09-01&sort=asc&limit=20&offset=0",
      "/1/user/-/sleep/date/2026-09-10.json",
      "/1/user/-/activities/date/2026-09-10.json",
    ]) {
      const response = await get(fetcher, config, tokens.access, path)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({
        errors: [{ errorType: "expired_token" }],
        success: false,
      })
    }
    const renewed = await refresh(fetcher, config, tokens.refreshToken)
    expect(renewed.status).toBe(200)
    const retried = await syncActivities(
      fetcher,
      config,
      renewed.body.access_token as string,
      "2026-09-01",
    )
    expect(retried.logs).toHaveLength(45)
  })
  test("the expire control expires tokens without moving the clock; a missing token is invalid_token", async () => {
    const { fetcher, admin } = setup()
    const tokens = await login(fetcher)
    expect(await (await admin("/tokens/expire", { userId: "ABC123" })).json()).toMatchObject({
      expired: 2,
    })
    expect((await get(fetcher, config, tokens.access, "/1/user/-/profile.json")).status).toBe(401)
    expect((await refresh(fetcher, config, tokens.refreshToken)).status).toBe(200)
    const none = await fetcher(new Request(`${base}/1/user/-/profile.json`))
    expect(await none.json()).toMatchObject({ errors: [{ errorType: "invalid_token" }] })
  })
})

describe("11. rate limiting", () => {
  test("one 429 with Retry-After: 2 is waited out and retried once", async () => {
    const { fetcher, admin } = setup()
    const tokens = await login(fetcher)
    await admin("/faults", { preset: "rate_limited", count: 1 })
    const waits: number[] = []
    const response = await getRetrying(
      fetcher,
      config,
      tokens.access,
      "/1/user/-/profile.json",
      async (s) => {
        waits.push(s)
      },
    )
    expect(waits).toEqual([2])
    expect(response.status).toBe(200)
  })
  test("a second 429 is surfaced; the no-Retry-After preset omits the header", async () => {
    const { fetcher, admin } = setup()
    const tokens = await login(fetcher)
    await admin("/faults", { preset: "rate_limited", count: 2 })
    const response = await getRetrying(
      fetcher,
      config,
      tokens.access,
      "/1/user/-/profile.json",
      async () => {},
    )
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("2")
    expect(response.headers.get("fitbit-rate-limit-remaining")).toBe("0")
    expect(await response.json()).toMatchObject({
      errors: [{ errorType: "too_many_requests" }],
      success: false,
    })
    await admin("/faults", { preset: "rate_limited_no_retry_after", count: 1 })
    const bare = await get(fetcher, config, tokens.access, "/1/user/-/profile.json")
    expect(bare.status).toBe(429)
    expect(bare.headers.get("retry-after")).toBeNull()
  })
  test("the other presets force 401, 403 and 5xx", async () => {
    const { fetcher, admin } = setup()
    const tokens = await login(fetcher)
    for (const [preset, status] of [
      ["unauthorized", 401],
      ["forbidden", 403],
      ["server_error", 500],
    ] as const) {
      await admin("/faults", { preset, count: 1 })
      expect((await get(fetcher, config, tokens.access, "/1/user/-/profile.json")).status).toBe(
        status,
      )
    }
    expect((await get(fetcher, config, tokens.access, "/1/user/-/profile.json")).status).toBe(200)
  })
})

describe("12. scopes", () => {
  test("a grant without the activity scope gets 403 insufficient_scope on the activity routes", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher, "profile sleep")
    expect(tokens.body.scope).toBe("profile sleep")
    for (const path of [
      "/1/user/-/activities/list.json?afterDate=2026-09-01&sort=asc&limit=20&offset=0",
      "/1/user/-/activities/date/2026-09-10.json",
    ]) {
      const response = await get(fetcher, config, tokens.access, path)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        errors: [{ errorType: "insufficient_scope" }],
        success: false,
      })
    }
    expect((await syncActivities(fetcher, config, tokens.access, "2026-09-01")).status).toBe(403)
    expect(
      (await get(fetcher, config, tokens.access, "/1/user/-/sleep/date/2026-09-10.json")).status,
    ).toBe(200)
    expect(await profileId(fetcher, config, tokens.access)).toBe("ABC123")
  })
})

describe("13. revoke", () => {
  test("revoking the access token ends both tokens", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const response = await revoke(fetcher, config, tokens.access)
    expect(response.status).toBe(200)
    expect((await get(fetcher, config, tokens.access, "/1/user/-/profile.json")).status).toBe(401)
    const again = await refresh(fetcher, config, tokens.refreshToken)
    expect(again.status).toBe(400)
    expect((again.body.errors as { errorType: string }[])[0]?.errorType).toBe("invalid_grant")
  })
  test("revoking the refresh token also ends the access token; an unknown token is a no-op 200", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    const other = await login(fetcher)
    expect((await revoke(fetcher, config, "not-a-token")).status).toBe(200)
    expect((await get(fetcher, config, tokens.access, "/1/user/-/profile.json")).status).toBe(200)
    expect((await revoke(fetcher, config, tokens.refreshToken)).status).toBe(200)
    // Both logins belong to one user and client, so every token of the user is gone.
    expect((await get(fetcher, config, other.access, "/1/user/-/profile.json")).status).toBe(401)
    expect((await get(fetcher, config, tokens.access, "/1/user/-/profile.json")).status).toBe(401)
  })
  test("revoke needs client credentials and a token", async () => {
    const { fetcher } = setup()
    const unauthenticated = await fetcher(
      new Request(`${base}/oauth2/revoke`, {
        method: "POST",
        body: new URLSearchParams({ token: "x" }),
      }),
    )
    expect(unauthenticated.status).toBe(401)
    const empty = await fetcher(
      new Request(`${base}/oauth2/revoke`, {
        method: "POST",
        headers: { authorization: `Basic ${btoa("mock_client:mock_client_secret")}` },
        body: new URLSearchParams({}),
      }),
    )
    expect(empty.status).toBe(400)
  })
  test("the revoke control makes the next refresh answer invalid_grant", async () => {
    const { fetcher, admin } = setup()
    const tokens = await login(fetcher)
    expect(await (await admin("/tokens/revoke", { userId: "ABC123" })).json()).toMatchObject({
      revoked: 2,
    })
    expect((await refresh(fetcher, config, tokens.refreshToken)).status).toBe(400)
  })
})

describe("14. date validation", () => {
  test("a date segment that is not YYYY-MM-DD is 400 validation on both data routes", async () => {
    const { fetcher } = setup()
    const tokens = await login(fetcher)
    for (const date of ["2026-9-10", "20260910", "2026-02-30", "yesterday", "2026-09-10T00:00"]) {
      for (const path of [
        `/1/user/-/sleep/date/${date}.json`,
        `/1.2/user/-/sleep/date/${date}.json`,
        `/1/user/-/activities/date/${date}.json`,
      ]) {
        const response = await get(fetcher, config, tokens.access, path)
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          errors: [{ errorType: "validation", fieldName: "date" }],
          success: false,
        })
      }
    }
    expect(
      (await get(fetcher, config, tokens.access, "/1/user/-/sleep/date/today.json")).status,
    ).toBe(200)
  })
})

describe("15. namespaces", () => {
  test("seeding and resetting one namespace leaves the other untouched", async () => {
    const { runtime, admin } = setup({ activityLogs: [], sleepLogs: [], dailySummaries: [] })
    const inNamespace =
      (name: string): Fetcher =>
      (request) => {
        const headers = new Headers(request.headers)
        headers.set("x-mockingbird-namespace", name)
        return runtime.fetch(new Request(request, { headers }))
      }
    const a = inNamespace("a"),
      b = inNamespace("b")
    const logs = [{ logId: 1, startTime: "2026-09-02T06:00:00.000-07:00" }]
    await admin("/activity-logs", { logs }, { "x-mockingbird-namespace": "a" })
    await admin(
      "/activity-logs",
      { logs: [{ logId: 2, startTime: "2026-09-03T06:00:00.000-07:00" }] },
      { "x-mockingbird-namespace": "b" },
    )
    await admin("/sleep-logs", { logs: [crossing.log] }, { "x-mockingbird-namespace": "a" })
    const ta = await login(a),
      tb = await login(b)
    expect(
      (await syncActivities(a, config, ta.access, "2026-09-01")).logs.map((l) => l.logId),
    ).toEqual([1])
    expect(
      (await syncActivities(b, config, tb.access, "2026-09-01")).logs.map((l) => l.logId),
    ).toEqual([2])
    await admin("/reset", {}, { "x-mockingbird-namespace": "a" })
    expect((await syncActivities(a, config, ta.access, "2026-09-01")).status).toBe(401)
    const ta2 = await login(a)
    expect((await syncActivities(a, config, ta2.access, "2026-09-01")).logs).toEqual([])
    expect((await syncSleep(a, config, ta2.access, ["2026-09-10"])).sleep).toEqual([])
    expect(
      (await syncActivities(b, config, tb.access, "2026-09-01")).logs.map((l) => l.logId),
    ).toEqual([2])
  })
})

describe("test controls and surface", () => {
  test("admin seed routes validate input and unknown users", async () => {
    const { admin } = setup()
    expect((await admin("/users", { nope: 1 })).status).toBe(400)
    expect((await admin("/activity-logs", { userId: "ghost", logs: [] })).status).toBe(404)
    expect((await admin("/activity-logs", { logs: "x" })).status).toBe(400)
    expect((await admin("/consent", { mode: "maybe" })).status).toBe(400)
    expect((await admin("/consent", { mode: "approve", userId: "ghost" })).status).toBe(404)
    expect(
      (await admin("/daily-summaries", { date: "2026-09-12", summary: { steps: 5 } })).status,
    ).toBe(201)
  })
  test("the journal holds no token or health payloads", async () => {
    const { fetcher, admin } = setup()
    const tokens = await login(fetcher)
    await get(fetcher, config, tokens.access, "/1/user/-/sleep/date/2026-09-10.json")
    const text = await (await admin("/requests")).text()
    expect(text).toContain("/1/user/-/sleep/date/2026-09-10.json")
    expect(text).not.toContain(tokens.access)
    expect(text).not.toContain(tokens.refreshToken)
    expect(text).not.toContain("27900000")
  })
  test("served over HTTP: authorize redirects and the data routes answer", async () => {
    const server = await createServer({ activityLogs, sleepLogs: [crossing] })
    try {
      const live: Config = { ...config, base: server.url }
      const fetcher: Fetcher = (request) => fetch(request)
      const pair = await pkce()
      const redirected = await consent(
        fetcher,
        authorizeUrl(live, { redirectUri, state, challenge: pair.challenge }),
      )
      expect(redirected.origin).toBe(redirectUri)
      const exchanged = await exchangeCode(fetcher, live, {
        code: redirected.code as string,
        redirectUri,
        verifier: pair.verifier,
      })
      expect(exchanged.status).toBe(200)
      expect(
        (await syncActivities(fetcher, live, exchanged.body.access_token as string, "2026-09-01"))
          .logs,
      ).toHaveLength(45)
    } finally {
      await server.close()
    }
  })
})
