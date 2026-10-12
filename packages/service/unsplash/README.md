# @crvouga/mockingbird-service-unsplash

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Unsplash v1 photo search with deterministic results and synthetic local image bytes.

## Install

```sh
bun add @crvouga/mockingbird-service-unsplash
```

## Usage

```ts
import { createApi } from "unsplash-js"
import { createServer } from "@crvouga/mockingbird-service-unsplash/server"

const server = await createServer()

// The Unsplash SDK your application already uses. Only its base URL changes.
const unsplash = createApi({ accessKey: "mock_unsplash_key", baseUrl: server.url })
const { data } = await unsplash.GET("/search/photos", {
  params: { query: { query: "mock", orientation: "landscape", per_page: 9, page: 1 } },
})
const image = await fetch(data?.results[0]?.urls.regular ?? "") // synthetic local image bytes

await server.close()
```

For a separate application process, run `mockingbird-unsplash serve --port 12125`.
Set the SDK's `baseUrl` (or a raw-fetch client's search origin) to `http://localhost:12125`;
no standard vendor base-URL environment variable exists. Accepts `client_id=mock_unsplash_key`
or `Authorization: Client-ID mock_unsplash_key`. Configure other synthetic keys with
`accessKeys`.

### Routes and fixtures

- `GET /search/photos`: exact case-insensitive matching against each fixture's `queries`.
  Filters orientation, returns `total`, `total_pages`, `results`, Link/X-Total/X-Per-Page
  headers, and stable insertion-order pages. Defaults: page 1, 10 per page; maximum 30.
  Unknown queries produce empty pages. Null alt text and missing/null author last names
  are preserved; attribution links come from fixtures.
- `GET /photos/{id}/download`: returns `{url}` pointing at the local image and increments
  namespace-scoped download inspection state. No real analytics event is sent.
- `GET /__admin/blobs/{id}`: returns fixture bytes with the configured image content type.
  This is a local transport stand-in, not an Unsplash vendor endpoint.

Pass `photos: PhotoFixture[]` to seed query matches, attribution, orientation and
`imageBase64`/`contentType`. The default is one synthetic PNG for query `mock`, not a real
photograph. Use only synthetic or owned bytes. URLs preserve the selected namespace and
custom `adminPrefix`, so a browser can load them without copying the request's credentials.

### Controls

The shared `/__admin/state/photos` and `/__admin/state/downloads` routes inspect/seed state.
Reset restores constructor fixtures and clears download counts. Timeline, clock,
request journal, latency and one-shot fault rules use the shared admin contract.
Namespaces are selected by `x-mockingbird-namespace`, `/__admin/ns/{name}`, or mapped
access keys via `PUT /__admin/credentials`. Query credentials are not put into the journal
or pagination links; when following links, reapply authentication.

Presets: `unauthorized` (401), `rate_limited` (scripted 403 quota error),
`server_error` (503), `connection_drop`. These are deterministic failure controls;
quota accounting is not live. Generic faults can also script 429 and latency.
There are no webhooks.

Acceptance tests cover all three requested behaviors, local bytes over HTTP, custom
prefix/namespace image URLs, reset, faults and credential redaction. Property tests cover
both parity-enabled JSON operations and detect divergence. `bun scripts/parity.ts` needs
`UNSPLASH_ACCESS_KEY` and probes an empty metadata search only, without downloading images.
Live-account parity has not been run.

### Deliberately not modelled

Real search/indexing/ranking, arbitrary partial-text matching, production photo content,
image resizing, additional search filters, user OAuth, editing/collections and actual
quota accounting. Rate-limit headers on successful responses are fixed fixture values.
Only the response fields consumed in issue #281 are modelled; this is not a full photo object.

## API

- `UnsplashAPI`: FetchAPI with `fetch`, `reset`, `photos` and `downloads` collections.
- `createRuntime`: shared admin, namespace, clock, fault and journal runtime.
- `UNSPLASH_NAMESPACE`: service name.
- `UNSPLASH_PRESETS`: deterministic named fault controls.
- `DEFAULT_PHOTOS`: synthetic initial fixture.
- `accessKey`: reads Client-ID header or client_id query credentials.
- `document`, `operationIds`, `supportedOperationIds`: generated contract metadata.
- `createServer`, `serveTarget`, `DEFAULT_PORT` from `./server`: Node server/CLI target
  (default port 12125).

Public types: `PhotoFixture`, `UnsplashAPIOptions`, `OperationId`, `SupportedOperationId`.
