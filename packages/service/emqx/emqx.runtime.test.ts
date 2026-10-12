/**
 * The service contract and the test controls the request asks for: health, namespaces, fault
 * presets, client and subscription inspection, raw payload injection, transport cuts, forced
 * disconnects, the virtual clock, reset and checkpoints.
 */
import { describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import {
  decodePacket,
  encodePacket,
  type Packet,
  PacketReader,
} from "@crvouga/mockingbird-mqtt-broker"
import { SignJWT } from "jose"
import { MqttClient as Client, type MqttClient } from "mqtt"
import { PLACEHOLDER } from "./src/auth.js"
import { createRuntime, EMQX_PRESETS, ReasonCode, type SettingsPatch } from "./src/index.js"
import { connectStream, createServer, type EmqxServer } from "./src/server.js"
import {
  clientOptions,
  connackOf,
  connect,
  event,
  inbox,
  type MqttCredentials,
  publishMqtt,
  refusalCode,
  subscribe,
} from "./test/consumer.js"

const BASIC = { authorization: `Basic ${btoa("fixture-api-key:fixture-api-secret")}` }
const JWT_SECRET = "fixture-jwt-signing-secret"
const T0 = Date.parse("2026-01-01T00:00:00.000Z")

type Harness = {
  server: EmqxServer
  open(clientId: string, credentials?: MqttCredentials, url?: string): Promise<MqttClient>
  admin(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>
  publish(topic: string, payload: string, headers?: Record<string, string>): Promise<Response>
}

const withServer = async (
  options: { settings?: SettingsPatch; adminPrefix?: string },
  run: (harness: Harness) => Promise<void>,
): Promise<void> => {
  const server = await createServer(options)
  const prefix = options.adminPrefix ?? "/__admin"
  const clients: MqttClient[] = []
  const admin: Harness["admin"] = (method, path, body, headers = {}) =>
    fetch(`${server.url}${prefix}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  try {
    await admin("POST", "/clock", { freeze: true, set: T0 })
    await run({
      server,
      admin,
      open: async (clientId, credentials = {}, url = server.mqttUrl) => {
        const client = await connect({ mqttUrl: url }, clientId, credentials)
        clients.push(client)
        return client
      },
      publish: (topic, payload, headers = {}) =>
        fetch(`${server.url}/api/v5/publish`, {
          method: "POST",
          headers: { ...BASIC, "content-type": "application/json", ...headers },
          body: JSON.stringify({ topic, payload, qos: 1 }),
        }),
    })
  } finally {
    for (const client of clients) client.end(true)
    await server.close()
  }
}

const refusal = (attempt: Promise<unknown>): Promise<number | undefined> =>
  attempt.then(() => undefined, refusalCode)

const token = (claims: Record<string, unknown>, ttlSeconds = 300): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(T0 / 1000 + ttlSeconds)
    .sign(new TextEncoder().encode(JWT_SECRET))

/** Ask for a WebSocket upgrade by hand and report how the server answered. */
const upgrade = (url: string, subprotocol?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(url.replace(/^ws/, "http"), {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(subprotocol !== undefined ? { "sec-websocket-protocol": subprotocol } : {}),
      },
    })
    request.on("response", (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on("upgrade", (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    request.on("error", reject)
    request.end()
  })

describe("contract", () => {
  test("health names the service and where MQTT is served", async () => {
    await withServer({}, async ({ server, admin }) => {
      const health = (await (await admin("GET", "/health")).json()) as Record<string, unknown>
      expect(health).toMatchObject({
        status: "ok",
        service: "emqx",
        mqtt: server.mqttUrl,
        websocket: server.wsUrl,
      })
      expect(server.mqttUrl).toMatch(/^mqtt:\/\/127\.0\.0\.1:\d+$/)
      expect(server.wsUrl).toBe(`${server.url.replace("http", "ws")}/mqtt`)
      expect(server.mqttPort).not.toBe(server.port)
    })
  })

  test("namespaces isolate HTTP and MQTT, by header, path prefix and credential", async () => {
    await withServer({}, async ({ server, admin, open, publish }) => {
      await admin("PUT", "/credentials", {
        credentials: { "tenant-b-key": "b", "tenant-b-user": "b" },
      })
      // The same client id and topic in three namespaces.
      const inDefault = await open("device")
      const inA = await open("device", {}, `${server.url.replace("http", "ws")}/__admin/ns/a/mqtt`)
      const inB = await open("device", { username: "tenant-b-user", password: "x" })
      for (const client of [inDefault, inA, inB]) await subscribe(client, "shared/topic")
      // Three live connections with one client id: nobody took anybody over.
      expect([inDefault, inA, inB].map((client) => client.connected)).toEqual([true, true, true])

      expect((await publish("shared/topic", '{"type":"default"}')).status).toBe(200)
      expect(
        (await publish("shared/topic", '{"type":"a"}', { "x-mockingbird-namespace": "a" })).status,
      ).toBe(200)
      const viaPath = await fetch(`${server.url}/__admin/ns/a/api/v5/publish`, {
        method: "POST",
        headers: { ...BASIC, "content-type": "application/json" },
        body: JSON.stringify({ topic: "shared/topic", payload: '{"type":"a-path"}', qos: 1 }),
      })
      expect(viaPath.status).toBe(200)
      expect(
        (
          await publish("shared/topic", '{"type":"b"}', {
            authorization: `Basic ${btoa("tenant-b-key:any")}`,
          })
        ).status,
      ).toBe(200)

      await Promise.all([
        inbox(inDefault).received(1),
        inbox(inA).received(2),
        inbox(inB).received(1),
      ])
      const types = (client: MqttClient) => inbox(client).messages.map((each) => each.envelope.type)
      expect(types(inDefault)).toEqual(["default"])
      expect(types(inA)).toEqual(["a", "a-path"])
      expect(types(inB)).toEqual(["b"])

      const clientsOf = async (namespace: string) =>
        (
          (await (await admin("GET", `/clients?namespace=${namespace}`)).json()) as {
            clients: { clientId: string; transport: string }[]
          }
        ).clients.map((each) => `${each.clientId}:${each.transport}`)
      expect(await clientsOf("default")).toEqual(["device:tcp"])
      expect(await clientsOf("a")).toEqual(["device:websocket"])
      expect(await clientsOf("b")).toEqual(["device:tcp"])
      expect(await clientsOf("c")).toEqual([])

      // Resetting one namespace drops its client and leaves the others connected.
      const dropped = event(inA, "close")
      await admin("POST", "/reset?namespace=a")
      await dropped
      expect(await clientsOf("a")).toEqual([])
      expect(inDefault.connected && inB.connected).toBe(true)
    })
  })

  test("two instances share nothing", async () => {
    await withServer({}, async (one) => {
      await withServer({}, async (two) => {
        const first = await one.open("device")
        const second = await two.open("device")
        await subscribe(first, "t")
        await subscribe(second, "t")
        expect((await one.publish("t", '{"type":"one"}')).status).toBe(200)
        await inbox(first).received(1)
        expect((await two.publish("t", '{"type":"two"}')).status).toBe(200)
        await inbox(second).received(1)
        expect(inbox(first).messages.map((each) => each.envelope.type)).toEqual(["one"])
        expect(inbox(second).messages.map((each) => each.envelope.type)).toEqual(["two"])
        expect(one.server.mqttPort).not.toBe(two.server.mqttPort)
      })
    })
  })

  test("the journal records publishes without their payloads", async () => {
    await withServer({}, async ({ admin, publish }) => {
      await publish("t", '{"type":"secret-marker"}')
      const journal = await (await admin("GET", "/requests")).text()
      expect(journal).toContain("PublishMessage")
      expect(journal).not.toContain("secret-marker")
      const log = await (await admin("GET", "/publishes")).text()
      expect(log).not.toContain("secret-marker")
    })
  })
})

describe("fault presets", () => {
  test("every preset is listed", async () => {
    await withServer({}, async ({ admin }) => {
      const { presets } = (await (await admin("GET", "/faults/presets")).json()) as {
        presets: { name: string }[]
      }
      // The emulator's own presets, beside the standard ones every emulator has.
      expect(presets.map((each) => each.name)).toEqual(
        expect.arrayContaining(Object.keys(EMQX_PRESETS)),
      )
      expect(Object.keys(EMQX_PRESETS).sort()).toEqual([
        "api_unauthorized",
        "connect_bad_credentials",
        "connect_not_authorized",
        "connect_server_unavailable",
        "publish_unavailable",
      ])
    })
  })

  for (const [preset, reasonCode] of [
    ["connect_bad_credentials", ReasonCode.BadUserNameOrPassword],
    ["connect_not_authorized", ReasonCode.NotAuthorized],
    ["connect_server_unavailable", ReasonCode.ServerUnavailable],
  ] as const) {
    test(`${preset}: the next CONNECT is refused with 0x${reasonCode.toString(16)}`, async () => {
      await withServer({}, async ({ server, admin, open }) => {
        expect((await admin("POST", "/faults", { preset, count: 1 })).status).toBe(201)
        expect(await refusal(connect({ mqttUrl: server.mqttUrl }, "device"))).toBe(reasonCode)
        // Over WebSocket too, with a rule that stays until removed.
        await admin("POST", "/faults", { preset })
        expect(await refusal(connect({ mqttUrl: server.wsUrl }, "device"))).toBe(reasonCode)
        expect(await refusal(connect({ mqttUrl: server.mqttUrl }, "device"))).toBe(reasonCode)
        await admin("DELETE", "/faults")
        expect((await open("device")).connected).toBe(true)
      })
    })
  }

  test("publish_unavailable: the REST publish answers 503 and delivers nothing", async () => {
    await withServer({}, async ({ admin, open, publish }) => {
      const client = await open("device")
      await subscribe(client, "t")
      await admin("POST", "/faults", { preset: "publish_unavailable", count: 1 })
      const failed = await publish("t", '{"type":"lost"}')
      expect(failed.status).toBe(503)
      expect(await failed.json()).toEqual({ reason_code: 131, message: "failed_to_dispatch" })
      expect((await publish("t", '{"type":"kept"}')).status).toBe(200)
      await inbox(client).received(1)
      expect(inbox(client).messages.map((each) => each.envelope.type)).toEqual(["kept"])
    })
  })

  test("api_unauthorized: every REST call answers 401", async () => {
    await withServer({}, async ({ server, admin, publish }) => {
      await admin("POST", "/faults", { preset: "api_unauthorized" })
      const refused = await publish("t", "{}")
      expect(refused.status).toBe(401)
      expect(refused.headers.get("www-authenticate")).toBe('Basic Realm="emqx-dashboard"')
      expect(await refused.json()).toEqual({
        code: "BAD_API_KEY_OR_SECRET",
        message: "Check api_key/api_secret",
      })
      const kick = await fetch(`${server.url}/api/v5/clients/x`, {
        method: "DELETE",
        headers: BASIC,
      })
      expect(kick.status).toBe(401)
    })
  })
})

describe("test controls", () => {
  test("clients, subscriptions and publish metadata can be inspected", async () => {
    await withServer({}, async ({ admin, open, publish }) => {
      const client = await open("device", { username: "alice", password: "x" })
      await subscribe(client, "a/+")
      await subscribe(client, "b")
      await publishMqtt(client, "a/1", { type: "m" })
      await publish("nobody", "abc")
      await inbox(client).received(1)

      expect(await (await admin("GET", "/clients")).json()).toEqual({
        clients: [
          {
            clientId: "device",
            username: "alice",
            connected: true,
            transport: "tcp",
            sessionExpiryInterval: 600,
            connectedAt: "2026-01-01T00:00:00.000Z",
            disconnectedAt: null,
            expiresAt: null,
            subscriptions: 2,
            queued: 0,
            inflight: expect.any(Number),
          },
        ],
      })
      expect(await (await admin("GET", "/clients/nobody")).json()).toEqual({
        error: { type: "mockingbird_admin", message: "no client nobody" },
      })
      const subscriptions = {
        clientId: "device",
        noLocal: false,
        retainAsPublished: false,
        retainHandling: 0,
      }
      expect(await (await admin("GET", "/subscriptions?clientId=device")).json()).toEqual({
        subscriptions: [
          { ...subscriptions, topicFilter: "a/+", qos: 1, subscriptionIdentifier: null },
          { ...subscriptions, topicFilter: "b", qos: 1, subscriptionIdentifier: null },
        ],
      })
      expect(await (await admin("GET", "/subscriptions?clientId=other")).json()).toEqual({
        subscriptions: [],
      })
      expect(await (await admin("GET", "/publishes")).json()).toEqual({
        total: 2,
        publishes: [
          {
            sequence: 1,
            topic: "a/1",
            qos: 1,
            bytes: 12,
            source: "mqtt",
            clientId: "device",
            matched: 1,
            at: "2026-01-01T00:00:00.000Z",
          },
          {
            sequence: 2,
            topic: "nobody",
            qos: 1,
            bytes: 3,
            source: "http",
            clientId: null,
            matched: 0,
            at: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
    })
  })

  test("inject delivers raw payloads and rejects a malformed request", async () => {
    await withServer({}, async ({ admin, open }) => {
      const client = await open("device")
      await subscribe(client, "t")
      expect(
        await (await admin("POST", "/inject", { topic: "t", payload: "<not json>" })).json(),
      ).toEqual({
        matched: 1,
      })
      expect(
        await (await admin("POST", "/inject", { topic: "nobody", payload: "x", qos: 0 })).json(),
      ).toEqual({
        matched: 0,
      })
      await inbox(client).received(1)
      expect(inbox(client).raw[0]?.payload.toString("utf8")).toBe("<not json>")
      expect(inbox(client).malformed).toBe(1)
      for (const body of [
        {},
        { topic: "t" },
        { topic: "t", payloadBase64: "***" },
        { topic: "t", payload: "x", qos: 2 },
      ]) {
        expect((await admin("POST", "/inject", body)).status).toBe(400)
      }
      expect(await (await admin("GET", "/publishes")).json()).toMatchObject({
        publishes: [{ source: "admin" }, { source: "admin" }],
      })
    })
  })

  test("the transport can be cut for every client and restored, without ending sessions", async () => {
    await withServer({}, async ({ server, admin, open, publish }) => {
      const first = await open("one")
      const second = await open("two")
      await subscribe(first, "t")
      const lost = [event(first, "close"), event(second, "close")]
      expect(await (await admin("POST", "/transport/cut")).json()).toEqual({
        cut: ["*"],
        dropped: 2,
      })
      await Promise.all(lost)
      expect(await (await admin("GET", "/transport")).json()).toEqual({ cut: ["*"] })
      // While cut, a CONNECT is dropped unanswered, as on a dead network.
      const dropped = await connect({ mqttUrl: server.mqttUrl }, "one").then(
        () => "connected",
        (error: Error) => error.message,
      )
      expect(dropped).toBe("connection closed before CONNACK")
      expect((await publish("t", '{"type":"queued"}')).status).toBe(200)
      expect(await (await admin("GET", "/clients/one")).json()).toMatchObject({
        connected: false,
        queued: 1,
      })
      expect((await admin("POST", "/transport/cut", { clientId: 7 })).status).toBe(400)

      expect(await (await admin("POST", "/transport/restore")).json()).toEqual({ cut: [] })
      const back = await open("one")
      expect(connackOf(back)?.sessionPresent).toBe(true)
      await inbox(back).received(1)
      expect(inbox(back).messages.map((each) => each.envelope.type)).toEqual(["queued"])
    })
  })

  test("a client can be disconnected with a chosen reason code, keeping its session", async () => {
    await withServer({}, async ({ admin, open }) => {
      const client = await open("device")
      await subscribe(client, "t")
      const disconnected = event(client, "disconnect")
      const response = await admin("POST", "/clients/device/disconnect", {
        reasonCode: ReasonCode.ServerShuttingDown,
      })
      expect(await response.json()).toEqual({ disconnected: "device" })
      const [packet] = (await disconnected) as [{ reasonCode?: number }]
      expect(packet.reasonCode).toBe(ReasonCode.ServerShuttingDown)
      expect(await (await admin("GET", "/clients/device")).json()).toMatchObject({
        connected: false,
        subscriptions: 1,
        expiresAt: new Date(T0 + 600_000).toISOString(),
      })
      expect((await admin("POST", "/clients/device/disconnect")).status).toBe(404)
      expect(
        (await admin("POST", "/clients/device/disconnect", { reasonCode: "now" })).status,
      ).toBe(400)
      // Without a reason code: Administrative action.
      const again = await open("device")
      const second = event(again, "disconnect")
      await admin("POST", "/clients/device/disconnect")
      expect(((await second) as [{ reasonCode?: number }])[0].reasonCode).toBe(
        ReasonCode.AdministrativeAction,
      )
    })
  })

  test("settings are read, patched, validated, and return to their configured values on reset", async () => {
    const configured: SettingsPatch = {
      apiKeys: [{ key: "fixture-api-key", secret: "fixture-api-secret" }],
    }
    await withServer({ settings: configured }, async ({ admin, publish }) => {
      expect(await (await admin("GET", "/settings")).json()).toEqual({
        apiKeys: configured.apiKeys,
        users: [],
        jwt: null,
        authorization: { noMatch: "allow", denyAction: "ignore" },
      })
      const patched = await admin("PUT", "/settings", {
        apiKeys: [{ key: "rotated", secret: "rotated-secret" }],
        users: [{ username: "service", password: "p", superuser: true }],
        jwt: { secret: JWT_SECRET, from: "username" },
        authorization: { noMatch: "deny" },
      })
      expect(await patched.json()).toEqual({
        apiKeys: [{ key: "rotated", secret: "rotated-secret" }],
        users: [{ username: "service", password: "p", superuser: true }],
        jwt: {
          secret: JWT_SECRET,
          secretBase64Encoded: false,
          from: "username",
          aclClaimName: "acl",
          verifyClaims: {},
          disconnectAfterExpire: true,
        },
        authorization: { noMatch: "deny", denyAction: "ignore" },
      })
      expect((await publish("t", "{}")).status).toBe(401)
      for (const body of [
        [],
        { apiKeys: [{ key: "k" }] },
        { users: "service" },
        { jwt: { from: "password" } },
        { jwt: { secret: "s", from: "header" } },
        { authorization: { noMatch: "maybe" } },
        { authorization: { denyAction: "explode" } },
      ]) {
        expect((await admin("PUT", "/settings", body)).status).toBe(400)
      }
      await admin("POST", "/reset")
      expect(await (await admin("GET", "/settings")).json()).toMatchObject({
        apiKeys: configured.apiKeys,
        jwt: null,
      })
      expect((await publish("t", "{}")).status).toBe(202)
    })
  })

  test("reset drops clients and sessions; a checkpoint restores sessions and drops live sockets", async () => {
    await withServer({}, async ({ server, admin, open }) => {
      const client = await open("device")
      await subscribe(client, "kept")
      const snapshot = server.runtime.snapshot()
      await subscribe(client, "later")
      expect(await (await admin("GET", "/clients/device")).json()).toMatchObject({
        subscriptions: 2,
      })

      const dropped = event(client, "close")
      server.runtime.restore(snapshot)
      await dropped
      // The restored session has no socket any more, so it is offline and its expiry runs.
      expect(await (await admin("GET", "/clients/device")).json()).toMatchObject({
        connected: false,
        subscriptions: 1,
        topics: [{ topicFilter: "kept" }],
      })
      const resumed = await open("device")
      expect(connackOf(resumed)?.sessionPresent).toBe(true)

      const reset = event(resumed, "close")
      expect((await admin("POST", "/reset")).status).toBe(200)
      await reset
      expect(await (await admin("GET", "/clients")).json()).toEqual({ clients: [] })
      expect(await (await admin("GET", "/subscriptions")).json()).toEqual({ subscriptions: [] })
      expect(connackOf(await open("device"))?.sessionPresent).toBe(false)
    })
  })

  test("a token that expires while connected ends the connection when the clock passes it", async () => {
    await withServer(
      { settings: { jwt: { secret: JWT_SECRET } } },
      async ({ admin, open, server }) => {
        const client = await open("device", { username: "jwt", password: await token({}, 300) })
        const expired = event(client, "disconnect")
        await admin("POST", "/clock", { advance: "299s" })
        expect(client.connected).toBe(true)
        await admin("POST", "/clock", { advance: "1s" })
        const [packet] = (await expired) as [{ reasonCode?: number }]
        expect(packet.reasonCode).toBe(ReasonCode.NotAuthorized)
        // The same token is now refused at CONNECT.
        expect(
          await refusal(
            connect({ mqttUrl: server.mqttUrl }, "device", {
              username: "jwt",
              password: await token({}, 300),
            }),
          ),
        ).toBe(ReasonCode.BadUserNameOrPassword)
      },
    )
  })

  test("with disconnect_after_expire off the connection stays and its ACL stops allowing", async () => {
    const settings: SettingsPatch = { jwt: { secret: JWT_SECRET, disconnectAfterExpire: false } }
    await withServer({ settings }, async ({ admin, open }) => {
      const client = await open("device", {
        username: "jwt",
        password: await token({ acl: { all: ["t/#"] } }, 300),
      })
      await subscribe(client, "t/1")
      await admin("POST", "/clock", { advance: "301s" })
      expect(client.connected).toBe(true)
      expect(await refusal(subscribe(client, "t/2"))).toBe(ReasonCode.NotAuthorized)
    })
  })

  test("deny_action = disconnect ends the connection on a denied operation", async () => {
    const settings: SettingsPatch = {
      jwt: { secret: JWT_SECRET },
      authorization: { noMatch: "deny", denyAction: "disconnect" },
    }
    await withServer({ settings }, async ({ open }) => {
      const client = await open("device", {
        username: "jwt",
        password: await token({ acl: { sub: ["allowed"] } }),
      })
      await subscribe(client, "allowed")
      const disconnected = event(client, "disconnect")
      client.subscribe("forbidden", { qos: 1 }, () => {})
      const [packet] = (await disconnected) as [{ reasonCode?: number }]
      expect(packet.reasonCode).toBe(ReasonCode.NotAuthorized)
    })
  })

  test("the list-form ACL passes undecided topics to authorization.no_match", async () => {
    const acl = [
      { permission: "deny", action: "subscribe", topic: `user/${PLACEHOLDER.clientId}/private` },
    ]
    const run = async (noMatch: "allow" | "deny") => {
      let outcome: (number | undefined)[] = []
      await withServer(
        { settings: { jwt: { secret: JWT_SECRET }, authorization: { noMatch } } },
        async ({ open }) => {
          const client = await open("device-1", { username: "jwt", password: await token({ acl }) })
          outcome = [
            await refusal(subscribe(client, "user/device-1/private")),
            await refusal(subscribe(client, "user/device-1/public")),
          ]
        },
      )
      return outcome
    }
    expect(await run("allow")).toEqual([ReasonCode.NotAuthorized, undefined])
    expect(await run("deny")).toEqual([ReasonCode.NotAuthorized, ReasonCode.NotAuthorized])
  })
})

describe("transports", () => {
  test("the WebSocket listener needs the /mqtt path and an MQTT subprotocol", async () => {
    await withServer({}, async ({ server }) => {
      expect(await upgrade(server.wsUrl, "mqtt")).toBe(101)
      expect(await upgrade(server.wsUrl, "mqtt-v5")).toBe(101)
      // `fail_if_no_subprotocol`: EMQX answers 400.
      expect(await upgrade(server.wsUrl)).toBe(400)
      expect(await upgrade(server.wsUrl, "chat")).toBe(400)
      expect(await upgrade(`${server.url.replace("http", "ws")}/elsewhere`, "mqtt")).toBe(404)
      expect(await upgrade(`${server.url.replace("http", "ws")}/__admin/ns/a/mqtt`, "mqtt")).toBe(
        101,
      )
    })
  })

  test("the WebSocket namespace path follows a custom admin prefix", async () => {
    await withServer({ adminPrefix: "/_control/mock" }, async ({ server, admin, open }) => {
      const ws = server.url.replace("http", "ws")
      const client = await open("device", {}, `${ws}/_control/mock/ns/a/mqtt`)
      await subscribe(client, "t")
      expect(await (await admin("GET", "/clients?namespace=a")).json()).toMatchObject({
        clients: [{ clientId: "device" }],
      })
      expect(await upgrade(`${ws}/__admin/ns/a/mqtt`, "mqtt")).toBe(404)
    })
  })

  test("a runtime serves MQTT in process, with no listener", async () => {
    const runtime = createRuntime()
    try {
      // Raw packets through `attach`…
      const received: Packet[] = []
      const reader = new PacketReader()
      const connection = runtime.attach({
        send: (bytes) => received.push(...reader.push(bytes).packets),
        close: () => {},
        destroy: () => {},
      })
      connection.receive(
        encodePacket({
          type: "connect",
          protocolName: "MQTT",
          protocolVersion: 5,
          cleanStart: true,
          keepAlive: 0,
          properties: {},
          clientId: "raw",
        }),
      )
      connection.receive(
        encodePacket({
          type: "subscribe",
          packetId: 1,
          properties: {},
          subscriptions: [
            {
              topicFilter: "t",
              qos: 1,
              noLocal: false,
              retainAsPublished: false,
              retainHandling: 0,
            },
          ],
        }),
      )
      // …and the consumer's client library over an in-memory stream.
      const options = clientOptions("in-process")
      const client = new Client(() => connectStream(runtime), options)
      await new Promise<void>((resolve) => client.once("connect", () => resolve()))
      await client.publishAsync("t", "over-memory", { qos: 1 })
      client.end(true)

      const response = await runtime.fetch(
        new Request("http://emqx.local/api/v5/publish", {
          method: "POST",
          headers: { ...BASIC, "content-type": "application/json" },
          body: JSON.stringify({ topic: "t", payload: "over-fetch", qos: 1 }),
        }),
      )
      expect(response.status).toBe(200)
      expect(received.map((packet) => packet.type)).toEqual([
        "connack",
        "suback",
        "publish",
        "publish",
      ])
      const payloads = received.flatMap((packet) =>
        packet.type === "publish" ? [new TextDecoder().decode(packet.payload)] : [],
      )
      expect(payloads).toEqual(["over-memory", "over-fetch"])
      expect(decodePacket(encodePacket(received[0] as Packet))).toMatchObject({
        type: "connack",
        reasonCode: 0,
        properties: { maximumPacketSize: 1_048_576, topicAliasMaximum: 65_535, receiveMaximum: 32 },
      })
    } finally {
      runtime.stop()
    }
  })
})
