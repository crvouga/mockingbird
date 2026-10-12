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
| `GET /v26.0/:accountId/insights` | Filters seeded or admin-inserted insight rows by inclusive JSON `time_range`, paginates with `limit`/`after`, and includes `country` when requested as a breakdown. |
| `GET /v26.0/:objectId` | Reads seeded/admin-inserted campaign, ad-set, or ad records. |

Seed fixtures are `act_mockingbird`, `cmp_mockingbird`, `set_mockingbird`, and `ad_mockingbird`,
with three dated insight rows from 2026-01-01 through 2026-01-03.

### Admin and faults

`GET /__admin/events` returns the namespace's privacy-safe stored requests. `GET/PUT
/__admin/settings` controls `accessTokens` and `maxEventAgeSeconds`. Standard `/__admin/state`
routes seed or edit `events`, `objects`, and `insights` directly.

Presets: `expired_token`, `rate_limited`, `server_error`, `partial_event_acceptance`,
`accepted_then_drop`, and `slow`. The ambiguous-write preset persists the event before dropping the
connection; retrying the same `event_id` remains deduplicated.

Namespaces use `x-mockingbird-namespace`, `/__admin/ns/<name>/…`, or credential mapping through
`PUT /__admin/credentials`.

## API

The main entry exports `MetaAPI`, `MetaState`, `createRuntime`, `META_NAMESPACE`, `META_PRESETS`,
`DEFAULT_SETTINGS`, `accessTokenCredential`, the generated `document`, `operationIds`,
`supportedOperationIds`, and their public option/state/event/insight types.
`@crvouga/mockingbird-service-meta/server` exports
`createServer`, `serveTarget`, `DEFAULT_PORT`, and server option/result types.

## Deliberately not modelled

- Real ad delivery, attribution calculation, hashing of plaintext PII, app-secret proof, or OAuth.
- Campaign/ad-set/ad mutation, creatives, audiences, pixels configuration, dashboards, or billing.
- The complete Insights fields/breakdowns matrix and asynchronous report jobs.
- Meta-side probabilistic matching: the emulator records only the supplied synthetic hashed fields.
