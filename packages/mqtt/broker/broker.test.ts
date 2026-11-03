import { describe, expect, test } from "bun:test"
import { bootSqlite } from "@crvouga/mockingbird-service"
import {
  Broker,
  type BrokerPolicy,
  type ConnectDecision,
  type Connection,
  type ConnectPacket,
  encodePacket,
  type Packet,
  PacketReader,
  type Properties,
  type PublishPacket,
  type QoS,
  ReasonCode,
  routeConnection,
  type Transport,
} from "./src/index.js"

const text = (value: string) => new TextEncoder().encode(value)
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** A permissive policy; each test overrides what it is about. */
const policy = (overrides: Partial<BrokerPolicy> = {}): BrokerPolicy => ({
  authenticate: () => ({ ok: true }),
  authorize: () => true,
  denyAction: () => "ignore",
  assignClientId: (token) => `auto-${token}`,
  sessionExpiry: (requested) => requested,
  connackProperties: () => ({ topicAliasMaximum: 4, receiveMaximum: 32 }),
  maxInflight: 32,
  queue: { storeQos0: false },
  pubackNoMatchingSubscribers: ReasonCode.NoMatchingSubscribers,
  qos2Subscribe: "downgrade",
  multiLevelWildcardMatchesParent: true,
  connectionExpiredReason: ReasonCode.NotAuthorized,
  ...overrides,
})

