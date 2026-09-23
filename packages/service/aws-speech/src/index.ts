import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  putObject,
  type S3Target,
  type Service,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { durationFor, MP3_SAMPLE_RATES, mp3Audio, pcmTone } from "./audio.js"
import {
  eventFrame,
  exceptionFrame,
  headerString,
  payloadJson,
  readFrames,
  unwrapSigned,
} from "./eventstream.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type JobRecord,
  type Settings,
  type SpeechLogEntry,
  SpeechState,
  type SpeechStats,
  type TranscriptScript,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export {
  durationFor,
  MP3_SAMPLE_RATES,
  MP3_SAMPLES_PER_FRAME,
  MS_PER_CHARACTER,
  mp3Audio,
  mp3Frame,
  pcmTone,
} from "./audio.js"
export type { EventStreamMessage, HeaderValue, MessageInput } from "./eventstream.js"
export {
  crc32,
  decodeMessage,
  EventStreamError,
  encodeMessage,
  eventFrame,
  exceptionFrame,
  FrameReader,
  readFrames,
  unwrapSigned,
} from "./eventstream.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  JobRecord,
  Settings,
  SpeechLogEntry,
  SpeechStats,
  TranscriptScript,
} from "./state.js"
export { DEFAULT_SETTINGS } from "./state.js"

export const SPEECH_NAMESPACE = "aws-speech"

/** Every Polly voice id (`@aws-sdk/client-polly` VoiceId). */
export const POLLY_VOICES = [
  "Aditi",
  "Adriano",
  "Ambre",
  "Amy",
  "Andres",
  "Aria",
  "Arlet",
  "Arthur",
  "Astrid",
  "Ayanda",
  "Beatrice",
  "Bianca",
  "Brian",
  "Burcu",
  "Camila",
  "Carla",
  "Carmen",
  "Celine",
  "Chantal",
  "Conchita",
  "Cristiano",
  "Daniel",
  "Danielle",
  "Dora",
  "Elin",
  "Emma",
  "Enrique",
  "Ewa",
  "Filiz",
  "Florian",
  "Gabrielle",
  "Geraint",
  "Giorgio",
  "Gregory",
  "Gwyneth",
  "Hala",
  "Hannah",
  "Hans",
  "Hiujin",
  "Ida",
  "Ines",
  "Isabelle",
  "Ivy",
  "Jacek",
  "Jan",
  "Jasmine",
  "Jihye",
  "Jitka",
  "Joanna",
  "Joey",
  "Justin",
  "Kajal",
  "Karl",
  "Kazuha",
  "Kendra",
  "Kevin",
  "Kimberly",
  "Laura",
  "Lea",
  "Lennart",
  "Liam",
  "Lisa",
  "Liv",
  "Lorenzo",
  "Lotte",
  "Lucia",
  "Lupe",
  "Mads",
  "Maja",
  "Marlene",
  "Mathieu",
  "Matthew",
  "Maxim",
  "Mia",
  "Miguel",
  "Mizuki",
  "Naja",
  "Niamh",
  "Nicole",
  "Ola",
  "Olivia",
  "Pedro",
  "Penelope",
  "Raveena",
  "Remi",
  "Ricardo",
  "Ruben",
  "Russell",
  "Ruth",
  "Sabrina",
  "Salli",
  "Seoyeon",
  "Sergio",
  "Sofie",
  "Stephen",
  "Suvi",
  "Takumi",
  "Tatyana",
  "Thiago",
  "Tiffany",
  "Tomoko",
  "Vicki",
  "Vitoria",
  "Zayd",
  "Zeina",
  "Zhiyu",
] as const

const ENGINES = ["standard", "neural", "long-form", "generative"]
/** Characters Polly bills per `SynthesizeSpeech` call (`TextLengthExceededException` above). */
const MAX_BILLED_CHARACTERS = 3_000

/** `(status, x-amzn-ErrorType, message)` for the pre-stream faults. */
const FAULT_ERRORS: Record<string, [number, string, string]> = {
  polly_throttling: [429, "ThrottlingException", "Rate exceeded."],
  polly_service_failure: [
    500,
    "ServiceFailureException",
    "An unknown condition has caused a service failure.",
  ],
  transcribe_bad_request: [400, "BadRequestException", "Your request has an invalid parameter."],
  transcribe_limit_exceeded: [
    429,
    "LimitExceededException",
    "You have reached your concurrent stream limit.",
  ],
  transcribe_service_unavailable: [
    503,
    "ServiceUnavailableException",
    "The service is currently unavailable.",
  ],
}

