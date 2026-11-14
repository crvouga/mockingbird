# @crvouga/mockingbird-service-meta

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful Meta Graph v26 emulator for server-side Conversions API events and marketing reporting. It
preserves privacy-safe hashed user fields, event deduplication, ambiguous writes, Graph errors,
campaign objects, dated insights, breakdowns, and cursor pagination without contacting Meta.

## Install

```bash
npm install -D @crvouga/mockingbird-service-meta
```

ESM only. Node >= 22 or Bun >= 1.2. Serve with `npx mockingbird-meta serve`, `createServer` from
`./server`, or mount `createRuntime()` in any Fetch-compatible process.

## Usage

Make the Graph origin injectable and point it at the emulator. Any non-empty synthetic Bearer token or
`access_token` query value authenticates unless `/__admin/settings` restricts tokens.

```ts
import { createServer } from "@crvouga/mockingbird-service-meta/server"

const server = await createServer()

// The application's own Conversions API request. Only the Graph origin changes:
// server.url instead of https://graph.facebook.com.
const response = await fetch(`${server.url}/v26.0/pixel_test/events`, {
  method: "POST",
  headers: { authorization: "Bearer meta_test", "content-type": "application/json" },
  body: JSON.stringify({ data: [{
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: "order_42",
    action_source: "website",
    user_data: { em: ["a".repeat(64)] },
    custom_data: { currency: "USD", value: 42 },
  }] }),
})
console.log(await response.json())
// → {events_received: 1, messages: [], fbtrace_id: "trace_…"}

await server.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v26.0/:pixelId/events` | Accepts CAPI `data[]` and `test_event_code`; keeps event name/time/id, action source, source URL, hashed user data and custom data. Repeated `event_id` values are acknowledged without a second stored event. Events older than seven days, future events, malformed hashes and invalid bodies receive Graph error envelopes. |
| `GET /v26.0/:accountId/insights` | Filters seeded or admin-inserted insight rows by inclusive JSON `time_range` and paginates with `limit`/`after` (`paging.cursors.after`, and `paging.next` while rows remain). `level` (`account`, `campaign`, `adset`, `ad`) and `time_increment` (`all_days`, `monthly`, or 1–90 days) roll the daily rows up: counts, spend and per-`action_type` actions are summed and purchase ROAS is recomputed. `fields` returns only the listed fields plus `date_start`/`date_stop`; a field outside the insight schema, an unknown `level` or an out-of-range `time_increment` answers Graph error 100. `country` is included when requested as a breakdown. |
| `GET /v26.0/:objectId` | Reads seeded/admin-inserted campaign, ad-set, or ad records. |

Seed fixtures are `act_mockingbird`, `cmp_mockingbird`, `set_mockingbird`, and `ad_mockingbird`,
with three dated insight rows from 2026-01-01 through 2026-01-03.

### Admin and faults

`GET /__admin/events` returns the namespace's privacy-safe stored requests. `GET/PUT
/__admin/settings` controls `accessTokens` and `maxEventAgeSeconds`. Standard `/__admin/state`
routes seed or edit `events`, `objects`, and `insights` directly.

Presets: `expired_token` (code 190, subcode 463), `rate_limited` (code 4, HTTP 429),
`user_request_limit` (code 17, subcode 2446079), `ad_account_rate_limit` (code 80004, subcode
2446079), `server_error`, `partial_event_acceptance`, `accepted_then_drop`, and `slow`. Every
Graph error is `{"error": {message, type, code, error_subcode?, is_transient, fbtrace_id}}`;
token and rate-limit codes are typed `OAuthException`. The ambiguous-write preset persists the event before dropping the
connection; retrying the same `event_id` remains deduplicated.

Namespaces use `x-mockingbird-namespace`, `/__admin/ns/<name>/…`, or credential mapping through
`PUT /__admin/credentials`.

## API

The main entry exports `MetaAPI`, `MetaState`, `createRuntime`, `META_NAMESPACE`, `META_PRESETS`,
`DEFAULT_SETTINGS`, `OAUTH_CODES`, `accessTokenCredential`, the generated `document`, `operationIds`,
`supportedOperationIds`, and their public option/state/event/insight types.
`@crvouga/mockingbird-service-meta/server` exports
`createServer`, `serveTarget`, `DEFAULT_PORT`, and server option/result types.

## Deliberately not modelled

- Real ad delivery, attribution calculation, hashing of plaintext PII, app-secret proof, or OAuth.
- Campaign/ad-set/ad mutation, creatives, audiences, pixels configuration, dashboards, or billing.
- The complete Insights fields/breakdowns matrix and asynchronous report jobs. Without `level` or
  `time_increment` the emulator returns the stored daily campaign rows; Meta's own defaults
  (`level` = the queried object, `time_increment` = `all_days`) apply only when a client sends
  them. The `level`/`time_increment` roll-up and the HTTP 400 status of codes 17 and 80004 are a
  best guess from Meta's documentation, not oracle-verified.
- Graph versions other than `v26.0`.
- Meta-side probabilistic matching: the emulator records only the supplied synthetic hashed fields.
