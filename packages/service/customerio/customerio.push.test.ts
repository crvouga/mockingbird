import { describe, expect, test } from "bun:test"
import { createRuntime, type Delivery, MAX_DEVICES_PER_PERSON } from "./src/index.js"
import { readCustomerIoDevices, sendCustomerIoPush, trackDeviceEvent } from "./test/consumer.js"

// Issue #671: transactional push sends and per-person device lists. Evidence is Customer.io's
// docs (https://docs.customer.io/messaging/send/transactional/push/, the App API `sendPush`
// operation, https://docs.customer.io/journeys/push-developer-guide), not a live workspace:
// every behaviour here is a best guess, not oracle-verified.
const API = "http://customerio.mock"
const KEY = "fixture-app-key"
const WRITE_KEY = "fixture-write-key"
const TRIGGER = "acme_push_reminder"

const harness = () => {
  const runtime = createRuntime({
    messages: [
      {
        id: 1,
        name: "Acme push reminder",
        trigger_name: TRIGGER,
        description: "",
        send_to_unsubscribed: false,
        link_tracking: false,
        open_tracking: true,
        hide_message_body: false,
        queue_drafts: false,
        created_at: 1_735_689_600,
        updated_at: 1_735_689_600,
      },
    ],
  })
  runtime.clock.freeze()
  const fetchImpl = (request: Request) => runtime.fetch(request)
  const admin = async <T>(path: string, body?: unknown, method = body ? "POST" : "GET") =>
    (await (
      await runtime.fetch(
        new Request(`${API}/__admin${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    ).json()) as T
  const device = (
    userId: string,
    token: string,
    options: {
      event?: "Device Created or Updated" | "Device Deleted"
      type?: "ios" | "android"
      timestamp?: string
      writeKey?: string
      properties?: Record<string, unknown>
    } = {},
  ) =>
    trackDeviceEvent({
      cdpHost: API,
      writeKey: options.writeKey ?? WRITE_KEY,
      userId,
      event: options.event ?? "Device Created or Updated",
      token,
      ...(options.type ? { type: options.type } : { type: "android" }),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.properties ? { properties: options.properties } : {}),
      fetchImpl,
    })
  const identify = (userId: string, traits: Record<string, unknown> = {}) =>
    runtime.fetch(
      new Request(`${API}/v1/identify`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${WRITE_KEY}:`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId, traits }),
      }),
    )
  const devices = (customerId: string) =>
    readCustomerIoDevices({ appApiHost: API, apiKey: KEY, customerId, fetchImpl })
  const push = (body: Record<string, unknown>, apiKey: string | null = KEY) =>
    sendCustomerIoPush({ appApiHost: API, apiKey, body, fetchImpl })
  const outbox = async (query = "?channel=push") =>
    (await admin<{ messages: Delivery[] }>(`/outbox${query}`)).messages
  return { runtime, admin, device, identify, devices, push, outbox, fetchImpl }
}

const at = (seconds: number) => new Date(seconds * 1000).toISOString()

