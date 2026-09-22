import { afterEach, describe, expect, test } from "bun:test"
import { auth, calendar } from "@googleapis/calendar"
import { GOOGLE_CALENDAR_PRESETS } from "./src/index.js"
import { createServer, type GoogleCalendarServer } from "./src/server.js"
import {
  EMR_CALENDAR_NAME,
  GoogleCalendarConsumer,
  handlePrimaryCalendarWebhook,
  type PushHeaders,
} from "./test/consumer.js"

const CLIENT = { clientId: "emr-client.apps.googleusercontent.com", clientSecret: "emr-secret" }
const DAY = 86_400_000

type Received = { headers: PushHeaders; status: number }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A served mock, a Bun.serve receiver running our webhook controller, and our consumer. */
const harness = async (base: (url: string) => string = (url) => url) => {
  const received: Received[] = []
  const processed: string[] = []
  const sink = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const headers: PushHeaders = Object.fromEntries(request.headers)
      const result = await handlePrimaryCalendarWebhook(headers, async (data) => {
        processed.push(data.channelId)
      })
      received.push({ headers, status: result.status })
      return Response.json(result.body, { status: result.status })
    },
  })
  const server: GoogleCalendarServer = await createServer({ push: { retryDelaysMs: [0] } })
  cleanups.push(async () => {
    await server.close()
    sink.stop(true)
  })
  const hooks = `http://127.0.0.1:${sink.port}/v1/webhooks/google-calendar`
  const consumer = new GoogleCalendarConsumer(base(server.url), {
    ...CLIENT,
    primaryWebhookUrl: `${hooks}/primary`,
    emrWebhookUrl: `${hooks}/emr`,
  })
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const signIn = async (who = "dr.house") => consumer.exchangeGoogleToken(`4/mock-${who}`)
  /** Wait until every published push has settled (delivered or failed). */
  const settle = async () => {
    const hub = server.runtime.webhooks
    const deadline = Date.now() + 3_000
    for (;;) {
      await hub.flush()
      await hub.idle()
      if (hub.deliveries().every((d) => d.state !== "pending") || Date.now() > deadline) break
      await Bun.sleep(5)
    }
  }
  /** The raw SDK, for calls our service does not make (incremental sync, paging). */
  const sdk = (accessToken: string) => {
    const client = new auth.OAuth2()
    client.setCredentials({ access_token: accessToken })
    return calendar({ version: "v3", auth: client, rootUrl: `${base(server.url)}/` })
  }
  return { server, consumer, admin, signIn, received, processed, settle, sdk }
}

const range = {
  start: new Date(Date.now() - 7 * DAY).toISOString(),
  end: new Date(Date.now() + 30 * DAY).toISOString(),
}
const at = (days: number, hours = 15) =>
  new Date(Math.floor(Date.now() / DAY) * DAY + days * DAY + hours * 3_600_000).toISOString()

describe("S25 Google Calendar acceptance: OAuth", () => {
  test("code exchange (postmessage) gives id, access and refresh tokens; userinfo; codes are single-use", async () => {
    const { consumer, signIn } = await harness()
    const tokens = await signIn()
    expect(tokens.accessToken).toStartWith("ya29.")
    expect(tokens.refreshToken).toStartWith("1//")
    expect(tokens.scope).toContain("https://www.googleapis.com/auth/calendar")
    expect(tokens.expiresIn).toBeGreaterThan(3500)
    const claims = JSON.parse(
      atob((tokens.idToken.split(".")[1] as string).replace(/-/g, "+").replace(/_/g, "/")),
    )
    expect(claims).toMatchObject({
      iss: "https://accounts.google.com",
      aud: CLIENT.clientId,
      email: "dr.house@example.com",
    })
    expect(await consumer.getUserInfoFromGoogle(tokens.accessToken as string)).toMatchObject({
      email: "dr.house@example.com",
      name: "Dr House",
      given_name: "Dr",
      family_name: "House",
    })
    await expect(signIn()).rejects.toThrow(/invalid_grant/)
    await expect(consumer.exchangeGoogleToken("not-a-code")).rejects.toThrow(/invalid_grant/)
  })

  test("refresh, invalid_grant, and revoke", async () => {
    const { consumer, signIn, server } = await harness()
    const tokens = await signIn("cuddy")
    const refreshed = await consumer.refreshToken(tokens.refreshToken as string)
    expect(refreshed.success).toBe(true)
    expect(refreshed.success && refreshed.accessToken).toStartWith("ya29.")
    server.runtime.applyPreset("invalid_grant", "default", { count: 10 })
    const failed = await consumer.refreshToken(tokens.refreshToken as string)
    expect(failed).toMatchObject({ success: false })
    expect(!failed.success && failed.error).toMatch(/invalid_grant/)
    server.runtime.faults.clear()
    expect(await consumer.revokeToken(tokens.accessToken as string)).toBe(true)
    await expect(consumer.getUserInfoFromGoogle(tokens.accessToken as string)).rejects.toThrow(
      "Failed to get user info",
    )
    expect(await consumer.revokeToken(tokens.accessToken as string)).toBe(false)
    expect((await consumer.refreshToken("1//garbage")).success).toBe(false)
  })
})

