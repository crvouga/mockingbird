import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type LiveKitTrack = {
  sid: string
  name: string
  type: "AUDIO" | "VIDEO" | "DATA"
  source: string
  muted: boolean
  width?: number
  height?: number
}
export type LiveKitParticipant = {
  sid: string
  identity: string
  name: string
  metadata: string
  attributes: Record<string, string>
  joinedAt: number
  permission: Record<string, boolean>
  tracks: LiveKitTrack[]
}
export type LiveKitRoom = {
  sid: string
  name: string
  emptyTimeout: number
  departureTimeout: number
  maxParticipants: number
  creationTime: number
  metadata: string
  numParticipants: number
  numPublishers: number
  activeRecording: boolean
}
export type DataMessage = {
  id: string
  room: string
  data: string
  kind: string
  topic?: string
  createdAt: number
}
export type AsyncResource = {
  id: string
  kind: "egress" | "sip"
  status: string
  roomName?: string
  input: Record<string, unknown>
  error?: string
}
export class LiveKitState {
  readonly rooms: Collection<LiveKitRoom>
  readonly participants: Collection<LiveKitParticipant & { room: string }>
  readonly inbox: Collection<DataMessage & { participantSid: string }>
  readonly resources: Collection<AsyncResource>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.rooms = new Collection(sqlite, namespace, "livekit_rooms")
    this.participants = new Collection(sqlite, namespace, "livekit_participants")
    this.inbox = new Collection(sqlite, namespace, "livekit_inbox")
    this.resources = new Collection(sqlite, namespace, "livekit_resources")
    this.ids = new IdSequence(sqlite, namespace, "livekit")
  }
  participantId(room: string, identity: string) {
    return `${room}\0${identity}`
  }
}
