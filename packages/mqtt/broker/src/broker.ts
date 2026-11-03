/**
 * The MQTT 5 broker engine: sessions, subscriptions, QoS 1 flows, offline queues and expiry.
 *
 * It is transport-free and timer-free. Bytes arrive through {@link Connection.receive} and
 * leave through a {@link Transport}; time is whatever `now()` returns, and everything that
 * depends on it (session expiry, connection expiry) is settled by {@link Broker.sweep}, which
 * every entry point runs first. A suite therefore moves a virtual clock instead of sleeping.
 *
 * Everything durable lives in `Collection`s, so reset and Timeline checkpoints cover it. Only
 * the live connections are held in memory.
 *
 * What a vendor decides differently (who may connect, which topics, limits, reason codes for
 * a refusal) comes in through {@link BrokerPolicy}.
 */
import { Collection, fromBase64, IdSequence, toBase64 } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import {
  type ConnectPacket,
  type DisconnectPacket,
  encodePacket,
  LEGACY_UNSUPPORTED_VERSION_CONNACK,
  type Packet,
  PacketReader,
  type Properties,
  type PublishPacket,
  type QoS,
  type SubscribePacket,
  type UnsubscribePacket,
} from "./codec.js"
import { ReasonCode } from "./reason.js"
import {
  isSharedSubscription,
  isValidTopicFilter,
  isValidTopicName,
  topicMatches,
} from "./topics.js"

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** The byte pipe to one client. A listener implements it over a socket. */
export type Transport = {
  send(bytes: Uint8Array): void
  /** Flush what was sent, then close: the peer sees an orderly end. */
  close(): void
  /** Drop the connection at once, as a network failure does. */
  destroy(): void
}

/** How a client reached the broker, for a policy that reads it. */
export type TransportInfo = {
  kind: "tcp" | "websocket" | "memory"
  /** Request path of a WebSocket upgrade. */
  path?: string
}

/** What a listener feeds: the other half of a {@link Transport}. */
export type Connection = {
  receive(chunk: Uint8Array): void
  /** The transport is gone: the peer closed it or the network failed. */
  closed(): void
}

export type ConnectRequest = {
  clientId: string
  /** True when the client sent an empty identifier and `clientId` was assigned. */
  assigned: boolean
  username: string | undefined
  password: Uint8Array | undefined
  cleanStart: boolean
  keepAlive: number
  properties: Properties
  transport: TransportInfo
}

export type ConnectDecision =
  | {
      ok: true
      /** Kept with the session and handed back to {@link BrokerPolicy.authorize}. */
      principal?: JsonValue
      /** Epoch ms after which the server drops the connection (a token's expiry). */
      connectionExpiresAt?: number
    }
  | { ok: false; reasonCode: number }

export type AuthorizeRequest = {
  /** `receive` is asked once per delivery, for vendors that authorize it separately. */
  action: "publish" | "subscribe" | "receive"
  /** The Topic Name, or the Topic Filter for `subscribe`. */
  topic: string
  qos: QoS
  retain: boolean
  clientId: string
  username: string | null
  principal: JsonValue | null
}

/** Where one vendor's broker differs from another's. Every member is read at use time. */
export type BrokerPolicy = {
  authenticate(request: ConnectRequest): ConnectDecision | Promise<ConnectDecision>
  authorize(request: AuthorizeRequest): boolean
  /** What a denied PUBLISH or SUBSCRIBE does: answer `Not authorized`, or also disconnect. */
  denyAction(): "ignore" | "disconnect"
  /** A reason code refuses a CONNECT for its client identifier. */
  checkClientId?(clientId: string): number | undefined
  /** The identifier assigned to a client that sent none, from a deterministic 16-character token. */
  assignClientId(token: string): string
  /** A reason code rejects a well-formed Topic Name the vendor does not accept. */
  checkTopicName?(topic: string): number | undefined
  /** A reason code rejects a well-formed Topic Filter the vendor does not accept. */
  checkTopicFilter?(filter: string): number | undefined
  /** The Session Expiry Interval (seconds) granted for the one a client asked for. */
  sessionExpiry(requested: number): number
  /** The keep alive the server imposes, when it differs from the client's. */
  serverKeepAlive?(requested: number): number | undefined
  /**
   * Vendor values for the CONNACK: Maximum Packet Size, Topic Alias Maximum, Receive Maximum,
   * Wildcard Subscription Available, Subscription Identifier Available.
   */
  connackProperties(): Properties
  /** Largest PUBLISH payload accepted from a client; larger ones disconnect it. */
  maxPayloadBytes?: number
  /** QoS 1 messages in flight to one client at a time. */
  maxInflight: number
  /** What a session keeps while its client is away. */
  queue: { storeQos0: boolean; maxLength?: number }
  /** PUBACK reason code for a publish no subscription matched. */
  pubackNoMatchingSubscribers: number
  /** A SUBSCRIBE asking for QoS 2: grant QoS 1, or send no SUBACK at all. */
  qos2Subscribe: "downgrade" | "ignore"
  /** Whether `a/#` matches `a` (MQTT 5.0 4.7.1.2 says it does). */
  multiLevelWildcardMatchesParent: boolean
  /** DISCONNECT reason code when `connectionExpiresAt` passes. */
  connectionExpiredReason: number
}

