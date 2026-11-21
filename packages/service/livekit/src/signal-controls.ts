import type { AdminRoutes, ServiceRuntime } from "@crvouga/mockingbird-service"
import {
  DataPacket,
  DataPacket_Kind,
  DataStream_Chunk,
  DataStream_Header,
  DataStream_TextHeader,
  DataStream_Trailer,
  RpcAck,
  RpcResponse,
  Transcription,
  TranscriptionSegment,
  UserPacket,
} from "@livekit/protocol"
import type { LiveKitAPI } from "./index.js"
import { parseAudioInput } from "./signal-audio.js"

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an object")
  return value as Record<string, unknown>
}
const string = (input: Record<string, unknown>, key: string) => {
  if (typeof input[key] !== "string") throw new TypeError(`${key} must be a string`)
  return input[key]
}
const strings = (input: unknown) => {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string"))
    throw new TypeError("destinationIdentities must be strings")
  return input as string[]
}
export const signalControls = (runtime: ServiceRuntime<LiveKitAPI>): AdminRoutes => {
  const routes: AdminRoutes = {}
  for (const operation of [
    "data",
    "transcription",
    "text",
    "rpc-response",
    "attributes",
    "audio",
  ]) {
    routes[`POST /rooms/:room/participants/:identity/${operation}`] = async ({
      namespace,
      params,
      body,
    }) => {
      try {
        const api = runtime.instance(namespace)
        const room = params.room as string
        const identity = params.identity as string
        if (!api.getParticipant(room, identity))
          return Response.json({ error: "participant not found" }, { status: 404 })
        if (operation === "audio") {
          const audio = parseAudioInput(body)
          try {
            return Response.json(await api.requestAudio(room, identity, audio))
          } catch (error) {
            return Response.json(
              { error: error instanceof Error ? error.message : "Audio unavailable" },
              { status: 501 },
            )
          }
        }
        const input = object(body)
        for (const key of ["topic", "trackId", "id"])
          if (input[key] !== undefined && typeof input[key] !== "string")
            throw new TypeError(`${key} must be a string`)
        for (const key of ["reliable", "final"])
          if (input[key] !== undefined && typeof input[key] !== "boolean")
            throw new TypeError(`${key} must be boolean`)
        if (operation === "attributes") {
          const attributes = object(input.attributes)
          if (Object.values(attributes).some((value) => typeof value !== "string"))
            throw new TypeError("attributes must have string values")
          return Response.json(
            api.updateAttributes(room, identity, attributes as Record<string, string>),
          )
        }
        const destinationIdentities = strings(input.destinationIdentities)
        const kind = input.reliable === false ? DataPacket_Kind.LOSSY : DataPacket_Kind.RELIABLE
        const send = (value: DataPacket["value"]) =>
          api.deliverPacket(
            room,
            identity,
            new DataPacket({ kind, destinationIdentities, value }).toBinary(),
          )
        if (operation === "data") {
          const encoded = string(input, "payload")
          const payload = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
          send({
            case: "user",
            value: new UserPacket({
              payload,
              topic: typeof input.topic === "string" ? input.topic : "",
            }),
          })
        } else if (operation === "transcription") {
          send({
            case: "transcription",
            value: new Transcription({
              transcribedParticipantIdentity: identity,
              trackId: typeof input.trackId === "string" ? input.trackId : "",
              segments: [
                new TranscriptionSegment({
                  id: typeof input.id === "string" ? input.id : crypto.randomUUID(),
                  text: string(input, "text"),
                  final: input.final !== false,
                }),
              ],
            }),
          })
        } else if (operation === "text") {
          const content = new TextEncoder().encode(string(input, "text"))
          const streamId = crypto.randomUUID()
          send({
            case: "streamHeader",
            value: new DataStream_Header({
              streamId,
              timestamp: BigInt(Date.now()),
              mimeType: "text/plain",
              topic: string(input, "topic"),
              totalLength: BigInt(content.length),
              contentHeader: { case: "textHeader", value: new DataStream_TextHeader() },
            }),
          })
          send({
            case: "streamChunk",
            value: new DataStream_Chunk({ streamId, chunkIndex: 0n, content }),
          })
          send({ case: "streamTrailer", value: new DataStream_Trailer({ streamId }) })
        } else if (operation === "rpc-response") {
          const requestId = string(input, "requestId")
          const payload = string(input, "payload")
          send({ case: "rpcAck", value: new RpcAck({ requestId }) })
          send({
            case: "rpcResponse",
            value: new RpcResponse({ requestId, value: { case: "payload", value: payload } }),
          })
        }
        return Response.json({ delivered: true })
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Invalid signal control" },
          { status: 400 },
        )
      }
    }
  }
  return routes
}
