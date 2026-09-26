/**
 * A port of our Daily.co consumers:
 * - backend `DailyVideoService` (apps/backend …/appointments/daily-video.service.ts) with its
 *   strict zod schemas (daily-video.schemas.ts) and its self-signed HS256 meeting tokens;
 * - EMR `DailyService` (the consumer app's daily-service.ts) and the
 *   appointment flows that call it (book, reschedule, timing update, cancel, join);
 * - the EMR's `POST /v1/webhooks/daily` receiver and the scribe's S3 transcript read.
 * The acceptance tests drive the mock through it, so "the mock works" means "our consumer's
 * own logic reaches the right outcome".
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"

export type Fetch = (request: Request) => Promise<Response>

// --- zod schemas (daily-video.schemas.ts), hand-ported ----------------------------------

const ROOM_PROPERTY_KEYS = new Set([
  "nbf",
  "exp",
  "max_participants",
  "enable_people_ui",
  "enable_pip_ui",
  "enable_emoji_reactions",
  "enable_hand_raising",
  "enable_prejoin_ui",
  "enable_live_captions_ui",
  "enable_network_ui",
  "enable_noise_cancellation_ui",
  "enable_breakout_rooms",
  "enable_video_processing_ui",
  "enable_knocking",
  "enable_screenshare",
  "enable_chat",
  "enable_shared_chat_history",
  "enable_advanced_chat",
  "start_video_off",
  "start_audio_off",
  "owner_only_broadcast",
  "enable_recording",
  "eject_at_room_exp",
  "eject_after_elapsed",
  "enable_hidden_participants",
  "enable_mesh_sfu",
  "experimental_optimize_large_calls",
  "enable_terse_logging",
  "sfu_switchover",
  "enable_adaptive_simulcast",
  "enable_multiparty_adaptive_simulcast",
  "enforce_unique_user_ids",
  "lang",
  "meeting_join_hook",
  "geo",
  "rtmp_geo",
  "disable_rtmp_geo_fallback",
  "recordings_bucket",
  "transcription_bucket",
  "recordings_template",
  "transcription_template",
  "auto_transcription_settings",
  "enable_transcription_storage",
  "enable_dialout",
  "dialout_config",
  "streaming_endpoints",
  "permissions",
])

const TOKEN_PROPERTY_KEYS = new Set([
  "room_name",
  "knocking",
  "nbf",
  "exp",
  "eject_at_token_exp",
  "eject_after_elapsed",
  "is_owner",
  "user_name",
  "user_id",
  "enable_screenshare",
  "start_video_off",
  "start_audio_off",
  "enable_recording",
  "enable_recording_ui",
  "start_cloud_recording",
  "start_cloud_recording_opts",
  "auto_start_transcription",
  "enable_prejoin_ui",
  "enable_live_captions_ui",
  "enable_terse_logging",
  "close_tab_on_exit",
  "redirect_on_meeting_exit",
  "lang",
  "permissions",
])

const SELF_SIGNED_CLAIMS = new Set([
  "r",
  "d",
  "iat",
  "nbf",
  "exp",
  "ejt",
  "eje",
  "k",
  "o",
  "u",
  "ud",
  "ss",
  "vo",
  "ao",
  "er",
  "erui",
  "sr",
  "sro",
  "ast",
  "ctoe",
  "rome",
  "uil",
  "p",
])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const onlyKeys = (v: Record<string, unknown>, allowed: Set<string>) =>
  Object.keys(v).every((k) => allowed.has(k))

/** `DailyCreateRoomRequestSchema` (strict). */
export const isValidCreateRoomRequest = (v: unknown): boolean =>
  isObject(v) &&
  onlyKeys(v, new Set(["name", "privacy", "properties"])) &&
  (v.properties === undefined ||
    (isObject(v.properties) && onlyKeys(v.properties, ROOM_PROPERTY_KEYS)))

/** `DailyCreateRoomResponseSchema` (passthrough; `privacy` enum; five required strings). */
export const isValidCreateRoomResponse = (v: unknown): v is { name: string; url: string } =>
  isObject(v) &&
  typeof v.id === "string" &&
  typeof v.name === "string" &&
  (v.privacy === "public" || v.privacy === "private") &&
  typeof v.url === "string" &&
  typeof v.created_at === "string" &&
  (v.config === undefined || isObject(v.config))

