import {
  Codec,
  DataPacket,
  DataPacket_Kind,
  DisconnectReason,
  JoinResponse,
  LeaveRequest,
  LeaveRequest_Action,
  ParticipantInfo,
  ParticipantInfo_State,
  ParticipantPermission,
  ParticipantUpdate,
  Pong,
  ReconnectResponse,
  Room,
  ServerInfo,
  SessionDescription,
  SignalRequest,
  SignalResponse,
  SignalTarget,
  SpeakerInfo,
  SpeakersChanged,
  TrackInfo,
  TrackPublishedResponse,
  TrackSource,
  TrackType,
  Transcription,
  TranscriptionSegment,
  TrickleRequest,
  UserPacket,
} from "@livekit/protocol"
import type { LiveKitEvent } from "./index.js"
import { type AudioFactory, type AudioSource, createBrowserAudio } from "./signal-audio.js"
import type { SignalState } from "./signal-state.js"
import type { LiveKitParticipant } from "./state.js"

export type SignalPeer = {
  url: URL
  accept(): void
  refuse(): void
  deliver(bytes: Uint8Array): void
  close(code?: number, reason?: string): void
  drop?(): void
  onMessage(listener: (bytes: Uint8Array) => void): void
  onClose(listener: () => void): void
}
type Signal = SignalResponse["message"]
const info = (participant: LiveKitParticipant) =>
  new ParticipantInfo({
    sid: participant.sid,
    identity: participant.identity,
    name: participant.name,
    metadata: participant.metadata,
    attributes: participant.attributes,
    joinedAt: BigInt(Math.floor(participant.joinedAt / 1000)),
    state: ParticipantInfo_State.ACTIVE,
    version: 1,
    permission: new ParticipantPermission(participant.permission),
    tracks: participant.tracks.map(
      (track) =>
        new TrackInfo({
          sid: track.sid,
          name: track.name,
          type: track.type === "AUDIO" ? TrackType.AUDIO : TrackType.VIDEO,
          source: track.source === "MICROPHONE" ? TrackSource.MICROPHONE : TrackSource.CAMERA,
          muted: track.muted,
          mimeType: track.type === "AUDIO" ? "audio/opus" : "video/VP8",
        }),
    ),
  })