describe("device lists from CDP device events (#671)", () => {
  test("1. a person with no device events has an empty device list", async () => {
    const { identify, devices } = harness()
    await identify("person-1", { email: "person-1@example.test" })
    expect(await devices("person-1")).toEqual([])
  })

  test("2. Device Created or Updated adds the token once and refreshes last_used", async () => {
    const { device, devices } = harness()
    expect((await device("person-1", "T1", { timestamp: at(1_800_000_000) })).status).toBe(200)
    expect(await devices("person-1")).toEqual([
      { id: "T1", platform: "android", last_used: 1_800_000_000 },
    ])
    await device("person-1", "T1", { timestamp: at(1_800_000_100) })
    expect(await devices("person-1")).toEqual([
      { id: "T1", platform: "android", last_used: 1_800_000_100 },
    ])
  })

  test("2b. event properties become the device's attributes", async () => {
    const { device, runtime } = harness()
    await device("person-1", "T1", { properties: { app_version: "3.2.1" } })
    const body = (await (
      await runtime.fetch(
        new Request(`${API}/v1/customers/person-1/attributes`, {
          headers: { Authorization: `Bearer ${KEY}` },
        }),
      )
    ).json()) as { customer: { devices: { attributes?: Record<string, unknown> }[] } }
    expect(body.customer.devices[0]?.attributes).toEqual({ app_version: "3.2.1" })
  })

  test("3. Device Deleted removes the token, through /v1/track and inside /v1/batch", async () => {
    const { device, devices, runtime } = harness()
    await device("person-1", "T1")
    await device("person-1", "T2")
    await device("person-1", "T1", { event: "Device Deleted" })
    expect((await devices("person-1"))?.map((d) => d.id)).toEqual(["T2"])
    const batch = await runtime.fetch(
      new Request(`${API}/v1/batch`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${WRITE_KEY}:`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batch: [
            {
              type: "track",
              userId: "person-1",
              event: "Device Deleted",
              context: { device: { token: "T2" } },
            },
          ],
        }),
      }),
    )
    expect(batch.status).toBe(200)
    expect(await devices("person-1")).toEqual([])
  })

  test("4. a 26th device evicts the one with the oldest last_used", async () => {
    const { device, devices } = harness()
    // T0 is the oldest even though it was added last-but-one.
    for (let index = 1; index <= MAX_DEVICES_PER_PERSON - 1; index += 1) {
      await device("person-1", `T${index}`, { timestamp: at(1_800_000_000 + index) })
    }
    await device("person-1", "T0", { timestamp: at(1_700_000_000) })
    expect(await devices("person-1")).toHaveLength(MAX_DEVICES_PER_PERSON)
    await device("person-1", "T26", { timestamp: at(1_900_000_000) })
    const ids = (await devices("person-1"))?.map((d) => d.id) ?? []
    expect(ids).toHaveLength(MAX_DEVICES_PER_PERSON)
    expect(ids).not.toContain("T0")
    expect(ids).toContain("T26")
  })

  test("5. a refused device event (bad write key or invalid body) changes nothing", async () => {
    const { device, devices, admin, runtime } = harness()
    await device("person-1", "T1")
    await admin("/settings", { keys: [WRITE_KEY, KEY] }, "PUT")
    expect((await device("person-1", "T2", { writeKey: "wrong" })).status).toBe(401)
    const invalid = await runtime.fetch(
      new Request(`${API}/v1/batch`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${WRITE_KEY}:`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batch: [
            {
              type: "track",
              userId: "person-1",
              event: "Device Created or Updated",
              context: { device: { token: "T3" } },
            },
            { type: "track", event: "Device Deleted", context: { device: { token: "T1" } } },
          ],
        }),
      }),
    )
    expect(invalid.status).toBe(400)
    expect((await devices("person-1"))?.map((d) => d.id)).toEqual(["T1"])
  })

  test("14c. a token another person holds moves to the new person (setting: share keeps both)", async () => {
    const { device, devices, admin } = harness()
    await device("person-1", "T1")
    await device("person-2", "T1")
    expect(await devices("person-1")).toEqual([])
    expect((await devices("person-2"))?.map((d) => d.id)).toEqual(["T1"])
    await admin("/settings", { deviceTokenOwnership: "share" }, "PUT")
    await device("person-1", "T1")
    expect((await devices("person-1"))?.map((d) => d.id)).toEqual(["T1"])
    expect((await devices("person-2"))?.map((d) => d.id)).toEqual(["T1"])
  })
})

