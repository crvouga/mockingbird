import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { SPEECH_PRESETS } from "./src/index.js"
import { createServer, type SpeechServer } from "./src/server.js"
import {
  AwsTranscribeBatchAdapter,
  AwsVoiceSpeechSynthesisAdapter,
  AwsVoiceStreamingSpeechSynthesisAdapter,
  AwsVoiceTranscriptionAdapter,
  type Config,
  createVoiceSpeechSynthesisAdapter,
  type GatewayMessage,
  voiceRoundTrip,
} from "./test/consumer.js"

const ENV = [
  "AWS_ENDPOINT_URL_POLLY",
  "AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING",
  "AWS_ENDPOINT_URL_TRANSCRIBE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
]
const saved: Record<string, string | undefined> = {}
let server: SpeechServer

beforeAll(async () => {
  server = await createServer()
  for (const key of ENV) saved[key] = process.env[key]
  // The seam: the SDKs' own endpoint variables, and the default credential chain.
  process.env.AWS_ENDPOINT_URL_POLLY = server.url
  process.env.AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING = server.url
  process.env.AWS_ENDPOINT_URL_TRANSCRIBE = server.url
  process.env.AWS_ACCESS_KEY_ID = "AKIDVOICE"
  process.env.AWS_SECRET_ACCESS_KEY = "mock-secret"
})

afterAll(async () => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await server.close()
})

beforeEach(async () => {
  await admin("/reset?all=1", {})
  await admin("/faults", undefined, "DELETE")
  await admin("/requests?all=1", undefined, "DELETE")
})

