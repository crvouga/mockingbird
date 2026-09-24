import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { connect } from "node:http2"
import {
  PollyClient,
  StartSpeechSynthesisStreamCommand,
  SynthesizeSpeechCommand,
} from "@aws-sdk/client-polly"
import {
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
} from "@aws-sdk/client-transcribe"
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
} from "@aws-sdk/client-transcribe-streaming"
import { EventStreamCodec } from "@smithy/eventstream-codec"
import { MPEGDecoder } from "mpg123-decoder"
import { decodeMessage, encodeMessage, mp3Audio } from "./src/index.js"
import { createServer, type SpeechServer } from "./src/server.js"

let server: SpeechServer
const credentials = { accessKeyId: "AKIDSDK", secretAccessKey: "mock-secret" }
const client = <T>(Client: new (config: Record<string, unknown>) => T) =>
  new Client({ region: "us-east-1", endpoint: server.url, credentials })

beforeAll(async () => {
  server = await createServer()
})
afterAll(async () => {
  await server.close()
})

const admin = (path: string, body: unknown, method = "PUT") =>
  fetch(`${server.url}/__admin${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("@aws-sdk/client-polly@3.1132.0 (h2c)", () => {
  test("SynthesizeSpeech in pcm and mp3", async () => {
    const polly = client(PollyClient)
    const pcm = await polly.send(
      new SynthesizeSpeechCommand({
        Engine: "generative",
        VoiceId: "Danielle",
        OutputFormat: "pcm",
        SampleRate: "16000",
        Text: "Hello there",
      }),
    )
    expect(pcm.ContentType).toBe("audio/pcm")
    expect(pcm.RequestCharacters).toBe(11)
    const bytes = await pcm.AudioStream?.transformToByteArray()
    expect(bytes?.length).toBe(11 * 60 * 16 * 2)
    const mp3 = await polly.send(
      new SynthesizeSpeechCommand({
        Engine: "neural",
        VoiceId: "Matthew",
        OutputFormat: "mp3",
        Text: "Hi",
      }),
    )
    expect(mp3.ContentType).toBe("audio/mpeg")
    const frames = (await mp3.AudioStream?.transformToByteArray()) as Uint8Array
    const decoder = new MPEGDecoder()
    await decoder.ready
    const decoded = decoder.decode(frames)
    decoder.free()
    expect(decoded.errors).toEqual([])
    expect(decoded.sampleRate).toBe(24_000)
  })

  test("StartSpeechSynthesisStream: AudioEvents then StreamClosedEvent with RequestCharacters", async () => {
    const polly = client(PollyClient)
    const response = await polly.send(
      new StartSpeechSynthesisStreamCommand({
        Engine: "generative",
        VoiceId: "Ruth",
        OutputFormat: "mp3",
        SampleRate: "24000",
        ActionStream: (async function* () {
          yield { TextEvent: { Text: "First sentence.", TextType: "text" as const } }
          yield { TextEvent: { Text: "Second.", TextType: "text" as const } }
          yield { CloseStreamEvent: {} }
        })(),
      }),
    )
    let audio = 0
    let closed: number | undefined
    for await (const event of response.EventStream ?? []) {
      if (event.AudioEvent?.AudioChunk) audio += event.AudioEvent.AudioChunk.length
      if (event.StreamClosedEvent) closed = event.StreamClosedEvent.RequestCharacters
    }
    expect(closed).toBe("First sentence.".length + "Second.".length)
    expect(audio).toBe(mp3Audio(15 * 60, 24_000).length + mp3Audio(7 * 60, 24_000).length)
  })
})

describe("@aws-sdk/client-transcribe-streaming@3.1132.0 (h2c duplex)", () => {
  test("StartStreamTranscription echoes the x-amzn-transcribe-* parameters and streams partials then a final", async () => {
    await admin("/transcripts", { match: { any: true }, partials: ["a", "a b"], final: "A b c." })
    const transcribe = client(TranscribeStreamingClient)
    const response = await transcribe.send(
      new StartStreamTranscriptionCommand({
        LanguageCode: "en-US",
        MediaEncoding: "pcm",
        MediaSampleRateHertz: 16_000,
        EnablePartialResultsStabilization: true,
        PartialResultsStability: "high",
        VocabularyName: "acme-terms",
        AudioStream: (async function* () {
          for (let i = 0; i < 3; i++) yield { AudioEvent: { AudioChunk: new Uint8Array(3_200) } }
        })(),
      }),
    )
    expect(response.LanguageCode).toBe("en-US")
    expect(response.MediaSampleRateHertz).toBe(16_000)
    expect(response.MediaEncoding).toBe("pcm")
    expect(response.VocabularyName).toBe("acme-terms")
    expect(response.SessionId).toMatch(/^[0-9a-f-]{36}$/)
    const results: [boolean | undefined, string | undefined][] = []
    for await (const event of response.TranscriptResultStream ?? []) {
      for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
        results.push([result.IsPartial, result.Alternatives?.[0]?.Transcript])
      }
    }
    expect(results).toEqual([
      [true, "a"],
      [true, "a b"],
      [false, "A b c."],
    ])
  })

  test("a bad parameter is a BadRequestException before the stream opens", async () => {
    const transcribe = client(TranscribeStreamingClient)
    const error = await transcribe
      .send(
        new StartStreamTranscriptionCommand({
          LanguageCode: "en-US",
          MediaEncoding: "pcm",
          MediaSampleRateHertz: 4_000,
          AudioStream: (async function* () {
            yield { AudioEvent: { AudioChunk: new Uint8Array(2) } }
          })(),
        }),
      )
      .catch((e: unknown) => e)
    expect((error as Error).name).toBe("BadRequestException")
  })
})

describe("@aws-sdk/client-transcribe@3.1132.0 (JSON 1.1 over HTTP/1.1)", () => {
  test("StartTranscriptionJob / GetTranscriptionJob, ConflictException, BadRequestException", async () => {
    await admin("/settings", { jobDurationMs: 0 })
    const transcribe = client(TranscribeClient)
    const started = await transcribe.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: "sdk-job-1",
        LanguageCode: "en-US",
        MediaFormat: "wav",
        Media: { MediaFileUri: "s3://bucket/calls/one.wav" },
        OutputBucketName: "bucket",
        OutputKey: "out/sdk-job-1.json",
      }),
    )
    expect(started.TranscriptionJob?.TranscriptionJobStatus).toBe("IN_PROGRESS")
    expect(started.TranscriptionJob?.CreationTime).toBeInstanceOf(Date)
    const dup = await transcribe
      .send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: "sdk-job-1",
          LanguageCode: "en-US",
          Media: { MediaFileUri: "s3://bucket/calls/one.wav" },
        }),
      )
      .catch((e: unknown) => e)
    expect((dup as Error).name).toBe("ConflictException")
    const got = await transcribe.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: "sdk-job-1" }),
    )
    expect(got.TranscriptionJob?.TranscriptionJobStatus).toBe("COMPLETED")
    expect(got.TranscriptionJob?.Transcript?.TranscriptFileUri).toBe(
      "https://s3.us-east-1.amazonaws.com/bucket/out/sdk-job-1.json",
    )
    const missing = await transcribe
      .send(new GetTranscriptionJobCommand({ TranscriptionJobName: "nope" }))
      .catch((e: unknown) => e)
    expect((missing as Error).name).toBe("BadRequestException")
  })

  test("completed transcripts land in the stack's S3 when a transcript store is configured", async () => {
    const puts: { path: string; body: string }[] = []
    const s3 = Bun.serve({
      port: 0,
      fetch: async (request) => {
        puts.push({ path: new URL(request.url).pathname, body: await request.text() })
        return new Response(null, { status: 200 })
      },
    })
    const withStore = await createServer({
      transcriptStore: { endpoint: `http://127.0.0.1:${s3.port}` },
      settings: { jobDurationMs: 0 },
    })
    try {
      const transcribe = new TranscribeClient({
        region: "us-west-2",
        endpoint: withStore.url,
        credentials,
      })
      await transcribe.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: "stored",
          LanguageCode: "en-US",
          Media: { MediaFileUri: "s3://results/a.wav" },
          OutputBucketName: "results",
          OutputKey: "care-chat-transcripts/stored.json",
        }),
      )
      const got = await transcribe.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: "stored" }),
      )
      expect(got.TranscriptionJob?.Transcript?.TranscriptFileUri).toBe(
        "https://s3.us-west-2.amazonaws.com/results/care-chat-transcripts/stored.json",
      )
      const deadline = Date.now() + 2_000
      while (puts.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect(puts[0]?.path).toBe("/results/care-chat-transcripts/stored.json")
      expect(JSON.parse(puts[0]?.body ?? "{}").results.transcripts[0].transcript).toBe("Hello.")
    } finally {
      await withStore.close()
      s3.stop(true)
    }
  })
})

