// Issue #545: every numbered behavior, driven through test/consumer.ts (a port of the issue's
// Python consumer). Garmin's endpoint specification is behind the developer portal, so each
// behavior is the consumer-observed wire, not vendor-verified (best guess, see the README).
import { describe, expect, test } from "bun:test"
import { createRuntime, GarminHealthAPI, type GarminHealthRuntimeOptions } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  authorizeUrl,
  createReceiver,
  GarminConsumer,
  GarminError,
  pkcePair,
} from "./test/consumer.js"

const ORIGIN = "http://garmin.test"
const HOOK = "http://consumer.test/api/v1/garmin/webhooks"
const REDIRECT = "http://localhost:8000/api/v1/garmin/callback"
const CREDENTIALS = { clientId: "mock_garmin_client", clientSecret: "mock_garmin_secret" }
const SEEDED = { accessToken: "mock_garmin_token", refreshToken: "mock_garmin_refresh" }
const DAY = 1767225600 // 2026-01-01T00:00:00Z, the day the default summaries fall on
const WINDOW = [DAY, DAY + 86400] as const
const NEXT_WINDOW = [DAY + 86400, DAY + 2 * 86400] as const

/** The admin routes that replace a document rather than trigger an action. */
const PUT_ROUTES = new Set(["/settings", "/users", "/summaries"])
// biome-ignore lint/suspicious/noExplicitAny: admin and webhook JSON is asserted field by field
type Json = Record<string, any>
type Hit = { path: string; clientId: string | null }

/** A runtime whose webhooks land in our FastAPI receiver port, and the consumer pointed at it. */
const harness = (options: GarminHealthRuntimeOptions = {}, receiverStatus = () => 200) => {
  const hits: Hit[] = []
  const calls: { path: string; status: number }[] = []
  const send = (request: Request) => runtime.fetch(request)
  const receiver = createReceiver(send, { status: receiverStatus })
  const runtime = createRuntime({
    adminControls: { clock: { now: "2026-01-01T00:00:00Z", frozen: true } },
    webhooks: {
      baseUrl: HOOK,
      retryDelaysMs: [0],
      fetch: (request) => {
        hits.push({
          path: new URL(request.url).pathname,
          clientId: request.headers.get("garmin-client-id"),
        })
        return receiver.handle(request)
      },
    },
    ...options,
  })
  const fetcher = async (request: Request) => {
    const response = await runtime.fetch(request)
    calls.push({ path: new URL(request.url).pathname, status: response.status })
    return response
  }
  const consumer = new GarminConsumer(fetcher, ORIGIN, CREDENTIALS)
  consumer.tokens = { ...SEEDED, expiresAt: Number.MAX_SAFE_INTEGER }
  const admin = async (path: string, body?: unknown, init: RequestInit = {}) => {
    const response = await runtime.fetch(
      new Request(`${ORIGIN}/__admin${path}`, {
        method: body === undefined ? "GET" : PUT_ROUTES.has(path) ? "PUT" : "POST",
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        ...init,
      }),
    )
    return { status: response.status, body: (await response.json()) as Json }
  }
  const settled = async () => {
    await runtime.webhooks.idle()
    return receiver.received
  }
  return { runtime, consumer, admin, hits, calls, settled, receiver }
}

/** The browser consent step then the code exchange, as the consumer's provider class does it. */
const connect = async (
  runtime: { fetch: (request: Request) => Promise<Response> },
  consumer: GarminConsumer,
  seed = "v",
) => {
  const { verifier, challenge } = await pkcePair(seed)
  const response = await runtime.fetch(
    new Request(
      authorizeUrl(ORIGIN, {
        clientId: CREDENTIALS.clientId,
        redirectUri: REDIRECT,
        state: "state-1",
        challenge,
      }),
      { redirect: "manual" },
    ),
  )
  const back = new URL(response.headers.get("location") ?? "")
  const code = back.searchParams.get("code") ?? ""
  await consumer.exchangeCode({ code, redirectUri: REDIRECT, verifier })
  return { code, verifier, challenge }
}

// Not an assignment at the call site, so the type checker keeps the tokens a connect() will set.
const signOut = (consumer: GarminConsumer) => {
  consumer.tokens = undefined
}

