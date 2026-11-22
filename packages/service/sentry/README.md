# @crvouga/mockingbird-service-sentry

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A stateful Sentry SDK transport and event/issue assertion emulator. This initial package is **wip**:
its bounded surface follows the official envelope protocol and Relay responses, not the entire
Sentry product. No vendor account, container, secret or outbound call is needed for tests.

## Install

```sh
bun add -d @crvouga/mockingbird-service-sentry
```

## Usage

```ts
import * as Sentry from "@sentry/node"
import { DEFAULT_PROJECT } from "@crvouga/mockingbird-service-sentry"
import { createServer } from "@crvouga/mockingbird-service-sentry/server"

// Test setup: the emulator, and a DSN that points the Sentry SDK at it.
const server = await createServer()
const dsn = `${server.url.replace("://", `://${DEFAULT_PROJECT.publicKey}@`)}/1`

// The app's own Sentry calls.
Sentry.init({ dsn })
Sentry.captureMessage("Fixture failure", { fingerprint: ["fixture-group"] })
await Sentry.flush(2000)

// The test asserts on what the emulator captured.
const captured = await (await fetch(`${server.url}/__admin/events?project=1`)).json()
console.log(captured.events.length) // 1
await Sentry.close()
await server.close()
```

The official `@sentry/nextjs` and `@sentry/node` SDKs both take that DSN: start `createServer()` from
the `/server` entry and set `SENTRY_DSN` to `http://<DEFAULT_PROJECT.publicKey>@127.0.0.1:<port>/1`, or
give it to `init`/`NodeClient`. Both SDKs are tested at **11.4.0** (the report supplied no pinned version).
Use SDK `flush()` to finish submission, then `POST /__admin/flush {"eventIds": […], "count": n}`
for an immediate assertion: `flushed: false` means the condition is not met; it never sleeps.

REST requests use `Authorization: Bearer fixture-rest-token`. `projects` and `restTokens` options
replace these constructor fixtures. Each project includes its organization, numeric-string ID,
slug, name and 32-hex public key. The defaults are obviously synthetic. Each namespace receives
its own constructor fixtures and returns to them on reset.

```sh
mockingbird-sentry serve --port 8810
```

## Routes and behavior

- `POST /api/{project}/envelope/`: byte-accurate envelope parsing, implicit or explicit lengths,
  UTF-8 JSON headers, binary attachments, unknown item retention, event/transaction/session/
  sessions/client-report items. Gzip/deflate request compression is supported. Responses are
  `200 {"id": "<event ID>"}` when an ID applies, or `200 {}` for session/report-only envelopes.
- `POST /api/{project}/store/`: JSON event ingestion; generates a deterministic 32-hex event ID
  when absent. Legacy `message: false` is accepted and ignored, matching Relay LogEntry; raw
  input attributes cannot overwrite normalized REST fields. Event IDs dedupe per project, including concurrent retries: a replay returns the
  same ID without a second capture, issue count or attachment.
- `POST /api/{project}/minidump/`: raw native minidump or multipart `upload_file_minidump`, optional
  `sentry` JSON and additional files. Returns the hyphenated event UUID as plain text, like Relay.
  Validates the MDMP/PMDM magic and retains bytes; native crash symbolication is not simulated.
- `GET /api/0/projects/{organization}/{project}/events/`: error events newest first, bare array,
  `full=true` caps a page at 10. Transactions remain available in event detail and admin search.
- `GET /api/0/projects/{organization}/{project}/events/{event}/`: event ID, message/title,
  exception/stacktrace entries, contexts, breadcrumbs, tags and fixture user identity.
- `GET /api/0/projects/{organization}/{project}/issues/`: bare-array groups; defaults to
  `is:unresolved`, `query=` includes all statuses. Explicit fingerprints take priority; fallback
  grouping is deterministically based on exception title/frames, or message when configured.
- `GET`/`PUT /api/0/issues/{issue}/` and `/api/0/organizations/{organization}/issues/{issue}/`:
  read or set `status` to `unresolved`, `resolved`, or `ignored`. Resolving persists until an
  explicit status update; automatic regression detection is outside this initial emulator.