describe("the wire", () => {
  test("our frames and smithy's decode each other byte for byte", () => {
    const codec = new EventStreamCodec(
      (bytes) => new TextDecoder().decode(bytes),
      (text) => new TextEncoder().encode(text),
    )
    const ours = encodeMessage({
      headers: {
        ":event-type": "AudioEvent",
        ":content-type": "application/octet-stream",
        ":message-type": "event",
      },
      body: new Uint8Array([1, 2, 3]),
    })
    expect([...codec.decode(ours).body]).toEqual([1, 2, 3])
    const signed = codec.encode({
      headers: {
        ":chunk-signature": { type: "binary", value: new Uint8Array(32) },
        ":date": { type: "timestamp", value: new Date(0) },
      },
      body: ours,
    })
    expect(decodeMessage(decodeMessage(signed).body).headers[":event-type"]).toEqual({
      type: "string",
      value: "AudioEvent",
    })
  })

  test("h2c prior knowledge and HTTP/1.1 share the port", async () => {
    const session = connect(server.url)
    const request = session.request({ ":method": "GET", ":path": "/health" })
    let body = ""
    for await (const chunk of request) body += chunk
    session.close()
    expect(JSON.parse(body).service).toBe("aws-speech")
    expect(
      ((await (await fetch(`${server.url}/health`)).json()) as { service: string }).service,
    ).toBe("aws-speech")
  })
})
