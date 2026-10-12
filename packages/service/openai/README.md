# @crvouga/mockingbird-service-openai

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A **wip**, portable, entirely local OpenAI emulator for Chat Completions, function tool loops,
Chat SSE streams, embeddings, models, files and staged uploads. Verified with unmodified
**openai 7.27.0**, **@ai-sdk/openai 4.0.83** and **ai 7.0.127** over Node HTTP.
It makes no inference calls and requires no vendor account or billed API key.

## Install

```sh
bun add @crvouga/mockingbird-service-openai
```

## Usage

The examples use the official `openai@7.27.0` SDK.

```ts
import OpenAI from "openai"
import { createRuntime, DEFAULT_TOKEN } from "@crvouga/mockingbird-service-openai"

// Test setup: the emulator, scripted with the reply the test expects.
const emulator = createRuntime({
  scripts: [{
    kind: "chat",
    message: { role: "assistant", content: "Fixture answer" },
    usage: { prompt_tokens: 12, completion_tokens: 3, cached_tokens: 8 },
  }],
})

// The app's own OpenAI client. Only its fetch changes: requests reach the
// emulator in this process instead of api.openai.com.
const openai = new OpenAI({
  apiKey: DEFAULT_TOKEN,
  fetch: (url: RequestInfo | URL, init?: RequestInit) => emulator.fetch(new Request(url, init)),
})
const completion = await openai.chat.completions.create({
  model: "fixture-chat",
  messages: [{ role: "user", content: "Fixture question" }],
})
console.log(completion.choices[0]?.message.content) // "Fixture answer"
console.log(completion.usage?.total_tokens) // 15
```

For the Vercel AI SDK, also install `@ai-sdk/openai@4.0.83` and `ai@7.0.127`, and point the
provider's `baseURL` at a listening server.
Use the explicit `.chat()` provider: the provider's default model uses the Responses API.

```ts
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import { createServer } from "@crvouga/mockingbird-service-openai/server"
import { DEFAULT_TOKEN } from "@crvouga/mockingbird-service-openai"

const server = await createServer({
  scripts: [{ kind: "chat", message: { role: "assistant", content: "Fixture answer" } }],
})
try {
  const provider = createOpenAI({ baseURL: `${server.url}/v1`, apiKey: DEFAULT_TOKEN })
  console.log((await generateText({ model: provider.chat("fixture-chat"), prompt: "Fixture", maxRetries: 0 })).text)
} finally {
  await server.close()
}
```

`openai` also accepts `baseURL: server.url + "/v1"` and the fixture `apiKey`.
The CLI is `mockingbird-openai serve --port 8813`. `createServer()` defaults to an ephemeral port.

