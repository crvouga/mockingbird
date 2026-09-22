/**
 * Ports of OUR consumer's Polly / Transcribe code (geviti-monorepo, branch
 * crvouga/makor-voice-chat), kept as close to the originals as a test harness allows.
 *
 * Sources (B/ = apps/backend/src/modules/):
 * - B/chatbot/voice/resample-pcm-s16le.ts                            → resamplePcmS16Le (verbatim)
 * - B/chatbot/voice/adapters/voice-synthesis-config-resolver.ts       → resolveVoiceSynthesisConfig
 * - B/chatbot/voice/adapters/aws-voice-speech-synthesis.adapter.ts     → AwsVoiceSpeechSynthesisAdapter
 * - B/chatbot/voice/adapters/aws-voice-streaming-speech-synthesis.adapter.ts
 *                                                                    → AwsVoiceStreamingSpeechSynthesisAdapter
 * - B/chatbot/voice/adapters/create-voice-speech-synthesis-adapter.ts  → createVoiceSpeechSynthesisAdapter
 * - B/chatbot/voice/adapters/aws-voice-transcription.adapter.ts       → AwsVoiceTranscriptionAdapter
 * - B/messaging/call-recording/aws-transcribe-batch.adapter.ts         → AwsTranscribeBatchAdapter
 * - B/chatbot/voice/chat-voice.gateway.ts (transcribe → reply → speak) → voiceRoundTrip
 */
import {
  Engine,
  OutputFormat,
  PollyClient,
  type StartSpeechSynthesisStreamActionStream,
  StartSpeechSynthesisStreamCommand,
  type StartSpeechSynthesisStreamEventStream,
  SynthesizeSpeechCommand,
  TextType,
  VoiceId,
} from "@aws-sdk/client-polly"
import {
  GetTranscriptionJobCommand,
  type GetTranscriptionJobCommandOutput,
  StartTranscriptionJobCommand,
  TranscribeClient,
} from "@aws-sdk/client-transcribe"
import {
  LanguageCode,
  MediaEncoding,
  PartialResultsStability,
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
} from "@aws-sdk/client-transcribe-streaming"
import { MPEGDecoder } from "mpg123-decoder"

/** `ConfigService.get` over a plain map. */
export type Config = Record<string, string | undefined>

// ── resample-pcm-s16le.ts (verbatim) ────────────────────────────────

export function resamplePcmS16Le(input: Buffer, inputRate = 16_000, outputRate = 24_000) {
  if (input.length === 0) return Buffer.alloc(0)
  if (input.length % 2 !== 0 || inputRate <= 0 || outputRate <= 0) {
    throw new Error("PCM input and sample rates are invalid")
  }
  if (inputRate === outputRate) return Buffer.from(input)
  const inputSamples = input.length / 2
  const outputSamples = Math.max(1, Math.floor((inputSamples * outputRate) / inputRate))
  const output = Buffer.alloc(outputSamples * 2)
  const ratio = inputRate / outputRate
  for (let outputIndex = 0; outputIndex < outputSamples; outputIndex += 1) {
    const inputPosition = outputIndex * ratio
    const lowerIndex = Math.min(Math.floor(inputPosition), inputSamples - 1)
    const upperIndex = Math.min(lowerIndex + 1, inputSamples - 1)
    const fraction = inputPosition - lowerIndex
    const lower = input.readInt16LE(lowerIndex * 2)
    const upper = input.readInt16LE(upperIndex * 2)
    const sample = Math.max(
      -32_768,
      Math.min(32_767, Math.round(lower + (upper - lower) * fraction)),
    )
    output.writeInt16LE(sample, outputIndex * 2)
  }
  return output
}

// ── voice-synthesis-config-resolver.ts ──────────────────────────────

const DEFAULT_VOICE_BY_ENGINE: Record<string, VoiceId> = {
  [Engine.GENERATIVE]: VoiceId.Stephen,
  [Engine.LONG_FORM]: VoiceId.Danielle,
  [Engine.NEURAL]: VoiceId.Matthew,
  [Engine.STANDARD]: VoiceId.Matthew,
}
const GENERATIVE_EN_US_VOICES: readonly VoiceId[] = [
  VoiceId.Danielle,
  VoiceId.Joanna,
  VoiceId.Matthew,
  VoiceId.Ruth,
  VoiceId.Salli,
  VoiceId.Stephen,
  VoiceId.Tiffany,
]