const get = (
  runtime: { fetch: (request: Request) => Promise<Response> },
  path: string,
  token?: string,
) =>
  runtime.fetch(
    new Request(`${ORIGIN}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  )

describe("OAuth with PKCE (behaviors 1-3)", () => {
  test("1: the consent page redirects with a one-time code and the state unchanged", async () => {
    const { runtime } = harness()
    const { challenge } = await pkcePair()
    const response = await runtime.fetch(
      new Request(
        authorizeUrl(ORIGIN, {
          clientId: CREDENTIALS.clientId,
          redirectUri: REDIRECT,
          state: "opaque state/1",
          challenge,
        }),
      ),
    )
    expect(response.status).toBe(302)
    const back = new URL(response.headers.get("location") ?? "")
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(back.searchParams.get("code")).toMatch(/^mock_garmin_code/)
    expect(back.searchParams.get("state")).toBe("opaque state/1")
    expect(back.searchParams.get("error")).toBeNull()
  })

  test("1: a consent-denied control redirects with error=access_denied and the state", async () => {
    const { runtime, admin } = harness()
    expect((await admin("/settings", { denyConsent: true })).status).toBe(200)
    const { challenge } = await pkcePair()
    const response = await runtime.fetch(
      new Request(
        authorizeUrl(ORIGIN, {
          clientId: CREDENTIALS.clientId,
          redirectUri: REDIRECT,
          state: "state-1",
          challenge,
        }),
      ),
    )
    const back = new URL(response.headers.get("location") ?? "")
    expect(back.searchParams.get("error")).toBe("access_denied")
    expect(back.searchParams.get("state")).toBe("state-1")
    expect(back.searchParams.get("code")).toBeNull()
  })

  test("1: an unknown client or an unregistered redirect_uri is never redirected to", async () => {
    const { runtime } = harness({
      clients: [{ id: "app", secret: "s", redirectUris: [REDIRECT] }],
    })
    const { challenge } = await pkcePair()
    for (const input of [
      { clientId: "stranger", redirectUri: REDIRECT },
      { clientId: "app", redirectUri: "http://evil.test/cb" },
    ]) {
      const response = await runtime.fetch(
        new Request(authorizeUrl(ORIGIN, { ...input, state: "s", challenge })),
      )
      expect(response.status).toBe(400)
      expect(response.headers.get("location")).toBeNull()
      expect(((await response.json()) as { error: string }).error).toBe("invalid_request")
    }
  })

  test("2: a valid code and matching verifier give tokens; expires_in is an integer", async () => {
    const { runtime, consumer } = harness()
    signOut(consumer)
    await connect(runtime, consumer)
    expect(consumer.tokens?.accessToken).toMatch(/^mock_garmin_access/)
    expect(consumer.tokens?.refreshToken).toMatch(/^mock_garmin_refresh/)
    const { verifier, challenge } = await pkcePair("raw")
    const authorized = await runtime.fetch(
      new Request(
        authorizeUrl(ORIGIN, {
          clientId: CREDENTIALS.clientId,
          redirectUri: REDIRECT,
          state: "s",
          challenge,
        }),
      ),
    )
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code") ?? ""
    const response = await runtime.fetch(
      new Request(`${ORIGIN}/di-oauth2-service/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          client_id: CREDENTIALS.clientId,
          client_secret: CREDENTIALS.clientSecret,
        }).toString(),
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([
      "access_token",
      "expires_in",
      "refresh_token",
      "token_type",
    ])
    expect(body.expires_in).toBe(86400)
    expect(body.token_type).toBe("bearer")
  })

  test("2: a reused code, a wrong verifier, a wrong redirect_uri and bad client credentials are 400 OAuth errors", async () => {
    const { runtime, consumer } = harness()
    signOut(consumer)
    const { code, verifier } = await connect(runtime, consumer)
    const reuse = await consumer
      .exchangeCode({ code, redirectUri: REDIRECT, verifier })
      .catch((e) => e)
    expect(reuse).toBeInstanceOf(GarminError)
    expect(reuse.status).toBe(400)
    expect(reuse.body.error).toBe("invalid_grant")

    const fresh = async () => {
      const { challenge } = await pkcePair("second")
      const response = await runtime.fetch(
        new Request(
          authorizeUrl(ORIGIN, {
            clientId: CREDENTIALS.clientId,
            redirectUri: REDIRECT,
            state: "s",
            challenge,
          }),
        ),
      )
      return new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? ""
    }
    const { verifier: right } = await pkcePair("second")
    const wrongVerifier = await consumer
      .exchangeCode({
        code: await fresh(),
        redirectUri: REDIRECT,
        verifier: (await pkcePair("x")).verifier,
      })
      .catch((e) => e)
    expect(wrongVerifier.status).toBe(400)
    expect(wrongVerifier.body.error).toBe("invalid_grant")
    const wrongRedirect = await consumer
      .exchangeCode({
        code: await fresh(),
        redirectUri: "http://localhost:9/other",
        verifier: right,
      })
      .catch((e) => e)
    expect(wrongRedirect.status).toBe(400)
    // A failed attempt does not burn the code's valid use? Best guess: a bad verifier leaves it intact.
    const stranger = new GarminConsumer((r) => runtime.fetch(r), ORIGIN, {
      clientId: CREDENTIALS.clientId,
      clientSecret: "wrong",
    })
    const badClient = await stranger
      .exchangeCode({ code: await fresh(), redirectUri: REDIRECT, verifier: right })
      .catch((e) => e)
    expect(badClient.status).toBe(400)
    expect(badClient.body.error).toBe("invalid_client")
  })

  test("2: an expired code is rejected", async () => {
    const { runtime, consumer, admin } = harness()
    signOut(consumer)
    const { challenge, verifier } = await pkcePair()
    const authorized = await runtime.fetch(
      new Request(
        authorizeUrl(ORIGIN, {
          clientId: CREDENTIALS.clientId,
          redirectUri: REDIRECT,
          state: "s",
          challenge,
        }),
      ),
    )
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code") ?? ""
    await admin("/clock", { advance: "11m" })
    const result = await consumer
      .exchangeCode({ code, redirectUri: REDIRECT, verifier })
      .catch((e) => e)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe("invalid_grant")
  })

  test("3: a refresh grant issues a new access token and rotates the refresh token", async () => {
    const { runtime, consumer } = harness()
    signOut(consumer)
    await connect(runtime, consumer)
    const first = consumer.tokens
    await consumer.refresh()
    expect(consumer.tokens?.accessToken).not.toBe(first?.accessToken)
    expect(consumer.tokens?.refreshToken).not.toBe(first?.refreshToken)
    expect(
      (await get(runtime, "/wellness-api/rest/user/id", consumer.tokens?.accessToken)).status,
    ).toBe(200)
    // The retired refresh token no longer works.
    consumer.tokens = first && { ...first, expiresAt: 0 }
    const reuse = await consumer.refresh().catch((e) => e)
    expect(reuse.status).toBe(400)
    expect(reuse.body.error).toBe("invalid_grant")
  })

  test("3: without rotation the response has no refresh_token and the consumer keeps the old one", async () => {
    const { runtime, consumer, admin } = harness()
    expect((await admin("/settings", { rotateRefreshTokens: false })).status).toBe(200)
    await consumer.refresh()
    expect(consumer.tokens?.refreshToken).toBe(SEEDED.refreshToken)
    expect(consumer.tokens?.accessToken).not.toBe(SEEDED.accessToken)
    await consumer.refresh()
    expect(
      (await get(runtime, "/wellness-api/rest/user/id", consumer.tokens?.accessToken)).status,
    ).toBe(200)
  })

  test("3: an unknown refresh token is an invalid_grant OAuth error", async () => {
    const { consumer } = harness()
    consumer.tokens = { accessToken: "x", refreshToken: "never-issued", expiresAt: 0 }
    const result = await consumer.refresh().catch((e) => e)
    expect(result).toBeInstanceOf(GarminError)
    expect(result.status).toBe(400)
    expect(result.body).toEqual({
      error: "invalid_grant",
      error_description: "Invalid refresh_token.",
    })
  })

  test("3: the refresh_rejected preset scripts a revoked refresh token", async () => {
    const { consumer, admin } = harness()
    await admin("/faults", { preset: "refresh_rejected", count: 1 })
    const result = await consumer.refresh().catch((e) => e)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe("invalid_grant")
    await consumer.refresh()
  })
})