/** `DailyCreateTokenRequestSchema` (strict). */
export const isValidCreateTokenRequest = (v: unknown): boolean =>
  isObject(v) &&
  onlyKeys(v, new Set(["properties"])) &&
  isObject(v.properties) &&
  onlyKeys(v.properties, TOKEN_PROPERTY_KEYS) &&
  (v.properties.user_id === undefined || String(v.properties.user_id).length <= 36)

/** `DailySelfSignedTokenPayloadSchema` (strict). */
export const isValidSelfSignedPayload = (v: Record<string, unknown>): boolean =>
  typeof v.r === "string" &&
  typeof v.d === "string" &&
  typeof v.iat === "number" &&
  onlyKeys(v, SELF_SIGNED_CLAIMS) &&
  (v.ud === undefined || String(v.ud).length <= 36)

/** `DailyRoomPresenceResponseSchema` (strict, participants strict). */
export const isValidPresenceResponse = (
  v: unknown,
): v is { total_count: number; data: { userId: string }[] } =>
  isObject(v) &&
  onlyKeys(v, new Set(["total_count", "data"])) &&
  typeof v.total_count === "number" &&
  Array.isArray(v.data) &&
  v.data.every(
    (p) =>
      isObject(p) &&
      onlyKeys(p, new Set(["room", "id", "userId", "userName", "joinTime", "duration"])) &&
      typeof p.room === "string" &&
      typeof p.id === "string" &&
      typeof p.userId === "string" &&
      typeof p.userName === "string" &&
      typeof p.joinTime === "string" &&
      typeof p.duration === "number",
  )

/** `DailyEjectUsersResponseSchema` (strict). */
export const isValidEjectResponse = (v: unknown): v is { ejectedIds: string[] } =>
  isObject(v) &&
  onlyKeys(v, new Set(["ejectedIds"])) &&
  Array.isArray(v.ejectedIds) &&
  v.ejectedIds.every((id) => typeof id === "string")