/** Never expires (3.1.2.11.2). */
export const SESSION_NEVER_EXPIRES = 0xffffffff

export type SessionRecord = {
  clientId: string
  username: string | null
  principal: JsonValue | null
  /** Seconds the session outlives its connection. */
  sessionExpiryInterval: number
  createdAt: number
  connectedAt: number
  /** `null` while a connection holds the session. */
  disconnectedAt: number | null
  /** Epoch ms the session is discarded at; `null` while connected, or when it never expires. */
  expiresAt: number | null
  connectionExpiresAt: number | null
  /** The live connection holding the session; a stale id marks a connection lost to a restore. */
  connectionId: string | null
  receiveMaximum: number
  maximumPacketSize: number | null
  transport: TransportInfo["kind"]
}

export type SubscriptionRecord = {
  clientId: string
  topicFilter: string
  /** Granted QoS. */
  qos: 0 | 1
  noLocal: boolean
  retainAsPublished: boolean
  retainHandling: number
  subscriptionIdentifier: number | null
}

/** Application message properties a broker forwards unaltered (3.3.2.3). */
type ForwardedProperties = {
  payloadFormatIndicator?: number
  messageExpiryInterval?: number
  contentType?: string
  responseTopic?: string
  /** base64. */
  correlationData?: string
  userProperties?: [string, string][]
}

export type QueuedMessage = {
  clientId: string
  topic: string
  /** base64. */
  payload: string
  qos: 0 | 1
  properties: ForwardedProperties
  subscriptionIdentifiers: number[]
  /** `inflight` once sent at QoS 1 and not yet acknowledged. */
  state: "queued" | "inflight"
  packetId: number | null
  enqueuedAt: number
}

/** Who published. */
export type PublishSource = "mqtt" | "http" | "admin"

/** One publish as the log keeps it: metadata only, never the payload. */
export type PublishRecord = {
  /** 1 for the first publish since the last reset, counting ones the log has dropped. */
  sequence: number
  topic: string
  qos: QoS
  bytes: number
  source: PublishSource
  /** The publishing client, for `mqtt`. */
  clientId: string | null
  /** Sessions the message was delivered or queued to. */
  matched: number
  at: string
}

export type TransportCut = { target: string; since: number }

export type ClientInfo = {
  clientId: string
  username: string | null
  connected: boolean
  transport: TransportInfo["kind"]
  sessionExpiryInterval: number
  connectedAt: string
  disconnectedAt: string | null
  expiresAt: string | null
  subscriptions: number
  queued: number
  inflight: number
}

export type PublishInput = {
  topic: string
  payload: Uint8Array
  qos: QoS
  properties?: Properties
}

export type BrokerOptions = {
  sqlite: SqliteClient
  /** Storage namespace; brokers with different namespaces share nothing. */
  namespace: string
  now: () => number
  policy: BrokerPolicy
}

/** Most publishes the metadata log keeps; older rows are dropped. */
export const PUBLISH_LOG_SIZE = 1000

const EVERY_CLIENT = "*"

const subscriptionKey = (clientId: string, topicFilter: string): string =>
  JSON.stringify([clientId, topicFilter])

const forwarded = (properties: Properties): ForwardedProperties => ({
  ...(properties.payloadFormatIndicator !== undefined
    ? { payloadFormatIndicator: properties.payloadFormatIndicator }
    : {}),
  ...(properties.messageExpiryInterval !== undefined
    ? { messageExpiryInterval: properties.messageExpiryInterval }
    : {}),
  ...(properties.contentType !== undefined ? { contentType: properties.contentType } : {}),
  ...(properties.responseTopic !== undefined ? { responseTopic: properties.responseTopic } : {}),
  ...(properties.correlationData !== undefined
    ? { correlationData: toBase64(properties.correlationData) }
    : {}),
  ...(properties.userProperties !== undefined && properties.userProperties.length > 0
    ? { userProperties: properties.userProperties }
    : {}),
})

const restored = (properties: ForwardedProperties, identifiers: number[]): Properties => {
  const { correlationData, ...rest } = properties
  return {
    ...rest,
    ...(correlationData !== undefined ? { correlationData: fromBase64(correlationData) } : {}),
    ...(identifiers.length > 0 ? { subscriptionIdentifiers: identifiers } : {}),
  }
}

type ConnectionState = "connecting" | "authenticating" | "open" | "closed"

class BrokerConnection implements Connection {
  state: ConnectionState = "connecting"
  clientId = ""
  readonly aliases = new Map<number, string>()
  readonly backlog: Packet[] = []
  private readonly reader: PacketReader
  private lastPacketId = 0

  constructor(
    readonly id: string,
    readonly transport: Transport,
    readonly info: TransportInfo,
    private readonly broker: Broker,
    maxPacketSize: number | undefined,
  ) {
    this.reader = new PacketReader(maxPacketSize)
  }