describe("S25 Google Calendar acceptance: EMR calendar sync", () => {
  test("the EMR calendar is created once, then found by name in calendarList", async () => {
    const { consumer, signIn, sdk } = await harness()
    const { accessToken } = await signIn()
    const first = await consumer.getOrCreateEMRCalendar(accessToken as string, "prac-1")
    expect(first).toEndWith("@group.calendar.google.com")
    expect(await consumer.getOrCreateEMRCalendar(accessToken as string, "prac-1")).toBe(first)
    const names = (await sdk(accessToken as string).calendarList.list()).data.items?.map(
      (c) => c.summary,
    )
    expect(names).toEqual(["dr.house@example.com", EMR_CALENDAR_NAME])
  })

  test("EMR appointments: insert, find by extended property, update, cleanup; availability excludes them", async () => {
    const { consumer, signIn, admin } = await harness()
    const token = (await signIn()).accessToken as string
    const appt = {
      medplumAppointmentId: "appt-1",
      practitionerId: "prac-1",
      appointmentName: "Follow-up",
      serviceType: "Consult",
      status: "booked",
      start: at(1),
      end: at(1, 16),
    }
    const created = await consumer.createEMRAppointment(token, appt)
    expect(created.googleEventId).toMatch(/^[a-v0-9]{26}$/)
    const found = await consumer.findGoogleEventByEMRAppointmentId(token, "appt-1")
    expect(found?.id).toBe(created.googleEventId as string)
    expect(found?.summary).toBe("EMR-local-Follow-up")
    const moved = await consumer.updateEMRAppointment(
      token,
      { ...appt, start: at(2), end: at(2, 16) },
      created.googleEventId as string,
    )
    expect(moved.googleEventId).toBe(created.googleEventId as string)
    // A personal event added in Google (not by our app) is what availability sees.
    await admin("/events", {
      email: "dr.house@example.com",
      event: { summary: "Dentist", start: { dateTime: at(3) }, end: { dateTime: at(3, 16) } },
    })
    const busy = await consumer.fetchCalendarEvents(token, range)
    expect(busy.success).toBe(true)
    expect(busy.events.map((e) => e.title)).toEqual(["Dentist"])
    expect(busy.nextSyncToken).toBeDefined()
    expect(await consumer.deleteEvents(token, [created.googleEventId as string])).toBe(1)
    // Deleting again is a 410 our cleanup logs and skips.
    expect(await consumer.deleteEvents(token, [created.googleEventId as string])).toBe(0)
    expect(consumer.logs.at(-1)?.fields?.status).toBe(410)
    expect(await consumer.findGoogleEventByEMRAppointmentId(token, "appt-1")).toBeNull()
  })
})

