import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ACCESS_TOKEN,
  DEFAULT_CLIENT,
  DEFAULT_USER,
  type SeedWorkout,
  SuuntoAPI,
  type SuuntoAPIOptions,
} from "./src/index.js"
import { createRuntime } from "./src/runtime.js"
import { createServer } from "./src/server.js"
import {
  claims,
  consentUrl,
  type Fetcher,
  SuuntoClient,
  SuuntoError,
  windows,
} from "./test/consumer.js"

const base = "http://suunto.test"
const redirectUri = "http://localhost:8000/callback"
const DAY = 86_400_000
const T0 = Date.UTC(2026, 8, 1)
const REAL_NOW = Date.UTC(2026, 8, 20)

const workout = (
  workoutId: number,
  startTime: number,
  extra: Partial<SeedWorkout> = {},
): SeedWorkout => ({
  workoutId,
  activityId: 3,
  startTime,
  stopTime: startTime + 3_600_000,
  totalTime: 3600,
  totalDistance: 10_000,
  name: `Run ${workoutId}`,
  ...extra,
})
const workouts = [
  workout(1001, T0 + 1 * DAY),
  workout(1002, T0 + 5 * DAY, { hrdata: { workoutAvgHR: 140, min: 90 } }),
  workout(1003, T0 + 9 * DAY, { gear: { manufacturer: "Suunto", displayName: "Suunto 9" } }),
]
const seeds: SuuntoAPIOptions = {
  workouts,
  sleepSamples: [
    {
      timestamp: T0 + 2 * DAY,
      entryData: { BedtimeStart: "2026-09-02T22:00:00+00:00", Duration: 27000, IsNap: false },
    },
    { timestamp: T0 + 3 * DAY, entryData: { Duration: 25200, SleepQualityScore: 80 } },
    { timestamp: T0 + 40 * DAY, entryData: { Duration: 1 } },
  ],
  activitySamples: [
    { timestamp: T0 + 4 * DAY, entryData: { HR: 61, StepCount: 12 } },
    { timestamp: T0 + 2 * DAY, entryData: { HR: 58 } },
  ],
  dailyStatistics: [
    { name: "stepcount", time: "2026-09-02T00:00:00+00:00", value: 8000 },
    { name: "stepcount", time: "2026-09-03T00:00:00+00:00", value: 9100 },
    { name: "energyconsumption", time: "2026-09-02T00:00:00+00:00", value: 2200 },
  ],
}

type Ctx = ReturnType<typeof setup>
const setup = (options: SuuntoAPIOptions = {}, client: { subscriptionKey?: string } = {}) => {
  let now = REAL_NOW
  const api = new SuuntoAPI({ ...seeds, ...options, now: () => now })
  const fetcher: Fetcher = (request) => api.fetch(request)
  const sleeps: number[] = []
  const make = (extra: Partial<ConstructorParameters<typeof SuuntoClient>[0]> = {}) =>
    new SuuntoClient({
      fetcher,
      dataUrl: base,
      authorizeUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
      clientId: DEFAULT_CLIENT.clientId,
      clientSecret: DEFAULT_CLIENT.clientSecret,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      ...client,
      ...extra,
    })
  return { api, fetcher, sleeps, make, tick: (ms: number) => (now += ms) }
}
/** Consent in a "browser", then redeem the code as the consumer does. */
const connect = async (ctx: Ctx, state = "s-1") => {
  const consumer = ctx.make()
  const consent = await ctx.fetcher(new Request(consentUrl(consumer.config, redirectUri, state)))
  const location = new URL(consent.headers.get("location") ?? "")
  const tokens = await consumer.exchangeCode(location.searchParams.get("code") ?? "", redirectUri)
  return { consumer, consent, location, tokens }
}
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (error instanceof SuuntoError) return error
    throw error
  }
  throw new Error("expected a rejection")
}

