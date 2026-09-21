# @crvouga/mockingbird-service-posthog

Stateful mock of **PostHog** for test suites: remote feature-flag evaluation (`/flags` v2 and
the legacy `/decide` shape), remote config, event capture (`/batch/`, `/e/`, `/i/v0/e/`),
session-recording intake, the posthog-js asset and survey endpoints, and the slice of the
management API our tooling and crons call (feature-flag list/create/patch, HogQL). Every flag
is set per test through admin routes, so paths our in-app overrides cannot reach (strict
booleans, `getConfig` payloads, EMR server gates, member-app variants) become controllable, and
a stack run never reaches `us.i.posthog.com`.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/posthog/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from the wire shapes of posthog-node 5.52.2,
  `@posthog/core` 1.54.0 (posthog-react-native 4.72.1's base) and posthog-js 1.433.2, and from
  our own raw fetches. All three SDKs are proven against it (`posthog.sdk.test.ts`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-posthog
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-posthog serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Point the app's PostHog host at the mock (port 8795 by default):

| App | Variables |
| --- | --- |
| backend (flags, capture, website purchase sink) | `POSTHOG_HOST`, `POSTHOG_API_KEY` |
| EMR backend | `POSTHOG_HOST`, `POSTHOG_API_KEY` |
| EMR frontend (browser posthog-js and the server raw fetch) | `NEXT_PUBLIC_POSTHOG_HOST`, `NEXT_PUBLIC_POSTHOG_KEY` |
| member app | `public-config.json[stage]` host, or `?POSTHOG_HOST=&POSTHOG_API_KEY=` on web (G-P1) |
| makor supplement-management | `POSTHOG_HOST` |

```bash
npx mockingbird-posthog serve --port 8795 --import-flags dev
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-posthog"

const posthog = createRuntime()
const admin = (path: string, body: unknown, method = "PUT") =>
  posthog.fetch(
    new Request(`http://posthog.test/__admin${path}`, { method, body: JSON.stringify(body) }),
  )

// Per-worker namespaces: map each worker's project token (the SDKs cannot add headers)…
await admin("/credentials", { credentials: { phc_worker1: "w1" } })
// …then set flags in that namespace.
await admin("/flags/shop-coupons?namespace=w1", { default: true })
await admin("/flags/rx-category-intake?namespace=w1", {
  default: true,
  payload: { categories: ["trt"] },
  overrides: [{ distinct_id: "42", value: false }, { email: "qa@example.test", value: "beta" }],
})
await admin("/flags/mobile-smart-links?namespace=w1", undefined, "DELETE") // absent again

// The app's posthog-node `getFeatureFlag("shop-coupons", "7")` now answers true.
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /flags/?v=2` (`&config=true`) | posthog-node, posthog-react-native, posthog-js. Body `{token, distinct_id, person_properties?, groups?, flag_keys_to_evaluate?, …}`. Answers `{flags: {<key>: {key, enabled, variant, reason, metadata: {id, version, description, payload?}}}, errorsWhileComputingFlags, requestId, evaluatedAt}`; `payload` is the JSON **string** and only accompanies an enabled flag. `config=true` adds the remote-config fields. |
| `POST /flags?v=2` | Same route without the trailing slash: the EMR frontend's raw fetch, body `{api_key, distinct_id, person_properties?}`. |
| `POST /flags/` (no `v`, or `v=1`), `POST /decide/?v=3` | The legacy shape `{featureFlags: {k: bool \| variant}, featureFlagPayloads: {k: "<json>"}, errorsWhileComputingFlags, config, …}` (makor). `/decide/?v=4` answers the v2 shape. |
| `GET /array/{token}/config`, `…/config.js` | Remote config: `{supportedCompression: ["gzip","gzip-js"], hasFeatureFlags: true, analytics: {endpoint: "/i/v0/e/"}, sessionRecording: false \| {endpoint: "/s/"}, surveys: false, …}`; the `.js` form sets `window._POSTHOG_REMOTE_CONFIG[token]`. `hasFeatureFlags` is always true (false makes posthog-react-native skip flag loading). |
| `POST /batch/` | `{api_key, batch: [{event, distinct_id, properties, timestamp, uuid}], sent_at}`, usually `Content-Encoding: gzip`. |
| `POST /e/`, `POST /i/v0/e/` | One event, an array of events, or `{api_key, batch}`; bodies may be raw gzip (`gzip-js`), base64 `data=` forms (`compression=base64`), or JSON. Events with a known `uuid` are deduplicated. |
| `POST /s/` | Session recordings: counted (`GET /__admin/recordings`), never stored. |
| `GET /static/recorder.js`, `/static/{ver}/recorder.js` | An inert script. |
| `GET /api/surveys/?token=`, `/api/web_experiments/?token=` | `{surveys: []}`, `{experiments: []}`. |
| `GET/POST /api/projects/{id}/feature_flags/`, `PATCH …/{flagId}/` | Bearer personal key required. List pages `{count, next, previous, results}` (`limit`/`offset`, what feature-flags-cli follows); flags carry `filters.groups` / `multivariate` / `payloads` derived from the flag model, and create/patch parse `filters` back (see below). `flagId` is the numeric id or the key. |
| `POST /api/projects/{id}/query/` | HogQL `{query: {kind: "HogQLQuery", query}}` → `{results, columns}` from canned answers (`PUT /__admin/settings {"queryResults": […]}`), `{results: []}` otherwise. |

Every route answers with and without its trailing slash. Errors use PostHog's
`{type, code, detail, attr}` body: 401 `invalid_api_key` without a project token, 400
`missing_distinct_id`, 400 `invalid_payload` for an undecodable body, 404 `not_found`.

### Flag semantics

- **Absent vs `false`.** A flag whose `default` is omitted (or `null`) is not returned at all
  unless an override matches; `default: false` returns `enabled: false`. The member app's
  `hasFlag` falls through to static defaults only for the absent case. Inactive or deleted
  flags are never returned (as in PostHog).
- **Targeting:** overrides in order, by exact `distinct_id` or by `person_properties.email`
  (case-insensitive), then the default.
- **Variants:** a string value is a variant (`enabled: true, variant: "<key>"`); our backend,
  EMR and makor clients all read it as `true`.
- **Payloads:** any JSON; stored and sent as the JSON string PostHog uses. The backend's
  `getConfig` only accepts object payloads.
- **Management `filters` → model:** `distinct_id` / `email` property groups become overrides;
  a property-less group at 100 % is the default (its `variant`, else the largest multivariate
  variant, else `true`); at 0 % or a partial rollout it is `false`; cohort and other property
  groups are ignored (deterministic, no hashing).

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `PUT /__admin/flags/:key` | `{default?: bool \| "variant" \| null, payload?: any, overrides?: [{distinct_id? \| email?, value?, payload?}], active?, name?}`. Omitting `default` makes the flag absent for everyone no override names. Bumps `metadata.version`. |
| `DELETE /__admin/flags/:key` | Remove the flag (absent). |
| `PUT /__admin/flags` | Bulk: `{flags: {<key>: spec}, replace?: true}` or `[{key, …spec}]`. |
| `GET /__admin/flags`, `GET /__admin/flags/:key` | The namespace's flags. |
| `GET /__admin/flags/evaluate?distinct_id=&email=` | What `/flags` answers for that subject, as `{flags: {key: value}}`. |
| `POST /__admin/flags/import` | `{from: "state.json", env: "dev" \| "prod", project?: "member-app" \| "emr", replace?}` seeds from the bundled copy of geviti `docs/feature-flags/state.json` (or pass `state: {flags: […]}` inline). `live` → `true` (or the largest variant), `rollout 0` / `targeted` / `ramping` → `false`, `inactive` / `missing` → absent. |
| `POST /__admin/flags/bump` | Changes nothing server-side; returns a `generation` counter. The documented moment to clear the app's flag caches (backend `getAllFlagsAndPayloads` 60 s per user; EMR frontend server 60 s / 10 s). |
| `GET /__admin/events?distinct_id=&event=&since=` | Captured events, oldest first (`since`: epoch ms or ISO, mock clock). `$exception` keeps only `$lib`, `$lib_version`, `$exception_level`, `$session_id`; properties named like message/body/text/content/prompt/stack/trace/html/comment/note are dropped from every event (and from `$set`). |
| `GET /__admin/recordings` | `{count}` of `/s/` posts. |
| `GET/PUT /__admin/settings` | `{sessionRecording?: bool, queryResults?: [{match?, columns?, results}]}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`),
each on `/flags` and `/decide`: `flags_5xx`, `flags_429` (`retry-after: 1`), `flags_hang`
(1.5 s, past the backend strict and EMR 1 s races), `errors_while_computing`
(`errorsWhileComputingFlags: true`, flags still present), `quota_limited`
(`quotaLimited: ["feature_flags"]`, no flags). Plus `capture_5xx` on the capture endpoints.
Each preset adds one rule per route, so `count` applies per route.

### Namespaces

PostHog SDKs cannot add headers. Choose a namespace by:

- **host prefix** (primary): `POSTHOG_HOST=http://127.0.0.1:8795/ns/w1`. Every SDK builds
  `${host}/path`, so `/ns/w1/flags/?v=2` selects `w1`.
- **project token**: `PUT /__admin/credentials {"credentials": {"phc_…": "w1"}}`. The token is
  read from `/array/{token}/…`, `?token=`, the body (`token`, `api_key`, or a batch's first
  event's `properties.token`, after decoding gzip/base64), or a personal key's
  `Authorization: Bearer` on the management API.
- `x-mockingbird-namespace`, for raw clients.

The management API's `next` page URL is built from the request without the `/ns/` prefix; page
through it with a credential-mapped personal key instead.

### Deliberately not modelled

- Percentage rollouts, cohorts, group (organisation) targeting and local evaluation
  (`/api/feature_flag/local_evaluation`): flags evaluate deterministically from explicit
  overrides and a default.
- Session-recording content, heatmaps, surveys and web experiments (the endpoints answer empty).
- HogQL execution: queries answer canned results.
- Person profiles: `$identify` / `$set` events are stored for assertions but do not feed
  targeting; send `person_properties` on `/flags` as the SDKs do.
- Project isolation by project id on the management API: one flag set per namespace.
- Real remote-config fields beyond what the SDKs read.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PostHogAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `evaluate(subject, keys?)`, `events(query?)`, `flagList()`, `state`. Options: `sqlite`, `now`, `namespace`, `flags`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces by prefix/token/header, presets, journal). Options: `flags`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `POSTHOG_PRESETS` | object | Every named fault preset. |
| `POSTHOG_NAMESPACE` | string | The service name, `"posthog"`. |
| `evaluateFlag` | function | Evaluate one flag record for `{distinct_id, person_properties}` (`undefined` = absent). |
| `parseFlagSpec` | function | Validate an admin flag body into a `FlagSpec`. |
| `payloadString` | function | A payload as PostHog stores it (JSON string, or `null`). |
| `specsFromState`, `valueForState` | functions | Map a `state.json` file (or one flag state) to flag specs. |
| `GEVITI_FLAG_STATE` | object | The bundled, trimmed copy of geviti `docs/feature-flags/state.json`. |
| `decodePostHogBody`, `tokenFromBody` | functions | Undo PostHog body envelopes (gzip, gzip-js, base64 `data=`); find the project token in a body. |
| `scrubProperties` | function | The event-property scrubbing applied before storage. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--import-flags dev\|prod`, `--session-recording`); port 8795. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