const setup = (overrides: Partial<BrokerPolicy> = {}, namespace = "test") => {
  let now = 1_700_000_000_000
  const broker = new Broker({
    sqlite: bootSqlite(),
    namespace,
    now: () => now,
    policy: policy(overrides),
  })
  return {
    broker,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** The packet shape carrying `T` as its type (several types share one shape). */
type PacketOf<T extends Packet["type"], P = Packet> = P extends Packet
  ? T extends P["type"]
    ? P
    : never
  : never

/** A client that speaks raw packets through the broker's own codec. */
class TestClient {
  readonly received: Packet[] = []
  /** How the broker ended the transport, if it did. */
  ended: "open" | "closed" | "destroyed" = "open"
  private readonly reader = new PacketReader()
  private readonly connection: Connection
  private nextId = 1

  constructor(attach: (transport: Transport) => Connection) {
    this.connection = attach({
      send: (bytes) => {
        this.received.push(...this.reader.push(bytes).packets)
      },
      close: () => {
        this.ended = "closed"
      },
      destroy: () => {
        this.ended = "destroyed"
      },
    })
  }

  static on(broker: Broker): TestClient {
    return new TestClient((transport) => broker.connect(transport))
  }

  send(packet: Packet): void {
    this.connection.receive(encodePacket(packet))
  }
  raw(bytes: Uint8Array): void {
    this.connection.receive(bytes)
  }
  /** The network under the client fails. */
  drop(): void {
    this.connection.closed()
  }
  take<T extends Packet["type"]>(type: T): PacketOf<T> {
    const index = this.received.findIndex((packet) => packet.type === type)
    if (index < 0) throw new Error(`no ${type} among ${this.received.map((p) => p.type)}`)
    return this.received.splice(index, 1)[0] as PacketOf<T>
  }
  publishes(): PublishPacket[] {
    const found = this.received.filter((p): p is PublishPacket => p.type === "publish")
    for (const each of found) this.received.splice(this.received.indexOf(each), 1)
    return found
  }
  connect(clientId: string, fields: Partial<ConnectPacket> = {}) {
    this.send({
      type: "connect",
      protocolName: "MQTT",
      protocolVersion: 5,
      cleanStart: false,
      keepAlive: 60,
      properties: {},
      clientId,
      ...fields,
    })
    return this.take("connack")
  }
  subscribe(topicFilter: string, qos: QoS = 1, properties: Properties = {}) {
    this.send({
      type: "subscribe",
      packetId: this.nextId++,
      properties,
      subscriptions: [
        { topicFilter, qos, noLocal: false, retainAsPublished: false, retainHandling: 0 },
      ],
    })
    return this.take("suback")
  }
  /** Send a PUBLISH without waiting for what the broker answers. */
  emit(topic: string, payload: string, qos: QoS = 1, properties: Properties = {}): void {
    const packetId = this.nextId++
    this.send({
      type: "publish",
      topic,
      payload: text(payload),
      qos,
      retain: false,
      dup: false,
      ...(qos > 0 ? { packetId } : {}),
      properties,
    })
  }
  publish(topic: string, payload: string, qos: QoS = 1, properties: Properties = {}) {
    this.emit(topic, payload, qos, properties)
    return qos === 1 ? this.take("puback") : undefined
  }
  ack(packet: PublishPacket): void {
    this.send({ type: "puback", packetId: packet.packetId ?? 0, reasonCode: 0, properties: {} })
  }
}

describe("connect", () => {
  test("CONNACK says what the broker supports, and a new session is not present", () => {
    const { broker } = setup()
    const connack = TestClient.on(broker).connect("a")
    expect(connack).toEqual({
      type: "connack",
      sessionPresent: false,
      reasonCode: 0,
      properties: {
        topicAliasMaximum: 4,
        receiveMaximum: 32,
        maximumQoS: 1,
        retainAvailable: 0,
        sharedSubscriptionAvailable: 0,
      },
    })
    expect(broker.clients()).toMatchObject([
      { clientId: "a", connected: true, transport: "memory" },
    ])
  })

  test("an empty client identifier is assigned one", () => {
    const { broker } = setup()
    const connack = TestClient.on(broker).connect("")
    expect(connack.properties.assignedClientIdentifier).toMatch(/^auto-.{16}$/)
    expect(broker.clients()[0]?.clientId).toBe(
      connack.properties.assignedClientIdentifier as string,
    )
  })

  test("a refused CONNECT gets the policy's reason code and no session", () => {
    const { broker } = setup({
      authenticate: () => ({ ok: false, reasonCode: ReasonCode.BadUserNameOrPassword }),
    })
    const client = TestClient.on(broker)
    expect(client.connect("a")).toMatchObject({ reasonCode: 0x86, sessionPresent: false })
    expect(client.ended).toBe("closed")
    expect(broker.clients()).toEqual([])
    expect(broker.connections).toBe(0)
  })

  test("packets sent while an asynchronous policy decides are handled after the CONNACK", async () => {
    let decide: (decision: ConnectDecision) => void = () => {}
    const { broker } = setup({
      authenticate: () =>
        new Promise<ConnectDecision>((resolve) => {
          decide = resolve
        }),
    })
    const client = TestClient.on(broker)
    client.send({
      type: "connect",
      protocolName: "MQTT",
      protocolVersion: 5,
      cleanStart: true,
      keepAlive: 0,
      properties: {},
      clientId: "a",
    })
    client.send({
      type: "subscribe",
      packetId: 1,
      properties: {},
      subscriptions: [
        { topicFilter: "t", qos: 1, noLocal: false, retainAsPublished: false, retainHandling: 0 },
      ],
    })
    expect(client.received).toEqual([])
    decide({ ok: true })
    await Promise.resolve()
    expect(client.received.map((packet) => packet.type)).toEqual(["connack", "suback"])
  })

  test("MQTT 3.1.1 is refused with the CONNACK that protocol defines", () => {
    const { broker } = setup()
    const sent: Uint8Array[] = []
    let ended = false
    const connection = broker.connect({
      send: (bytes) => sent.push(bytes),
      close: () => {
        ended = true
      },
      destroy: () => {},
    })
    connection.receive(
      Uint8Array.of(
        0x10,
        0x0d,
        0x00,
        0x04,
        0x4d,
        0x51,
        0x54,
        0x54,
        0x04,
        0x02,
        0x00,
        0x3c,
        0x00,
        0x01,
        0x61,
      ),
    )
    // MQTT 3.1.1 section 3.2.2.3: return code 1, unacceptable protocol version.
    expect(sent).toEqual([Uint8Array.of(0x20, 0x02, 0x00, 0x01)])
    expect(ended).toBe(true)
  })

  test("a first packet that is not CONNECT, and a second CONNECT, end the connection", () => {
    const { broker } = setup()
    const early = TestClient.on(broker)
    early.send({ type: "pingreq" })
    expect(early.ended).toBe("destroyed")

    const twice = TestClient.on(broker)
    twice.connect("a")
    twice.send({
      type: "connect",
      protocolName: "MQTT",
      protocolVersion: 5,
      cleanStart: true,
      keepAlive: 0,
      properties: {},
      clientId: "a",
    })
    expect(twice.take("disconnect").reasonCode).toBe(ReasonCode.ProtocolError)
  })

  test("a malformed packet disconnects with its reason code", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("a")
    client.raw(Uint8Array.of(0x80, 0x02, 0x00, 0x01))
    expect(client.take("disconnect").reasonCode).toBe(ReasonCode.MalformedPacket)
    expect(client.ended).toBe("closed")
  })
})

describe("publish and subscribe", () => {
  test("QoS 1 reaches the matching subscription only, byte for byte", () => {
    const { broker } = setup()
    const subscriber = TestClient.on(broker)
    subscriber.connect("sub")
    expect(subscriber.subscribe("room/1").reasonCodes).toEqual([1])
    const other = TestClient.on(broker)
    other.connect("other")
    other.subscribe("room/2")
    const publisher = TestClient.on(broker)
    publisher.connect("pub")
    const payload = Uint8Array.of(0x00, 0xff, 0x7b, 0x22)
    publisher.send({
      type: "publish",
      topic: "room/1",
      payload,
      qos: 1,
      retain: false,
      dup: false,
      packetId: 7,
      properties: { contentType: "application/json", userProperties: [["k", "v"]] },
    })
    expect(publisher.take("puback")).toMatchObject({ packetId: 7, reasonCode: 0 })
    const [delivered] = subscriber.publishes()
    expect(delivered).toMatchObject({
      topic: "room/1",
      qos: 1,
      retain: false,
      dup: false,
      properties: { contentType: "application/json", userProperties: [["k", "v"]] },
    })
    expect(delivered?.payload).toEqual(payload)
    expect(other.publishes()).toEqual([])
  })

  test("a publish nobody subscribes to is acknowledged with the policy's reason code", () => {
    const { broker } = setup()
    const publisher = TestClient.on(broker)
    publisher.connect("pub")
    expect(publisher.publish("nobody", "x")?.reasonCode).toBe(ReasonCode.NoMatchingSubscribers)
  })

  test("wildcards, the $ rule and the parent-level option", () => {
    const { broker } = setup()
    const subscriber = TestClient.on(broker)
    subscriber.connect("sub")
    subscriber.subscribe("a/+/c")
    subscriber.subscribe("b/#")
    subscriber.subscribe("#")
    expect(broker.publish({ topic: "a/x/c", payload: text("1"), qos: 0 })).toBe(1)
    expect(broker.publish({ topic: "b", payload: text("2"), qos: 0 })).toBe(1)
    // 4.7.2: `#` does not match a topic beginning with `$`.
    expect(broker.publish({ topic: "$SYS/x", payload: text("3"), qos: 0 })).toBe(0)
    expect(subscriber.publishes().map((p) => read(p.payload))).toEqual(["1", "2"])

    const strict = setup({ multiLevelWildcardMatchesParent: false })
    const second = TestClient.on(strict.broker)
    second.connect("sub")
    second.subscribe("b/#")
    expect(strict.broker.publish({ topic: "b", payload: text("x"), qos: 0 })).toBe(0)
    expect(strict.broker.publish({ topic: "b/", payload: text("x"), qos: 0 })).toBe(1)
  })

  test("overlapping subscriptions deliver one copy at the highest granted QoS", () => {
    const { broker } = setup()
    const subscriber = TestClient.on(broker)
    subscriber.connect("sub")
    subscriber.subscribe("a/#", 0, { subscriptionIdentifiers: [5] })
    subscriber.subscribe("a/b", 1, { subscriptionIdentifiers: [9] })
    broker.publish({ topic: "a/b", payload: text("x"), qos: 1 })
    const delivered = subscriber.publishes()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      qos: 1,
      properties: { subscriptionIdentifiers: [5, 9] },
    })
  })

  test("No Local keeps a client's own publishes from coming back", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("a")
    client.send({
      type: "subscribe",
      packetId: 1,
      properties: {},
      subscriptions: [
        { topicFilter: "t", qos: 1, noLocal: true, retainAsPublished: false, retainHandling: 0 },
      ],
    })
    client.take("suback")
    expect(client.publish("t", "x")?.reasonCode).toBe(ReasonCode.NoMatchingSubscribers)
    expect(client.publishes()).toEqual([])
  })

  test("unsubscribe stops deliveries and reports a filter that was never subscribed", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("a")
    client.subscribe("t")
    client.send({ type: "unsubscribe", packetId: 9, properties: {}, topicFilters: ["t", "u"] })
    expect(client.take("unsuback").reasonCodes).toEqual([0, ReasonCode.NoSubscriptionExisted])
    expect(broker.publish({ topic: "t", payload: text("x"), qos: 1 })).toBe(0)
    expect(client.publishes()).toEqual([])
  })

  test("QoS 2 and RETAIN are refused the way the CONNACK announced", () => {
    const { broker } = setup()
    const subscriber = TestClient.on(broker)
    subscriber.connect("sub")
    // 3.2.2.3.4: a server that supports only QoS 1 still accepts a QoS 2 request and grants 1.
    expect(subscriber.subscribe("t", 2).reasonCodes).toEqual([1])

    const second = TestClient.on(broker)
    second.connect("q2")
    second.emit("t", "x", 2)
    expect(second.take("disconnect").reasonCode).toBe(ReasonCode.QoSNotSupported)

    const third = TestClient.on(broker)
    third.connect("retain")
    third.send({
      type: "publish",
      topic: "t",
      payload: text("x"),
      qos: 0,
      retain: true,
      dup: false,
      properties: {},
    })
    expect(third.take("disconnect").reasonCode).toBe(ReasonCode.RetainNotSupported)
    expect(subscriber.publishes()).toEqual([])
  })

  test("a policy that ignores QoS 2 subscriptions sends no SUBACK", () => {
    const { broker } = setup({ qos2Subscribe: "ignore" })
    const client = TestClient.on(broker)
    client.connect("a")
    client.send({
      type: "subscribe",
      packetId: 1,
      properties: {},
      subscriptions: [
        { topicFilter: "t", qos: 2, noLocal: false, retainAsPublished: false, retainHandling: 0 },
      ],
    })
    expect(client.received).toEqual([])
    expect(broker.subscriptionList()).toEqual([])
  })

  test("invalid, shared and vendor-rejected filters get their SUBACK codes", () => {
    const { broker } = setup({
      checkTopicFilter: (filter) =>
        filter.startsWith("$") ? ReasonCode.TopicFilterInvalid : undefined,
      checkTopicName: (topic) => (topic.startsWith("$") ? ReasonCode.TopicNameInvalid : undefined),
    })
    const client = TestClient.on(broker)
    client.connect("a")
    client.send({
      type: "subscribe",
      packetId: 1,
      properties: {},
      subscriptions: ["a/#/b", "$share/g/t", "$reserved", "ok"].map((topicFilter) => ({
        topicFilter,
        qos: 1 as const,
        noLocal: false,
        retainAsPublished: false,
        retainHandling: 0,
      })),
    })
    expect(client.take("suback").reasonCodes).toEqual([
      ReasonCode.TopicFilterInvalid,
      ReasonCode.SharedSubscriptionsNotSupported,
      ReasonCode.TopicFilterInvalid,
      1,
    ])
    expect(client.publish("$reserved", "x")?.reasonCode).toBe(ReasonCode.TopicNameInvalid)
    // A wildcard in a Topic Name is a protocol violation, not a vendor limit (4.7.1).
    client.publish("a/+", "x", 0)
    expect(client.take("disconnect").reasonCode).toBe(ReasonCode.TopicNameInvalid)
  })

  test("authorization: denied operations are answered or disconnect, as the policy says", () => {
    let action: "ignore" | "disconnect" = "ignore"
    const { broker } = setup({
      authorize: ({ action: kind, topic, principal }) =>
        kind === "receive" ? principal !== "deaf" : topic.startsWith("ok"),
      authenticate: ({ clientId }) => ({ ok: true, principal: clientId }),
      denyAction: () => action,
    })
    const client = TestClient.on(broker)
    client.connect("a")
    expect(client.subscribe("secret").reasonCodes).toEqual([ReasonCode.NotAuthorized])
    expect(client.subscribe("ok/1").reasonCodes).toEqual([1])
    expect(client.publish("secret", "x")?.reasonCode).toBe(ReasonCode.NotAuthorized)
    client.publish("secret", "x", 0)
    expect(client.received).toEqual([])
    expect(broker.publishLog()).toEqual([])

    // A subscriber not allowed to receive is skipped silently.
    const deaf = TestClient.on(broker)
    deaf.connect("deaf")
    deaf.subscribe("ok/1")
    expect(broker.publish({ topic: "ok/1", payload: text("x"), qos: 1 })).toBe(1)
    expect(deaf.publishes()).toEqual([])
    expect(client.publishes()).toHaveLength(1)

    action = "disconnect"
    client.emit("secret", "x")
    expect(client.take("disconnect").reasonCode).toBe(ReasonCode.NotAuthorized)
  })

  test("topic aliases map to the topic they were set with", () => {
    const { broker } = setup()
    const subscriber = TestClient.on(broker)
    subscriber.connect("sub")
    subscriber.subscribe("t")
    const publisher = TestClient.on(broker)
    publisher.connect("pub")
    publisher.publish("t", "first", 0, { topicAlias: 1 })
    publisher.publish("", "second", 0, { topicAlias: 1 })
    expect(subscriber.publishes().map((p) => [p.topic, read(p.payload)])).toEqual([
      ["t", "first"],
      ["t", "second"],
    ])
    publisher.publish("t", "x", 0, { topicAlias: 5 })
    expect(publisher.take("disconnect").reasonCode).toBe(ReasonCode.TopicAliasInvalid)
  })

  test("a payload above the vendor limit disconnects", () => {
    const { broker } = setup({ maxPayloadBytes: 4 })
    const client = TestClient.on(broker)
    client.connect("a")
    client.publish("t", "12345", 0)
    expect(client.take("disconnect").reasonCode).toBe(ReasonCode.PacketTooLarge)
  })
})

