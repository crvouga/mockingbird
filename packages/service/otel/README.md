# @crvouga/mockingbird-service-otel

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of an **OTLP/HTTP collector** in front of the **OpenObserve (O2) search API**,
over one store. Local and E2E runs stop exporting to production telemetry infrastructure, and a
test can assert on structured events: emit through the real OpenTelemetry SDK, then read the
log back with the same SQL our ops feed and investigation agent send ("the reconcile cron
emitted `initial_credit_reconcile_completed` with `granted=1`").

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/otel/SUPPORT.md)
- OTLP/HTTP follows opentelemetry-proto v1; the O2 routes follow OpenObserve's API, trimmed to
  what our clients call.

## Install

```bash
npm install -D @crvouga/mockingbird-service-otel
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies, no protobuf library (a minimal
wire-format decoder is built in). Serve it with `npx mockingbird-otel serve`, `createServer`
from `./server` (Node), or `createRuntime` with any Fetch server.

## Usage

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at the emulator and set `OTEL_TRACES_SAMPLER_ARG=1` (our SDK
samples 10% of root spans otherwise). Point `O2_BASE_URL` at the same emulator; `O2_BASIC_AUTH` is
any base64 `user:password` unless `--search-auth` is set.

```bash
npx mockingbird-otel serve --port 8809 --ingest-token "$OTEL_AUTH_TOKEN"
# a local collector that takes no credentials, with a browser exporter allowed in
npx mockingbird-otel serve --ingest-auth none --cors-origins http://localhost:5173
# a hosted OTLP gateway: Authorization: Basic base64(instanceId:token)
npx mockingbird-otel serve --ingest-basic-auth "$OTLP_INSTANCE_ID:$OTLP_TOKEN"
```

```ts
import { SeverityNumber } from "@opentelemetry/api-logs"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { createServer } from "@crvouga/mockingbird-service-otel/server"

const server = await createServer()

// The OpenTelemetry SDK your application already uses. Only the exporter's URL changes.
const exporter = new OTLPLogExporter({
  url: `${server.url}/v1/logs`,
  headers: { authorization: "Bearer ingest-token" },
})
const loggerProvider = new LoggerProvider({
  resource: resourceFromAttributes({ "service.name": "backend" }),
  processors: [new SimpleLogRecordProcessor(exporter)],
})
loggerProvider.getLogger("backend").emit({
  severityNumber: SeverityNumber.INFO,
  severityText: "info",
  body: "reconcile done", // dropped: bodies are never stored
  attributes: { event: "initial_credit_reconcile_completed", granted: 1 },
})
await loggerProvider.forceFlush()

// Test control: long-poll until the event lands.
await fetch(`${server.url}/__admin/wait`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "log", where: { event: "initial_credit_reconcile_completed" } }),
})

