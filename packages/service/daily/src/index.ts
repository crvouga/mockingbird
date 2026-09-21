import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  putObject,
  type S3Target,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { DailyState, type PresenceRecord, type RoomRecord, type Settings } from "./state.js"
import {
  claimsToProperties,
  decodeToken,
  KNOWN_CLAIMS,
  looksLikeMilliseconds,
  propertiesToClaims,
  signToken,
  toSeconds,
  verifySignature,
} from "./tokens.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { S3Target } from "@crvouga/mockingbird-service"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  PresenceRecord,
  RoomRecord,
  SessionRecord,
  Settings,
  WarningRecord,
} from "./state.js"
export {
  CLAIM_NAMES,
  claimsToProperties,
  decodeToken,
  propertiesToClaims,
  signToken,
  verifySignature,
} from "./tokens.js"

export const DAILY_NAMESPACE = "daily"

/** The transcript object our scribe reads from S3: `[{s: speaker userId, t, ts, te}]`. */
export type TranscriptEntry = { s: string; t: string; ts: number; te: number }

/** A Daily webhook event (`transcription.stopped`, `recording.ready-to-download`). */
export type DailyWebhook = {
  version: string
  type: string
  /** Our receiver reads `event`; Daily's documented envelope says `type`. Both are sent. */
  event: string
  id: string
  event_ts: number
  payload: Record<string, unknown>
}

export type SessionInput = {
  participants: { userId: string; userName?: string }[]
  durationSec: number
  /** The transcript to write; a synthetic one alternating between participants when omitted. */
  transcript?: TranscriptEntry[]
  sessionId?: string
  /** Also emit `recording.ready-to-download`. Default true. */
  recording?: boolean
}

export type SessionResult = {
  sessionId: string
  s3Key: string
  /** `s3://bucket/key`, or `null` when no S3 target is configured. */
  transcript: string | null
  events: string[]
}

/** Where `POST /__admin/rooms/:name/session` writes transcripts (the stack's s3rver / MinIO). */
export type TranscriptStore = S3Target & {
  /** Default `{roomName}/{sessionId}.json` (the EMR's `DAILY_TRANSCRIPT_S3_KEY_PATTERN`). */
  keyPattern?: string
}

export type TokenInspection = {
  /** Parsed as a JWT at all. */
  decodable: boolean
  header: Record<string, unknown> | null
  claims: Record<string, unknown> | null
  properties: Record<string, unknown> | null
  /** `true`/`false` when a key was available to check with, else `null`. */
  signatureValid: boolean | null
  room: { name: string; exists: boolean; nbf: number | null; exp: number | null } | null
  /** Whether the token would admit its holder now (signature, token window, room window). */
  joinable: boolean
  problems: string[]
  warnings: string[]
}

export type DailyAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  /** Called for every webhook event; the runtime signs and delivers it. */
  onWebhook?: (event: DailyWebhook) => void
  /** Transcript destination for admin sessions. */
  transcripts?: TranscriptStore
}

const DEFAULT_KEY_PATTERN = "{roomName}/{sessionId}.json"

const dailyError = (status: number, error: string, info: string) => jsonRes(status, { error, info })
const invalid = (info: string) => dailyError(400, "invalid-request-error", info)
const notFound = (name: string) => dailyError(404, "not-found", `room ${name} not found`)

const record = (context: OperationContext): Record<string, unknown> => {
  if (context.body.kind === "empty") return {}
  if (
    context.body.kind !== "json" ||
    typeof context.body.value !== "object" ||
    !context.body.value ||
    Array.isArray(context.body.value)
  ) {
    throw new HttpError(400, { error: "invalid-request-error", info: "body must be a JSON object" })
  }
  return context.body.value as Record<string, unknown>
}

const withSlash = (base: string) => (base.endsWith("/") ? base : `${base}/`)

/** The `Room` body Daily answers with. */
const roomView = (room: RoomRecord) => ({
  id: room.id,
  name: room.name,
  api_created: true,
  privacy: room.privacy,
  url: room.url,
  created_at: room.created_at,
  config: room.config,
})

