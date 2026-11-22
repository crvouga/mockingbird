/** Fetch-only Daily call-object stand-in. This does not load daily-js or Daily's CDN. */
export type BrowserOptions = {
  baseUrl: string
  adminPrefix?: string
  fetch?: (request: Request) => Promise<Response>
  headers?: HeadersInit
  pollIntervalMs?: number
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
}
type Presence = {
  id: string
  userId: string
  userName: string
  video?: boolean
  audio?: boolean
  owner?: boolean
}
export type CallParticipant = {
  session_id: string
  user_id: string
  user_name: string
  local: boolean
  owner: boolean
  tracks: { audio: CallTrack; video: CallTrack }
}
type CallTrack = {
  state: "off" | "playable" | "loading"
  persistentTrack: MediaStreamTrack | null
  track: MediaStreamTrack | null
}
export type CallEvent = {
  action: string
  participant?: CallParticipant
  participants?: Record<string, CallParticipant>
  error?: { type: string }
  errorMsg?: string
  track?: MediaStreamTrack
  type?: string
}
type Listener = (event: CallEvent) => void

export function createCallObject(options: BrowserOptions) {
  const listeners = new Map<string, Set<Listener>>()
  let state = "new"
  let room = ""
  let id = ""
  let participants: Record<string, CallParticipant> = {}
  let stream: MediaStream | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let destroyed = false
  let epoch = 0
  const emit = (action: string, detail: Omit<CallEvent, "action"> = {}) => {
    for (const listener of listeners.get(action) ?? []) listener({ action, ...detail })
  }
  const request = async (suffix: string, method = "GET", body?: unknown) => {
    const headers = new Headers(options.headers)
    headers.set("content-type", "application/json")
    const response = await (options.fetch ?? fetch)(
      new Request(
        `${options.baseUrl.replace(/\/$/, "")}${options.adminPrefix ?? "/__admin"}/rooms/${encodeURIComponent(room)}/participants${suffix}`,
        { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      ),
    )
    if (!response.ok) {
      const data = (await response.json()) as { error?: { type?: string }; errorMsg?: string }
      throw Object.assign(new Error(data.errorMsg ?? "Daily emulator request failed"), {
        type: data.error?.type ?? "ejected",
      })
    }
    return response.json()
  }
  const stopMedia = () => {
    for (const track of stream?.getTracks() ?? []) {
      emit("track-stopped", {
        track,
        type: track.kind,
        ...(participants.local ? { participant: participants.local } : {}),
      })
      track.stop()
    }
    stream = undefined
  }
  const convert = (p: Presence): CallParticipant => {
    const local = p.id === id
    const track = (kind: "audio" | "video"): CallTrack => {
      const media = local ? (stream?.getTracks().find((t) => t.kind === kind) ?? null) : null
      if (media) media.enabled = p[kind] !== false
      return {
        state: p[kind] === false ? "off" : media ? "playable" : "loading",
        track: media,
        persistentTrack: media,
      }
    }
    return {
      session_id: p.id,
      user_id: p.userId,
      user_name: p.userName,
      owner: p.owner === true,
      local,
      tracks: { audio: track("audio"), video: track("video") },
    }
  }
  const finish = () => {
    epoch++
    clearTimeout(timer)
    stopMedia()
    participants = {}
    state = "left-meeting"
    emit("left-meeting")
  }
  const refresh = async () => {
    if (state !== "joined-meeting") return
    const generation = epoch
    let rows: Presence[]
    try {
      rows = (await request("")) as Presence[]
    } catch {
      if (generation === epoch) finish()
      return
    }
    if (generation !== epoch) return
    if (!rows.some((p) => p.id === id)) {
      finish()
      return
    }
    const next: Record<string, CallParticipant> = {}
    for (const row of rows) {
      const participant = convert(row)
      const key = participant.local ? "local" : row.id
      next[key] = participant
      const previous = participants[key]
      if (!previous) emit("participant-joined", { participant })
      else if (
        previous.user_name !== participant.user_name ||
        previous.tracks.video.state !== participant.tracks.video.state ||
        previous.tracks.audio.state !== participant.tracks.audio.state
      )
        emit("participant-updated", { participant })
    }
    for (const [key, participant] of Object.entries(participants))
      if (!next[key]) emit("participant-left", { participant })
    participants = next
  }
  const poll = async () => {
    await refresh()
    if (state === "joined-meeting")
      timer = setTimeout(() => {
        void poll()
      }, options.pollIntervalMs ?? 100)
  }
  const setTrack = async (kind: "audio" | "video", enabled: boolean) => {
    if (state !== "joined-meeting") throw new Error("not joined")
    await request(`/${encodeURIComponent(id)}`, "PATCH", { [kind]: enabled })
    await refresh()
  }
  const call = {
    on(event: string, listener: Listener) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
      return call
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener)
      return call
    },
    meetingState: () => state,
    participants: () => participants,
    async join(input: {
      url: string
      token?: string
      userName?: string
      startVideoOff?: boolean
      startAudioOff?: boolean
    }) {
      if (destroyed || state === "joining-meeting" || state === "joined-meeting")
        throw new Error("call object is unavailable or already joined")
      const generation = ++epoch
      room = decodeURIComponent(new URL(input.url).pathname.split("/").filter(Boolean).at(-1) ?? "")
      state = "joining-meeting"
      emit("joining-meeting")
      try {
        const media =
          options.getUserMedia ??
          globalThis.navigator?.mediaDevices?.getUserMedia.bind(globalThis.navigator.mediaDevices)
        if (media) {
          try {
            stream = await media({ video: !input.startVideoOff, audio: !input.startAudioOff })
          } catch {
            emit("camera-error", {
              error: { type: "permissions" },
              errorMsg: "Unable to acquire local media",
            })
          }
        }
        if (generation !== epoch || destroyed) throw new Error("join cancelled")
        const row = (await request("", "POST", {
          browser: true,
          token: input.token,
          user_name: input.userName,
          video: !input.startVideoOff,
          audio: !input.startAudioOff,
        })) as Presence
        if (generation !== epoch || destroyed) {
          await request(`/${encodeURIComponent(row.id)}`, "DELETE")
          throw new Error("join cancelled")
        }
        id = row.id
        participants = { local: convert(row) }
        state = "joined-meeting"
        emit("joined-meeting", { participants })
        for (const track of stream?.getTracks() ?? [])
          emit("track-started", {
            track,
            type: track.kind,
            ...(participants.local ? { participant: participants.local } : {}),
          })
        await poll()
        return { participants }
      } catch (error) {
        stopMedia()
        state = "error"
        const type = error instanceof Error && "type" in error ? String(error.type) : "ejected"
        emit("error", { error: { type }, errorMsg: error instanceof Error ? error.message : type })
        throw error
      }
    },
    async leave() {
      if (state === "joined-meeting") {
        try {
          await request(`/${encodeURIComponent(id)}`, "DELETE")
        } finally {
          finish()
        }
      }
    },
    async destroy() {
      destroyed = true
      epoch++
      await call.leave()
      destroyed = true
      listeners.clear()
      stopMedia()
    },
    localAudio: () => participants.local?.tracks.audio.state !== "off",
    localVideo: () => participants.local?.tracks.video.state !== "off",
    setLocalVideo: (enabled: boolean) => setTrack("video", enabled),
    setLocalAudio: (enabled: boolean) => setTrack("audio", enabled),
    /** Deterministic alternative to waiting for the polling interval in tests. */
    refresh,
  }
  return call
}

/** One configured Daily factory per page; separate calls require separate factory instances. */
export function createDailyIframe(options: BrowserOptions) {
  let instance: ReturnType<typeof createCallObject> | undefined
  return {
    createCallObject(overrides: Partial<BrowserOptions> = {}) {
      if (instance) throw new Error("A Daily call object already exists; destroy it first")
      const call = createCallObject({ ...options, ...overrides })
      const destroy = call.destroy
      call.destroy = async () => {
        try {
          await destroy()
        } finally {
          if (instance === call) instance = undefined
        }
      }
      instance = call
      return call
    },
    getCallInstance: () => instance,
    async destroy() {
      await instance?.destroy()
    },
  }
}