describe("the Health API (behaviors 4-12)", () => {
  test("4: the user id of an authorized user", async () => {
    const { runtime, consumer } = harness()
    expect(await consumer.userId()).toBe("garmin-user-1")
    signOut(consumer)
    await connect(runtime, consumer)
    expect(await consumer.userId()).toBe("garmin-user-1")
  })

  test("4: the user id follows the account the consent page signed in", async () => {
    const { runtime, consumer, admin } = harness()
    await admin("/users", [{ userId: "garmin-user-2" }])
    await admin("/settings", { consentUserId: "garmin-user-2" })
    signOut(consumer)
    await connect(runtime, consumer)
    expect(await consumer.userId()).toBe("garmin-user-2")
  })

  test("5: an accepted sleeps backfill answers 202 with an empty body, then pushes the summaries", async () => {
    const { runtime, consumer, hits, settled } = harness()
    const response = await get(
      runtime,
      `/wellness-api/rest/backfill/sleeps?summaryStartTimeInSeconds=${WINDOW[0]}&summaryEndTimeInSeconds=${WINDOW[1]}`,
      SEEDED.accessToken,
    )
    expect(response.status).toBe(202)
    expect(await response.text()).toBe("")
    // The same call, a different window, through the consumer.
    expect(await consumer.backfill("sleeps", NEXT_WINDOW[0], NEXT_WINDOW[1])).toBe("accepted")

    const received = await settled()
    expect(hits).toEqual([{ path: "/api/v1/garmin/webhooks/push", clientId: "mock_garmin_client" }])
    expect(received).toHaveLength(1)
    expect(received[0]?.accepted).toEqual([
      {
        type: "sleeps",
        item: expect.objectContaining({
          userId: "garmin-user-1",
          summaryId: "sleep-1",
          startTimeInSeconds: DAY + 600,
          durationInSeconds: 27000,
          deepSleepDurationInSeconds: 5000,
          lightSleepDurationInSeconds: 14000,
          remSleepDurationInSeconds: 6000,
          awakeDurationInSeconds: 2000,
          overallSleepScore: { value: 82, qualifierKey: "GOOD" },
        }),
      },
    ])
  })

  test("5: every backfill type pushes its own key with the fields the consumer reads", async () => {
    const { consumer, settled } = harness()
    for (const type of ["activities", "sleeps", "dailies", "epochs", "bodyComps", "hrv"])
      expect(await consumer.backfill(type, WINDOW[0], WINDOW[1])).toBe("accepted")
    const received = await settled()
    expect(received.map((r) => r.accepted[0]?.type).sort()).toEqual([
      "activities",
      "bodyComps",
      "dailies",
      "epochs",
      "hrv",
      "sleeps",
    ])
    const byType = Object.fromEntries(
      received.map((r) => [r.accepted[0]?.type, r.accepted[0]?.item]),
    )
    expect(byType.dailies).toMatchObject({
      userId: "garmin-user-1",
      summaryId: "daily-1",
      calendarDate: "2026-01-01",
      steps: 9100,
      floorsClimbed: 12,
      restingHeartRateInBeatsPerMinute: 52,
    })
    expect(byType.epochs).toMatchObject({ meanHeartRateInBeatsPerMinute: 64, steps: 40 })
    expect(byType.bodyComps).toMatchObject({
      measurementTimeInSeconds: DAY + 28800,
      weightInGrams: 72000,
      bodyFatInPercent: 18.5,
      bodyMassIndex: 22.4,
    })
    expect(byType.hrv).toMatchObject({ lastNightAvg: 61 })
  })

  test("6: the same type and window requested again is 409 and makes no second delivery", async () => {
    const { consumer, hits, settled, admin } = harness()
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("accepted")
    await settled()
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("duplicate")
    await settled()
    expect(hits).toHaveLength(1)
    // A different type for the same window, and the same type for another window, are new requests.
    expect(await consumer.backfill("dailies", WINDOW[0], WINDOW[1])).toBe("accepted")
    expect(await consumer.backfill("sleeps", NEXT_WINDOW[0], NEXT_WINDOW[1])).toBe("accepted")
    const { body } = await admin("/backfills")
    expect(body.backfills).toHaveLength(3)
  })

  test("6: the conflict preset answers 409 for a window never requested", async () => {
    const { consumer, admin, hits } = harness()
    await admin("/faults", { preset: "conflict", count: 1 })
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("duplicate")
    expect(hits).toHaveLength(0)
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("accepted")
  })

  test("7: a ping user gets callbackURLs and the unauthenticated URL serves the seeded dailies", async () => {
    const { runtime, consumer, admin, hits, settled } = harness()
    await admin("/users", [{ userId: "garmin-user-1", delivery: "ping" }])
    expect(await consumer.backfill("dailies", WINDOW[0], WINDOW[1])).toBe("accepted")
    const received = await settled()
    expect(hits.map((h) => h.path)).toEqual(["/api/v1/garmin/webhooks/ping"])
    const ping = received[0]?.pings[0]
    expect(ping?.userId).toBe("garmin-user-1")
    const callback = new URL(ping?.callbackURL ?? "")
    expect(callback.origin).toBe(ORIGIN)
    expect(callback.pathname).toBe("/wellness-api/rest/dailies")
    expect(callback.searchParams.get("uploadStartTimeInSeconds")).toBe(String(WINDOW[0]))
    expect(callback.searchParams.get("uploadEndTimeInSeconds")).toBe(String(WINDOW[1]))
    expect(callback.searchParams.get("token")).toBeTruthy()
    // The consumer's unauthenticated GET got the summaries.
    expect(ping?.items).toEqual([
      expect.objectContaining({ userId: "garmin-user-1", summaryId: "daily-1", steps: 9100 }),
    ])
    // The URL itself answers the same with no Authorization header, repeatedly.
    const again = await runtime.fetch(new Request(ping?.callbackURL ?? ""))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(ping?.items)
    // A tampered token, or a token used for another type, is rejected.
    callback.searchParams.set("token", "nope")
    expect((await runtime.fetch(new Request(callback))).status).toBe(401)
    const other = new URL(ping?.callbackURL ?? "")
    other.pathname = "/wellness-api/rest/sleeps"
    expect((await runtime.fetch(new Request(other))).status).toBe(401)
  })

  test("7: publicUrl overrides the origin of callback URLs", async () => {
    const { consumer, admin, settled } = harness()
    await admin("/users", [{ userId: "garmin-user-1", delivery: "ping" }])
    await admin("/settings", { publicUrl: "http://emulator.internal:12131/" })
    await consumer.backfill("dailies", WINDOW[0], WINDOW[1])
    const received = await settled()
    expect(received[0]?.pings[0]?.callbackURL).toStartWith(
      "http://emulator.internal:12131/wellness-api/rest/dailies?",
    )
  })

  test("8: a window with no seeded data is still 202 and nothing is delivered", async () => {
    const { consumer, hits, settled, admin } = harness()
    expect(await consumer.backfill("sleeps", DAY + 10 * 86400, DAY + 11 * 86400)).toBe("accepted")
    await settled()
    expect(hits).toHaveLength(0)
    const { body } = await admin("/backfills")
    expect(body.backfills).toEqual([
      expect.objectContaining({ type: "sleeps", notificationId: null }),
    ])
    expect(body.notifications).toEqual([])
    // The empty window was requested, so asking again is a duplicate.
    expect(await consumer.backfill("sleeps", DAY + 10 * 86400, DAY + 11 * 86400)).toBe("duplicate")
  })

  test("9: activities arrive under the activities key with the four required fields", async () => {
    const { consumer, settled } = harness()
    expect(await consumer.backfill("activities", WINDOW[0], WINDOW[1])).toBe("accepted")
    const received = await settled()
    expect(received[0]?.rejected).toEqual([])
    const item = received[0]?.accepted[0]
    expect(item?.type).toBe("activities")
    expect(item?.item).toMatchObject({
      userId: "garmin-user-1",
      summaryId: "act-1",
      activityId: 9001,
      activityType: "RUNNING",
      startTimeInSeconds: DAY + 25200,
      durationInSeconds: 1800,
      activityName: "Morning run",
      deviceName: "Forerunner 265",
      averageHeartRateInBeatsPerMinute: 150,
      maxHeartRateInBeatsPerMinute: 176,
      steps: 5200,
      distanceInMeters: 5000,
      activeKilocalories: 320,
    })
  })

  test("9: an activity seeded without durationInSeconds is delivered as seeded; the consumer rejects it", async () => {
    const { consumer, admin, settled } = harness()
    const { status } = await admin("/summaries", [
      {
        userId: "garmin-user-1",
        type: "activities",
        data: {
          summaryId: "act-bad",
          activityId: 9002,
          activityType: "WALKING",
          startTimeInSeconds: DAY + 40000,
        },
      },
    ])
    expect(status).toBe(200)
    expect(await consumer.backfill("activities", WINDOW[0], WINDOW[1])).toBe("accepted")
    const received = await settled()
    expect(received[0]?.accepted.map((a) => a.item.summaryId)).toEqual(["act-1"])
    expect(received[0]?.rejected.map((a) => a.item.summaryId)).toEqual(["act-bad"])
  })

  test("10: an access token past expires_in on the emulator clock is 401; the consumer refreshes and the retry succeeds", async () => {
    const { runtime, consumer, admin, calls } = harness()
    await admin("/settings", { tokenTtlSeconds: 3600 })
    signOut(consumer)
    await connect(runtime, consumer)
    const stale = consumer.tokens?.accessToken ?? ""
    expect(await consumer.userId()).toBe("garmin-user-1")
    await admin("/clock", { advance: "2h" })
    expect((await get(runtime, "/wellness-api/rest/user/id", stale)).status).toBe(401)
    calls.length = 0
    expect(await consumer.userId()).toBe("garmin-user-1")
    expect(calls.map((c) => c.status)).toEqual([401, 200, 200])
    expect(consumer.tokens?.accessToken).not.toBe(stale)
    // Every API route checks expiry, including the backfill and the registration.
    await admin("/clock", { advance: "2h" })
    const backfill = await get(
      runtime,
      `/wellness-api/rest/backfill/sleeps?summaryStartTimeInSeconds=${WINDOW[0]}&summaryEndTimeInSeconds=${WINDOW[1]}`,
      consumer.tokens?.accessToken,
    )
    expect(backfill.status).toBe(401)
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("accepted")
  })

  test("10: the expire-token control forces expiry without moving the clock", async () => {
    const { runtime, consumer, admin } = harness()
    expect((await admin("/users/garmin-user-1/expire-token", {})).body.expired).toBe(1)
    expect((await get(runtime, "/wellness-api/rest/user/id", SEEDED.accessToken)).status).toBe(401)
    // revokeRefresh makes the consumer's refresh fail too.
    await admin("/users/garmin-user-1/expire-token", { revokeRefresh: true })
    const result = await consumer.userId().catch((e) => e)
    expect(result).toBeInstanceOf(GarminError)
    expect(result.body.error).toBe("invalid_grant")
  })

  test("10: the unauthorized preset answers 401 for N calls and the consumer refreshes once per call", async () => {
    const { consumer, admin, calls } = harness()
    await admin("/faults", { preset: "unauthorized", count: 1 })
    expect(await consumer.userId()).toBe("garmin-user-1")
    expect(calls.filter((c) => c.path.startsWith("/wellness-api")).map((c) => c.status)).toEqual([
      401, 200,
    ])
  })

  test("11: a forced 429 carries Retry-After; the consumer waits once and retries", async () => {
    const { runtime, consumer, admin, hits, settled } = harness()
    await admin("/faults", { preset: "rate_limited", count: 1 })
    const direct = await get(
      runtime,
      `/wellness-api/rest/backfill/sleeps?summaryStartTimeInSeconds=${WINDOW[0]}&summaryEndTimeInSeconds=${WINDOW[1]}`,
      SEEDED.accessToken,
    )
    expect(direct.status).toBe(429)
    expect(direct.headers.get("retry-after")).toBe("1")
    // The faulted call did not record the window.
    await admin("/faults", { preset: "rate_limited", count: 1 })
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("accepted")
    expect(consumer.waited).toEqual([1])
    await settled()
    expect(hits).toHaveLength(1)
  })

  test("11: a second 429 in a row is not retried again", async () => {
    const { consumer, admin } = harness()
    await admin("/faults", { preset: "rate_limited", count: 2 })
    const result = await consumer.backfill("sleeps", WINDOW[0], WINDOW[1]).catch((e) => e)
    expect(result).toBeInstanceOf(GarminError)
    expect(result.status).toBe(429)
  })

  test("11: the server_error preset forces a 5xx on the next calls", async () => {
    const { consumer, admin } = harness()
    await admin("/faults", { preset: "server_error", count: 1 })
    const result = await consumer.backfill("sleeps", WINDOW[0], WINDOW[1]).catch((e) => e)
    expect(result.status).toBe(500)
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("accepted")
  })

  test("12: DELETE registration succeeds without a body and the user's tokens stop working", async () => {
    const { runtime, consumer, hits, settled } = harness()
    const status = await consumer.deregister()
    expect(status).toBe(204)
    expect(
      await (
        await runtime.fetch(
          new Request(`${ORIGIN}/wellness-api/rest/user/id`, {
            headers: { authorization: `Bearer ${SEEDED.accessToken}` },
          }),
        )
      ).text(),
    ).toContain("unauthorized")
    expect((await get(runtime, "/wellness-api/rest/user/id", SEEDED.accessToken)).status).toBe(401)
    // The refresh token is dead too, so the consumer cannot revive the registration.
    const refresh = await consumer.refresh().catch((e) => e)
    expect(refresh.body.error).toBe("invalid_grant")
    // A deregistration the user did through the API does not notify the consumer.
    await settled()
    expect(hits).toHaveLength(0)
  })

  test("12: the same call with an expired token answers 401 and the consumer tolerates it", async () => {
    const { runtime, consumer, admin } = harness()
    await admin("/users/garmin-user-1/expire-token", {})
    expect(await consumer.deregister()).toBe(401)
    // Nothing was deregistered: a refresh still works.
    await consumer.refresh()
    expect(
      (await get(runtime, "/wellness-api/rest/user/id", consumer.tokens?.accessToken)).status,
    ).toBe(200)
  })

  test("12: a deregistered user's ping callbackURL stops answering", async () => {
    const { runtime, consumer, admin, settled } = harness()
    await admin("/users", [{ userId: "garmin-user-1", delivery: "ping" }])
    await consumer.backfill("dailies", WINDOW[0], WINDOW[1])
    const callback = (await settled())[0]?.pings[0]?.callbackURL ?? ""
    expect((await runtime.fetch(new Request(callback))).status).toBe(200)
    await consumer.deregister()
    expect((await runtime.fetch(new Request(callback))).status).toBe(401)
  })

  test("backfill request validation: bad bounds are 400, an unknown type 404", async () => {
    const { runtime } = harness()
    const call = (type: string, query: string) =>
      get(runtime, `/wellness-api/rest/backfill/${type}?${query}`, SEEDED.accessToken)
    expect((await call("sleeps", "summaryStartTimeInSeconds=1")).status).toBe(400)
    expect(
      (await call("sleeps", "summaryStartTimeInSeconds=a&summaryEndTimeInSeconds=2")).status,
    ).toBe(400)
    expect(
      (await call("sleeps", "summaryStartTimeInSeconds=5&summaryEndTimeInSeconds=5")).status,
    ).toBe(400)
    expect(
      (
        await call(
          "sleeps",
          `summaryStartTimeInSeconds=${DAY}&summaryEndTimeInSeconds=${DAY + 91 * 86400}`,
        )
      ).status,
    ).toBe(400)
    expect(
      (await call("stress", `summaryStartTimeInSeconds=${DAY}&summaryEndTimeInSeconds=${DAY + 1}`))
        .status,
    ).toBe(404)
    expect(
      (
        await get(
          runtime,
          `/wellness-api/rest/backfill/sleeps?summaryStartTimeInSeconds=${DAY}&summaryEndTimeInSeconds=${DAY + 1}`,
        )
      ).status,
    ).toBe(401)
  })
})

