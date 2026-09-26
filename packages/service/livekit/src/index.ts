import { type APIOptions, bootSqlite } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { verifyJwt } from "./crypto.js"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  type AsyncResource,
  type DataMessage,
  type LiveKitParticipant,
  type LiveKitRoom,
  LiveKitState,
  type LiveKitTrack,
} from "./state.js"

export type { LiveKitRuntime, LiveKitRuntimeOptions } from "./runtime.js"
export { createRuntime, LIVEKIT_PRESETS } from "./runtime.js"
export type {
  AsyncResource,
  DataMessage,
  LiveKitParticipant,
  LiveKitRoom,
  LiveKitTrack,
} from "./state.js"
export { document, operationIds, supportedOperationIds }
export const LIVEKIT_NAMESPACE = "livekit"
type Input = Record<string, unknown>
export type LiveKitEvent = {
  event: string
  id: string
  createdAt: string
  room?: Record<string, unknown>
  participant?: Record<string, unknown>
  track?: Record<string, unknown>
  egressInfo?: Record<string, unknown>
  sipCall?: Record<string, unknown>
}
export type LiveKitAPIOptions = APIOptions & {
  keys?: Readonly<Record<string, string>>
  onEvent?: (event: LiveKitEvent) => void
}
const record = (value: unknown): Input =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Input) : {}

