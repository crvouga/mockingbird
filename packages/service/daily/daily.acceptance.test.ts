import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  createRuntime,
  DAILY_PRESETS,
  type DailyWebhook,
  type TokenInspection,
} from "./src/index.js"
import type { RoomRecord, Settings, WarningRecord } from "./src/state.js"
import {
  DailyEmrConsumer,
  DailyVideoServiceConsumer,
  DailyWebhookReceiver,
  extractRoomToken,
  FakeS3,
  readTranscript,
  VIDEO_MEETING_BUFFER_AFTER_SECONDS,
  VIDEO_MEETING_BUFFER_BEFORE_SECONDS,
} from "./test/consumer.js"

const API = "http://daily.mock"
const API_KEY = "daily-api-key-for-tests"
const DOMAIN_ID = "8f0c7c9e-2b5a-4c1e-9d3e-6a7b8c9d0e1f"
const ROOM_BASE = "https://geviti-mock.daily.test/"
const WEBHOOK_SECRET = "daily-webhook-secret"
const BUCKET = "emr-transcripts"

/** Appointment times in the future on the frozen mock clock. */
const NOW = Date.UTC(2026, 9, 1, 15, 0, 0)
const START = "2026-10-02T16:00:00.000Z"
const END = "2026-10-02T16:30:00.000Z"
const PROVIDER = { providerId: "prac-7f3a", providerName: "Dr Grace Hopper" }

const harness = (settings: Partial<Settings> = {}) => {
  const s3 = new FakeS3()
  const deliveries: { headers: Headers; raw: Buffer }[] = []
  const runtime = createRuntime({
    settings: { domainId: DOMAIN_ID, roomUrlBase: ROOM_BASE, ...settings },
    transcripts: { endpoint: "http://s3.local:4569", bucket: BUCKET, fetch: s3.fetch },
    webhooks: {
      url: "http://emr.local/v1/webhooks/daily",
      secret: WEBHOOK_SECRET,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, raw: Buffer.from(await request.arrayBuffer()) })
        return Response.json({ acknowledged: true })
      },
    },
  })
  runtime.clock.freeze()
  runtime.clock.set(NOW)
  const send = (request: Request) => runtime.fetch(request)
  const emr = new DailyEmrConsumer(
    { apiKey: API_KEY, baseUrl: `${API}/v1`, roomBaseUrl: ROOM_BASE },
    send,
    () => runtime.clock.now(),
  )
  const backend = new DailyVideoServiceConsumer(
    { apiKey: API_KEY, baseUrl: `${API}/v1`, domainId: DOMAIN_ID },
    send,
    () => runtime.clock.now(),
  )
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const room = async (name: string) => {
    const response = await admin(`/rooms/${name}`)
    return response.status === 200 ? ((await response.json()) as RoomRecord) : undefined
  }
  const decode = async (token: string, apiKey = API_KEY) =>
    (await (await admin("/tokens/decode", { token, apiKey })).json()) as TokenInspection
  return { runtime, s3, deliveries, emr, backend, admin, room, decode }
}