describe("controls and webhooks (behavior 13 and the test controls)", () => {
  test("13: the deregistration control POSTs deregistrations with garmin-client-id; the user's tokens stop working", async () => {
    const { runtime, admin, hits, settled } = harness()
    const { body } = await admin("/users/garmin-user-1/deregister", {})
    expect(body.notified).toBe(true)
    const received = await settled()
    expect(hits).toEqual([
      { path: "/api/v1/garmin/webhooks/deregistration", clientId: "mock_garmin_client" },
    ])
    expect(received[0]?.deregistrations).toEqual(["garmin-user-1"])
    const events = (await admin("/webhooks/events")).body.events as { payload: Json }[]
    expect(events[0]?.payload).toEqual({
      deregistrations: [{ userId: "garmin-user-1", userAccessToken: SEEDED.accessToken }],
    })
    expect((await get(runtime, "/wellness-api/rest/user/id", SEEDED.accessToken)).status).toBe(401)
    expect((await admin("/users/nobody/deregister", {})).status).toBe(400)
  })

  test("13: the permissions control POSTs userPermissionsChange to the permissions path", async () => {
    const { admin, hits, settled } = harness()
    await admin("/users/garmin-user-1/permissions", {
      permissions: { activitySummary: true, sleepSummary: false },
    })
    await admin("/users/garmin-user-1/permissions", { permissions: { sleepSummary: true } })
    const received = await settled()
    expect(hits.map((h) => h.path)).toEqual([
      "/api/v1/garmin/webhooks/permissions",
      "/api/v1/garmin/webhooks/permissions",
    ])
    expect(received.map((r) => r.permissions)).toEqual([
      [{ userId: "garmin-user-1", permissions: { activitySummary: true, sleepSummary: false } }],
      [{ userId: "garmin-user-1", permissions: { activitySummary: true, sleepSummary: true } }],
    ])
    expect(
      (await admin("/users/garmin-user-1/permissions", { permissions: { x: 1 } })).status,
    ).toBe(400)
  })

  test("13: a non-2xx answer from the consumer is recorded as a failed delivery with its status", async () => {
    const { consumer, admin, settled } = harness({}, () => 500)
    await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])
    await admin("/users/garmin-user-1/permissions", { permissions: { activitySummary: true } })
    await settled()
    const deliveries = (await admin("/webhooks")).body.deliveries as {
      type: string
      state: string
      url: string
      attempts: { status: number | null }[]
    }[]
    expect(deliveries.map((d) => [d.type, d.state, d.attempts[0]?.status])).toEqual([
      ["push", "failed", 500],
      ["permissions", "failed", 500],
    ])
    expect(deliveries[0]?.url).toBe(`${HOOK}/push`)
  })

  test("13: a consumer that rejects a missing header answers 401; the emulator always sends it", async () => {
    const { runtime, hits } = harness({
      webhooks: { baseUrl: HOOK, clientId: "custom-client", retryDelaysMs: [0] },
    })
    expect(
      runtime.webhooks
        .endpoints("default")
        .every((e) => e.headers?.["garmin-client-id"] === "custom-client"),
    ).toBe(true)
    expect(hits).toEqual([])
  })

  test("the webhook base URL is configurable per namespace at runtime", async () => {
    const hits: string[] = []
    const runtime = createRuntime({
      webhooks: {
        baseUrl: HOOK,
        retryDelaysMs: [0],
        fetch: async (request) => {
          hits.push(request.url)
          return new Response("{}", { status: 200 })
        },
      },
    })
    const put = await runtime.fetch(
      new Request(`${ORIGIN}/__admin/webhook-base-url`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-mockingbird-namespace": "a" },
        body: JSON.stringify({
          baseUrl: "http://other.test/hooks/",
          clientId: "app-a",
          paths: { push: "/p" },
        }),
      }),
    )
    expect(put.status).toBe(200)
    expect(
      ((await put.json()) as { endpoints: { url: string }[] }).endpoints.map((e) => e.url),
    ).toEqual([
      "http://other.test/hooks/p",
      "http://other.test/hooks/ping",
      "http://other.test/hooks/deregistration",
      "http://other.test/hooks/permissions",
    ])
    const bad = await runtime.fetch(
      new Request(`${ORIGIN}/__admin/webhook-base-url`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "not a url" }),
      }),
    )
    expect(bad.status).toBe(400)
    const call = (namespace: string) =>
      runtime.fetch(
        new Request(
          `${ORIGIN}/wellness-api/rest/backfill/sleeps?summaryStartTimeInSeconds=${WINDOW[0]}&summaryEndTimeInSeconds=${WINDOW[1]}`,
          {
            headers: {
              authorization: `Bearer ${SEEDED.accessToken}`,
              "x-mockingbird-namespace": namespace,
            },
          },
        ),
      )
    expect((await call("a")).status).toBe(202)
    expect((await call("b")).status).toBe(202)
    await runtime.webhooks.idle()
    // The boot endpoints serve every namespace; a namespace's own endpoints are added to them.
    expect(hits.sort()).toEqual([
      "http://consumer.test/api/v1/garmin/webhooks/push",
      "http://consumer.test/api/v1/garmin/webhooks/push",
      "http://other.test/hooks/p",
    ])
  })

  test("held delivery: autoDeliver off keeps notifications pending until delivered, dropped or replayed", async () => {
    const { consumer, admin, hits, settled } = harness()
    await admin("/settings", { autoDeliver: false })
    await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])
    await consumer.backfill("dailies", WINDOW[0], WINDOW[1])
    await consumer.backfill("hrv", WINDOW[0], WINDOW[1])
    await settled()
    expect(hits).toHaveLength(0)
    const pending = (await admin("/backfills")).body.notifications as {
      id: string
      type: string
      state: string
    }[]
    expect(pending.map((n) => n.state)).toEqual(["pending", "pending", "pending"])
    // The held notification metadata carries no body.
    expect(JSON.stringify(pending)).not.toContain("summaryId")

    const dropped = await admin("/notifications/drop", { ids: [pending[1]?.id] })
    expect(dropped.body.dropped).toEqual([pending[1]?.id])
    const delivered = await admin("/notifications/deliver", {})
    expect(delivered.body.delivered).toEqual([pending[0]?.id, pending[2]?.id])
    expect(hits).toHaveLength(2)
    // Nothing is delivered twice by asking again.
    expect((await admin("/notifications/deliver", {})).body.delivered).toEqual([])
    const states = (await admin("/backfills")).body.notifications as { state: string }[]
    expect(states.map((n) => n.state)).toEqual(["sent", "dropped", "sent"])
  })

  test("duplicate, drop and reorder webhook presets change what the consumer receives", async () => {
    const { consumer, admin, hits, settled } = harness()
    await admin("/faults", { preset: "duplicate", count: 1 })
    await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])
    await settled()
    expect(hits).toHaveLength(2)

    await admin("/faults", { preset: "webhook_drop", count: 1 })
    await consumer.backfill("dailies", WINDOW[0], WINDOW[1])
    await settled()
    expect(hits).toHaveLength(2)

    const before = (await settled()).length
    await admin("/faults", { preset: "webhook_reorder", count: 1 })
    await consumer.backfill("hrv", WINDOW[0], WINDOW[1])
    await consumer.backfill("epochs", WINDOW[0], WINDOW[1])
    await settled()
    await admin("/webhooks/flush", {})
    const arrived = (await settled()).slice(before).map((r) => r.accepted[0]?.type)
    expect(arrived).toEqual(["epochs", "hrv"])
  })

  test("presets are the ones the catalog lists", async () => {
    const { admin } = harness()
    const presets = (await admin("/faults/presets")).body
    const names = (
      Array.isArray(presets.presets) ? presets.presets : Object.keys(presets.presets)
    ).map((p: string | { name: string }) => (typeof p === "string" ? p : p.name))
    for (const name of [
      "unauthorized",
      "conflict",
      "rate_limited",
      "server_error",
      "refresh_rejected",
      "connection_drop",
      "duplicate",
      "webhook_drop",
      "webhook_reorder",
    ])
      expect(names).toContain(name)
  })

  test("connection_drop makes the backfill an unknown outcome and records nothing", async () => {
    const { consumer, admin } = harness()
    await admin("/faults", { preset: "connection_drop", count: 1 })
    await expect(consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).rejects.toThrow()
    expect(((await admin("/backfills")).body.backfills as unknown[]).length).toBe(0)
  })
})