export function resolveVoiceSynthesisConfig(config: Config): { engine: Engine; voiceId: VoiceId } {
  const requestedEngine = config.CHATBOT_VOICE_TTS_ENGINE?.trim()
  const engine = (Object.values(Engine).find((e) => e === requestedEngine) ??
    Engine.GENERATIVE) as Engine
  const fallbackVoiceId = DEFAULT_VOICE_BY_ENGINE[engine] as VoiceId
  const requestedVoice = config.CHATBOT_VOICE_TTS_VOICE_ID?.trim()
  const allowed: readonly VoiceId[] =
    engine === Engine.GENERATIVE ? GENERATIVE_EN_US_VOICES : Object.values(VoiceId)
  const voiceId = allowed.find((v) => v === requestedVoice) ?? fallbackVoiceId
  return { engine, voiceId }
}

export type VoiceSpeechSynthesisPort = {
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Buffer>
}

const region = (config: Config) => config.AWS_REGION ?? config.AWS_BEDROCK_REGION ?? "us-east-1"

// ── aws-voice-speech-synthesis.adapter.ts ───────────────────────────

const isAsyncIterable = (value: unknown): value is AsyncIterable<Uint8Array> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value

export class AwsVoiceSpeechSynthesisAdapter implements VoiceSpeechSynthesisPort {
  private readonly client: PollyClient
  constructor(private readonly config: Config) {
    this.client = new PollyClient({ region: region(config) })
  }

  async *synthesize(text: string, signal: AbortSignal) {
    const { engine, voiceId } = resolveVoiceSynthesisConfig(this.config)
    const response = await this.client.send(
      new SynthesizeSpeechCommand({
        Engine: engine,
        VoiceId: voiceId,
        OutputFormat: OutputFormat.PCM,
        SampleRate: String(16_000),
        Text: text,
      }),
      { abortSignal: signal },
    )
    if (!isAsyncIterable(response.AudioStream))
      throw new Error("Amazon Polly returned no audio stream")
    let remainder = Buffer.alloc(0)
    for await (const value of response.AudioStream) {
      if (signal.aborted) return
      const combined = Buffer.concat([remainder, Buffer.from(value)])
      const completeLength = combined.length - (combined.length % 2)
      if (completeLength > 0)
        yield resamplePcmS16Le(combined.subarray(0, completeLength), 16_000, 24_000)
      remainder = Buffer.from(combined.subarray(completeLength))
    }
    if (remainder.length > 0) throw new Error("Amazon Polly returned invalid PCM audio")
  }
}

// ── aws-voice-streaming-speech-synthesis.adapter.ts ─────────────────

const STREAM_SAMPLE_RATE = 24_000

function createSpeechActionStream(
  text: string,
): AsyncIterable<StartSpeechSynthesisStreamActionStream> {
  const actions: StartSpeechSynthesisStreamActionStream[] = [
    { TextEvent: { Text: text, TextType: TextType.TEXT } },
    { CloseStreamEvent: {} },
  ]
  return (async function* () {
    for (const action of actions) yield action
  })()
}

function toStreamFailure(event: StartSpeechSynthesisStreamEventStream): Error | undefined {
  const named = (name: string, message: string | undefined) =>
    Object.assign(new Error(message ?? `Amazon Polly speech stream returned ${name}`), { name })
  if (event.ValidationException)
    return named("ValidationException", event.ValidationException.message)
  if (event.ServiceQuotaExceededException)
    return named("ServiceQuotaExceededException", event.ServiceQuotaExceededException.message)
  if (event.ThrottlingException)
    return named("ThrottlingException", event.ThrottlingException.message)
  if (event.ServiceFailureException)
    return named("ServiceFailureException", event.ServiceFailureException.message)
  return undefined
}