describe("1 authorize", () => {
  test("redirects to redirect_uri with a one-time code and the state unchanged", async () => {
    const { consent, location } = await connect(setup(), "state-1_x")
    expect(consent.status).toBe(302)
    expect(location.origin + location.pathname).toBe(redirectUri)
    expect(location.searchParams.get("code")).toBeTruthy()
    expect(location.searchParams.get("state")).toBe("state-1_x")
  })

  test("an unencoded redirect_uri that has its own query keeps it", async () => {
    const ctx = setup()
    const response = await ctx.fetcher(
      new Request(
        `${base}/oauth/authorize?response_type=code&client_id=mock_client&redirect_uri=http://localhost:8000/cb?tenant=a&state=xyz`,
      ),
    )
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.searchParams.get("tenant")).toBe("a")
    expect(location.searchParams.get("code")).toBeTruthy()
  })

  test("a denied consent redirects with error=access_denied and the state", async () => {
    const ctx = setup({ settings: { consent: "deny" } })
    const response = await ctx.fetcher(
      new Request(consentUrl(ctx.make().config, redirectUri, "s-2")),
    )
    const location = new URL(response.headers.get("location") ?? "")
    expect(response.status).toBe(302)
    expect(location.searchParams.get("error")).toBe("access_denied")
    expect(location.searchParams.get("error_description")).toBeTruthy()
    expect(location.searchParams.get("state")).toBe("s-2")
    expect(location.searchParams.get("code")).toBeNull()
  })

  test("a failing consent page redirects with error=server_error", async () => {
    const ctx = setup({ settings: { consent: "error" } })
    const response = await ctx.fetcher(new Request(consentUrl(ctx.make().config, redirectUri, "s")))
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "server_error",
    )
  })

  test("an unknown client or an unregistered redirect URI is never redirected", async () => {
    const ctx = setup({ clients: [{ ...DEFAULT_CLIENT, redirectUris: [redirectUri] }] })
    const unknown = await ctx.fetcher(
      new Request(
        `${base}/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${redirectUri}&state=s`,
      ),
    )
    expect(unknown.status).toBe(400)
    expect(unknown.headers.get("location")).toBeNull()
    expect(await unknown.json()).toMatchObject({ error: "unauthorized_client" })
    const other = await ctx.fetcher(
      new Request(
        `${base}/oauth/authorize?response_type=code&client_id=mock_client&redirect_uri=http://evil.test/cb&state=s`,
      ),
    )
    expect(other.status).toBe(400)
    expect(other.headers.get("location")).toBeNull()
  })
})