- `GET /api/0/projects/{organization}/{project}/events/{event}/attachments/` and `/{attachment}/`:
  attachment metadata; `?download=1` on detail returns the original bytes to the authenticated caller.

Read pagination uses `limit` (1–100), `cursor=0:<offset>:<previous flag>` and Sentry's `Link`
header with both `rel="previous"` and `rel="next"`, their cursors, and `results="true|false"`.
Stable insertion order avoids duplicates when walking a fixed result set. Links preserve filters
and the selected namespace, including a custom admin prefix. The emulator supports release/tag/trace
and status filters; production search syntax, sampling, trend/rank sorting and statistics are
not silently represented as implemented features (see boundaries below).

Ingest auth accepts `X-Sentry-Auth: Sentry sentry_key=…, sentry_version=7`, query `sentry_key`
with optional `sentry_version`, or a self-authenticated envelope DSN. Conflicting header/query
credentials, missing auth, malformed keys, incompatible protocol versions, bad envelopes and
unknown project keys receive Relay-shaped `{"detail": "…"}` errors. There is no invented generic
API error code or request ID: the ingest response's `id` is the vendor event identifier. Exact
production quota, filter-reason details and REST error text beyond the documented cases are bounded
approximations. The default payload ceiling is 20 MiB, configurable with `maxPayloadBytes`.

## Test controls

All internal endpoints move together with `adminPrefix` (default `/__admin`). Namespace carriers:
`x-mockingbird-namespace`, `/__admin/ns/<suite>/…`, or DSN query/header credentials and REST tokens
mapped with `PUT /__admin/credentials`. Self-authenticated envelope-only DSNs use header/path
namespaces; credential mapping cannot inspect a body before the shared runtime selects a namespace.
Clock, reset, Timeline checkpoints/branches and snapshot aliases, request journal, metrics, admin
UI, collection introspection and generic faults are the shared service contract.

- `GET /__admin/events?project=1&release=…&tag=key:value&trace=…`: normalized captured errors and
  transactions. All listed fields, timestamps, fingerprints, tags, contexts and breadcrumbs survive
  subject to redaction; `user` retains only the fake fixture `id`.
- `GET /__admin/issues`: matching groups with current resolution state, using the same filters.
- `GET /__admin/envelopes?project=1`: item/header metadata and rejection flags; never raw bytes.
- `GET`/`PUT /__admin/settings`: `grouping: "exception"|"message"`, `sensitivePaths` (dot paths;
  defaults `request.data`, `request.cookies`) and `rejectItems` (types to discard while accepting
  other items with 200). These are synthetic controls, not public Sentry settings APIs.
- `POST /__admin/flush {eventIds?, count?, project?}`: immediate capture condition/result.
- `POST /__admin/issues/{id}/status {status}`: resolve/reopen/ignore.
- `POST /__admin/projects/{id}/clear`: clear that project's telemetry while retaining its fixture.

Presets: `rate_limited` (429, `Retry-After: 60`, `X-Sentry-Rate-Limits: 60:error:organization`),
`server_error` (503), `network_reset` (socket drop) and `item_rejected` (synthetic 403 filter).
Each is scoped to ingestion and operates before writes. Generic faults can force other 5xx/429
responses. The official SDK test proves error-category quotas drop further errors without blocking
transactions. It verifies behavior immediately, without retry sleeps.

### Raw capture and redaction

Authorization/cookies and credential-named fields are filtered recursively, including header
pairs. Configured sensitive body paths are filtered before normalized data enters storage or
vendor/admin diagnostics. Personal email, name and IP attributes are dropped. Journals/log sinks
contain request metadata and resource IDs only, never bodies, headers or attachment bytes.
Raw wire bodies and attachment bytes are retained **encrypted with AES-GCM** in ordinary Collections,
so reset/Timeline cover them without disclosing plaintext through generic state diagnostics.
`runtime.instance(namespace).rawEnvelope(id)` is explicit programmatic owner access to original
wire bytes; it is not exposed by an admin HTTP route. Supply a `captureKey` from `createCaptureKey()`
when reopening persistent SQLite storage; the default key lives only for that runtime's lifetime.
Treat this explicit raw access as sensitive test-owner access. Normal event/detail/search paths
return redacted data, while authenticated attachment download is an explicit byte retrieval.