function toPcmS16Le(samples: Float32Array, sampleCount: number): Buffer {
  const usable = Math.max(0, Math.min(sampleCount, samples.length))
  const output = Buffer.alloc(usable * 2)
  for (let index = 0; index < usable; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] as number))
    output.writeInt16LE(
      Math.max(-32_768, Math.min(32_767, Math.round(clamped * 32_767))),
      index * 2,
    )
  }
  return output
}

export class AwsVoiceStreamingSpeechSynthesisAdapter implements VoiceSpeechSynthesisPort {
  private readonly client: PollyClient
  /** Why the last call fell back to SynthesizeSpeech (the adapter logs this). */
  lastFallback: string | undefined
  constructor(
    private readonly config: Config,
    private readonly fallback: VoiceSpeechSynthesisPort,
  ) {
    this.client = new PollyClient({ region: region(config) })
  }

  async *synthesize(text: string, signal: AbortSignal) {
    const { engine, voiceId } = resolveVoiceSynthesisConfig(this.config)
    let decoder: MPEGDecoder | undefined
    let yieldedBytes = 0
    try {
      decoder = new MPEGDecoder()
      await decoder.ready
      const response = await this.client.send(
        new StartSpeechSynthesisStreamCommand({
          Engine: engine,
          VoiceId: voiceId,
          OutputFormat: OutputFormat.MP3,
          SampleRate: String(STREAM_SAMPLE_RATE),
          ActionStream: createSpeechActionStream(text),
        }),
        { abortSignal: signal },
      )
      if (!isAsyncIterable(response.EventStream))
        throw new Error("Amazon Polly returned no speech event stream")
      let streamClosed = false
      for await (const event of response.EventStream as AsyncIterable<StartSpeechSynthesisStreamEventStream>) {
        if (signal.aborted) return
        const failure = toStreamFailure(event)
        if (failure) throw failure
        if (event.StreamClosedEvent) {
          streamClosed = true
          break
        }
        const chunk = event.AudioEvent?.AudioChunk
        if (!chunk || chunk.length === 0) continue
        const decoded = decoder.decode(chunk)
        if (decoded.errors.length > 0)
          throw new Error("Amazon Polly speech stream returned undecodable audio")
        if (decoded.samplesDecoded <= 0) continue
        if (decoded.sampleRate !== STREAM_SAMPLE_RATE)
          throw new Error("Amazon Polly speech stream returned an unexpected sample rate")
        const channel = decoded.channelData[0]
        if (!channel) continue
        const pcm = toPcmS16Le(channel, decoded.samplesDecoded)
        if (pcm.length === 0) continue
        yieldedBytes += pcm.length
        yield pcm
      }
      if (!streamClosed) throw new Error("Amazon Polly speech stream ended without closing")
      if (yieldedBytes === 0) throw new Error("Amazon Polly speech stream produced no audio")
    } catch (error) {
      if (signal.aborted) return
      if (yieldedBytes > 0) throw error
      this.lastFallback = error instanceof Error ? error.name : "UnknownError"
      yield* this.fallback.synthesize(text, signal)
    } finally {
      decoder?.free()
    }
  }
}

/** `createVoiceSpeechSynthesisAdapter` (minus the CHATBOT_VOICE_MOCK fake). */
export function createVoiceSpeechSynthesisAdapter(config: Config): VoiceSpeechSynthesisPort {
  const requested = config.CHATBOT_VOICE_TTS_TRANSPORT?.trim()
  if (!requested || requested !== "stream") return new AwsVoiceSpeechSynthesisAdapter(config)
  if (resolveVoiceSynthesisConfig(config).engine !== Engine.GENERATIVE)
    return new AwsVoiceSpeechSynthesisAdapter(config)
  return new AwsVoiceStreamingSpeechSynthesisAdapter(
    config,
    new AwsVoiceSpeechSynthesisAdapter(config),
  )
}

// ── aws-voice-transcription.adapter.ts ──────────────────────────────

export type VoiceTranscriptionResult = { transcript: string; isFinal: boolean }

