/**
 * MQTT 5.0 control packet codec (OASIS Standard, 7 March 2019).
 *
 * Symmetric on purpose: the broker decodes what clients send and encodes its replies, and the
 * tests drive the broker with the same functions pointed the other way. Section numbers in the
 * comments are the specification's.
 *
 * https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html
 */
import { ReasonCode } from "./reason.js"

/** A malformed packet or protocol violation, carrying the reason code a server answers with. */
export class MqttProtocolError extends Error {
  constructor(
    readonly reasonCode: number,
    message: string,
  ) {
    super(message)
    this.name = "MqttProtocolError"
  }
}

const malformed = (message: string): MqttProtocolError =>
  new MqttProtocolError(ReasonCode.MalformedPacket, message)
const protocolError = (message: string): MqttProtocolError =>
  new MqttProtocolError(ReasonCode.ProtocolError, message)

/** Properties (2.2.2.2), by the specification's names in camelCase. */
export type Properties = {
  payloadFormatIndicator?: number
  messageExpiryInterval?: number
  contentType?: string
  responseTopic?: string
  correlationData?: Uint8Array
  /** PUBLISH may carry several; SUBSCRIBE carries at most one. */
  subscriptionIdentifiers?: number[]
  sessionExpiryInterval?: number
  assignedClientIdentifier?: string
  serverKeepAlive?: number
  authenticationMethod?: string
  authenticationData?: Uint8Array
  requestProblemInformation?: number
  willDelayInterval?: number
  requestResponseInformation?: number
  responseInformation?: string
  serverReference?: string
  reasonString?: string
  receiveMaximum?: number
  topicAliasMaximum?: number
  topicAlias?: number
  maximumQoS?: number
  retainAvailable?: number
  userProperties?: [string, string][]
  maximumPacketSize?: number
  wildcardSubscriptionAvailable?: number
  subscriptionIdentifierAvailable?: number
  sharedSubscriptionAvailable?: number
}

type PropertyKind = "byte" | "u16" | "u32" | "varint" | "utf8" | "binary" | "pair"

const PROPERTY_TABLE: readonly [number, keyof Properties, PropertyKind][] = [
  [0x01, "payloadFormatIndicator", "byte"],
  [0x02, "messageExpiryInterval", "u32"],
  [0x03, "contentType", "utf8"],
  [0x08, "responseTopic", "utf8"],
  [0x09, "correlationData", "binary"],
  [0x0b, "subscriptionIdentifiers", "varint"],
  [0x11, "sessionExpiryInterval", "u32"],
  [0x12, "assignedClientIdentifier", "utf8"],
  [0x13, "serverKeepAlive", "u16"],
  [0x15, "authenticationMethod", "utf8"],
  [0x16, "authenticationData", "binary"],
  [0x17, "requestProblemInformation", "byte"],
  [0x18, "willDelayInterval", "u32"],
  [0x19, "requestResponseInformation", "byte"],
  [0x1a, "responseInformation", "utf8"],
  [0x1c, "serverReference", "utf8"],
  [0x1f, "reasonString", "utf8"],
  [0x21, "receiveMaximum", "u16"],
  [0x22, "topicAliasMaximum", "u16"],
  [0x23, "topicAlias", "u16"],
  [0x24, "maximumQoS", "byte"],
  [0x25, "retainAvailable", "byte"],
  [0x26, "userProperties", "pair"],
  [0x27, "maximumPacketSize", "u32"],
  [0x28, "wildcardSubscriptionAvailable", "byte"],
  [0x29, "subscriptionIdentifierAvailable", "byte"],
  [0x2a, "sharedSubscriptionAvailable", "byte"],
]
const PROPERTY_BY_ID = new Map(PROPERTY_TABLE.map((row) => [row[0], row]))

export type QoS = 0 | 1 | 2

export type Will = {
  topic: string
  payload: Uint8Array
  qos: QoS
  retain: boolean
  properties: Properties
}

export type SubscriptionRequest = {
  topicFilter: string
  qos: QoS
  noLocal: boolean
  retainAsPublished: boolean
  retainHandling: number
}

