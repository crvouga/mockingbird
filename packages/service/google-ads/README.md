# @crvouga/mockingbird-service-google-ads

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A **wip** portable emulator for Google Ads API v25 and Google Analytics 4. It provides deterministic
GAQL reporting, campaign-budget mutations, click-conversion uploads, Measurement Protocol event
collection, and Analytics Data reports using namespaced SQLite state and an injected clock.

## Install

```sh
bun add @crvouga/mockingbird-service-google-ads
```

## Usage

```ts
import { OAuth2Client } from "google-auth-library"
import { DEFAULT_CUSTOMER, DEFAULT_TOKEN } from "@crvouga/mockingbird-service-google-ads"
import { createServer } from "@crvouga/mockingbird-service-google-ads/server"

const emulator = await createServer()

// Google publishes no Node client for the Ads API, so the application calls REST through
// google-auth-library. Only the base URL and the fixture token change.
const client = new OAuth2Client()
client.setCredentials({ access_token: DEFAULT_TOKEN })
const response = await client.request({
  url: `${emulator.url}/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`,
  method: "POST",
  data: { query: "SELECT campaign.id, campaign.name, metrics.clicks FROM campaign" },
})
console.log(response.data)

await emulator.close()
```

The Ads and Analytics Data routes use OAuth Bearer credentials. Measurement Protocol routes use
the `measurement_id` and `api_secret` query parameters. The exported defaults are synthetic and
safe for tests. Configure `tokens`, customers, campaigns, budgets, conversion actions, metrics,
and Analytics properties through `createRuntime` options when a suite needs different fixtures.

For parallel tests, send `x-mockingbird-namespace`, use the shared `/__admin/ns/{namespace}` path,
or register credentials with the shared admin API. State, pagination snapshots, IDs, clocks,
faults, and resets are isolated by namespace.

## Supported operations

| Operation | Route | Behavior |
| --- | --- | --- |
| SearchGoogleAds | `POST /v25/customers/{customerId}/googleAds:search` | GAQL selection, filtering, ordering, aggregation, summary rows, fixed 10,000-row pages, two-hour page tokens bound to the query, and validate-only requests |
| SearchStreamGoogleAds | `POST /v25/customers/{customerId}/googleAds:searchStream` | Deterministic JSON batches and optional summary rows |
| MutateCampaignBudgets | `POST /v25/customers/{customerId}/campaignBudgets:mutate` | Create, update, remove, update masks, validate-only and atomic or partial failure |
| UploadClickConversions | `POST /v25/customers/{customerId}:uploadClickConversions` | Click identifiers, conversion actions, duplicate detection, job IDs and partial failure |
| CollectAnalyticsEvents | `POST /mp/collect` | Production-style empty 204 response with accepted events stored for reporting |
| ValidateAnalyticsEvents | `POST /debug/mp/collect` | Validation messages without ingestion |
| RunAnalyticsReport | `POST /v1beta/properties/{propertyId}:runReport` | Dimensions, metrics, filters, ordering, pagination and reporting lag |
| BatchRunAnalyticsReports | `POST /v1beta/properties/{propertyId}:batchRunReports` | Up to five report requests |

The exact request and response schemas are in [`openapi.yaml`](openapi.yaml), and the generated
support matrix is in [`SUPPORT.md`](SUPPORT.md).

Campaign budgets are read back with GAQL (`FROM campaign_budget`); uploaded conversions and
collected events are read through the inspection routes below, and events also through the
Analytics Data reports. REST rows use protobuf JSON names (`costMicros`, `conversionsValue`,
`conversionActionCategory`) and int64 values are strings; GAQL field names stay snake_case.

Google Ads failures are a `google.rpc.Status` whose `details` hold a `GoogleAdsFailure` with the
per-operation `errorCode`, `message`, `location` and a `requestId` equal to the `request-id`
response header. Unparsable JSON and every Analytics Data failure are a bare status with no Ads
detail and no `request-id` header.

## Where Google differs from a common assumption

These follow Google's documentation and the pinned `googleapis` v25 protos rather than what a
client written against an older contract may expect.