## Routes and persisted behavior

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/chat/completions` | Scripted assistant JSON or Chat SSE; tools, finish reasons and exact usage |
| `GET /v1/chat/completions` | Stored completions only, model filter, `after`, `limit`, `order` |
| `GET` / `DELETE /v1/chat/completions/{completion_id}` | Retrieve/delete a `store: true` completion |
| `POST /v1/embeddings` | Exact scripted vectors, string or token inputs, float/base64 encoding and dimensions |
| `GET /v1/models` / `GET /v1/models/{model}` | Configured synthetic model fixtures |
| `POST` / `GET /v1/files` | Multipart file creation; metadata listing with purpose, order, after and limit |
| `GET` / `DELETE /v1/files/{file_id}` | Metadata read and deletion |
| `GET /v1/files/{file_id}/content` | Exact binary bytes |
| `POST /v1/uploads` | Create a pending staged Upload, expires after one hour |
| `POST /v1/uploads/{upload_id}/parts` | Multipart `data`, pending parts remain unpublished |
| `POST /v1/uploads/{upload_id}/complete` | Ordered `part_ids`; exact declared byte count and optional MD5 check |
| `POST /v1/uploads/{upload_id}/cancel` | Cancel a pending Upload |

`DEFAULT_TOKEN` is `fixture-openai-token`; `tokens: [{ token, models?: string[] }]` configures
synthetic bearer credentials and optional model access. Invalid/missing credentials return 401,
model-scope denial 403, unknown model/resource 404, malformed requests 400, with
`{ error: { message, type, param, code } }` and `x-request-id`. Default models are `fixture-chat`
and `fixture-embedding` (three dimensions). `models` accepts `{ id, kind: "chat" | "embedding",
dimensions?, created?, owned_by? }`. No model name implies real inference or vendor availability.

Script selection consumes the first unconsumed script matching its kind and optional
`match: { model?, lastRole?, contentIncludes?, toolCallId? }`. Unmatched scripts stay queued.
`ChatScript` has `kind: "chat"`, `message: { role: "assistant", content: string | null,
tool_calls?, refusal? }`, optional `finish_reason`, `usage`, `chunk_size` and `stream_delay_ms`.
Function calls use `{ id?, type: "function", function: { name, arguments: string } }`;
arguments must be valid JSON **strings**. Missing IDs are generated once and persist. Assistant
null content is preserved with tools/refusal; a `role: "tool"` reply must refer to an earlier
assistant call ID. Finish reasons are `stop`, `tool_calls`, `length`, `content_filter`.
`EmbeddingScript` has `kind: "embedding"`, `vectors: number[][]`, optional match and usage.

Exact usage is `{ prompt_tokens, completion_tokens?, cached_tokens? }` (nonnegative integers,
cached at most prompt). Chat replies include total tokens and `prompt_tokens_details.cached_tokens`.
Without a script, the local default is `Fixture response`; embeddings use deterministic hash
vectors. Default token estimates count UTF-8 bytes divided by four, rounded up, with a minimum
of one. These defaults are synthetic policies; supply usage/vectors for precise consumer tests.
They do not approximate semantic inference or claim tokenizer parity.

SSE emits `chat.completion.chunk` JSON with indexed content/tool argument deltas, a final
finish reason, and `[DONE]`. `stream_options.include_usage: true` adds a final empty-choices
usage chunk; earlier chunks carry null usage. `chunk_size` counts Unicode characters;
`stream_delay_ms` delays frame delivery for cancellation tests. Aborting/canceling closes the
stream and clears its pending timer; a begun completion remains a created resource.

Only `store: true` completions are available through vendor reads. Chat ordering defaults to
ascending creation time. Its local page bounds are default 20, maximum 100. File ordering defaults locally to descending
creation time, limit/max 10,000; callers can set order explicitly. Stable insertion order breaks
creation-time ties. `after` is the last resource ID; all pages expose `first_id`, `last_id`,
`has_more`. Repeating `prompt_cache_key`, headers or request IDs does not deduplicate creations:
the documented Chat contract does not promise mutation idempotency. Upload completion only
accepts pending uploads; completed/cancelled/expired uploads reject further mutation.

File multipart bodies use `purpose` and `file`. Supported purposes are `assistants`, `batch`,
`fine-tune`, `vision`, `user_data`; staged Uploads use the first four. Batch files expire after
30 days. Optional `expires_after[anchor]=created_at` and `expires_after[seconds]` accept
3,600–2,592,000 seconds. Staged Upload completion creates the file atomically in caller part
order, verifies byte count/checksum, and never publishes partial data. `maxFileBytes` defaults
to 20 MiB and bounds files/uploads/parts locally; it is not a production quota.

All records use SQLite Collections and IdSequence; lifecycle timestamps/expiry use the shared
clock. Each namespace receives constructor `scripts`, `models`, `files` fixtures; reset restores
them. Files accept `{ id?, filename, purpose, bytes: string | number[], expires_at? }`.
Use `x-mockingbird-namespace`, `/__admin/ns/{namespace}/v1/...`, or shared credential registration
for SDKs. Timeline branches/checkpoints reuse the shared runtime and keep their state isolated.

## Controls, failures and privacy

`DEFAULT_ADMIN_KEY` is `fixture-openai-admin`. Admin data routes require
`x-mockingbird-admin-key`; configure a nonempty `adminKey` to replace it. A custom `adminPrefix`
relocates all controls and the namespace path carrier. Shared clock, fault, reset, journal,
state, credential, metrics and Timeline routes remain available.

| Control | Purpose |
| --- | --- |
| `POST /__admin/scripts` | Strictly validate and queue one exact Chat/embedding script |
| `GET /__admin/scripts` | IDs, kinds and consumption state only |
| `POST /__admin/raw-faults` | Explicit raw `{ body: string, status?, content_type?, model? }`; allows malformed vendor data |
| `GET /__admin/request-metadata` | Model, counts/roles, byte length, hashes and response/script IDs |
| `POST /__admin/request-assertions` | `{ fingerprints: string[] }`, compare ordered SHA-256 request hashes |
| `GET /__admin/stream-metadata` | Open/closed/aborted stream status and chunk counts |
| `GET /__admin/upload-metadata` | Pending/completed/cancelled/expired Upload metadata |

Normal scripts reject unknown fields and malformed response shapes atomically. Raw-fault controls
are the sole escape hatch. `fingerprint(body)` computes the exact JSON-serialization SHA-256 hash
for request assertions; property order matters. No incoming prompts/tool results are retained.
Scripts, replies, file/part bytes and raw fault bodies are AES-GCM encrypted in SQLite with a
private runtime key and logical namespace binding. Generic state snapshots show ciphertext and
metadata, never plaintext bodies or keys. Vendor resource reads decrypt the requested output.
The shared request journal/logs contain metadata only; API keys are never logged.

Presets fire once: `rate_limited` (429, Retry-After and retry-after-ms), `server_error` (500),
`service_unavailable` (503), `network_reset`, `invalid_json`, `malformed_stream`, `content_refusal`,
`slow_response` (50 ms before dispatch). Canned errors/drop do not consume scripts.
The reported raw client retries only network errors, 429 and 5xx. Official OpenAI SDK additionally
retries 408/409 by its own policy; configure `maxRetries` when asserting attempts. Transport
latency uses wall time, while resource lifecycle uses the emulator clock.

## API

Root exports `OpenAIAPI`, `createRuntime`, `document`, `supportedOperationIds`, `DEFAULT_MODELS`,
`DEFAULT_TOKEN`, `DEFAULT_ADMIN_KEY`, `OPENAI_NAMESPACE`, `OPENAI_PRESETS`, `fingerprint`,
`validateScript`, `createVaultKey`, `vendorError`, and exported fixture/script/options/runtime types.
The API exposes `fetch`, `reset`, `ensureSeeded`, `queue`, `queueRaw`, `seedFile`, `state`, `app`,
`sqlite`. Node `./server` exports `createServer`, `DEFAULT_PORT`, `serveTarget` and server types.
Optional `vaultKey` is caller-supplied private key material, never persisted in state.

## Oracle and verification

The contract follows official [Chat creation](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[function calling](https://developers.openai.com/api/docs/guides/function-calling),
[stored Chat listing](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/list),
[embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create),
[models](https://developers.openai.com/api/reference/resources/models/methods/list),
[files](https://developers.openai.com/api/reference/resources/files/methods/create),
[file listing](https://developers.openai.com/api/reference/resources/files/methods/list),
[Uploads](https://developers.openai.com/api/reference/resources/uploads/methods/create),
[completion](https://developers.openai.com/api/reference/resources/uploads/methods/complete), and
[errors](https://developers.openai.com/api/docs/guides/error-codes).

`bun test` verifies unmodified SDKs over Node HTTP, the reported nonstream tool loop with exact
retry counts, SSE/abort handling, exact bytes and staged atomicity, namespaces/reset/Timeline,
privacy, pagination, every preset, every enabled JSON operation via independent-instance walks,
and a deliberately divergent instance. Multipart/binary operations have served acceptance tests.
`bun run parity` exits 2: repository policy prohibits billed inference. No live OpenAI result is
claimed; official documentation and local SDK execution are the oracle evidence.

## Deliberately not modelled

Responses API, realtime/audio/image/batch/fine-tuning APIs, built-in hosted tools, multimodal
content interpretation, real inference/tokenization, account billing, production quotas,
production opaque IDs/cursor encodings and undocumented request-ID deduplication. This package
never calls OpenAI. Encrypted persistence is private runtime state, not a production key vault.