export type ConnectPacket = {
  type: "connect"
  protocolName: string
  protocolVersion: number
  cleanStart: boolean
  keepAlive: number
  properties: Properties
  clientId: string
  will?: Will
  username?: string
  password?: Uint8Array
}
export type ConnackPacket = {
  type: "connack"
  sessionPresent: boolean
  reasonCode: number
  properties: Properties
}
export type PublishPacket = {
  type: "publish"
  topic: string
  payload: Uint8Array
  qos: QoS
  retain: boolean
  dup: boolean
  /** Present when `qos` is 1 or 2. */
  packetId?: number
  properties: Properties
}
export type AckPacket = {
  type: "puback" | "pubrec" | "pubrel" | "pubcomp"
  packetId: number
  reasonCode: number
  properties: Properties
}
export type SubscribePacket = {
  type: "subscribe"
  packetId: number
  properties: Properties
  subscriptions: SubscriptionRequest[]
}
export type SubackPacket = {
  type: "suback" | "unsuback"
  packetId: number
  properties: Properties
  reasonCodes: number[]
}
export type UnsubscribePacket = {
  type: "unsubscribe"
  packetId: number
  properties: Properties
  topicFilters: string[]
}
export type PingPacket = { type: "pingreq" | "pingresp" }
export type DisconnectPacket = { type: "disconnect"; reasonCode: number; properties: Properties }
export type AuthPacket = { type: "auth"; reasonCode: number; properties: Properties }

export type Packet =
  | ConnectPacket
  | ConnackPacket
  | PublishPacket
  | AckPacket
  | SubscribePacket
  | SubackPacket
  | UnsubscribePacket
  | PingPacket
  | DisconnectPacket
  | AuthPacket

const TYPE_CODES: Record<Packet["type"], number> = {
  connect: 1,
  connack: 2,
  publish: 3,
  puback: 4,
  pubrec: 5,
  pubrel: 6,
  pubcomp: 7,
  subscribe: 8,
  suback: 9,
  unsubscribe: 10,
  unsuback: 11,
  pingreq: 12,
  pingresp: 13,
  disconnect: 14,
  auth: 15,
}
const TYPE_NAMES = Object.fromEntries(
  Object.entries(TYPE_CODES).map(([name, code]) => [code, name]),
) as Record<number, Packet["type"]>

/** Largest value a Variable Byte Integer holds (1.5.5). */
export const MAX_VARIABLE_BYTE_INTEGER = 268_435_455

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

// ── writing ────────────────────────────────────────────────────────────────

class Writer {
  private chunks: Uint8Array[] = []
  private size = 0

  bytes(value: Uint8Array): this {
    this.chunks.push(value)
    this.size += value.length
    return this
  }
  byte(value: number): this {
    return this.bytes(Uint8Array.of(value & 0xff))
  }
  u16(value: number): this {
    return this.bytes(Uint8Array.of((value >>> 8) & 0xff, value & 0xff))
  }
  u32(value: number): this {
    return this.bytes(
      Uint8Array.of(
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      ),
    )
  }
  varint(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > MAX_VARIABLE_BYTE_INTEGER) {
      throw new RangeError(`variable byte integer out of range: ${value}`)
    }
    const out: number[] = []
    let rest = value
    do {
      let digit = rest % 128
      rest = Math.floor(rest / 128)
      if (rest > 0) digit |= 0x80
      out.push(digit)
    } while (rest > 0)
    return this.bytes(Uint8Array.from(out))
  }
  binary(value: Uint8Array): this {
    if (value.length > 0xffff) throw new RangeError("binary data longer than 65535 bytes")
    return this.u16(value.length).bytes(value)
  }
  utf8(value: string): this {
    return this.binary(utf8Encoder.encode(value))
  }
  get length(): number {
    return this.size
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.size)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

const writeProperties = (writer: Writer, properties: Properties): void => {
  const body = new Writer()
  for (const [id, name, kind] of PROPERTY_TABLE) {
    const value = properties[name]
    if (value === undefined) continue
    if (kind === "pair") {
      for (const [key, text] of value as [string, string][]) body.byte(id).utf8(key).utf8(text)
    } else if (name === "subscriptionIdentifiers") {
      for (const each of value as number[]) body.byte(id).varint(each)
    } else if (kind === "byte") body.byte(id).byte(value as number)
    else if (kind === "u16") body.byte(id).u16(value as number)
    else if (kind === "u32") body.byte(id).u32(value as number)
    else if (kind === "utf8") body.byte(id).utf8(value as string)
    else if (kind === "binary") body.byte(id).binary(value as Uint8Array)
  }
  writer.varint(body.length).bytes(body.concat())
}