describe("S11.6 acceptance: EMR booking, join, reschedule, cancel", () => {
  test("an EMR booking creates a room and a provider token on the mock", async () => {
    const { emr, room, decode } = harness()
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    const created = await room(meeting.roomId)
    expect(created?.privacy).toBe("private")
    expect(meeting.roomUrl).toBe(`${ROOM_BASE}${meeting.roomId}`)
    const endSec = Date.parse(END) / 1000
    expect(created?.config).toMatchObject({
      nbf: endSec - 1800 - VIDEO_MEETING_BUFFER_BEFORE_SECONDS,
      exp: endSec + VIDEO_MEETING_BUFFER_AFTER_SECONDS,
      enable_knocking: true,
      sfu_switchover: 2,
      geo: "us-west-2",
      permissions: { hasPresence: true, canSend: ["video", "audio"] },
    })
    expect(meeting.providerJoinUrl).toBe(`${ROOM_BASE}${meeting.roomId}?t=${meeting.providerToken}`)
    expect(meeting.patientJoinUrl).toBe(`${ROOM_BASE}${meeting.roomId}`)
    const token = await decode(meeting.providerToken)
    expect(token.signatureValid).toBe(true)
    expect(token.properties).toMatchObject({
      room_name: meeting.roomId,
      is_owner: true,
      user_id: PROVIDER.providerId,
      user_name: PROVIDER.providerName,
      domain_id: DOMAIN_ID,
      exp: endSec + 4 * 3600,
    })
    // Owners may enter before the room opens; the token is valid now.
    expect(token.joinable).toBe(true)
  })

  test("createAppointmentVideoMeeting creates two rooms (one orphaned) and the mock tolerates it", async () => {
    const { emr, admin } = harness()
    const { orphanRoom, meeting } = await emr.createAppointmentVideoMeeting({
      start: START,
      end: END,
      ...PROVIDER,
    })
    expect(orphanRoom).not.toBe(meeting.roomId)
    const { rooms } = (await (await admin("/rooms")).json()) as { rooms: RoomRecord[] }
    expect(rooms.map((r) => r.name).sort()).toEqual([orphanRoom, meeting.roomId].sort())
  })

  test("the member-app join returns https://<mock-room-base>/<name>?t=<token>", async () => {
    const { emr, decode, runtime } = harness()
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    const url = await emr.patientJoinUrl(meeting.roomId, "patient-42", "Ada Lovelace", START, END)
    expect(url.startsWith(`${ROOM_BASE}${meeting.roomId}?t=`)).toBe(true)
    const token = extractRoomToken(url) as string
    const inspected = await decode(token)
    expect(inspected.properties).toMatchObject({
      room_name: meeting.roomId,
      is_owner: false,
      user_id: "patient-42",
      nbf: Date.parse(START) / 1000 - VIDEO_MEETING_BUFFER_BEFORE_SECONDS,
      exp: Date.parse(END) / 1000 + VIDEO_MEETING_BUFFER_AFTER_SECONDS,
      eject_at_token_exp: true,
      enable_recording: false,
    })
    // A day early: the patient token and the room are not open yet.
    expect(inspected.joinable).toBe(false)
    expect(inspected.problems).toContain("token not yet valid (nbf is in the future)")
    expect(inspected.problems).toContain("room not yet open (room nbf is in the future)")
    runtime.clock.set(Date.parse(START) - 60_000)
    expect((await decode(token)).joinable).toBe(true)
    runtime.clock.set(Date.parse(END) + 2 * 3_600_000)
    expect((await decode(token)).problems).toContain("token expired (exp is in the past)")
  })

  test("rescheduling updates nbf/exp; the timing update also moves eject_after_elapsed", async () => {
    const { emr, room, decode } = harness()
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    const newEnd = new Date("2026-10-05T19:45:00.000Z")
    const moved = await emr.rescheduleVideoMeeting(
      { roomId: meeting.roomId },
      newEnd,
      45,
      { id: PROVIDER.providerId, name: PROVIDER.providerName },
      "booked",
    )
    const endSec = newEnd.getTime() / 1000
    expect((await room(meeting.roomId))?.config).toMatchObject({
      nbf: endSec - 45 * 60 - VIDEO_MEETING_BUFFER_BEFORE_SECONDS,
      exp: endSec + VIDEO_MEETING_BUFFER_AFTER_SECONDS,
      max_participants: 3,
      enable_knocking: true,
    })
    if (moved && "providerToken" in moved) {
      expect((await decode(moved.providerToken)).properties?.exp).toBe(endSec + 4 * 3600)
    } else {
      throw new Error("reschedule failed")
    }
    const timing = await emr.updateAppointmentVideoMeetingTiming(
      meeting.roomId,
      new Date("2026-10-06T15:00:00Z"),
      new Date("2026-10-06T16:00:00Z"),
    )
    expect(timing).toEqual({ success: true, message: "Video meeting timing updated successfully" })
    expect((await room(meeting.roomId))?.config).toMatchObject({
      nbf: Date.parse("2026-10-06T15:00:00Z") / 1000 - VIDEO_MEETING_BUFFER_BEFORE_SECONDS,
      exp: Date.parse("2026-10-06T16:00:00Z") / 1000 + VIDEO_MEETING_BUFFER_AFTER_SECONDS,
      eject_after_elapsed: 3600 + VIDEO_MEETING_BUFFER_AFTER_SECONDS,
    })
  })

  test("cancelling deletes the room; a second delete's 404 is tolerated", async () => {
    const { emr, room } = harness()
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    await emr.rescheduleVideoMeeting(
      { roomId: meeting.roomId },
      new Date(END),
      30,
      { id: PROVIDER.providerId, name: PROVIDER.providerName },
      "cancelled",
    )
    expect(await room(meeting.roomId)).toBeUndefined()
    await emr.deleteRoom(meeting.roomId)
  })

  test("a 404 on update takes the 'room no longer exists' branch (missing room, or room_not_found)", async () => {
    const { emr, runtime } = harness()
    expect(
      await emr.updateAppointmentVideoMeetingTiming("gone-room", new Date(START), new Date(END)),
    ).toEqual({ success: false, message: "Video meeting room no longer exists" })
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    runtime.applyPreset("room_not_found", "default", { count: 1 })
    expect(
      await emr.updateAppointmentVideoMeetingTiming(meeting.roomId, new Date(START), new Date(END)),
    ).toEqual({ success: false, message: "Video meeting room no longer exists" })
    // Any other failure is re-thrown into the generic message.
    runtime.applyPreset("server_error", "default", { count: 1 })
    const failed = await emr.updateAppointmentVideoMeetingTiming(
      meeting.roomId,
      new Date(START),
      new Date(END),
    )
    expect(failed.success).toBe(false)
    expect(failed.message).toStartWith(
      "Failed to update video meeting timing: Daily.co API error: 500",
    )
  })

  test("a provider opening the meeting resets nbf and gets a fresh owner token", async () => {
    const { emr, room, decode } = harness()
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    const url = await emr.providerJoinUrl(
      meeting.roomId,
      PROVIDER.providerId,
      PROVIDER.providerName,
      END,
    )
    expect((await room(meeting.roomId))?.config.nbf).toBe(NOW / 1000 - 300)
    expect((await decode(extractRoomToken(url) as string)).joinable).toBe(true)
  })

  test("nbf/exp in milliseconds are tolerated and journalled as warnings", async () => {
    const { emr, admin, runtime } = harness()
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    // `generatePatientToken` passes Date.parse(end): exp arrives in milliseconds.
    const { token } = await emr.generatePatientToken(meeting.roomId, "patient-9", "Ada", END)
    expect(token.split(".")).toHaveLength(3)
    const { warnings } = (await (await admin("/warnings")).json()) as { warnings: WarningRecord[] }
    expect(warnings).toEqual([
      expect.objectContaining({
        operationId: "CreateMeetingToken",
        subject: meeting.roomId,
        field: "exp",
        value: Date.parse(END) + 4 * 3600,
      }),
    ])
    const journal = runtime.journal.list({ operationId: "CreateMeetingToken" })
    expect(journal.at(-1)?.ids?.warning).toBe("exp in milliseconds")
    // A room created with millisecond times is accepted too.
    const created = await emr.createRoom({ properties: { nbf: NOW, exp: NOW + 3_600_000 } })
    expect(created.name).toBeTruthy()
  })
})