// Then query it the way our O2 clients do (OpenObserve's search API is plain HTTP).
const search = await fetch(`${server.url}/api/30rBqcDevOrg7Hn2KmQ4xW9sLtY/_search`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Basic ${btoa("agent:pw")}` },
  body: JSON.stringify({
    query: { sql: `SELECT * FROM "default" WHERE event = 'initial_credit_reconcile_completed'` },
  }),
})
console.log(await search.json())
// { hits: [{ service_name: "backend", event: "…", granted: 1, severity_text: "info", _timestamp }], … }

await loggerProvider.shutdown()
await server.close()
```

### Receiver

| Route | Behaviour |
| --- | --- |
| `POST /v1/traces` | `ExportTraceServiceRequest`, `application/json` or `application/x-protobuf` (optionally `content-encoding: gzip`) → `200 {partialSuccess: {}}` (an empty protobuf response for protobuf requests). |
| `POST /v1/logs` | `ExportLogsServiceRequest`, same encodings and answers. |
| `POST /v1/metrics` | Accepted and counted (`GET /__admin/otlp-metrics`), never stored. |
| `OPTIONS /v1/traces`, `/v1/logs`, `/v1/metrics` | A browser exporter's CORS preflight, answered when `cors.allowedOrigins` is set (see *Browser CORS*); otherwise `405`. |

Undecodable payloads are 400, other content types 415. Every receiver error is a
`google.rpc.Status` (`{code, message}`) in the request's encoding: binary protobuf for an
`application/x-protobuf` request, JSON otherwise. The optional `stream-name` header picks the
stream (default `default`).

**Collector auth.** The receiver authenticates exports the way the collector it stands in for
does, so the exporter under test keeps its real headers. The mode is the `ingestAuth` setting
(`createRuntime({settings})`, `PUT /__admin/settings` per namespace, or `--ingest-auth`):

| `ingestAuth` | An export needs | Narrowed by |
| --- | --- | --- |
| `bearer` (default) | `Authorization: Bearer <token>`: any token, 401 without one. | `ingestTokens` / `--ingest-token`: only those tokens. |
| `basic` | `Authorization: Basic base64(user:password)`, the header a hosted OTLP gateway takes (Grafana Cloud: `instanceId:token`): any credentials, 401 without them. | `ingestUsers: [{username, password}]` / `--ingest-basic-auth <user:password>`: only those. |
| `none` | Nothing: a local collector. An `Authorization` header an exporter still sends is ignored. | — |

A refused export is `401 {"code": 16, "message": "Unauthenticated"}`. A mode takes only its own
scheme (a bearer token is a 401 in `basic` mode and the reverse), credentials are checked before
the payload is parsed, and in every mode an accepted payload is parsed and stored the same way.
Only the receiver changes: O2 search always wants Basic credentials.

**Browser CORS.** Off by default: `OPTIONS /v1/*` is `405` and no response carries CORS headers.
Set `cors` (same three places; `--cors-origins`, `--cors-headers`) to answer a browser exporter as
the OpenTelemetry Collector's `cors:` block does:

```ts
import { createRuntime } from "@crvouga/mockingbird-service-otel"

createRuntime({
  settings: {
    ingestAuth: "none",
    cors: {
      allowedOrigins: ["https://app.example.test", "https://*.preview.example.test"], // or "*"
      allowedHeaders: ["authorization", "content-type", "traceparent", "tracestate"], // or "*"
      allowedMethods: ["POST"], // default GET, POST, HEAD
      exposedHeaders: [], // Access-Control-Expose-Headers on the export
      maxAge: 600, // Access-Control-Max-Age, seconds
    },
  },
})
```

A preflight (`OPTIONS` with `Origin` and `Access-Control-Request-Method`) is answered before
authentication, always `204`. When the origin, the requested method and every name in
`Access-Control-Request-Headers` are allowed it carries `Access-Control-Allow-Origin` (the
origin, or `*`), `-Allow-Methods`, `-Allow-Headers` (both echoing the request),
`-Allow-Credentials: true` and `-Max-Age`; otherwise it carries none of them, which is what
fails it in the browser. The export's own response, errors included, carries
`Access-Control-Allow-Origin`, `-Allow-Credentials` and `Vary: Origin` for an allowed origin.
With `allowedHeaders` unset only `accept`, `content-type` and `x-requested-with` pass; once it
is set the list is exact, so name `content-type` (an OTLP content type is never CORS-safelisted)
and the propagation headers your exporter adds. A preflight has no credential to pick a
namespace by: it reads the default namespace's settings unless the endpoint uses the
`/__admin/ns/<name>` prefix (settings passed to `createRuntime` apply to every namespace).

**Storage, as O2 stores it.** Every field name is lowercased and flattened (`clientUserId` →
`clientuserid`, `http.status_code` → `http_status_code`, nested maps joined with `_`); resource
attributes get a `service_` prefix (`service_service_version`,
`service_deployment_environment_name`) except `service.name` → `service_name`; null fields are
dropped. Logs carry `_timestamp` (µs), `severity_text`, `severity_number`, `trace_id`, `span_id`
and their attributes (`event`, …). Spans carry `operation_name`, `trace_id`, `span_id`,
`reference_parent_span_id`, `span_kind`, `span_status` (`UNSET`/`OK`/`ERROR`), `start_time` /
`end_time` (ns), `duration` (µs), `events` (JSON: each event's name, time and attributes) and
their attributes, with ids exactly as exported. **Log bodies are dropped**
unless `--keep-bodies` (a body can hold a prompt or PHI; truncation is not protection); the
`body` column still exists in the schema so recipes that select it keep working.

**Org routing.** `deployment.environment.name` (or `deployment.environment`) `production` lands
in the `production` org; anything else in `development`, like the collector's dev-org default.
Default orgs: `default`, `development` (`30rBqcDevOrg7Hn2KmQ4xW9sLtY`), `production`
(`3HSzeProdOrg5Jd8VpN1cR6gTfB`).

### O2 search

| Route | Behaviour |
| --- | --- |
| `GET /api/organizations` | `{data: [{id, identifier, name, type}]}`: display name → identifier. |
| `GET /api/{org}/streams?type=logs\|traces` | `{list: [{name, stream_type, stats: {doc_num}}]}`. |
| `GET /api/{org}/streams/{stream}/schema?type=logs\|traces` | `{name, stream_type, schema: [{name, type}]}`: every field ever ingested non-null. 404 before anything is ingested. |
| `POST /api/{org}/_search?type=logs\|traces` | `{query: {sql, start_time, end_time (µs), from, size}}` → `{took, hits, total, from, size, scan_records, is_partial}`. |

Basic auth is required (`401 Unauthorized Access`, text/plain). `{org}` must be an org
**identifier**: a display name (`/api/production/_search`, as release-conductor sends) is the
same bare 401 real O2 answers, so that bug stays visible.

The SQL subset: `SELECT * | expr [AS alias], … FROM "<stream>" [WHERE …] [GROUP BY …]
[HAVING …] [ORDER BY expr [ASC|DESC], …] [LIMIT n [OFFSET m]]` with `AND`/`OR`/`NOT`, `=`,
`!=`/`<>`, `<`, `<=`, `>`, `>=`, `IS [NOT] NULL`, `[NOT] IN`, `[NOT] LIKE`/`ILIKE`,
`[NOT] BETWEEN` (ISO strings compare against `_timestamp`), and `str_match`,
`str_match_ignore_case`, `match_all`, `re_match`, `lower`, `upper`, `tostring`, `length`,
`coalesce`, `count(*)`, `count([DISTINCT] x)`, `min`, `max`, `sum`, `avg`. Rows outside
`start_time`–`end_time` are excluded, the default order is `_timestamp DESC`, `LIMIT` applies
before `from`/`size` paging. **Column names are case-sensitive and must exist in the stream's
schema**: `clientUserId` or a never-ingested column is `400 … No field named …`, as our clients
expect. A query on a stream with no data answers empty hits.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/logs?service=&event=&severity=&trace_id=&org=` | Stored log rows (with `_org`, `_stream`). |
| `GET /__admin/spans?service=&name=&trace_id=&org=` | Stored span rows. |
| `POST /__admin/wait` | `{kind: "log"\|"span", where: {event: "…", …}, count?: 1, timeoutMs?: 5000, org?}`: long-polls until `count` rows match (200 `{matched, count}`) or times out (408 with what matched). `where` keys may be spelt as emitted (`clientUserId`, `service.name`) or as stored. |
| `GET /__admin/otlp-metrics` | `{requests, bytes, metrics}` for `/v1/metrics`. |
| `GET /__admin/settings` | The calling namespace's settings. |
| `PUT /__admin/settings` | `{ingestAuth?: "bearer"\|"basic"\|"none", ingestTokens?, ingestUsers?: [{username, password}], cors?: {allowedOrigins, allowedHeaders?, allowedMethods?, exposedHeaders?, maxAge?}, searchUsers?: [{username, password}], organizations?: [{identifier, name}], routing?: {byEnvironment, default}, keepBodies?}` for the calling namespace; only the keys sent change. |

`/__admin/spans`, `/__admin/logs` and `/__admin/wait` are the export of what was ingested: one
normalized row per span or log record, every attribute kept (see *Storage* above). The original
OTLP request batches are not kept, and `GET /__admin/requests` records each export without its
body.

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `rate_limited` (429 +
`retry-after: 1`), `bad_gateway` (502), `unavailable` (503), `gateway_timeout` (504) — all
retried by the SDK — `server_error` (500) and `unauthorized` (401), which the SDK drops,
`partial_success` (200 rejecting every item, JSON only) and `search_unavailable` (O2 search 503).
They work in every auth mode and fault the export `POST` only, never a CORS preflight; their
bodies are JSON whatever the request's encoding.

### Namespaces

`x-mockingbird-namespace`, a `/__admin/ns/<name>` prefix on the endpoint and base URL, or by credential:
`PUT /__admin/credentials {"credentials": {"<OTEL_AUTH_TOKEN>": "w1", "<O2 username>": "w1"}}`
(map both so a worker's exports and searches meet). In `basic` mode the credential is the Basic
username (the instance id); in `none` mode there is none, so use the header or the path prefix.

### Deliberately not modelled

- gRPC OTLP (port 4317); only OTLP/HTTP.
- Metrics storage and the O2 metrics/PromQL APIs: metric exports are counted only.
- O2's full SQL dialect (DataFusion): joins, subqueries, window functions, arithmetic,
  `histogram()`, `approx_*`; only the subset above.
- O2 ingestion via `/api/{org}/{stream}/_json` or `/api/{org}/v1/logs`, dashboards, alerts and
  the UI; the collector's own batching, tail sampling and transform processors.
- `partialSuccess` for protobuf requests (an empty success response is sent).
- The original OTLP batches, and the span fields no row holds: links, trace state, flags, the
  status message, the scope version and the dropped-item counts. `start_time` / `end_time` are
  JSON numbers, so nanoseconds past 2^53 round (`_timestamp` and `duration`, in µs, are exact).
- A hosted gateway's own surface: its `/otlp` path prefix (point the exporter at the emulator's
  root, or set the per-signal endpoint), its token scopes and the wording of its 401. The 401 is
  the OTLP `Status` above.
- The Collector's CORS library also refuses a preflight whose `Access-Control-Request-Headers`
  is not the lowercase, sorted list browsers send; here the names match in any order and case.
- Log bodies by default (see `--keep-bodies`).

## API

| Export | Kind | Description |
| --- | --- | --- |
| `OtelAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `logs()`, `spans()`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, wait, namespaces, credentials, presets). Options: `settings` (`ingestAuth`, `ingestTokens`, `ingestUsers`, `cors`, `searchUsers`, `organizations`, `routing`, `keepBodies`), `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `OTEL_PRESETS` | object | Every named fault preset. |
| `OTEL_NAMESPACE` | string | The service name, `"otel"`. |
| `otelCredential` | function | The OTLP bearer token or the Basic username (how credentials map to namespaces). |
| `adminRow` | function | A stored row as the admin routes show it (`_org`, `_stream` plus its columns). |
| `DEFAULT_ORGANIZATIONS`, `DEFAULT_SETTINGS`, `INGEST_AUTH_MODES` | values | The seeded orgs and settings (`ingestAuth: "bearer"`, CORS off), and the auth modes. |
| `logRows`, `spanRows`, `formatKey` | functions | OTLP/JSON export → O2 rows, and O2's field-name normalisation. |
| `decodeLogsRequest`, `decodeTraceRequest`, `ProtobufError` | functions, class | The protobuf decoder: OTLP protobuf → OTLP/JSON shape. |
| `parseSql`, `execute`, `referencedColumns`, `SqlError` | functions, class | The SQL subset: parse, run over rows, list the columns a query reads. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8809. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