describe("2 token: authorization_code", () => {
  test("answers a JWT access token with sub and user claims, a JWT refresh token and the documented fields", async () => {
    const { tokens } = await connect(setup())
    expect(tokens).toMatchObject({ token_type: "bearer", expires_in: 86400, scope: "workout" })
    expect(claims(tokens.access_token)).toEqual({
      sub: DEFAULT_USER.subject,
      user: DEFAULT_USER.username,
    })
    expect(claims(tokens.refresh_token).sub).toBe(DEFAULT_USER.subject)
    expect(tokens.refresh_token.split(".")).toHaveLength(3)
  })

  test("a reused code is a 400 invalid_grant, a wrong secret a 401 invalid_client, with no state change", async () => {
    const ctx = setup()
    const consumer = ctx.make()
    const location = new URL(
      (await ctx.fetcher(new Request(consentUrl(consumer.config, redirectUri, "s")))).headers.get(
        "location",
      ) ?? "",
    )
    const code = location.searchParams.get("code") ?? ""
    const wrong = await rejection(
      ctx.make({ clientSecret: "wrong" }).exchangeCode(code, redirectUri),
    )
    expect(wrong.status).toBe(401)
    expect(wrong.body).toMatchObject({ error: "invalid_client" })
    const mismatched = await rejection(consumer.exchangeCode(code, "http://localhost:8000/other"))
    expect(mismatched.body).toMatchObject({ error: "invalid_grant" })
    // The failed attempts above did not spend the code.
    await consumer.exchangeCode(code, redirectUri).catch(() => undefined)
    const reuse = await rejection(ctx.make().exchangeCode(code, redirectUri))
    expect(reuse.status).toBe(400)
    expect(reuse.body).toMatchObject({ error: "invalid_grant" })
  })

  test("Basic credentials are required", async () => {
    const ctx = setup()
    const response = await ctx.fetcher(
      new Request(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=x&client_id=mock_client&client_secret=mock_client_secret",
      }),
    )
    expect(response.status).toBe(401)
  })

  test("an unsupported grant type is rejected", async () => {
    const ctx = setup()
    const response = await ctx.fetcher(
      new Request(`${base}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
        },
        body: "grant_type=password",
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" })
  })
})

describe("3 token: refresh_token", () => {
  test("answers a new access token; the refresh token is reusable by default", async () => {
    const { consumer, tokens } = await connect(setup())
    const first = await consumer.refresh()
    expect(first.access_token).not.toBe(tokens.access_token)
    expect(claims(first.access_token).user).toBe(DEFAULT_USER.username)
    expect(first.refresh_token).toBe(tokens.refresh_token)
    expect(first.expires_in).toBe(86400)
    await consumer.refresh()
  })

  test("with rotateRefreshTokens the old refresh token is spent", async () => {
    const ctx = setup({ settings: { rotateRefreshTokens: true } })
    const { consumer, tokens } = await connect(ctx)
    const next = await consumer.refresh()
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    const stale = ctx.make({ refreshToken: tokens.refresh_token })
    expect((await rejection(stale.refresh())).body).toMatchObject({ error: "invalid_grant" })
    await consumer.refresh()
  })

  test("an unknown refresh token is invalid_grant", async () => {
    const error = await rejection(setup().make({ refreshToken: "nope" }).refresh())
    expect(error.status).toBe(400)
    expect(error.body).toMatchObject({ error: "invalid_grant" })
  })
})

describe("4 subscription key", () => {
  const key = "sub-key-123"
  test("a missing or wrong key is the gateway's 401 and the token is not consulted", async () => {
    const ctx = setup({ settings: { subscriptionKey: key } })
    const { tokens } = await connect(ctx)
    const missing = await rejection(ctx.make({ accessToken: tokens.access_token }).workouts())
    expect(missing.status).toBe(401)
    expect(missing.body).toEqual({
      statusCode: 401,
      message: expect.stringContaining("missing subscription key"),
    })
    // An unknown token with a wrong key still gets the key message, not the token one.
    const wrong = await rejection(
      ctx.make({ subscriptionKey: "wrong", accessToken: "garbage" }).workouts(),
    )
    expect(wrong.body).toEqual({
      statusCode: 401,
      message: expect.stringContaining("invalid subscription key"),
    })
    // And an expired token with the right key gets the token message.
    ctx.tick(2 * DAY)
    const expired = await rejection(
      ctx.make({ subscriptionKey: key, accessToken: tokens.access_token }).workouts(),
    )
    expect(expired.body).toEqual({
      statusCode: 401,
      message: expect.stringContaining("Access token"),
    })
  })

  test("the right key passes, and so does any request when no key is configured", async () => {
    const keyed = setup({ settings: { subscriptionKey: key } }, { subscriptionKey: key })
    expect(await keyed.make({ accessToken: DEFAULT_ACCESS_TOKEN }).workouts()).toHaveLength(3)
    const open = setup()
    expect(await open.make({ accessToken: DEFAULT_ACCESS_TOKEN }).workouts()).toHaveLength(3)
  })

  test("the OAuth routes do not need the key", async () => {
    const ctx = setup({ settings: { subscriptionKey: key } })
    await connect(ctx)
  })

  test("a bare token without the word Bearer is accepted too (the vendor's own curl example)", async () => {
    const ctx = setup()
    const response = await ctx.fetcher(
      new Request(`${base}/v3/workouts/`, { headers: { authorization: DEFAULT_ACCESS_TOKEN } }),
    )
    expect(response.status).toBe(200)
  })
})

describe("5-7 workouts", () => {
  test("lists the seeded workouts in {error: null, payload}, each with the required fields", async () => {
    const ctx = setup()
    const response = await ctx.fetcher(
      new Request(
        `${base}/v3/workouts/?since=0&limit=100&offset=0&filter-by-modification-time=true`,
        {
          headers: { authorization: `Bearer ${DEFAULT_ACCESS_TOKEN}`, accept: "application/json" },
        },
      ),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { error: null; payload: Record<string, unknown>[] }
    expect(body.error).toBeNull()
    expect(body.payload).toHaveLength(3)
    for (const item of body.payload)
      for (const field of ["workoutId", "activityId", "startTime", "stopTime", "totalTime"])
        expect(typeof item[field]).toBe("number")
    expect(body.payload[1]).toMatchObject({ workoutId: 1002, hrdata: { workoutAvgHR: 140 } })
    expect(body.payload[2]).toMatchObject({ gear: { displayName: "Suunto 9" } })
  })

  test("only the trailing-slash path is served (best guess: the issue sends it; the bare path is a gateway 404)", async () => {
    const ctx = setup()
    const response = await ctx.fetcher(
      new Request(`${base}/v3/workouts`, {
        headers: { authorization: `Bearer ${DEFAULT_ACCESS_TOKEN}` },
      }),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ statusCode: 404, message: "Resource not found" })
  })

  test("since (epoch seconds, as the consumer sends it) returns only workouts after that instant", async () => {
    const ctx = setup()
    const consumer = ctx.make({ accessToken: DEFAULT_ACCESS_TOKEN })
    const between = (T0 + 3 * DAY) / 1000
    expect((await consumer.workouts(between)).map((w) => w.workoutId)).toEqual([1002, 1003])
    expect(
      (await consumer.workouts((T0 + 5 * DAY + 3_600_000) / 1000)).map((w) => w.workoutId),
    ).toEqual([1003])
    expect(await consumer.workouts((T0 + 30 * DAY) / 1000)).toEqual([])
    expect(await consumer.workouts(0)).toHaveLength(3)
  })

  test("since in milliseconds is read as milliseconds", async () => {
    const ctx = setup()
    const consumer = ctx.make({ accessToken: DEFAULT_ACCESS_TOKEN })
    const body = (await consumer.get("/v3/workouts/", { since: String(T0 + 3 * DAY) })) as {
      payload: { workoutId: number }[]
    }
    expect(body.payload.map((w) => w.workoutId)).toEqual([1002, 1003])
  })

  test("filter-by-modification-time compares since with the modification time, otherwise the start time", async () => {
    const ctx = setup({
      workouts: [
        workout(1, T0 + DAY, { modifiedAt: T0 + 20 * DAY }),
        workout(2, T0 + 10 * DAY, { modifiedAt: T0 + 11 * DAY }),
      ],
    })
    const consumer = ctx.make({ accessToken: DEFAULT_ACCESS_TOKEN })
    const since = String((T0 + 15 * DAY) / 1000)
    const ids = async (filter: string) =>
      (
        (await consumer.get("/v3/workouts/", { since, "filter-by-modification-time": filter })) as {
          payload: { workoutId: number }[]
        }
      ).payload.map((w) => w.workoutId)
    expect(await ids("true")).toEqual([1])
    expect(await ids("false")).toEqual([])
  })

  test("offset and limit return the next window, and the paging consumer follows it", async () => {
    const many = Array.from({ length: 250 }, (_, i) => workout(2000 + i, T0 + i * 60_000))
    const ctx = setup({ workouts: many })
    const consumer = ctx.make({ accessToken: DEFAULT_ACCESS_TOKEN })
    expect(await consumer.workouts()).toHaveLength(100)
    const second = (await consumer.get("/v3/workouts/", { limit: "100", offset: "100" })) as {
      payload: { workoutId: number }[]
    }
    expect(second.payload.map((w) => w.workoutId)).toEqual(
      many.slice(100, 200).map((w) => w.workoutId),
    )
    expect(await consumer.allWorkouts()).toHaveLength(250)
  })

  test("a malformed since, limit or offset is a 400 in the API's error shape", async () => {
    const consumer = setup().make({ accessToken: DEFAULT_ACCESS_TOKEN })
    for (const query of [
      { since: "yesterday" },
      { limit: "0" },
      { offset: "-1" },
      { "filter-by-modification-time": "maybe" },
    ]) {
      const error = await rejection(consumer.get("/v3/workouts/", query))
      expect(error.status).toBe(400)
      expect(error.body).toMatchObject({ code: 400, error: expect.any(String) })
    }
  })

  test("a workout by key passes through; another user's or an unknown key is a 404", async () => {
    const ctx = setup({
      users: [DEFAULT_USER, { subject: "sub-2", username: "second" }],
      workouts: [...workouts, workout(7, T0, { subject: "sub-2" })],
    })
    const consumer = ctx.make({ accessToken: DEFAULT_ACCESS_TOKEN })
    expect(await consumer.workout("1002")).toMatchObject({
      error: null,
      payload: { workoutId: 1002 },
    })
    expect((await rejection(consumer.workout("7"))).status).toBe(404)
    expect((await rejection(consumer.workout("nope"))).status).toBe(404)
    expect((await consumer.workouts()).map((w) => w.workoutId)).toEqual([1001, 1002, 1003])
  })

  test("a workout missing a required field cannot be seeded", () => {
    expect(() => new SuuntoAPI({ workouts: [{ workoutId: 1 } as unknown as SeedWorkout] })).toThrow(
      /activityId/,
    )
  })
})

describe("8-10 24/7 samples", () => {
  const range = [T0, T0 + 10 * DAY] as const
  test("sleep: the samples inside the window; an empty window is []", async () => {
    const consumer = setup().make({ accessToken: DEFAULT_ACCESS_TOKEN })
    const samples = await consumer.sleep(...range)
    expect(samples.map((s) => s.timestamp)).toEqual([T0 + 2 * DAY, T0 + 3 * DAY])
    expect(samples[0]?.entryData).toMatchObject({ Duration: 27000, IsNap: false })
    expect(await consumer.sleep(T0 + 5 * DAY, T0 + 8 * DAY)).toEqual([])
  })

  test("activity: a top-level array in timestamp order", async () => {
    const consumer = setup().make({ accessToken: DEFAULT_ACCESS_TOKEN })
    const samples = await consumer.activity(...range)
    expect(samples.map((s) => s.timestamp)).toEqual([T0 + 2 * DAY, T0 + 4 * DAY])
    expect(samples[1]?.entryData).toEqual({ HR: 61, StepCount: 12 })
  })

  test("daily statistics: one entry per Name with Sources[].Samples[]", async () => {
    const ctx = setup()
    const consumer = ctx.make({ accessToken: DEFAULT_ACCESS_TOKEN })
    const response = await ctx.fetcher(
      new Request(
        `${base}/247/daily-activity-statistics?startdate=2026-09-01T00:00:00&enddate=2026-09-15T00:00:00`,
        {
          headers: { authorization: `Bearer ${DEFAULT_ACCESS_TOKEN}` },
        },
      ),
    )
    expect(response.status).toBe(200)
    const stats = await consumer.dailyStatistics(T0, T0 + 14 * DAY)
    expect(stats.map((s) => s.Name).sort()).toEqual(["energyconsumption", "stepcount"])
    const steps = stats.find((s) => s.Name === "stepcount")
    expect(steps?.Sources).toEqual([
      {
        Name: "Suunto",
        Samples: [
          { Value: 8000, TimeISO8601: "2026-09-02T00:00:00+00:00" },
          { Value: 9100, TimeISO8601: "2026-09-03T00:00:00+00:00" },
        ],
      },
    ])
    expect(await consumer.dailyStatistics(T0 + 6 * DAY, T0 + 8 * DAY)).toEqual([])
  })

  test("the consumer's chunks (20 days for samples, 14 for statistics) all fit the limit", async () => {
    const consumer = setup().make({ accessToken: DEFAULT_ACCESS_TOKEN })
    expect(windows(T0, T0 + 45 * DAY, 20)).toHaveLength(3)
    // T0 + 40 days is exactly where one chunk ends and the next begins: `to` is exclusive.
    const sleep = await consumer.sleep(T0, T0 + 45 * DAY)
    expect(sleep.map((s) => s.timestamp)).toEqual([T0 + 2 * DAY, T0 + 3 * DAY, T0 + 40 * DAY])
    expect(consumer.skipped).toEqual([])
  })

  test("only the user's own samples are returned", async () => {
    const ctx = setup({
      users: [DEFAULT_USER, { subject: "sub-2", username: "second" }],
      sleepSamples: [
        { timestamp: T0 + DAY, entryData: { Duration: 1 } },
        { subject: "sub-2", timestamp: T0 + 2 * DAY, entryData: { Duration: 2 } },
      ],
    })
    expect(
      (await ctx.make({ accessToken: DEFAULT_ACCESS_TOKEN }).sleep(...range)).map(
        (s) => s.entryData.Duration,
      ),
    ).toEqual([1])
  })

  test("malformed or missing window parameters are a 400", async () => {
    const consumer = setup().make({ accessToken: DEFAULT_ACCESS_TOKEN })
    for (const [path, query] of [
      ["/247samples/sleep", {}],
      ["/247samples/sleep", { from: "a", to: "b" }],
      ["/247samples/activity", { from: String(T0 + DAY), to: String(T0) }],
      ["/247/daily-activity-statistics", { startdate: "2026-09-01" }],
      ["/247/daily-activity-statistics", { startdate: "yesterday", enddate: "today" }],
    ] as const) {
      const error = await rejection(consumer.get(path, { ...query }))
      expect(error.status).toBe(400)
      expect(error.body).toMatchObject({ code: 400 })
    }
  })
})

describe("11 window limit", () => {
  test("a window over the limit is a 4xx the consumer logs and skips", async () => {
    const consumer = setup().make({ accessToken: DEFAULT_ACCESS_TOKEN })
    // The consumer chunked at 40 days here, past the 28-day limit.
    expect(await consumer.sleep(T0, T0 + 40 * DAY, 40)).toEqual([])
    expect(await consumer.activity(T0, T0 + 40 * DAY, 40)).toEqual([])
    expect(await consumer.dailyStatistics(T0, T0 + 40 * DAY, 40)).toEqual([])
    expect(consumer.skipped.map((e) => e.status)).toEqual([400, 400, 400])
    expect(consumer.skipped[0]?.body).toMatchObject({ error: expect.stringContaining("28 days") })
  })

  test("exactly the limit is accepted, and the limit is a setting", async () => {
    const ctx = setup({ settings: { maxWindowDays: 7 } })
    const consumer = ctx.make({ accessToken: DEFAULT_ACCESS_TOKEN })
    expect(await consumer.sleep(T0, T0 + 7 * DAY, 7)).toHaveLength(2)
    await consumer.sleep(T0, T0 + 8 * DAY, 8)
    expect(consumer.skipped).toHaveLength(1)
  })
})

describe("12-14 failures on the next N calls", () => {
  const preset = (runtime: ReturnType<typeof createRuntime>, name: string, count: number) =>
    runtime.fetch(
      new Request(`${base}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset: name, count }),
      }),
    )
  const served = (options: SuuntoAPIOptions = {}) => {
    const runtime = createRuntime({ ...seeds, ...options })
    const sleeps: number[] = []
    const consumer = new SuuntoClient({
      fetcher: (r) => runtime.fetch(r),
      dataUrl: base,
      authorizeUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
      clientId: "mock_client",
      clientSecret: "mock_client_secret",
      accessToken: DEFAULT_ACCESS_TOKEN,
      refreshToken: "mock_suunto_refresh",
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    return { runtime, consumer, sleeps }
  }

  test("200 with {error, code: 429} in the body: the consumer raises the body's code", async () => {
    const { runtime, consumer } = served()
    await preset(runtime, "error_in_body", 1)
    const error = await rejection(consumer.workouts())
    expect(error.status).toBe(429)
    expect(error.body).toEqual({ error: "rate_limited", code: 429 })
    expect(await consumer.workouts()).toHaveLength(3)
  })

  test("an expired access token is a 401; the consumer refreshes once and retries", async () => {
    const ctx = setup()
    const { tokens, consumer } = await connect(ctx)
    ctx.tick(2 * DAY)
    expect(consumer.refreshes).toBe(0)
    const rows = await consumer.workouts()
    expect(rows).toHaveLength(3)
    expect(consumer.refreshes).toBe(1)
    expect(consumer.accessToken).not.toBe(tokens.access_token)
  })

  test("forced token expiry (admin) and the unauthorized preset both 401 once", async () => {
    const { runtime, consumer } = served()
    await runtime.fetch(
      new Request(`${base}/__admin/tokens/expire`, { method: "POST", body: "{}" }),
    )
    expect(await consumer.workouts()).toHaveLength(3)
    expect(consumer.refreshes).toBe(1)
    await preset(runtime, "unauthorized", 1)
    expect(await consumer.workouts()).toHaveLength(3)
    expect(consumer.refreshes).toBe(2)
  })

  test("429 with Retry-After: 2: the consumer waits 2 s and retries once", async () => {
    const { runtime, consumer, sleeps } = served()
    await preset(runtime, "rate_limited", 1)
    expect(await consumer.workouts()).toHaveLength(3)
    expect(sleeps).toEqual([2000])
    await preset(runtime, "rate_limited", 2)
    const error = await rejection(consumer.workouts())
    expect(error.status).toBe(429)
    expect(error.body).toEqual({
      statusCode: 429,
      message: "Rate limit is exceeded. Try again in 2 seconds.",
    })
    expect(sleeps).toEqual([2000, 2000])
  })

  test("429 without Retry-After, 5xx and a dropped connection", async () => {
    const { runtime, consumer, sleeps } = served()
    await preset(runtime, "rate_limited_no_retry_after", 1)
    expect(await consumer.workouts()).toHaveLength(3)
    expect(sleeps).toEqual([1000])
    await preset(runtime, "server_error", 1)
    expect((await rejection(consumer.workouts())).status).toBe(500)
    await preset(runtime, "connection_drop", 1)
    await expect(consumer.workouts()).rejects.toThrow()
    expect(await consumer.workouts()).toHaveLength(3)
  })

  test("a fault on the data routes leaves the OAuth routes alone", async () => {
    const { runtime, consumer } = served()
    await preset(runtime, "server_error", 5)
    expect((await consumer.refresh()).access_token).toBeTruthy()
  })
})