/** A restJson1 error (Polly, Transcribe Streaming): `x-amzn-ErrorType` + `{message}`. */
export const speechError = (
  status: number,
  type: string,
  message: string,
  requestId?: string,
): Response =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-amzn-errortype": type,
      ...(requestId ? { "x-amzn-requestid": requestId } : {}),
    },
  })

/** An AWS JSON 1.1 error (Transcribe batch): `{__type, Message}`. */
const jsonRpcError = (status: number, type: string, message: string): Response =>
  new Response(JSON.stringify({ __type: type, Message: message }), {
    status,
    headers: { "content-type": "application/x-amz-json-1.1", "x-amzn-errortype": type },
  })

const fault = (
  request: Request,
): { type: string; message?: string; afterEvents?: number } | undefined => {
  const params = faultEffect(request, "speech_fault")
  return params && typeof params.type === "string"
    ? (params as { type: string; message?: string; afterEvents?: number })
    : undefined
}

/** The region of a SigV4 credential scope (`Credential=AKID/date/<region>/service/…`). */
const regionOf = (request: Request): string =>
  /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(request.headers.get("authorization") ?? "")?.[1] ??
  "us-east-1"

/** The namespace credential: the SigV4 access key id. */
export const accessKeyCredential = sigV4AccessKeyId

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const utf8 = new TextDecoder()

/** Audio per `AudioEvent` chunk: 16 KiB. */
const AUDIO_EVENT_BYTES = 16_384

export type SpeechAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  transcripts?: readonly TranscriptScript[]
  /**
   * Where completed batch transcripts are written (the stack's local S3), so the app's
   * own `GetObject` of `TranscriptFileUri` finds them. The bucket is the job's
   * `OutputBucketName`.
   */
  transcriptStore?: Omit<S3Target, "bucket">
}

/**
 * Stateful mock of Amazon Polly and Amazon Transcribe (streaming and batch).
 *
 * Polly answers with deterministic synthetic audio whose length follows the text. Transcribe
 * never listens: what it "hears" comes from scripted transcripts (`PUT /__admin/transcripts`),
 * sent as partial results while the audio streams in and a final result when it ends.
 */