export class AwsVoiceTranscriptionAdapter {
  private readonly client: TranscribeStreamingClient
  private readonly stability: PartialResultsStability
  constructor(private readonly config: Config) {
    const value = config.CHATBOT_VOICE_STT_STABILITY?.trim().toLowerCase()
    this.stability =
      value === "low"
        ? PartialResultsStability.LOW
        : value === "medium"
          ? PartialResultsStability.MEDIUM
          : PartialResultsStability.HIGH
    this.client = new TranscribeStreamingClient({ region: region(config) })
  }

  async *transcribeTurn(
    input: AsyncIterable<Buffer>,
    options: { signal: AbortSignal },
  ): AsyncIterable<VoiceTranscriptionResult> {
    const vocabularyName = this.config.CHATBOT_VOICE_VOCABULARY_NAME?.trim()
    const response = await this.client.send(
      new StartStreamTranscriptionCommand({
        LanguageCode: LanguageCode.EN_US,
        MediaEncoding: MediaEncoding.PCM,
        MediaSampleRateHertz: 16_000,
        EnablePartialResultsStabilization: true,
        PartialResultsStability: this.stability,
        ...(vocabularyName ? { VocabularyName: vocabularyName } : {}),
        AudioStream: (async function* () {
          for await (const chunk of input) yield { AudioEvent: { AudioChunk: chunk } }
        })(),
      }),
      { abortSignal: options.signal },
    )
    if (!response.TranscriptResultStream)
      throw new Error("Amazon Transcribe returned no result stream")
    const finalSegments: string[] = []
    for await (const event of response.TranscriptResultStream) {
      for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
        const transcript = result.Alternatives?.[0]?.Transcript?.trim()
        if (transcript) {
          if (result.IsPartial === true)
            yield { transcript: [...finalSegments, transcript].join(" "), isFinal: false }
          else finalSegments.push(transcript)
        }
      }
    }
    const transcript = finalSegments.join(" ").trim()
    if (transcript) yield { transcript, isFinal: true }
  }
}

// ── chat-voice.gateway.ts (the turn loop, reduced to its protocol) ──

export type GatewayMessage =
  | { type: "caption"; text: string; isFinal: false }
  | { type: "turnTranscript"; transcript: string }
  | { type: "ttsAudio"; bytes: number }

/**
 * One voice turn as `/v2/chatbot/voice` runs it: stream the member's audio to Transcribe,
 * send captions for partials and `turnTranscript` for the final, get the reply text (the chat
 * agent — injected here), then stream TTS audio frames back.
 */
export const voiceRoundTrip = async (
  config: Config,
  audio: Buffer[],
  reply: (transcript: string) => Promise<string>,
): Promise<{ messages: GatewayMessage[]; audio: Buffer }> => {
  const messages: GatewayMessage[] = []
  const signal = new AbortController().signal
  let transcript = ""
  for await (const result of new AwsVoiceTranscriptionAdapter(config).transcribeTurn(
    (async function* () {
      for (const chunk of audio) yield chunk
    })(),
    { signal },
  )) {
    if (result.isFinal) {
      transcript = result.transcript
      messages.push({ type: "turnTranscript", transcript })
    } else messages.push({ type: "caption", text: result.transcript, isFinal: false })
  }
  const text = await reply(transcript)
  const out: Buffer[] = []
  for await (const chunk of createVoiceSpeechSynthesisAdapter(config).synthesize(text, signal)) {
    out.push(chunk)
    messages.push({ type: "ttsAudio", bytes: chunk.length })
  }
  return { messages, audio: Buffer.concat(out) }
}

// ── aws-transcribe-batch.adapter.ts ─────────────────────────────────

export const TWILIO_RECORDING_SID_PATTERN = /^RE[0-9a-f]{32}$/i
export const CARE_CHAT_CALL_RECORDING_KEY_PATTERN =
  /^care-chat\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/calls\/(RE[0-9a-f]{32})\.wav$/i
const TRANSCRIPT_OUTPUT_PREFIX = "care-chat-transcripts/"

export const transcriptionJobName = (recordingSid: string) => {
  if (!TWILIO_RECORDING_SID_PATTERN.test(recordingSid)) throw new Error("invalid RecordingSid")
  return `care-chat-${recordingSid.toLowerCase()}`
}