// --- a jsonwebtoken-compatible HS256 signer (what @nestjs/jwt produces) ------------------

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export const signHs256 = (payload: Record<string, unknown>, secret: string): string => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64url(JSON.stringify(payload))
  const signature = b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${signature}`
}

// --- backend DailyVideoService ------------------------------------------------------------

const VIDEO_MEETING_BUFFER_BEFORE_SECONDS_BACKEND = 5 * 60

export type BackendConfig = {
  apiKey: string
  /** `DAILY_API_BASE_URL` (includes `/v1`). */
  baseUrl: string
  domainId: string
  transcriptionBucket?: { name: string; region: string; roleArn: string }
}

export class DailyVideoServiceConsumer {
  /** The Redis caches the service keeps (provider/user UUIDs, room → provider mapping). */
  private readonly uuids = new Map<string, string>()
  readonly roomProvider = new Map<string, string>()

  constructor(
    private readonly config: BackendConfig,
    private readonly send: Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private headers() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` }
  }

  uuidFor(kind: "provider" | "user", id: string | number): string {
    const key = `${kind}:${id}`
    let found = this.uuids.get(key)
    if (!found) {
      found = randomUUID()
      this.uuids.set(key, found)
    }
    return found
  }

  async createRoom(appointmentStartTime: Date, appointmentEndTime: Date) {
    const bucket = this.config.transcriptionBucket
    const payload = {
      privacy: "private",
      properties: {
        enable_knocking: true,
        nbf: Math.floor(appointmentStartTime.getTime() / 1000),
        exp: Math.floor(appointmentEndTime.getTime() / 1000),
        eject_at_room_exp: true,
        max_participants: 3,
        enforce_unique_user_ids: true,
        enable_transcription_storage: true,
        transcription_bucket: bucket
          ? {
              bucket_name: bucket.name,
              bucket_region: bucket.region,
              assume_role_arn: bucket.roleArn,
              allow_api_access: true,
            }
          : undefined,
        enable_recording: "cloud",
        recordings_bucket: bucket
          ? {
              bucket_name: bucket.name,
              bucket_region: bucket.region,
              assume_role_arn: bucket.roleArn,
              allow_api_access: true,
            }
          : undefined,
      },
    }
    if (!isValidCreateRoomRequest(payload)) throw new Error("Invalid room creation payload")
    const response = await this.send(
      new Request(`${this.config.baseUrl}/rooms`, {
        method: "POST",
        headers: this.headers(),
        // JSON.stringify drops the undefined buckets, as zod's parse output does.
        body: JSON.stringify(payload),
      }),
    )
    if (!response.ok) throw new Error("Failed to create Daily.co room")
    const data = (await response.json()) as unknown
    if (!isValidCreateRoomResponse(data)) {
      throw new Error("Invalid response from Daily.co room creation")
    }
    return { roomId: data.name }
  }

  async createProviderToken(roomId: string, userName: string, providerId: string, expiry?: Date) {
    const payload = {
      properties: {
        room_name: roomId,
        is_owner: true,
        user_name: userName,
        user_id: this.uuidFor("provider", providerId),
        eject_at_token_exp: false,
        nbf: 0,
        auto_start_transcription: true,
        start_cloud_recording: true,
        enable_recording_ui: true,
        ...(expiry && { exp: Math.floor(expiry.getTime() / 1000) }),
      },
    }
    if (!isValidCreateTokenRequest(payload)) throw new Error("Invalid token creation payload")
    const response = await this.send(
      new Request(`${this.config.baseUrl}/meeting-tokens`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      }),
    )
    if (!response.ok) throw new Error("Failed to create Daily.co provider token")
    const data = (await response.json()) as { token?: unknown }
    if (typeof data.token !== "string")
      throw new Error("Invalid response from Daily.co token creation")
    return data.token
  }

  createSelfSignedProviderToken(
    roomId: string,
    userName: string,
    providerId: string,
    expiry?: Date,
  ) {
    const payload = {
      r: roomId,
      d: this.config.domainId,
      iat: Math.floor(this.now() / 1000),
      o: true,
      u: userName,
      ud: this.uuidFor("provider", providerId),
      ejt: false,
      nbf: 0,
      ast: true,
      sr: true,
      erui: true,
      ...(expiry && { exp: Math.floor(expiry.getTime() / 1000) }),
    }
    if (!isValidSelfSignedPayload(payload))
      throw new Error("Failed to create self-signed provider token")
    return signHs256(payload, this.config.apiKey)
  }

  createSelfSignedUserToken(
    roomId: string,
    userName: string,
    userId: string,
    appointmentStartTime?: Date,
    expiry?: Date,
  ) {
    const payload = {
      r: roomId,
      d: this.config.domainId,
      iat: Math.floor(this.now() / 1000),
      o: false,
      u: userName,
      ud: userId,
      ejt: true,
      nbf: appointmentStartTime
        ? Math.floor(appointmentStartTime.getTime() / 1000) -
          VIDEO_MEETING_BUFFER_BEFORE_SECONDS_BACKEND
        : 0,
      ...(expiry && { exp: Math.floor(expiry.getTime() / 1000) }),
    }
    if (!isValidSelfSignedPayload(payload))
      throw new Error("Failed to create self-signed user token")
    return signHs256(payload, this.config.apiKey)
  }

  /** `getOrCreateUserAccessToken` minus the Redis cache. */
  userAccessToken(roomId: string, userName: string, userId: number, start?: Date, expiry?: Date) {
    return this.createSelfSignedUserToken(
      roomId,
      userName,
      this.uuidFor("user", userId),
      start,
      expiry,
    )
  }

  storeRoomProviderMapping(roomId: string, providerId: string) {
    this.roomProvider.set(roomId, this.uuidFor("provider", providerId))
  }

  async checkRoomPresence(roomId: string, userId: number) {
    const providerUuid = this.roomProvider.get(roomId)
    if (!providerUuid) return { isOwnerPresent: false, isUserPresent: false }
    try {
      const response = await this.send(
        new Request(`${this.config.baseUrl}/rooms/${roomId}/presence`, {
          method: "GET",
          headers: this.headers(),
        }),
      )
      if (!response.ok) return { isOwnerPresent: false, isUserPresent: false }
      const data = (await response.json()) as unknown
      if (!isValidPresenceResponse(data)) return { isOwnerPresent: false, isUserPresent: false }
      const userUuid = this.uuidFor("user", userId)
      return {
        isOwnerPresent: data.data.some((p) => p.userId === providerUuid),
        isUserPresent: data.data.some((p) => p.userId === userUuid),
      }
    } catch {
      return { isOwnerPresent: false, isUserPresent: false }
    }
  }

  async ejectUsersFromRoom(roomName: string, userIds: number[]) {
    const userUuids = userIds.map((id) => this.uuidFor("user", id))
    const response = await this.send(
      new Request(`${this.config.baseUrl}/rooms/${roomName}/eject`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ user_ids: userUuids }),
      }),
    )
    if (!response.ok) throw new Error("Failed to eject users from room")
    const data = (await response.json()) as unknown
    if (!isValidEjectResponse(data)) throw new Error("Failed to eject users from room")
    return data
  }
}

