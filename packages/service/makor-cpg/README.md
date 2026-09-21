# @crvouga/mockingbird-service-makor-cpg

Stateful mock of the **legacy Makor AI API ("CPG")** for test suites. It covers:

- care-plan details and the plus-user toggle (Intercom sync, user-actions queue);
- the bloodwork-results webhook (ODX);
- subscription and Wholescripts order reads;
- AI patient summaries and async-review scripts, which the EMR frontend calls straight from the
  browser.

Generation answers at once and deterministically. Review scripts move from `processing` to
`complete` on the mock clock, so the EMR panels and the backend jobs run with no Railway staging
server and no 30–50 s LLM wait.

This is **not** the in-repo makor-ecosystem gateway (`MAKOR_GATEWAY_URL`). That gateway is out
of scope; see "Deliberately not modelled".

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/makor-cpg/SUPPORT.md)
- The vendor publishes no spec. The contract (`openapi.yaml`) is hand-authored from our
  consumers' wire shapes: `makor-ai.types.ts` and the EMR `async-review-script.types.ts` /
  `user-summary.service.ts`.

## Install

```bash
npm install -D @crvouga/mockingbird-service-makor-cpg
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-makor-cpg serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

```bash
npx mockingbird-makor-cpg serve --port 8806 --processing-ms 2000
```

| Consumer | Setting |
| --- | --- |
| Backend `MakorAiClientService` | `MAKOR_AI_API_URL=http://127.0.0.1:8806`, `MAKOR_AI_API_KEY=<any>`. Seam **G-K1**: `validation.schema.ts` accepts https only today, so loopback http must be allowed. |
| EMR frontend (`cpg-api.ts`) | `NEXT_PUBLIC_MAKOR_API_URL=http://127.0.0.1:8806`, `NEXT_PUBLIC_MAKOR_API_KEY=<any>`. The browser sends the key. |

```ts
import { createRuntime } from "@crvouga/mockingbird-service-makor-cpg"

const cpg = createRuntime({ settings: { processingMs: 45_000 } })
const admin = (method: string, path: string, body?: unknown) =>
  cpg.fetch(
    new Request(`http://makor.test/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

// Member 1652 has an approved plan (the Intercom sync reads it); nobody else does (404, normal).
await admin("PUT", "/care-plans/1652", { status: "Approved", state: "CA" })
// …the EMR generates a review script: it answers `processing` at once…
cpg.clock.advance(45_000)
// …and the next GET /api/async-review-script/1652/<labTestId> answers `complete`.
```

### Routes

Every route needs `x-api-key`. Any non-empty key is accepted unless `apiKeys` is set. Errors are
`{error, message, statusCode}`.

| Route | Behaviour |
| --- | --- |
| `GET /api/care-plans/current-care-plan-details/{userId}` | `{carePlanId, status, pricing{…7 fields}, state}` for a seeded plan. With no plan it answers 404 `{error: "Not Found", message: "No active or approved care plan found for this user"}`. The backend treats that exact message as an expected absence and logs it at warn level. |
| `PATCH /api/care-plans/plus-user/{userId}` | `{plusUser: boolean}` → `{success: true, message}`, or the same 404 when there is no plan. |
| `POST /api/bloodwork/webhook` | `{userId, labResultsId}` → **202** `{message: "Webhook received"}`. The ids are recorded (`GET /__admin/bloodwork`). |
| `GET /api/subscription/status/{userId}` | `{success: true, data: <subscription row>}` while a seeded subscription is active, else `{success: true, data: {hasActiveSubscription: false, message}}`. |
| `POST /api/subscription/cancel/{userId}` | `{success: true, data: {subscription_id, status: "canceled", message}}`. Already cancelled gives `data.alreadyCancelled: true`; none gives `data.success: false`. |
| `GET /api/wholescripts-orders/user/{userId}?page=&count=` | `{data, page, count, total, totalPages}` over seeded orders. Defaults are page 1 and count 10. |
| `POST /api/v2/generate-user-summary` | `{user_id, intake_forms?, free_text_entries?, llm_model?}` → `{user_id, summary{general_summary, past_visits, intake_summary}, biomarker_analysis}`, stored as the user's most recent summary. It answers **at once**; the real server takes 30–50 s (see `slow_generation`). The content comes from a fixture, or is a deterministic placeholder that never echoes the input. |
| `GET /api/v2/user-summary/{cpgUserId}` | `{cpgUserId, summary, isMostRecent: true, createdAt}`, or 404 when there is no summary (normal). |
| `GET /api/async-review-script/{userId}/{labTestId}` | `{review: {id, labTestId, reviewType, status, scriptContent, errorMessage, metadata, isMostRecent, createdAt, updatedAt}}` for the most recent review of that lab test, or 404 when there is none (normal). |
| `POST /api/async-review-script/generate` | `{userId, labTestId, intakeForm?, chartingNotes?, demographics?}` → `{message, reviewId, status, reviewType, scriptContent}`. It answers **at once**. With `processingMs` 0 (the default) the status is `complete` and the content is included. Otherwise it is `processing` with `scriptContent: null`, and it becomes `complete` once `processingMs` has passed on the mock clock. `reviewType` is `comparative` when the user already has a review for another lab test. |
| `POST /api/async-review-script/regenerate/{userId}/{labTestId}` | The same, as a new version (keeping the type), or 404 when nothing was ever generated. |

Script content comes from the most specific fixture: user + lab test, then user, then lab test,
then `*`. Without a fixture it is a deterministic placeholder `ScriptContent`, with every
`labFindings` group, nutrition recommendations and fiber guidance filled in. Intake text,
charting notes and demographics are validated but never stored, echoed or journaled.

### CORS

The EMR frontend calls this API **straight from the browser**. `cpg-api.ts` sends `x-api-key`
and `Content-Type: application/json` from the page, so every call is preceded by a CORS
preflight. The mock:

- answers every `OPTIONS` request with **204**, unauthenticated, since browsers send no custom
  headers on a preflight;
- echoes `Origin` in `Access-Control-Allow-Origin`, or sends `*` when there is no `Origin`;
- allows `GET, POST, PUT, PATCH, DELETE, OPTIONS`;
- echoes `Access-Control-Request-Headers`, defaulting to
  `content-type, x-api-key, x-mockingbird-namespace, authorization`;
- exposes `x-mockingbird` and sets `Access-Control-Max-Age: 600`.

It stamps the same headers on **every** response: vendor, 401, fault presets, admin and health.
An injected 500 then reaches the page as a 500, not as a CORS "network error". This is
deliberately permissive, because the key is public in the browser bundle anyway.
`withCors(request, response)` and `CORS_HEADERS` are exported.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `PUT /__admin/care-plans/:userId` | Seed a plan with `{carePlanId?, status? (default Active), pricing? (merged over defaults), state? (default TX)}`. `GET` reads it (including `plusUser`); `DELETE` removes it. |
| `PUT /__admin/subscriptions/:userId` | Seed a subscription row. The given fields are merged over an active default. |
| `PUT /__admin/wholescripts-orders/:userId` | Seed orders: `[order, …]` or `{orders: [...]}`. |
| `GET /__admin/bloodwork` | The bloodwork webhooks received (ids only). |
| `PUT /__admin/fixtures/summary` | `{userId? (default *), summary, biomarker_analysis?}` sets what generation returns. |
| `PUT /__admin/fixtures/review-script` | `{userId? (*), labTestId? (*), scriptContent}` sets what review generation produces. |
| `POST /__admin/summaries` | Seed a stored summary: `{cpgUserId, summary?: {summary, biomarker_analysis}, createdAt?}`. |
| `POST /__admin/reviews` | Seed a stored review: `{userId, labTestId, status? (complete), scriptContent?, reviewType?, errorMessage?, readyInMs?}`. `GET /__admin/reviews?userId=` lists them. |
| `GET/PUT /__admin/settings` | `{apiKeys?: string[], processingMs?: number}` for the calling namespace. |
| `POST /__admin/tick` | Complete every review that is due now. Reads also settle due reviews lazily. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n, "latencyMs"?: ms}`):