describe("sessions", () => {
  const persistent = { properties: { sessionExpiryInterval: 600 } }

  test("a lost transport keeps subscriptions and queues QoS 1; the same id drains it", () => {
    const { broker, advance } = setup()
    const first = TestClient.on(broker)
    first.connect("dev", persistent)
    first.subscribe("t")
    first.drop()
    expect(broker.clients()).toMatchObject([
      { clientId: "dev", connected: false, subscriptions: 1, queued: 0 },
    ])
    expect(broker.publish({ topic: "t", payload: text("one"), qos: 1 })).toBe(1)
    expect(broker.publish({ topic: "t", payload: text("zero"), qos: 0 })).toBe(1)
    expect(broker.publish({ topic: "t", payload: text("two"), qos: 1 })).toBe(1)
    expect(broker.clients()[0]).toMatchObject({ queued: 2 })

    advance(599_000)
    const second = TestClient.on(broker)
    expect(second.connect("dev", persistent)).toMatchObject({ sessionPresent: true })
    const drained = second.publishes()
    expect(drained.map((p) => read(p.payload))).toEqual(["one", "two"])
    for (const each of drained) second.ack(each)
    expect(broker.clients()[0]).toMatchObject({ connected: true, queued: 0, inflight: 0 })
  })

  test("after the expiry interval the session, its subscriptions and its queue are gone", () => {
    const { broker, advance } = setup()
    const first = TestClient.on(broker)
    first.connect("dev", persistent)
    first.subscribe("t")
    first.drop()
    broker.publish({ topic: "t", payload: text("lost"), qos: 1 })
    advance(600_000)
    expect(broker.clients()).toEqual([])
    expect(broker.subscriptionList()).toEqual([])
    const second = TestClient.on(broker)
    expect(second.connect("dev", persistent)).toMatchObject({ sessionPresent: false })
    expect(second.publishes()).toEqual([])
    expect(broker.publish({ topic: "t", payload: text("x"), qos: 1 })).toBe(0)
  })

  test("without a Session Expiry Interval the session ends with the connection", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("dev")
    client.subscribe("t")
    client.drop()
    expect(broker.clients()).toEqual([])
    expect(TestClient.on(broker).connect("dev")).toMatchObject({ sessionPresent: false })
  })

  test("a message sent but never acknowledged is resent with DUP on resume", () => {
    const { broker } = setup()
    const first = TestClient.on(broker)
    first.connect("dev", persistent)
    first.subscribe("t")
    broker.publish({ topic: "t", payload: text("x"), qos: 1 })
    const [sent] = first.publishes()
    expect(sent).toMatchObject({ dup: false })
    first.drop()
    const second = TestClient.on(broker)
    second.connect("dev", persistent)
    const [again] = second.publishes()
    expect(again).toMatchObject({ dup: true, packetId: sent?.packetId })
    second.ack(again as PublishPacket)
    expect(broker.clients()[0]).toMatchObject({ inflight: 0 })
  })

  test("Clean Start discards the stored session", () => {
    const { broker } = setup()
    const first = TestClient.on(broker)
    first.connect("dev", persistent)
    first.subscribe("t")
    first.drop()
    broker.publish({ topic: "t", payload: text("x"), qos: 1 })
    const second = TestClient.on(broker)
    expect(second.connect("dev", { ...persistent, cleanStart: true })).toMatchObject({
      sessionPresent: false,
    })
    expect(second.publishes()).toEqual([])
    expect(broker.subscriptionList()).toEqual([])
  })

  test("a second connection with the same client identifier takes the session over", () => {
    const { broker } = setup()
    const first = TestClient.on(broker)
    first.connect("dev", persistent)
    first.subscribe("t")
    const second = TestClient.on(broker)
    expect(second.connect("dev", persistent)).toMatchObject({ sessionPresent: true })
    expect(first.take("disconnect").reasonCode).toBe(ReasonCode.SessionTakenOver)
    expect(first.ended).toBe("closed")
    broker.publish({ topic: "t", payload: text("x"), qos: 1 })
    expect(first.publishes()).toEqual([])
    expect(second.publishes()).toHaveLength(1)
    expect(broker.clients()).toHaveLength(1)
    // The old transport closing afterwards must not end the session the new one holds.
    first.drop()
    expect(broker.clients()).toMatchObject([{ connected: true }])
  })

  test("DISCONNECT can shorten the session but not create one", () => {
    const { broker } = setup()
    const kept = TestClient.on(broker)
    kept.connect("kept", persistent)
    kept.send({ type: "disconnect", reasonCode: 0, properties: { sessionExpiryInterval: 0 } })
    expect(broker.clients()).toEqual([])

    const none = TestClient.on(broker)
    none.connect("none")
    none.send({ type: "disconnect", reasonCode: 0, properties: { sessionExpiryInterval: 60 } })
    expect(none.take("disconnect").reasonCode).toBe(ReasonCode.ProtocolError)
  })

  test("the granted expiry is echoed when the policy changes it", () => {
    const { broker, advance } = setup({ sessionExpiry: (requested) => Math.min(requested, 100) })
    const client = TestClient.on(broker)
    const connack = client.connect("dev", persistent)
    expect(connack.properties.sessionExpiryInterval).toBe(100)
    client.drop()
    advance(100_000)
    expect(broker.clients()).toEqual([])
  })

  test("Receive Maximum bounds the messages in flight", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("dev", { properties: { receiveMaximum: 2 } })
    client.subscribe("t")
    for (const each of ["1", "2", "3", "4"]) {
      broker.publish({ topic: "t", payload: text(each), qos: 1 })
    }
    const first = client.publishes()
    expect(first.map((p) => read(p.payload))).toEqual(["1", "2"])
    client.ack(first[0] as PublishPacket)
    expect(client.publishes().map((p) => read(p.payload))).toEqual(["3"])
    expect(broker.clients()[0]).toMatchObject({ inflight: 2, queued: 1 })
  })

  test("the offline queue keeps QoS 0 and drops its oldest when the policy says so", () => {
    const { broker } = setup({ queue: { storeQos0: true, maxLength: 2 } })
    const first = TestClient.on(broker)
    first.connect("dev", persistent)
    first.subscribe("t")
    first.drop()
    for (const each of ["1", "2", "3"]) {
      broker.publish({ topic: "t", payload: text(each), qos: 0 })
    }
    const second = TestClient.on(broker)
    second.connect("dev", persistent)
    expect(second.publishes().map((p) => [p.qos, read(p.payload)])).toEqual([
      [0, "2"],
      [0, "3"],
    ])
  })

  test("a message larger than the client's Maximum Packet Size is discarded", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("dev", { properties: { maximumPacketSize: 20 } })
    client.subscribe("t")
    broker.publish({ topic: "t", payload: text("x".repeat(64)), qos: 1 })
    broker.publish({ topic: "t", payload: text("ok"), qos: 1 })
    expect(client.publishes().map((p) => read(p.payload))).toEqual(["ok"])
    expect(broker.clients()[0]).toMatchObject({ inflight: 1, queued: 0 })
  })
})