const hasProperties = (properties: Properties): boolean =>
  Object.values(properties).some(
    (value) => value !== undefined && !(Array.isArray(value) && value.length === 0),
  )

const frame = (type: Packet["type"], flags: number, body: Writer): Uint8Array =>
  new Writer()
    .byte((TYPE_CODES[type] << 4) | flags)
    .varint(body.length)
    .bytes(body.concat())
    .concat()

/** Encode one control packet, fixed header included. */
export const encodePacket = (packet: Packet): Uint8Array => {
  const body = new Writer()
  switch (packet.type) {
    case "connect": {
      body.utf8(packet.protocolName).byte(packet.protocolVersion)
      const will = packet.will
      body.byte(
        (packet.username !== undefined ? 0x80 : 0) |
          (packet.password !== undefined ? 0x40 : 0) |
          (will?.retain ? 0x20 : 0) |
          ((will?.qos ?? 0) << 3) |
          (will ? 0x04 : 0) |
          (packet.cleanStart ? 0x02 : 0),
      )
      body.u16(packet.keepAlive)
      writeProperties(body, packet.properties)
      body.utf8(packet.clientId)
      if (will) {
        writeProperties(body, will.properties)
        body.utf8(will.topic).binary(will.payload)
      }
      if (packet.username !== undefined) body.utf8(packet.username)
      if (packet.password !== undefined) body.binary(packet.password)
      return frame("connect", 0, body)
    }
    case "connack":
      body.byte(packet.sessionPresent ? 1 : 0).byte(packet.reasonCode)
      writeProperties(body, packet.properties)
      return frame("connack", 0, body)
    case "publish": {
      body.utf8(packet.topic)
      if (packet.qos > 0) body.u16(packet.packetId ?? 0)
      writeProperties(body, packet.properties)
      body.bytes(packet.payload)
      const flags = (packet.dup ? 0x08 : 0) | (packet.qos << 1) | (packet.retain ? 0x01 : 0)
      return frame("publish", flags, body)
    }
    case "puback":
    case "pubrec":
    case "pubrel":
    case "pubcomp": {
      body.u16(packet.packetId)
      // 3.4.2.1: the Reason Code and Property Length may be omitted for Success with no properties.
      if (hasProperties(packet.properties)) {
        body.byte(packet.reasonCode)
        writeProperties(body, packet.properties)
      } else if (packet.reasonCode !== ReasonCode.Success) body.byte(packet.reasonCode)
      return frame(packet.type, packet.type === "pubrel" ? 0x02 : 0, body)
    }
    case "subscribe":
      body.u16(packet.packetId)
      writeProperties(body, packet.properties)
      for (const each of packet.subscriptions) {
        body
          .utf8(each.topicFilter)
          .byte(
            each.qos |
              (each.noLocal ? 0x04 : 0) |
              (each.retainAsPublished ? 0x08 : 0) |
              ((each.retainHandling & 0x03) << 4),
          )
      }
      return frame("subscribe", 0x02, body)
    case "suback":
    case "unsuback":
      body.u16(packet.packetId)
      writeProperties(body, packet.properties)
      body.bytes(Uint8Array.from(packet.reasonCodes))
      return frame(packet.type, 0, body)
    case "unsubscribe":
      body.u16(packet.packetId)
      writeProperties(body, packet.properties)
      for (const filter of packet.topicFilters) body.utf8(filter)
      return frame("unsubscribe", 0x02, body)
    case "pingreq":
    case "pingresp":
      return frame(packet.type, 0, body)
    case "disconnect":
    case "auth":
      // 3.14.2.1: both may be omitted for Normal disconnection with no properties.
      if (hasProperties(packet.properties)) {
        body.byte(packet.reasonCode)
        writeProperties(body, packet.properties)
      } else if (packet.reasonCode !== ReasonCode.Success) body.byte(packet.reasonCode)
      return frame(packet.type, 0, body)
  }
}

/**
 * The MQTT 3.1.1 CONNACK that refuses a protocol level this broker does not speak
 * (return code 0x01, "unacceptable protocol version"): a 3.x client cannot parse a v5 CONNACK.
 */
export const LEGACY_UNSUPPORTED_VERSION_CONNACK: Uint8Array = Uint8Array.of(0x20, 0x02, 0x00, 0x01)

// ── reading ────────────────────────────────────────────────────────────────

