import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import {
  AccessToken,
  DataPacket_Kind,
  EgressClient,
  EncodedFileOutput,
  RoomServiceClient,
  SipClient,
  TokenVerifier,
  WebhookReceiver,
} from "livekit-server-sdk"
import { createServer } from "./src/server.js"

const key = "fixture"
const secret = "fixture-secret-that-is-at-least-32-chars"
describe("livekit-server-sdk against LiveKit mock", () => {
  test("creates, lists, moderates, sends data, and emits signed lifecycle webhooks", async () => {
    const delivered: { body: string; authorization: string }[] = []
    const server = await createServer({
      keys: { [key]: secret },
      webhooks: {
        endpoints: [{ url: "https://sink.test/livekit", events: ["*"] }],
        fetch: async (request) => {
          delivered.push({
            body: await request.text(),
            authorization: request.headers.get("authorization") ?? "",
          })
          return new Response(null, { status: 204 })
        },
      },
    })
    const client = new RoomServiceClient(server.url, key, secret, { failover: false })
    try {
      const created = await client.createRoom({
        name: "consult",
        emptyTimeout: 60,
        maxParticipants: 4,
        metadata: "fixture",
      })
      expect(created).toMatchObject({
        name: "consult",
        emptyTimeout: 60,
        maxParticipants: 4,
        metadata: "fixture",
      })
      expect((await client.createRoom({ name: "consult" })).sid).toBe(created.sid)
      expect((await client.listRooms()).map((room) => room.name)).toEqual(["consult"])
      await fetch(`${server.url}/__admin/rooms/consult/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: "patient", name: "Jane", metadata: "m" }),
      })
      const participant = await client.getParticipant("consult", "patient")
      expect(participant).toMatchObject({ identity: "patient", name: "Jane", metadata: "m" })
      await client.updateParticipant("consult", "patient", {
        metadata: "updated",
        permission: { canPublish: false, canSubscribe: true, canPublishData: true },
      })
      const trackResponse = await fetch(
        `${server.url}/__admin/rooms/consult/participants/patient/tracks`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "mic", type: "AUDIO", source: "MICROPHONE" }),
        },
      )
      const track = (await trackResponse.json()) as { sid: string }
      expect((await client.mutePublishedTrack("consult", "patient", track.sid, true)).muted).toBe(
        true,
      )
      await client.sendData(
        "consult",
        new TextEncoder().encode("hello"),
        DataPacket_Kind.RELIABLE,
        { destinationIdentities: ["patient"], topic: "chat" },
      )
      const inbox = (await (
        await fetch(`${server.url}/__admin/rooms/consult/participants/patient/inbox`)
      ).json()) as { messages: { data: string; topic: string }[] }
      expect(atob(inbox.messages[0]?.data ?? "")).toBe("hello")
      expect(inbox.messages[0]?.topic).toBe("chat")
      await client.removeParticipant("consult", "patient")
      expect(await client.listParticipants("consult")).toEqual([])
      await client.deleteRoom("consult")
      expect(await client.listRooms()).toEqual([])
      await server.runtime.webhooks.idle()
      expect(delivered.map(({ body }) => JSON.parse(body).event)).toEqual([
        "room_started",
        "participant_joined",
        "track_published",
        "track_unpublished",
        "participant_left",
        "room_finished",
      ])
      const receiver = new WebhookReceiver(key, secret)
      for (const event of delivered)
        expect((await receiver.receive(event.body, event.authorization)).event).toBeString()
    } finally {
      await server.close()
    }
  })

  test("mints genuine constrained tokens and rejects expired, invalid, and insufficient grants", async () => {
    const server = await createServer({
      keys: { [key]: secret, rotated: "rotated-secret-that-is-at-least-32-chars" },
    })
    try {
      const participantToken = new AccessToken(key, secret, {
        identity: "patient",
        metadata: "fixture",
        ttl: 60,
      })
      participantToken.addGrant({
        roomJoin: true,
        room: "consult",
        canPublish: false,
        canSubscribe: true,
        canPublishData: true,
      })
      const encoded = await participantToken.toJwt()
      const claims = await new TokenVerifier(key, secret).verify(encoded)
      expect(claims).toMatchObject({
        iss: key,
        sub: "patient",
        metadata: "fixture",
        video: {
          roomJoin: true,
          room: "consult",
          canPublish: false,
          canSubscribe: true,
          canPublishData: true,
        },
      })
      const insufficient = new RoomServiceClient(server.url, undefined, undefined, {
        token: encoded,
        failover: false,
      })
      await expect(insufficient.listRooms()).rejects.toMatchObject({
        code: "unauthenticated",
        status: 401,
      })
      const wrong = new RoomServiceClient(
        server.url,
        key,
        "wrong-secret-that-is-at-least-32-chars",
        { failover: false },
      )
      await expect(wrong.listRooms()).rejects.toMatchObject({ code: "unauthenticated" })
      const expiredToken = new AccessToken(key, secret, { ttl: -1 })
      expiredToken.addGrant({ roomList: true })
      const expired = new RoomServiceClient(server.url, undefined, undefined, {
        token: await expiredToken.toJwt(),
        failover: false,
      })
      await expect(expired.listRooms()).rejects.toMatchObject({ code: "unauthenticated" })
      const rotated = new RoomServiceClient(
        server.url,
        "rotated",
        "rotated-secret-that-is-at-least-32-chars",
        { failover: false },
      )
      expect(await rotated.listRooms()).toEqual([])
    } finally {
      await server.close()
    }
  })

  test("uses the shared clock and isolates namespaces", async () => {
    const fixed = Date.now()
    const clock = createClock(() => fixed)
    const server = await createServer({ clock, keys: { [key]: secret } })
    const client = new RoomServiceClient(server.url, key, secret, { failover: false })
    try {
      await client.createRoom({ name: "clocked" })
      const room = await client.listRooms(["clocked"])
      expect(room[0]?.creationTime).toBe(BigInt(Math.floor(fixed / 1000)))
      const token = new AccessToken(key, secret, { ttl: 60 })
      token.addGrant({ roomList: true })
      const response = await fetch(`${server.url}/twirp/livekit.RoomService/ListRooms`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token.toJwt()}`,
          "content-type": "application/json",
          "x-mockingbird-namespace": "other",
        },
        body: "{}",
      })
      expect(await response.json()).toEqual({ rooms: [] })
      await client.createRoom({ name: "expires", emptyTimeout: 1 })
      clock.advance(1_001)
      expect(await client.listRooms(["expires"])).toEqual([])
    } finally {
      await server.close()
    }
  })

  test("starts and controls egress and SIP through official clients", async () => {
    const server = await createServer({ keys: { [key]: secret } })
    const rooms = new RoomServiceClient(server.url, key, secret, { failover: false })
    const egress = new EgressClient(server.url, key, secret, { failover: false })
    const sip = new SipClient(server.url, key, secret, { failover: false })
    try {
      await rooms.createRoom({ name: "voice" })
      const started = await egress.startRoomCompositeEgress(
        "voice",
        new EncodedFileOutput({ filepath: "recordings/voice.mp4" }),
      )
      expect(started).toMatchObject({ roomName: "voice", status: 0 })
      expect(await egress.listEgress()).toHaveLength(1)
      expect((await egress.stopEgress(started.egressId)).status).toBe(3)
      const call = await sip.createSipParticipant("trunk", "+15555550100", "voice", {
        participantIdentity: "caller",
      })
      expect(call).toMatchObject({ roomName: "voice", participantIdentity: "caller" })
      expect(call.sipCallId).toStartWith("SC_")
    } finally {
      await server.close()
    }
  })
})