| Preset | Effect |
| --- | --- |
| `slow_generation` | The three generation calls take 40 s: the real 30–50 s, which is at the edge of the EMR's 50 s summary timeout. |
| `generation_failed` | A summary answers 500. A review script answers 500 `{status: "failed", errorMessage}` and is stored as failed; the panel shows `errorMessage`. |
| `care_plan_invalid_shape` | A 200 with no `pricing`. The backend's schema check fails, and it logs an error and returns null. |
| `bloodwork_not_accepted` | The webhook answers 200 instead of 202. The backend warns and returns null. |
| `route_missing` | Every route answers 404 `Cannot GET …`. This is a wrong route, which the backend logs at error level, unlike the no-plan 404. |
| `unauthorized` | Every call answers 401. |
| `server_error` | Every call answers 500. |

### Namespaces

- the `x-mockingbird-namespace` header (the EMR's axios instance can add it);
- a `/ns/<name>` prefix on the base URL;
- the API key: `PUT /__admin/credentials {"credentials": {"<x-api-key>": "<namespace>"}}`.

The request journal records operation ids, statuses and the user, lab test and review ids. It
never records request bodies.

### Deliberately not modelled

- The makor-ecosystem gateway (`MAKOR_GATEWAY_URL`: `/v1/makor/*`, `/v1/care-team-chat/*`,
  `/v1/plans/*`). It is in-repo, not third-party, and a stub for it (an SSE replayer) is tracked
  separately.
- Real AI output. Summaries and scripts are fixtures or deterministic placeholders, and
  `biomarker_analysis` is passed through as given.
- The real server's internal polling. The 30–50 s latency is only a preset.
- Stripe side effects of subscription cancel. Only the stored row changes.
- Review history listing (`ReviewHistoryResponse`), which no live caller reaches.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `MakorCpgAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `tick()`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The mock with the full service contract plus CORS (health, admin, namespaces, credentials, presets). Options: `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `MAKOR_CPG_PRESETS` | object | Every named fault preset. |
| `MAKOR_CPG_NAMESPACE` | string | The service name, `"makor-cpg"`. |
| `NO_CARE_PLAN_MESSAGE` | string | The exact 404 message the backend treats as an expected absence. |
| `CORS_HEADERS`, `withCors` | values | The permissive CORS headers, and the helper that stamps them on a response. |
| `apiKeyCredential` | function | The `x-api-key` a request carries (how keys map to namespaces). |
| `defaultScriptContent` | function | The placeholder review script for a lab test. |
| `DEFAULT_SETTINGS` | object | `{apiKeys: [], processingMs: 0}`. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--api-key`, `--processing-ms`); port 8806. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