class Reader {
  private offset = 0
  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset
  }
  private take(length: number): Uint8Array {
    if (length > this.remaining) throw malformed("packet is shorter than its fields")
    const slice = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }
  byte(): number {
    return this.take(1)[0] as number
  }
  u16(): number {
    const bytes = this.take(2)
    return ((bytes[0] as number) << 8) | (bytes[1] as number)
  }
  u32(): number {
    const bytes = this.take(4)
    return (
      (bytes[0] as number) * 0x1000000 +
      (((bytes[1] as number) << 16) | ((bytes[2] as number) << 8) | (bytes[3] as number))
    )
  }
  varint(): number {
    let value = 0
    let multiplier = 1
    for (let index = 0; index < 4; index++) {
      const digit = this.byte()
      value += (digit & 0x7f) * multiplier
      if ((digit & 0x80) === 0) return value
      multiplier *= 128
    }
    throw malformed("variable byte integer longer than four bytes")
  }
  binary(): Uint8Array {
    return this.take(this.u16()).slice()
  }
  utf8(): string {
    let text: string
    try {
      text = utf8Decoder.decode(this.take(this.u16()))
    } catch {
      throw malformed("string is not well-formed UTF-8")
    }
    // 1.5.4: a UTF-8 Encoded String must not include the null character.
    if (text.includes("\u0000")) throw malformed("string contains U+0000")
    return text
  }
  rest(): Uint8Array {
    return this.take(this.remaining).slice()
  }
  sub(length: number): Reader {
    return new Reader(this.take(length))
  }
}

const readProperties = (reader: Reader): Properties => {
  const scope = reader.sub(reader.varint())
  const properties: Properties = {}
  while (scope.remaining > 0) {
    const id = scope.varint()
    const row = PROPERTY_BY_ID.get(id)
    if (!row) throw malformed(`unknown property 0x${id.toString(16)}`)
    const [, name, kind] = row
    if (kind === "pair") {
      const list = properties.userProperties ?? []
      list.push([scope.utf8(), scope.utf8()])
      properties.userProperties = list
      continue
    }
    if (name === "subscriptionIdentifiers") {
      const list = properties.subscriptionIdentifiers ?? []
      const value = scope.varint()
      // 3.8.2.1.2: a Subscription Identifier of 0 is a Protocol Error.
      if (value === 0) throw protocolError("subscription identifier 0")
      list.push(value)
      properties.subscriptionIdentifiers = list
      continue
    }
    // 2.2.2.2: including any other property more than once is a Protocol Error.
    if (properties[name] !== undefined) throw protocolError(`duplicate property ${name}`)
    const value =
      kind === "byte"
        ? scope.byte()
        : kind === "u16"
          ? scope.u16()
          : kind === "u32"
            ? scope.u32()
            : kind === "utf8"
              ? scope.utf8()
              : scope.binary()
    ;(properties as Record<string, unknown>)[name] = value
  }
  return properties
}

const requireFlags = (type: string, flags: number, expected: number): void => {
  // 2.1.3: a reserved flag with any other value is a Malformed Packet.
  if (flags !== expected) throw malformed(`${type} fixed header flags must be ${expected}`)
}