describe("backend DailyVideoService: strict schemas and self-signed tokens", () => {
  test("createRoom passes the strict request schema and the response validates", async () => {
    const { backend, room } = harness()
    const { roomId } = await backend.createRoom(new Date(START), new Date(END))
    expect((await room(roomId))?.config).toMatchObject({
      enable_knocking: true,
      nbf: Date.parse(START) / 1000,
      exp: Date.parse(END) / 1000,
      max_participants: 3,
      enable_recording: "cloud",
    })
    const withBucket = new DailyVideoServiceConsumer(
      {
        apiKey: API_KEY,
        baseUrl: `${API}/v1`,
        domainId: DOMAIN_ID,
        transcriptionBucket: {
          name: BUCKET,
          region: "us-west-2",
          roleArn: "arn:aws:iam::1:role/daily",
        },
      },
      (r) => harness().runtime.fetch(r),
    )
    expect((await withBucket.createRoom(new Date(START), new Date(END))).roomId).toBeTruthy()
  })

  test("the mock verifies the backend's self-signed HS256 tokens (GET /v1/meeting-tokens/:token)", async () => {
    const { backend, runtime, decode } = harness()
    const { roomId } = await backend.createRoom(new Date(START), new Date(END))
    const owner = backend.createSelfSignedProviderToken(
      roomId,
      "Dr Hopper",
      "prac-1",
      new Date(END),
    )
    const validate = (token: string, key = API_KEY, query = "") =>
      runtime.fetch(
        new Request(`${API}/v1/meeting-tokens/${token}${query}`, {
          headers: { authorization: `Bearer ${key}` },
        }),
      )
    const ok = await validate(owner)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({
      room_name: roomId,
      domain_id: DOMAIN_ID,
      is_owner: true,
      user_name: "Dr Hopper",
      eject_at_token_exp: false,
      auto_start_transcription: true,
      start_cloud_recording: true,
      enable_recording_ui: true,
    })
    expect((await validate(owner, "another-key")).status).toBe(400)
    const inspected = await decode(owner)
    expect(inspected).toMatchObject({ signatureValid: true, joinable: true, warnings: [] })
    expect((await decode(owner, "wrong")).problems).toContain(
      "signature does not match any known API key",
    )

    // The member's token: nbf 5 min before the start.
    const member = backend.userAccessToken(roomId, "Ada", 42, new Date(START), new Date(END))
    expect((await validate(member)).status).toBe(400)
    expect((await validate(member, API_KEY, "?ignoreNbf=true")).status).toBe(200)
    runtime.clock.set(Date.parse(START) - 4 * 60_000)
    expect((await validate(member)).status).toBe(200)
    // Consumer finding: the backend's room nbf is the exact start, while its member token
    // allows 5 min early, so an early member is still held by the room window.
    expect((await decode(member)).problems).toEqual([
      "room not yet open (room nbf is in the future)",
    ])
    runtime.clock.set(Date.parse(START) + 60_000)
    expect((await decode(member)).joinable).toBe(true)
    runtime.clock.set(Date.parse(END) + 1_000)
    expect((await validate(member)).status).toBe(400)
  })

  test("a token with the wrong domain, an unknown claim, or a long user id is flagged", async () => {
    const { decode } = harness()
    const { signHs256 } = await import("./test/consumer.js")
    const odd = signHs256(
      { r: "nope", d: "other-domain", iat: NOW / 1000, ud: "x".repeat(40), zz: 1 },
      API_KEY,
    )
    const inspected = await decode(odd)
    expect(inspected.signatureValid).toBe(true)
    expect(inspected.warnings).toEqual(
      expect.arrayContaining([
        "unknown claim zz",
        `domain id other-domain is not this domain (${DOMAIN_ID})`,
      ]),
    )
    expect(inspected.problems).toEqual(
      expect.arrayContaining([
        "user id (ud) is longer than 36 characters",
        "room nope does not exist",
      ]),
    )
    expect((await decode("not-a-jwt")).decodable).toBe(false)
  })

  test("presence and eject answer the strict schemas our backend validates", async () => {
    const { backend, admin } = harness()
    const { roomId } = await backend.createRoom(new Date(START), new Date(END))
    backend.storeRoomProviderMapping(roomId, "prac-1")
    expect(await backend.checkRoomPresence(roomId, 42)).toEqual({
      isOwnerPresent: false,
      isUserPresent: false,
    })
    const presence = await admin(
      `/rooms/${roomId}/presence`,
      {
        participants: [
          { userId: backend.uuidFor("provider", "prac-1"), userName: "Dr Hopper" },
          { userId: backend.uuidFor("user", 42), userName: "Ada" },
        ],
      },
      "PUT",
    )
    expect(presence.status).toBe(200)
    expect(await backend.checkRoomPresence(roomId, 42)).toEqual({
      isOwnerPresent: true,
      isUserPresent: true,
    })
    const ejected = await backend.ejectUsersFromRoom(roomId, [42])
    expect(ejected.ejectedIds).toHaveLength(1)
    expect(await backend.checkRoomPresence(roomId, 42)).toEqual({
      isOwnerPresent: true,
      isUserPresent: false,
    })
  })
})

