import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  decodePacket,
  encodePacket,
  MqttProtocolError,
  type Packet,
  PacketReader,
  type Properties,
  ReasonCode,
} from "./src/index.js"

const params = fcParameters(process.env)

// 1.5.4: no null character; lone surrogates are not well-formed UTF-8.
const text = fc.string({ unit: "grapheme", maxLength: 12 }).filter((s) => !s.includes("\u0000"))
const bytes = fc.uint8Array({ maxLength: 32 })
const u16 = fc.integer({ min: 0, max: 0xffff })
const u32 = fc.integer({ min: 0, max: 0xffffffff })
const packetId = fc.integer({ min: 1, max: 0xffff })
const qos = fc.constantFrom(0 as const, 1 as const, 2 as const)

const properties: fc.Arbitrary<Properties> = fc.record(
  {
    payloadFormatIndicator: fc.constantFrom(0, 1),
    messageExpiryInterval: u32,
    contentType: text,
    responseTopic: text,
    correlationData: bytes,
    subscriptionIdentifiers: fc.array(fc.integer({ min: 1, max: 268_435_455 }), {
      minLength: 1,
      maxLength: 3,
    }),
    sessionExpiryInterval: u32,
    assignedClientIdentifier: text,
    serverKeepAlive: u16,
    reasonString: text,
    receiveMaximum: u16,
    topicAliasMaximum: u16,
    topicAlias: u16,
    maximumQoS: fc.constantFrom(0, 1),
    retainAvailable: fc.constantFrom(0, 1),
    userProperties: fc.array(fc.tuple(text, text), { minLength: 1, maxLength: 3 }),
    maximumPacketSize: u32,
    wildcardSubscriptionAvailable: fc.constantFrom(0, 1),
    subscriptionIdentifierAvailable: fc.constantFrom(0, 1),
    sharedSubscriptionAvailable: fc.constantFrom(0, 1),
  },
  { requiredKeys: [] },
)

const publish = fc
  .record({ topic: text, payload: bytes, qos, retain: fc.boolean(), properties, id: packetId })
  .chain(({ id, ...rest }) =>
    fc.boolean().map(
      (dup): Packet => ({
        type: "publish",
        ...rest,
        // 3.3.1.1: DUP is 0 at QoS 0, which carries no Packet Identifier either.
        dup: rest.qos === 0 ? false : dup,
        ...(rest.qos === 0 ? {} : { packetId: id }),
      }),
    ),
  )

const packet: fc.Arbitrary<Packet> = fc.oneof(
  fc
    .record({
      cleanStart: fc.boolean(),
      keepAlive: u16,
      properties,
      clientId: text,
      will: fc.option(
        fc.record({
          topic: text,
          payload: bytes,
          qos,
          retain: fc.boolean(),
          properties,
        }),
        { nil: undefined },
      ),
      username: fc.option(text, { nil: undefined }),
      password: fc.option(bytes, { nil: undefined }),
    })
    .map(
      ({ will, username, password, ...rest }): Packet => ({
        type: "connect",
        protocolName: "MQTT",
        protocolVersion: 5,
        ...rest,
        ...(will ? { will } : {}),
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
      }),
    ),
  fc
    .record({
      sessionPresent: fc.boolean(),
      reasonCode: fc.constantFrom(0, 0x86, 0x87),
      properties,
    })
    .map((fields): Packet => ({ type: "connack", ...fields })),
  publish,
  fc
    .record({
      type: fc.constantFrom(
        "puback" as const,
        "pubrec" as const,
        "pubrel" as const,
        "pubcomp" as const,
      ),
      packetId,
      reasonCode: fc.constantFrom(0, 0x10, 0x87),
      properties,
    })
    .map((fields): Packet => fields),
  fc
    .record({
      packetId,
      properties,
      subscriptions: fc.array(
        fc.record({
          topicFilter: text,
          qos,
          noLocal: fc.boolean(),
          retainAsPublished: fc.boolean(),
          retainHandling: fc.constantFrom(0, 1, 2),
        }),
        { minLength: 1, maxLength: 4 },
      ),
    })
    .map((fields): Packet => ({ type: "subscribe", ...fields })),
  fc
    .record({
      type: fc.constantFrom("suback" as const, "unsuback" as const),
      packetId,
      properties,
      reasonCodes: fc.array(fc.constantFrom(0, 1, 0x11, 0x87), { minLength: 1, maxLength: 4 }),
    })
    .map((fields): Packet => fields),
  fc
    .record({ packetId, properties, topicFilters: fc.array(text, { minLength: 1, maxLength: 4 }) })
    .map((fields): Packet => ({ type: "unsubscribe", ...fields })),
  fc.constantFrom<Packet>({ type: "pingreq" }, { type: "pingresp" }),
  fc
    .record({
      type: fc.constantFrom("disconnect" as const, "auth" as const),
      reasonCode: fc.constantFrom(0, 0x8e, 0x98),
      properties,
    })
    .map((fields): Packet => fields),
)