const decodeBody = (type: Packet["type"], flags: number, body: Reader): Packet => {
  switch (type) {
    case "connect": {
      requireFlags(type, flags, 0)
      const protocolName = body.utf8()
      const protocolVersion = body.byte()
      // 3.1.2.1 / 3.1.2.2: the rest is only defined for the protocol this codec speaks. The
      // caller refuses any other name or level, so nothing after the level is read.
      if (protocolName !== "MQTT" || protocolVersion !== 5) {
        return {
          type,
          protocolName,
          protocolVersion,
          cleanStart: false,
          keepAlive: 0,
          properties: {},
          clientId: "",
        }
      }
      const connectFlags = body.byte()
      // 3.1.2.3: the reserved bit must be 0.
      if (connectFlags & 0x01) throw malformed("CONNECT reserved flag is set")
      const willFlag = (connectFlags & 0x04) !== 0
      const willQos = (connectFlags >> 3) & 0x03
      const willRetain = (connectFlags & 0x20) !== 0
      if (willQos === 3) throw malformed("Will QoS 3")
      if (!willFlag && (willQos !== 0 || willRetain)) throw malformed("Will flags without a Will")
      const keepAlive = body.u16()
      const properties = readProperties(body)
      const clientId = body.utf8()
      const packet: ConnectPacket = {
        type,
        protocolName,
        protocolVersion,
        cleanStart: (connectFlags & 0x02) !== 0,
        keepAlive,
        properties,
        clientId,
      }
      if (willFlag) {
        const willProperties = readProperties(body)
        const topic = body.utf8()
        packet.will = {
          topic,
          payload: body.binary(),
          qos: willQos as QoS,
          retain: willRetain,
          properties: willProperties,
        }
      }
      if (connectFlags & 0x80) packet.username = body.utf8()
      if (connectFlags & 0x40) packet.password = body.binary()
      if (body.remaining > 0) throw malformed("CONNECT has trailing bytes")
      return packet
    }
    case "connack": {
      requireFlags(type, flags, 0)
      const acknowledgeFlags = body.byte()
      if (acknowledgeFlags & 0xfe) throw malformed("CONNACK reserved flags are set")
      const reasonCode = body.byte()
      return {
        type,
        sessionPresent: acknowledgeFlags === 1,
        reasonCode,
        properties: readProperties(body),
      }
    }
    case "publish": {
      const qos = (flags >> 1) & 0x03
      // 3.3.1.2: both QoS bits set is a Malformed Packet.
      if (qos === 3) throw malformed("PUBLISH QoS 3")
      const dup = (flags & 0x08) !== 0
      // 3.3.1.1: DUP must be 0 for QoS 0.
      if (qos === 0 && dup) throw malformed("PUBLISH DUP set at QoS 0")
      const topic = body.utf8()
      const packetId = qos > 0 ? body.u16() : undefined
      // 2.2.1: a QoS > 0 PUBLISH needs a non-zero Packet Identifier.
      if (packetId === 0) throw protocolError("PUBLISH packet identifier 0")
      const properties = readProperties(body)
      return {
        type,
        topic,
        payload: body.rest(),
        qos: qos as QoS,
        retain: (flags & 0x01) !== 0,
        dup,
        ...(packetId !== undefined ? { packetId } : {}),
        properties,
      }
    }
    case "puback":
    case "pubrec":
    case "pubrel":
    case "pubcomp": {
      requireFlags(type, flags, type === "pubrel" ? 0x02 : 0)
      const packetId = body.u16()
      const reasonCode = body.remaining > 0 ? body.byte() : ReasonCode.Success
      const properties = body.remaining > 0 ? readProperties(body) : {}
      return { type, packetId, reasonCode, properties }
    }
    case "subscribe": {
      requireFlags(type, flags, 0x02)
      const packetId = body.u16()
      if (packetId === 0) throw protocolError("SUBSCRIBE packet identifier 0")
      const properties = readProperties(body)
      const subscriptions: SubscriptionRequest[] = []
      while (body.remaining > 0) {
        const topicFilter = body.utf8()
        const options = body.byte()
        // 3.8.3.1: reserved bits must be 0; QoS 3 and Retain Handling 3 are not defined.
        if (options & 0xc0) throw malformed("SUBSCRIBE reserved option bits are set")
        if ((options & 0x03) === 3) throw malformed("SUBSCRIBE QoS 3")
        const retainHandling = (options >> 4) & 0x03
        if (retainHandling === 3) throw protocolError("SUBSCRIBE Retain Handling 3")
        subscriptions.push({
          topicFilter,
          qos: (options & 0x03) as QoS,
          noLocal: (options & 0x04) !== 0,
          retainAsPublished: (options & 0x08) !== 0,
          retainHandling,
        })
      }
      // 3.8.3: a SUBSCRIBE with no payload is a Protocol Error.
      if (subscriptions.length === 0) throw protocolError("SUBSCRIBE without a topic filter")
      return { type, packetId, properties, subscriptions }
    }
    case "suback":
    case "unsuback": {
      requireFlags(type, flags, 0)
      const packetId = body.u16()
      const properties = readProperties(body)
      return { type, packetId, properties, reasonCodes: [...body.rest()] }
    }
    case "unsubscribe": {
      requireFlags(type, flags, 0x02)
      const packetId = body.u16()
      if (packetId === 0) throw protocolError("UNSUBSCRIBE packet identifier 0")
      const properties = readProperties(body)
      const topicFilters: string[] = []
      while (body.remaining > 0) topicFilters.push(body.utf8())
      // 3.10.3: an UNSUBSCRIBE with no payload is a Protocol Error.
      if (topicFilters.length === 0) throw protocolError("UNSUBSCRIBE without a topic filter")
      return { type, packetId, properties, topicFilters }
    }
    case "pingreq":
    case "pingresp":
      requireFlags(type, flags, 0)
      if (body.remaining > 0) throw malformed(`${type} has a body`)
      return { type }
    case "disconnect":
    case "auth": {
      requireFlags(type, flags, 0)
      const reasonCode = body.remaining > 0 ? body.byte() : ReasonCode.Success
      const properties = body.remaining > 0 ? readProperties(body) : {}
      return { type, reasonCode, properties }
    }
  }
}