// --- EMR DailyService + the appointment flows -------------------------------------------

export const VIDEO_MEETING_BUFFER_BEFORE_SECONDS = 5 * 60
export const VIDEO_MEETING_BUFFER_AFTER_SECONDS = 60 * 60
export const PATIENT_TOKEN_FALLBACK_EXPIRY_SECONDS = 4 * 60 * 60

export type EmrConfig = {
  apiKey: string
  /** `DailyService.baseUrl` (hardcoded `https://api.daily.co/v1` today; env-driven after G-D1). */
  baseUrl: string
  /** `DEFAULT_DAILY_BASE_URL` (`https://acme.daily.co/`; env-driven after G-D1). */
  roomBaseUrl: string
  bucket?: { name: string; region: string; roleArn: string }
}

export type DailyRoom = { name: string; url: string; id: string; config: Record<string, unknown> }

export class DailyEmrConsumer {
  constructor(
    private readonly config: EmrConfig,
    private readonly send: Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async call(path: string, method: string, body?: unknown): Promise<Response> {
    const response = await this.send(
      new Request(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return response
  }

  private async fail(response: Response): Promise<never> {
    const errorText = await response.text()
    throw new Error(`Daily.co API error: ${response.status} ${response.statusText} - ${errorText}`)
  }

  async createRoom(config: unknown): Promise<DailyRoom> {
    const response = await this.call("/rooms", "POST", config)
    if (!response.ok) return this.fail(response)
    return (await response.json()) as DailyRoom
  }

  async createToken(config: unknown): Promise<{ token: string }> {
    const response = await this.call("/meeting-tokens", "POST", config)
    if (!response.ok) return this.fail(response)
    return (await response.json()) as { token: string }
  }

  async updateRoom(roomName: string, patch: unknown): Promise<DailyRoom> {
    const response = await this.call(`/rooms/${roomName}`, "POST", patch)
    if (!response.ok) return this.fail(response)
    return (await response.json()) as DailyRoom
  }

  async deleteRoom(roomName: string): Promise<void> {
    const response = await this.call(`/rooms/${roomName}`, "DELETE")
    if (!response.ok && response.status !== 404) await this.fail(response)
  }

  generateRoomConfig(appointmentEndTime: number, appointmentDuration: number) {
    const bucket = this.config.bucket
    const nbf = appointmentEndTime - appointmentDuration - VIDEO_MEETING_BUFFER_BEFORE_SECONDS
    const exp = appointmentEndTime + VIDEO_MEETING_BUFFER_AFTER_SECONDS
    const ejectAfter = appointmentDuration + VIDEO_MEETING_BUFFER_AFTER_SECONDS
    const bucketConfig = bucket
      ? {
          bucket_name: bucket.name,
          bucket_region: bucket.region,
          assume_role_arn: bucket.roleArn,
          allow_api_access: true,
        }
      : undefined
    return {
      privacy: "private",
      properties: {
        nbf,
        exp,
        eject_after_elapsed: ejectAfter,
        max_participants: 3,
        enable_prejoin_ui: true,
        enable_people_ui: true,
        enable_pip_ui: false,
        enable_emoji_reactions: true,
        enable_hand_raising: true,
        enable_live_captions_ui: true,
        enable_network_ui: true,
        enable_noise_cancellation_ui: true,
        enable_breakout_rooms: false,
        enable_knocking: true,
        enable_screenshare: false,
        enable_video_processing_ui: true,
        enable_chat: true,
        enable_shared_chat_history: false,
        start_video_off: false,
        start_audio_off: false,
        owner_only_broadcast: false,
        enable_recording: "cloud",
        eject_at_room_exp: true,
        enable_advanced_chat: false,
        enable_hidden_participants: false,
        enable_mesh_sfu: false,
        sfu_switchover: 2,
        enable_adaptive_simulcast: true,
        enable_multiparty_adaptive_simulcast: false,
        enforce_unique_user_ids: true,
        experimental_optimize_large_calls: false,
        close_tab_on_exit: false,
        lang: "en",
        enable_transcription_storage: true,
        transcription_bucket: bucketConfig,
        recordings_bucket: bucketConfig,
        geo: "us-west-2",
        rtmp_geo: "us-west-2",
        enable_terse_logging: false,
        permissions: {
          hasPresence: true,
          canSend: ["video", "audio"],
          canReceive: { base: true },
          canAdmin: false,
        },
      },
    }
  }

  generateProviderTokenConfig(
    roomName: string,
    providerId: string,
    providerName: string,
    appointmentEndTime: number,
  ) {
    return {
      properties: {
        room_name: roomName,
        exp: appointmentEndTime + 4 * 3600,
        is_owner: true,
        user_name: providerName,
        user_id: providerId.slice(0, 36),
        eject_at_token_exp: false,
        eject_after_elapsed: 3600,
        enable_screenshare: true,
        start_video_off: false,
        start_audio_off: false,
        enable_recording: "cloud",
        start_cloud_recording: true,
        auto_start_transcription: true,
        enable_recording_ui: true,
        enable_prejoin_ui: true,
        enable_live_captions_ui: true,
        enable_terse_logging: false,
        close_tab_on_exit: false,
        lang: "en",
        permissions: {
          hasPresence: true,
          canSend: ["video", "audio", "screenVideo", "screenAudio"],
          canReceive: { base: true },
          canAdmin: ["participants", "streaming", "transcription"],
        },
      },
    }
  }

  generateApprovedPatientTokenConfig(
    roomName: string,
    patientId: string,
    patientName: string,
    appointmentEndTime: number,
    appointmentStartTime?: number,
  ) {
    const scopedStart =
      typeof appointmentStartTime === "number" && Number.isFinite(appointmentStartTime)
        ? appointmentStartTime
        : undefined
    const scoped = scopedStart !== undefined
    const nbf =
      scopedStart !== undefined ? scopedStart - VIDEO_MEETING_BUFFER_BEFORE_SECONDS : undefined
    const exp = scoped
      ? appointmentEndTime + VIDEO_MEETING_BUFFER_AFTER_SECONDS
      : appointmentEndTime + PATIENT_TOKEN_FALLBACK_EXPIRY_SECONDS
    return {
      properties: {
        room_name: roomName,
        exp,
        is_owner: false,
        user_name: patientName,
        user_id: patientId.slice(0, 36),
        ...(nbf !== undefined ? { nbf } : {}),
        eject_at_token_exp: scoped,
        ...(scoped ? {} : { eject_after_elapsed: 3600 }),
        enable_screenshare: false,
        start_video_off: false,
        start_audio_off: false,
        enable_recording: false,
        enable_recording_ui: false,
        enable_prejoin_ui: true,
        enable_live_captions_ui: true,
        enable_terse_logging: false,
        close_tab_on_exit: false,
        lang: "en",
        permissions: {
          hasPresence: true,
          canSend: ["video", "audio"],
          canReceive: { base: true },
          canAdmin: false,
        },
      },
    }
  }

  /** `addVideoMeetingToAppointment`: one room, one provider token, the join URLs. */
  async addVideoMeetingToAppointment(appointment: {
    start: string
    end: string
    providerId: string
    providerName: string
  }) {
    const startTime = new Date(appointment.start).getTime()
    const endTime = new Date(appointment.end).getTime()
    const appointmentDuration = Math.floor((endTime - startTime) / 1000)
    const appointmentEndTime = Math.floor(endTime / 1000)
    const room = await this.createRoom(
      this.generateRoomConfig(appointmentEndTime, appointmentDuration),
    )
    const providerToken = await this.createToken(
      this.generateProviderTokenConfig(
        room.name,
        appointment.providerId,
        appointment.providerName,
        appointmentEndTime,
      ),
    )
    return {
      roomId: room.name,
      roomUrl: room.url,
      providerToken: providerToken.token,
      providerJoinUrl: `${this.config.roomBaseUrl}${room.name}?t=${providerToken.token}`,
      patientJoinUrl: `${this.config.roomBaseUrl}${room.name}`,
    }
  }

  /**
   * `createAppointmentVideoMeeting`: creates a room from its own config, then calls
   * `addVideoMeetingToAppointment`, which creates another. The first is orphaned.
   */
  async createAppointmentVideoMeeting(appointment: {
    start: string
    end: string
    providerId: string
    providerName: string
  }) {
    const startTime = new Date(appointment.start).getTime()
    const endTime = new Date(appointment.end).getTime()
    const orphan = await this.createRoom(
      this.generateRoomConfig(Math.floor(endTime / 1000), Math.floor((endTime - startTime) / 1000)),
    )
    return {
      orphanRoom: orphan.name,
      meeting: await this.addVideoMeetingToAppointment(appointment),
    }
  }

  /** `updateAppointmentVideoMeetingTiming` */
  async updateAppointmentVideoMeetingTiming(roomId: string, newStartTime: Date, newEndTime: Date) {
    try {
      const endTimeSeconds = Math.floor(newEndTime.getTime() / 1000)
      const durationSeconds = Math.floor((newEndTime.getTime() - newStartTime.getTime()) / 1000)
      const roomUpdate = {
        properties: {
          nbf: endTimeSeconds - durationSeconds - VIDEO_MEETING_BUFFER_BEFORE_SECONDS,
          exp: endTimeSeconds + VIDEO_MEETING_BUFFER_AFTER_SECONDS,
          eject_after_elapsed: durationSeconds + VIDEO_MEETING_BUFFER_AFTER_SECONDS,
        },
      }
      try {
        await this.updateRoom(roomId, roomUpdate)
      } catch (dailyError) {
        if (dailyError instanceof Error && dailyError.message.includes("404")) {
          return { success: false, message: "Video meeting room no longer exists" }
        }
        throw dailyError
      }
      return { success: true, message: "Video meeting timing updated successfully" }
    } catch (error) {
      return {
        success: false,
        message: `Failed to update video meeting timing: ${error instanceof Error ? error.message : "Unknown error"}`,
      }
    }
  }

  /** The reschedule path (`…VideoMeeting` handling in the reschedule transaction). */
  async rescheduleVideoMeeting(
    meeting: { roomId: string },
    serviceEnd: Date,
    durationMinutes: number,
    provider: { id: string; name: string },
    newStatus: string,
  ) {
    if (newStatus === "cancelled") {
      try {
        await this.deleteRoom(meeting.roomId)
      } catch {
        // "Failed deleting Daily room (ignored)"
      }
      return undefined
    }
    const appointmentEndEpoch = Math.floor(serviceEnd.getTime() / 1000)
    const nbf = appointmentEndEpoch - durationMinutes * 60 - VIDEO_MEETING_BUFFER_BEFORE_SECONDS
    const exp = appointmentEndEpoch + VIDEO_MEETING_BUFFER_AFTER_SECONDS
    try {
      await this.updateRoom(meeting.roomId, { properties: { exp, nbf, max_participants: 3 } })
      const token = await this.createToken(
        this.generateProviderTokenConfig(
          meeting.roomId,
          provider.id,
          provider.name,
          appointmentEndEpoch,
        ),
      )
      return {
        roomId: meeting.roomId,
        roomExpiresAt: new Date(exp * 1000).toISOString(),
        providerToken: token.token,
        providerJoinUrl: `${this.config.roomBaseUrl}${meeting.roomId}?t=${token.token}`,
      }
    } catch {
      return { roomId: meeting.roomId, failed: true as const }
    }
  }

  /** `getVideoMeeting` for a practitioner: reset nbf, fresh owner token. */
  async providerJoinUrl(roomId: string, providerId: string, providerName: string, end: string) {
    await this.updateRoom(roomId, { properties: { nbf: Math.floor(this.now() / 1000) - 300 } })
    const token = await this.createToken(
      this.generateProviderTokenConfig(
        roomId,
        providerId,
        providerName,
        Math.floor(new Date(end).getTime() / 1000),
      ),
    )
    return `${this.config.roomBaseUrl}${roomId}?t=${token.token}`
  }

  /** `getVideoMeeting` for a patient (the member-app join): a scoped token, else the knock URL. */
  async patientJoinUrl(
    roomId: string,
    patientId: string,
    patientName: string,
    start: string,
    end: string,
  ) {
    const fallbackUrl = `${this.config.roomBaseUrl}${roomId}`
    try {
      const token = await this.createToken(
        this.generateApprovedPatientTokenConfig(
          roomId,
          patientId,
          patientName,
          Math.floor(Date.parse(end) / 1000),
          Math.floor(Date.parse(start) / 1000),
        ),
      )
      return `${this.config.roomBaseUrl}${roomId}?t=${token.token}`
    } catch {
      return fallbackUrl
    }
  }

  /** `generatePatientToken`: passes `Date.parse(end)` — milliseconds — as the end time. */
  async generatePatientToken(roomId: string, patientId: string, patientName: string, end: string) {
    return this.createToken(
      this.generateApprovedPatientTokenConfig(roomId, patientId, patientName, Date.parse(end)),
    )
  }
}

/** member-app `extractRoomToken`: the `t` query param of a room URL. */
export const extractRoomToken = (urlOrId: string): string | undefined => {
  try {
    const token = new URL(urlOrId).searchParams.get("t")
    return token ? token : undefined
  } catch {
    return undefined
  }
}

// --- EMR webhook receiver + scribe transcript read ------------------------------------------

export const MINIMUM_CALL_DURATION_SECONDS = 60

export type ScribeMapping = {
  roomName: string
  appointmentId: string
  role: "provider" | "member"
  fhirResourceId: string
}

export type EnqueuedTranscriptJob = {
  appointmentId: string
  roomName: string
  sessionId: string
  practitionerId: string
  patientId: string
  callDurationSeconds: number
}

/** `WebhookControllerImpl.handleDailyWebhook` + `handleTranscriptionStopped`. */
export class DailyWebhookReceiver {
  readonly jobs: EnqueuedTranscriptJob[] = []

  constructor(
    private readonly secret: string | undefined,
    private readonly mappings: ScribeMapping[] = [],
  ) {}

  receive(rawBody: Buffer, headers: Headers): { status: number; body: Record<string, unknown> } {
    const signature = headers.get("x-webhook-signature") ?? undefined
    if (this.secret) {
      if (!signature) return { status: 401, body: { error: "Missing signature" } }
      const expectedSig = createHmac("sha256", this.secret).update(rawBody).digest("hex")
      const sigBuf = Buffer.from(signature)
      const expectedBuf = Buffer.from(expectedSig)
      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        return { status: 401, body: { error: "Invalid signature" } }
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody.toString("utf-8"))
    } catch {
      return { status: 400, body: { error: "Invalid JSON payload" } }
    }
    if (!isDailyWebhookPayload(parsed))
      return { status: 400, body: { error: "Invalid Daily payload" } }
    if (parsed.event === "transcription.stopped") return this.transcriptionStopped(parsed)
    return { status: 200, body: { acknowledged: true } }
  }

  private transcriptionStopped(payload: DailyWebhookPayload) {
    const { room_name: roomName, session_id: sessionId, duration } = payload.payload
    if (!roomName || !sessionId) {
      return { status: 200, body: { acknowledged: true, skipped: "missing-room-data" } }
    }
    const callDuration = duration ?? 0
    if (callDuration < MINIMUM_CALL_DURATION_SECONDS) {
      return { status: 200, body: { acknowledged: true, skipped: "duration-below-threshold" } }
    }
    const mappings = this.mappings.filter((m) => m.roomName === roomName)
    if (mappings.length === 0) {
      return { status: 200, body: { acknowledged: true, skipped: "no-matching-appointment" } }
    }
    const provider = mappings.find((m) => m.role === "provider")
    const member = mappings.find((m) => m.role === "member")
    const practitionerId = provider?.fhirResourceId.split("/")[1] ?? provider?.fhirResourceId
    const patientId = member?.fhirResourceId.split("/")[1] ?? member?.fhirResourceId
    if (!practitionerId || !patientId) {
      return { status: 200, body: { acknowledged: true, skipped: "missing-participants" } }
    }
    this.jobs.push({
      appointmentId: (mappings[0] as ScribeMapping).appointmentId,
      roomName,
      sessionId,
      practitionerId,
      patientId,
      callDurationSeconds: callDuration,
    })
    return { status: 200, body: { acknowledged: true } }
  }
}

type DailyWebhookPayload = {
  event: string
  version: string
  payload: { room_name?: string; session_id?: string; s3_key?: string; duration?: number }
}

const isDailyWebhookPayload = (value: unknown): value is DailyWebhookPayload => {
  if (!isObject(value) || !isObject(value.payload)) return false
  const payload = value.payload
  return (
    typeof value.event === "string" &&
    typeof value.version === "string" &&
    (payload.duration === undefined || typeof payload.duration === "number") &&
    (["room_name", "session_id", "s3_key"] as const).every(
      (key) => payload[key] === undefined || typeof payload[key] === "string",
    )
  )
}

/** `S3TranscriptAdapter.getTranscript`'s key and `DailyTranscriptSchema` parse. */
export const readTranscript = (
  getObject: (bucket: string, key: string) => string | undefined,
  bucket: string,
  roomName: string,
  sessionId: string,
  keyPattern = "{roomName}/{sessionId}.json",
): { s: string; t: string; ts: number; te: number }[] => {
  const key = keyPattern.replace("{roomName}", roomName).replace("{sessionId}", sessionId)
  const body = getObject(bucket, key)
  if (!body) throw new Error(`Empty transcript file at s3://${bucket}/${key}`)
  const parsed = JSON.parse(body) as unknown
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (e) =>
        isObject(e) &&
        typeof e.s === "string" &&
        typeof e.t === "string" &&
        typeof e.ts === "number" &&
        typeof e.te === "number",
    )
  ) {
    throw new Error(`Invalid transcript payload at s3://${bucket}/${key}`)
  }
  return parsed as { s: string; t: string; ts: number; te: number }[]
}