describe("namespaces (behavior 14)", () => {
  const call = (
    runtime: { fetch: (r: Request) => Promise<Response> },
    namespace: string,
    path: string,
    init: RequestInit = {},
  ) =>
    runtime.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${SEEDED.accessToken}`,
          "content-type": "application/json",
          "x-mockingbird-namespace": namespace,
          ...init.headers,
        },
      }),
    )

  test("14: seeding, backfill history and reset in one namespace leave the other unchanged", async () => {
    const { runtime, settled } = harness()
    const window = `summaryStartTimeInSeconds=${WINDOW[0]}&summaryEndTimeInSeconds=${WINDOW[1]}`
    expect(
      (
        await call(runtime, "a", "/__admin/summaries", {
          method: "POST",
          body: JSON.stringify([
            {
              userId: "garmin-user-1",
              type: "sleeps",
              data: { summaryId: "only-in-a", startTimeInSeconds: DAY + 100, durationInSeconds: 1 },
            },
          ]),
        })
      ).status,
    ).toBe(404)
    // Seeding is a PUT: a POST on the route is not part of the contract.
    expect(
      (
        await call(runtime, "a", "/__admin/summaries", {
          method: "PUT",
          body: JSON.stringify([
            {
              userId: "garmin-user-1",
              type: "sleeps",
              data: { summaryId: "only-in-a", startTimeInSeconds: DAY + 100, durationInSeconds: 1 },
            },
          ]),
        })
      ).status,
    ).toBe(200)
    expect((await call(runtime, "a", `/wellness-api/rest/backfill/sleeps?${window}`)).status).toBe(
      202,
    )
    // The same window in the other namespace is a first request, with its own data.
    expect((await call(runtime, "b", `/wellness-api/rest/backfill/sleeps?${window}`)).status).toBe(
      202,
    )
    const events = (
      await runtime.fetch(new Request(`${ORIGIN}/__admin/webhooks/events?all=1`))
    ).json() as Promise<{
      events: { namespace: string; payload: { sleeps: { summaryId: string }[] } }[]
    }>
    const byNamespace = Object.fromEntries(
      (await events).events.map((e) => [
        e.namespace,
        e.payload.sleeps.map((s) => s.summaryId).sort(),
      ]),
    )
    expect(byNamespace).toEqual({ a: ["only-in-a", "sleep-1"], b: ["sleep-1"] })
    await settled()

    const reset = await call(runtime, "a", "/__admin/reset", { method: "POST" })
    expect(reset.status).toBe(200)
    // a is back to boot: the window is a first request again; b still remembers it.
    expect((await call(runtime, "a", `/wellness-api/rest/backfill/sleeps?${window}`)).status).toBe(
      202,
    )
    expect((await call(runtime, "b", `/wellness-api/rest/backfill/sleeps?${window}`)).status).toBe(
      409,
    )
    const backfills = async (namespace: string) =>
      (
        (await (await call(runtime, namespace, "/__admin/backfills")).json()) as {
          backfills: unknown[]
        }
      ).backfills
    expect(await backfills("a")).toHaveLength(1)
    expect(await backfills("b")).toHaveLength(1)
  })

  test("14: users and tokens are per namespace, including a deregistration", async () => {
    const { runtime } = harness()
    expect(
      (await call(runtime, "a", "/__admin/users/garmin-user-1/deregister", { method: "POST" }))
        .status,
    ).toBe(200)
    expect((await call(runtime, "a", "/wellness-api/rest/user/id")).status).toBe(401)
    expect((await call(runtime, "b", "/wellness-api/rest/user/id")).status).toBe(200)
    expect((await call(runtime, "default", "/wellness-api/rest/user/id")).status).toBe(200)
  })

  test("14: a /__admin/ns/<name> path prefix selects the namespace and ping callbackURLs carry it", async () => {
    const { runtime, settled } = harness()
    await call(runtime, "a", "/__admin/users", {
      method: "PUT",
      body: JSON.stringify([{ userId: "garmin-user-1", delivery: "ping" }]),
    })
    const window = `summaryStartTimeInSeconds=${WINDOW[0]}&summaryEndTimeInSeconds=${WINDOW[1]}`
    const viaPrefix = await runtime.fetch(
      new Request(`${ORIGIN}/__admin/ns/a/wellness-api/rest/backfill/dailies?${window}`, {
        headers: { authorization: `Bearer ${SEEDED.accessToken}` },
      }),
    )
    expect(viaPrefix.status).toBe(202)
    const received = await settled()
    const callbackURL = received[0]?.pings[0]?.callbackURL ?? ""
    expect(callbackURL).toStartWith(`${ORIGIN}/__admin/ns/a/wellness-api/rest/dailies?`)
    // The consumer fetched it without a header and without a namespace header: the path carried it.
    expect(received[0]?.pings[0]?.items).toHaveLength(1)
    // The default namespace has no such callback token.
    const wrong = callbackURL.replace("/__admin/ns/a", "")
    expect((await runtime.fetch(new Request(wrong))).status).toBe(401)
  })

  test("14: a token minted in one namespace is not valid in another", async () => {
    const { runtime, consumer } = harness()
    signOut(consumer)
    const inA = new GarminConsumer(
      (request) => {
        request.headers.set("x-mockingbird-namespace", "a")
        return runtime.fetch(request)
      },
      ORIGIN,
      CREDENTIALS,
    )
    // Request headers on a built Request are mutable here, which carries the namespace.
    await connect(
      {
        fetch: (r) => {
          r.headers.set("x-mockingbird-namespace", "a")
          return runtime.fetch(r)
        },
      },
      inA,
    )
    const token = inA.tokens?.accessToken ?? ""
    expect(
      (
        await call(runtime, "a", "/wellness-api/rest/user/id", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await call(runtime, "b", "/wellness-api/rest/user/id", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401)
  })
})

describe("served over HTTP", () => {
  test("a served emulator receives API calls and delivers push and ping webhooks to a real sink", async () => {
    const received: { path: string; clientId: string | null; body: Json }[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({
          path: new URL(request.url).pathname,
          clientId: request.headers.get("garmin-client-id"),
          body: (await request.json()) as Json,
        })
        return Response.json({ ok: true })
      },
    })
    const server = await createServer({
      webhooks: {
        baseUrl: `http://127.0.0.1:${sink.port}/api/v1/garmin/webhooks`,
        retryDelaysMs: [0],
      },
    })
    try {
      const consumer = new GarminConsumer(fetch, server.url, CREDENTIALS)
      consumer.tokens = { ...SEEDED, expiresAt: Number.MAX_SAFE_INTEGER }
      expect(await consumer.userId()).toBe("garmin-user-1")
      expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("accepted")
      expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("duplicate")
      await fetch(`${server.url}/__admin/users`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ userId: "garmin-user-1", delivery: "ping" }]),
      })
      expect(await consumer.backfill("dailies", WINDOW[0], WINDOW[1])).toBe("accepted")
      await server.runtime.webhooks.idle()
      expect(received.map((r) => [r.path, r.clientId])).toEqual([
        ["/api/v1/garmin/webhooks/push", "mock_garmin_client"],
        ["/api/v1/garmin/webhooks/ping", "mock_garmin_client"],
      ])
      expect(received[0]?.body.sleeps[0]).toMatchObject({
        userId: "garmin-user-1",
        summaryId: "sleep-1",
      })
      const callback = received[1]?.body.dailies[0].callbackURL as string
      expect(callback).toStartWith(`${server.url}/wellness-api/rest/dailies?`)
      const summaries = (await (await fetch(callback)).json()) as { summaryId: string }[]
      expect(summaries.map((s) => s.summaryId)).toEqual(["daily-1"])
      expect(await consumer.deregister()).toBe(204)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})

describe("the emulator's own state", () => {
  test("the API class works standalone: seeded fixtures, deterministic clock, reset", async () => {
    let now = Date.UTC(2026, 0, 1)
    const api = new GarminHealthAPI({ now: () => now })
    const consumer = new GarminConsumer(
      (r) => api.fetch(r),
      ORIGIN,
      CREDENTIALS,
      () => now,
    )
    consumer.tokens = { ...SEEDED, expiresAt: Number.MAX_SAFE_INTEGER }
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("accepted")
    expect(api.backfills.count()).toBe(1)
    expect(api.notifications.list({ order: "oldest" })[0]?.value.state).toBe("sent")
    now += 1000
    await api.reset()
    expect(api.backfills.count()).toBe(0)
    expect(await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])).toBe("accepted")
  })

  test("the request journal holds metadata only, never a summary", async () => {
    const { consumer, admin, settled } = harness()
    await consumer.backfill("sleeps", WINDOW[0], WINDOW[1])
    await settled()
    const journal = JSON.stringify((await admin("/requests")).body)
    expect(journal).not.toContain("sleep-1")
    expect(journal).not.toContain("deepSleepDurationInSeconds")
    expect(journal).not.toContain(SEEDED.refreshToken)
  })
})
