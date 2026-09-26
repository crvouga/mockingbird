# @crvouga/mockingbird-service-bedrock

Stateful, scriptable mock of **Amazon Bedrock Runtime** for test suites: `Converse`,
`ConverseStream` (byte-exact `application/vnd.amazon.eventstream` frames), `InvokeModel`
(Anthropic Messages bodies and Titan text embeddings), `InvokeModelWithBidirectionalStream`
(Nova Sonic over HTTP/2 duplex), and the AgentCore `InvokeHarness` event stream.

The mock never generates language. It replays **scripts**: a test says "when the chat model
sees *dizzy* with `report_rx_symptom` available, emit this `toolUse`; after the tool result
comes back, say this". Chat turns, approval cards, guardrail blocks, structured output and
throttles become deterministic and take milliseconds.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/bedrock/SUPPORT.md)
- Proven with the official clients our consumer pins: `@aws-sdk/client-bedrock-runtime@3.1132.0`,
  `@aws-sdk/client-bedrock-agentcore@3.1074.0`, `@ai-sdk/amazon-bedrock@4.0.176` + `ai@6.0.283`.

## Install

```bash
npm install -D @crvouga/mockingbird-service-bedrock
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-bedrock serve` (h2c + HTTP/1.1 on one port), `createServer` from `./server`,
or `createRuntime` with any Fetch server (HTTP/1.1 only — see below).

## Usage

Point the app at it. No code change: every client honours the endpoint variables.

```bash
npx mockingbird-bedrock serve --port 8796
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8796    # SDK v3, AI SDK, botocore
export AWS_ENDPOINT_URL_BEDROCK_AGENTCORE=http://127.0.0.1:8796  # AgentCore InvokeHarness
```

```ts
import { createServer } from "@crvouga/mockingbird-service-bedrock/server"

const bedrock = await createServer({ port: 8796 })
await fetch(`${bedrock.url}/__admin/scripts`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    scripts: [
      {
        id: "rx-symptom-approval",
        match: { modelId: "*sonnet*", lastUserText: { contains: "dizzy" }, toolsInclude: ["report_rx_symptom"] },
        turns: [
          {
            toolUse: { name: "report_rx_symptom", input: { symptoms: [{ symptomDefinitionId: 7, severity: 3 }] } },
            stopReason: "tool_use",
          },
          {
            expectToolResult: { name: "report_rx_symptom" },
            text: "I've flagged that for your care team.",
            chunkSize: 12,
            usage: { inputTokens: 1200, outputTokens: 40, cacheReadInputTokens: 900 },
          },
        ],
      },
    ],
  }),
})
// …the backend's streamText turn now emits the approval card; approving resumes the turn.
await bedrock.close()
```

### Protocols

The AWS SDK v3 clients for Bedrock Runtime default to `NodeHttp2Handler`: against an
`http://` endpoint they speak **h2c** (cleartext HTTP/2 with prior knowledge), and Nova Sonic
needs HTTP/2 duplex. The AI SDK and AgentCore use HTTP/1.1. `mockingbird-bedrock serve` and
`createServer` sniff each connection's first bytes and serve both on one port. (`serve
--config` from another service's CLI, and `createRuntime` behind a plain Fetch server, speak
HTTP/1.1 only — fine for the AI SDK, not for the SDK v3 Bedrock client.)

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /model/{modelId}/converse` | Converse JSON: `output.message.content[]` (`text`, `toolUse`, `reasoningContent`), `stopReason`, `usage` (with `cacheRead/WriteInputTokens` when a `cachePoint` is present), `metrics`, `trace.guardrail` (with `guardrailConfig.trace: "enabled"`), `x-amzn-RequestId`. |
| `POST /model/{modelId}/converse-stream` | The same answer as event frames: `messageStart`, `contentBlockStart` (tool use), `contentBlockDelta` (`text`, `toolUse.input` partial JSON, `reasoningContent`), `contentBlockStop`, `messageStop`, `metadata`; exception frames mid-stream. |
| `POST /model/{modelId}/invoke` | `amazon.titan-embed-text-*`: `{embedding, inputTextTokenCount}` — a deterministic unit vector from SHA-256(`inputText`) (1024-d by default; `dimensions` 256/512/1024). Claude models: an Anthropic Messages body in, a Messages response out. |
| `POST /model/{modelId}/invoke-with-bidirectional-stream` | Nova Sonic (`*sonic*`), HTTP/2 duplex: reads `chunk` events as they arrive (SigV4 envelopes unwrapped), answers each user turn with `textOutput` + 24 kHz PCM tone `audioOutput` + `toolUse`, then `usageEvent`; `completionEnd` after `sessionEnd`. |
| `POST /harnesses/invoke?harnessArn=` | AgentCore harness stream: `messageStart`, `contentBlockDelta` (`text` or `toolResult[]`), `contentBlockStop`, `messageStop`, `metadata`; `validationException` / `internalServerException` / `runtimeClientError` frames. |