export class LiveKitAPI {
  readonly state: LiveKitState
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly keys: Readonly<Record<string, string>>
  constructor(private readonly options: LiveKitAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? LIVEKIT_NAMESPACE
    this.now = options.now ?? Date.now
    this.keys = options.keys ?? { fixture: "fixture-secret-that-is-at-least-32-chars" }
    this.state = new LiveKitState(this.sqlite, this.namespace)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
  }
  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-livekit-request-id": this.state.ids.next("req_", 20),
      },
    })
  }
  private error(code: string, msg: string, status = 400, meta: Record<string, string> = {}) {
    return this.json({ code, msg, meta }, status)
  }
  private publicRoom(room: LiveKitRoom) {
    return { ...room, creationTime: String(Math.floor(room.creationTime / 1000)) }
  }
  private publicParticipant(participant: LiveKitParticipant) {
    return {
      sid: participant.sid,
      identity: participant.identity,
      name: participant.name,
      state: "ACTIVE",
      joinedAt: String(Math.floor(participant.joinedAt / 1000)),
      metadata: participant.metadata,
      attributes: participant.attributes,
      permission: participant.permission,
      tracks: participant.tracks,
    }
  }
  private emit(event: Omit<LiveKitEvent, "id" | "createdAt">) {
    this.options.onEvent?.({
      ...event,
      id: this.state.ids.next("EV_", 20),
      createdAt: String(Math.floor(this.now() / 1000)),
    })
  }
  private room(name: unknown) {
    return typeof name === "string" ? this.state.rooms.get(name) : undefined
  }
  private participant(room: unknown, identity: unknown) {
    return typeof room === "string" && typeof identity === "string"
      ? this.state.participants.get(this.state.participantId(room, identity))
      : undefined
  }
  private updateRoomCount(name: string) {
    const room = this.state.rooms.get(name)
    if (!room) return
    const participants = this.state.participants
      .list({ where: (p) => p.room === name })
      .map(({ value }) => value)
    this.state.rooms.insert(name, {
      ...room,
      numParticipants: participants.length,
      numPublishers: participants.filter((p) => p.tracks.length).length,
    })
  }
  createRoom(input: Input) {
    const name = typeof input.name === "string" ? input.name : ""
    if (!name) return undefined
    const prior = this.state.rooms.get(name)
    if (prior) return prior
    const room: LiveKitRoom = {
      sid: this.state.ids.next("RM_", 24),
      name,
      emptyTimeout: Number(input.emptyTimeout ?? 300),
      departureTimeout: Number(input.departureTimeout ?? 20),
      maxParticipants: Number(input.maxParticipants ?? 0),
      creationTime: this.now(),
      metadata: typeof input.metadata === "string" ? input.metadata : "",
      numParticipants: 0,
      numPublishers: 0,
      activeRecording: false,
    }
    this.state.rooms.insert(name, room)
    this.emit({ event: "room_started", room: this.publicRoom(room) })
    return room
  }
  join(
    roomName: string,
    input: {
      identity: string
      name?: string
      metadata?: string
      attributes?: Record<string, string>
      permission?: Record<string, boolean>
    },
  ) {
    const room = this.state.rooms.get(roomName) ?? this.createRoom({ name: roomName })
    if (!room || this.participant(roomName, input.identity)) return undefined
    const participant: LiveKitParticipant & { room: string } = {
      room: roomName,
      sid: this.state.ids.next("PA_", 24),
      identity: input.identity,
      name: input.name ?? input.identity,
      metadata: input.metadata ?? "",
      attributes: input.attributes ?? {},
      joinedAt: this.now(),
      permission: {
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
        ...input.permission,
      },
      tracks: [],
    }
    this.state.participants.insert(this.state.participantId(roomName, input.identity), participant)
    this.updateRoomCount(roomName)
    this.emit({
      event: "participant_joined",
      room: this.publicRoom(this.state.rooms.get(roomName) as LiveKitRoom),
      participant: this.publicParticipant(participant),
    })
    return participant
  }
  remove(roomName: string, identity: string) {
    const participant = this.participant(roomName, identity)
    if (!participant) return undefined
    const room = this.publicRoom(this.state.rooms.get(roomName) as LiveKitRoom)
    for (const track of participant.tracks)
      this.emit({
        event: "track_unpublished",
        room,
        participant: this.publicParticipant(participant),
        track,
      })
    this.state.participants.delete(this.state.participantId(roomName, identity))
    this.updateRoomCount(roomName)
    this.emit({ event: "participant_left", room, participant: this.publicParticipant(participant) })
    return participant
  }
  deleteRoom(name: string) {
    const room = this.state.rooms.get(name)
    if (!room) return undefined
    for (const { value } of this.state.participants.list({ where: (p) => p.room === name }))
      this.remove(name, value.identity)
    this.state.rooms.delete(name)
    this.emit({ event: "room_finished", room: this.publicRoom(room) })
    return room
  }
  publish(roomName: string, identity: string, input: Partial<LiveKitTrack>) {
    const participant = this.participant(roomName, identity)
    if (!participant) return undefined
    const track: LiveKitTrack = {
      sid: input.sid ?? this.state.ids.next("TR_", 24),
      name: input.name ?? "track",
      type: input.type ?? "AUDIO",
      source: input.source ?? "MICROPHONE",
      muted: input.muted ?? false,
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
    }
    const next = { ...participant, tracks: [...participant.tracks, track] }
    this.state.participants.insert(this.state.participantId(roomName, identity), next)
    this.updateRoomCount(roomName)
    this.emit({
      event: "track_published",
      room: this.publicRoom(this.state.rooms.get(roomName) as LiveKitRoom),
      participant: this.publicParticipant(next),
      track,
    })
    return track
  }
  expireRooms() {
    for (const { value: room } of this.state.rooms.list()) {
      if (
        room.numParticipants === 0 &&
        room.emptyTimeout > 0 &&
        room.creationTime + room.emptyTimeout * 1000 <= this.now()
      )
        this.deleteRoom(room.name)
    }
  }
  transitionResource(id: string, status: string, error?: string) {
    const current = this.state.resources.get(id)
    if (!current) return undefined
    const input = { ...current.input, status, ...(error ? { error } : {}) }
    const next = { ...current, status, input, ...(error ? { error } : {}) }
    this.state.resources.insert(id, next)
    this.emit(
      current.kind === "egress"
        ? {
            event: status === "EGRESS_COMPLETE" ? "egress_ended" : "egress_updated",
            egressInfo: input,
          }
        : {
            event: status === "DISCONNECTED" ? "sip_call_ended" : "sip_call_updated",
            sipCall: input,
          },
    )
    return next
  }
  private async authorize(request: Request, service: string, method: string, input: Input) {
    const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    const claims = raw ? await verifyJwt(raw, this.keys, this.now()) : undefined
    if (!claims) return undefined
    const video = record(claims.video)
    const sip = record(claims.sip)
    if (service === "SIP") return sip.admin === true || sip.call === true ? claims : undefined
    if (service === "Egress") return video.roomRecord === true ? claims : undefined
    const required =
      method === "CreateRoom" || method === "DeleteRoom"
        ? "roomCreate"
        : method === "ListRooms"
          ? "roomList"
          : "roomAdmin"
    if (video[required] !== true) return undefined
    const room = input.room ?? input.roomName
    return typeof video.room === "string" && typeof room === "string" && video.room !== room
      ? undefined
      : claims
  }
  private async roomService(method: string, input: Input) {
    if (method === "CreateRoom") {
      const room = this.createRoom(input)
      return room
        ? this.json(this.publicRoom(room))
        : this.error("invalid_argument", "room name is required")
    }
    if (method === "ListRooms") {
      this.expireRooms()
      const names = Array.isArray(input.names) ? new Set(input.names) : undefined
      const rooms = this.state.rooms
        .list({ order: "oldest", where: (r) => !names?.size || names.has(r.name) })
        .map(({ value }) => this.publicRoom(value))
      return this.json({ rooms })
    }
    if (method === "DeleteRoom")
      return typeof input.room === "string" && this.deleteRoom(input.room)
        ? this.json({})
        : this.error("not_found", "room not found", 404)
    if (method === "UpdateRoomMetadata") {
      const room = this.room(input.room)
      if (!room) return this.error("not_found", "room not found", 404)
      const next = { ...room, metadata: typeof input.metadata === "string" ? input.metadata : "" }
      this.state.rooms.insert(room.name, next)
      return this.json(this.publicRoom(next))
    }
    if (method === "ListParticipants") {
      if (!this.room(input.room)) return this.error("not_found", "room not found", 404)
      return this.json({
        participants: this.state.participants
          .list({ where: (p) => p.room === input.room, order: "oldest" })
          .map(({ value }) => this.publicParticipant(value)),
      })
    }
    if (method === "GetParticipant") {
      const participant = this.participant(input.room, input.identity)
      return participant
        ? this.json(this.publicParticipant(participant))
        : this.error("not_found", "participant not found", 404)
    }
    if (method === "RemoveParticipant")
      return typeof input.room === "string" &&
        typeof input.identity === "string" &&
        this.remove(input.room, input.identity)
        ? this.json({})
        : this.error("not_found", "participant not found", 404)
    if (method === "UpdateParticipant") {
      const participant = this.participant(input.room, input.identity)
      if (!participant || typeof input.room !== "string" || typeof input.identity !== "string")
        return this.error("not_found", "participant not found", 404)
      const next = {
        ...participant,
        ...(typeof input.metadata === "string" ? { metadata: input.metadata } : {}),
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(input.attributes && typeof input.attributes === "object"
          ? {
              attributes: {
                ...participant.attributes,
                ...(input.attributes as Record<string, string>),
              },
            }
          : {}),
        ...(input.permission && typeof input.permission === "object"
          ? { permission: input.permission as Record<string, boolean> }
          : {}),
      }
      this.state.participants.insert(this.state.participantId(input.room, input.identity), next)
      return this.json(this.publicParticipant(next))
    }
    if (method === "MutePublishedTrack") {
      const participant = this.participant(input.room, input.identity)
      const index = participant?.tracks.findIndex((track) => track.sid === input.trackSid) ?? -1
      if (
        !participant ||
        index < 0 ||
        typeof input.room !== "string" ||
        typeof input.identity !== "string"
      )
        return this.error("not_found", "track not found", 404)
      const track = { ...(participant.tracks[index] as LiveKitTrack), muted: input.muted === true }
      const tracks = [...participant.tracks]
      tracks[index] = track
      this.state.participants.insert(this.state.participantId(input.room, input.identity), {
        ...participant,
        tracks,
      })
      return this.json({ track })
    }
    if (method === "SendData") {
      if (typeof input.room !== "string" || !this.room(input.room))
        return this.error("not_found", "room not found", 404)
      const identities = Array.isArray(input.destinationIdentities)
        ? input.destinationIdentities
        : []
      const sids = Array.isArray(input.destinationSids) ? input.destinationSids : []
      const recipients = this.state.participants
        .list({
          where: (p) =>
            p.room === input.room &&
            ((!identities.length && !sids.length) ||
              identities.includes(p.identity) ||
              sids.includes(p.sid)),
        })
        .map(({ value }) => value)
      const message: DataMessage = {
        id: this.state.ids.next("DP_", 20),
        room: input.room,
        data: typeof input.data === "string" ? input.data : "",
        kind: typeof input.kind === "string" ? input.kind : "RELIABLE",
        ...(typeof input.topic === "string" ? { topic: input.topic } : {}),
        createdAt: this.now(),
      }
      for (const participant of recipients)
        this.state.inbox.insert(`${participant.sid}\0${message.id}`, {
          ...message,
          participantSid: participant.sid,
        })
      return this.json({})
    }
    return this.error("unimplemented", `RoomService.${method} is not implemented`, 501)
  }
  private async asyncService(service: "Egress" | "SIP", method: string, input: Input) {
    const kind = service === "Egress" ? "egress" : "sip"
    if (method.startsWith("List"))
      return this.json({
        items: this.state.resources
          .list({ where: (r) => r.kind === kind })
          .map(({ value }) => value.input),
      })
    if (method.startsWith("Stop") || method.startsWith("Delete")) {
      const id = String(
        input.egressId ?? input.sipCallId ?? input.sipTrunkId ?? input.sipDispatchRuleId ?? "",
      )
      const current = this.state.resources.get(id)
      if (!current) return this.error("not_found", `${kind} resource not found`, 404)
      const next = this.transitionResource(
        id,
        kind === "egress" ? "EGRESS_COMPLETE" : "DISCONNECTED",
      )
      return this.json(next?.input ?? {})
    }
    if (method.startsWith("Start") || method.startsWith("Create")) {
      const id = this.state.ids.next(kind === "egress" ? "EG_" : "SC_", 24)
      const roomName =
        typeof input.roomName === "string"
          ? input.roomName
          : typeof input.room === "string"
            ? input.room
            : undefined
      const output: Input =
        kind === "egress"
          ? {
              egressId: id,
              roomName: roomName ?? "",
              status: "EGRESS_STARTING",
              startedAt: String(this.now() * 1_000_000),
              ...input,
            }
          : {
              participantId: this.state.ids.next("PA_", 24),
              participantIdentity:
                typeof input.participantIdentity === "string"
                  ? input.participantIdentity
                  : `sip-${id}`,
              roomName: roomName ?? "",
              sipCallId: id,
            }
      const resource: AsyncResource = {
        id,
        kind,
        status: kind === "egress" ? "EGRESS_STARTING" : "DIALING",
        ...(roomName ? { roomName } : {}),
        input: output,
      }
      this.state.resources.insert(id, resource)
      this.emit(
        kind === "egress"
          ? { event: "egress_started", egressInfo: output }
          : { event: "sip_call_started", sipCall: output },
      )
      return this.json(output)
    }
    return this.error("unimplemented", `${service}.${method} is not implemented`, 501)
  }
  async fetch(request: Request) {
    if (request.method !== "POST")
      return this.error("bad_route", "Twirp endpoints require POST", 404)
    const match = new URL(request.url).pathname.match(
      /^\/twirp\/livekit\.(RoomService|Egress|SIP)\/([^/]+)$/,
    )
    if (!match) return this.error("bad_route", "unknown Twirp route", 404)
    const service = match[1] as "RoomService" | "Egress" | "SIP"
    const method = match[2] as string
    const input = (await request.json().catch(() => ({}))) as Input
    if (!(await this.authorize(request, service, method, input)))
      return this.error("unauthenticated", "invalid or insufficient LiveKit token", 401)
    return service === "RoomService"
      ? this.roomService(method, input)
      : this.asyncService(service, method, input)
  }
}
