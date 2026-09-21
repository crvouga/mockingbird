# @crvouga/mockingbird-service-otel

Stateful mock of an **OTLP/HTTP collector** in front of the **OpenObserve (O2) search API**,
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

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at the mock and set `OTEL_TRACES_SAMPLER_ARG=1` (our SDK
samples 10% of root spans otherwise). Point `O2_BASE_URL` at the same mock; `O2_BASIC_AUTH` is
any base64 `user:password` unless `--search-auth` is set.

```bash
npx mockingbird-otel serve --port 8809 --ingest-token "$OTEL_AUTH_TOKEN"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-otel"

const otel = createRuntime()
const call = (path: string, init: RequestInit) => otel.fetch(new Request(`http://otel.test${path}`, init))

// What @opentelemetry/exporter-logs-otlp-http sends for one winston/pino event log.
await call("/v1/logs", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer ingest-token" },
  body: JSON.stringify({
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "backend" } }] },
      scopeLogs: [{ logRecords: [{
        severityText: "info",
        body: { stringValue: "reconcile done" }, // dropped: bodies are never stored
        attributes: [
          { key: "event", value: { stringValue: "initial_credit_reconcile_completed" } },
          { key: "granted", value: { intValue: "1" } },
        ],
      }] }],
    }],
  }),
})

// Long-poll until it lands, then query it the way our O2 clients do.
await call("/__admin/wait", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "log", where: { event: "initial_credit_reconcile_completed" } }),
})
const search = await call("/api/30rBqcDevOrg7Hn2KmQ4xW9sLtY/_search", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Basic ${btoa("agent:pw")}` },
  body: JSON.stringify({
    query: { sql: `SELECT * FROM "default" WHERE event = 'initial_credit_reconcile_completed'` },
  }),
})
// { hits: [{ service_name: "backend", event: "…", granted: 1, severity_text: "info", _timestamp }], … }
```

### Receiver

| Route | Behaviour |
| --- | --- |
| `POST /v1/traces` | `ExportTraceServiceRequest`, `application/json` or `application/x-protobuf` (optionally `content-encoding: gzip`) → `200 {partialSuccess: {}}` (an empty protobuf response for protobuf requests). |
| `POST /v1/logs` | `ExportLogsServiceRequest`, same encodings and answers. |
| `POST /v1/metrics` | Accepted and counted (`GET /__admin/otlp-metrics`), never stored. |

`Authorization: Bearer <token>` is required (401 without); with `--ingest-token` only that token
is accepted. Undecodable payloads are 400, other content types 415. The optional `stream-name`
header picks the stream (default `default`).

**Storage, as O2 stores it.** Every field name is lowercased and flattened (`clientUserId` →
`clientuserid`, `http.status_code` → `http_status_code`, nested maps joined with `_`); resource
attributes get a `service_` prefix (`service_service_version`,
`service_deployment_environment_name`) except `service.name` → `service_name`; null fields are
dropped. Logs carry `_timestamp` (µs), `severity_text`, `severity_number`, `trace_id`, `span_id`
and their attributes (`event`, …). Spans carry `operation_name`, `trace_id`, `span_id`,
`reference_parent_span_id`, `span_kind`, `span_status` (`UNSET`/`OK`/`ERROR`), `start_time` /
`end_time` (ns), `duration` (µs), `events` (JSON) and their attributes. **Log bodies are dropped**
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
| `PUT /__admin/settings` | `{ingestTokens?, searchUsers?: [{username, password}], organizations?: [{identifier, name}], routing?: {byEnvironment, default}, keepBodies?}` for the calling namespace. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `rate_limited` (429 +
`retry-after: 1`), `bad_gateway` (502), `unavailable` (503), `gateway_timeout` (504) — all
retried by the SDK — `server_error` (500) and `unauthorized` (401), which the SDK drops,
`partial_success` (200 rejecting every item, JSON only) and `search_unavailable` (O2 search 503).

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the endpoint and base URL, or by credential:
`PUT /__admin/credentials {"credentials": {"<OTEL_AUTH_TOKEN>": "w1", "<O2 username>": "w1"}}`
(map both so a worker's exports and searches meet).

### Deliberately not modelled

- gRPC OTLP (port 4317); only OTLP/HTTP.
- Metrics storage and the O2 metrics/PromQL APIs: metric exports are counted only.
- O2's full SQL dialect (DataFusion): joins, subqueries, window functions, arithmetic,
  `histogram()`, `approx_*`; only the subset above.
- O2 ingestion via `/api/{org}/{stream}/_json` or `/api/{org}/v1/logs`, dashboards, alerts and
  the UI; the collector's own batching, tail sampling and transform processors.
- `partialSuccess` for protobuf requests (an empty success response is sent).
- Log bodies by default (see `--keep-bodies`).

## API

| Export | Kind | Description |
| --- | --- | --- |
| `OtelAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `logs()`, `spans()`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, wait, namespaces, credentials, presets). Options: `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `OTEL_PRESETS` | object | Every named fault preset. |
| `OTEL_NAMESPACE` | string | The service name, `"otel"`. |
| `otelCredential` | function | The OTLP bearer token or the O2 Basic username (how credentials map to namespaces). |
| `adminRow` | function | A stored row as the admin routes show it (`_org`, `_stream` plus its columns). |
| `DEFAULT_ORGANIZATIONS`, `DEFAULT_SETTINGS` | values | The seeded orgs and settings. |
| `logRows`, `spanRows`, `formatKey` | functions | OTLP/JSON export → O2 rows, and O2's field-name normalisation. |
| `decodeLogsRequest`, `decodeTraceRequest`, `ProtobufError` | functions, class | The protobuf decoder: OTLP protobuf → OTLP/JSON shape. |
| `parseSql`, `execute`, `referencedColumns`, `SqlError` | functions, class | The SQL subset: parse, run over rows, list the columns a query reads. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8809. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