const admin = async (
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) => {
  const response = await fetch(`${server.url}/__admin${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return (await response.json()) as Record<string, unknown>
}

const signal = () => new AbortController().signal
const collect = async (chunks: AsyncIterable<Buffer>) => {
  const out: Buffer[] = []
  for await (const chunk of chunks) out.push(chunk)
  return Buffer.concat(out)
}
/** 100 ms frames of 16 kHz PCM silence, as the gateway forwards them. */
const micAudio = (frames: number) => Array.from({ length: frames }, () => Buffer.alloc(3_200))
const config = (extra: Config = {}): Config => ({ AWS_REGION: "us-east-1", ...extra })

describe("S13 acceptance: the /v2/chatbot/voice round trip against the mock (CHATBOT_VOICE_MOCK off)", () => {
  for (const transport of ["synthesize", "stream"] as const) {
    test(`transcribe → reply → speak, TTS transport ${transport}`, async () => {
      await admin(
        "/transcripts",
        {
          match: { any: true },
          partials: ["I have", "I have a headache"],
          final: "I have a headache.",
        },
        "PUT",
      )
      const { messages, audio } = await voiceRoundTrip(
        config({ CHATBOT_VOICE_TTS_TRANSPORT: transport }),
        micAudio(5),
        async (transcript) => `You said: ${transcript}`,
      )
      const text = messages.filter(
        (m): m is Extract<GatewayMessage, { type: "caption" | "turnTranscript" }> =>
          m.type !== "ttsAudio",
      )
      expect(text).toEqual([
        { type: "caption", text: "I have", isFinal: false },
        { type: "caption", text: "I have a headache", isFinal: false },
        { type: "turnTranscript", transcript: "I have a headache." },
      ])
      expect(audio.length).toBeGreaterThan(0)
      expect(audio.length % 2).toBe(0)
      // 24 kHz PCM out, 60 ms per character of the reply.
      const replyMs = "You said: I have a headache.".length * 60
      expect(Math.abs(audio.length / 2 / 24 - replyMs)).toBeLessThan(40)
      const log = (await admin("/speech")) as { entries: { operation: string }[] }
      expect(log.entries.map((e) => e.operation)).toContain(
        transport === "stream" ? "StartSpeechSynthesisStream" : "SynthesizeSpeech",
      )
    })
  }
})

describe("Polly SynthesizeSpeech", () => {
  test("raw PCM s16le, even byte count, deterministic, proportional to text length", async () => {
    const adapter = new AwsVoiceSpeechSynthesisAdapter(config())
    const short = await collect(adapter.synthesize("Hi.", signal()))
    const again = await collect(adapter.synthesize("Hi.", signal()))
    const long = await collect(adapter.synthesize("Hi. This reply is ten times longer.", signal()))
    expect(short.length % 2).toBe(0)
    expect(short.equals(again)).toBe(true)
    expect(long.length / short.length).toBeCloseTo(
      "Hi. This reply is ten times longer.".length / 3,
      0,
    )
    const raw = await fetch(`${server.url}/v1/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        Engine: "generative",
        VoiceId: "Ruth",
        OutputFormat: "pcm",
        SampleRate: "16000",
        Text: "abc",
      }),
    })
    expect(raw.headers.get("content-type")).toBe("audio/pcm")
    expect(raw.headers.get("x-amzn-requestcharacters")).toBe("3")
    expect((await raw.arrayBuffer()).byteLength).toBe(3 * 60 * 16 * 2)
  })

  test("errors carry the modelled exception names", async () => {
    const call = (body: Record<string, unknown>) =>
      fetch(`${server.url}/v1/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ VoiceId: "Ruth", OutputFormat: "pcm", Text: "x", ...body }),
      })
    const rate = await call({ SampleRate: "22050" })
    expect({ status: rate.status, type: rate.headers.get("x-amzn-errortype") }).toEqual({
      status: 400,
      type: "InvalidSampleRateException",
    })
    const long = await call({ Text: "x".repeat(3_001) })
    expect(long.headers.get("x-amzn-errortype")).toBe("TextLengthExceededException")
    const voice = await call({ VoiceId: "Nobody" })
    expect(voice.headers.get("x-amzn-errortype")).toBe("ValidationException")
    await admin("/faults", { preset: "polly_throttling", count: 1 })
    const adapter = new AwsVoiceSpeechSynthesisAdapter(config())
    // The SDK's standard retry absorbs one throttle.
    expect((await collect(adapter.synthesize("Hi", signal()))).length).toBeGreaterThan(0)
  })
})

describe("Polly StartSpeechSynthesisStream (HTTP/2 duplex)", () => {
  test("valid 24 kHz MP3 frames that mpg123 decodes, then the required StreamClosedEvent", async () => {
    const fallback = { synthesize: async function* () {} }
    const adapter = new AwsVoiceStreamingSpeechSynthesisAdapter(config(), fallback)
    const pcm = await collect(adapter.synthesize("Streaming reply.", signal()))
    expect(adapter.lastFallback).toBeUndefined()
    // mpg123 decoded MP3 at 24 kHz: 576-sample frames covering 60 ms per character.
    expect(pcm.length / 2).toBeGreaterThanOrEqual("Streaming reply.".length * 60 * 24)
    expect((pcm.length / 2) % 576).toBe(0)
  })

  for (const [preset, name] of [
    ["polly_stream_throttling", "ThrottlingException"],
    ["polly_stream_validation", "ValidationException"],
    ["polly_stream_quota", "ServiceQuotaExceededException"],
  ] as const) {
    test(`${preset}: an exception event before the first byte falls back to SynthesizeSpeech`, async () => {
      await admin("/faults", { preset, count: 1 })
      const adapter = new AwsVoiceStreamingSpeechSynthesisAdapter(
        config(),
        new AwsVoiceSpeechSynthesisAdapter(config()),
      )
      const pcm = await collect(adapter.synthesize("Fallback please.", signal()))
      expect(adapter.lastFallback).toBe(name)
      // Our adapter resamples each PCM chunk 16 → 24 kHz, losing a sample per chunk boundary.
      expect(Math.abs(pcm.length - "Fallback please.".length * 60 * 24 * 2)).toBeLessThanOrEqual(8)
    })
  }

  test("a stream that ends without StreamClosedEvent after audio is an error, not a fallback", async () => {
    await admin("/faults", { preset: "polly_stream_no_close", count: 1 })
    const adapter = new AwsVoiceStreamingSpeechSynthesisAdapter(
      config(),
      new AwsVoiceSpeechSynthesisAdapter(config()),
    )
    const error = await collect(adapter.synthesize("No close.", signal())).catch((e: unknown) => e)
    expect((error as Error).message).toBe("Amazon Polly speech stream ended without closing")
  })

  test("a non-generative engine keeps the synthesize transport (and the stream refuses it)", async () => {
    expect(
      createVoiceSpeechSynthesisAdapter(
        config({ CHATBOT_VOICE_TTS_TRANSPORT: "stream", CHATBOT_VOICE_TTS_ENGINE: "neural" }),
      ),
    ).toBeInstanceOf(AwsVoiceSpeechSynthesisAdapter)
    const refused = await fetch(`${server.url}/v1/synthesisStream`, {
      method: "POST",
      headers: {
        "x-amzn-engine": "neural",
        "x-amzn-voiceid": "Matthew",
        "x-amzn-outputformat": "mp3",
        "x-amzn-samplerate": "24000",
      },
      body: new Uint8Array(0),
    })
    expect(refused.status).toBe(400)
    expect(refused.headers.get("x-amzn-errortype")).toBe("ValidationException")
  })
})

describe("Transcribe StartStreamTranscription (HTTP/2 duplex)", () => {
  test("scripts pick a session by index; unscripted sessions hear the default", async () => {
    await admin(
      "/transcripts",
      {
        transcripts: [
          { id: "second", match: { sessionIndex: 1 }, partials: ["two"], final: "Second session." },
        ],
      },
      "PUT",
    )
    const adapter = new AwsVoiceTranscriptionAdapter(
      config({ CHATBOT_VOICE_VOCABULARY_NAME: "geviti-terms" }),
    )
    const run = async () => {
      const results = []
      for await (const result of adapter.transcribeTurn(
        (async function* () {
          yield* micAudio(2)
        })(),
        { signal: signal() },
      ))
        results.push(result)
      return results
    }
    expect(await run()).toEqual([{ transcript: "Hello.", isFinal: true }])
    expect(await run()).toEqual([
      { transcript: "two", isFinal: false },
      { transcript: "Second session.", isFinal: true },
    ])
    const stats = (await admin("/transcripts")) as {
      stats: { sessions: number; scripted: number; unscripted: number }
    }
    expect(stats.stats).toEqual({ sessions: 2, scripted: 1, unscripted: 1 })
    const journal = (await admin("/requests?operationId=StartStreamTranscription")) as {
      requests: { ids: Record<string, string> }[]
    }
    expect(journal.requests.map((r) => r.ids.transcript)).toEqual(["unscripted", "second"])
  })

  test("faults: BadRequestException / LimitExceededException before the stream, InternalFailureException mid-stream", async () => {
    const adapter = new AwsVoiceTranscriptionAdapter(config())
    const drain = async () => {
      const out = []
      for await (const r of adapter.transcribeTurn(
        (async function* () {
          yield* micAudio(3)
        })(),
        { signal: signal() },
      ))
        out.push(r)
      return out
    }
    for (const [preset, name] of [
      ["transcribe_bad_request", "BadRequestException"],
      ["transcribe_limit_exceeded", "LimitExceededException"],
    ] as const) {
      await admin("/faults", { preset, count: 3 })
      expect(((await drain().catch((e: unknown) => e)) as Error).name).toBe(name)
      await admin("/faults", undefined, "DELETE")
    }
    await admin(
      "/transcripts",
      { match: { any: true }, partials: ["one", "one two"], final: "One two three." },
      "PUT",
    )
    await admin("/faults", { preset: "transcribe_mid_stream_failure", count: 1 })
    const partial: unknown[] = []
    const error = await (async () => {
      for await (const r of adapter.transcribeTurn(
        (async function* () {
          yield* micAudio(3)
        })(),
        { signal: signal() },
      ))
        partial.push(r)
    })().catch((e: unknown) => e)
    expect(partial).toEqual([{ transcript: "one", isFinal: false }])
    expect((error as Error).name).toBe("InternalFailureException")
  })
})

describe("Transcribe batch (JSON 1.1): the call-recording adapter", () => {
  const SID = `RE${"a1".repeat(16)}`
  const KEY = `care-chat/123e4567-e89b-42d3-a456-426614174000/calls/${SID}.wav`
  const batchConfig = {
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "AKIDBATCH",
    AWS_SECRET_ACCESS_KEY: "s",
    AWS_S3_RESULTS_BUCKET: "geviti-results",
  }

  test("start → IN_PROGRESS → COMPLETED on the mock clock, with a TranscriptFileUri our adapter accepts", async () => {
    const adapter = new AwsTranscribeBatchAdapter(batchConfig)
    await admin(
      "/transcripts",
      {
        match: { jobName: `care-chat-${SID.toLowerCase()}` },
        final: "Patient: my refill is late.",
      },
      "PUT",
    )
    expect(await adapter.getJob(SID)).toEqual({ status: "NOT_FOUND" })
    await adapter.startJob({ recordingSid: SID, recordingKey: KEY })
    // A retried start is a ConflictException our adapter swallows.
    await adapter.startJob({ recordingSid: SID, recordingKey: KEY })
    expect(await adapter.getJob(SID)).toEqual({ status: "IN_PROGRESS" })
    await admin("/clock", { advance: "3s" })
    const done = await adapter.getJob(SID)
    expect(done.status).toBe("COMPLETED")
    const uri = (done as { transcriptFileUri: string }).transcriptFileUri
    expect(uri).toBe(
      `https://s3.us-east-1.amazonaws.com/geviti-results/care-chat-transcripts/care-chat-${SID.toLowerCase()}.json`,
    )
    expect(adapter.transcriptKey(uri)).toBe(
      `care-chat-transcripts/care-chat-${SID.toLowerCase()}.json`,
    )
    const document = (await admin(`/jobs/care-chat-${SID.toLowerCase()}/transcript`)) as {
      results: { transcripts: { transcript: string }[]; channel_labels?: unknown }
    }
    expect(document.results.transcripts[0]?.transcript).toBe("Patient: my refill is late.")
    expect(document.results.channel_labels).toBeDefined()
  })

  test("a failed job reports its FailureReason; the preset fails the next job", async () => {
    const adapter = new AwsTranscribeBatchAdapter(batchConfig)
    await admin("/faults", { preset: "transcribe_job_failed", count: 1 })
    await adapter.startJob({ recordingSid: SID, recordingKey: KEY })
    expect(await adapter.getJob(SID)).toEqual({
      status: "FAILED",
      failureReason: "The media format provided does not match the detected media format.",
    })
  })
})

