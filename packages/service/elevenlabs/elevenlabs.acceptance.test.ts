import { describe, expect, test } from "bun:test"
import { toBase64 } from "@crvouga/mockingbird-service"
import {
  createRuntime,
  DEFAULT_API_KEY,
  DEFAULT_MODEL_ID,
  DEFAULT_VOICES,
  ELEVENLABS_PRESETS,
  type ElevenLabsRuntimeOptions,
  mp3Audio,
  pcmAudio,
  type ScriptView,
  speechFingerprint,
  textFingerprint,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  CachedTts,
  ElevenLabsTtsAdapter,
  type TtsFormat,
  TtsHttpError,
  withRetry,
} from "./test/consumer.js"
import { parseMp3 } from "./test/mp3.js"

const ORIGIN = "http://elevenlabs.mock"
const VOICE = DEFAULT_VOICES[0]?.voice_id as string
const MODEL = DEFAULT_MODEL_ID
/** Stands in for a real prompt: no test may find it in anything the mock keeps or shows. */
const PROMPT = "synthetic-private-prompt: the quick brown fox"
/** Scripted audio that no generated answer equals: a valid MP3 on a tone outside the default set. */
const SCRIPTED = mp3Audio(44_100, 128, 400, 21)

const harness = (options: ElevenLabsRuntimeOptions = {}) => {
  const runtime = createRuntime(options)
  const adapter = (
    overrides: { apiKey?: string | undefined; namespace?: string; baseUrl?: string } = {},
  ) =>
    new ElevenLabsTtsAdapter({
      baseUrl: overrides.baseUrl ?? `${ORIGIN}/v1`,
      apiKey: "apiKey" in overrides ? overrides.apiKey : DEFAULT_API_KEY,
      fetch: (request) => runtime.fetch(request),
      ...(overrides.namespace
        ? { headers: { "x-mockingbird-namespace": overrides.namespace } }
        : {}),
    })
  const admin = async (
    path: string,
    body?: unknown,
    init: { method?: string; namespace?: string } = {},
  ) => {
    const response = await runtime.fetch(
      new Request(`${ORIGIN}/__admin${path}`, {
        method: init.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          ...(init.namespace ? { "x-mockingbird-namespace": init.namespace } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    // biome-ignore lint/suspicious/noExplicitAny: admin bodies are read loosely in assertions
    return { status: response.status, body: (await response.json()) as any }
  }
  const queue = async (script: Record<string, unknown>, namespace?: string) => {
    const { audio, ...rest } = script as { audio?: Uint8Array }
    const queued = await admin(
      "/scripts",
      { ...rest, ...(audio ? { audio_base64: toBase64(audio) } : {}) },
      namespace ? { namespace } : {},
    )
    expect(queued.status).toBe(201)
    return queued.body as ScriptView
  }
  /** The convert route, by hand: for requests the consumer's adapter never sends. */
  const raw = (query: string, init: RequestInit) =>
    runtime.fetch(new Request(`${ORIGIN}/v1/text-to-speech/${VOICE}${query}`, init))
  return { runtime, adapter, admin, queue, raw }
}

const say = (text = PROMPT, format: TtsFormat = "mp3", voiceId = VOICE, modelId = MODEL) => ({
  voiceId,
  modelId,
  text,
  format,
})

const failure = async (attempt: Promise<unknown>): Promise<TtsHttpError> => {
  const error = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(TtsHttpError)
  return error as TtsHttpError
}

describe("behavior 1: a valid key, voice and model get audio", () => {
  test("a scripted reply comes back 200 audio/mpeg with exactly the queued bytes", async () => {
    const { adapter, queue, runtime } = harness()
    await queue({ match: { voice_id: VOICE, text: PROMPT }, audio: SCRIPTED })
    const audio = await adapter().synthesize(say())
    expect(audio.contentType).toBe("audio/mpeg")
    expect(audio.bytes).toEqual(SCRIPTED)
    const [entry] = runtime.journal.list()
    expect(entry).toMatchObject({ operationId: "ConvertTextToSpeech", status: 200 })
  })

  test("unscripted mp3_44100_128 is a decodable MPEG-1 Layer III stream at 44.1 kHz, 128 kbit/s", async () => {
    const { adapter } = harness()
    const audio = await adapter().synthesize(say())
    expect(audio.contentType).toBe("audio/mpeg")
    const frames = parseMp3(audio.bytes)
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame).toMatchObject({ mpeg: 1, sampleRate: 44_100, bitrate: 128, channels: 1 })
    }
    // 50 ms of audio per character, rounded up to whole 1152-sample frames.
    expect(frames).toHaveLength(Math.ceil((44_100 * PROMPT.length * 0.05) / 1152))
  })

  test("unscripted pcm_44100 is 16-bit mono samples at 44.1 kHz", async () => {
    const { adapter } = harness()
    const audio = await adapter().synthesize(say(PROMPT, "pcm"))
    expect(audio.bytes.length % 2).toBe(0)
    expect(audio.bytes.length / 2).toBe(Math.round(44_100 * PROMPT.length * 0.05))
  })

  test("the answer carries the vendor's cost and request id headers", async () => {
    const { raw } = harness()
    const response = await raw("", {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": DEFAULT_API_KEY },
      body: JSON.stringify({ text: "héllo 👋" }),
    })
    expect(response.status).toBe(200)
    // No output_format and no model_id: the vendor's defaults, mp3_44100_128 and multilingual v2.
    expect(response.headers.get("content-type")).toBe("audio/mpeg")
    expect(response.headers.get("character-cost")).toBe("7")
    expect(response.headers.get("request-id")).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(response.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/)
    expect(Number(response.headers.get("content-length"))).toBe(
      (await response.arrayBuffer()).byteLength,
    )
  })
})

describe("behavior 2: each format keeps its container, or its lack of one", () => {
  test("mp3_44100_128 is frames from the first byte to the last, never a header before junk", async () => {
    const { adapter } = harness()
    const { bytes } = await adapter().synthesize(say())
    // parseMp3 throws unless every byte sits in a complete frame with coherent side
    // information and Huffman data.
    const frames = parseMp3(bytes)
    expect(frames[0]?.offset).toBe(0)
    expect(frames.reduce((sum, frame) => sum + frame.length, 0)).toBe(bytes.length)
    for (const frame of frames) {
      expect(frame.length).toBe(frame.padding ? 418 : 417)
      // Each granule codes one spectral line: audible, and the same line throughout.
      expect(frame.lines).toEqual([
        frames[0]?.lines[0] as number[],
        frames[0]?.lines[0] as number[],
      ])
    }
  })

  test("pcm_44100 stays headerless samples although the consumer sends Accept: audio/wav", async () => {
    const { adapter, raw } = harness()
    const pcm = await adapter().synthesize(say(PROMPT, "pcm"))
    // The discrepancy the request asks to keep visible: the consumer asked for WAV and did
    // not get one. There is no RIFF header to skip, and the type is not audio/wav.
    expect(pcm.contentType).toBe("audio/pcm")
    expect(new TextDecoder().decode(pcm.bytes.slice(0, 4))).not.toBe("RIFF")
    // The same request as wav_44100 is those samples behind a 44-byte header.
    const wav = await raw("?output_format=wav_44100", {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": DEFAULT_API_KEY },
      body: JSON.stringify({ text: PROMPT, model_id: MODEL }),
    })
    expect(wav.headers.get("content-type")).toBe("audio/wav")
    const container = new Uint8Array(await wav.arrayBuffer())
    expect(new TextDecoder().decode(container.slice(0, 4))).toBe("RIFF")
    expect(container.length).toBe(pcm.bytes.length + 44)
    // Same samples, apart from the pitch: a different format is a different request.
    const view = new DataView(pcm.bytes.buffer)
    const peak = Math.max(
      ...Array.from({ length: pcm.bytes.length / 2 }, (_, i) =>
        Math.abs(view.getInt16(i * 2, true)),
      ),
    )
    expect(peak).toBeGreaterThan(8_000)
    expect(peak).toBeLessThanOrEqual(8_192)
  })
})

describe("behavior 3: rejected requests get the vendor's status and error envelope", () => {
  const envelope = (error: TtsHttpError) =>
    (error.body as { detail: Record<string, unknown> }).detail

  test("a missing key is 401 needs_authorization", async () => {
    const { adapter } = harness()
    const error = await failure(adapter({ apiKey: undefined }).synthesize(say()))
    expect(error.status).toBe(401)
    expect(envelope(error)).toEqual({
      type: "authentication_error",
      code: "unauthorized",
      message: "Neither authorization header nor xi-api-key received, please provide one.",
      status: "needs_authorization",
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
  })

  test("a wrong key is 401 invalid_api_key", async () => {
    const { adapter } = harness()
    const error = await failure(adapter({ apiKey: "not-the-configured-key" }).synthesize(say()))
    expect(error.status).toBe(401)
    expect(envelope(error)).toEqual({
      type: "authentication_error",
      code: "unauthorized",
      message: "Invalid API key",
      status: "invalid_api_key",
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
  })

  test("a voice that is not configured is 404 voice_not_found", async () => {
    const { adapter } = harness()
    const error = await failure(adapter().synthesize(say(PROMPT, "mp3", "no-such-voice")))
    expect(error.status).toBe(404)
    expect(envelope(error)).toMatchObject({
      type: "not_found",
      code: "voice_not_found",
      status: "voice_not_found",
      param: "voice_id",
    })
  })

  test("a model that is not configured is 404 model_not_found; one that cannot speak is 400", async () => {
    const { adapter } = harness({
      models: [{ model_id: MODEL }, { model_id: "scribe_v1", can_do_text_to_speech: false }],
    })
    const missing = await failure(adapter().synthesize(say(PROMPT, "mp3", VOICE, "no-such-model")))
    expect(missing.status).toBe(404)
    expect(envelope(missing)).toMatchObject({
      type: "not_found",
      code: "model_not_found",
      status: "model_not_found",
      param: "model_id",
    })
    const mute = await failure(adapter().synthesize(say(PROMPT, "mp3", VOICE, "scribe_v1")))
    expect(mute.status).toBe(400)
    expect(envelope(mute)).toMatchObject({ type: "validation_error", code: "unsupported_model" })
  })

  test("empty text is 400 empty_text", async () => {
    const { adapter } = harness()
    const error = await failure(adapter().synthesize(say("")))
    expect(error.status).toBe(400)
    expect(envelope(error)).toMatchObject({
      type: "validation_error",
      code: "empty_text",
      status: "empty_text",
      param: "text",
    })
  })

  test("a body that is not JSON is 422 with the validator's error list", async () => {
    // The adapter always serializes its body, so this request is sent by hand.
    const { raw } = harness()
    const response = await raw("?output_format=mp3_44100_128", {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": DEFAULT_API_KEY },
      body: `{"text": "${PROMPT}`,
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        {
          type: "json_invalid",
          loc: ["body", 0],
          msg: "JSON decode error",
          input: {},
          ctx: { error: "Invalid JSON" },
        },
      ],
    })
  })

  test("a missing or mistyped field is 422, naming the field", async () => {
    const { raw } = harness()
    const post = async (body: string, contentType = "application/json") => {
      const response = await raw("", {
        method: "POST",
        headers: { "content-type": contentType, "xi-api-key": DEFAULT_API_KEY },
        body,
      })
      return { status: response.status, body: await response.json() }
    }
    const missing = {
      detail: [{ type: "missing", loc: ["body", "text"], msg: "Field required", input: null }],
    }
    expect(await post("{}")).toEqual({ status: 422, body: missing })
    // A JSON body the vendor cannot read as JSON (another media type) is a missing field too.
    expect(await post(JSON.stringify({ text: "hello" }), "text/plain")).toEqual({
      status: 422,
      body: missing,
    })
    expect(await post(JSON.stringify({ text: 5, model_id: 7 }))).toEqual({
      status: 422,
      body: {
        detail: [
          {
            type: "string_type",
            loc: ["body", "text"],
            msg: "Input should be a valid string",
            input: 5,
          },
          {
            type: "string_type",
            loc: ["body", "model_id"],
            msg: "Input should be a valid string",
            input: 7,
          },
        ],
      },
    })
  })

  test("an output_format the vendor does not list is 400 invalid_output_format", async () => {
    const { raw } = harness()
    const response = await raw("?output_format=wav", {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": DEFAULT_API_KEY },
      body: JSON.stringify({ text: PROMPT, model_id: MODEL }),
    })
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain("application/json")
    const { detail } = (await response.json()) as { detail: Record<string, unknown> }
    expect(detail).toMatchObject({
      type: "validation_error",
      code: "invalid_output_format",
      status: "invalid_output_format",
      param: "output_format",
    })
    expect(response.headers.get("x-trace-id")).toBe(detail.request_id as string)
  })

  test("the body is validated before the key, and the key before everything else", async () => {
    const { raw } = harness()
    const post = (query: string, body: string) =>
      raw(query, { method: "POST", headers: { "content-type": "application/json" }, body })
    // No key and a bad body: the vendor answers 422, not 401.
    expect((await post("", "{")).status).toBe(422)
    expect((await post("", "{}")).status).toBe(422)
    // No key, a readable body, and an unknown format, empty text or unknown voice: 401.
    expect((await post("?output_format=bogus", JSON.stringify({ text: "" }))).status).toBe(401)
  })

  test("another method on the route is 405, an unknown route 404, as the vendor's router answers", async () => {
    const { runtime } = harness()
    const wrongMethod = await runtime.fetch(new Request(`${ORIGIN}/v1/text-to-speech/${VOICE}`))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("POST")
    expect(await wrongMethod.json()).toEqual({ detail: "Method Not Allowed" })
    const unknown = await runtime.fetch(new Request(`${ORIGIN}/v1/voices`))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ detail: "Not Found" })
  })
})

describe("behavior 4: configured failures exercise the caller's handling and spare the script", () => {
  test("a one-shot quota or rate-limit failure is followed by the queued success", async () => {
    for (const [preset, status, code] of [
      ["quota_exceeded", 402, "quota_exceeded"],
      ["rate_limited", 429, "rate_limit_exceeded"],
    ] as const) {
      const { adapter, admin, queue } = harness()
      const script = await queue({ match: { text: PROMPT }, audio: SCRIPTED, times: 1 })
      expect((await admin(`/faults/presets/${preset}`, {})).status).toBe(201)

      const error = await failure(adapter().synthesize(say()))
      expect([error.status, error.code]).toEqual([status, code])
      // The failure answered in front of the mock: the one-shot script is still whole.
      expect((await admin("/scripts")).body.scripts).toEqual([{ ...script, remaining: 1, hits: 0 }])

      // The request after it is the success the suite queued.
      expect((await adapter().synthesize(say())).bytes).toEqual(SCRIPTED)
      expect((await admin("/scripts")).body.scripts).toEqual([{ ...script, remaining: 0, hits: 1 }])
    }
  })

  test("a retrying caller gets through a 429, a 5xx and a dropped connection, but not a 402", async () => {
    for (const preset of ["rate_limited", "system_busy", "server_error", "network_reset"]) {
      const { runtime, adapter, admin, queue } = harness()
      await queue({ audio: SCRIPTED, times: 1 })
      await admin(`/faults/presets/${preset}`, {})
      const audio = await withRetry(() => adapter().synthesize(say()))
      expect(audio.bytes).toEqual(SCRIPTED)
      // Two requests reached the mock's front door; one call was recorded.
      expect(runtime.journal.list()).toHaveLength(2)
      expect((await admin("/calls")).body.count).toBe(1)
    }
    const { runtime, adapter, admin } = harness()
    await admin("/faults/presets/quota_exceeded", {})
    const error = await failure(withRetry(() => adapter().synthesize(say())))
    expect(error.status).toBe(402)
    expect(runtime.journal.list()).toHaveLength(1)
  })

  test("a request the mock itself rejects does not use up a one-shot script either", async () => {
    const { adapter, admin, queue } = harness()
    await queue({ audio: SCRIPTED, times: 1 })
    await failure(adapter({ apiKey: "wrong" }).synthesize(say()))
    await failure(adapter().synthesize(say(PROMPT, "mp3", "no-such-voice")))
    await failure(adapter().synthesize(say(PROMPT, "mp3", VOICE, "no-such-model")))
    await failure(adapter().synthesize(say("")))
    expect((await admin("/scripts")).body.scripts[0]).toMatchObject({ remaining: 1, hits: 0 })
    expect((await adapter().synthesize(say())).bytes).toEqual(SCRIPTED)
  })

  test("a failure counted for several requests fails exactly that many", async () => {
    const { adapter, admin } = harness()
    await admin("/faults/presets/rate_limited", { count: 2 })
    expect((await failure(adapter().synthesize(say()))).status).toBe(429)
    expect((await failure(adapter().synthesize(say()))).status).toBe(429)
    expect((await adapter().synthesize(say())).contentType).toBe("audio/mpeg")
  })
})

describe("behavior 5: isolation between namespaces, and repeatable answers", () => {
  test("namespaces do not share scripts, audio or call records", async () => {
    const { adapter, admin, queue } = harness()
    await queue({ match: { text: PROMPT }, audio: SCRIPTED }, "worker-a")
    const a = await adapter({ namespace: "worker-a" }).synthesize(say())
    const b = await adapter({ namespace: "worker-b" }).synthesize(say())
    expect(a.bytes).toEqual(SCRIPTED)
    // The other namespace never sees the script: it gets generated audio.
    expect(b.bytes).not.toEqual(SCRIPTED)
    expect(parseMp3(b.bytes).length).toBeGreaterThan(0)
    expect((await admin("/scripts", undefined, { namespace: "worker-b" })).body.scripts).toEqual([])
    expect((await admin("/calls", undefined, { namespace: "worker-a" })).body.count).toBe(1)
    expect((await admin("/calls", undefined, { namespace: "worker-b" })).body.count).toBe(1)
    expect((await admin("/calls")).body.count).toBe(0)
    // Resetting one leaves the other's script and history alone.
    await admin("/reset", {}, { namespace: "worker-b" })
    expect((await adapter({ namespace: "worker-a" }).synthesize(say())).bytes).toEqual(SCRIPTED)
    expect((await admin("/calls", undefined, { namespace: "worker-a" })).body.count).toBe(2)
  })

  test("separate instances do not share scripts or audio", async () => {
    const first = harness()
    const second = harness()
    await first.queue({ audio: SCRIPTED })
    expect((await first.adapter().synthesize(say())).bytes).toEqual(SCRIPTED)
    expect((await second.adapter().synthesize(say())).bytes).not.toEqual(SCRIPTED)
    expect((await second.admin("/scripts")).body.scripts).toEqual([])
  })

  test("the same scripted request answers the same bytes every time", async () => {
    const { adapter, admin, queue } = harness()
    await queue({ match: { voice_id: VOICE, model_id: MODEL, text: PROMPT }, audio: SCRIPTED })
    for (let repeat = 0; repeat < 4; repeat++) {
      expect((await adapter().synthesize(say())).bytes).toEqual(SCRIPTED)
    }
    expect((await admin("/scripts")).body.scripts[0]).toMatchObject({ hits: 4, remaining: null })
    const fingerprint = speechFingerprint({ voice_id: VOICE, model_id: MODEL, text: PROMPT })
    expect((await admin(`/calls?fingerprint=${fingerprint}`)).body.count).toBe(4)
  })

  test("a cache in front of the adapter calls the vendor once per distinct request", async () => {
    const { adapter, admin, queue } = harness()
    await queue({ match: { text: PROMPT }, audio: SCRIPTED })
    const cached = new CachedTts(adapter())
    const first = await cached.synthesize(say())
    const again = await cached.synthesize(say())
    const other = await cached.synthesize(say("a different line"))
    expect(again.bytes).toEqual(first.bytes)
    expect(other.bytes).not.toEqual(first.bytes)
    const calls = (await admin("/calls")).body
    expect(calls.count).toBe(2)
    expect(Object.values(calls.by_fingerprint)).toEqual([1, 1])
  })

  test("unscripted audio is a pure function of the request, on any instance", async () => {
    const one = harness()
    const two = harness()
    for (const format of ["mp3", "pcm"] as const) {
      const first = await one.adapter().synthesize(say(PROMPT, format))
      expect((await one.adapter().synthesize(say(PROMPT, format))).bytes).toEqual(first.bytes)
      expect((await two.adapter().synthesize(say(PROMPT, format))).bytes).toEqual(first.bytes)
      // Another text of the same length is another request: other bytes.
      const other = await one.adapter().synthesize(say(PROMPT.replace("quick", "QUICK"), format))
      expect(other.bytes.length).toBe(first.bytes.length)
      expect(other.bytes).not.toEqual(first.bytes)
    }
  })
})

describe("test controls", () => {
  test("scripts answer oldest first among those that match, and `times` retires them", async () => {
    const { adapter, queue } = harness()
    const first = mp3Audio(44_100, 128, 100, 20)
    const second = mp3Audio(44_100, 128, 100, 22)
    const pcm = pcmAudio(44_100, 100, 20)
    await queue({ match: { output_format: "pcm_44100" }, audio: pcm })
    await queue({ match: { text: PROMPT }, audio: first, times: 1 })
    await queue({ match: { text_sha256: textFingerprint(PROMPT) }, audio: second, times: 2 })
    const heard = []
    for (let i = 0; i < 4; i++) heard.push((await adapter().synthesize(say())).bytes)
    expect(heard.slice(0, 3)).toEqual([first, second, second])
    // All three one-shots are spent: generated audio again.
    expect(parseMp3(heard[3] as Uint8Array)[0]?.lines[0]).not.toEqual([22])
    // The format-wide script was never in the way of mp3 requests, and still answers.
    expect((await adapter().synthesize(say("anything", "pcm"))).bytes).toEqual(pcm)
  })

  test("a script matched by request fingerprint answers that request alone", async () => {
    const { adapter, queue } = harness()
    await queue({
      match: {
        fingerprint: speechFingerprint({
          voice_id: VOICE,
          model_id: MODEL,
          output_format: "pcm_44100",
          text: PROMPT,
        }),
      },
      audio: SCRIPTED,
      content_type: "application/octet-stream",
    })
    const hit = await adapter().synthesize(say(PROMPT, "pcm"))
    // Exact bytes and the scripted content type, whatever the format would have said.
    expect(hit).toEqual({ bytes: SCRIPTED, contentType: "application/octet-stream" })
    expect((await adapter().synthesize(say(PROMPT, "mp3"))).bytes).not.toEqual(SCRIPTED)
    expect((await adapter().synthesize(say(`${PROMPT}!`, "pcm"))).bytes).not.toEqual(SCRIPTED)
  })

  test("a malformed script is refused with the reason", async () => {
    const { admin } = harness()
    const audio_base64 = toBase64(SCRIPTED)
    for (const [script, reason] of [
      [{}, /exactly one of audio/],
      [{ audio_base64: "" }, /empty/],
      [{ audio_base64, times: 0 }, /times/],
      [{ audio_base64, match: { output_format: "mp3" } }, /not a vendor output format/],
      [{ audio_base64, match: { text: "a", text_sha256: "b" } }, /not both/],
      [{ audio_base64, match: { fingerprint: "abc" } }, /SHA-256/],
      [{ audio_base64, reply: 1 }, /unknown field reply/],
    ] as const) {
      const refused = await admin("/scripts", script)
      expect(refused.status).toBe(400)
      expect(refused.body.error.message).toMatch(reason)
    }
    expect((await admin("/scripts")).body.scripts).toEqual([])
  })

  test("every preset fails one request with its documented status and envelope", async () => {
    const expected: Record<string, [number, string, string]> = {
      invalid_api_key: [401, "authentication_error", "invalid_api_key"],
      quota_exceeded: [402, "payment_required", "quota_exceeded"],
      rate_limited: [429, "rate_limit_error", "rate_limit_exceeded"],
      too_many_concurrent_requests: [429, "rate_limit_error", "too_many_concurrent_requests"],
      system_busy: [429, "rate_limit_error", "system_busy"],
      server_error: [500, "internal_error", "internal_error"],
      service_unavailable: [503, "service_unavailable", "service_unavailable"],
    }
    const { adapter, admin } = harness({ io: { sleep: async () => {} } })
    const listed = (await admin("/faults/presets")).body.presets.map(
      (preset: { name: string }) => preset.name,
    )
    // The emulator's own presets, beside the standard ones every emulator has.
    expect(listed).toEqual(expect.arrayContaining(Object.keys(ELEVENLABS_PRESETS)))
    expect(Object.keys(ELEVENLABS_PRESETS).sort()).toEqual(
      [...Object.keys(expected), "network_reset", "slow_response"].sort(),
    )
    for (const [preset, [status, type, legacy]] of Object.entries(expected)) {
      await admin(`/faults/presets/${preset}`, {})
      const error = await failure(adapter().synthesize(say()))
      expect(error.status).toBe(status)
      expect((error.body as { detail: Record<string, unknown> }).detail).toMatchObject({
        type,
        status: legacy,
        request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      })
      // One shot: the next request is audio again.
      expect((await adapter().synthesize(say())).contentType).toBe("audio/mpeg")
    }
    await admin("/faults/presets/network_reset", {})
    await expect(adapter().synthesize(say())).rejects.toThrow(TypeError)
    expect((await adapter().synthesize(say())).contentType).toBe("audio/mpeg")
  })

  test("any other one-shot failure is a fault rule with its own status and body", async () => {
    const { adapter, admin } = harness()
    const detail = { status: "voice_not_found", message: "legacy envelope" }
    await admin("/faults", {
      operationId: "ConvertTextToSpeech",
      status: 400,
      count: 1,
      body: { detail },
    })
    const error = await failure(adapter().synthesize(say()))
    expect([error.status, error.code, error.body]).toEqual([400, "voice_not_found", { detail }])
    expect((await adapter().synthesize(say())).contentType).toBe("audio/mpeg")
  })

  test("calls record fingerprints, lengths and outcomes for every request the mock handled", async () => {
    const { adapter, admin, queue } = harness()
    const script = await queue({ match: { output_format: "pcm_44100" }, audio: SCRIPTED })
    await adapter().synthesize(say())
    await adapter().synthesize(say(PROMPT, "pcm"))
    await failure(adapter().synthesize(say(PROMPT, "mp3", "no-such-voice")))
    const { body } = await admin("/calls")
    expect(body.count).toBe(3)
    const fingerprint = speechFingerprint({ voice_id: VOICE, model_id: MODEL, text: PROMPT })
    expect(body.calls[0]).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9]{20}$/),
      voice_id: VOICE,
      model_id: MODEL,
      output_format: "mp3_44100_128",
      text_sha256: textFingerprint(PROMPT),
      text_characters: PROMPT.length,
      fingerprint,
      status: 200,
      error: null,
      script_id: null,
      audio_bytes: expect.any(Number),
      audio_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      content_type: "audio/mpeg",
      at: expect.any(String),
    })
    expect(body.calls[1]).toMatchObject({
      output_format: "pcm_44100",
      script_id: script.id,
      audio_bytes: SCRIPTED.length,
      audio_sha256: script.sha256,
    })
    expect(body.calls[2]).toMatchObject({
      voice_id: "no-such-voice",
      status: 404,
      error: "voice_not_found",
      audio_bytes: 0,
      audio_sha256: null,
    })
    expect(body.by_fingerprint[fingerprint]).toBe(1)
    expect((await admin(`/calls?fingerprint=${fingerprint}`)).body.calls).toHaveLength(1)
  })

  test("reset returns to the configured scripts, voices, models and keys", async () => {
    const { adapter, admin, queue } = harness({
      scripts: [{ match: { text: PROMPT }, audio: SCRIPTED, times: 1 }],
      voices: [{ voice_id: "voice-under-test" }],
      keys: ["suite-key"],
    })
    const client = adapter({ apiKey: "suite-key" })
    const request = say(PROMPT, "mp3", "voice-under-test")
    expect((await client.synthesize(request)).bytes).toEqual(SCRIPTED)
    expect((await client.synthesize(request)).bytes).not.toEqual(SCRIPTED)
    await queue({ audio: pcmAudio(44_100, 50, 9) })
    await admin("/voices", { voices: [] }, { method: "PUT" })
    await admin("/keys", { keys: ["another-key"] }, { method: "PUT" })
    expect((await failure(client.synthesize(request))).status).toBe(401)

    expect((await admin("/reset", {})).status).toBe(200)
    // The seeded one-shot is whole again, the queued script and the edits are gone.
    const scripts = (await admin("/scripts")).body.scripts
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toMatchObject({ remaining: 1, hits: 0, bytes: SCRIPTED.length })
    expect((await admin("/calls")).body.count).toBe(0)
    expect((await client.synthesize(request)).bytes).toEqual(SCRIPTED)
  })

  test("a snapshot restores scripts, their remaining answers and the call history", async () => {
    const { adapter, admin, queue } = harness()
    await queue({ audio: SCRIPTED, times: 1 })
    const snapshot = (await admin("/snapshots", {})).body.id as string
    expect((await adapter().synthesize(say())).bytes).toEqual(SCRIPTED)
    expect((await adapter().synthesize(say())).bytes).not.toEqual(SCRIPTED)
    expect((await admin("/calls")).body.count).toBe(2)

    expect((await admin(`/snapshots/${snapshot}/restore`, {})).status).toBe(200)
    expect((await admin("/calls")).body.count).toBe(0)
    expect((await admin("/scripts")).body.scripts[0]).toMatchObject({ remaining: 1, hits: 0 })
    // The sealed audio came back with the record.
    expect((await adapter().synthesize(say())).bytes).toEqual(SCRIPTED)
  })

  test("latency is virtual: slow_response waits on the injected sleep, not on the clock", async () => {
    const slept: number[] = []
    const { adapter, admin } = harness({
      io: {
        sleep: async (ms) => {
          slept.push(ms)
        },
      },
    })
    await admin("/faults/presets/slow_response", {})
    await admin("/faults", { latencyMs: 60_000, count: 1 })
    const started = performance.now()
    await adapter().synthesize(say())
    expect(slept).toEqual([250, 60_000])
    expect(performance.now() - started).toBeLessThan(5_000)
    // Both delays were one-shot.
    await adapter().synthesize(say())
    expect(slept).toHaveLength(2)
  })

  test("a request aborted while it is held back rejects, records nothing and spares the script", async () => {
    let release = () => {}
    let entered = () => {}
    const held = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { adapter, admin, queue } = harness({
      io: {
        sleep: () =>
          new Promise<void>((resolve) => {
            release = resolve
            entered()
          }),
      },
    })
    await queue({ audio: SCRIPTED, times: 1 })
    await admin("/faults/presets/slow_response", {})
    const controller = new AbortController()
    const pending = adapter().synthesize({ ...say(), signal: controller.signal })
    // The caller gives up while the vendor is still holding the request.
    await held
    controller.abort()
    release()
    await expect(pending).rejects.toThrow()
    expect((await admin("/calls")).body.count).toBe(0)
    expect((await admin("/scripts")).body.scripts[0]).toMatchObject({ remaining: 1, hits: 0 })
    expect((await adapter().synthesize(say())).bytes).toEqual(SCRIPTED)
  })

  test("voices, models and keys are configured per namespace through the admin routes", async () => {
    const { adapter, admin } = harness()
    expect((await admin("/voices")).body.voices).toEqual([...DEFAULT_VOICES])
    expect(
      (await admin("/models")).body.models.map((m: { model_id: string }) => m.model_id),
    ).toEqual(["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"])
    await admin(
      "/voices",
      { voices: ["narrator", { voice_id: "sidekick", name: "Sidekick" }] },
      { method: "PUT" },
    )
    await admin("/models", { models: ["studio-v9"] }, { method: "PUT" })
    await admin("/keys", { keys: ["rotated-key"] }, { method: "PUT" })
    expect((await failure(adapter().synthesize(say()))).code).toBe("invalid_api_key")
    const client = adapter({ apiKey: "rotated-key" })
    expect((await failure(client.synthesize(say()))).code).toBe("voice_not_found")
    expect((await failure(client.synthesize(say(PROMPT, "mp3", "narrator")))).code).toBe(
      "model_not_found",
    )
    expect((await client.synthesize(say(PROMPT, "mp3", "sidekick", "studio-v9"))).contentType).toBe(
      "audio/mpeg",
    )
    expect(
      (await admin("/voices", { voices: [{ name: "nameless" }] }, { method: "PUT" })).status,
    ).toBe(400)
    expect((await admin("/keys", { keys: [""] }, { method: "PUT" })).status).toBe(400)
  })

  test("a vendor format the mock cannot encode is 501 until a script supplies its bytes", async () => {
    const { raw, queue } = harness()
    const convert = () =>
      raw("?output_format=opus_48000_64", {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": DEFAULT_API_KEY },
        body: JSON.stringify({ text: PROMPT }),
      })
    const unmodelled = await convert()
    expect(unmodelled.status).toBe(501)
    expect(((await unmodelled.json()) as { detail: { type: string } }).detail.type).toBe(
      "mockingbird_not_modelled",
    )
    const opus = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3])
    await queue({ match: { output_format: "opus_48000_64" }, audio: opus })
    const scripted = await convert()
    expect(scripted.status).toBe(200)
    expect(scripted.headers.get("content-type")).toBe("audio/opus")
    expect(new Uint8Array(await scripted.arrayBuffer())).toEqual(opus)
  })
})