describe("POST /v1/send/push (#671)", () => {
  test("6. a push to one token is queued and recorded with its overrides", async () => {
    const { device, push, outbox, admin, runtime } = harness()
    await device("person-1", "T1")
    await device("person-1", "T2")
    await admin("/settings", { retainMessageDataForTests: true }, "PUT")
    const customPayload = {
      android: {
        message: {
          notification: { title: "t", body: "m" },
          data: { kind: "reminder" },
          android: { priority: "high" },
        },
      },
    }
    const result = await push({
      transactional_message_id: TRIGGER,
      identifiers: { id: "person-1" },
      to: "T1",
      title: "Reminder",
      message: "Time to check in",
      custom_data: { kind: "reminder" },
      custom_payload: customPayload,
      sound: "none",
      send_to_unsubscribed: false,
      disable_message_retention: true,
    })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error("expected a queued push")
    expect(result.deliveryId).toBeString()
    expect(result.queuedAt).toBeNumber()
    const [delivery] = await outbox()
    expect(delivery?.id).toBe(result.deliveryId)
    expect(delivery?.channel).toBe("push")
    expect(delivery?.identifiers).toEqual({ id: "person-1" })
    expect(delivery?.push).toMatchObject({
      to: "T1",
      devices: ["T1"],
      to_on_profile: true,
      title: "Reminder",
      message: "Time to check in",
      custom_data: { kind: "reminder" },
      custom_payload: customPayload,
      sound: "none",
    })
    const read = await runtime.fetch(
      new Request(`${API}/v1/messages/${result.deliveryId}`, {
        headers: { Authorization: `Bearer ${KEY}` },
      }),
    )
    expect(read.status).toBe(200)
    expect(((await read.json()) as { message: unknown }).message).toMatchObject({
      type: "push",
      recipient: "T1",
      customer_id: "person-1",
      state: "pending",
    })
  })

  test("6b. without retention (and no test override) the push body is not kept", async () => {
    const { device, push, outbox } = harness()
    await device("person-1", "T1")
    await push({
      transactional_message_id: TRIGGER,
      identifiers: { id: "person-1" },
      title: "secret",
      disable_message_retention: true,
    })
    expect((await outbox())[0]?.push).toMatchObject({ title: null, devices: ["T1"] })
  })

  test("7. to: all targets every device, last_used the newest, absent behaves as all", async () => {
    const { device, push, outbox } = harness()
    await device("person-1", "T1", { timestamp: at(1_800_000_300) })
    await device("person-1", "T2", { timestamp: at(1_800_000_100) })
    await device("person-1", "T3", { timestamp: at(1_800_000_200) })
    const base = { transactional_message_id: TRIGGER, identifiers: { id: "person-1" } }
    await push({ ...base, to: "all" })
    await push({ ...base, to: "last_used" })
    await push(base)
    expect((await outbox()).map((d) => d.push?.devices)).toEqual([
      ["T1", "T2", "T3"],
      ["T1"],
      ["T1", "T2", "T3"],
    ])
  })

  test("8. an unknown transactional_message_id matches email/SMS (strict: 400, nothing queued)", async () => {
    const { device, push, outbox, admin } = harness()
    await device("person-1", "T1")
    await admin("/settings", { strictMessages: true }, "PUT")
    const result = await push({
      transactional_message_id: "no_such_trigger",
      identifiers: { id: "person-1" },
      to: "T1",
    })
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "transactional_message_id not found",
      outcome: "fallback",
    })
    expect(await outbox()).toEqual([])
  })

  test("9. a missing or wrong Bearer key is 401 and nothing is queued", async () => {
    const { device, push, outbox, admin } = harness()
    await device("person-1", "T1")
    const body = { transactional_message_id: TRIGGER, identifiers: { id: "person-1" } }
    expect(await push(body, null)).toMatchObject({ ok: false, status: 401 })
    await admin("/settings", { keys: [WRITE_KEY, KEY] }, "PUT")
    expect(await push(body, "wrong")).toMatchObject({ ok: false, status: 401 })
    expect(await outbox()).toEqual([])
  })

  test("10. platform other than all is 400 (requires web push)", async () => {
    const { device, push, outbox } = harness()
    await device("person-1", "T1")
    const base = { transactional_message_id: TRIGGER, identifiers: { id: "person-1" } }
    expect(await push({ ...base, platform: "ios" })).toMatchObject({ ok: false, status: 400 })
    expect(await push({ ...base, platform: "all" })).toMatchObject({ ok: true })
    expect(await outbox()).toHaveLength(1)
  })

  test("11. identifiers must name exactly one of id, email, cio_id", async () => {
    const { push, outbox } = harness()
    for (const identifiers of [{}, { id: "person-1", email: "person-1@example.test" }]) {
      expect(await push({ transactional_message_id: TRIGGER, identifiers })).toMatchObject({
        ok: false,
        status: 400,
        error: "identifiers: must contain exactly one of id, email or cio_id",
      })
    }
    expect(await outbox()).toEqual([])
  })

  test("12. send_to_unsubscribed: false suppresses a push to an unsubscribed profile", async () => {
    const { device, push, outbox, identify } = harness()
    await device("person-1", "T1")
    await identify("person-1", { unsubscribed: true })
    const base = { transactional_message_id: TRIGGER, identifiers: { id: "person-1" } }
    expect(await push({ ...base, send_to_unsubscribed: false })).toMatchObject({ ok: true })
    expect(await push({ ...base, send_to_unsubscribed: true })).toMatchObject({ ok: true })
    expect((await outbox()).map((d) => [d.state, d.reason])).toEqual([
      ["suppressed", "unsubscribed"],
      ["pending", null],
    ])
  })

  test("13. non-string custom_data values are 400 (Firebase only supports strings)", async () => {
    const { device, push, outbox } = harness()
    await device("person-1", "T1")
    expect(
      await push({
        transactional_message_id: TRIGGER,
        identifiers: { id: "person-1" },
        custom_data: { count: 3 },
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "custom_data.count: must be a string (Firebase only supports strings)",
      outcome: "fallback",
    })
    expect(await outbox()).toEqual([])
  })

  test("14a/b. unobserved targets are accepted and flagged by default", async () => {
    const { device, push, outbox } = harness()
    await device("person-1", "T1")
    await push({ transactional_message_id: TRIGGER, identifiers: { id: "person-1" }, to: "TX" })
    await push({ transactional_message_id: TRIGGER, identifiers: { id: "nobody" }, to: "T9" })
    expect((await outbox()).map((d) => d.push)).toMatchObject([
      { devices: ["TX"], to_on_profile: false, profile_found: true },
      { devices: ["T9"], to_on_profile: false, profile_found: false },
    ])
  })

  test("14. the push_unknown_targets_rejected preset (or the setting) makes them definite 4xx", async () => {
    const { device, push, outbox, admin } = harness()
    await device("person-1", "T1")
    await admin("/faults", { preset: "push_unknown_targets_rejected" })
    expect(
      await push({ transactional_message_id: TRIGGER, identifiers: { id: "person-1" }, to: "TX" }),
    ).toMatchObject({ ok: false, status: 400, error: "to: device not found on profile" })
    await admin("/settings", { pushUnknownTargets: "reject" }, "PUT")
    expect(
      await push({ transactional_message_id: TRIGGER, identifiers: { id: "nobody" } }),
    ).toMatchObject({ ok: false, status: 400, outcome: "fallback" })
    expect(
      await push({ transactional_message_id: TRIGGER, identifiers: { id: "person-1" }, to: "T1" }),
    ).toMatchObject({ ok: true })
    expect(await outbox()).toHaveLength(1)
  })

  test("onSends fault presets cover /v1/send/push", async () => {
    const { device, push, outbox, admin } = harness()
    await device("person-1", "T1")
    const body = { transactional_message_id: TRIGGER, identifiers: { id: "person-1" } }
    await admin("/faults", { preset: "rate_limited", count: 1 })
    expect(await push(body)).toMatchObject({ ok: false, status: 429, outcome: "retry" })
    await admin("/faults", { preset: "server_error", count: 1 })
    expect(await push(body)).toMatchObject({ ok: false, status: 500, outcome: "hold" })
    await admin("/faults", { preset: "accepted_but_500", count: 1 })
    expect(await push(body)).toMatchObject({ ok: false, status: 500, outcome: "hold" })
    expect(await outbox()).toHaveLength(1)
  })
})