describe("contract", () => {
  test("namespaces by access key id isolate transcripts; the journal holds no text", async () => {
    await admin("/credentials", { credentials: { AKIDWORKER1: "w1" } }, "PUT")
    await admin(
      "/transcripts?namespace=w1",
      { match: { any: true }, final: "Worker one heard this." },
      "PUT",
    )
    const saved = process.env.AWS_ACCESS_KEY_ID
    process.env.AWS_ACCESS_KEY_ID = "AKIDWORKER1"
    try {
      const results = []
      for await (const r of new AwsVoiceTranscriptionAdapter(config()).transcribeTurn(
        (async function* () {
          yield* micAudio(1)
        })(),
        { signal: signal() },
      ))
        results.push(r)
      expect(results).toEqual([{ transcript: "Worker one heard this.", isFinal: true }])
      await collect(
        new AwsVoiceSpeechSynthesisAdapter(config()).synthesize("Secret words.", signal()),
      )
    } finally {
      process.env.AWS_ACCESS_KEY_ID = saved
    }
    const journal = JSON.stringify(await admin("/requests?namespace=w1"))
    expect(journal).toContain("SynthesizeSpeech")
    expect(journal).not.toContain("Secret")
    expect(journal).not.toContain("Worker one heard")
    expect(JSON.stringify(await admin("/speech?namespace=w1"))).not.toContain("Secret")
  })

  test("/health and every documented preset", async () => {
    const health = await fetch(`${server.url}/health`)
    expect(health.headers.get("x-mockingbird")).toMatch(/^aws-speech@/)
    expect(((await health.json()) as { service: string }).service).toBe("aws-speech")
    const listed = (await admin("/faults/presets")) as { presets: { name: string }[] }
    expect(listed.presets.map((p) => p.name).sort()).toEqual(Object.keys(SPEECH_PRESETS).sort())
  })
})