describe("webhooks and transcripts", () => {
  const mappings = (roomName: string) => [
    {
      roomName,
      appointmentId: "appt-1",
      role: "provider" as const,
      fhirResourceId: "Practitioner/prac-1",
    },
    { roomName, appointmentId: "appt-1", role: "member" as const, fhirResourceId: "Patient/pat-1" },
  ]

  test("a session writes {room}/{session}.json to S3 (SigV4) and fires transcription.stopped", async () => {
    const { emr, admin, runtime, s3, deliveries } = harness()
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    const transcript = [
      { s: "prac-1", t: "How are you feeling today?", ts: 0.5, te: 2.1 },
      { s: "pat-1", t: "Much better, thanks.", ts: 2.4, te: 3.9 },
    ]
    const response = await admin(`/rooms/${meeting.roomId}/session`, {
      participants: [{ userId: "prac-1" }, { userId: "pat-1" }],
      durationSec: 1_200,
      transcript,
      sessionId: "sess-001",
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessionId: "sess-001",
      s3Key: `${meeting.roomId}/sess-001.json`,
      transcript: `s3://${BUCKET}/${meeting.roomId}/sess-001.json`,
      events: ["transcription.stopped", "recording.ready-to-download"],
    })
    expect(s3.rejected).toEqual([])
    expect(readTranscript((b, k) => s3.get(b, k), BUCKET, meeting.roomId, "sess-001")).toEqual(
      transcript,
    )

    await runtime.webhooks.idle()
    const receiver = new DailyWebhookReceiver(WEBHOOK_SECRET, mappings(meeting.roomId))
    const outcomes = deliveries.map((d) => receiver.receive(d.raw, d.headers))
    expect(outcomes).toEqual([
      { status: 200, body: { acknowledged: true } },
      { status: 200, body: { acknowledged: true } },
    ])
    expect(receiver.jobs).toEqual([
      {
        appointmentId: "appt-1",
        roomName: meeting.roomId,
        sessionId: "sess-001",
        practitionerId: "prac-1",
        patientId: "pat-1",
        callDurationSeconds: 1_200,
      },
    ])
    const event = JSON.parse(deliveries[0]?.raw.toString() as string) as DailyWebhook
    expect(event).toMatchObject({
      event: "transcription.stopped",
      type: "transcription.stopped",
      version: "1.0.0",
      payload: {
        room_name: meeting.roomId,
        session_id: "sess-001",
        s3_key: `${meeting.roomId}/sess-001.json`,
      },
    })
    // Our scheme: hex HMAC-SHA256 over the raw body, checked independently here.
    expect(deliveries[0]?.headers.get("x-webhook-signature")).toBe(
      createHmac("sha256", WEBHOOK_SECRET)
        .update(deliveries[0]?.raw as Buffer)
        .digest("hex"),
    )
    // The mock keeps no transcript text, and the journal holds no bodies.
    expect(JSON.stringify(runtime.instance().rooms())).not.toContain("feeling")
    expect(JSON.stringify(runtime.journal.list())).not.toContain("feeling")
  })

  test("a wrong secret is rejected; a short call is skipped; no transcript → a synthetic one", async () => {
    const { emr, admin, runtime, s3, deliveries } = harness()
    const meeting = await emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER })
    const result = (await (
      await admin(`/rooms/${meeting.roomId}/session`, {
        participants: [{ userId: "prac-1" }, { userId: "pat-1" }],
        durationSec: 45,
        recording: false,
      })
    ).json()) as { sessionId: string; events: string[] }
    expect(result.events).toEqual(["transcription.stopped"])
    const synthetic = readTranscript(
      (b, k) => s3.get(b, k),
      BUCKET,
      meeting.roomId,
      result.sessionId,
    )
    expect(synthetic.map((e) => e.s)).toEqual(["prac-1", "pat-1"])
    await runtime.webhooks.idle()
    const delivery = deliveries[0] as { raw: Buffer; headers: Headers }
    expect(
      new DailyWebhookReceiver("other-secret").receive(delivery.raw, delivery.headers),
    ).toEqual({
      status: 401,
      body: { error: "Invalid signature" },
    })
    expect(
      new DailyWebhookReceiver(WEBHOOK_SECRET, mappings(meeting.roomId)).receive(
        delivery.raw,
        delivery.headers,
      ),
    ).toEqual({ status: 200, body: { acknowledged: true, skipped: "duration-below-threshold" } })
  })

  test("an S3 that rejects the signature makes the admin session a 502", async () => {
    const s3 = new FakeS3({ accessKeyId: "S3RVER", secretAccessKey: "different" })
    const runtime = createRuntime({
      transcripts: { endpoint: "http://s3.local:4569", bucket: BUCKET, fetch: s3.fetch },
    })
    const created = (await (
      await runtime.fetch(
        new Request(`${API}/v1/rooms`, {
          method: "POST",
          headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ privacy: "private" }),
        }),
      )
    ).json()) as { name: string }
    const response = await runtime.fetch(
      new Request(`${API}/__admin/rooms/${created.name}/session`, {
        method: "POST",
        body: JSON.stringify({ participants: [{ userId: "a" }], durationSec: 90 }),
      }),
    )
    expect(response.status).toBe(502)
    expect(s3.rejected).toEqual(["signature does not match"])
  })
})