/** Page-side WebRTC fixture endpoint over an injected signaling transport, scoped to one API namespace. */
export function createBrowserSignalServer(options: {
  api: SignalState
  createPeerConnection?: () => RTCPeerConnection
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream
  createAudio?: AudioFactory
  onTrack?: (track: MediaStreamTrack, participant: { room: string; identity: string }) => void
  onData?: (packet: DataPacket, participant: { room: string; identity: string }) => void
}) {
  const api = options.api
  const backendId = crypto.randomUUID()
  const createAudio =
    options.createAudio ?? (typeof AudioContext !== "undefined" ? createBrowserAudio : undefined)
  let disposed = false
  const activeAudio = new Set<{ room: string; identity: string; stop(): void }>()
  const cleanup = new Set<Promise<unknown>>()
  const closing = (work: unknown) => {
    const promise = Promise.resolve(work)
      .catch(() => {})
      .finally(() => cleanup.delete(promise))
    cleanup.add(promise)
  }
  const ready = Promise.resolve(api.audioBackend(backendId, Boolean(createAudio)))
  const sessions = new Map<
    string,
    {
      room: string
      identity: string
      send(message: Signal): void
      data(packet: DataPacket): Promise<void>
      close(reason?: DisconnectReason): void
      disconnect(): void
      resume(peer: SignalPeer): void
      audio(
        track: MediaStreamTrack,
        participantSid: string,
        trackSid: string,
      ): Promise<(() => void) | undefined>
    }
  >()
  const peerConnection = options.createPeerConnection ?? (() => new RTCPeerConnection())
  const observed = async (event: LiveKitEvent) => {
    if (event.event === "signal_audio" && event.control?.backend === backendId) {
      const control = event.control
      const room = String(event.room?.name)
      const identity = String(event.participant?.identity)
      let source: AudioSource | undefined
      let track: Awaited<ReturnType<typeof server.publishAudio>> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let cancelled = false
      const job = {
        room,
        identity,
        stop: () => {
          cancelled = true
          if (timer) clearTimeout(timer)
          source?.close()
          source = undefined
          track?.stop()
          track = undefined
          activeAudio.delete(job)
          closing(api.completeAudio(control.id, { error: "Audio publication cancelled" }))
        },
      }
      activeAudio.add(job)
      try {
        if (disposed) throw new Error("Signal server is closed")
        if (!createAudio) throw new Error("Audio media factory is unavailable")
        source = await createAudio(control.input)
        if (cancelled || disposed) throw new Error("Audio publication cancelled")
        track = await server.publishAudio(room, identity, source.track)
        if (cancelled || disposed) throw new Error("Audio publication cancelled")
        timer = setTimeout(job.stop, source.durationMs)
        await api.completeAudio(control.id, { sid: track.sid })
      } catch (error) {
        job.stop()
        await api.completeAudio(control.id, {
          error: error instanceof Error ? error.message : "Audio generation failed",
        })
      }
      return
    }
    for (const job of activeAudio) {
      if (
        event.event === "emulator_reset" ||
        ((event.event === "room_finished" || event.event === "room_deleted") &&
          event.room?.name === job.room) ||
        (event.event === "participant_left" &&
          event.room?.name === job.room &&
          event.participant?.identity === job.identity)
      )
        job.stop()
    }
    for (const session of sessions.values()) {
      if (
        event.event === "signal_disconnect" &&
        (!event.room?.name || event.room.name === session.room) &&
        (!event.participant?.identity || event.participant.identity === session.identity)
      ) {
        session.disconnect()
        continue
      }
      if (
        event.event === "emulator_reset" ||
        ((event.event === "room_finished" || event.event === "room_deleted") &&
          event.room?.name === session.room) ||
        (event.event === "participant_left" &&
          event.room?.name === session.room &&
          event.participant?.identity === session.identity)
      ) {
        session.close(
          event.event === "room_deleted" || event.event === "room_finished"
            ? DisconnectReason.ROOM_DELETED
            : DisconnectReason.PARTICIPANT_REMOVED,
        )
        continue
      }
      if (event.room?.name !== session.room || !event.participant?.identity) continue
      if (event.event === "signal_packet" && event.packet) {
        const packet = DataPacket.fromJsonString(event.packet)
        if (
          session.identity !== packet.participantIdentity &&
          (!packet.destinationIdentities.length ||
            packet.destinationIdentities.includes(session.identity))
        )
          await session.data(packet)
        continue
      }
      const participant = await api.getParticipant(session.room, String(event.participant.identity))
      if (participant)
        session.send({
          case: "update",
          value: new ParticipantUpdate({ participants: [info(participant)] }),
        })
      else
        session.send({
          case: "update",
          value: new ParticipantUpdate({
            participants: [
              new ParticipantInfo({
                sid: String(event.participant.sid),
                identity: String(event.participant.identity),
                state: ParticipantInfo_State.DISCONNECTED,
              }),
            ],
          }),
        })
    }
  }
  const unsubscribe = api.observe((event) => {
    void observed(event).catch(() => {
      for (const session of sessions.values()) session.close()
    })
  })
  const validate = async (url: URL) =>
    api.authorizeJoin(
      url.searchParams.get("access_token") ?? "",
      url.searchParams.get("room") ?? undefined,
    )
  const accept = async (incomingPeer: SignalPeer) => {
    if (disposed) {
      incomingPeer.refuse()
      return
    }
    let peer = incomingPeer
    let departed = false
    peer.onClose(() => {
      departed = true
    })
    const grant = await validate(peer.url)
    if (peer.url.pathname !== "/rtc" || !grant) {
      peer.refuse()
      return
    }
    if (departed || disposed) return
    if (peer.url.searchParams.get("reconnect") === "1") {
      const previous = sessions.get(peer.url.searchParams.get("sid") ?? "")
      if (!previous || previous.room !== grant.room || previous.identity !== grant.identity) {
        peer.refuse()
        return
      }
      previous.resume(peer)
      return
    }
    const participant = await api.join(grant.room, grant)
    const room = await api.getRoom(grant.room)
    if ((departed || disposed) && participant) {
      await api.remove(grant.room, grant.identity)
      return
    }
    if (!participant || !room) {
      peer.refuse()
      return
    }
    let down: RTCPeerConnection
    try {
      down = peerConnection()
    } catch {
      await api.remove(grant.room, grant.identity)
      peer.refuse()
      return
    }
    let up: RTCPeerConnection | undefined
    let closed = false
    const permitted = async (permission: string) => {
      const current = await api.getParticipant(grant.room, grant.identity)
      return !disposed && !closed && Boolean(current) && current?.permission[permission] !== false
    }
    let detached = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let negotiation = Promise.resolve()
    const mediaTimers = new Set<ReturnType<typeof setInterval>>()
    const trackIds = new Map<string, string>()
    const candidates = new Map<SignalTarget, RTCIceCandidateInit[]>([
      [SignalTarget.PUBLISHER, []],
      [SignalTarget.SUBSCRIBER, []],
    ])
    const channel = down.createDataChannel("_reliable", { ordered: true })
    down.createDataChannel("_lossy", { ordered: false, maxRetransmits: 0 })
    channel.binaryType = "arraybuffer"
    const pending: Uint8Array<ArrayBuffer>[] = []
    channel.onopen = () => {
      void permitted("canSubscribe")
        .then((allowed) => {
          const queued = pending.splice(0)
          if (allowed) for (const bytes of queued) channel.send(bytes)
        })
        .catch(() => close())
    }
    const send = (message: Signal) => {
      if (!closed) peer.deliver(new SignalResponse({ message }).toBinary())
    }
    const close = (reason = DisconnectReason.PARTICIPANT_REMOVED) => {
      if (closed) return
      send({
        case: "leave",
        value: new LeaveRequest({
          reason,
          action: LeaveRequest_Action.DISCONNECT,
        }),
      })
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      sessions.delete(participant.sid)
      closing(api.recordConnection(participant.sid, grant.room, grant.identity, "closed"))
      closing(down.close())
      if (up) closing(up.close())
      for (const timer of mediaTimers) clearInterval(timer)
      peer.close()
      closing(api.remove(grant.room, grant.identity))
    }
    const queued = (work: () => Promise<void>) => {
      negotiation = negotiation.then(work).catch(() => close())
    }
    const trickle = (target: SignalTarget) => (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate)
        send({
          case: "trickle",
          value: new TrickleRequest({
            target,
            candidateInit: JSON.stringify(event.candidate.toJSON()),
          }),
        })
    }
    down.onicecandidate = trickle(SignalTarget.SUBSCRIBER)
    const flush = async (connection: RTCPeerConnection, target: SignalTarget) => {
      for (const candidate of candidates.get(target)?.splice(0) ?? [])
        await connection.addIceCandidate(candidate)
    }
    const publisher = () => {
      if (up) return up
      const connection = peerConnection()
      connection.onicecandidate = trickle(SignalTarget.PUBLISHER)
      connection.ontrack = (event) => {
        void permitted("canPublish")
          .then((allowed) => {
            if (allowed) options.onTrack?.(event.track, grant)
            else event.track.stop()
          })
          .catch(() => close())
        let reading = false
        const timer = setInterval(() => {
          if (closed || reading) return
          reading = true
          void (async () => {
            if (!(await permitted("canPublish"))) {
              event.track.stop()
              clearInterval(timer)
              return
            }
            const report = await connection.getStats(event.track)
            const section = connection.remoteDescription?.sdp
              .split(/\r?\nm=/)
              .find((value) => value.includes(`a=mid:${event.transceiver.mid}\r\n`))
            const signaledId = section?.match(/a=msid:\S+ (\S+)/)?.[1]
            const trackSid =
              trackIds.get(event.track.id) ?? (signaledId ? trackIds.get(signaledId) : undefined)
            if (!trackSid) return
            for (const stats of report.values()) {
              if (
                stats.type === "inbound-rtp" &&
                !stats.isRemote &&
                (stats.kind ?? stats.mediaType) === event.track.kind &&
                typeof stats.packetsReceived === "number" &&
                typeof stats.bytesReceived === "number"
              ) {
                await api.recordMedia(
                  grant.room,
                  grant.identity,
                  trackSid,
                  stats.packetsReceived,
                  stats.bytesReceived,
                )
              }
            }
          })()
            .catch(() => close())
            .finally(() => {
              reading = false
            })
        }, 100)
        mediaTimers.add(timer)
      }
      connection.ondatachannel = (event) => {
        event.channel.binaryType = "arraybuffer"
        event.channel.onmessage = (event) => {
          try {
            const bytes = new Uint8Array(event.data as ArrayBuffer)
            void Promise.resolve(api.deliverPacket(grant.room, grant.identity, bytes))
              .then((message) => options.onData?.(DataPacket.fromJsonString(message.packet), grant))
              .catch(() => close())
          } catch {
            close()
          }
        }
      }
      up = connection
      return connection
    }
    const detach = () => {
      if (closed || detached) return
      detached = true
      void Promise.resolve(
        api.recordConnection(participant.sid, grant.room, grant.identity, "reconnecting"),
      ).catch(() => close())
      reconnectTimer = setTimeout(close, 10000)
      peer.drop?.()
      if (!peer.drop) peer.close(1012, "Signal connection lost")
    }
    const bind = (next: SignalPeer) => {
      next.onClose(() => {
        if (next === peer && !closed) detach()
      })
      next.onMessage(onMessage)
    }
    sessions.set(participant.sid, {
      room: grant.room,
      identity: grant.identity,
      send,
      close,
      disconnect: detach,
      resume(next) {
        if (closed || !detached) {
          next.refuse()
          return
        }
        if (reconnectTimer) clearTimeout(reconnectTimer)
        peer = next
        detached = false
        void Promise.resolve(
          api.recordConnection(participant.sid, grant.room, grant.identity, "open"),
        ).catch(() => close())
        bind(peer)
        peer.accept()
        send({
          case: "reconnect",
          value: new ReconnectResponse({
            serverInfo: new ServerInfo({ version: "1.13.7", region: "fixture", protocol: 16 }),
          }),
        })
        queued(async () => {
          const offer = await down.createOffer({ iceRestart: true })
          await down.setLocalDescription(offer)
          send({
            case: "offer",
            value: new SessionDescription({ type: "offer", sdp: offer.sdp ?? "" }),
          })
        })
      },
      async audio(track, participantSid, trackSid) {
        if (!(await permitted("canSubscribe"))) return
        const stream = options.createMediaStream
          ? options.createMediaStream([track])
          : new MediaStream([track])
        const sender = down.addTrack(track, stream)
        queued(async () => {
          const offer = await down.createOffer()
          await down.setLocalDescription(offer)
          const sdp = (offer.sdp ?? "")
            .replaceAll(stream.id, `${participantSid}|${trackSid}`)
            .replaceAll(track.id, trackSid)
          send({ case: "offer", value: new SessionDescription({ type: "offer", sdp }) })
        })
        return () => {
          if (!closed) down.removeTrack(sender)
        }
      },
      async data(packet) {
        if (!(await permitted("canSubscribe"))) return
        const bytes = new Uint8Array(packet.toBinary())
        if (channel.readyState === "open") channel.send(bytes)
        else pending.push(bytes)
      },
    })
    const onMessage = (bytes: Uint8Array) => {
      void (async () => {
        try {
          const { message } = SignalRequest.fromBinary(bytes)
          if (message.case === "answer") {
            const { sdp } = message.value
            queued(async () => {
              await down.setRemoteDescription({ type: "answer", sdp })
              await flush(down, SignalTarget.SUBSCRIBER)
            })
          } else if (message.case === "offer") {
            const { sdp, id } = message.value
            queued(async () => {
              const connection = publisher()
              await connection.setRemoteDescription({ type: "offer", sdp })
              await flush(connection, SignalTarget.PUBLISHER)
              const answer = await connection.createAnswer()
              await connection.setLocalDescription(answer)
              send({
                case: "answer",
                value: new SessionDescription({ type: "answer", sdp: answer.sdp ?? "", id }),
              })
            })
          } else if (message.case === "trickle") {
            const { target, candidateInit } = message.value
            const candidate = JSON.parse(candidateInit) as RTCIceCandidateInit
            candidates.get(target)?.push(candidate)
            const connection = target === SignalTarget.PUBLISHER ? up : down
            if (connection?.remoteDescription) queued(() => flush(connection, target))
          } else if (message.case === "addTrack") {
            if (!(await permitted("canPublish"))) {
              close()
              return
            }
            const { cid, name, type, source, muted } = message.value
            const track = await api.publish(
              grant.room,
              grant.identity,
              {
                name,
                type: type === TrackType.AUDIO ? "AUDIO" : "VIDEO",
                source: source === TrackSource.MICROPHONE ? "MICROPHONE" : "CAMERA",
                muted,
              },
              true,
            )
            if (track) {
              trackIds.set(cid, track.sid)
              send({
                case: "trackPublished",
                value: new TrackPublishedResponse({
                  cid,
                  track: new TrackInfo({ sid: track.sid, name, type, source, muted }),
                }),
              })
            }
          } else if (message.case === "pingReq")
            send({
              case: "pongResp",
              value: new Pong({
                lastPingTimestamp: message.value.timestamp,
                timestamp: BigInt(Date.now()),
              }),
            })
          else if (message.case === "ping") send({ case: "pong", value: BigInt(Date.now()) })
          else if (message.case === "leave") close()
        } catch {
          close()
        }
      })()
    }
    bind(peer)
    await api.recordConnection(participant.sid, grant.room, grant.identity, "open")
    peer.accept()
    send({
      case: "join",
      value: new JoinResponse({
        room: new Room({
          sid: room.sid,
          name: room.name,
          creationTime: BigInt(Math.floor(room.creationTime / 1000)),
          numParticipants: room.numParticipants,
        }),
        participant: info(participant),
        otherParticipants: (await api.listParticipants(grant.room))
          .filter((p) => p.identity !== grant.identity)
          .map(info),
        subscriberPrimary: true,
        serverVersion: "1.13.7",
        serverRegion: "fixture",
        serverInfo: new ServerInfo({ version: "1.13.7", region: "fixture", protocol: 16 }),
        enabledPublishCodecs: [new Codec({ mime: "audio/opus" })],
      }),
    })
    queued(async () => {
      const offer = await down.createOffer()
      await down.setLocalDescription(offer)
      send({
        case: "offer",
        value: new SessionDescription({ type: "offer", sdp: offer.sdp ?? "" }),
      })
    })
  }
  const server = {
    ready,
    accept,
    async validate(url: URL) {
      return (await validate(url))
        ? new Response(null, { status: 200 })
        : new Response("Invalid room join token", { status: 401 })
    },
    async sendData(
      room: string,
      identity: string,
      payload: Uint8Array,
      topic = "",
      destinationIdentities: string[] = [],
    ) {
      return api.deliverPacket(
        room,
        identity,
        new DataPacket({
          kind: DataPacket_Kind.RELIABLE,
          destinationIdentities,
          value: { case: "user", value: new UserPacket({ payload, topic }) },
        }).toBinary(),
      )
    },
    async publishAudio(room: string, identity: string, audio: MediaStreamTrack) {
      if (disposed) throw new Error("Signal server is closed")
      if (audio.kind !== "audio") throw new TypeError("Expected an audio track")
      if (!options.createMediaStream && typeof MediaStream === "undefined")
        throw new Error("MediaStream factory is unavailable")
      const participant = await api.getParticipant(room, identity)
      if (!participant || disposed) throw new Error("Unknown publishing participant")
      const track = await api.publish(room, identity, {
        name: "fixture-audio",
        type: "AUDIO",
        source: "MICROPHONE",
      })
      if (!track) throw new Error("Participant disappeared")
      if (disposed) {
        await api.unpublish(room, identity, track.sid)
        throw new Error("Signal server is closed")
      }
      const speaking = (active: boolean) => {
        for (const session of sessions.values())
          if (session.room === room)
            session.send({
              case: "speakersChanged",
              value: new SpeakersChanged({
                speakers: [
                  new SpeakerInfo({ sid: participant.sid, active, level: active ? 1 : 0 }),
                ],
              }),
            })
      }
      const detach: (() => void)[] = []
      for (const session of sessions.values())
        if (session.room === room && session.identity !== identity) {
          const remove = await session.audio(audio, participant.sid, track.sid)
          if (remove) detach.push(remove)
        }
      speaking(true)
      let stopped = false
      const stop = () => {
        if (stopped) return
        stopped = true
        speaking(false)
        for (const remove of detach) remove()
        closing(api.unpublish(room, identity, track.sid))
      }
      audio.addEventListener("ended", stop, { once: true })
      return { ...track, stop }
    },
    async sendTranscription(room: string, identity: string, text: string, trackId = "") {
      return api.deliverPacket(
        room,
        identity,
        new DataPacket({
          kind: DataPacket_Kind.RELIABLE,
          value: {
            case: "transcription",
            value: new Transcription({
              transcribedParticipantIdentity: identity,
              trackId,
              segments: [new TranscriptionSegment({ id: crypto.randomUUID(), text, final: true })],
            }),
          },
        }).toBinary(),
      )
    },
    async close() {
      disposed = true
      unsubscribe()
      closing(api.audioBackend(backendId, false))
      for (const job of activeAudio) job.stop()
      for (const session of sessions.values()) session.close()
      await Promise.all(cleanup)
    },
    get connections() {
      return sessions.size
    },
  }
  return server
}

export { createSignalWebSocket } from "./browser-socket.js"
export type { AudioFactory, AudioInput, AudioSource } from "./signal-audio.js"
export { createBrowserAudio } from "./signal-audio.js"
