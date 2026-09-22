/**
 * Nova Sonic over `InvokeModelWithBidirectionalStream`: one HTTP/2 request whose body and
 * response are both event streams, open for the whole voice session.
 *
 * Input frames (`chunk` events, each `{bytes: base64(JSON {event: {...}})}`, wrapped in a
 * SigV4 envelope by the SDK) are read as they arrive. The mock answers a user turn when an
 * interactive USER text content ends, when a USER audio content ends (or after
 * `audioTurnChunks` audio frames, standing in for end-of-speech detection), and when a
 * TOOL result content ends. Each answer is a script turn (or the default): the text as
 * `textOutput`, the same text as 24 kHz PCM tone `audioOutput`, and `toolUse` events.
 * Audio bytes sent in are counted, never kept.
 */
import { base64, speechFor } from "./audio.js"
import {
  eventFrame,
  exceptionFrame,
  headerString,
  payloadJson,
  readFrames,
  unwrapSigned,
} from "./eventstream.js"
import type { Plan } from "./plan.js"
import type { Sleep } from "./render.js"
import type { CallAnalysis, TurnFault } from "./scripts.js"

export type SonicHost = {
  /** Match a script (or fall back) for one user turn; records stats. */
  resolve(call: CallAnalysis): Promise<Plan>
  sleep: Sleep
  /** Deterministic ids for sessions, completions and contents. */
  nextId(prefix: string): string
  /** USER audio frames that end a spoken turn without a contentEnd; 0 disables. */
  audioTurnChunks: number
  /** A fault from a runtime preset, applied to the first answer. */
  fault?: TurnFault
}