describe("contract", () => {
  test("auth: a bearer key is required; apiKeys restricts it; namespaces by API key", async () => {
    const { runtime, admin } = harness()
    const noAuth = await runtime.fetch(new Request(`${API}/v1/rooms/x`))
    expect(noAuth.status).toBe(401)
    expect(await noAuth.json()).toEqual({
      error: "authentication-error",
      info: "authorization header missing",
    })
    await admin("/credentials", { credentials: { "worker-key": "w1" } }, "PUT")
    const worker = new DailyEmrConsumer(
      { apiKey: "worker-key", baseUrl: `${API}/v1`, roomBaseUrl: ROOM_BASE },
      (r) => runtime.fetch(r),
    )
    await worker.createRoom({ privacy: "private", properties: {} })
    expect(runtime.instance("w1").rooms()).toHaveLength(1)
    expect(runtime.instance().rooms()).toHaveLength(0)
    await admin("/settings", { apiKeys: [API_KEY] }, "PUT")
    const denied = await runtime.fetch(
      new Request(`${API}/v1/rooms`, {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(denied.status).toBe(401)
    const settings = (await (await admin("/settings")).json()) as Settings
    expect(JSON.stringify(settings)).not.toContain(API_KEY)
  })

  test("Daily-style validation: unknown room properties and duplicate names are 400", async () => {
    const { emr } = harness()
    await expect(emr.createRoom({ properties: { not_a_property: true } })).rejects.toThrow(
      "Daily.co API error: 400",
    )
    await emr.createRoom({ name: "fixed-name" })
    await expect(emr.createRoom({ name: "fixed-name" })).rejects.toThrow(
      "a room named fixed-name already exists",
    )
  })

  test("server_error surfaces in the EMR's error text (booking then proceeds without video)", async () => {
    const { emr, runtime } = harness()
    runtime.applyPreset("server_error", "default", { count: 1 })
    await expect(
      emr.addVideoMeetingToAppointment({ start: START, end: END, ...PROVIDER }),
    ).rejects.toThrow(/^Daily\.co API error: 500 /)
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(DAILY_PRESETS)).toEqual(
      expect.arrayContaining([
        "room_not_found",
        "unauthorized",
        "rate_limited",
        "server_error",
        "webhook_duplicate",
        "webhook_reorder",
        "webhook_drop",
      ]),
    )
  })
})