/** Decode exactly one control packet. Throws {@link MqttProtocolError} when it is not one. */
export const decodePacket = (bytes: Uint8Array): Packet => {
  const reader = new Reader(bytes)
  const first = reader.byte()
  const type = TYPE_NAMES[first >> 4]
  // 2.1.2: packet type 0 is reserved.
  if (!type) throw malformed("reserved control packet type 0")
  const body = reader.sub(reader.varint())
  if (reader.remaining > 0) throw malformed("bytes after the packet")
  return decodeBody(type, first & 0x0f, body)
}

/**
 * Length of the first packet in `buffer` (fixed header included), or `undefined` when the
 * fixed header is not complete yet.
 */
const packetLength = (buffer: Uint8Array): number | undefined => {
  let value = 0
  let multiplier = 1
  for (let index = 1; index <= 4; index++) {
    const digit = buffer[index]
    if (digit === undefined) return undefined
    value += (digit & 0x7f) * multiplier
    if ((digit & 0x80) === 0) return index + 1 + value
    multiplier *= 128
  }
  throw malformed("remaining length longer than four bytes")
}

/**
 * Reassembles control packets from a byte stream, in whatever chunks the transport delivers.
 * Chunks are held as they come and each packet's bytes are copied once, when it is complete,
 * so a large packet in many small chunks costs time linear in its size.
 */
export class PacketReader {
  private chunks: Uint8Array[] = []
  /** Bytes of `chunks[0]` already consumed. */
  private head = 0
  /** Bytes held and not yet consumed. */
  private buffered = 0

  /** `maxPacketSize` is the Maximum Packet Size this endpoint advertised (3.2.2.3.6). */
  constructor(private readonly maxPacketSize: number = MAX_VARIABLE_BYTE_INTEGER + 5) {}

  /**
   * The complete packets `chunk` finishes, as raw bytes and decoded. A packet that cannot be
   * decoded stops the stream: its error is returned after the packets before it.
   */
  push(chunk: Uint8Array): { packets: Packet[]; error?: MqttProtocolError } {
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }
    const packets: Packet[] = []
    try {
      for (;;) {
        const length = packetLength(this.peek(5))
        if (length === undefined) break
        if (length > this.maxPacketSize) {
          throw new MqttProtocolError(ReasonCode.PacketTooLarge, `packet of ${length} bytes`)
        }
        if (this.buffered < length) break
        packets.push(decodePacket(this.take(length)))
      }
    } catch (error) {
      this.chunks = []
      this.head = 0
      this.buffered = 0
      if (error instanceof MqttProtocolError) return { packets, error }
      throw error
    }
    return { packets }
  }

  /** Up to the first `count` held bytes, without consuming them. */
  private peek(count: number): Uint8Array {
    const bytes: number[] = []
    let skip = this.head
    for (const chunk of this.chunks) {
      for (let index = skip; index < chunk.length && bytes.length < count; index++) {
        bytes.push(chunk[index] ?? 0)
      }
      if (bytes.length === count) break
      skip = 0
    }
    return Uint8Array.from(bytes)
  }

  /** Consume the first `length` held bytes into a fresh array (decoded packets keep views of it). */
  private take(length: number): Uint8Array {
    const out = new Uint8Array(length)
    let filled = 0
    let used = 0
    while (filled < length) {
      const chunk = this.chunks[used]
      if (!chunk) break
      const count = Math.min(chunk.length - this.head, length - filled)
      out.set(chunk.subarray(this.head, this.head + count), filled)
      filled += count
      this.head += count
      if (this.head === chunk.length) {
        used += 1
        this.head = 0
      }
    }
    // One splice per packet: shifting chunk by chunk would be quadratic in the chunk count.
    this.chunks.splice(0, used)
    this.buffered -= length
    return out
  }
}