type Content = {
  type: string
  role: string
  interactive: boolean
  text: string
  audioChunks: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const utf8 = new TextDecoder()

/** Audio per `audioOutput` event: 100 ms of 24 kHz PCM. */
const AUDIO_CHUNK_BYTES = 4_800

/** The response body of a Nova Sonic session. */
export const sonicSession = (
  request: Request,
  modelId: string,
  host: SonicHost,
): ReadableStream<Uint8Array> => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const output = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      closed = true
    },
  })
  const sessionId = host.nextId("session")
  const contents = new Map<string, Content>()
  const tools: string[] = []
  const toolNames = new Map<string, string>()
  let promptName = ""
  let systemText = ""
  let lastUserText = ""
  let sinceUser = 0
  let pendingToolResults: string[] = []
  let completionId: string | undefined
  let outputSampleRate = 24_000
  let contentEvents = 0
  let fault = host.fault
  let chain: Promise<void> = Promise.resolve()
  let inputChars = 0

  const close = () => {
    if (closed) return
    closed = true
    try {
      controller.close()
    } catch {
      // already closed by the reader
    }
  }
  const emitRaw = (frame: Uint8Array) => {
    if (!closed) controller.enqueue(frame)
  }
  const emit = (event: Record<string, unknown>) =>
    emitRaw(
      eventFrame("chunk", { bytes: base64(new TextEncoder().encode(JSON.stringify({ event }))) }),
    )

  /** A content event (text, audio, tool): paced, and where mid-stream faults land. */
  const emitContent = async (event: Record<string, unknown>, delayMs: number) => {
    if (closed) return
    if (fault && (fault.type === "mid_stream_exception" || fault.type === "truncated_frame")) {
      if (contentEvents >= (fault.afterChunks ?? 1)) {
        if (fault.type === "mid_stream_exception") {
          emitRaw(
            exceptionFrame(fault.exceptionType ?? "modelStreamErrorException", {
              message:
                fault.message ?? "The model stream encountered an error. Try your request again.",
            }),
          )
        } else {
          const frame = eventFrame("chunk", {
            bytes: base64(new TextEncoder().encode(JSON.stringify({ event }))),
          })
          emitRaw(frame.subarray(0, Math.floor(frame.length / 2)))
        }
        close()
        return
      }
    }
    if (delayMs > 0) await host.sleep(delayMs, request.signal)
    emit(event)
    contentEvents++
  }

  const respond = async (spoken: boolean, call: CallAnalysis) => {
    const plan = await host.resolve(call)
    if (plan.fault && !fault) fault = plan.fault
    if (fault?.type === "latency") await host.sleep(fault.latencyMs ?? 1_000, request.signal)
    const base = { sessionId, promptName }
    if (completionId === undefined) {
      completionId = host.nextId("completion")
      emit({ completionStart: { ...base, completionId } })
    }
    const ids = { ...base, completionId }
    if (spoken && plan.userTranscript !== undefined) {
      const contentId = host.nextId("content")
      emit({
        contentStart: {
          ...ids,
          contentId,
          type: "TEXT",
          role: "USER",
          textOutputConfiguration: { mediaType: "text/plain" },
        },
      })
      await emitContent(
        { textOutput: { ...ids, contentId, content: plan.userTranscript, role: "USER" } },
        0,
      )
      emit({ contentEnd: { ...ids, contentId, type: "TEXT", stopReason: "PARTIAL_TURN" } })
    }
    for (const block of plan.blocks) {
      if (closed) return
      if (block.kind === "text") {
        const textId = host.nextId("content")
        emit({
          contentStart: {
            ...ids,
            contentId: textId,
            type: "TEXT",
            role: "ASSISTANT",
            additionalModelFields: JSON.stringify({ generationStage: "FINAL" }),
            textOutputConfiguration: { mediaType: "text/plain" },
          },
        })
        await emitContent(
          { textOutput: { ...ids, contentId: textId, content: block.text, role: "ASSISTANT" } },
          plan.delayMsPerChunk,
        )
        emit({
          contentEnd: { ...ids, contentId: textId, type: "TEXT", stopReason: "PARTIAL_TURN" },
        })
        const audioId = host.nextId("content")
        emit({
          contentStart: {
            ...ids,
            contentId: audioId,
            type: "AUDIO",
            role: "ASSISTANT",
            audioOutputConfiguration: {
              mediaType: "audio/lpcm",
              sampleRateHertz: outputSampleRate,
              sampleSizeBits: 16,
              channelCount: 1,
              encoding: "base64",
              audioType: "SPEECH",
            },
          },
        })
        const audio = speechFor(block.text, outputSampleRate)
        for (let at = 0; at < audio.length; at += AUDIO_CHUNK_BYTES) {
          await emitContent(
            {
              audioOutput: {
                ...ids,
                contentId: audioId,
                content: base64(audio.subarray(at, at + AUDIO_CHUNK_BYTES)),
              },
            },
            plan.delayMsPerChunk,
          )
          if (closed) return
        }
        emit({ contentEnd: { ...ids, contentId: audioId, type: "AUDIO", stopReason: "END_TURN" } })
      } else if (block.kind === "toolUse") {
        toolNames.set(block.toolUseId, block.name)
        const toolId = host.nextId("content")
        emit({
          contentStart: {
            ...ids,
            contentId: toolId,
            type: "TOOL",
            role: "TOOL",
            toolUseOutputConfiguration: { mediaType: "application/json" },
          },
        })
        await emitContent(
          {
            toolUse: {
              ...ids,
              contentId: toolId,
              toolName: block.name,
              toolUseId: block.toolUseId,
              content: JSON.stringify(block.input ?? {}),
            },
          },
          plan.delayMsPerChunk,
        )
        emit({ contentEnd: { ...ids, contentId: toolId, type: "TOOL", stopReason: "TOOL_USE" } })
      }
    }
    if (closed) return
    emit({
      usageEvent: {
        ...ids,
        totalInputTokens: plan.usage.inputTokens,
        totalOutputTokens: plan.usage.outputTokens,
        totalTokens: plan.usage.totalTokens,
        details: {
          delta: {
            input: { speechTokens: 0, textTokens: plan.usage.inputTokens },
            output: { speechTokens: 0, textTokens: plan.usage.outputTokens },
          },
        },
      },
    })
  }
  /** Queue an answer, snapshotting the conversation as it stands now. */
  const schedule = (spoken: boolean) => {
    const call: CallAnalysis = {
      operation: "InvokeModelWithBidirectionalStream",
      modelId,
      lastUserText,
      systemText,
      tools: [...tools],
      toolSchemas: {},
      toolChoice: undefined,
      hasDocument: false,
      hasImage: false,
      hasCachePoint: false,
      hasGuardrail: false,
      toolResults: pendingToolResults,
      turnIndex: sinceUser,
      structured: undefined,
      inputChars,
    }
    pendingToolResults = []
    sinceUser++
    chain = chain.then(() => respond(spoken, call)).catch(() => close())
  }

  const handle = (event: Record<string, unknown>) => {
    const [kind] = Object.keys(event)
    const body = kind ? event[kind] : undefined
    if (!kind || !isRecord(body)) return
    switch (kind) {
      case "promptStart": {
        promptName = String(body.promptName ?? "")
        const audio = isRecord(body.audioOutputConfiguration)
          ? body.audioOutputConfiguration
          : undefined
        if (typeof audio?.sampleRateHertz === "number") outputSampleRate = audio.sampleRateHertz
        const config = isRecord(body.toolConfiguration) ? body.toolConfiguration : undefined
        for (const tool of Array.isArray(config?.tools) ? config.tools : []) {
          if (isRecord(tool) && isRecord(tool.toolSpec) && typeof tool.toolSpec.name === "string") {
            tools.push(tool.toolSpec.name)
          }
        }
        return
      }
      case "contentStart": {
        const name = String(body.contentName ?? "")
        contents.set(name, {
          type: String(body.type ?? ""),
          role: String(body.role ?? ""),
          interactive: body.interactive !== false,
          text: "",
          audioChunks: 0,
        })
        const config = isRecord(body.toolResultInputConfiguration)
          ? body.toolResultInputConfiguration
          : undefined
        if (config && typeof config.toolUseId === "string") {
          const tool = toolNames.get(config.toolUseId)
          if (tool) pendingToolResults.push(tool)
        }
        return
      }
      case "textInput": {
        const content = contents.get(String(body.contentName ?? ""))
        const text = typeof body.content === "string" ? body.content : ""
        inputChars += text.length
        if (!content) return
        content.text += text
        if (content.role === "SYSTEM") systemText += text
        return
      }
      case "audioInput": {
        const content = contents.get(String(body.contentName ?? ""))
        if (!content) return
        content.audioChunks++
        if (host.audioTurnChunks > 0 && content.audioChunks >= host.audioTurnChunks) {
          content.audioChunks = 0
          // A spoken turn has no text to match on (the mock does no ASR).
          lastUserText = ""
          sinceUser = 0
          schedule(true)
        }
        return
      }
      case "toolResult": {
        const text = typeof body.content === "string" ? body.content : ""
        inputChars += text.length
        return
      }
      case "contentEnd": {
        const content = contents.get(String(body.contentName ?? ""))
        if (!content) return
        if (content.role === "USER" && content.type === "TEXT" && content.interactive) {
          lastUserText = content.text
          sinceUser = 0
          schedule(false)
        } else if (content.role === "USER" && content.type === "AUDIO" && content.audioChunks > 0) {
          lastUserText = ""
          sinceUser = 0
          schedule(true)
        } else if (content.type === "TOOL") {
          schedule(false)
        }
        return
      }
      default:
        return
    }
  }

  void (async () => {
    let ended = false
    try {
      for await (const raw of readFrames(request.body)) {
        const frame = unwrapSigned(raw)
        if (frame === null) break
        if (headerString(frame, ":event-type") !== "chunk") continue
        const payload = payloadJson(frame)
        if (!isRecord(payload) || typeof payload.bytes !== "string") continue
        let decoded: unknown
        try {
          decoded = JSON.parse(
            utf8.decode(Uint8Array.from(atob(payload.bytes), (c) => c.charCodeAt(0))),
          )
        } catch {
          continue
        }
        const event = isRecord(decoded) && isRecord(decoded.event) ? decoded.event : decoded
        if (!isRecord(event)) continue
        if ("sessionEnd" in event) {
          ended = true
          break
        }
        handle(event)
      }
    } catch {
      // The client went away or sent a broken frame: finish what is queued, then close.
    }
    await chain
    if (ended && completionId !== undefined && !closed) {
      emit({ completionEnd: { sessionId, promptName, completionId, stopReason: "END_TURN" } })
    }
    close()
  })()
  return output
}