`modelId` is any model id, inference-profile id (`global.` / `us.`) or URL-encoded ARN. SigV4 is
accepted without verification. Request checks Bedrock makes and our code branches on are
enforced: role alternation, first/last message is the user (assistant **prefill** is rejected
for Claude 4.5+), tool-use/tool-result pairing, `toolConfig` required with tool blocks, a
document needs a sibling text block, `temperature` + `top_p` together on Claude 4.5+. Errors are
`x-amzn-ErrorType: <Name>:http://internal.amazon.com/coral/com.amazon.bedrock/` + `{"message"}`.
Output longer than `maxTokens` (≈4 chars/token) is cut with `stopReason: "max_tokens"`.

### Scripts (`PUT /__admin/scripts`)

A script is `{id, match?, turns, times?}`. The first script (in insertion order) whose `match`
accepts a call **and** has a turn for that point in the conversation answers it; `times` caps
how many calls it answers.

- **Match keys:** `modelId` (glob), `operation` (`Converse`, `ConverseStream`, `InvokeModel`,
  `InvokeModelWithBidirectionalStream`, `InvokeHarness`), `lastUserText` (string = contains, or
  `{contains, regex, flags}`), `systemHash` (SHA-256 hex of the system text blocks joined with
  `\n`), `toolsInclude`, `toolChoice` (`auto` / `any` / a tool name), `hasDocument`, `hasImage`,
  `callIndex` (0-based index of the call in the namespace).
- **Turn selection** reads the conversation, not server state: turn *n* answers the call that
  comes after *n* assistant messages since the member last said something. So turn 0 is the
  first call of a user turn, turn 1 is the call that resumes after a tool result, and every new
  conversation starts over. `expectToolResult: {name}` makes a turn answer only when the last
  user message carries that tool's result. Nova Sonic counts answers within the session.
- **A turn** is any of: `text` (streamed in `chunkSize`-character deltas, `delayMsPerChunk`
  mock-clock ms apart), `reasoning`, `toolUse` (`{name, input, toolUseId?}` or a list), `json`
  (structured output, rendered in the form the request asked for — see below), `guardrail`
  (`true` or `{text, trace}`: `guardrail_intervened` with Bedrock's refusal text and a trace),
  `toolResult` (harness), `userTranscript` (Nova Sonic), `stopReason`, `usage`, `fault`.
- **Structured output** (`json`) goes out as text JSON for
  `outputConfig.textFormat.structure.jsonSchema` (Python boto3 clients) and
  `additionalModelRequestFields.output_config.format` (AI SDK native), and as a `toolUse` of the
  forced tool for `toolChoice: {tool}` or `{any}` (the AI SDK's synthetic `json` tool, insight
  reports' `record_chat_*`).
- **Unscripted defaults**, each counted as `unscripted` (`GET /__admin/scripts` → `stats`):
  chat → `"OK."` (`PUT /__admin/settings {"defaultText"}`); structured output → the minimal
  object valid against the request's schema; our intent classifier (its system prompt asks for
  `{"category","confidence"}`) → `{"category":"general","confidence":0.9}`; InvokeModel with a
  Claude body (the EMR scribe) → a 4-section SOAP JSON; Titan → the SHA-256 vector; InvokeHarness
  → an `eligible_for_clinician_review` prescreen summary; Nova Sonic → `"OK."` spoken.

### Faults

A turn's `fault` (or a preset, `POST /__admin/faults {"preset": "<name>", "count"?: n}`, which
applies to every model and harness call in the calling namespace):