  /** Read through a getter so a handler closing the connection mid-loop is seen. */
  private get gone(): boolean {
    return this.state === "closed"
  }

  receive(chunk: Uint8Array): void {
    if (this.gone) return
    const { packets, error } = this.reader.push(chunk)
    for (const packet of packets) {
      if (this.gone) return
      this.broker.accept(this, packet)
    }
    if (error && !this.gone) this.broker.fail(this, error.reasonCode)
  }

  closed(): void {
    this.broker.detach(this)
  }

  send(packet: Packet): void {
    if (this.gone) return
    this.transport.send(encodePacket(packet))
  }

  /** The next Packet Identifier not in `used` (2.2.1). */
  nextPacketId(used: ReadonlySet<number>): number {
    for (let tries = 0; tries < 0xffff; tries++) {
      this.lastPacketId = this.lastPacketId >= 0xffff ? 1 : this.lastPacketId + 1
      if (!used.has(this.lastPacketId)) return this.lastPacketId
    }
    throw new RangeError("no free packet identifier")
  }
}

export class Broker {
  readonly sessions: Collection<SessionRecord>
  readonly subscriptions: Collection<SubscriptionRecord>
  readonly queue: Collection<QueuedMessage>
  readonly publishes: Collection<PublishRecord>
  readonly cuts: Collection<TransportCut>
  readonly counters: Collection<{ value: number }>
  private readonly ids: IdSequence
  private readonly now: () => number
  private readonly policy: BrokerPolicy
  /** Connections holding a session, by client identifier. */
  private readonly live = new Map<string, BrokerConnection>()
  /** Every transport not yet closed, including ones still before their CONNACK. */
  private readonly open = new Set<BrokerConnection>()
  private connectionCount = 0
  private sweeping = false

  constructor(options: BrokerOptions) {
    const { sqlite, namespace } = options
    this.sessions = new Collection(sqlite, namespace, "mqtt_sessions")
    this.subscriptions = new Collection(sqlite, namespace, "mqtt_subscriptions")
    this.queue = new Collection(sqlite, namespace, "mqtt_queue")
    this.publishes = new Collection(sqlite, namespace, "mqtt_publishes")
    this.cuts = new Collection(sqlite, namespace, "mqtt_transport_cuts")
    this.counters = new Collection(sqlite, namespace, "mqtt_counters")
    this.ids = new IdSequence(sqlite, namespace, "mqtt")
    this.now = options.now
    this.policy = options.policy
  }

  // ── transports ───────────────────────────────────────────────────────────

  /** Attach a new client transport. Feed the returned {@link Connection} what it receives. */
  connect(transport: Transport, info: TransportInfo = { kind: "memory" }): Connection {
    this.connectionCount += 1
    const connection = new BrokerConnection(
      `c${this.connectionCount}`,
      transport,
      info,
      this,
      this.policy.connackProperties().maximumPacketSize,
    )
    this.open.add(connection)
    return connection
  }

  /** Open transports right now, including ones that have not sent CONNECT. */
  get connections(): number {
    return this.open.size
  }

  /**
   * Drop every transport without touching stored sessions: the process is going away, or the
   * stored state is about to be replaced. A session whose connection vanished this way starts
   * its expiry at the next {@link sweep}.
   */
  dropConnections(): void {
    for (const connection of [...this.open]) {
      connection.state = "closed"
      connection.transport.destroy()
    }
    this.open.clear()
    this.live.clear()
  }

  // ── time ─────────────────────────────────────────────────────────────────

