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
  packet?: string
  senderIdentity?: string
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
export const JOB_STATUSES = ["JS_PENDING", "JS_RUNNING", "JS_SUCCESS", "JS_FAILED"] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export type AgentJob = {
  id: string
  dispatchId: string
  type: "JT_ROOM"
  room: Omit<LiveKitRoom, "creationTime"> & { creationTime: string }
  metadata: string
  agentName: string
  state: {
    status: JobStatus
    error: string
    startedAt: string
    endedAt: string
    updatedAt: string
    participantIdentity: string
    workerId: string
    agentId: string
  }
}
export type AgentDispatch = {
  id: string
  agentName: string
  room: string
  metadata: string
  state: { jobs: AgentJob[]; createdAt: string; deletedAt: string }
}

export class LiveKitState {
  readonly rooms: Collection<LiveKitRoom>
  readonly dispatches: Collection<AgentDispatch>
  readonly participants: Collection<LiveKitParticipant & { room: string }>
  readonly inbox: Collection<DataMessage & { participantSid: string }>
  readonly connections: Collection<{
    id: string
    room: string
    identity: string
    state: "open" | "reconnecting" | "closed"
    openedAt: number
    updatedAt: number
    resumes: number
  }>
  readonly media: Collection<{
    room: string
    identity: string
    trackSid: string
    packetsReceived: number
    bytesReceived: number
  }>
  readonly resources: Collection<AsyncResource>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.rooms = new Collection(sqlite, namespace, "livekit_rooms")
    this.dispatches = new Collection(sqlite, namespace, "livekit_dispatches")
    this.participants = new Collection(sqlite, namespace, "livekit_participants")
    this.inbox = new Collection(sqlite, namespace, "livekit_inbox")
    this.connections = new Collection(sqlite, namespace, "livekit_connections")
    this.media = new Collection(sqlite, namespace, "livekit_media")
    this.resources = new Collection(sqlite, namespace, "livekit_resources")
    this.ids = new IdSequence(sqlite, namespace, "livekit")
  }
  participantId(room: string, identity: string) {
    return `${room}\0${identity}`
  }
}
