# @crvouga/mockingbird-service-tempo

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of **Grafana Tempo** for test suites: the OTLP/HTTP trace receiver
(`POST /v1/traces`, JSON and protobuf) and the query routes a trace reader calls (TraceQL search,
trace by id, tag names), over one store. A test exports spans the way its application does and
reads them back with the requests its production reader sends, with no Docker and no Tempo.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/tempo/SUPPORT.md)
- Status: **work in progress**. Tempo publishes no OpenAPI document and no instance was
  available while this was written, so the contract (`openapi.yaml`) follows Grafana's
  [HTTP API reference](https://grafana.com/docs/tempo/latest/api_docs/) and Tempo's source at
  v3.1.0. [What was verified, and how](#what-was-verified-and-how) lists every detail that could
  not be confirmed.

## Install

```bash
npm install -D @crvouga/mockingbird-service-tempo
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-tempo serve`, `createServer` from `./server` (Node), or `createRuntime` with any
Fetch server.

## Usage

Tempo listens on two ports (4318 for OTLP, 3200 for queries); the emulator serves both from one
origin. Point the exporter's endpoint and the reader's Tempo URL at it:

```bash
npx mockingbird-tempo serve --port 8930
# OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8930   (the exporter posts /v1/traces)
# TEMPO_URL=http://127.0.0.1:8930                     (the reader calls /api/…)

# Grafana Cloud style credentials, and tenants:
npx mockingbird-tempo serve --basic-auth 123456:fixture-token --multitenancy
```

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { createServer } from "@crvouga/mockingbird-service-tempo/server"

const server = await createServer()

// The OpenTelemetry SDK your application already uses. Only the exporter's URL changes
// (the protobuf exporter works the same way).
const provider = new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "checkout" }),
  spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${server.url}/v1/traces` }))],
})
const span = provider.getTracer("checkout").startSpan("POST /checkout", {
  startTime: new Date(1_700_000_000_000),
  attributes: { "user.id": "user-1" },
})
span.end(new Date(1_700_000_001_500))
await provider.forceFlush()

// What the trace reader sends (Tempo's query API is plain HTTP).
const q = encodeURIComponent('{ .user.id = "user-1" }')
const search = await fetch(`${server.url}/api/search?q=${q}&start=1699999990&end=1700000010&limit=50`)
const { traces } = (await search.json()) as { traces: { traceID: string }[] }
const trace = await fetch(`${server.url}/api/traces/${traces[0]?.traceID}`)

await provider.shutdown()
await server.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v1/traces` | An `ExportTraceServiceRequest` as `application/json` or `application/x-protobuf` (gzip accepted). Success is 200 with `{"partialSuccess":{}}` for JSON and an empty protobuf message for protobuf. Errors are `google.rpc.Status` in the request's encoding: 400 code 3 for a payload that does not decode, `trace ids must be 128 bit, received N bits` and `span ids must be 64 bit and not all zero, received N bits` for ids Tempo's distributor refuses (the whole export is refused, nothing is stored). Any other content type is 415 `415 unsupported media type, supported: [application/json, application/x-protobuf]` as plain text. An export without spans is accepted before any other check. A span id already stored for the trace is replaced. |
| `GET /api/search` | `q` (TraceQL, see below), `start`/`end` (epoch seconds), `limit` (default 20), `spss` (spans per span set, default 3, at most 100). Answers `{traces: [...], metrics: {...}}`; each trace has `traceID`, `rootServiceName`, `rootTraceName`, `startTimeUnixNano` (nanoseconds, a decimal string), `durationMs` (a number), `spanSet`/`spanSets` (the matched spans: `spanID`, `startTimeUnixNano`, `durationNanos`, and the attributes the query compared; `matched` counts all of them) and `serviceStats`. No match is `{"traces": []}`. Newest trace first. With both `start` and `end` (non-zero), a trace is returned when it overlaps the window: it starts at or before `end` and ends at or after `start`, both inclusive to the nanosecond; with either missing no window applies, as in Tempo. With no `q` every trace in the window is returned. |
| `GET /api/traces/{traceId}` | The trace as Tempo marshals it: `{"batches": [{resource, scopeSpans: [{scope, spans}]}]}`. This is **not** OTLP/JSON: `traceId`, `spanId` and `parentSpanId` are base64, `kind` and `status.code` are enum names (`SPAN_KIND_SERVER`, `STATUS_CODE_ERROR`), 64-bit integers (times, `intValue`) are decimal strings, zero values are omitted, and every span has a `status` object. A trace id shorter than 32 hex characters is left-padded. Unknown trace: 404 with an empty body. Not hex: 400 `trace IDs can only contain hex characters: invalid character 'x' at position N`. |
| `GET /api/v2/search/tags` | `scope` = `span`, `resource`, `event`, `link`, `instrumentation`, `intrinsic`, or absent/`none` for all of them. Answers `{scopes: [{name, tags}], metrics}`: attribute names seen on any stored span, each list sorted, a scope with no names left out. A name seen on a single span is listed. `limit` caps each list. Unknown scope: 400 `invalid scope: <scope>`. |