  /**
   * Settle everything the clock decides: discard expired sessions, start the expiry of
   * sessions whose connection was lost, and drop connections whose credential expired.
   */
  sweep(): void {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const now = this.now()
      for (const { value: session } of this.sessions.list({ order: "oldest" })) {
        const connection = this.live.get(session.clientId)
        if (connection && connection.id === session.connectionId) {
          if (session.connectionExpiresAt !== null && now >= session.connectionExpiresAt) {
            this.shutdown(connection, this.policy.connectionExpiredReason)
          }
          continue
        }
        if (session.disconnectedAt === null) {
          this.endConnection(session, now)
          continue
        }
        if (session.expiresAt !== null && now >= session.expiresAt) {
          this.destroySession(session.clientId)
        }
      }
    } finally {
      this.sweeping = false
    }
  }

  // ── server-side operations ───────────────────────────────────────────────

  /**
   * Publish from the server side (an HTTP API, an admin injection). Returns how many sessions
   * the message was delivered or queued to. No client ACL applies; `receive` authorization does.
   */
  publish(input: PublishInput, source: PublishSource = "http"): number {
    this.sweep()
    return this.route(input, source, null)
  }

  /**
   * End a client's session as an administrator does: disconnect it with `reasonCode` and
   * discard the session, its subscriptions and its queue. False when no such session exists.
   */
  kick(clientId: string, reasonCode: number = ReasonCode.AdministrativeAction): boolean {
    this.sweep()
    if (!this.sessions.has(clientId)) return false
    const connection = this.live.get(clientId)
    if (connection) this.shutdown(connection, reasonCode, true)
    this.destroySession(clientId)
    return true
  }

  /**
   * Send a connected client a DISCONNECT and close its connection. The session stays, under
   * its own expiry. False when the client is not connected.
   */
  disconnect(clientId: string, reasonCode: number = ReasonCode.AdministrativeAction): boolean {
    this.sweep()
    const connection = this.live.get(clientId)
    if (!connection) return false
    this.shutdown(connection, reasonCode)
    return true
  }

  /**
   * Cut the transport of one client, or of every client: live connections die without a
   * DISCONNECT and new CONNECTs are dropped unanswered until {@link restoreTransport}.
   * Sessions are left to their own expiry. Returns how many connections were dropped.
   */
  cutTransport(clientId?: string): number {
    this.sweep()
    const target = clientId ?? EVERY_CLIENT
    this.cuts.insert(target, { target, since: this.now() })
    let dropped = 0
    for (const connection of [...this.open]) {
      if (clientId !== undefined && connection.clientId !== clientId) continue
      connection.transport.destroy()
      this.detach(connection)
      dropped += 1
    }
    return dropped
  }

  /** Let one client, or with no argument every client, connect again. */
  restoreTransport(clientId?: string): void {
    if (clientId !== undefined) {
      this.cuts.delete(clientId)
      return
    }
    for (const row of this.cuts.list()) this.cuts.delete(row.id)
  }

  /** Targets currently cut: client identifiers, or `*` for every client. */
  transportCuts(): string[] {
    return this.cuts
      .list({ order: "oldest" })
      .map((row) => row.value.target)
      .sort()
  }

  clients(): ClientInfo[] {
    this.sweep()
    const subscriptions = this.subscriptions.list()
    const queue = this.queue.list()
    const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString())
    return this.sessions.list({ order: "oldest" }).map(({ value: session }) => ({
      clientId: session.clientId,
      username: session.username,
      connected: this.live.has(session.clientId),
      transport: session.transport,
      sessionExpiryInterval: session.sessionExpiryInterval,
      connectedAt: new Date(session.connectedAt).toISOString(),
      disconnectedAt: iso(session.disconnectedAt),
      expiresAt: iso(session.expiresAt),
      subscriptions: subscriptions.filter((row) => row.value.clientId === session.clientId).length,
      queued: queue.filter(
        (row) => row.value.clientId === session.clientId && row.value.state === "queued",
      ).length,
      inflight: queue.filter(
        (row) => row.value.clientId === session.clientId && row.value.state === "inflight",
      ).length,
    }))
  }

  subscriptionList(clientId?: string): SubscriptionRecord[] {
    this.sweep()
    return this.subscriptions
      .list({
        order: "oldest",
        ...(clientId !== undefined ? { where: (row) => row.clientId === clientId } : {}),
      })
      .map((row) => row.value)
  }

  /** The last {@link PUBLISH_LOG_SIZE} publishes, oldest first. */
  publishLog(): PublishRecord[] {
    return this.publishes.list({ order: "oldest" }).map((row) => row.value)
  }

  /** Publishes since the last reset, including ones the log no longer holds. */
  publishCount(): number {
    return this.counters.get("publishes")?.value ?? 0
  }

  // ── packets ──────────────────────────────────────────────────────────────

  /** @internal Called by a connection for each decoded packet. */
  accept(connection: BrokerConnection, packet: Packet): void {
    if (connection.state === "authenticating") {
      connection.backlog.push(packet)
      return
    }
    if (connection.state === "connecting") {
      // 3.1: the first packet from a client must be CONNECT.
      if (packet.type !== "connect") {
        connection.transport.destroy()
        this.detach(connection)
        return
      }
      this.onConnect(connection, packet)
      return
    }
    if (connection.state !== "open") return
    this.sweep()
    if (!this.open.has(connection)) return
    switch (packet.type) {
      case "publish":
        this.onPublish(connection, packet)
        return
      case "puback":
        this.onPuback(connection, packet.packetId)
        return
      case "subscribe":
        this.onSubscribe(connection, packet)
        return
      case "unsubscribe":
        this.onUnsubscribe(connection, packet)
        return
      case "pingreq":
        connection.send({ type: "pingresp" })
        return
      case "disconnect":
        this.onDisconnect(connection, packet)
        return
      default:
        // A second CONNECT (3.1), a QoS 2 flow packet this broker never starts, AUTH without
        // extended authentication (3.15), or a packet only a server sends.
        this.fail(connection, ReasonCode.ProtocolError)
    }
  }

  /** @internal A protocol violation: answer with `reasonCode` and close. */
  fail(connection: BrokerConnection, reasonCode: number): void {
    if (connection.state === "open") {
      this.shutdown(connection, reasonCode)
      return
    }
    connection.transport.destroy()
    this.detach(connection)
  }

  /** @internal The transport is gone, or was just closed by the broker. */
  detach(connection: BrokerConnection, keepSession = false): void {
    if (connection.state === "closed") return
    const wasOpen = connection.state === "open"
    connection.state = "closed"
    this.open.delete(connection)
    if (!wasOpen || this.live.get(connection.clientId) !== connection) return
    this.live.delete(connection.clientId)
    if (keepSession) return
    const session = this.sessions.get(connection.clientId)
    if (session) this.endConnection(session, this.now())
  }

  /** The session's connection ended at `at`: discard it, or start its expiry (4.1). */
  private endConnection(session: SessionRecord, at: number): void {
    if (session.sessionExpiryInterval === 0) {
      this.destroySession(session.clientId)
      return
    }
    // Messages sent and not acknowledged stay in flight: they are resent on resume (4.4).
    this.sessions.update(session.clientId, {
      ...session,
      connectionId: null,
      connectionExpiresAt: null,
      disconnectedAt: at,
      expiresAt:
        session.sessionExpiryInterval === SESSION_NEVER_EXPIRES
          ? null
          : at + session.sessionExpiryInterval * 1000,
    })
  }

  private destroySession(clientId: string): void {
    this.sessions.delete(clientId)
    for (const row of this.subscriptions.list({ where: (each) => each.clientId === clientId })) {
      this.subscriptions.delete(row.id)
    }
    for (const row of this.queue.list({ where: (each) => each.clientId === clientId })) {
      this.queue.delete(row.id)
    }
  }

  /** Send DISCONNECT with `reasonCode`, close the transport, and settle the session. */
  private shutdown(connection: BrokerConnection, reasonCode: number, keepSession = false): void {
    connection.send({ type: "disconnect", reasonCode, properties: {} })
    connection.transport.close()
    this.detach(connection, keepSession)
  }

  private isCut(clientId: string): boolean {
    return this.cuts.has(EVERY_CLIENT) || this.cuts.has(clientId)
  }

  private onConnect(connection: BrokerConnection, packet: ConnectPacket): void {
    if (packet.protocolName !== "MQTT" || packet.protocolVersion !== 5) {
      // 3.1.2.2: a server that does not accept the protocol level may say so, then must close.
      // MQTT 3.1 / 3.1.1 clients get the CONNACK their own protocol defines for that.
      if (packet.protocolVersion === 3 || packet.protocolVersion === 4) {
        connection.transport.send(LEGACY_UNSUPPORTED_VERSION_CONNACK)
      }
      connection.transport.close()
      this.detach(connection)
      return
    }
    const assigned = packet.clientId === ""
    const clientId = assigned ? this.policy.assignClientId(this.ids.next("", 16)) : packet.clientId
    connection.clientId = clientId
    if (this.isCut(clientId)) {
      connection.transport.destroy()
      this.detach(connection)
      return
    }
    const refuse = (reasonCode: number) => {
      if (connection.state === "closed") return
      connection.send({ type: "connack", sessionPresent: false, reasonCode, properties: {} })
      connection.transport.close()
      this.detach(connection)
    }
    const invalid = this.policy.checkClientId?.(clientId)
    if (invalid !== undefined) {
      refuse(invalid)
      return
    }
    connection.state = "authenticating"
    const settle = (decision: ConnectDecision) => {
      if (connection.state !== "authenticating") return
      if (!decision.ok) {
        refuse(decision.reasonCode)
        return
      }
      this.openSession(connection, packet, clientId, assigned, decision)
      // Packets that arrived while the policy was deciding. `accept` drops them once closed.
      for (const queued of connection.backlog.splice(0)) this.accept(connection, queued)
    }
    let decision: ConnectDecision | Promise<ConnectDecision>
    try {
      decision = this.policy.authenticate({
        clientId,
        assigned,
        username: packet.username,
        password: packet.password,
        cleanStart: packet.cleanStart,
        keepAlive: packet.keepAlive,
        properties: packet.properties,
        transport: connection.info,
      })
    } catch {
      refuse(ReasonCode.UnspecifiedError)
      return
    }
    if (decision instanceof Promise) {
      decision.then(settle, () => refuse(ReasonCode.UnspecifiedError))
    } else settle(decision)
  }

  private openSession(
    connection: BrokerConnection,
    packet: ConnectPacket,
    clientId: string,
    assigned: boolean,
    decision: Extract<ConnectDecision, { ok: true }>,
  ): void {
    this.sweep()
    const now = this.now()
    // 3.1.4: a client identifier already connected is disconnected first. Its session is still
    // the live one, so the new connection resumes it unless it asked for a clean start.
    const previous = this.live.get(clientId)
    if (previous) this.shutdown(previous, ReasonCode.SessionTakenOver, true)
    const existing = this.sessions.get(clientId)
    const sessionPresent = existing !== undefined && !packet.cleanStart
    if (existing && !sessionPresent) this.destroySession(clientId)
    const requested = packet.properties.sessionExpiryInterval ?? 0
    const granted = this.policy.sessionExpiry(requested)
    const record: SessionRecord = {
      clientId,
      username: packet.username ?? null,
      principal: decision.principal ?? null,
      sessionExpiryInterval: granted,
      createdAt: sessionPresent ? existing.createdAt : now,
      connectedAt: now,
      disconnectedAt: null,
      expiresAt: null,
      connectionExpiresAt: decision.connectionExpiresAt ?? null,
      connectionId: connection.id,
      // 3.1.2.11.3: 65,535 when the client names no Receive Maximum.
      receiveMaximum: packet.properties.receiveMaximum ?? 0xffff,
      maximumPacketSize: packet.properties.maximumPacketSize ?? null,
      transport: connection.info.kind,
    }
    if (sessionPresent) this.sessions.update(clientId, record)
    else this.sessions.insert(clientId, record)
    this.live.set(clientId, connection)
    connection.state = "open"
    const keepAlive = this.policy.serverKeepAlive?.(packet.keepAlive)
    connection.send({
      type: "connack",
      sessionPresent,
      reasonCode: ReasonCode.Success,
      properties: {
        ...this.policy.connackProperties(),
        // What this broker does not do, said the way the protocol provides for (3.2.2.3).
        maximumQoS: 1,
        retainAvailable: 0,
        sharedSubscriptionAvailable: 0,
        ...(assigned ? { assignedClientIdentifier: clientId } : {}),
        ...(granted !== requested ? { sessionExpiryInterval: granted } : {}),
        ...(keepAlive !== undefined && keepAlive !== packet.keepAlive
          ? { serverKeepAlive: keepAlive }
          : {}),
      },
    })
    if (sessionPresent) this.resume(connection, record)
  }

  /** 4.4: resend what was sent and never acknowledged, then whatever queued up meanwhile. */
  private resume(connection: BrokerConnection, session: SessionRecord): void {
    const rows = this.queue.list({
      where: (each) => each.clientId === session.clientId && each.state === "inflight",
      order: "oldest",
    })
    for (const row of rows) {
      this.sendMessage(connection, session, row.id, row.value, row.value.packetId, true)
    }
    this.pump(session.clientId)
  }

  private onDisconnect(connection: BrokerConnection, packet: DisconnectPacket): void {
    const interval = packet.properties.sessionExpiryInterval
    const session = this.sessions.get(connection.clientId)
    if (interval !== undefined && session) {
      // 3.14.2.2.2: a session that began with interval 0 cannot be given one on DISCONNECT.
      if (session.sessionExpiryInterval === 0 && interval !== 0) {
        this.fail(connection, ReasonCode.ProtocolError)
        return
      }
      this.sessions.update(connection.clientId, {
        ...session,
        sessionExpiryInterval: this.policy.sessionExpiry(interval),
      })
    }
    connection.transport.close()
    this.detach(connection)
  }

  private onPublish(connection: BrokerConnection, packet: PublishPacket): void {
    // 3.3.4: a client must not send a Subscription Identifier.
    if (packet.properties.subscriptionIdentifiers !== undefined) {
      this.fail(connection, ReasonCode.ProtocolError)
      return
    }
    let topic = packet.topic
    const alias = packet.properties.topicAlias
    if (alias !== undefined) {
      // 3.3.2.3.4: 0, or a value above the server's Topic Alias Maximum, is not valid.
      const limit = this.policy.connackProperties().topicAliasMaximum ?? 0
      if (alias === 0 || alias > limit) {
        this.fail(connection, ReasonCode.TopicAliasInvalid)
        return
      }
      if (topic !== "") connection.aliases.set(alias, topic)
      else topic = connection.aliases.get(alias) ?? ""
    }
    if (topic === "") {
      this.fail(connection, ReasonCode.ProtocolError)
      return
    }
    // 3.2.2.3.4 / 3.2.2.3.5: above the advertised Maximum QoS, or RETAIN when Retain Available
    // is 0, is a Protocol Error answered with these reason codes.
    if (packet.qos === 2) {
      this.fail(connection, ReasonCode.QoSNotSupported)
      return
    }
    if (packet.retain) {
      this.fail(connection, ReasonCode.RetainNotSupported)
      return
    }
    if (!isValidTopicName(topic)) {
      this.fail(connection, ReasonCode.TopicNameInvalid)
      return
    }
    const limit = this.policy.maxPayloadBytes
    if (limit !== undefined && packet.payload.length > limit) {
      this.fail(connection, ReasonCode.PacketTooLarge)
      return
    }
    const acknowledge = (reasonCode: number) => {
      if (packet.qos === 1 && packet.packetId !== undefined) {
        connection.send({ type: "puback", packetId: packet.packetId, reasonCode, properties: {} })
      }
    }
    const rejected = this.policy.checkTopicName?.(topic)
    if (rejected !== undefined) {
      acknowledge(rejected)
      return
    }
    const session = this.sessions.get(connection.clientId)
    const allowed = this.policy.authorize({
      action: "publish",
      topic,
      qos: packet.qos,
      retain: packet.retain,
      clientId: connection.clientId,
      username: session?.username ?? null,
      principal: session?.principal ?? null,
    })
    if (!allowed) {
      if (this.policy.denyAction() === "disconnect") {
        this.fail(connection, ReasonCode.NotAuthorized)
        return
      }
      acknowledge(ReasonCode.NotAuthorized)
      return
    }
    const matched = this.route(
      { topic, payload: packet.payload, qos: packet.qos, properties: packet.properties },
      "mqtt",
      connection.clientId,
    )
    acknowledge(matched > 0 ? ReasonCode.Success : this.policy.pubackNoMatchingSubscribers)
  }

  private onPuback(connection: BrokerConnection, packetId: number): void {
    const row = this.queue
      .list({
        where: (each) =>
          each.clientId === connection.clientId &&
          each.state === "inflight" &&
          each.packetId === packetId,
      })
      .at(0)
    if (!row) return
    this.queue.delete(row.id)
    this.pump(connection.clientId)
  }

  private onSubscribe(connection: BrokerConnection, packet: SubscribePacket): void {
    const identifier = packet.properties.subscriptionIdentifiers?.[0]
    const identifiers = this.policy.connackProperties().subscriptionIdentifierAvailable ?? 1
    if (identifier !== undefined && identifiers === 0) {
      // 3.2.2.3.12: sent when the server said it does not support them.
      this.fail(connection, ReasonCode.SubscriptionIdentifiersNotSupported)
      return
    }
    if (
      this.policy.qos2Subscribe === "ignore" &&
      packet.subscriptions.some((each) => each.qos === 2)
    ) {
      return
    }
    const session = this.sessions.get(connection.clientId)
    const reasonCodes: number[] = []
    for (const each of packet.subscriptions) {
      if (isSharedSubscription(each.topicFilter)) {
        reasonCodes.push(ReasonCode.SharedSubscriptionsNotSupported)
        continue
      }
      if (!isValidTopicFilter(each.topicFilter)) {
        reasonCodes.push(ReasonCode.TopicFilterInvalid)
        continue
      }
      const rejected = this.policy.checkTopicFilter?.(each.topicFilter)
      if (rejected !== undefined) {
        reasonCodes.push(rejected)
        continue
      }
      const allowed = this.policy.authorize({
        action: "subscribe",
        topic: each.topicFilter,
        qos: each.qos,
        retain: false,
        clientId: connection.clientId,
        username: session?.username ?? null,
        principal: session?.principal ?? null,
      })
      if (!allowed) {
        if (this.policy.denyAction() === "disconnect") {
          this.fail(connection, ReasonCode.NotAuthorized)
          return
        }
        reasonCodes.push(ReasonCode.NotAuthorized)
        continue
      }
      // 3.9.3: the granted QoS may be lower than the one requested.
      const qos = each.qos === 0 ? 0 : 1
      this.subscriptions.insert(subscriptionKey(connection.clientId, each.topicFilter), {
        clientId: connection.clientId,
        topicFilter: each.topicFilter,
        qos,
        noLocal: each.noLocal,
        retainAsPublished: each.retainAsPublished,
        retainHandling: each.retainHandling,
        subscriptionIdentifier: identifier ?? null,
      })
      reasonCodes.push(qos)
    }
    connection.send({ type: "suback", packetId: packet.packetId, properties: {}, reasonCodes })
  }

  private onUnsubscribe(connection: BrokerConnection, packet: UnsubscribePacket): void {
    const reasonCodes = packet.topicFilters.map((filter) =>
      this.subscriptions.delete(subscriptionKey(connection.clientId, filter))
        ? ReasonCode.Success
        : ReasonCode.NoSubscriptionExisted,
    )
    connection.send({ type: "unsuback", packetId: packet.packetId, properties: {}, reasonCodes })
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  private route(input: PublishInput, source: PublishSource, publisher: string | null): number {
    const targets = new Map<string, { qos: 0 | 1; identifiers: number[] }>()
    for (const { value: subscription } of this.subscriptions.list({ order: "oldest" })) {
      if (subscription.noLocal && subscription.clientId === publisher) continue
      const matches = topicMatches(subscription.topicFilter, input.topic, {
        parentLevel: this.policy.multiLevelWildcardMatchesParent,
      })
      if (!matches) continue
      // 3.3.4: overlapping subscriptions of one client get one copy, at the highest of their
      // granted QoS, carrying every Subscription Identifier.
      const target = targets.get(subscription.clientId) ?? { qos: 0, identifiers: [] }
      if (subscription.qos === 1) target.qos = 1
      if (subscription.subscriptionIdentifier !== null) {
        target.identifiers.push(subscription.subscriptionIdentifier)
      }
      targets.set(subscription.clientId, target)
    }
    let matched = 0
    for (const [clientId, target] of targets) {
      const session = this.sessions.get(clientId)
      if (!session) continue
      const qos = input.qos === 0 ? 0 : target.qos
      const allowed = this.policy.authorize({
        action: "receive",
        topic: input.topic,
        qos,
        retain: false,
        clientId,
        username: session.username,
        principal: session.principal,
      })
      if (!allowed) continue
      matched += 1
      this.deliver(session, {
        clientId,
        topic: input.topic,
        payload: toBase64(input.payload),
        qos,
        properties: forwarded(input.properties ?? {}),
        subscriptionIdentifiers: target.identifiers,
        state: "queued",
        packetId: null,
        enqueuedAt: this.now(),
      })
    }
    this.record(input, source, publisher, matched)
    return matched
  }

  private deliver(session: SessionRecord, message: QueuedMessage): void {
    const connection = this.live.get(session.clientId)
    if (message.qos === 0) {
      if (connection) {
        this.sendMessage(connection, session, undefined, message, null, false)
        return
      }
      if (!this.policy.queue.storeQos0) return
    }
    this.queue.insert(String(this.queue.nextSequence()).padStart(12, "0"), message)
    const limit = this.policy.queue.maxLength
    if (limit !== undefined) {
      const waiting = this.queue.list({
        where: (each) => each.clientId === session.clientId && each.state === "queued",
        order: "oldest",
      })
      for (const row of waiting.slice(0, Math.max(0, waiting.length - limit))) {
        this.queue.delete(row.id)
      }
    }
    if (connection) this.pump(session.clientId)
  }

  /** Send as much of a client's queue as its Receive Maximum allows (4.9). */
  private pump(clientId: string): void {
    const connection = this.live.get(clientId)
    const session = this.sessions.get(clientId)
    if (!connection || !session) return
    const rows = this.queue.list({ where: (each) => each.clientId === clientId, order: "oldest" })
    const used = new Set<number>()
    for (const row of rows) {
      if (row.value.state === "inflight" && row.value.packetId !== null) {
        used.add(row.value.packetId)
      }
    }
    const window = Math.min(session.receiveMaximum, this.policy.maxInflight)
    for (const row of rows) {
      if (row.value.state !== "queued") continue
      if (row.value.qos === 0) {
        this.queue.delete(row.id)
        this.sendMessage(connection, session, undefined, row.value, null, false)
        continue
      }
      if (used.size >= window) break
      const packetId = connection.nextPacketId(used)
      used.add(packetId)
      const sending: QueuedMessage = { ...row.value, state: "inflight", packetId }
      this.queue.update(row.id, sending)
      this.sendMessage(connection, session, row.id, sending, packetId, false)
    }
  }

  private sendMessage(
    connection: BrokerConnection,
    session: SessionRecord,
    queueId: string | undefined,
    message: QueuedMessage,
    packetId: number | null,
    dup: boolean,
  ): void {
    const bytes = encodePacket({
      type: "publish",
      topic: message.topic,
      payload: fromBase64(message.payload),
      qos: message.qos,
      // 3.3.1.3: a message forwarded to an established subscription has RETAIN 0.
      retain: false,
      dup,
      ...(packetId !== null ? { packetId } : {}),
      properties: restored(message.properties, message.subscriptionIdentifiers),
    })
    // 3.1.2.11.4: a packet above the client's Maximum Packet Size is discarded unsent, and
    // treated as if the application message had been delivered.
    if (session.maximumPacketSize !== null && bytes.length > session.maximumPacketSize) {
      if (queueId !== undefined) this.queue.delete(queueId)
      return
    }
    if (connection.state === "open") connection.transport.send(bytes)
  }

  private record(
    input: PublishInput,
    source: PublishSource,
    publisher: string | null,
    matched: number,
  ): void {
    const sequence = this.publishCount() + 1
    this.counters.insert("publishes", { value: sequence })
    this.publishes.insert(String(sequence).padStart(12, "0"), {
      sequence,
      topic: input.topic,
      qos: input.qos,
      bytes: input.payload.length,
      source,
      clientId: publisher,
      matched,
      at: new Date(this.now()).toISOString(),
    })
    this.publishes.delete(String(sequence - PUBLISH_LOG_SIZE).padStart(12, "0"))
  }
}