describe("push test controls (#671)", () => {
  test("PUT /__admin/devices/:id sets a person's devices directly", async () => {
    const { admin, devices, push, outbox } = harness()
    const set = await admin<{ devices: unknown[] }>(
      "/devices/person-1",
      {
        devices: [
          { token: "A1", platform: "ios", last_used: 1_800_000_000 },
          { token: "A2", platform: "android", last_used: 1_800_000_500 },
        ],
      },
      "PUT",
    )
    expect(set.devices).toHaveLength(2)
    expect(await devices("person-1")).toEqual([
      { id: "A1", platform: "ios", last_used: 1_800_000_000 },
      { id: "A2", platform: "android", last_used: 1_800_000_500 },
    ])
    await push({
      transactional_message_id: TRIGGER,
      identifiers: { id: "person-1" },
      to: "last_used",
    })
    expect((await outbox())[0]?.push?.devices).toEqual(["A2"])
    expect(await admin("/devices/person-1", { devices: "nope" }, "PUT")).toMatchObject({
      error: { type: "mockingbird_admin" },
    })
  })

  test("outbox channel=push filters, and reset, namespaces and snapshots cover devices and pushes", async () => {
    const { device, devices, push, outbox, admin, fetchImpl } = harness()
    await device("person-1", "T1")
    await push({ transactional_message_id: TRIGGER, identifiers: { id: "person-1" } })
    await fetchImpl(
      new Request(`${API}/v1/send/email`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          transactional_message_id: TRIGGER,
          identifiers: { id: "person-1" },
          to: "person-1@example.test",
        }),
      }),
    )
    expect(await outbox("")).toHaveLength(2)
    expect((await outbox()).map((d) => d.channel)).toEqual(["push"])

    const snapshot = await admin<{ id: string }>("/snapshots", {})
    await device("person-1", "T1", { event: "Device Deleted" })
    expect(await devices("person-1")).toEqual([])
    await admin(`/snapshots/${snapshot.id}/restore`, {})
    expect((await devices("person-1"))?.map((d) => d.id)).toEqual(["T1"])

    const other = await fetchImpl(
      new Request(`${API}/__admin/ns/other/v1/customers/person-1/attributes`, {
        headers: { Authorization: `Bearer ${KEY}` },
      }),
    )
    expect(other.status).toBe(404)

    await admin("/reset", {})
    expect(await devices("person-1")).toBeNull()
    expect(await outbox()).toEqual([])
  })
})