/**
 * Stateful mock of the Daily.co REST API.
 *
 * Rooms echo the properties they were given as `config`; tokens are HS256 JWTs signed with
 * the caller's API key (like Daily's, and like the ones our backend self-signs), so any of
 * them can be verified and decoded. Media never flows: presence and sessions are set by
 * admin routes.
 */
export class DailyAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: DailyState
  private readonly service: Service
  private readonly now: () => number
  private readonly onWebhook: ((event: DailyWebhook) => void) | undefined
  private readonly transcripts: TranscriptStore | undefined

  constructor(options: DailyAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? DAILY_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.transcripts = options.transcripts
    this.state = new DailyState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      CreateRoom: (context) => this.createRoom(context),
      GetRoom: (context) => this.withRoom(context, (room) => jsonRes(200, roomView(room))),
      UpdateRoom: (context) => this.updateRoom(context),
      DeleteRoom: (context) => this.deleteRoom(context),
      GetRoomPresence: (context) =>
        this.withRoom(context, (room) =>
          jsonRes(200, {
            total_count: room.presence.length,
            data: room.presence.map((p) => ({
              room: room.name,
              id: p.id,
              userId: p.userId,
              userName: p.userName,
              joinTime: new Date(p.joinedAtMs).toISOString(),
              duration: Math.max(0, Math.floor((this.now() - p.joinedAtMs) / 1000)),
            })),
          }),
        ),
      EjectParticipants: (context) => this.eject(context),
      CreateMeetingToken: (context) => this.createToken(context),
      ValidateMeetingToken: (context) => this.validateToken(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => dailyError(404, "not-found", "not found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const key = bearerToken(context.request)
        if (!key) return dailyError(401, "authentication-error", "authorization header missing")
        const keys = this.state.current().apiKeys
        if (keys.length > 0 && !keys.includes(key)) {
          return dailyError(401, "authentication-error", "Invalid API key")
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000)
  }

  /** Validate the body against the contract, as Daily's `invalid-request-error`. */
  private validate(context: OperationContext): Response | undefined {
    const issues = bodyIssues(context)
    if (issues.length === 0) return undefined
    return invalid(issues.map((issue) => `${issue.path || "body"}: ${issue.message}`).join("; "))
  }

  /** Journal (and keep) a warning for each nbf/exp that is really milliseconds. */
  private checkTimes(
    operationId: string,
    subject: string,
    values: Record<string, unknown>,
  ): string | undefined {
    const odd: string[] = []
    for (const field of ["nbf", "exp"]) {
      const value = values[field]
      if (!looksLikeMilliseconds(value)) continue
      odd.push(field)
      this.state.warn({
        at: this.iso(),
        operationId,
        subject,
        field,
        value,
        message: `${field}=${value} looks like milliseconds; Daily expects unix seconds`,
      })
    }
    return odd.length > 0 ? `${odd.join(",")} in milliseconds` : undefined
  }

  private withRoom(
    context: OperationContext,
    handler: (room: RoomRecord) => Response | Promise<Response>,
  ): Response | Promise<Response> {
    const name = context.params.name ?? ""
    const room = this.state.rooms.get(name)
    if (!room || faultEffect(context.request, "room_not_found") !== undefined) return notFound(name)
    return handler(room)
  }

  private createRoom(context: OperationContext): Response {
    const body = record(context)
    const problem = this.validate(context)
    if (problem) return problem
    const name = typeof body.name === "string" ? body.name : this.state.nextRoomName()
    if (this.state.rooms.has(name)) return invalid(`a room named ${name} already exists`)
    const properties = (body.properties ?? {}) as Record<string, unknown>
    const warning = this.checkTimes("CreateRoom", name, properties)
    const room: RoomRecord = {
      id: this.state.nextUuid("room"),
      name,
      privacy: body.privacy === "private" ? "private" : "public",
      url: `${withSlash(this.state.current().roomUrlBase)}${name}`,
      created_at: this.iso(),
      config: properties,
      presence: [],
      sessions: [],
    }
    this.state.rooms.insert(name, room)
    return annotateResponse(jsonRes(200, roomView(room)), {
      ids: { roomName: name, ...(warning ? { warning } : {}) },
    })
  }

  private updateRoom(context: OperationContext): Response | Promise<Response> {
    return this.withRoom(context, (room) => {
      const body = record(context)
      const problem = this.validate(context)
      if (problem) return problem
      const properties = (body.properties ?? {}) as Record<string, unknown>
      const warning = this.checkTimes("UpdateRoom", room.name, properties)
      const next: RoomRecord = {
        ...room,
        privacy:
          body.privacy === "private" || body.privacy === "public" ? body.privacy : room.privacy,
        config: { ...room.config, ...properties },
      }
      this.state.rooms.update(room.name, next)
      return annotateResponse(jsonRes(200, roomView(next)), {
        ids: { roomName: room.name, ...(warning ? { warning } : {}) },
      })
    })
  }

  private deleteRoom(context: OperationContext): Response | Promise<Response> {
    return this.withRoom(context, (room) => {
      this.state.rooms.delete(room.name)
      return annotateResponse(jsonRes(200, { deleted: true, name: room.name }), {
        ids: { roomName: room.name },
      })
    })
  }

  private eject(context: OperationContext): Response | Promise<Response> {
    return this.withRoom(context, (room) => {
      const body = record(context)
      const problem = this.validate(context)
      if (problem) return problem
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])
      const userIds = new Set(Array.isArray(body.user_ids) ? body.user_ids.map(String) : [])
      const ejected: PresenceRecord[] = []
      const remaining: PresenceRecord[] = []
      for (const p of room.presence) {
        if (ids.has(p.id) || userIds.has(p.userId)) ejected.push(p)
        else remaining.push(p)
      }
      this.state.rooms.update(room.name, { ...room, presence: remaining })
      return annotateResponse(jsonRes(200, { ejectedIds: ejected.map((p) => p.id) }), {
        ids: { roomName: room.name },
      })
    })
  }

  private async createToken(context: OperationContext): Promise<Response> {
    const body = record(context)
    const problem = this.validate(context)
    if (problem) return problem
    const properties = body.properties as Record<string, unknown>
    const roomName = typeof properties.room_name === "string" ? properties.room_name : undefined
    const subject = roomName ?? "(any room)"
    const warning = this.checkTimes("CreateMeetingToken", subject, properties)
    if (roomName && !this.state.rooms.has(roomName)) {
      this.state.warn({
        at: this.iso(),
        operationId: "CreateMeetingToken",
        subject,
        field: "room_name",
        value: roomName,
        message: `token minted for room ${roomName}, which does not exist (yet)`,
      })
    }
    const claims = {
      ...propertiesToClaims(properties),
      d: this.state.current().domainId,
      iat: this.nowSeconds(),
    }
    const token = await signToken(claims, bearerToken(context.request) as string)
    return annotateResponse(jsonRes(200, { token }), {
      ids: { ...(roomName ? { roomName } : {}), ...(warning ? { warning } : {}) },
    })
  }

  private async validateToken(context: OperationContext): Promise<Response> {
    const decoded = decodeToken(context.params.token ?? "")
    if (!decoded) return invalid("token is not a valid meeting token")
    if (!(await verifySignature(decoded, bearerToken(context.request) as string))) {
      return invalid("token signature does not match this API key")
    }
    const now = this.nowSeconds()
    const nbf = toSeconds(decoded.claims.nbf)
    const exp = toSeconds(decoded.claims.exp)
    const ignoreNbf = context.url.searchParams.get("ignoreNbf") === "true"
    if (!ignoreNbf && nbf !== undefined && nbf > now) return invalid("token is not yet valid (nbf)")
    if (exp !== undefined && exp <= now) return invalid("token has expired (exp)")
    const properties = claimsToProperties(decoded.claims)
    return annotateResponse(jsonRes(200, properties), {
      ids: typeof properties.room_name === "string" ? { roomName: properties.room_name } : {},
    })
  }

  /**
   * Everything the mock can say about a token: decoded claims, signature (checked against
   * `keys`, else the namespace's `apiKeys`), the backend's strict claim schema, millisecond
   * timestamps, and the token/room time windows on the mock clock.
   */
  async inspectToken(token: string, keys: readonly string[] = []): Promise<TokenInspection> {
    const problems: string[] = []
    const warnings: string[] = []
    const decoded = decodeToken(token)
    if (!decoded) {
      return {
        decodable: false,
        header: null,
        claims: null,
        properties: null,
        signatureValid: false,
        room: null,
        joinable: false,
        problems: ["not a JWT"],
        warnings,
      }
    }
    const candidates = [...keys, ...this.state.current().apiKeys]
    let signatureValid: boolean | null = null
    if (candidates.length === 0) {
      warnings.push("no API key to verify the signature with (pass apiKey or set apiKeys)")
    } else {
      signatureValid = false
      for (const key of candidates) {
        if (await verifySignature(decoded, key)) signatureValid = true
      }
      if (!signatureValid) problems.push("signature does not match any known API key")
    }
    if (decoded.header.alg !== "HS256")
      problems.push(`alg ${String(decoded.header.alg)} is not HS256`)
    const claims = decoded.claims
    for (const claim of Object.keys(claims)) {
      if (!KNOWN_CLAIMS.has(claim)) warnings.push(`unknown claim ${claim}`)
    }
    if (typeof claims.r !== "string") warnings.push("no room (r): valid for every room")
    if (typeof claims.d !== "string") problems.push("missing domain id (d)")
    else if (claims.d !== this.state.current().domainId) {
      warnings.push(`domain id ${claims.d} is not this domain (${this.state.current().domainId})`)
    }
    if (typeof claims.ud === "string" && claims.ud.length > 36) {
      problems.push("user id (ud) is longer than 36 characters")
    }
    for (const field of ["nbf", "exp"]) {
      if (looksLikeMilliseconds(claims[field])) {
        warnings.push(`${field} looks like milliseconds`)
        this.state.warn({
          at: this.iso(),
          operationId: "InspectToken",
          subject: typeof claims.r === "string" ? claims.r : "(any room)",
          field,
          value: claims[field],
          message: `token ${field}=${String(claims[field])} looks like milliseconds`,
        })
      }
    }
    const now = this.nowSeconds()
    const nbf = toSeconds(claims.nbf)
    const exp = toSeconds(claims.exp)
    if (nbf !== undefined && nbf > now) problems.push("token not yet valid (nbf is in the future)")
    if (exp !== undefined && exp <= now) problems.push("token expired (exp is in the past)")
    let room: TokenInspection["room"] = null
    if (typeof claims.r === "string") {
      const found = this.state.rooms.get(claims.r)
      const roomNbf = toSeconds(found?.config.nbf) ?? null
      const roomExp = toSeconds(found?.config.exp) ?? null
      room = { name: claims.r, exists: found !== undefined, nbf: roomNbf, exp: roomExp }
      if (!found) problems.push(`room ${claims.r} does not exist`)
      else {
        // Owners may enter before the room's nbf (Daily lets an owner start the meeting).
        if (roomNbf !== null && roomNbf > now && claims.o !== true) {
          problems.push("room not yet open (room nbf is in the future)")
        }
        if (roomExp !== null && roomExp <= now)
          problems.push("room expired (room exp is in the past)")
      }
    }
    return {
      decodable: true,
      header: decoded.header,
      claims,
      properties: claimsToProperties(claims),
      signatureValid,
      room,
      joinable: problems.length === 0 && signatureValid !== false,
      problems,
      warnings,
    }
  }

  /** Put participants in a room (what `GET /v1/rooms/:name/presence` reports). */
  setPresence(
    name: string,
    participants: { userId: string; userName?: string; joinedAt?: string | number }[],
  ): RoomRecord | undefined {
    const room = this.state.rooms.get(name)
    if (!room) return undefined
    const presence = participants.map((p) => ({
      id: this.state.nextUuid("participant"),
      userId: p.userId,
      userName: p.userName ?? p.userId,
      joinedAtMs:
        p.joinedAt === undefined
          ? this.now()
          : typeof p.joinedAt === "number"
            ? p.joinedAt
            : Date.parse(p.joinedAt),
    }))
    const next = { ...room, presence }
    this.state.rooms.update(name, next)
    return next
  }

  /**
   * End a call: write the transcript to S3 at `{room}/{session}.json`, then emit
   * `transcription.stopped` (and `recording.ready-to-download`). The transcript text is
   * never kept in the mock's state.
   */
  async endSession(name: string, input: SessionInput): Promise<SessionResult | undefined> {
    const room = this.state.rooms.get(name)
    if (!room) return undefined
    const sessionId = input.sessionId ?? this.state.nextUuid("session")
    const pattern = this.transcripts?.keyPattern ?? DEFAULT_KEY_PATTERN
    const s3Key = pattern.replace("{roomName}", name).replace("{sessionId}", sessionId)
    const transcript =
      input.transcript ?? synthesizeTranscript(input.participants, input.durationSec)
    let uri: string | null = null
    if (this.transcripts) {
      uri = await putObject(this.transcripts, s3Key, JSON.stringify(transcript), "application/json")
    }
    const endedAt = this.now()
    const events: string[] = []
    const emit = (type: string, payload: Record<string, unknown>) => {
      events.push(type)
      this.onWebhook?.({
        version: "1.0.0",
        type,
        event: type,
        id: `evt_${this.state.nextUuid("event")}`,
        event_ts: Math.floor(endedAt / 1000),
        payload,
      })
    }
    emit("transcription.stopped", {
      room_name: name,
      session_id: sessionId,
      duration: input.durationSec,
      s3_key: s3Key,
      instance_id: this.state.nextUuid("instance"),
    })
    if (input.recording !== false) {
      emit("recording.ready-to-download", {
        type: "cloud",
        recording_id: this.state.nextUuid("recording"),
        room_name: name,
        session_id: sessionId,
        start_ts: Math.floor(endedAt / 1000) - input.durationSec,
        status: "finished",
        max_participants: input.participants.length,
        duration: input.durationSec,
        s3_key: s3Key.replace(/\.json$/, ".mp4"),
      })
    }
    this.state.rooms.update(name, {
      ...room,
      presence: [],
      sessions: [
        ...room.sessions,
        {
          sessionId,
          durationSec: input.durationSec,
          participants: input.participants.length,
          transcript: uri,
          endedAt: new Date(endedAt).toISOString(),
        },
      ],
    })
    return { sessionId, s3Key, transcript: uri, events }
  }

  rooms(): RoomRecord[] {
    return this.state.rooms.list({ order: "oldest" }).map((row) => row.value)
  }
}

/** A plausible transcript alternating between the participants across `durationSec`. */
export const synthesizeTranscript = (
  participants: { userId: string }[],
  durationSec: number,
): TranscriptEntry[] => {
  if (participants.length === 0) return []
  const lines = Math.max(2, Math.min(12, Math.floor(durationSec / 30)))
  const step = durationSec / lines
  return Array.from({ length: lines }, (_, i) => ({
    s: (participants[i % participants.length] as { userId: string }).userId,
    t: `Synthetic transcript line ${i + 1}.`,
    ts: Math.round(i * step * 100) / 100,
    te: Math.round((i + 1) * step * 100) / 100,
  }))
}

export type { DailyRuntime, DailyRuntimeOptions } from "./runtime.js"
export { createRuntime, DAILY_PRESETS, dailyWebhookSigner, WEBHOOK_PATH } from "./runtime.js"
