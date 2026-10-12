# @crvouga/mockingbird-service-elevenlabs

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Emulator of **ElevenLabs text to speech** for test suites: `POST /v1/text-to-speech/{voice_id}`
answers with audio that really is what `output_format` says (decodable MPEG Layer III frames,
headerless PCM samples, or a WAV file), with the vendor's error envelopes, and with exact bytes
a test queues. Nothing is synthesized by a model and nothing is billed: the default audio is a
tone whose pitch and length are functions of the request.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/elevenlabs/SUPPORT.md)
- Status: **work in progress**. No vendor credentials were available, so several answers follow
  the vendor's documentation without a live check; each is marked **unverified** under
  [Errors](#errors) and [Audio](#audio).

## Install

```bash
npm install -D @crvouga/mockingbird-service-elevenlabs
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-elevenlabs serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point the app's ElevenLabs base URL at the emulator (`http://127.0.0.1:8841/v1` where the real
one is `https://api.elevenlabs.io/v1`) and give it the key the emulator accepts.

```bash
npx mockingbird-elevenlabs serve --port 8841 \
  --api-key "$ELEVENLABS_API_KEY" \
  --voices "$ELEVENLABS_VOICE_ID" \
  --models eleven_multilingual_v2,eleven_flash_v2_5
```

In-process, pass the emulator as the `fetch` of the official SDK (`@elevenlabs/elevenlabs-js`):

```ts
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"
import {
  createRuntime,
  DEFAULT_API_KEY,
  DEFAULT_VOICES,
  mp3Audio,
} from "@crvouga/mockingbird-service-elevenlabs"

// Test setup. A reply the test controls: exact bytes for one text. Here they are a valid MP3,
// but any bytes are returned as given.
const scripted = mp3Audio(44_100, 128, 500, 9)
const emulator = createRuntime({
  scripts: [{ match: { text: "Welcome back." }, audio: scripted }],
})

// The ElevenLabs SDK your application already uses. Only its fetch changes: requests reach
// the emulator in this process instead of api.elevenlabs.io.
const elevenlabs = new ElevenLabsClient({
  apiKey: DEFAULT_API_KEY,
  fetch: ((url: RequestInfo | URL, init?: RequestInit) =>
    emulator.fetch(new Request(url, init))) as typeof fetch,
})
const voiceId = DEFAULT_VOICES[0]?.voice_id ?? ""

const welcome = await elevenlabs.textToSpeech
  .convert(voiceId, { text: "Welcome back.", modelId: "eleven_multilingual_v2", outputFormat: "mp3_44100_128" })
  .withRawResponse()
console.log(welcome.rawResponse.status, welcome.rawResponse.headers.get("content-type")) // 200 audio/mpeg
console.log((await new Response(welcome.data).arrayBuffer()).byteLength === scripted.length) // true

// Unscripted requests get generated audio: raw 16-bit mono samples for pcm_44100.
const pcm = await elevenlabs.textToSpeech.convert(voiceId, { text: "Anything else.", outputFormat: "pcm_44100" })
console.log((await new Response(pcm).arrayBuffer()).byteLength) // 61740
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v1/text-to-speech/{voice_id}?output_format=…` | JSON `{text, model_id?}` with `xi-api-key`. Answers `200` with the audio and the headers `character-cost` (code points in `text`), `request-id` and `x-trace-id`. `output_format` defaults to `mp3_44100_128` and `model_id` to `eleven_multilingual_v2`, as on the vendor. The `Accept` header is not read. |

Any other method on that path is `405 {"detail": "Method Not Allowed"}` with `allow: POST`; any
other path is `404 {"detail": "Not Found"}`.

### Audio