describe("S25 Google Calendar acceptance: push notifications", () => {
  test("watch → sync, then exists on every change; renewal stops the old channel; stop ends pushes", async () => {
    const { consumer, signIn, admin, received, processed, settle } = await harness()
    const token = (await signIn()).accessToken as string
    const first = await consumer.registerWebhookChannel(token, "prac-1", "primary")
    await settle()
    expect(received).toHaveLength(1)
    const sync = received[0]?.headers ?? {}
    expect(sync["x-goog-resource-state"]).toBe("sync")
    expect(sync["x-goog-channel-id"]).toBe(first.channelId)
    expect(sync["x-goog-resource-id"]).toBe(first.resourceId)
    expect(sync["x-goog-message-number"]).toBe("1")
    expect(sync["x-goog-resource-uri"]).toContain("/calendar/v3/calendars/primary/events")
    expect(new Date(sync["x-goog-channel-expiration"] as string).getTime()).toBeGreaterThan(
      Date.now() + 29 * DAY,
    )
    expect(received[0]?.status).toBe(200)

    await admin("/events", {
      email: "dr.house@example.com",
      event: { summary: "Lunch", start: { dateTime: at(1, 12) }, end: { dateTime: at(1, 13) } },
    })
    await settle()
    expect(received.at(-1)?.headers["x-goog-resource-state"]).toBe("exists")
    expect(received.at(-1)?.headers["x-goog-message-number"]).toBe("2")
    expect(processed).toEqual([first.channelId])

    const renewed = await consumer.registerWebhookChannel(token, "prac-1", "primary", {
      channelId: first.channelId,
      resourceId: first.resourceId,
    })
    await settle()
    const before = received.length
    await consumer.createEMRAppointment(token, {
      medplumAppointmentId: "appt-9",
      practitionerId: "prac-1",
      status: "booked",
      start: at(2),
      end: at(2, 16),
    })
    await settle()
    expect(received.slice(before).map((r) => r.headers["x-goog-channel-id"])).toEqual([
      renewed.channelId,
    ])

    await consumer.stopChannel(token, {
      channelId: renewed.channelId,
      resourceId: renewed.resourceId,
    })
    await expect(
      consumer.stopChannel(token, { channelId: renewed.channelId, resourceId: renewed.resourceId }),
    ).rejects.toMatchObject({ response: { status: 404 } })
    const stoppedAt = received.length
    await admin("/events", {
      email: "dr.house@example.com",
      event: { summary: "Gym", start: { dateTime: at(4) }, end: { dateTime: at(4, 16) } },
    })
    await settle()
    expect(received.length).toBe(stoppedAt)
  })

  test("the EMR calendar channel watches the secondary calendar; the receiver 400s without headers", async () => {
    const { consumer, signIn, received, settle } = await harness()
    const token = (await signIn()).accessToken as string
    const channel = await consumer.registerWebhookChannel(token, "prac-2", "emr")
    await settle()
    expect(received[0]?.headers["x-goog-resource-uri"]).toContain("group.calendar.google.com")
    expect(channel.resourceId).not.toBe("")
    expect((await handlePrimaryCalendarWebhook({}, async () => {})).status).toBe(400)
    expect(
      (
        await handlePrimaryCalendarWebhook(
          { "x-goog-channel-id": "c", "x-goog-resource-state": "not_exists" },
          async () => {},
        )
      ).body,
    ).toEqual({ message: "Non-exists state ignored" })
  })

  test("push_duplicate delivers twice; channels expire on the mock clock", async () => {
    const { consumer, signIn, admin, received, settle, server } = await harness()
    const token = (await signIn()).accessToken as string
    await consumer.registerWebhookChannel(token, "prac-3", "primary")
    await settle()
    server.runtime.applyPreset("push_duplicate", "default")
    await admin("/events", {
      email: "dr.house@example.com",
      event: { summary: "A", start: { dateTime: at(1) }, end: { dateTime: at(1, 16) } },
    })
    await settle()
    expect(received.filter((r) => r.headers["x-goog-message-number"] === "2")).toHaveLength(2)
    server.runtime.clock.advance(31 * DAY)
    const count = received.length
    await admin("/events", {
      email: "dr.house@example.com",
      event: { summary: "B", start: { dateTime: at(40) }, end: { dateTime: at(40, 16) } },
    })
    await settle()
    expect(received.length).toBe(count)
  })
})