const getErrorName = (error: unknown) =>
  error && typeof error === "object" && "name" in error && typeof error.name === "string"
    ? error.name
    : null

export type CallTranscriptionJobState =
  | { status: "NOT_FOUND" }
  | { status: "FAILED"; failureReason: string | null }
  | { status: "COMPLETED"; transcriptFileUri: string }
  | { status: "QUEUED" | "IN_PROGRESS" }

export class AwsTranscribeBatchAdapter {
  private readonly client: TranscribeClient
  constructor(
    private readonly config: Config & {
      AWS_REGION: string
      AWS_ACCESS_KEY_ID: string
      AWS_SECRET_ACCESS_KEY: string
      AWS_S3_RESULTS_BUCKET: string
    },
  ) {
    this.client = new TranscribeClient({
      region: config.AWS_REGION,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    })
  }

  async startJob(params: { recordingSid: string; recordingKey: string }) {
    const keySid = CARE_CHAT_CALL_RECORDING_KEY_PATTERN.exec(params.recordingKey)?.[1]
    if (keySid?.toLowerCase() !== params.recordingSid.toLowerCase())
      throw new Error("Call recording key does not match the RecordingSid")
    const jobName = transcriptionJobName(params.recordingSid)
    try {
      await this.client.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: "en-US",
          MediaFormat: "wav",
          Media: {
            MediaFileUri: `s3://${this.config.AWS_S3_RESULTS_BUCKET}/${params.recordingKey}`,
          },
          Settings: { ChannelIdentification: true },
          OutputBucketName: this.config.AWS_S3_RESULTS_BUCKET,
          OutputKey: `${TRANSCRIPT_OUTPUT_PREFIX}${jobName}.json`,
        }),
      )
    } catch (error) {
      if (getErrorName(error) !== "ConflictException") throw error
    }
  }

  async getJob(recordingSid: string): Promise<CallTranscriptionJobState> {
    let response: GetTranscriptionJobCommandOutput
    try {
      response = await this.client.send(
        new GetTranscriptionJobCommand({
          TranscriptionJobName: transcriptionJobName(recordingSid),
        }),
      )
    } catch (error) {
      if (getErrorName(error) === "BadRequestException") return { status: "NOT_FOUND" }
      throw error
    }
    const job = response.TranscriptionJob
    if (
      !job ||
      !["QUEUED", "IN_PROGRESS", "FAILED", "COMPLETED"].includes(job.TranscriptionJobStatus ?? "")
    ) {
      throw new Error("AWS Transcribe returned an invalid job response")
    }
    if (job.TranscriptionJobStatus === "FAILED")
      return { status: "FAILED", failureReason: job.FailureReason?.trim() || null }
    if (job.TranscriptionJobStatus === "COMPLETED") {
      const uri = job.Transcript?.TranscriptFileUri
      if (!uri) throw new Error("AWS Transcribe completed without a transcript location")
      new URL(uri) // z.string().url()
      return { status: "COMPLETED", transcriptFileUri: uri }
    }
    return { status: job.TranscriptionJobStatus as "QUEUED" | "IN_PROGRESS" }
  }

  /** `transcriptKeyFromUrl`: the S3 key, only for our bucket and prefix (path or virtual-hosted). */
  transcriptKey(uri: string): string | null {
    const url = new URL(uri)
    if (url.protocol !== "https:") return null
    const bucket = this.config.AWS_S3_RESULTS_BUCKET
    const prefix = `/${TRANSCRIPT_OUTPUT_PREFIX}`
    const virtual = new Set([
      `${bucket}.s3.${this.config.AWS_REGION}.amazonaws.com`,
      `${bucket}.s3.amazonaws.com`,
    ])
    if (virtual.has(url.host) && url.pathname.startsWith(prefix)) return url.pathname.slice(1)
    const pathStyle = new Set([`s3.${this.config.AWS_REGION}.amazonaws.com`, "s3.amazonaws.com"])
    if (pathStyle.has(url.host) && url.pathname.startsWith(`/${bucket}${prefix}`))
      return url.pathname.slice(bucket.length + 2)
    return null
  }
}
