/**
 * The service contract, the test controls the request asks for, and where AWS IoT Core's MQTT
 * broker departs from the MQTT 5 specification
 * (https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html).
 */
import { describe, expect, test } from "bun:test"
import { MqttClient as Client, type MqttClient } from "mqtt"
import {
  AWS_IOT_PRESETS,
  type CustomAuthorizerEvent,
  createRuntime,
  type PolicyDocument,
  ReasonCode,
  type SettingsPatch,
} from "./src/index.js"
import {
  type AwsIotServer,
  type AwsIotServerOptions,
  connectStream,
  createServer,
} from "./src/server.js"
import {
  type AuthCallback,
  connackOf,
  connect,
  event,
  type IotHttpConfig,
  inbox,
  publishBytes,
  refusalCode,
} from "./test/consumer.js"

const T0 = Date.parse("2026-01-01T00:00:00.000Z")
const KEY = { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" }
const text = (value: string) => new TextEncoder().encode(value)

type Harness = {
  server: AwsIotServer
  http: IotHttpConfig
  open(clientId: string, auth?: AuthCallback, url?: string): Promise<MqttClient>
  admin(method: string, path: string, body?: unknown): Promise<Response>
}

const withServer = async (
  options: AwsIotServerOptions,
  run: (harness: Harness) => Promise<void>,
): Promise<void> => {
  const server = await createServer(options)
  const clients: MqttClient[] = []
  const admin: Harness["admin"] = (method, path, body) =>
    fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  try {
    await admin("POST", "/clock", { freeze: true, set: T0 })
    await run({
      server,
      http: { endpoint: server.url, region: "us-east-1", credentials: KEY },
      admin,
      open: async (clientId, auth = () => ({}), url = server.mqttUrl) => {
        const client = await connect(url, clientId, auth)
        clients.push(client)
        return client
      },
    })
  } finally {
    for (const client of clients) client.end(true)
    await server.close()
  }
}

const refusal = (attempt: Promise<unknown>): Promise<number | undefined> =>
  attempt.then(() => undefined, refusalCode)

const disconnectReason = async (client: MqttClient): Promise<number | undefined> =>
  ((await event(client, "disconnect")) as [{ reasonCode?: number }])[0].reasonCode

describe("contract", () => {
  test("health names the service and where MQTT is served", async () => {
    await withServer({}, async ({ server, admin }) => {
      expect(await (await admin("GET", "/health")).json()).toMatchObject({
        status: "ok",
        service: "aws-iot",
        mqtt: server.mqttUrl,
        websocket: server.wsUrl,
      })
      expect(server.wsUrl).toBe(`${server.url.replace("http", "ws")}/mqtt`)
    })
  })

  test("namespaces isolate HTTP and MQTT, by header, path prefix, access key and username", async () => {
    await withServer({}, async ({ server, http, admin, open }) => {
      await admin("PUT", "/credentials", {
        credentials: { "tenant-b-key": "b", "tenant-b-user": "b" },
      })
      const ws = server.url.replace("http", "ws")
      const inDefault = await open("device")
      const inA = await open("device", () => ({}), `${ws}/__admin/ns/a/mqtt`)
      // The username's query string names the authorizer; the mapping is by the name before it.
      const inB = await open("device", () => ({
        username: "tenant-b-user?x-amz-customauthorizer-name=fixture",
      }))
      for (const client of [inDefault, inA, inB]) await client.subscribeAsync("shared", { qos: 1 })

      expect((await publishBytes(http, "shared", text('{"type":"default"}'))).status).toBe(200)
      expect(
        (
          await publishBytes(
            { ...http, endpoint: `${server.url}/__admin/ns/a` },
            "shared",
            text('{"type":"a"}'),
          )
        ).status,
      ).toBe(200)
      const tenantB = { ...http, credentials: { ...KEY, accessKeyId: "tenant-b-key" } }
      expect((await publishBytes(tenantB, "shared", text('{"type":"b"}'))).status).toBe(200)
      const viaHeader = {
        ...http,
        fetch: (request: Request) => {
          const headers = new Headers(request.headers)
          headers.set("x-mockingbird-namespace", "a")
          return fetch(new Request(request, { headers }))
        },
      }
      expect((await publishBytes(viaHeader, "shared", text('{"type":"a-header"}'))).status).toBe(
        200,
      )

      await Promise.all([
        inbox(inDefault).received(1),
        inbox(inA).received(2),
        inbox(inB).received(1),
      ])
      const types = (client: MqttClient) => inbox(client).messages.map((each) => each.envelope.type)
      expect(types(inDefault)).toEqual(["default"])
      expect(types(inA)).toEqual(["a", "a-header"])
      expect(types(inB)).toEqual(["b"])
      expect([inDefault, inA, inB].every((client) => client.connected)).toBe(true)
    })
  })

  test("the journal and the publish log keep metadata, never payloads", async () => {
    await withServer({}, async ({ http, admin }) => {
      await publishBytes(http, "user/example", text('{"type":"secret-marker"}'))
      const journal = await (await admin("GET", "/requests")).text()
      expect(journal).toContain('"operationId":"Publish"')
      expect(journal).not.toContain("secret-marker")
      const log = await (await admin("GET", "/publishes")).json()
      expect(log).toEqual({
        total: 1,
        publishes: [
          {
            sequence: 1,
            topic: "user/example",
            qos: 1,
            bytes: 24,
            source: "http",
            clientId: null,
            matched: 0,
            at: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
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
        expect.arrayContaining(Object.keys(AWS_IOT_PRESETS)),
      )
      expect(Object.keys(AWS_IOT_PRESETS).sort()).toEqual([
        "connect_bad_credentials",
        "connect_not_authorized",
        "connect_quota_exceeded",
        "publish_internal_failure",
        "publish_throttled",
        "publish_unauthorized",
      ])
    })
  })

  for (const [preset, reasonCode] of [
    ["connect_not_authorized", ReasonCode.NotAuthorized],
    ["connect_bad_credentials", ReasonCode.BadUserNameOrPassword],
    ["connect_quota_exceeded", ReasonCode.QuotaExceeded],
  ] as const) {
    test(`${preset}: the next CONNECT is refused with 0x${reasonCode.toString(16)}`, async () => {
      await withServer({}, async ({ server, admin, open }) => {
        expect((await admin("POST", "/faults", { preset, count: 2 })).status).toBe(201)
        expect(await refusal(connect(server.mqttUrl, "device"))).toBe(reasonCode)
        expect(await refusal(connect(server.wsUrl, "device"))).toBe(reasonCode)
        expect((await open("device")).connected).toBe(true)
      })
    })
  }

  for (const [preset, status, type, message] of [
    ["publish_throttled", 429, "ThrottlingException", "The rate exceeds the limit."],
    [
      "publish_unauthorized",
      401,
      "UnauthorizedException",
      "You are not authorized to perform this operation.",
    ],
    [
      "publish_internal_failure",
      500,
      "InternalFailureException",
      "An unexpected error has occurred.",
    ],
  ] as const) {
    test(`${preset}: Publish answers ${status} ${type} and delivers nothing`, async () => {
      await withServer({}, async ({ http, admin, open }) => {
        const subscriber = await open("subscriber")
        await subscriber.subscribeAsync("t", { qos: 1 })
        await admin("POST", "/faults", { preset, count: 1 })
        expect(await publishBytes(http, "t", text('{"type":"lost"}'))).toEqual({
          ok: false,
          status,
          errorType: type,
          body: { message, traceId: expect.any(String) },
        })
        expect((await publishBytes(http, "t", text('{"type":"kept"}'))).status).toBe(200)
        await inbox(subscriber).received(1)
        expect(inbox(subscriber).messages.map((each) => each.envelope.type)).toEqual(["kept"])
      })
    })
  }
})

describe("test controls", () => {
  test("malformed bytes can be injected, the transport cut and restored, a client disconnected", async () => {
    await withServer({}, async ({ admin, open }) => {
      const client = await open("device")
      await client.subscribeAsync("t", { qos: 1 })
      const raw = await admin("POST", "/inject", {
        topic: "t",
        payloadBase64: btoa(String.fromCharCode(0xff, 0xfe, 0x7b)),
      })
      expect(await raw.json()).toEqual({ matched: 1 })
      await inbox(client).received(1)
      expect(inbox(client).malformed).toBe(1)
      expect([...(inbox(client).raw[0]?.payload ?? [])]).toEqual([0xff, 0xfe, 0x7b])

      const lost = event(client, "close")
      expect(await (await admin("POST", "/transport/cut", { clientId: "device" })).json()).toEqual({
        cut: ["device"],
        dropped: 1,
      })
      await lost
      expect(await (await admin("GET", "/clients/device")).json()).toMatchObject({
        connected: false,
        subscriptions: 1,
      })
      await admin("POST", "/transport/restore", { clientId: "device" })
      const back = await open("device")
      expect(connackOf(back)?.sessionPresent).toBe(true)

      const reason = disconnectReason(back)
      await admin("POST", "/clients/device/disconnect", {
        reasonCode: ReasonCode.AdministrativeAction,
      })
      expect(await reason).toBe(ReasonCode.AdministrativeAction)
      expect(await (await admin("GET", "/subscriptions?clientId=device")).json()).toMatchObject({
        subscriptions: [{ topicFilter: "t", qos: 1 }],
      })
    })
  })

  test("settings are read, patched and validated; reset returns to the configured ones", async () => {
    const policy: PolicyDocument = {
      Statement: [{ Effect: "Allow", Action: ["iot:*"], Resource: ["*"] }],
    }
    const configured: SettingsPatch = { credentials: [KEY] }
    await withServer({ settings: configured }, async ({ http, admin }) => {
      expect(await (await admin("GET", "/settings")).json()).toEqual({
        region: "us-east-1",
        accountId: "123456789012",
        credentials: [KEY],
        authorizers: [],
        persistentSessionExpirySeconds: 3600,
      })
      const patched = await admin("PUT", "/settings", {
        credentials: [{ accessKeyId: "rotated", secretAccessKey: "rotated-secret" }],
        authorizers: [{ username: "u", password: "p", policyDocuments: [JSON.stringify(policy)] }],
        persistentSessionExpirySeconds: 604_800,
      })
      expect(await patched.json()).toMatchObject({
        credentials: [{ accessKeyId: "rotated" }],
        authorizers: [{ username: "u", password: "p", policyDocuments: [policy] }],
        persistentSessionExpirySeconds: 604_800,
      })
      expect((await publishBytes(http, "t", text("{}"))).status).toBe(403)
      for (const body of [
        [],
        { persistentSessionExpirySeconds: 604_801 },
        { credentials: [{ accessKeyId: "k" }] },
        {
          authorizers: [{ username: "u", policyDocuments: [{ Statement: [{ Effect: "Allow" }] }] }],
        },
        {
          authorizers: [
            {
              username: "u",
              policyDocuments: [
                { Statement: [{ Effect: "Allow", Action: "iot:*", Resource: "*", Condition: {} }] },
              ],
            },
          ],
        },
      ]) {
        const refused = await admin("PUT", "/settings", body)
        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ error: { type: "mockingbird_admin" } })
      }
      await admin("POST", "/reset")
      expect(await (await admin("GET", "/settings")).json()).toMatchObject({ credentials: [KEY] })
      expect((await publishBytes(http, "t", text("{}"))).status).toBe(200)
    })
  })

  test("reset drops clients and sessions; a checkpoint restores sessions and drops live sockets", async () => {
    await withServer({}, async ({ server, admin, open }) => {
      const client = await open("device")
      await client.subscribeAsync("kept", { qos: 1 })
      const snapshot = server.runtime.snapshot()
      await client.subscribeAsync("later", { qos: 1 })
      const dropped = event(client, "close")
      server.runtime.restore(snapshot)
      await dropped
      expect(await (await admin("GET", "/clients/device")).json()).toMatchObject({
        connected: false,
        topics: [{ topicFilter: "kept" }],
      })
      const resumed = await open("device")
      expect(connackOf(resumed)?.sessionPresent).toBe(true)
      const reset = event(resumed, "close")
      await admin("POST", "/reset")
      await reset
      expect(await (await admin("GET", "/clients")).json()).toEqual({ clients: [] })
    })
  })

  test("without credentials or authorizers configured, any signed request and any client is accepted", async () => {
    await withServer({}, async ({ server, http, open }) => {
      const client = await open("anyone", () => ({ username: "whoever", password: "whatever" }))
      await client.subscribeAsync("#", { qos: 1 })
      const unverified = { ...http, credentials: { accessKeyId: "any", secretAccessKey: "any" } }
      expect((await publishBytes(unverified, "t", text('{"type":"x"}'))).status).toBe(200)
      await inbox(client).received(1)
      // Unsigned is still refused.
      const unsigned = await fetch(`${server.url}/topics/t`, { method: "POST", body: "{}" })
      expect(unsigned.status).toBe(403)
    })
  })
})

describe("custom authorizer function", () => {
  const allowEverything: PolicyDocument = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "iot:*", Resource: "*" }],
  }

  test("it receives the Lambda event and its answer decides the connection", async () => {
    const events: CustomAuthorizerEvent[] = []
    const options: AwsIotServerOptions = {
      authorizer: async (event) => {
        events.push(event)
        const password = atob(event.protocolData.mqtt.password ?? "")
        if (password === "throw") throw new Error("lambda crashed")
        return {
          isAuthenticated: password === "let-me-in",
          principalId: "principal1",
          // As a Lambda function returns them: JSON strings.
          policyDocuments: [
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: "iot:Connect",
                  Resource: "arn:aws:iot:us-east-1:123456789012:client/device-*",
                },
                {
                  Effect: "Allow",
                  Action: ["iot:Subscribe", "iot:Receive", "iot:Publish"],
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: AWS's policy variable syntax
                  Resource: "arn:aws:iot:us-east-1:123456789012:topic*/devices/${iot:ClientId}/*",
                },
              ],
            }),
          ],
          disconnectAfterInSeconds: 86_400,
          refreshAfterInSeconds: 300,
        }
      },
    }
    await withServer(options, async ({ server, open }) => {
      const good: AuthCallback = () => ({
        username: "user?x-amz-customauthorizer-name=fixture-authorizer",
        password: "let-me-in",
      })
      const client = await open("device-1", good)
      expect(events[0]).toEqual({
        protocols: ["mqtt"],
        protocolData: {
          mqtt: { username: "user", password: btoa("let-me-in"), clientId: "device-1" },
        },
        connectionMetadata: { id: expect.any(String) },
      })
      const overWebSocket = await open("device-2", good, server.wsUrl)
      expect(events[1]?.protocols).toEqual(["http", "mqtt"])
      expect(overWebSocket.connected).toBe(true)

      await client.subscribeAsync("devices/device-1/inbox", { qos: 1 })
      expect(await refusal(client.subscribeAsync("devices/device-2/inbox", { qos: 1 }))).toBe(
        ReasonCode.NotAuthorized,
      )
      await client.publishAsync("devices/device-1/inbox", '{"type":"own"}', { qos: 1 })
      await inbox(client).received(1)

      const attempt = (clientId: string, password: string) =>
        refusal(connect(server.mqttUrl, clientId, () => ({ username: "user", password })))
      // isAuthenticated: false; a failing function; a client id iot:Connect does not cover.
      expect(await attempt("device-3", "wrong")).toBe(ReasonCode.NotAuthorized)
      expect(await attempt("device-3", "throw")).toBe(ReasonCode.NotAuthorized)
      expect(await attempt("laptop-1", "let-me-in")).toBe(ReasonCode.NotAuthorized)
    })
  })

  test("a policy the emulator cannot evaluate refuses the connection", async () => {
    const options: AwsIotServerOptions = {
      authorizer: () => ({
        isAuthenticated: true,
        policyDocuments: [
          {
            Statement: [
              {
                Effect: "Allow",
                Action: "iot:*",
                Resource: "*",
                Condition: { Bool: { "aws:SecureTransport": "true" } },
              } as never,
            ],
          },
        ],
      }),
    }
    await withServer(options, async ({ server }) => {
      expect(await refusal(connect(server.mqttUrl, "device"))).toBe(ReasonCode.NotAuthorized)
    })
    await withServer(
      { authorizer: () => ({ isAuthenticated: true, policyDocuments: [allowEverything] }) },
      async ({ open }) => {
        expect((await open("device")).connected).toBe(true)
      },
    )
  })
})