describe("what the mock keeps", () => {
  test("no prompt, key or audio reaches the journal, the logs, the state, the admin views or a snapshot", async () => {
    const KEY = "synthetic-private-key-0123456789"
    const logs: unknown[] = []
    const { runtime, adapter, admin, queue } = harness({
      keys: [KEY],
      scripts: [{ match: { text: PROMPT }, audio: SCRIPTED }],
      onLog: (entry) => logs.push(entry),
    })
    await queue({ match: { text: `${PROMPT} again` }, audio: pcmAudio(44_100, 50, 9) })
    const client = adapter({ apiKey: KEY })
    await client.synthesize(say())
    await client.synthesize(say(`${PROMPT} again`, "pcm"))
    await client.synthesize(say(`${PROMPT} unscripted`))
    await failure(client.synthesize(say(PROMPT, "mp3", "no-such-voice")))
    await failure(adapter({ apiKey: `${KEY}-wrong` }).synthesize(say()))
    // A rejected body is logged by where and why, never by what.
    await runtime.fetch(
      new Request(`${ORIGIN}/v1/text-to-speech/${VOICE}`, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": KEY },
        body: JSON.stringify({ text: [PROMPT] }),
      }),
    )

    const collections = (await admin("/state")).body.collections.map(
      (c: { name: string }) => c.name,
    )
    expect(collections).toEqual(
      expect.arrayContaining(["calls", "keys", "models", "scripts", "voices"]),
    )
    const state = []
    for (const name of collections) state.push((await admin(`/state/${name}`)).body)
    const kept = JSON.stringify({
      journal: runtime.journal.list(),
      requests: (await admin("/requests")).body,
      logs,
      state,
      scripts: (await admin("/scripts")).body,
      calls: (await admin("/calls")).body,
      keys: (await admin("/keys")).body,
      metrics: (await admin("/metrics")).body,
      snapshot: runtime.snapshot(),
      timeline: (await admin("/timeline")).body,
    })
    expect(kept).not.toContain("synthetic-private")
    expect(kept).not.toContain(KEY)
    // Neither the scripted bytes nor the generated ones, in the encoding a record would use.
    expect(kept).not.toContain(toBase64(SCRIPTED).slice(0, 64))
    expect(kept).not.toContain(toBase64(SCRIPTED.slice(417, 834)).slice(0, 64))
    // What is kept instead: digests, lengths and counts.
    expect(kept).toContain(textFingerprint(PROMPT))
    expect((await admin("/keys")).body.keys).toEqual([
      { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    const rejected = runtime.journal.list({ status: 422 })[0]
    expect(rejected?.issues).toEqual([
      { path: "text", message: "Input should be a valid string", kind: "schema" },
    ])
  })
})

describe("runtime contract", () => {
  test("health names the service, and every response is stamped", async () => {
    const { runtime, admin } = harness()
    expect((await admin("/health")).body).toMatchObject({ status: "ok", service: "elevenlabs" })
    const response = await runtime.fetch(new Request(`${ORIGIN}/v1/nowhere`))
    expect(response.headers.get("x-mockingbird")).toMatch(/^elevenlabs@.+; ns=default$/)
  })

  test("a namespace is selected by header, by path prefix, or by API key", async () => {
    const { runtime, adapter, admin } = harness()
    await adapter({ namespace: "by-header" }).synthesize(say())
    await adapter({ baseUrl: `${ORIGIN}/__admin/ns/by-path/v1` }).synthesize(say())
    // The key carries the namespace for a client that can set neither a header nor a path.
    await admin("/keys", { keys: ["worker-7-key"] }, { method: "PUT", namespace: "by-key" })
    await admin("/credentials", { credentials: { "worker-7-key": "by-key" } }, { method: "PUT" })
    await adapter({ apiKey: "worker-7-key" }).synthesize(say())
    for (const namespace of ["by-header", "by-path", "by-key"]) {
      expect(runtime.instance(namespace).calls()).toHaveLength(1)
    }
    expect(runtime.instance().calls()).toHaveLength(0)
    // The key is shown masked.
    expect(JSON.stringify((await admin("/credentials")).body)).not.toContain("worker-7-key")
  })
})

describe("served over HTTP", () => {
  test("a separate process reaches the same behavior with plain fetch", async () => {
    const server = await createServer({
      scripts: [{ match: { text: "scripted" }, audio: SCRIPTED }],
    })
    try {
      const adapter = new ElevenLabsTtsAdapter({
        baseUrl: `${server.url}/v1`,
        apiKey: DEFAULT_API_KEY,
        fetch: (request) => fetch(request),
      })
      expect((await adapter.synthesize(say("scripted"))).bytes).toEqual(SCRIPTED)
      const mp3 = await adapter.synthesize(say())
      expect(mp3.contentType).toBe("audio/mpeg")
      expect(parseMp3(mp3.bytes)[0]).toMatchObject({ sampleRate: 44_100, bitrate: 128 })
      const pcm = await adapter.synthesize(say(PROMPT, "pcm"))
      expect(pcm.contentType).toBe("audio/pcm")
      expect(pcm.bytes.length).toBe(Math.round(44_100 * PROMPT.length * 0.05) * 2)

      const unauthorized = await fetch(`${server.url}/v1/text-to-speech/${VOICE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      })
      expect(unauthorized.status).toBe(401)
      expect(((await unauthorized.json()) as { detail: { status: string } }).detail.status).toBe(
        "needs_authorization",
      )

      // A dropped connection is a failed fetch on the wire, too.
      await fetch(`${server.url}/__admin/faults/presets/network_reset`, { method: "POST" })
      await expect(adapter.synthesize(say())).rejects.toThrow()
      expect((await adapter.synthesize(say())).contentType).toBe("audio/mpeg")

      const calls = (await (await fetch(`${server.url}/__admin/calls`)).json()) as { count: number }
      expect(calls.count).toBe(5)
    } finally {
      await server.close()
    }
  })
})