// --- an in-process fake S3 that verifies SigV4 independently -------------------------------

const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")
const hmacRaw = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest()

/**
 * A path-style S3 `PutObject` endpoint (s3rver's shape) that checks every request's SigV4
 * header shape and signature with `node:crypto`, and stores what it accepts.
 */
export class FakeS3 {
  readonly objects = new Map<string, { body: string; contentType: string | null }>()
  readonly rejected: string[] = []

  constructor(
    private readonly credentials = { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
  ) {}

  get(bucket: string, key: string): string | undefined {
    return this.objects.get(`${bucket}/${key}`)?.body
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const body = Buffer.from(await request.arrayBuffer())
    const problem = this.verify(request, url, body)
    if (problem) {
      this.rejected.push(problem)
      return new Response(
        `<Error><Code>SignatureDoesNotMatch</Code><Message>${problem}</Message></Error>`,
        {
          status: 403,
        },
      )
    }
    if (request.method !== "PUT") return new Response("", { status: 405 })
    const [, bucket, ...key] = url.pathname.split("/")
    this.objects.set(
      `${decodeURIComponent(bucket as string)}/${key.map(decodeURIComponent).join("/")}`,
      {
        body: body.toString("utf-8"),
        contentType: request.headers.get("content-type"),
      },
    )
    return new Response("", { status: 200, headers: { etag: `"${sha256Hex(body).slice(0, 32)}"` } })
  }

  private verify(request: Request, url: URL, body: Buffer): string | undefined {
    const authorization = request.headers.get("authorization") ?? ""
    const shape =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([a-z0-9-]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
        authorization,
      )
    if (!shape) return `malformed authorization header: ${authorization.slice(0, 40)}`
    const [, accessKeyId, date, region, signedHeaders, signature] = shape as unknown as string[]
    if (accessKeyId !== this.credentials.accessKeyId) return "unknown access key"
    const amzDate = request.headers.get("x-amz-date") ?? ""
    if (!/^\d{8}T\d{6}Z$/.test(amzDate) || !amzDate.startsWith(date as string))
      return "bad x-amz-date"
    const payloadHash = request.headers.get("x-amz-content-sha256")
    if (payloadHash !== sha256Hex(body)) return "x-amz-content-sha256 does not match the body"
    const names = (signedHeaders as string).split(";")
    for (const required of ["host", "x-amz-content-sha256", "x-amz-date"]) {
      if (!names.includes(required)) return `SignedHeaders lacks ${required}`
    }
    const headerValue = (name: string) =>
      name === "host" ? url.host : (request.headers.get(name) ?? "")
    const canonical = [
      request.method,
      url.pathname,
      "",
      names.map((n) => `${n}:${headerValue(n).trim()}\n`).join(""),
      signedHeaders,
      payloadHash,
    ].join("\n")
    const scope = `${date}/${region}/s3/aws4_request`
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n")
    let key = hmacRaw(`AWS4${this.credentials.secretAccessKey}`, date as string)
    key = hmacRaw(key, region as string)
    key = hmacRaw(key, "s3")
    key = hmacRaw(key, "aws4_request")
    const expected = createHmac("sha256", key).update(toSign).digest("hex")
    return expected === signature ? undefined : "signature does not match"
  }
}