describe("AWS IoT Core MQTT differences", () => {
  test("a QoS 2 subscription gets no SUBACK", async () => {
    await withServer({}, async ({ admin, open }) => {
      const client = await open("device")
      let acknowledged = false
      client.subscribe("t", { qos: 2 }, () => {
        acknowledged = true
      })
      // A QoS 1 subscription sent afterwards is acknowledged; the QoS 2 one never was.
      await client.subscribeAsync("u", { qos: 1 })
      expect(acknowledged).toBe(false)
      expect(await (await admin("GET", "/subscriptions")).json()).toMatchObject({
        subscriptions: [{ topicFilter: "u" }],
      })
    })
  })

  test("a/# does not match a, topic limits and reserved topics are refused", async () => {
    await withServer({}, async ({ http, open }) => {
      const client = await open("device")
      await client.subscribeAsync("sensor/#", { qos: 1 })
      expect((await publishBytes(http, "sensor", text('{"type":"parent"}'))).status).toBe(200)
      expect((await publishBytes(http, "sensor/", text('{"type":"empty-level"}'))).status).toBe(200)
      expect((await publishBytes(http, "sensor/a/b", text('{"type":"deep"}'))).status).toBe(200)
      await inbox(client).received(2)
      expect(inbox(client).messages.map((each) => each.envelope.type)).toEqual([
        "empty-level",
        "deep",
      ])

      // 7 forward slashes at most, 256 bytes at most, nothing beginning with `$`.
      expect(await refusal(client.subscribeAsync("1/2/3/4/5/6/7/8/9", { qos: 1 }))).toBe(
        ReasonCode.TopicFilterInvalid,
      )
      await client.subscribeAsync("1/2/3/4/5/6/7/8", { qos: 1 })
      expect(await refusal(client.subscribeAsync(`a/${"x".repeat(255)}`, { qos: 1 }))).toBe(
        ReasonCode.TopicFilterInvalid,
      )
      expect(await refusal(client.subscribeAsync("$aws/things/+/shadow/#", { qos: 1 }))).toBe(
        ReasonCode.TopicFilterInvalid,
      )
      expect(await refusal(client.publishAsync("1/2/3/4/5/6/7/8/9", "x", { qos: 1 }))).toBe(
        ReasonCode.TopicNameInvalid,
      )
      expect(await refusal(client.publishAsync("$aws/rules/x", "x", { qos: 1 }))).toBe(
        ReasonCode.TopicNameInvalid,
      )
      expect(client.connected).toBe(true)
    })
  })

  test("a client id over 128 bytes is refused; a payload over 128 KB disconnects", async () => {
    await withServer({}, async ({ server, open }) => {
      expect(await refusal(connect(server.mqttUrl, "x".repeat(129)))).toBe(
        ReasonCode.ClientIdentifierNotValid,
      )
      expect((await open("x".repeat(128))).connected).toBe(true)
      const subscriber = await open("subscriber")
      await subscriber.subscribeAsync("big", { qos: 1 })
      const client = await open("device")
      await client.publishAsync("big", Buffer.alloc(128 * 1024), { qos: 1 })
      await inbox(subscriber).received(1)
      expect(inbox(subscriber).raw[0]?.payload).toHaveLength(128 * 1024)
      const reason = disconnectReason(client)
      client.publish("big", Buffer.alloc(128 * 1024 + 1), { qos: 1 })
      expect(await reason).toBe(ReasonCode.PacketTooLarge)
    })
  })

  test("persistent sessions keep QoS 1 only, up to the account's expiry quota", async () => {
    const settings: SettingsPatch = { persistentSessionExpirySeconds: 604_800 }
    await withServer({ settings }, async ({ server, http, admin }) => {
      const client = await connect(server.mqttUrl, "device", () => ({}), {
        properties: { sessionExpiryInterval: 0xffffffff },
      })
      // "AWS IoT Core supports a maximum of 7 days": even "never expire" is adjusted.
      expect(connackOf(client)?.properties?.sessionExpiryInterval).toBe(604_800)
      await client.subscribeAsync({ "q1/#": { qos: 1 }, "q0/#": { qos: 0 } })
      const lost = event(client, "close")
      await admin("POST", "/transport/cut", { clientId: "device" })
      await lost
      await publishBytes(http, "q1/a", text('{"type":"kept"}'))
      await publishBytes(http, "q0/a", text('{"type":"dropped"}'))
      await publishBytes(http, "q1/b", text('{"type":"qos0-publish"}'), { qos: "0" })
      expect(await (await admin("GET", "/clients/device")).json()).toMatchObject({ queued: 1 })

      await admin("POST", "/clock", { advance: "604799s" })
      expect(await (await admin("GET", "/clients/device")).json()).toMatchObject({ queued: 1 })
      await admin("POST", "/clock", { advance: "1s" })
      expect(await (await admin("GET", "/clients")).json()).toEqual({ clients: [] })
    })
  })
})

test("a runtime serves Publish and MQTT in process, with no listener", async () => {
  const runtime = createRuntime()
  try {
    const client = new Client(() => connectStream(runtime), {
      protocolVersion: 5,
      clientId: "in-process",
      reconnectPeriod: 0,
    })
    const delivered = new Promise<string>((resolve) => {
      client.on("message", (topic, payload) => resolve(`${topic}:${payload.toString()}`))
    })
    await new Promise<void>((resolve) => client.once("connect", () => resolve()))
    await client.subscribeAsync("user/example", { qos: 1 })
    const http: IotHttpConfig = {
      endpoint: "https://example-ats.iot.us-east-1.amazonaws.com",
      region: "us-east-1",
      credentials: KEY,
      fetch: (request) => runtime.fetch(request),
    }
    expect((await publishBytes(http, "user/example", text("over-fetch"))).status).toBe(200)
    expect(await delivered).toBe("user/example:over-fetch")
    client.end(true)
  } finally {
    runtime.stop()
  }
})