Every 400 from the query routes is Tempo's: the error text as the whole body, `text/plain`.
Search validates in Tempo's order: `invalid start: strconv.ParseUint: parsing "abc": invalid syntax`,
`invalid limit: must be a positive number`, `http parameter start must be before end. received
start=10 end=5`, `limit N exceeds max limit M`, then the TraceQL query, the 168 h maximum range
and `spans per span set exceeds 100. received N`.

### TraceQL

One spanset filter is evaluated:

- `{ }`, `{ true }`, `{ false }`
- attribute equality: `.name`, `span.name` or `resource.name` (quoted parts such as
  `span."user id"` included) `=` a string, integer, float or boolean
- `&&` between those; every condition has to hold on the same span

An unscoped `.name` reads the span's attribute and falls back to the resource's. Types compare
exactly, except that integers and floats compare as numbers. An array attribute matches when any
element does.

Anything else is a 400 and never a looser match:

- Input Tempo's parser rejects answers with Tempo's wording and position, for example
  `invalid TraceQL query: parse error at line 1, col 3: syntax error: unexpected IDENTIFIER` for
  `{ user.id = "u" }` (the dot is missing).
- Valid TraceQL outside the subset (`=~`, `!=`, `>`, `||`, intrinsics such as `status` or
  `duration`, `event.`/`link.`/`parent.` scopes, pipelines, spanset operators, hints) answers
  `invalid TraceQL query: <construct> not yet supported (Mockingbird emulates a TraceQL subset)`.
  The first part is the wording Tempo's validator uses for features it lacks; a real Tempo
  evaluates these queries.

### Authentication and tenants

Tempo itself authenticates nobody; a gateway in front of it does. The emulator plays both:

| Setting | Effect |
| --- | --- |
| none (default) | A local Tempo: no credentials needed, stray ones ignored. |
| `bearerTokens` (`--bearer-token`) | `Authorization: Bearer <token>` on ingest and query. |
| `basicUsers` (`--basic-auth user:password`) | `Authorization: Basic …`, Grafana Cloud style (instance id and access token). |
| `unauthorized` | The response for missing or wrong credentials: `{status, body, contentType}` with `status` 401 or 403, default 401 `Unauthorized` as plain text. Set it to what your gateway answers. |
| `multitenancy` (`--multitenancy`) | Tempo's `multitenancy_enabled`: `X-Scope-OrgID` is required and a tenant reads only what it wrote. A query route without the header is 401 `no org id`; an export without it is 503 `{"code":14,"message":"no org id"}`. `a\|b` on a query reads both tenants. Off, the header is ignored. |
| `leftPadTraceIds` (`--left-pad-trace-ids`) | Tempo's `left_pad_trace_ids`: search answers 32-character trace ids. Off (Tempo's default), leading zeros are trimmed. |
| `defaultLimit`, `maxLimit` | Search's default (20) and maximum (262144) result count. |