| Preset / fault | Effect |
| --- | --- |
| `throttling` | 429 `ThrottlingException` before the first chunk |
| `mid_stream_exception` (`afterChunks`, `exceptionType`) | content chunks, then a `modelStreamErrorException` frame (harness: `internalServerException`) |
| `mid_stream_throttling` | the same with a `throttlingException` frame |
| `validation_exception` / `validation` | 400 `ValidationException` |
| `max_tokens` | output cut in half, `stopReason: "max_tokens"` |
| `latency` (`latencyMs`) | the response starts after 2 s on the mock clock |
| `truncated_frame` | the stream stops half-way through a frame (both decoders throw) |
| `model_timeout`, `service_unavailable`, `access_denied`, `internal_server` | 408 / 503 / 403 / 500 with the matching `x-amzn-ErrorType` |

Chunk pacing and latency wait on the **mock clock**: freeze it (`POST /__admin/clock
{"freeze": true}`) and advance it to release each chunk, so time-to-first-token tests are exact.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `PUT /__admin/scripts` | Replace the namespace's scripts (`{"scripts": [...]}`); validated. |
| `POST /__admin/scripts` | Add scripts (same ids overwrite). |
| `GET /__admin/scripts` | Scripts plus `stats` (`calls`, `scripted`, `unscripted`, `byScript`, `byFallback`, `byOperation`). |
| `DELETE /__admin/scripts[?id=]` | Remove one or all. |
| `GET /__admin/model-metrics` | Just the stats. |
| `GET/PUT /__admin/settings` | `defaultText`, `chunkSize` (16), `delayMsPerChunk` (0), `audioTurnChunks` (0: a Nova Sonic spoken turn ends at the audio `contentEnd`; n: after n audio frames). |

The request journal (`GET /__admin/requests`) records per call only `modelId`, `script` (or
`unscripted:<default>`), tool names, flags (`cachePoint`, `guardrail`, `document`, `image`,
`structured:<form>`), `stopReason` and token counts — never prompt or message text.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the endpoint URL, or by credential: the SDKs
cannot add headers, so map each worker's access key id:
`PUT /__admin/credentials {"credentials": {"<AWS_ACCESS_KEY_ID>": "<namespace>"}}`.

### Deliberately not modelled

- Language: output only ever comes from scripts or the fixed defaults.
- Real speech: Nova Sonic audio out is a 440 Hz PCM tone whose length follows the text; audio
  in is counted, never transcribed (a spoken turn matches with `lastUserText: ""`).
- `InvokeModelWithResponseStream` (no consumer calls it), guardrail evaluation itself
  (`ApplyGuardrail`; scripts decide when the guardrail intervenes), prompt caching arithmetic
  (cache token counts are 0 unless scripted), model-specific output token limits.
- SigV4 signatures are not verified; the access key id only selects a namespace.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `BedrockAPI` | class | The in-process mock: `fetch`, `reset`, `scripts()`, `putScripts(scripts, replace?)`, `removeScripts(id?)`, `stats()`. Options: `sqlite`, `now`, `namespace`, `settings`, `scripts`, `sleep`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, SigV4 credentials, presets, scripts). Options: `settings`, `scripts`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `BEDROCK_PRESETS` | object | Every named fault preset. |
| `BEDROCK_NAMESPACE` | string | The service name, `"bedrock"`. |
| `bedrockError` | function | A Bedrock error response (`status`, `x-amzn-ErrorType`, `{message}`). |
| `accessKeyCredential` | function | The SigV4 access key id of a request (how credentials map to namespaces). |
| `clockSleep` | function | A sleep that waits on a (possibly frozen) mock clock. |
| `titanEmbedding` | function | The deterministic unit vector Titan answers with. |
| `sampleSchema` | function | The minimal instance of a JSON Schema (the unscripted structured output). |
| `parseScript` | function | Validate one script (what `PUT /__admin/scripts` runs). |
| `MODEL_OPERATIONS`, `STOP_REASONS`, `TURN_FAULTS` | arrays | The values `operation`, `stopReason` and `fault` accept. |
| `DEFAULT_SETTINGS`, `DEFAULT_CHAT_TEXT`, `DEFAULT_CLASSIFIER`, `DEFAULT_SOAP_NOTE`, `GUARDRAIL_BLOCKED_TEXT` | values | The defaults. |
| `encodeMessage`, `decodeMessage`, `FrameReader`, `readFrames`, `eventFrame`, `exceptionFrame`, `unwrapSigned`, `crc32`, `EventStreamError` | codec | The event-stream codec (exact prelude, headers and CRC32s), in both directions. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT`, `listenH2c` (`./server`) | Node | Serve h2c + HTTP/1.1 on one port; the `serve` CLI target; port 8796; the dual-protocol listener for any Fetch handler. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