A request is answered by the oldest queued [script](#scripts) that matches it. Without one the
emulator generates a tone: 50 ms per character of `text` (at least 0.25 s, at most 5 s), at one
of twelve pitches picked from the request's [fingerprint](#calls-and-fingerprints). The same
request therefore always gets the same bytes, on any instance, and two different requests
almost always get different ones (two texts of equal length share bytes when they land on the
same pitch; queue a script when a test needs bytes that are certainly distinct).

| `output_format` | Bytes | `content-type` |
| --- | --- | --- |
| `mp3_44100_32`, `_64`, `_96`, `_128`, `_192` | MPEG-1 Layer III, 44.1 kHz, mono, constant bitrate. Every byte belongs to a complete 1152-sample frame; the padding bit keeps the stream at its nominal rate (417- and 418-byte frames at 128 kbit/s). No ID3 tag, no Xing header. | `audio/mpeg` |
| `mp3_22050_32`, `mp3_24000_48` | MPEG-2 Layer III, mono, 576-sample frames. | `audio/mpeg` |
| `pcm_8000` … `pcm_48000` | Raw signed 16-bit little-endian mono samples. No container and no header: the first byte is the first sample. | `audio/pcm` (**unverified**) |
| `wav_8000` … `wav_48000` | The same samples behind a canonical 44-byte RIFF/WAVE header. | `audio/wav` (**unverified**) |
| `opus_48000_*`, `ulaw_8000`, `alaw_8000` | Not generated. `501` with `detail.type: "mockingbird_not_modelled"` until a script supplies the bytes; then `audio/opus`, `audio/basic`, `audio/x-alaw-basic` (**unverified**). | |

`pcm_44100` is not a WAV file, whatever the request's `Accept` header says: a client that sends
`Accept: audio/wav` and treats the answer as WAV gets headerless samples from the vendor and
from this emulator alike. Ask for `wav_44100` to get the container.

The MP3 frames carry real audio, not a header in front of filler: each granule Huffman-codes
one spectral line, and `ffmpeg`, `mpg123` and Core Audio decode the stream to a steady tone at
about a quarter of full scale. `mp3Audio`, `pcmAudio` and `wavAudio` are exported for building
script fixtures that are valid audio.

What the vendor's reference states and the emulator follows: the format list, the
`mp3_44100_128` default, `audio/mpeg`, and PCM as S16LE with 16-bit depth. Not stated there,
and so unverified: every content type except `audio/mpeg`; that PCM and MP3 are mono (the
reference only says effects that "produce stereo audio" are refused for `pcm_*`); the WAV
header layout; whether real MP3 answers start with an ID3 tag; and that `character-cost` equals
the character count for every model.

### Errors

Every error but a `422` is the vendor's envelope, with `x-trace-id` repeating `request_id`:

```json
{
  "detail": {
    "type": "authentication_error",
    "code": "unauthorized",
    "message": "Invalid API key",
    "status": "invalid_api_key",
    "request_id": "8d3fefe1da6d251e5b571c484eecdaad"
  }
}
```

`status` is the legacy identifier (the vendor still sends it; older clients read
`detail.status` and `detail.message`). `param` is added when one request parameter is at fault.
A `422` is the request validator's list instead: `{"detail": [{"type", "loc", "msg", "input"}]}`.

| Request | Answer | Basis |
| --- | --- | --- |
| Body is not JSON | `422` `json_invalid`, `loc: ["body", 0]`, `msg: "JSON decode error"` | Observed. The vendor's `loc[1]` is the parser's character offset and `ctx.error` its message; the emulator sends `0` and `"Invalid JSON"`. |
| No body, a non-JSON media type, or no `text` | `422` `missing`, `loc: ["body", "text"]`, `msg: "Field required"` | Observed. For a JSON array the vendor lists every body field as missing; the emulator lists `text`. |
| `text` or `model_id` is not a string | `422` `string_type`, `msg: "Input should be a valid string"`, `input` the value | Observed. |
| No `xi-api-key` | `401` `authentication_error` / `unauthorized`, `status: "needs_authorization"` | Observed, message included. |
| A key the namespace does not hold | `401` `authentication_error` / `unauthorized`, `status: "invalid_api_key"` | Observed, message included. |
| `output_format` not in the vendor's list | `400` `validation_error` / `invalid_output_format`, `param: "output_format"` | Documented code and type. **Unverified** on the wire. |
| `text` is `""` | `400` `validation_error` / `empty_text`, `param: "text"` | Documented code and type. **Unverified** on the wire. |
| A voice that is not configured | `404` `not_found` / `voice_not_found`, `param: "voice_id"` | Documented code and type. **Unverified**; the vendor's older help article files `voice_not_found` under "400 or 401". |
| A model that is not configured | `404` `not_found` / `model_not_found`, `param: "model_id"` | Documented code and type. **Unverified** on the wire. |
| A model configured with `can_do_text_to_speech: false` | `400` `validation_error` / `unsupported_model` | Documented code and type. **Unverified** on the wire. |

"Observed" means the answer the public endpoint gave a request that carried no API key, or a
made-up one, on 2026-10-10. Those answers also fix the order of the first two checks: the body
is validated before the key is looked at (a keyless request with a bad body is `422`), and the
key before `output_format`, the text and the voice (a keyless request with an unknown format is
`401`). The order of the checks after the key is **unverified**: format, empty text, voice,
model. For the unverified rows the `message` is the description in the vendor's error
reference, `status` repeats `code`, and whether the vendor sends `param` is not known.

### Scripts

`POST /__admin/scripts` queues exact bytes for the requests a `match` selects:

```json
{
  "match": { "voice_id": "21m00Tcm4TlvDq8ikWAM", "output_format": "mp3_44100_128", "text": "Welcome back." },
  "audio_base64": "//uQwAAAACALlACEIAAEAXKA…",
  "content_type": "audio/mpeg",
  "times": 1
}
```

- `match` may name `voice_id`, `model_id`, `output_format`, the exact `text` (or its
  `text_sha256`), and a whole-request `fingerprint`. Every field given must match; an empty
  `match` answers every request. `text` is hashed on arrival and dropped.
- `times` retires the script after that many answers; without it the script answers every
  matching request, which is what a caching test wants. Among scripts that match, the oldest
  with answers left wins, so queue one-shot replies before repeating ones.
- A script is used only by a request that would otherwise get audio. A request rejected with
  `4xx`, or failed by a fault, leaves it untouched.
- `content_type` overrides the format's content type.
- The `scripts` option of `createRuntime` takes the same shape with `audio: Uint8Array`. Those
  scripts are restored by `POST /__admin/reset`; scripts queued over HTTP are dropped by it.

### Calls and fingerprints

The emulator keeps one record per request it handled past body validation, and no request
text: `GET /__admin/calls` answers `{count, by_fingerprint, calls}`, each call
`{id, voice_id, model_id, output_format, text_sha256, text_characters, fingerprint, status,
error, script_id, audio_bytes, audio_sha256, content_type, at}`. `?fingerprint=<hex>` narrows
it to one request.

- `text_sha256` is the SHA-256 of the UTF-8 text (`textFingerprint(text)`).
- `fingerprint` is the SHA-256 of the JSON array `[voice_id, model_id, output_format,
  text_sha256]` with the defaults filled in (`speechFingerprint({voice_id, model_id?,
  output_format?, text})`). Other body fields are not part of it.

Requests failed by a fault never reach the emulator, so they have no call record; they are in
the request journal (`GET /__admin/requests`) with their status and `faultId`.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/scripts` | Queue a reply (above). `201` with `{id, match, content_type, bytes, sha256, times, remaining, hits}`; `400` with the reason for a malformed script. |
| `GET /__admin/scripts` | The namespace's scripts, oldest first, without their audio. |
| `DELETE /__admin/scripts` | Drop every script. `{deleted}`. |
| `GET /__admin/calls` | Call records and counts (above). |
| `PUT /__admin/voices` | `{voices: ["<id>", {voice_id, name?}]}` replaces the namespace's voices. `GET` lists them. |
| `PUT /__admin/models` | `{models: ["<id>", {model_id, can_do_text_to_speech?}]}` replaces the namespace's models. `GET` lists them. |
| `PUT /__admin/keys` | `{keys: ["<key>"]}` replaces the keys the namespace accepts. `GET` lists their SHA-256, never the keys. |

A namespace starts with the key `fixture-elevenlabs-key`, the voice `21m00Tcm4TlvDq8ikWAM` (the
id in the vendor's examples) and the models `eleven_multilingual_v2`, `eleven_flash_v2_5` and
`eleven_turbo_v2_5`, unless the `keys`, `voices` and `models` options say otherwise.
`POST /__admin/reset` returns to that, and `POST /__admin/snapshots` and its restore cover
scripts (with their remaining answers) and call records.

Fault presets (`POST /__admin/faults/presets/<name>`, body `{"count": n}` to fail more than the
next request; `GET /__admin/faults/presets`). Each answers in front of the emulator, so it
records no call and uses up no script:

| Preset | Answer |
| --- | --- |
| `invalid_api_key` | `401` `authentication_error`, `status: "invalid_api_key"` |
| `quota_exceeded` | `402` `payment_required` / `insufficient_credits`, `status: "quota_exceeded"` |
| `rate_limited` | `429` `rate_limit_error` / `rate_limit_exceeded` |
| `too_many_concurrent_requests` | `429` `rate_limit_error` / `concurrent_limit_exceeded`, `status: "too_many_concurrent_requests"` |
| `system_busy` | `429` `rate_limit_error` / `system_busy` |
| `server_error` | `500` `internal_error` |
| `service_unavailable` | `503` `service_unavailable` |
| `network_reset` | No answer: the connection is dropped (`fetch` rejects with `TypeError`). |
| `slow_response` | The request is held 250 ms before the emulator sees it. |

The statuses, types and codes are the ones the vendor's error reference lists; the bodies were
not observed (**unverified**). In particular the reference puts an exhausted quota at `402`,
while the vendor's older help article files `quota_exceeded` under "400 or 401". For any other
status or body, add a rule: `POST /__admin/faults {"status": 401, "count": 1, "body": {…}}`.
`{"latencyMs": n}` holds a request back by `n` ms; pass `io: {sleep}` to `createRuntime` to
make that wait virtual. A request aborted while it is held back rejects when the wait ends.

### Namespaces

A namespace has its own keys, voices, models, scripts and call records. Choose one with the
`x-mockingbird-namespace` header, with a `/__admin/ns/<name>` prefix on the base URL
(`http://127.0.0.1:8841/__admin/ns/worker-1/v1`), or by API key:
`PUT /__admin/credentials {"credentials": {"<key>": "<namespace>"}}`, after adding that key to
the namespace with `PUT /__admin/keys`.

### What is stored

Request text, API keys and audio never reach the journal, the logs, state introspection, the
admin routes or a snapshot. A request leaves a call record of identifiers, lengths and digests;
a key is kept as its SHA-256; scripted audio is kept encrypted (AES-256-GCM under a key that
exists only in the process; pass `vaultKey` to reopen a persisted database) beside its length
and SHA-256. A rejected body is logged as the field and the reason, never the value.

### Live parity

`bun run parity:service -- elevenlabs` compares the emulator with the real API. It needs
`ELEVENLABS_API_KEY` and exits 2 without it. By default it only sends requests the vendor
rejects before synthesizing (invalid bodies, a voice that does not exist), so no characters are
billed; `--include-unsafe` adds conversions of one short line with `ELEVENLABS_VOICE_ID`. That
run is what would settle the rows marked unverified above.

### Deliberately not modelled

- Generated semantic speech: the audio is a tone, never words. A test that needs particular
  audio queues it.
- Streaming speech (`/stream`, WebSockets), timestamps (`/with-timestamps`), text to dialogue.
- Voice cloning and voice administration (`/v1/voices`), model listing (`/v1/models`): voices
  and models are fixtures set through the admin routes.
- Dubbing, conversational agents, speech to text, sound effects, music.
- Account billing, subscriptions, quotas and plan limits. Every key may use every format; the
  tier rules for `mp3_44100_192` and 44.1 kHz PCM, the per-model character limits and real
  rate limits do not apply. Use the fault presets to fail a request on purpose.
- Request fields other than `text` and `model_id` (`voice_settings`, `seed`, `language_code`,
  `previous_text`, …) and the `enable_logging` and `optimize_streaming_latency` query
  parameters: accepted, not validated, and without effect on the answer or the fingerprint.
- `Authorization` as an alternative to `xi-api-key`, and the vendor's regional hosts.
- Opus, mu-law and A-law encoding (script-only, see [Audio](#audio)).

## API

| Export | Kind | Description |
| --- | --- | --- |
| `ElevenLabsAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `queue(script)`, `scripts()`, `clearScripts()`, `calls()`. Options: `sqlite`, `now`, `namespace`, `keys`, `voices`, `models`, `scripts`, `vaultKey`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, namespaces, credentials, presets, journal). Options: those of `ElevenLabsAPI` plus `clock`, `seed`, `adminPrefix`, `adminKey`, `onLog`, `io`. |
| `ELEVENLABS_PRESETS` | object | Every named fault preset. |
| `ELEVENLABS_NAMESPACE` | string | The service name, `"elevenlabs"`. |
| `API_KEY_HEADER` | string | `"xi-api-key"`. |
| `DEFAULT_API_KEY`, `DEFAULT_VOICES`, `DEFAULT_MODELS`, `DEFAULT_MODEL_ID` | values | What a namespace starts with, and the model used when a request names none. |
| `OUTPUT_FORMATS`, `DEFAULT_OUTPUT_FORMAT` | values | Every `output_format` the vendor lists, and `"mp3_44100_128"`. |
| `describeFormat` | function | `(format)` to `{codec, sampleRate, bitrate?, contentType, synthesized}`. |
| `mp3Audio`, `pcmAudio`, `wavAudio` | functions | The tone generators: `mp3Audio(sampleRate, bitrate, durationMs, line)`, `pcmAudio(sampleRate, durationMs, line)`, `wavAudio(sampleRate, durationMs, line)`, where `line` picks the pitch (`(line + 0.5) * 38.28` Hz in PCM and WAV). |
| `speechFingerprint`, `textFingerprint` | functions | The digests a script matches and a call record carries. |
| `createVaultKey` | function | A fresh 32-byte key for the `vaultKey` option. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8841. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
