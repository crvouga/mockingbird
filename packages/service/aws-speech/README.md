# @crvouga/mockingbird-service-aws-speech

Stateful mock of **Amazon Polly** and **Amazon Transcribe** for test suites: Polly
`SynthesizeSpeech` and `StartSpeechSynthesisStream` (HTTP/2 duplex event stream), Transcribe
Streaming `StartStreamTranscription` (HTTP/2 duplex) and Transcribe batch
`StartTranscriptionJob` / `GetTranscriptionJob`. Chat voice turns run end to end with no audio
leaving the machine: Transcribe "hears" what a test scripts, Polly answers with deterministic
synthetic audio whose length follows the text.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/aws-speech/SUPPORT.md)
- Proven with the official clients our consumer pins: `@aws-sdk/client-polly`,
  `@aws-sdk/client-transcribe-streaming`, `@aws-sdk/client-transcribe` (3.1132.0), and the MP3
  decoder our backend uses (`mpg123-decoder@1.0.3`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-aws-speech
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-aws-speech serve` (h2c + HTTP/1.1 on one port), `createServer` from
`./server`, or `createRuntime` with any Fetch server (HTTP/1.1 only).

## Usage

```bash
npx mockingbird-aws-speech serve --port 8797
export AWS_ENDPOINT_URL_POLLY=http://127.0.0.1:8797
export AWS_ENDPOINT_URL_TRANSCRIBE_STREAMING=http://127.0.0.1:8797
export AWS_ENDPOINT_URL_TRANSCRIBE=http://127.0.0.1:8797
```

```ts
import { createServer } from "@crvouga/mockingbird-service-aws-speech/server"

const speech = await createServer({ port: 8797 })
// What the next voice session "hears": partials while audio streams in, then the final.
await fetch(`${speech.url}/__admin/transcripts`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ match: { any: true }, partials: ["I have", "I have a headache"], final: "I have a headache." }),
})
// …the backend's /v2/chatbot/voice turn transcribes, replies, and speaks through Polly…
await speech.close()
```

### Protocols

Polly and Transcribe Streaming clients default to `NodeHttp2Handler`: against an `http://`
endpoint they speak **h2c** (cleartext HTTP/2, prior knowledge), and their bidirectional
operations need HTTP/2 duplex. Transcribe batch uses HTTP/1.1. `mockingbird-aws-speech serve`
and `createServer` sniff each connection and serve both on one port (`serve --config` from
another service's CLI, and `createRuntime` behind a plain Fetch server, speak HTTP/1.1 only).

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v1/speech` | Polly `SynthesizeSpeech`. `OutputFormat: pcm` → raw PCM s16le mono 440 Hz tone (`audio/pcm`, even byte count, `SampleRate` 8000/16000, default 16000); `mp3` → valid MPEG-2 Layer III frames (`audio/mpeg`, 8000/16000/22050/24000). 60 ms of audio per character, byte-identical on every run; `x-amzn-RequestCharacters`. Errors: `ValidationException` (unknown voice or engine), `InvalidSampleRateException`, `TextLengthExceededException` (> 3000 characters). |
| `POST /v1/synthesisStream` | Polly `StartSpeechSynthesisStream` (HTTP/2 duplex, parameters in `x-amzn-Engine` / `x-amzn-VoiceId` / `x-amzn-OutputFormat` / `x-amzn-SampleRate`; generative engine only). Each `TextEvent` answers `AudioEvent`s (24 kHz MP3 frames mpg123 decodes); `CloseStreamEvent` (or the end of input) answers `StreamClosedEvent {RequestCharacters}`. |
| `POST /stream-transcription` | Transcribe `StartStreamTranscription` (HTTP/2 duplex). Validates the `x-amzn-transcribe-*` parameters (400 `BadRequestException`), echoes them in the response headers with `x-amzn-transcribe-session-id`. Sends one scripted partial (`IsPartial: true`) per `AudioEvent` received, the rest when the audio ends, then the final result, then closes. Audio bytes are counted, never kept. |
| `POST /` | Transcribe batch (AWS JSON 1.1, `X-Amz-Target`). `StartTranscriptionJob` → `IN_PROGRESS` (`ConflictException` for a repeated name); `GetTranscriptionJob` → `COMPLETED` once `jobDurationMs` (2 s) have passed on the mock clock, with `Transcript.TranscriptFileUri` = `https://s3.<region>.amazonaws.com/<OutputBucketName>/<OutputKey>`; `BadRequestException` for an unknown job. |

### Transcripts (`PUT /__admin/transcripts`)

`{match?, partials?, final, times?}` (or `{"transcripts": [...]}`). `match` is
`{sessionIndex}` (0-based count of streaming sessions in the namespace), `{jobName}` (a batch
job), or `{any: true}`; an exact match wins over `any`. Unscripted sessions and jobs hear
`defaultTranscript` (`"Hello."`, `PUT /__admin/settings`) and count as `unscripted`
(`GET /__admin/transcripts` → `stats`).

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `PUT` / `POST` / `GET` / `DELETE /__admin/transcripts` | Replace, add, list (with `stats`), remove (`?id=`). |
| `GET /__admin/jobs` | Batch jobs (advanced on the mock clock). |
| `POST /__admin/jobs/:name/complete` | Complete now, optionally with `{transcript}`. |
| `POST /__admin/jobs/:name/fail` | Fail with `{reason}` (`FailureReason`). |
| `GET /__admin/jobs/:name/transcript` | The transcript JSON Transcribe would write to S3. |
| `GET /__admin/speech` | Metadata of every synthesis / transcription (voice, engine, format, characters, bytes, script id — never text). |
| `GET/PUT /__admin/settings` | `defaultTranscript`, `jobDurationMs`. |

With `--s3-endpoint <url>` (`transcriptStore` in code) a completed job's transcript JSON is also
written to that S3 (the stack's s3rver) at `OutputBucketName/OutputKey`, so the app's own
`GetObject` on `TranscriptFileUri` finds it.

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`):
`polly_throttling` (429 `ThrottlingException`), `polly_service_failure` (500),
`polly_stream_throttling` / `polly_stream_validation` / `polly_stream_quota` (an exception
event before any audio: our adapter falls back to `SynthesizeSpeech`), `polly_stream_failure`
(`ServiceFailureException` after audio), `polly_stream_no_close` (no `StreamClosedEvent`),
`transcribe_bad_request` (400), `transcribe_limit_exceeded` (429), `transcribe_service_unavailable`
(503), `transcribe_mid_stream_failure` (`InternalFailureException` after the first partial),
`transcribe_job_limit` (`LimitExceededException`), `transcribe_job_failed` (next job `FAILED`).

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the endpoint URL, or the SigV4 access key id:
`PUT /__admin/credentials {"credentials": {"<AWS_ACCESS_KEY_ID>": "<namespace>"}}`. The journal
records voice, engine, format, character counts and script ids — never text.

### Deliberately not modelled

- Real speech: Polly audio is a tone (PCM) or silent-but-valid MP3 frames (a tone needs a real
  MP3 encoder); Transcribe never listens — words come only from scripts.
- `ogg_vorbis`, `ogg_opus`, `mulaw`, `alaw` and speech-mark (`json`) output, SSML semantics (tags
  are stripped for length), lexicons, per-voice engine availability.
- Transcribe language identification, speaker labels, custom vocabularies (accepted and echoed,
  not applied), Call Analytics and Medical variants, batch jobs reading their media from S3.
- SigV4 signatures and event signatures are not verified; the access key id only selects a
  namespace.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `SpeechAPI` | class | The in-process mock: `fetch`, `reset`, `jobs()`, `complete(name, transcript?)`, `fail(name, reason)`, `transcriptDocument(job)`, `speechLog()`, `stats()`. Options: `sqlite`, `now`, `namespace`, `settings`, `transcripts`, `transcriptStore`. |
| `createRuntime` | function | The mock with the full service contract. Options: `settings`, `transcripts`, `transcriptStore`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `SPEECH_PRESETS` | object | Every named fault preset. |
| `SPEECH_NAMESPACE` | string | The service name, `"aws-speech"`. |
| `POLLY_VOICES` | array | Every Polly voice id the mock accepts. |
| `speechError` | function | A restJson1 error response (`x-amzn-ErrorType` + `{message}`). |
| `accessKeyCredential` | function | The SigV4 access key id of a request (how credentials map to namespaces). |
| `pcmTone`, `mp3Audio`, `mp3Frame`, `durationFor`, `MS_PER_CHARACTER`, `MP3_SAMPLE_RATES`, `MP3_SAMPLES_PER_FRAME` | audio | The deterministic synthetic audio. |
| `DEFAULT_SETTINGS` | value | Default settings. |
| `encodeMessage`, `decodeMessage`, `FrameReader`, `readFrames`, `eventFrame`, `exceptionFrame`, `unwrapSigned`, `crc32`, `EventStreamError` | codec | The event-stream codec (exact prelude, headers and CRC32s), in both directions. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT`, `listenH2c` (`./server`) | Node | Serve h2c + HTTP/1.1 on one port; the `serve` CLI target; port 8797; the dual-protocol listener. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