describe("controls", () => {
  const persistent = { properties: { sessionExpiryInterval: 600 } }

  test("kick disconnects with Administrative action and discards the session", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("dev", persistent)
    client.subscribe("t")
    expect(broker.kick("dev")).toBe(true)
    expect(client.take("disconnect").reasonCode).toBe(ReasonCode.AdministrativeAction)
    expect(broker.clients()).toEqual([])
    expect(broker.subscriptionList()).toEqual([])
    expect(broker.kick("dev")).toBe(false)
  })

  test("disconnect closes the connection and leaves the session to its expiry", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("dev", persistent)
    client.subscribe("t")
    expect(broker.disconnect("dev", ReasonCode.ServerShuttingDown)).toBe(true)
    expect(client.take("disconnect").reasonCode).toBe(ReasonCode.ServerShuttingDown)
    expect(broker.clients()).toMatchObject([{ connected: false, subscriptions: 1 }])
    expect(broker.disconnect("dev")).toBe(false)
  })

  test("a cut transport drops silently and refuses reconnects until restored", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("dev", persistent)
    client.subscribe("t")
    expect(broker.cutTransport("dev")).toBe(1)
    expect(client.ended).toBe("destroyed")
    expect(client.received).toEqual([])
    expect(broker.transportCuts()).toEqual(["dev"])
    expect(broker.clients()).toMatchObject([{ connected: false, subscriptions: 1 }])

    const blocked = TestClient.on(broker)
    blocked.send({
      type: "connect",
      protocolName: "MQTT",
      protocolVersion: 5,
      cleanStart: false,
      keepAlive: 0,
      properties: {},
      clientId: "dev",
    })
    expect(blocked.received).toEqual([])
    expect(blocked.ended).toBe("destroyed")
    // Another client is unaffected.
    expect(TestClient.on(broker).connect("other").reasonCode).toBe(0)

    broker.publish({ topic: "t", payload: text("queued"), qos: 1 })
    broker.restoreTransport("dev")
    const back = TestClient.on(broker)
    expect(back.connect("dev", persistent)).toMatchObject({ sessionPresent: true })
    expect(back.publishes().map((p) => read(p.payload))).toEqual(["queued"])

    expect(broker.cutTransport()).toBe(2)
    expect(broker.transportCuts()).toEqual(["*"])
    broker.restoreTransport()
    expect(broker.transportCuts()).toEqual([])
  })

  test("a connection whose credential expires is disconnected at the next sweep", () => {
    let expiry = 0
    const { broker, advance } = setup({
      authenticate: () => ({ ok: true, connectionExpiresAt: expiry }),
    })
    expiry = 1_700_000_000_000 + 30_000
    const client = TestClient.on(broker)
    client.connect("dev", persistent)
    advance(29_999)
    broker.sweep()
    expect(client.received).toEqual([])
    advance(1)
    broker.sweep()
    expect(client.take("disconnect").reasonCode).toBe(ReasonCode.NotAuthorized)
    expect(broker.clients()).toMatchObject([{ connected: false }])
  })

  test("dropping every connection leaves sessions, which start expiring at the next sweep", () => {
    const { broker, advance } = setup()
    const client = TestClient.on(broker)
    client.connect("dev", persistent)
    client.subscribe("t")
    broker.dropConnections()
    expect(client.ended).toBe("destroyed")
    expect(broker.connections).toBe(0)
    expect(broker.clients()).toMatchObject([{ connected: false, subscriptions: 1 }])
    advance(600_000)
    expect(broker.clients()).toEqual([])
  })

  test("the publish log keeps metadata and a running count, never payloads", () => {
    const { broker } = setup()
    const client = TestClient.on(broker)
    client.connect("pub")
    client.publish("t", "secret-payload")
    broker.publish({ topic: "u", payload: text("abc"), qos: 0 }, "http")
    expect(broker.publishLog()).toEqual([
      {
        sequence: 1,
        topic: "t",
        qos: 1,
        bytes: 14,
        source: "mqtt",
        clientId: "pub",
        matched: 0,
        at: "2023-11-14T22:13:20.000Z",
      },
      {
        sequence: 2,
        topic: "u",
        qos: 0,
        bytes: 3,
        source: "http",
        clientId: null,
        matched: 0,
        at: "2023-11-14T22:13:20.000Z",
      },
    ])
    expect(broker.publishCount()).toBe(2)
    expect(JSON.stringify(broker.publishLog())).not.toContain("secret-payload")
  })

  test("brokers with different namespaces share nothing", () => {
    const sqlite = bootSqlite()
    const make = (namespace: string) =>
      new Broker({ sqlite, namespace, now: () => 0, policy: policy() })
    const one = make("one")
    const two = make("two")
    const subscriber = TestClient.on(one)
    subscriber.connect("same-id", persistent)
    subscriber.subscribe("t")
    const stranger = TestClient.on(two)
    expect(stranger.connect("same-id", persistent)).toMatchObject({ sessionPresent: false })
    expect(subscriber.received).toEqual([])
    expect(two.publish({ topic: "t", payload: text("x"), qos: 1 })).toBe(0)
    expect(one.publish({ topic: "t", payload: text("x"), qos: 1 })).toBe(1)
    expect(two.subscriptionList()).toEqual([])
  })

  test("routeConnection attaches a transport to the broker its CONNECT selects", () => {
    const sqlite = bootSqlite()
    const brokers = new Map(
      ["one", "two"].map((namespace) => [
        namespace,
        new Broker({ sqlite, namespace, now: () => 0, policy: policy() }),
      ]),
    )
    const connect = (username: string) => {
      const client = new TestClient((transport) =>
        routeConnection(transport, (packet) => brokers.get(packet.username ?? "")),
      )
      // Deliver the CONNECT one byte at a time: selection waits for the whole packet.
      const bytes = encodePacket({
        type: "connect",
        protocolName: "MQTT",
        protocolVersion: 5,
        cleanStart: true,
        keepAlive: 0,
        properties: {},
        clientId: "c",
        username,
      })
      for (const byte of bytes) client.raw(Uint8Array.of(byte))
      return client
    }
    expect(connect("two").take("connack").reasonCode).toBe(0)
    expect(brokers.get("two")?.clients()).toHaveLength(1)
    expect(brokers.get("one")?.clients()).toHaveLength(0)
    expect(connect("nobody").ended).toBe("destroyed")
  })

  test("routeConnection drops a transport whose first packet is too large to be a CONNECT", () => {
    let selected = 0
    const feed = (chunks: Iterable<Uint8Array>) => {
      let destroyed = false
      let fed = 0
      const connection = routeConnection(
        { send: () => {}, close: () => {}, destroy: () => (destroyed = true) },
        () => {
          selected += 1
          return undefined
        },
      )
      for (const chunk of chunks) {
        if (destroyed) break
        fed += chunk.length
        connection.receive(chunk)
      }
      return { destroyed, fed }
    }
    // A CONNECT fixed header declaring a 200 MB body, then the body 64 KB at a time.
    function* huge() {
      yield Uint8Array.of(0x10, 0x80, 0x80, 0x80, 0x64)
      for (let sent = 0; sent < 8 * 1024 * 1024; sent += 65_536) yield new Uint8Array(65_536)
    }
    const { destroyed, fed } = feed(huge())
    // Dropped from the fixed header alone, nothing of the body held.
    expect(fed).toBe(5)
    expect(destroyed).toBe(true)
    expect(selected).toBe(0)

    // A large but plausible CONNECT is still read and offered to `select`.
    const connect = encodePacket({
      type: "connect",
      protocolName: "MQTT",
      protocolVersion: 5,
      cleanStart: true,
      keepAlive: 0,
      properties: {},
      clientId: "c",
      username: "u",
      password: new Uint8Array(65_535),
    })
    feed([connect])
    expect(selected).toBe(1)
  })
})