## Oracle evidence

- [Official envelope grammar and item rules](https://develop.sentry.dev/sdk/foundations/envelopes/).
- [Official transport rate limits](https://develop.sentry.dev/sdk/foundations/transport/rate-limiting/).
- [Official pagination headers and cursor examples](https://docs.sentry.io/api/pagination/).
- [Project event list](https://docs.sentry.io/api/events/list-a-projects-error-events/),
  [project issue list](https://docs.sentry.io/api/events/list-a-projects-issues/) and
  [issue detail](https://docs.sentry.io/api/events/retrieve-an-issue/).
- [Relay envelope response](https://github.com/getsentry/relay/blob/c4e9930349068039dd6ecd06cf338c527ee90165/relay-server/src/endpoints/envelope.rs),
  [auth status/messages](https://github.com/getsentry/relay/blob/c4e9930349068039dd6ecd06cf338c527ee90165/relay-server/src/extractors/request_meta.rs),
  [ingest errors, quota headers and minidump response](https://github.com/getsentry/relay/blob/c4e9930349068039dd6ecd06cf338c527ee90165/relay-server/src/endpoints/common.rs).
- [Relay legacy message normalization](https://github.com/getsentry/relay/blob/c4e9930349068039dd6ecd06cf338c527ee90165/relay-event-schema/src/protocol/logentry.rs) explicitly ignores `message: false`; its CI-discovered seed is retained in the regression registry.
- Official npm SDK source for `@sentry/node`, `@sentry/core` and `@sentry/nextjs` 11.4.0; served
  tests use the actual clients and transport, not a reimplementation of SDK quota handling.

`bun run parity:service -- sentry` requires `SENTRY_API_URL`, `SENTRY_AUTH_TOKEN`,
`SENTRY_ORGANIZATION_SLUG`, `SENTRY_PROJECT_ID` and `SENTRY_PROJECT_SLUG`. The runner compares only
safe reads and never submits to a live vendor. Tests need none of these keys. Live parity has not
been claimed without access; docs and SDK source are the initial oracle.

## Deliberately not modelled

Vendor dashboards/billing, full organization/project/release management, production quotas,
complete search DSL and search time windows, sort modes other than newest/last-seen, statistical
series/sampling, source-map/native symbolication, sessions aggregate analytics, profiling/replays,
full crash dump validation, legacy compressed-base64 store ingestion, automatic issue regressions,
alert-rule evaluation or optional issue-alert webhooks. Unknown envelope items are retained, not
processed as unsupported product features. Group fallback rules and forced filter behavior are
explicit deterministic test policies, not Sentry's production grouping algorithm. Issues are
explicitly resolved/reopened by controls or vendor PUT, and never invent asynchronous workers.

## API

Main entry runtime exports: `SentryAPI` (`fetch`, `reset`, `rawEnvelope`, `captured`, `issueWire`,
`sqlite`, `state`, `app`), `createRuntime`, `SENTRY_NAMESPACE`, `SENTRY_PRESETS`, `DEFAULT_PROJECT`,
`createCaptureKey`, `sentryCredential`, `document` and `supportedOperationIds`.
Types include `SentryAPIOptions`, `SentryRuntime`, `SentryRuntimeOptions`, `ProjectFixture`,
`SentrySettings`, `CapturedEvent`, `CapturedEnvelope`, and `IssueRecord`.
Server entry runtime exports: `createServer`, `DEFAULT_PORT`, `serveTarget`. Server types:
`SentryServer`, `SentryServerOptions`. `createServer` returns `{url, runtime, close, …}`; close the
server after each test. The CLI entry runs `serve` with the common host/port/admin-prefix options.