describe("S25 Google Calendar acceptance: sync tokens, paging and failures", () => {
  test("incremental sync: nextSyncToken → changes and deletions; invalid or invalidated tokens are 410", async () => {
    // Our fetchCalendarEvents never sends its syncToken (the assignment is commented out), so
    // incremental sync is exercised through the SDK directly; the 410 fallback is ported too.
    const { signIn, sdk, admin, server, consumer } = await harness()
    const token = (await signIn()).accessToken as string
    const cal = sdk(token)
    const a = await cal.events.insert({
      calendarId: "primary",
      requestBody: { summary: "A", start: { dateTime: at(1) }, end: { dateTime: at(1, 16) } },
    })
    const full = await cal.events.list({ calendarId: "primary", singleEvents: true })
    const syncToken = full.data.nextSyncToken as string
    await cal.events.insert({
      calendarId: "primary",
      requestBody: { summary: "B", start: { dateTime: at(2) }, end: { dateTime: at(2, 16) } },
    })
    await cal.events.delete({ calendarId: "primary", eventId: a.data.id as string })
    const delta = await cal.events.list({ calendarId: "primary", syncToken })
    expect(delta.data.items?.map((e) => [e.summary ?? null, e.status])).toEqual([
      ["B", "confirmed"],
      [null, "cancelled"],
    ])
    await expect(
      cal.events.list({ calendarId: "primary", syncToken, timeMin: range.start }),
    ).rejects.toMatchObject({
      response: { status: 400 },
    })
    await expect(
      cal.events.list({ calendarId: "primary", syncToken: "garbage" }),
    ).rejects.toMatchObject({
      response: { status: 410, data: { error: { errors: [{ reason: "fullSyncRequired" }] } } },
    })
    await admin("/sync-tokens/invalidate", {})
    await expect(
      cal.events.list({ calendarId: "primary", syncToken: delta.data.nextSyncToken as string }),
    ).rejects.toMatchObject({
      response: { status: 410 },
    })
    server.runtime.applyPreset("sync_token_gone", "default", { count: 1 })
    // Our service does not send the token, so the preset (which only fires with one) cannot bite.
    expect((await consumer.fetchCalendarEvents(token, range, 1000, "stale")).success).toBe(true)
  })

  test("paging: nextPageToken chains through maxResults pages", async () => {
    const { signIn, sdk } = await harness()
    const cal = sdk((await signIn()).accessToken as string)
    for (let i = 0; i < 5; i++) {
      await cal.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: `E${i}`,
          start: { dateTime: at(i + 1) },
          end: { dateTime: at(i + 1, 16) },
        },
      })
    }
    const seen: string[] = []
    let pageToken: string | undefined
    do {
      const page = await cal.events.list({
        calendarId: "primary",
        maxResults: 2,
        singleEvents: true,
        orderBy: "startTime",
        ...(pageToken ? { pageToken } : {}),
      })
      seen.push(...(page.data.items ?? []).map((e) => e.summary as string))
      pageToken = page.data.nextPageToken ?? undefined
      if (!pageToken) expect(page.data.nextSyncToken).toBeUndefined()
    } while (pageToken)
    expect(seen).toEqual(["E0", "E1", "E2", "E3", "E4"])
  })

  test("presets map onto our error branches", async () => {
    const cases: [string, number, RegExp | "result"][] = [
      ["calendar_api_disabled", 1, /Google Calendar API is not enabled/],
      ["insufficient_scopes", 1, /Insufficient permissions for Google Calendar/],
      ["rate_limited", 1, "result"],
      ["too_many_requests", 10, "result"],
      ["token_expired", 1, "result"],
    ]
    for (const [preset, count, expected] of cases) {
      const { consumer, signIn, server } = await harness()
      const token = (await signIn()).accessToken as string
      server.runtime.applyPreset(preset, "default", { count })
      if (expected === "result") {
        const result = await consumer.fetchCalendarEvents(token, range)
        expect(result.success).toBe(false)
        expect(result.error).toStartWith("Failed to fetch Google Calendar events: ")
      } else {
        await expect(consumer.fetchCalendarEvents(token, range)).rejects.toThrow(expected)
      }
    }
    // gaxios retries 5xx: a single backendError is invisible to our service.
    const { consumer, signIn, server } = await harness()
    const token = (await signIn()).accessToken as string
    server.runtime.applyPreset("backend_error", "default", { count: 1 })
    expect((await consumer.fetchCalendarEvents(token, range)).success).toBe(true)
    expect(Object.keys(GOOGLE_CALENDAR_PRESETS)).toEqual(
      expect.arrayContaining([
        "invalid_grant",
        "rate_limited",
        "too_many_requests",
        "sync_token_gone",
        "backend_error",
      ]),
    )
  })

  test("validation: missing end, empty range, duplicate id, non-https watch when required", async () => {
    const { signIn, sdk, admin } = await harness()
    const cal = sdk((await signIn()).accessToken as string)
    await expect(
      cal.events.insert({
        calendarId: "primary",
        requestBody: { summary: "x", start: { dateTime: at(1) } },
      }),
    ).rejects.toMatchObject({
      response: { status: 400, data: { error: { message: "Missing end time." } } },
    })
    await expect(
      cal.events.insert({
        calendarId: "primary",
        requestBody: { summary: "x", start: { dateTime: at(1, 16) }, end: { dateTime: at(1, 15) } },
      }),
    ).rejects.toMatchObject({
      response: { data: { error: { errors: [{ reason: "timeRangeEmpty" }] } } },
    })
    await cal.events.insert({
      calendarId: "primary",
      requestBody: { id: "emrappt00001", start: { dateTime: at(1) }, end: { dateTime: at(1, 16) } },
    })
    await expect(
      cal.events.insert({
        calendarId: "primary",
        requestBody: {
          id: "emrappt00001",
          start: { dateTime: at(1) },
          end: { dateTime: at(1, 16) },
        },
      }),
    ).rejects.toMatchObject({ response: { status: 409 } })
    await expect(
      cal.events.list({ calendarId: "nobody@group.calendar.google.com" }),
    ).rejects.toMatchObject({ response: { status: 404 } })
    await admin("/settings", { requireHttpsWebhooks: true }, "PUT")
    await expect(
      cal.events.watch({
        calendarId: "primary",
        requestBody: { id: "c1", type: "web_hook", address: "http://127.0.0.1/hook" },
      }),
    ).rejects.toMatchObject({ response: { status: 400 } })
  })
})