Bearer tokens and Basic users can be configured together; a request needs one that matches.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/traces` | `{resourceSpans: [...], tenant?}`: store an OTLP/JSON export exactly as given, with no credentials, faults or tenant header in the way. A span without `startTimeUnixNano` starts at the emulator clock (`POST /__admin/clock`), and without `endTimeUnixNano` ends there. Answers `{accepted, tenant, traceIds}`. |
| `GET /__admin/traces` | `{traces: [{tenant, traceID, spanCount, rootServiceName, rootTraceName, startTimeUnixNano, durationMs}]}`, oldest first. `?tenant=` narrows it. |
| `GET /__admin/spans` | `{spans: [...]}`: the stored spans (hex ids beside the wire shape). `?traceId=`, `?tenant=`. |
| `GET /__admin/settings`, `PUT /__admin/settings` | The settings above, for the calling namespace. `POST /__admin/reset` returns them to their defaults. |

Snapshots (`POST /__admin/snapshots`, `POST /__admin/snapshots/:id/restore`), checkpoints,
reset, the clock, the request journal and metrics are the standard contract. The journal records
that an export happened and which trace ids it touched, never span contents.

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `"count": 1` is a
one-shot; `GET /__admin/faults/presets`): `ingest_unavailable` (503, exporters retry),
`ingest_rate_limited` (429 `RATE_LIMITED: …`, retried), `ingest_server_error` (500, dropped),
`ingest_dropped` (the connection dies), `query_unavailable` (503), `query_server_error`
(500 `internal error`), `query_rate_limited` (429 `too many outstanding requests`),
`query_timeout` (504 `context deadline exceeded`), `query_dropped`, `unauthorized` (the
configured 401 on every route). Ingest faults answer `google.rpc.Status` in the request's
encoding.

### Namespaces

Parallel workers each get their own store by `x-mockingbird-namespace`, by a
`/__admin/ns/<name>` prefix on the base URL, or by credential:
`PUT /__admin/credentials {"credentials": {"<bearer token or Basic username>": "<namespace>"}}`.
Tenants (`X-Scope-OrgID`) are a separate wall inside a namespace.

### What was verified, and how

No Tempo instance was available. Each behaviour was read from Grafana's documentation or
Tempo's source (v3.1.0) and the OpenTelemetry Collector's OTLP receiver (v0.153.0, which Tempo
embeds):

- Search parameters, defaults, validation order and messages: `pkg/api/http.go`
  (`ParseSearchRequest`), `modules/frontend/search_handlers.go`, `search_sharder.go`.
- Search and tags response fields and JSON types: `pkg/tempopb/tempo.proto` marshalled with gogo
  `jsonpb` defaults (`modules/frontend/combiner/common.go`), and the documented examples.
- Newest-first ordering, the overlap window, trimmed trace ids, `<root span not yet received>`:
  `pkg/traceql/combine.go`, `tempodb/encoding/vparquet5/block_traceql.go`, `pkg/util/traceid.go`,
  `modules/frontend/combiner/search.go`.
- `batches`, base64 ids, enum names and span ordering in trace by id; the bodiless 404:
  `pkg/tempopb/trace_utils.go`, `pkg/model/trace/sort.go`,
  `modules/frontend/combiner/trace_by_id.go`, and the example in "Push spans with HTTP".
- Tag scopes, sorting and the intrinsic list: `pkg/api/search_tags.go`,
  `modules/frontend/tag_handlers.go`, `pkg/search/util.go`, `pkg/collector`.
- TraceQL tokens, attribute lexing and error positions: `pkg/traceql/lexer.go`, `parse.go`, and
  the expected errors in `parse_test.go`.
- OTLP responses and errors: the collector's `receiver/otlpreceiver/otlphttp.go` and
  `internal/errors/errors.go`; id checks in `modules/distributor/distributor.go`.
- `no org id`: dskit `middleware.AuthenticateUser` for queries, Tempo's receiver middleware for
  ingest; cross-tenant reads: "Cross-tenant query federation".

**Unverified** (derived, or chosen where the sources say nothing):

- The default 401 for wrong credentials. It belongs to whatever gateway fronts Tempo (Grafana
  Cloud's body is not documented); configure `unauthorized` to match yours.
- Parse-error text beyond the cases in Tempo's parser tests. The emulator never appends goyacc's
  `, expecting …` list except where a test confirms it, and some invalid input that sits outside
  the subset is reported as "not yet supported" instead of as a syntax error.
- The message text of a 400 for an undecodable export (the status, code 3 and encoding are the
  receiver's; its decoder's wording is not reproduced), and for an id of the wrong length, which
  the receiver rejects before Tempo's distributor would.
- 503 `no org id` for an export without `X-Scope-OrgID` under multi-tenancy: derived from the
  receiver mapping a plain error to `UNAVAILABLE`, not observed.
- `metrics` values in search and tags (`inspectedBytes`, `inspectedTraces`): synthetic.
- `serviceStats`, and which attributes a matched span lists: taken from the engine's source and
  the documented example, not from a live response.
- Scope order in an unscoped tags response (Tempo's is unordered), the order of traces that start
  at the same nanosecond (the emulator uses the trace id), and which traces a `limit` keeps:
  Tempo "takes the first N results" of a parallel search, the emulator always keeps the newest.
- The 404 for a path Tempo does not serve (`404 page not found`).
- Bodies of the query fault presets other than `internal error`, `too many outstanding requests`
  and `context deadline exceeded`.

### Deliberately not modelled

- The Grafana UI, dashboards, PromQL and metrics; TraceQL metrics (`/api/metrics/query_range`)
  and the metrics-generator.
- Full TraceQL: only the subset above is evaluated, everything else is a 400.
- The tag search that predates TraceQL (`tags=`, `minDuration`, `maxDuration`), filtered tag
  names (`q` on the tags route), tag values, and the v1 tags route: refused or absent.
- `GET /api/v2/traces/{id}` and `Accept: application/protobuf` on query routes: answers are JSON.
- Block-granular time ranges: `start`/`end` on trace by id and tags are validated, then ignored
  (the emulator is one block that always overlaps).
- Tail sampling, ingestion limits, retention, compaction, distributed storage, and the delay
  between ingest and searchability: a stored span is visible at once.
- OTLP/gRPC, Jaeger and Zipkin receivers; OTLP logs and metrics.
- Administration, provisioning, overrides and cloud resource creation.
- Span-id de-duplication for Zipkin-style shared ids, and Tempo's root-span and service
  statistics for traces spread over several tenants.

Send 64-bit OTLP/JSON values (timestamps, `intValue`) as strings, as exporters do: a JSON number
past 2^53 loses precision before the emulator sees it. Values that do not fit their protobuf
width, ids of the wrong length and attribute values nested more than 100 levels deep are refused
with a 400.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `TempoAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `inject(payload, tenant?)`, `spans(filter?)`, `traces(tenant?)`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, namespaces, credentials, presets, clock, checkpoints). Options: `settings`, `clock`, `seed`, `adminPrefix`, `adminKey`, `onLog`, `sqlite`. |
| `TEMPO_PRESETS` | object | Every named fault preset. |
| `TEMPO_NAMESPACE` | string | The service name, `"tempo"`. |
| `DEFAULT_SETTINGS` | object | The settings a namespace starts with. |
| `SINGLE_TENANT` | string | Tempo's tenant when multi-tenancy is off, `"single-tenant"`. |
| `ORG_ID_HEADER` | string | `"x-scope-orgid"`. |
| `ROOT_SPAN_NOT_YET_RECEIVED` | string | `rootServiceName` of a trace without a root span. |
| `INTRINSIC_TAGS` | array | The names under the `intrinsic` tag scope. |
| `tempoCredential` | function | The bearer token or Basic username of a request (how credentials map to namespaces). |
| `parseTraceQL`, `matchesSpan`, `TraceQLError` | functions, class | The TraceQL subset: parse a query, test one span's attributes against it, and the error whose message follows `invalid TraceQL query: `. |
| `decodeSpans`, `validateIds`, `OtlpError` | functions, class | An OTLP/JSON export as spans in Tempo's wire shape, Tempo's id checks, and the error a refused export raises. |
| `decodeTraceRequest`, `encodeRpcStatus`, `decodeRpcStatus`, `ProtobufError` | functions, class | The protobuf `ExportTraceServiceRequest` decoder and `google.rpc.Status` codec. |
| `hexToBase64`, `base64ToHex` | functions | Convert ids between OTLP's hex and Tempo's base64. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8930. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