describe("15 namespaces", () => {
  test("seeding and resetting one leaves the other's users, tokens, workouts and samples unchanged", async () => {
    const runtime = createRuntime(seeds)
    const call = (namespace: string, path: string, init: RequestInit = {}) =>
      runtime.fetch(
        new Request(`${base}${path}`, {
          ...init,
          headers: { "x-mockingbird-namespace": namespace, ...init.headers },
        }),
      )
    const consumer = (namespace: string) =>
      new SuuntoClient({
        fetcher: (r) => {
          const next = new Request(r, { headers: new Headers(r.headers) })
          next.headers.set("x-mockingbird-namespace", namespace)
          return runtime.fetch(next)
        },
        dataUrl: base,
        authorizeUrl: `${base}/oauth/authorize`,
        tokenUrl: `${base}/oauth/token`,
        clientId: "mock_client",
        clientSecret: "mock_client_secret",
        accessToken: DEFAULT_ACCESS_TOKEN,
      })
    const post = (path: string, body: unknown) =>
      call("a", path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await post("/__admin/workouts", workout(9999, T0))).status).toBe(201)
    expect(
      (await post("/__admin/samples/sleep", { timestamp: T0 + DAY, entryData: { Duration: 9 } }))
        .status,
    ).toBe(201)
    expect(await consumer("a").workouts()).toHaveLength(4)
    expect(await consumer("b").workouts()).toHaveLength(3)
    expect(await consumer("a").sleep(T0, T0 + 10 * DAY)).toHaveLength(3)
    expect(await consumer("b").sleep(T0, T0 + 10 * DAY)).toHaveLength(2)
    await call("b", "/__admin/reset", { method: "POST" })
    expect(await consumer("a").workouts()).toHaveLength(4)
    await call("a", "/__admin/reset", { method: "POST" })
    expect(await consumer("a").workouts()).toHaveLength(3)
  })

  test("settings are per namespace", async () => {
    const runtime = createRuntime(seeds)
    const put = (namespace: string) =>
      runtime.fetch(
        new Request(`${base}/__admin/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
          body: JSON.stringify({ subscriptionKey: "k" }),
        }),
      )
    await put("a")
    const get = (namespace: string) =>
      runtime.fetch(
        new Request(`${base}/v3/workouts/`, {
          headers: {
            authorization: `Bearer ${DEFAULT_ACCESS_TOKEN}`,
            "x-mockingbird-namespace": namespace,
          },
        }),
      )
    expect((await get("a")).status).toBe(401)
    expect((await get("b")).status).toBe(200)
  })
})

describe("test controls and contract", () => {
  const admin = (
    runtime: ReturnType<typeof createRuntime>,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    runtime.fetch(
      new Request(`${base}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

  test("admin: seed a user, mint tokens whose claims name it, change settings", async () => {
    const runtime = createRuntime({ workouts })
    expect(
      (await admin(runtime, "POST", "/users", { username: "second", subject: "sub-2" })).status,
    ).toBe(201)
    const minted = (await (
      await admin(runtime, "POST", "/tokens", { username: "second" })
    ).json()) as {
      access_token: string
      refresh_token: string
    }
    expect(claims(minted.access_token)).toEqual({ sub: "sub-2", user: "second" })
    const consumer = new SuuntoClient({
      fetcher: (r) => runtime.fetch(r),
      dataUrl: base,
      authorizeUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
      clientId: "mock_client",
      clientSecret: "mock_client_secret",
      accessToken: minted.access_token,
    })
    expect(await consumer.workouts()).toEqual([])
    expect((await admin(runtime, "POST", "/tokens", { username: "nobody" })).status).toBe(404)
    const settings = await admin(runtime, "PUT", "/settings", {
      consent: "deny",
      accessTokenTtlSeconds: 60,
    })
    expect(await settings.json()).toMatchObject({
      consent: "deny",
      accessTokenTtlSeconds: 60,
      maxWindowDays: 28,
    })
    expect((await admin(runtime, "PUT", "/settings", { consent: "maybe" })).status).toBe(400)
    expect((await admin(runtime, "PUT", "/settings", { nope: 1 })).status).toBe(400)
  })

  test("a consent as a chosen user mints tokens that name that user", async () => {
    const ctx = setup({
      users: [DEFAULT_USER, { subject: "sub-2", username: "second" }],
      settings: { consentUser: "second" },
    })
    const { tokens } = await connect(ctx)
    expect(claims(tokens.access_token)).toEqual({ sub: "sub-2", user: "second" })
    const consumer = ctx.make({ accessToken: tokens.access_token })
    expect(await consumer.workouts()).toEqual([])
  })

  test("a non-JWT token reads as no claims", () => {
    expect(claims("mock_suunto_token")).toEqual({ sub: null, user: null })
  })

  test("the journal never holds tokens or secrets", async () => {
    const runtime = createRuntime(seeds)
    const consumer = new SuuntoClient({
      fetcher: (r) => runtime.fetch(r),
      dataUrl: base,
      authorizeUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
      clientId: "mock_client",
      clientSecret: "mock_client_secret",
      refreshToken: "mock_suunto_refresh",
    })
    const tokens = await consumer.refresh()
    await consumer.workouts()
    const journal = JSON.stringify(
      await (await runtime.fetch(new Request(`${base}/__admin/requests`))).json(),
    )
    expect(journal).toContain("/v3/workouts/")
    expect(journal).not.toContain("mock_client_secret")
    expect(journal).not.toContain(tokens.access_token)
    expect(journal).not.toContain(tokens.refresh_token)
  })

  test("served over HTTP on loopback: consent in a browser, then data", async () => {
    const server = await createServer({ ...seeds })
    try {
      const consumer = new SuuntoClient({
        fetcher: (r) => fetch(r),
        dataUrl: server.url,
        authorizeUrl: `${server.url}/oauth/authorize`,
        tokenUrl: `${server.url}/oauth/token`,
        clientId: "mock_client",
        clientSecret: "mock_client_secret",
      })
      const consent = await fetch(consentUrl(consumer.config, redirectUri, "s"), {
        redirect: "manual",
      })
      expect(consent.status).toBe(302)
      const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? ""
      await consumer.exchangeCode(code, redirectUri)
      expect(await consumer.workouts()).toHaveLength(3)
      expect((await consumer.sleep(T0, T0 + 10 * DAY)).length).toBe(2)
    } finally {
      await server.close()
    }
  })
})