/**
 * Largest first packet {@link routeConnection} holds while it waits for a CONNECT. Every
 * length-prefixed CONNECT field at its 65,535-byte maximum fits with room to spare; a client
 * declaring more is dropped from its fixed header, before any of the body is buffered.
 */
const MAX_ROUTED_CONNECT_BYTES = 1024 * 1024

/**
 * Hold a new transport until its CONNECT arrives, ask `select` which broker it belongs to
 * (a tenant chosen by username or client identifier), and attach it there. A transport whose
 * first packet is not a CONNECT, is larger than {@link MAX_ROUTED_CONNECT_BYTES}, or that
 * `select` turns away, is dropped.
 */
export const routeConnection = (
  transport: Transport,
  select: (connect: ConnectPacket) => Broker | undefined,
  info: TransportInfo = { kind: "memory" },
): Connection => {
  // Bounds what is held before CONNECT: at most one packet of this size.
  const reader = new PacketReader(MAX_ROUTED_CONNECT_BYTES)
  const held: Uint8Array[] = []
  let attached: Connection | undefined
  let done = false
  return {
    receive(chunk) {
      if (attached) {
        attached.receive(chunk)
        return
      }
      if (done) return
      held.push(chunk)
      const { packets, error } = reader.push(chunk)
      const first = packets[0]
      if (!first && !error) return
      const broker = first?.type === "connect" ? select(first) : undefined
      if (!broker) {
        done = true
        transport.destroy()
        return
      }
      attached = broker.connect(transport, info)
      for (const each of held.splice(0)) attached.receive(each)
    },
    closed() {
      done = true
      attached?.closed()
    },
  }
}
