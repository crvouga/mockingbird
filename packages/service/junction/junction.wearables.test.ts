import { describe, expect, test } from "bun:test"
import { createRuntime, type JunctionRuntime, verifySvix } from "./src/index.js"

// #757 (the wearables REST surface) and #758 (webhook events past the three labtest ones).
// Shapes come from Junction's API reference and @tryvital/vital-node; best guess, not
// oracle-verified.

const KEY = { "x-vital-api-key": "sk_us_test" }
const NOW = Date.parse("2026-03-10T12:00:00Z")

type Json = Record<string, unknown>

const call = async (
  runtime: JunctionRuntime,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> => {
  const response = await runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: { ...KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  const text = await response.text()
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as Json }
}

const admin = (runtime: JunctionRuntime, method: string, path: string, body?: unknown) =>
  call(runtime, method, `/__admin${path}`, body)

const setup = async (options: Parameters<typeof createRuntime>[0] = {}) => {
  const runtime = createRuntime(options)
  await admin(runtime, "POST", "/clock", { now: NOW })
  const created = await call(runtime, "POST", "/v2/user", { client_user_id: "member-1" })
  expect(created.status).toBe(200)
  return { runtime, userId: created.body.user_id as string }
}

const connect = async (runtime: JunctionRuntime, userId: string, body: Json) => {
  const res = await admin(runtime, "POST", `/users/${userId}/connections`, body)
  expect(res.status).toBe(201)
  return res.body
}

describe("#757 wearables REST surface", () => {
  test("POST /v2/link/token mints a link token and web URL for a known user", async () => {
    const { runtime, userId } = await setup()
    const res = await call(runtime, "POST", "/v2/link/token", { user_id: userId, provider: "oura" })
    expect(res.status).toBe(200)
    expect(typeof res.body.link_token).toBe("string")
    expect(res.body.link_web_url).toBe(
      `https://link.tryvital.io/?token=${encodeURIComponent(res.body.link_token as string)}&env=sandbox&region=us`,
    )
    const unknown = await call(runtime, "POST", "/v2/link/token", {
      user_id: "00000000-0000-4000-8000-000000000000",
    })
    expect(unknown.status).toBe(404)
    const badProvider = await call(runtime, "POST", "/v2/link/token", {
      user_id: userId,
      provider: "not_a_provider",
    })
    expect(badProvider.status).toBe(422)
  })

  test("GET /v2/providers lists the provider catalog", async () => {
    const { runtime } = await setup()
    const res = await call(runtime, "GET", "/v2/providers")
    expect(res.status).toBe(200)
    const providers = res.body as unknown as Json[]
    const oura = providers.find((provider) => provider.slug === "oura")
    expect(oura).toMatchObject({
      name: "Oura",
      slug: "oura",
      logo: "https://storage.googleapis.com/vital-assets/oura.png",
      auth_type: "oauth",
    })
    expect(oura?.supported_resources).toContain("sleep")
  })

  test("an admin connection shows on the user and in GET /v2/user/providers", async () => {
    const { runtime, userId } = await setup()
    expect((await call(runtime, "GET", `/v2/user/providers/${userId}`)).body).toEqual({
      providers: [],
    })
    await connect(runtime, userId, { provider: "oura", days: 3 })
    const res = await call(runtime, "GET", `/v2/user/providers/${userId}`)
    expect(res.status).toBe(200)
    const [provider] = res.body.providers as Json[]
    expect(provider).toMatchObject({
      name: "Oura",
      slug: "oura",
      status: "connected",
      error_details: null,
    })
    expect((provider?.resource_availability as Json | undefined)?.sleep).toEqual({
      status: "available",
      scope_requirements: null,
    })
    const user = await call(runtime, "GET", `/v2/user/${userId}`)
    expect(user.body.connected_sources).toEqual([
      {
        source: {
          name: "Oura",
          slug: "oura",
          logo: "https://storage.googleapis.com/vital-assets/oura.png",
        },
        created_on: provider?.created_on,
      },
    ])
  })

  test("POST /v2/user/refresh reports provider/resource sources, and 400 with none", async () => {
    const { runtime, userId } = await setup()
    const none = await call(runtime, "POST", `/v2/user/refresh/${userId}`)
    expect(none.status).toBe(400)
    expect(none.body).toEqual({
      success: false,
      user_id: userId,
      error: "user has no connected sources",
      failed_sources: [],
    })
    await connect(runtime, userId, { provider: "withings" })
    await connect(runtime, userId, { provider: "dexcom_v3", status: "error" })
    const res = await call(runtime, "POST", `/v2/user/refresh/${userId}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      user_id: userId,
      refreshed_sources: ["withings/sleep", "withings/body"],
      in_progress_sources: [],
      failed_sources: [],
    })
  })

  test("DELETE /v2/user/{user_id}/{provider} deregisters a connection", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "fitbit" })
    const res = await call(runtime, "DELETE", `/v2/user/${userId}/fitbit`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect((await call(runtime, "GET", `/v2/user/providers/${userId}`)).body.providers).toEqual([])
    expect((await call(runtime, "GET", `/v2/user/${userId}`)).body.connected_sources).toEqual([])
    expect((await call(runtime, "DELETE", `/v2/user/${userId}/fitbit`)).status).toBe(404)
    expect((await call(runtime, "DELETE", `/v2/user/${userId}/nope`)).status).toBe(422)
  })

  test("summaries return one record per seeded day inside the window", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "fitbit", days: 5 })
    const window = "start_date=2026-03-08&end_date=2026-03-12"
    for (const [path, key] of [
      ["activity", "activity"],
      ["sleep", "sleep"],
      ["sleep_cycle", "sleep_cycle"],
      ["body", "body"],
    ] as const) {
      const res = await call(runtime, "GET", `/v2/summary/${path}/${userId}?${window}`)
      expect(res.status).toBe(200)
      const records = res.body[key] as Json[]
      // Seeded 2026-03-06..2026-03-10; the window starts on the 8th.
      expect(records).toHaveLength(3)
      expect(records[0]?.user_id).toBe(userId)
      expect((records[0]?.source as Json | undefined)?.provider).toBe("fitbit")
    }
    const activity = (
      await call(runtime, "GET", `/v2/summary/activity/${userId}?start_date=2026-03-10`)
    ).body.activity as Json[]
    expect(activity.map((day) => day.calendar_date)).toEqual(["2026-03-10"])
    expect(typeof activity[0]?.steps).toBe("number")
    const meals = await call(runtime, "GET", `/v2/summary/meal/${userId}?${window}`)
    expect((meals.body.meals as Json[]).map((meal) => meal.name)).toEqual([
      "Breakfast",
      "Lunch",
      "Dinner",
      "Breakfast",
      "Lunch",
      "Dinner",
      "Breakfast",
      "Lunch",
      "Dinner",
    ])
    for (const raw of ["sleep", "body"] as const) {
      const res = await call(runtime, "GET", `/v2/summary/${raw}/${userId}/raw?${window}`)
      expect(res.status).toBe(200)
      expect((res.body[raw] as Json[])[0]).toMatchObject({ user_id: userId, source_id: 2 })
    }
  })

  test("summaries need start_date, a known user, and honour the provider filter", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "oura", days: 2 })
    await connect(runtime, userId, { provider: "garmin", days: 2 })
    expect((await call(runtime, "GET", `/v2/summary/sleep/${userId}`)).status).toBe(422)
    const both = await call(runtime, "GET", `/v2/summary/sleep/${userId}?start_date=2026-03-01`)
    expect(both.body.sleep as Json[]).toHaveLength(4)
    const oura = await call(
      runtime,
      "GET",
      `/v2/summary/sleep/${userId}?start_date=2026-03-01&provider=oura`,
    )
    expect(oura.body.sleep as Json[]).toHaveLength(2)
    const missing = await call(
      runtime,
      "GET",
      "/v2/summary/sleep/00000000-0000-4000-8000-000000000000?start_date=2026-03-01",
    )
    expect(missing.status).toBe(404)
  })

  test("readings are deterministic for the same user, provider and day", async () => {
    const first = await setup()
    const second = await setup()
    // Both runtimes mint the same first user id.
    expect(second.userId).toBe(first.userId)
    for (const { runtime, userId } of [first, second])
      await connect(runtime, userId, { provider: "oura", days: 2 })
    const read = async ({ runtime, userId }: typeof first) =>
      (await call(runtime, "GET", `/v2/summary/activity/${userId}?start_date=2026-03-01`)).body
    expect(await read(first)).toEqual(await read(second))
  })

  test("grouped timeseries return samples keyed by provider for every modelled resource", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "apple_health_kit", days: 2 })
    const units: Record<string, string> = {
      steps: "count",
      distance: "m",
      calories_active: "kcal",
      body_weight: "kg",
      body_fat: "percent",
      heartrate: "bpm",
      hrv: "rmssd",
      glucose: "mmol/L",
    }
    for (const [resource, unitName] of Object.entries(units)) {
      const res = await call(
        runtime,
        "GET",
        `/v2/timeseries/${userId}/${resource}/grouped?start_date=2026-03-10&end_date=2026-03-10`,
      )
      expect(res.status).toBe(200)
      expect(res.body.next_cursor).toBeNull()
      const [group] = (res.body.groups as Record<string, Json[]>).apple_health_kit ?? []
      expect((group?.source as Json | undefined)?.provider).toBe("apple_health_kit")
      const data = group?.data as Json[]
      expect(data.length).toBeGreaterThan(0)
      expect(data.every((sample) => sample.unit === unitName)).toBe(true)
      expect(data.every((sample) => String(sample.timestamp).startsWith("2026-03-10"))).toBe(true)
    }
  })

  test("a grouped timeseries the emulator does not model is an explicit 501", async () => {
    const { runtime, userId } = await setup()
    const res = await call(
      runtime,
      "GET",
      `/v2/timeseries/${userId}/blood_oxygen/grouped?start_date=2026-03-01`,
    )
    expect(res.status).toBe(501)
    expect(String(res.body.detail)).toContain("does not model the blood_oxygen timeseries")
    const typo = await call(
      runtime,
      "GET",
      `/v2/timeseries/${userId}/stepz/grouped?start_date=2026-03-01`,
    )
    expect(typo.status).toBe(404)
  })

  test("admin connections refuse an unknown provider or user", async () => {
    const { runtime, userId } = await setup()
    const provider = await admin(runtime, "POST", `/users/${userId}/connections`, {
      provider: "nope",
    })
    expect(provider.status).toBe(400)
    const user = await admin(
      runtime,
      "POST",
      "/users/00000000-0000-4000-8000-000000000000/connections",
      { provider: "oura" },
    )
    expect(user.status).toBe(404)
    expect((await admin(runtime, "GET", `/users/${userId}/connections`)).body).toEqual({
      connections: [],
    })
  })
})

describe("#758 webhook events past the three labtest ones", () => {
  const emit = (runtime: JunctionRuntime, body: Json) =>
    admin(runtime, "POST", "/webhooks/emit", body)

  test("daily.data summary events carry the day's summary as data", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "oura", days: 3 })
    const res = await emit(runtime, {
      event_type: "daily.data.sleep.created",
      user_id: userId,
      calendar_date: "2026-03-09",
    })
    expect(res.status).toBe(200)
    const [event] = res.body.events as Json[]
    expect(event).toMatchObject({
      event_type: "daily.data.sleep.created",
      user_id: userId,
      client_user_id: "member-1",
    })
    const summary = (
      await call(
        runtime,
        "GET",
        `/v2/summary/sleep/${userId}?start_date=2026-03-09&end_date=2026-03-09`,
      )
    ).body.sleep as Json[]
    expect(event?.data).toEqual(summary[0])
    expect(runtime.instance().webhookEvents().at(-1)?.event_type).toBe("daily.data.sleep.created")
  })

  test("daily.data timeseries events wrap samples in data.data", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "dexcom_v3", days: 1 })
    const res = await emit(runtime, { event_type: "daily.data.glucose.updated", user_id: userId })
    expect(res.status).toBe(200)
    const data = (res.body.events as Json[])[0]?.data as Json
    expect(data).toMatchObject({
      source_id: 8,
      source: { name: "Dexcom", slug: "dexcom_v3" },
      user_id: userId,
    })
    expect((data.data as Json[]).length).toBe(96)
  })

  test("every modelled resource emits daily and historical events by its event name", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "apple_health_kit", days: 2 })
    for (const name of [
      "activity",
      "sleep",
      "sleep_cycle",
      "body",
      "meal",
      "steps",
      "distance",
      "calories_active",
      "weight",
      "fat",
      "heartrate",
      "hrv",
      "glucose",
    ]) {
      for (const type of [
        `daily.data.${name}.created`,
        `daily.data.${name}.updated`,
        `historical.data.${name}.created`,
      ]) {
        const res = await emit(runtime, { event_type: type, user_id: userId })
        expect([type, res.status]).toEqual([type, 200])
        expect((res.body.events as Json[]).every((event) => event.event_type === type)).toBe(true)
      }
    }
  })

  test("historical.data events are data-less backfill notices", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "garmin", days: 30 })
    const res = await emit(runtime, {
      event_type: "historical.data.activity.created",
      user_id: userId,
    })
    expect((res.body.events as Json[])[0]?.data).toEqual({
      user_id: userId,
      start_date: "2026-02-09T00:00:00+00:00",
      end_date: "2026-03-11T00:00:00+00:00",
      provider: "garmin",
      is_final: true,
    })
  })

  test("connecting with emitWebhooks sends provider.connection.created and the backfill", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "withings", days: 3, emitWebhooks: true })
    const types = runtime
      .instance()
      .webhookEvents()
      .map((event) => event.event_type)
    expect(types).toEqual([
      "provider.connection.created",
      "historical.data.sleep.created",
      "historical.data.body.created",
      "historical.data.steps.created",
      "historical.data.weight.created",
      "historical.data.fat.created",
      "historical.data.heartrate.created",
    ])
    const created = runtime.instance().webhookEvents()[0]
    expect(created?.data).toMatchObject({
      user_id: userId,
      provider: { name: "Withings", slug: "withings" },
      source: { name: "Withings", slug: "withings" },
    })
  })

  test("provider.connection.error marks the connection errored", async () => {
    const { runtime, userId } = await setup()
    await connect(runtime, userId, { provider: "oura" })
    const res = await emit(runtime, {
      event_type: "provider.connection.error",
      user_id: userId,
      provider: "oura",
      error_type: "required_scopes_not_granted",
    })
    expect(res.status).toBe(200)
    expect((res.body.events as Json[])[0]?.data).toMatchObject({
      provider: "oura",
      user_id: userId,
      error_type: "required_scopes_not_granted",
    })
    const [provider] = (await call(runtime, "GET", `/v2/user/providers/${userId}`)).body
      .providers as Json[]
    expect(provider?.status).toBe("error")
    expect((provider?.error_details as Json | undefined)?.error_type).toBe(
      "required_scopes_not_granted",
    )
  })

  test("labtest.appointment.created carries the booked appointment", async () => {
    const { runtime, userId } = await setup()
    const order = await admin(runtime, "POST", "/orders", {
      user_id: userId,
      lab_test_id: "b439efda-1e07-4d2c-8afb-51771c7cc0cb",
      status: "requisition_created",
    })
    expect(order.status).toBe(201)
    const orderId = order.body.id as string
    const refused = await emit(runtime, {
      event_type: "labtest.appointment.created",
      order_id: orderId,
    })
    expect(refused.status).toBe(409)
    const availability = await call(
      runtime,
      "POST",
      "/v3/order/phlebotomy/appointment/availability?start_date=2026-03-11",
      { first_line: "1 Main St", city: "San Diego", state: "CA", zip_code: "92101" },
    )
    expect(availability.status).toBe(200)
    const slot = (
      (availability.body.slots as Json[]).flatMap((day) => day.slots as Json[]) as Json[]
    )[0]
    const booked = await call(runtime, "POST", `/v3/order/${orderId}/phlebotomy/appointment/book`, {
      booking_key: slot?.booking_key,
    })
    expect(booked.status).toBe(200)
    const res = await emit(runtime, {
      event_type: "labtest.appointment.created",
      order_id: orderId,
    })
    expect(res.status).toBe(200)
    const [event] = res.body.events as Json[]
    expect(event?.event_type).toBe("labtest.appointment.created")
    // Same payload the booking's own labtest.appointment.updated carried.
    const bookingEvent = runtime
      .instance()
      .webhookEvents()
      .find((entry) => entry.event_type === "labtest.appointment.updated")
    expect(event?.data).toEqual(bookingEvent?.data)
    expect((event?.data as Json | undefined)?.id).toBe(booked.body.id)
  })

  test("emitted events are signed with the Svix scheme", async () => {
    const secret = `whsec_${btoa("junction-wearables-secret")}`
    const received: Request[] = []
    const { runtime, userId } = await setup({
      webhooks: {
        url: "http://receiver.local/hook",
        secret,
        fetch: async (request) => {
          received.push(request)
          return new Response(null, { status: 204 })
        },
      },
    })
    await connect(runtime, userId, { provider: "oura" })
    await emit(runtime, { event_type: "daily.data.steps.created", user_id: userId })
    await runtime.webhooks?.idle()
    expect(received).toHaveLength(1)
    const request = received[0] as Request
    const body = await request.text()
    expect(JSON.parse(body).event_type).toBe("daily.data.steps.created")
    const header = (name: string) => request.headers.get(name) ?? ""
    expect(
      await verifySvix(
        secret,
        {
          "svix-id": header("svix-id"),
          "svix-timestamp": header("svix-timestamp"),
          "svix-signature": header("svix-signature"),
        },
        body,
      ),
    ).toBe(true)
  })

  test("documented but unmodelled events are 501; undocumented ones are 400", async () => {
    const { runtime, userId } = await setup()
    for (const type of ["lab_report.parsing_job.created", "daily.data.blood_oxygen.created"]) {
      const res = await emit(runtime, { event_type: type, user_id: userId })
      expect([type, res.status]).toEqual([type, 501])
    }
    for (const type of ["lab_report.redraw_separate_pdf.created", "provider.wellness_visit"]) {
      const res = await emit(runtime, { event_type: type, user_id: userId })
      expect([type, res.status]).toEqual([type, 400])
      expect(String((res.body.error as Json).message)).toContain("not in Junction's documented")
    }
    expect(runtime.instance().webhookEvents()).toEqual([])
  })
})