describe("MQTT 5 codec", () => {
  test("every packet survives encode then decode", () => {
    fc.assert(
      fc.property(packet, (original) => {
        expect(decodePacket(encodePacket(original))).toEqual(original)
      }),
      params,
    )
  })

  test("a stream cut anywhere reassembles into the same packets", () => {
    fc.assert(
      fc.property(
        fc.array(packet, { minLength: 1, maxLength: 5 }),
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 }),
        (packets, sizes) => {
          const stream = packets.map(encodePacket)
          const joined = new Uint8Array(stream.reduce((sum, each) => sum + each.length, 0))
          let offset = 0
          for (const each of stream) {
            joined.set(each, offset)
            offset += each.length
          }
          const reader = new PacketReader()
          const out: Packet[] = []
          let position = 0
          for (let index = 0; position < joined.length; index++) {
            const size = sizes[index % sizes.length] as number
            const result = reader.push(joined.subarray(position, position + size))
            expect(result.error).toBeUndefined()
            out.push(...result.packets)
            position += size
          }
          expect(out).toEqual(packets)
        },
      ),
      params,
    )
  })

  test("a large packet in many small chunks is reassembled in linear time", () => {
    // 16 MB in 1 KB chunks. Re-copying everything buffered on each chunk copies ~128 GB here
    // and takes many seconds; copying each byte once takes milliseconds.
    const payload = new Uint8Array(16 * 1024 * 1024).map((_, index) => index & 0xff)
    const wire = encodePacket({
      type: "publish",
      topic: "big",
      payload,
      qos: 0,
      retain: false,
      dup: false,
      properties: {},
    })
    const reader = new PacketReader()
    const packets: Packet[] = []
    const started = performance.now()
    for (let offset = 0; offset < wire.length; offset += 1024) {
      packets.push(...reader.push(wire.subarray(offset, offset + 1024)).packets)
    }
    const elapsed = performance.now() - started
    expect(packets).toHaveLength(1)
    const [packet] = packets
    expect(packet?.type === "publish" && packet.payload).toEqual(payload)
    expect(elapsed).toBeLessThan(1000)
  })

  test("arbitrary bytes never throw anything but a protocol error", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (noise) => {
        try {
          decodePacket(noise)
        } catch (error) {
          expect(error).toBeInstanceOf(MqttProtocolError)
        }
        const { error } = new PacketReader().push(noise)
        if (error) expect(error).toBeInstanceOf(MqttProtocolError)
      }),
      params,
    )
  })

  // The bytes below are written out from the specification's packet layouts (sections 3.1 to
  // 3.14), so the codec is checked against the wire format and not only against itself.
  test("CONNECT wire bytes", () => {
    const connect = Uint8Array.of(
      0x10,
      0x15,
      0x00,
      0x04,
      0x4d,
      0x51,
      0x54,
      0x54, // "MQTT"
      0x05, // protocol version
      0x02, // clean start
      0x00,
      0x3c, // keep alive 60
      0x05,
      0x11,
      0x00,
      0x00,
      0x02,
      0x58, // session expiry interval 600
      0x00,
      0x03,
      0x61,
      0x62,
      0x63, // client identifier "abc"
    )
    expect(decodePacket(connect)).toEqual({
      type: "connect",
      protocolName: "MQTT",
      protocolVersion: 5,
      cleanStart: true,
      keepAlive: 60,
      properties: { sessionExpiryInterval: 600 },
      clientId: "abc",
    })
    expect(
      encodePacket({
        type: "connect",
        protocolName: "MQTT",
        protocolVersion: 5,
        cleanStart: true,
        keepAlive: 60,
        properties: { sessionExpiryInterval: 600 },
        clientId: "abc",
      }),
    ).toEqual(connect)
  })

  test("PUBLISH, PUBACK, SUBACK and DISCONNECT wire bytes", () => {
    expect(
      encodePacket({
        type: "publish",
        topic: "a/b",
        payload: Uint8Array.of(0x68, 0x69),
        qos: 1,
        retain: false,
        dup: true,
        packetId: 10,
        properties: {},
      }),
    ).toEqual(Uint8Array.of(0x3a, 0x0a, 0x00, 0x03, 0x61, 0x2f, 0x62, 0x00, 0x0a, 0x00, 0x68, 0x69))
    // 3.4.2.1: Success with no properties is just the Packet Identifier.
    expect(encodePacket({ type: "puback", packetId: 10, reasonCode: 0, properties: {} })).toEqual(
      Uint8Array.of(0x40, 0x02, 0x00, 0x0a),
    )
    expect(
      encodePacket({
        type: "puback",
        packetId: 10,
        reasonCode: ReasonCode.NotAuthorized,
        properties: {},
      }),
    ).toEqual(Uint8Array.of(0x40, 0x03, 0x00, 0x0a, 0x87))
    expect(
      encodePacket({ type: "suback", packetId: 1, properties: {}, reasonCodes: [1, 0x87] }),
    ).toEqual(Uint8Array.of(0x90, 0x05, 0x00, 0x01, 0x00, 0x01, 0x87))
    expect(
      encodePacket({
        type: "disconnect",
        reasonCode: ReasonCode.SessionTakenOver,
        properties: {},
      }),
    ).toEqual(Uint8Array.of(0xe0, 0x01, 0x8e))
    expect(decodePacket(Uint8Array.of(0xe0, 0x00))).toEqual({
      type: "disconnect",
      reasonCode: 0,
      properties: {},
    })
  })

  test("malformed and illegal packets name their reason code", () => {
    const reason = (bytes: Uint8Array) => {
      try {
        decodePacket(bytes)
      } catch (error) {
        return (error as MqttProtocolError).reasonCode
      }
      return undefined
    }
    // Reserved fixed header flags on SUBSCRIBE (2.1.3).
    expect(reason(Uint8Array.of(0x80, 0x02, 0x00, 0x01))).toBe(ReasonCode.MalformedPacket)
    // PUBLISH with both QoS bits set (3.3.1.2).
    expect(reason(Uint8Array.of(0x36, 0x04, 0x00, 0x01, 0x61, 0x00))).toBe(
      ReasonCode.MalformedPacket,
    )
    // SUBSCRIBE with no topic filter (3.8.3).
    expect(reason(Uint8Array.of(0x82, 0x03, 0x00, 0x01, 0x00))).toBe(ReasonCode.ProtocolError)
    // The same property twice (2.2.2.2).
    expect(
      reason(Uint8Array.of(0x20, 0x09, 0x00, 0x00, 0x06, 0x21, 0x00, 0x01, 0x21, 0x00, 0x02)),
    ).toBe(ReasonCode.ProtocolError)
    // A packet above the advertised Maximum Packet Size (3.2.2.3.6).
    const large = new PacketReader(8).push(Uint8Array.of(0x30, 0x10))
    expect(large.error?.reasonCode).toBe(ReasonCode.PacketTooLarge)
  })

  test("another protocol level is reported without reading the rest", () => {
    const legacy = Uint8Array.of(
      0x10,
      0x0f,
      0x00,
      0x04,
      0x4d,
      0x51,
      0x54,
      0x54,
      0x04, // MQTT 3.1.1
      0x02,
      0x00,
      0x3c,
      0x00,
      0x03,
      0x61,
      0x62,
      0x63,
    )
    expect(decodePacket(legacy)).toMatchObject({ type: "connect", protocolVersion: 4 })
  })
})