describe("contract", () => {
  test("namespaces by account (access token), header and /ns/ prefix; the journal holds no event text", async () => {
    const { server, admin, sdk, signIn } = await harness()
    await admin("/credentials", { credentials: { "wilson@example.com": "w" } }, "PUT")
    const wilson = sdk((await signIn("wilson")).accessToken as string)
    await wilson.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: "Private oncology consult",
        start: { dateTime: at(1) },
        end: { dateTime: at(1, 16) },
      },
    })
    const inW = (await (await admin("/events?namespace=w")).json()) as { events: unknown[] }
    const inDefault = (await (await admin("/events")).json()) as { events: unknown[] }
    expect(inW.events).toHaveLength(1)
    expect(inDefault.events).toHaveLength(0)
    // googleapis resolves request paths against rootUrl's origin, dropping a /ns/ prefix, so
    // calendar calls pick their namespace by account. The OAuth endpoints and our userinfo
    // fetch concatenate, so the prefix carries there.
    const prefixed = await harness((url) => `${url}/ns/team`)
    await prefixed.admin(
      "/users/chase%40example.com?namespace=team",
      { name: "Robert Chase" },
      "PUT",
    )
    const chase = await prefixed.signIn("chase")
    expect((await prefixed.consumer.getUserInfoFromGoogle(chase.accessToken as string)).name).toBe(
      "Robert Chase",
    )
    const viaHeader = await fetch(`${server.url}/calendar/v3/users/me/calendarList`, {
      headers: { authorization: "Bearer nope", "x-mockingbird-namespace": "w" },
    })
    expect(viaHeader.status).toBe(401)
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/^google-calendar@.*; ns=w$/)
    const journal = await (await admin("/requests?namespace=w")).text()
    expect(journal).toContain("EventsInsert")
    expect(journal).not.toContain("oncology")
  })
})