- **Search page size is fixed.** `Search` returns pages of up to 10,000 rows and a request that
  sets `pageSize` is rejected with `requestError: PAGE_SIZE_NOT_SUPPORTED`. Continue by re-sending
  the identical query with `pageToken`; a changed query is `INVALID_PAGE_TOKEN` and a token unused
  for two hours is `EXPIRED_PAGE_TOKEN`
  ([paging guide](https://developers.google.com/google-ads/api/docs/reporting/paging),
  [`SearchGoogleAdsRequest`](https://github.com/googleapis/googleapis/blob/03a91044136a014466d4293eb1fe91f2b02075d2/google/ads/googleads/v25/services/google_ads_service.proto)).
  To page a small fixture, lower the emulator's page with the `searchPageSize` setting; the
  request still cannot choose it.
- **`/mp/collect` never reports validation errors over HTTP.** It answers an empty `204` for a
  bad secret, an unparsable body or a rejected event alike. Inspect a rejection with
  `POST /debug/mp/collect`, which returns `validationMessages` and stores nothing, or with
  `GET /__admin/request-metadata`, which records `accepted`, `rejected`, `duplicate` and `reasons`
  per request
  ([validation guide](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events)).
- **Timestamps older than 72 hours are overridden, not rejected,** unless the request sets
  `validation_behavior: "ENFORCE_RECOMMENDATIONS"`
  ([sending guide](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events?client_type=gtag)).
  Google documents no bound for future timestamps, so the one-minute `futureToleranceMs` default
  is a test policy of this emulator, not a vendor rule; set it to `null` to disable it.
- **A validate-only budget mutation returns errors only.** A valid preflight answers `{}` with no
  `results` and writes nothing
  ([`MutateCampaignBudgetsRequest`](https://github.com/googleapis/googleapis/blob/03a91044136a014466d4293eb1fe91f2b02075d2/google/ads/googleads/v25/services/campaign_budget_service.proto)).
- **Mutations take no idempotency key.** The duplicate guards are Google's own: a shared budget
  name (`campaignBudgetError: DUPLICATE_NAME`), a conversion `orderId`
  (`ORDER_ID_ALREADY_IN_USE`), a click and conversion time (`CLICK_CONVERSION_ALREADY_EXISTS`),
  and a web `purchase` event's `transaction_id` per user.
- **`developer-token` is accepted and ignored.** The pinned protos mark the developer-token
  errors as sunset; `login-customer-id` is still checked against the customer's manager.

## Controls and failures

Service-specific controls are protected by the shared `x-mockingbird-admin-key` guard and live
beside the shared health, state, clock, journal, fault, reset, and Timeline endpoints.

| Control | Purpose |
| --- | --- |
| `GET /__admin/events` | Inspect stored Analytics events, oldest first |
| `GET /__admin/conversions` | Inspect uploaded conversions, oldest first |
| `GET /__admin/budgets` | Inspect campaign budgets |
| `GET /__admin/budget-mutations` | Inspect the mutation audit trail: request ID, `before` and `after` per write |
| `GET /__admin/request-metadata` | Inspect redacted request metadata |
| `POST /__admin/daily-metrics` | Seed synthetic daily Ads metrics (`availableAt` delays one row) |
| `POST /__admin/page-tokens/expire` | Expire all current GAQL page tokens |
| `GET /__admin/settings` | Read `reportingLagMs`, `pageTokenTtlMs`, `futureToleranceMs` and `searchPageSize` |
| `PUT /__admin/settings` | Update those deterministic test settings |

| To | Use |
| --- | --- |
| Advance the reporting date | `POST /__admin/clock {"advance": "1d"}` or `{"set": "<ISO-8601>"}`; GAQL `DURING` ranges and Analytics `today`/`yesterday`/`NdaysAgo` follow it |
| Delay reporting | `PUT /__admin/settings {"reportingLagMs": n}` hides new events until the clock passes it |
| Page a small fixture | `PUT /__admin/settings {"searchPageSize": n}` (1 to 10,000) |
| Add latency | the `slow_response` preset, or `POST /__admin/faults {"latencyMs": n, "count": 1}` |
| Fail one request | the `server_error` or `network_reset` preset |
| Throttle | the `quota_exhausted` or `rate_limited` preset; `"count": n` throttles n requests |
| See what arrived | `GET /__admin/requests` (the journal) and `GET /__admin/request-metadata` |

Fault presets are `quota_exhausted`, `rate_limited`, `server_error`, `network_reset`,
`slow_response`, `ambiguous_budget_write`, `partial_budget_failure`, and
`partial_conversion_failure`. Each fires once unless `count` says otherwise, and is scoped to the
calling namespace. The two throttling presets answer `429 RESOURCE_EXHAUSTED` with
`quotaError: RESOURCE_EXHAUSTED` or `RESOURCE_TEMPORARILY_EXHAUSTED` and the backoff in
`details.quotaErrorDetails.retryDelay`, before anything is written.

`ambiguous_budget_write` commits the next executed budget mutation and then returns `503`, so
retry logic can be tested against an uncertain outcome. A validate-only preflight executes
nothing and does not spend it: the fault waits for the real call that follows. Reconcile before
replaying: the `503` carries a `request-id` header, and `GET /__admin/budget-mutations` lists the
write under that request ID with the budget's `before` and `after`.

Sensitive event and conversion payloads are sealed in state; journals and inspection metadata
contain only the fields needed for assertions.

## API

The portable root exports `GoogleAdsAPI`, `createRuntime`, `document`, `supportedOperationIds`,
`GOOGLE_ADS_NAMESPACE`, `GOOGLE_ADS_PRESETS`, `DEFAULT_ADMIN_KEY`, `DEFAULT_TOKEN`,
`DEFAULT_CUSTOMER`, `DEFAULT_CUSTOMERS`, `DEFAULT_BUDGETS`, `DEFAULT_CAMPAIGNS`, `DEFAULT_ACTIONS`,
`DEFAULT_PROPERTY`, `DEFAULT_MEASUREMENT`, `DEFAULT_API_SECRET`, `createVaultKey`, `fingerprint`,
and the public fixture/runtime option types. The Node `./server` entry exports `createServer`,
`DEFAULT_PORT`, and server types. `mockingbird-google-ads serve` starts a listener.

## Verification and scope

Acceptance tests cover GAQL precision and paging, budget preflight and partial writes, conversion
deduplication, GA4 event validation and reporting, OAuth scope/expiry behavior, encrypted state,
namespaces, resets, fault recovery, and the unmodified `google-auth-library` 11.1.0 HTTP signing
path. Runtime tests drive every control above over `/__admin`. Property tests exercise every
parity-enabled operation and prove that a divergent transport is detected deterministically.

`test/consumer.ts` is a port of the raw-fetch traffic described in the original service request.
It is not the requesting application's client, whose source is not in this repository, so no test
here runs that client unmodified.

## Deliberately not modelled

The emulator implements a bounded subset. It does not model the complete Google Ads resource
graph, every GAQL function, GAQL field-compatibility rules between segments and metrics, every
Analytics dimension or metric, real Google identity, production quota allocation, billing,
dashboards, attribution processing, or undocumented backend behavior. Uploaded conversions do not
feed `metrics.conversions`; seed those with daily metrics. Normal operation is local and does not
contact Google; only the explicit parity command uses credentials supplied through `.env.local`
or GitHub Actions secrets.