export class SpeechAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: SpeechState
  private readonly service: Service
  private readonly now: () => number
  private readonly transcriptStore: Omit<S3Target, "bucket"> | undefined
  private requests = 0

  constructor(options: SpeechAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? SPEECH_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.transcriptStore = options.transcriptStore
    this.state = new SpeechState(sqlite, namespace, {
      settings: options.settings ?? {},
      transcripts: options.transcripts ?? [],
    })
    const handlers = defineOperations<SupportedOperationId>({
      SynthesizeSpeech: (context) => this.synthesize(context),
      // The duplex operations are served by `fetch` before routing (bodies never buffered).
      StartSpeechSynthesisStream: (context) => this.synthesisStream(context.request),
      StartStreamTranscription: (context) => this.streamTranscription(context.request),
      TranscribeJsonRpc: (context) => this.jsonRpc(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) =>
        speechError(
          404,
          "UnknownOperationException",
          `No operation matches ${request.method} ${new URL(request.url).pathname}`,
        ),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === "POST" && path === "/v1/synthesisStream")
      return this.synthesisStream(request)
    if (request.method === "POST" && path === "/stream-transcription")
      return this.streamTranscription(request)
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  /** Metadata of every synthesis and transcription so far (never text). */
  speechLog(): SpeechLogEntry[] {
    return this.state.log.list({ order: "oldest" }).map((row) => row.value)
  }

  jobs(): JobRecord[] {
    return this.state.jobs.list({ order: "oldest" }).map((row) => this.advance(row.value))
  }

  stats(): SpeechStats {
    return this.state.currentStats()
  }

  private requestId(): string {
    const hex = opaqueToken(`speech:${this.requests++}:${this.now()}`, 32)
      .split("")
      .map((c) => (c.charCodeAt(0) % 16).toString(16))
      .join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  }

  // ── Polly ───────────────────────────────────────────────────────

  /** Shared checks for both Polly operations; a string is the error. */
  private checkVoice(input: {
    voiceId: unknown
    engine: unknown
    outputFormat: unknown
    sampleRate: unknown
  }): { voiceId: string; engine: string; outputFormat: string; sampleRate: number } | Response {
    const { voiceId, engine = "standard", outputFormat } = input
    if (typeof voiceId !== "string" || !(POLLY_VOICES as readonly string[]).includes(voiceId)) {
      return speechError(
        400,
        "ValidationException",
        `1 validation error detected: Value '${String(voiceId)}' at 'voiceId' failed to satisfy constraint: Member must satisfy enum value set`,
      )
    }
    if (typeof engine !== "string" || !ENGINES.includes(engine)) {
      return speechError(
        400,
        "ValidationException",
        `1 validation error detected: Value '${String(engine)}' at 'engine' failed to satisfy constraint: Member must satisfy enum value set: [standard, neural, long-form, generative]`,
      )
    }
    if (outputFormat !== "pcm" && outputFormat !== "mp3") {
      return speechError(
        400,
        "ValidationException",
        `OutputFormat ${String(outputFormat)} is not modelled by the Mockingbird mock (pcm and mp3 are).`,
      )
    }
    const fallbackRate = outputFormat === "pcm" ? 16_000 : engine === "standard" ? 22_050 : 24_000
    const sampleRate = input.sampleRate === undefined ? fallbackRate : Number(input.sampleRate)
    const allowed =
      outputFormat === "pcm"
        ? [8_000, 16_000]
        : MP3_SAMPLE_RATES.filter((r) => r >= 8_000 && r !== 11_025 && r !== 12_000)
    if (!allowed.includes(sampleRate)) {
      return speechError(
        400,
        "InvalidSampleRateException",
        `The specified sample rate ${String(input.sampleRate)} is not valid for ${outputFormat}.`,
      )
    }
    return { voiceId, engine, outputFormat, sampleRate }
  }

  private audio(text: string, outputFormat: string, sampleRate: number): Uint8Array {
    const ms = durationFor(text)
    return outputFormat === "pcm" ? pcmTone(ms, sampleRate) : mp3Audio(ms, sampleRate)
  }

  private async synthesize(context: OperationContext): Promise<Response> {
    const requestId = this.requestId()
    const body = context.body.kind === "json" ? context.body.value : undefined
    if (!isRecord(body) || typeof body.Text !== "string" || body.Text.length === 0) {
      return speechError(
        400,
        "ValidationException",
        "1 validation error detected: Value null at 'text' failed to satisfy constraint: Member must not be null",
        requestId,
      )
    }
    const injected = fault(context.request)
    const known = injected ? FAULT_ERRORS[injected.type] : undefined
    if (known && injected?.type.startsWith("polly_")) {
      return speechError(known[0], known[1], injected?.message ?? known[2], requestId)
    }
    const voice = this.checkVoice({
      voiceId: body.VoiceId,
      engine: body.Engine,
      outputFormat: body.OutputFormat,
      sampleRate: body.SampleRate,
    })
    if (voice instanceof Response) return voice
    const text = body.TextType === "ssml" ? body.Text.replace(/<[^>]*>/g, "") : body.Text
    if (text.length > MAX_BILLED_CHARACTERS) {
      return speechError(
        400,
        "TextLengthExceededException",
        `Maximum text length has been exceeded (${MAX_BILLED_CHARACTERS} billed characters).`,
        requestId,
      )
    }
    const audio = this.audio(text, voice.outputFormat, voice.sampleRate)
    this.state.record({
      operation: "SynthesizeSpeech",
      voiceId: voice.voiceId,
      engine: voice.engine,
      outputFormat: voice.outputFormat,
      sampleRate: String(voice.sampleRate),
      characters: text.length,
      audioBytes: audio.length,
    })
    return annotateResponse(
      new Response(audio as BodyInit, {
        status: 200,
        headers: {
          "content-type": voice.outputFormat === "pcm" ? "audio/pcm" : "audio/mpeg",
          "x-amzn-requestcharacters": String(text.length),
          "x-amzn-requestid": requestId,
        },
      }),
      {
        ids: {
          voiceId: voice.voiceId,
          engine: voice.engine,
          outputFormat: voice.outputFormat,
          characters: String(text.length),
        },
      },
    )
  }

  private async synthesisStream(request: Request): Promise<Response> {
    const requestId = this.requestId()
    const headers = request.headers
    const injected = fault(request)
    const known = injected ? FAULT_ERRORS[injected.type] : undefined
    if (known && injected?.type.startsWith("polly_")) {
      return speechError(known[0], known[1], injected?.message ?? known[2], requestId)
    }
    const voice = this.checkVoice({
      voiceId: headers.get("x-amzn-voiceid") ?? undefined,
      engine: headers.get("x-amzn-engine") ?? undefined,
      outputFormat: headers.get("x-amzn-outputformat") ?? undefined,
      sampleRate: headers.get("x-amzn-samplerate") ?? undefined,
    })
    if (voice instanceof Response) return voice
    if (voice.engine !== "generative") {
      return speechError(
        400,
        "ValidationException",
        "StartSpeechSynthesisStream supports only the generative engine.",
        requestId,
      )
    }
    const streamFault = injected?.type.startsWith("polly_stream_") ? injected : undefined
    let characters = 0
    let audioBytes = 0
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        void (async () => {
          const exception = (type: string, message: string) =>
            controller.enqueue(exceptionFrame(type, { message }))
          const failure: Record<string, [string, string]> = {
            polly_stream_throttling: ["ThrottlingException", "Rate exceeded."],
            polly_stream_validation: [
              "ValidationException",
              "The input fails to satisfy the constraints.",
            ],
            polly_stream_quota: ["ServiceQuotaExceededException", "Service quota exceeded."],
            polly_stream_failure: [
              "ServiceFailureException",
              "An unknown condition has caused a service failure.",
            ],
          }
          const planned = streamFault ? failure[streamFault.type] : undefined
          let events = 0
          try {
            for await (const raw of readFrames(request.body)) {
              const frame = unwrapSigned(raw)
              if (frame === null) break
              const type = headerString(frame, ":event-type")
              if (type === "CloseStreamEvent") break
              if (type !== "TextEvent") continue
              const payload = payloadJson(frame)
              const text = isRecord(payload) && typeof payload.Text === "string" ? payload.Text : ""
              if (planned && events >= (streamFault?.afterEvents ?? 0)) {
                exception(planned[0], streamFault?.message ?? planned[1])
                controller.close()
                return
              }
              characters += text.length
              const audio = this.audio(text, voice.outputFormat, voice.sampleRate)
              audioBytes += audio.length
              for (let at = 0; at < audio.length; at += AUDIO_EVENT_BYTES) {
                controller.enqueue(
                  eventFrame("AudioEvent", audio.subarray(at, at + AUDIO_EVENT_BYTES)),
                )
                events++
              }
            }
            if (planned) exception(planned[0], streamFault?.message ?? planned[1])
            else if (streamFault?.type !== "polly_stream_no_close") {
              controller.enqueue(eventFrame("StreamClosedEvent", { RequestCharacters: characters }))
            }
          } catch {
            // The client went away: nothing to answer.
          }
          this.state.record({
            operation: "StartSpeechSynthesisStream",
            voiceId: voice.voiceId,
            engine: voice.engine,
            outputFormat: voice.outputFormat,
            sampleRate: String(voice.sampleRate),
            characters,
            audioBytes,
          })
          try {
            controller.close()
          } catch {
            // already closed
          }
        })()
      },
    })
    return annotateResponse(
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/vnd.amazon.eventstream",
          "x-amzn-requestid": requestId,
        },
      }),
      { ids: { voiceId: voice.voiceId, engine: voice.engine, outputFormat: voice.outputFormat } },
    )
  }

  // ── Transcribe streaming ────────────────────────────────────────

  private async streamTranscription(request: Request): Promise<Response> {
    const requestId = this.requestId()
    const headers = request.headers
    const injected = fault(request)
    const known = injected ? FAULT_ERRORS[injected.type] : undefined
    if (known && injected?.type.startsWith("transcribe_")) {
      return speechError(known[0], known[1], injected?.message ?? known[2], requestId)
    }
    const language = headers.get("x-amzn-transcribe-language-code")
    const identify = headers.get("x-amzn-transcribe-identify-language") === "true"
    const encoding = headers.get("x-amzn-transcribe-media-encoding")
    const rate = Number(headers.get("x-amzn-transcribe-sample-rate"))
    if (!identify && (!language || !/^[a-z]{2}-[A-Z]{2}$/.test(language))) {
      return speechError(
        400,
        "BadRequestException",
        "A language code is required unless IdentifyLanguage is set.",
        requestId,
      )
    }
    if (!encoding || !["pcm", "ogg-opus", "flac"].includes(encoding)) {
      return speechError(
        400,
        "BadRequestException",
        `1 validation error detected: Value '${String(encoding)}' at 'mediaEncoding' failed to satisfy constraint: Member must satisfy enum value set: [ogg-opus, flac, pcm]`,
        requestId,
      )
    }
    if (!Number.isInteger(rate) || rate < 8_000 || rate > 48_000) {
      return speechError(
        400,
        "BadRequestException",
        "1 validation error detected: Value at 'mediaSampleRateHertz' failed to satisfy constraint: Member must have value between 8000 and 48000",
        requestId,
      )
    }
    const sessionIndex = this.state.nextSessionIndex()
    const script = this.state.pick({ sessionIndex })
    const partials = script?.partials ?? []
    const final = script?.final ?? this.state.current().defaultTranscript
    const sessionId = headers.get("x-amzn-transcribe-session-id") ?? this.requestId()
    const midStream = injected?.type === "transcribe_mid_stream_failure" ? injected : undefined
    let chunks = 0
    let audioBytes = 0
    let sent = 0
    let resultIndex = 0
    const result = (transcript: string, isPartial: boolean) => {
      const end = Math.max(0.1, Math.round((audioBytes / 2 / rate) * 1000) / 1000)
      return eventFrame("TranscriptEvent", {
        Transcript: {
          Results: [
            {
              ResultId: `${sessionId}-${resultIndex++}`,
              StartTime: 0,
              EndTime: end,
              IsPartial: isPartial,
              Alternatives: [{ Transcript: transcript, Items: [] }],
              ...(headers.get("x-amzn-transcribe-enable-channel-identification") === "true"
                ? { ChannelId: "ch_0" }
                : {}),
            },
          ],
        },
      })
    }
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        void (async () => {
          let emitted = 0
          const emit = (frame: Uint8Array) => {
            if (midStream && emitted >= (midStream.afterEvents ?? 1)) {
              controller.enqueue(
                exceptionFrame("InternalFailureException", {
                  Message: midStream.message ?? "A problem occurred while processing the audio.",
                }),
              )
              return false
            }
            controller.enqueue(frame)
            emitted++
            return true
          }
          try {
            for await (const raw of readFrames(request.body)) {
              const frame = unwrapSigned(raw)
              if (frame === null) break
              if (headerString(frame, ":event-type") !== "AudioEvent") continue
              chunks++
              audioBytes += frame.body.length
              if (frame.body.length === 0) break
              if (sent < partials.length && !emit(result(partials[sent++] as string, true))) {
                controller.close()
                return
              }
            }
            while (sent < partials.length) {
              if (!emit(result(partials[sent++] as string, true))) {
                controller.close()
                return
              }
            }
            if (final.length > 0 && !emit(result(final, false))) {
              controller.close()
              return
            }
          } catch {
            // The client went away.
          }
          this.state.record({
            operation: "StartStreamTranscription",
            audioBytes,
            chunks,
            ...(script ? { script: script.id } : {}),
          })
          try {
            controller.close()
          } catch {
            // already closed
          }
        })()
      },
    })
    const echo = (name: string) => {
      const value = headers.get(name)
      return value === null ? {} : { [name]: value }
    }
    return annotateResponse(
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/vnd.amazon.eventstream",
          "x-amzn-request-id": requestId,
          "x-amzn-transcribe-session-id": sessionId,
          ...echo("x-amzn-transcribe-language-code"),
          ...echo("x-amzn-transcribe-sample-rate"),
          ...echo("x-amzn-transcribe-media-encoding"),
          ...echo("x-amzn-transcribe-vocabulary-name"),
          ...echo("x-amzn-transcribe-enable-partial-results-stabilization"),
          ...echo("x-amzn-transcribe-partial-results-stability"),
        },
      }),
      { ids: { sessionIndex: String(sessionIndex), transcript: script?.id ?? "unscripted" } },
    )
  }

  // ── Transcribe batch (AWS JSON 1.1) ─────────────────────────────

  /** Move a job along the mock clock: IN_PROGRESS → COMPLETED after `jobDurationMs`. */
  private advance(job: JobRecord): JobRecord {
    if (job.TranscriptionJobStatus !== "IN_PROGRESS") return job
    if (this.now() < job.createdAtMs + this.state.current().jobDurationMs) return job
    return this.complete(job.TranscriptionJobName, undefined) ?? job
  }

  /** Complete a job (admin or clock), fixing its transcript; writes it to S3 when configured. */
  complete(name: string, transcript: string | undefined): JobRecord | undefined {
    const job = this.state.jobs.get(name)
    if (!job) return undefined
    const script = transcript === undefined ? this.state.pick({ jobName: name }) : undefined
    const next: JobRecord = {
      ...job,
      TranscriptionJobStatus: "COMPLETED",
      completedAtMs: this.now(),
      transcript: transcript ?? script?.final ?? this.state.current().defaultTranscript,
    }
    this.state.jobs.update(name, next)
    if (this.transcriptStore && next.OutputBucketName) {
      void putObject(
        { ...this.transcriptStore, bucket: next.OutputBucketName },
        this.outputKey(next),
        JSON.stringify(this.transcriptDocument(next)),
        "application/json",
      ).catch(() => undefined)
    }
    return next
  }

  /** Fail a job with a reason (admin, or the `transcribe_job_failed` preset). */
  fail(name: string, reason: string): JobRecord | undefined {
    const job = this.state.jobs.get(name)
    if (!job) return undefined
    const next: JobRecord = {
      ...job,
      TranscriptionJobStatus: "FAILED",
      completedAtMs: this.now(),
      failureReason: reason,
    }
    this.state.jobs.update(name, next)
    return next
  }

  private outputKey(job: JobRecord): string {
    return job.OutputKey ?? `${job.TranscriptionJobName}.json`
  }

  /** The transcript JSON Transcribe writes to S3 (the shape our formatter reads). */
  transcriptDocument(job: JobRecord): Record<string, unknown> {
    const words = (job.transcript ?? "").split(/\s+/).filter(Boolean)
    return {
      jobName: job.TranscriptionJobName,
      accountId: "123456789012",
      status: "COMPLETED",
      results: {
        transcripts: [{ transcript: job.transcript ?? "" }],
        ...(job.Settings?.ChannelIdentification === true
          ? {
              channel_labels: {
                channels: [{ channel_label: "ch_0", items: [] }],
                number_of_channels: 1,
              },
            }
          : {}),
        items: words.map((word, i) => ({
          start_time: (i * 0.5).toFixed(3),
          end_time: (i * 0.5 + 0.4).toFixed(3),
          alternatives: [{ confidence: "0.99", content: word.replace(/[.,!?]$/, "") }],
          type: "pronunciation",
        })),
      },
    }
  }

  private jobBody(job: JobRecord): Record<string, unknown> {
    const seconds = (ms: number) => ms / 1000
    const uri =
      job.OutputBucketName !== undefined
        ? `https://s3.${job.region}.amazonaws.com/${job.OutputBucketName}/${this.outputKey(job)}`
        : `https://s3.${job.region}.amazonaws.com/aws-transcribe-${job.region}-prod/123456789012/${job.TranscriptionJobName}/asrOutput.json`
    return {
      TranscriptionJobName: job.TranscriptionJobName,
      TranscriptionJobStatus: job.TranscriptionJobStatus,
      LanguageCode: job.LanguageCode,
      ...(job.MediaFormat ? { MediaFormat: job.MediaFormat } : {}),
      ...(job.MediaSampleRateHertz ? { MediaSampleRateHertz: job.MediaSampleRateHertz } : {}),
      Media: job.Media,
      ...(job.Settings ? { Settings: job.Settings } : {}),
      CreationTime: seconds(job.createdAtMs),
      StartTime: seconds(job.createdAtMs),
      ...(job.completedAtMs !== undefined ? { CompletionTime: seconds(job.completedAtMs) } : {}),
      ...(job.TranscriptionJobStatus === "COMPLETED"
        ? { Transcript: { TranscriptFileUri: uri } }
        : {}),
      ...(job.failureReason ? { FailureReason: job.failureReason } : {}),
    }
  }

  private async jsonRpc(context: OperationContext): Promise<Response> {
    const target = context.request.headers.get("x-amz-target") ?? ""
    let body: unknown
    try {
      const bytes =
        context.body.kind === "bytes"
          ? context.body.value
          : context.body.kind === "json"
            ? undefined
            : new Uint8Array(0)
      body =
        bytes === undefined
          ? (context.body as { value: unknown }).value
          : JSON.parse(utf8.decode(bytes) || "{}")
    } catch {
      return jsonRpcError(400, "SerializationException", "Request body is not valid JSON.")
    }
    if (!isRecord(body))
      return jsonRpcError(400, "SerializationException", "Request body is not a JSON object.")
    const name = body.TranscriptionJobName
    if (typeof name !== "string" || !/^[0-9a-zA-Z._-]{1,200}$/.test(name)) {
      return jsonRpcError(
        400,
        "BadRequestException",
        "1 validation error detected: Value at 'transcriptionJobName' failed to satisfy constraint: Member must satisfy regular expression pattern: ^[0-9a-zA-Z._-]+",
      )
    }
    const injected = fault(context.request)
    const notes = (response: Response) =>
      annotateResponse(response, {
        ids: { target: target.replace(/^Transcribe\./, ""), jobName: name },
      })
    switch (target) {
      case "Transcribe.StartTranscriptionJob": {
        if (injected?.type === "transcribe_job_limit") {
          return notes(
            jsonRpcError(
              400,
              "LimitExceededException",
              injected.message ??
                "You have exceeded the maximum number of concurrent transcription jobs.",
            ),
          )
        }
        if (this.state.jobs.has(name)) {
          return notes(
            jsonRpcError(
              400,
              "ConflictException",
              "The requested job name already exists. Use a different job name.",
            ),
          )
        }
        const media = isRecord(body.Media) ? body.Media : {}
        if (typeof media.MediaFileUri !== "string" || !media.MediaFileUri.startsWith("s3://")) {
          return notes(
            jsonRpcError(
              400,
              "BadRequestException",
              "The S3 URI that you specified for the media file isn't valid.",
            ),
          )
        }
        const language = typeof body.LanguageCode === "string" ? body.LanguageCode : undefined
        if (!language && body.IdentifyLanguage !== true) {
          return notes(
            jsonRpcError(
              400,
              "BadRequestException",
              "Either LanguageCode or IdentifyLanguage must be specified.",
            ),
          )
        }
        const job: JobRecord = {
          TranscriptionJobName: name,
          TranscriptionJobStatus: "IN_PROGRESS",
          LanguageCode: language ?? "en-US",
          ...(typeof body.MediaFormat === "string" ? { MediaFormat: body.MediaFormat } : {}),
          ...(typeof body.MediaSampleRateHertz === "number"
            ? { MediaSampleRateHertz: body.MediaSampleRateHertz }
            : {}),
          Media: { MediaFileUri: media.MediaFileUri },
          ...(isRecord(body.Settings) ? { Settings: body.Settings } : {}),
          ...(typeof body.OutputBucketName === "string"
            ? { OutputBucketName: body.OutputBucketName }
            : {}),
          ...(typeof body.OutputKey === "string" ? { OutputKey: body.OutputKey } : {}),
          region: regionOf(context.request),
          createdAtMs: this.now(),
        }
        this.state.jobs.insert(name, job)
        if (injected?.type === "transcribe_job_failed") {
          this.fail(
            name,
            injected.message ??
              "The media format provided does not match the detected media format.",
          )
        }
        return notes(
          jsonRes(
            200,
            { TranscriptionJob: this.jobBody(this.state.jobs.get(name) ?? job) },
            { "content-type": "application/x-amz-json-1.1" },
          ),
        )
      }
      case "Transcribe.GetTranscriptionJob": {
        const job = this.state.jobs.get(name)
        if (!job) {
          return notes(
            jsonRpcError(
              400,
              "BadRequestException",
              "The requested job couldn't be found. Check the job name and try your request again.",
            ),
          )
        }
        return notes(
          jsonRes(
            200,
            { TranscriptionJob: this.jobBody(this.advance(job)) },
            { "content-type": "application/x-amz-json-1.1" },
          ),
        )
      }
      default:
        return notes(
          jsonRpcError(
            400,
            "UnknownOperationException",
            `The operation ${target || "(none)"} is not modelled by the Mockingbird mock.`,
          ),
        )
    }
  }
}

export type { SpeechRuntime, SpeechRuntimeOptions } from "./runtime.js"
export { createRuntime, SPEECH_PRESETS } from "./runtime.js"
