# @crvouga/mockingbird-service-tavily

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP scripted Tavily search and extraction. No public URLs are fetched. Contract references:
[Search](https://docs.tavily.com/documentation/api-reference/endpoint/search),
[Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract) and the exact
[tavily-python 0.7.17](https://pypi.org/project/tavily-python/0.7.17/) AsyncTavilyClient source.

## Install

`bun add @crvouga/mockingbird-service-tavily`

## Usage

```ts
import { tavily } from "@tavily/core"
import { createServer } from "@crvouga/mockingbird-service-tavily/server"

// Test setup: script the results for one query.
const server = await createServer({
  searches: [{ query: "fixture", results: [
    { title: "Example", url: "https://example.test", content: "Synthetic", score: 0.9 },
  ] }],
})

// The Tavily SDK your application already uses. Only its base URL changes.
const client = tavily({ apiKey: "mock_tavily_key", apiBaseURL: server.url })
const { results } = await client.search("fixture")
console.log(results[0]?.title, results[0]?.url) // Example https://example.test

await server.close()
```

CLI: `mockingbird-tavily serve --port 12130`. Configure the SDK's base URL (`apiBaseURL` in
`@tavily/core`, `api_base_url` in tavily-python); neither SDK has a required global endpoint
environment variable. If your app reads TAVILY_API_KEY,
set it to emulate_tavily_key in local tests. HTTP authentication is Bearer, exactly as emitted by
AsyncTavilyClient 0.7.17, not a JSON api_key body field.

POST /search matches query fixtures, returns ranked hits in fixture order and respects max_results
(0–20, default 10). topic, search_depth and time_range are accepted; optional fixture match
fields select variants without running a ranking/date-filter model. More specific match objects win.
include_answer true/basic/advanced includes the scripted answer. Missing queries return empty results.
POST /extract accepts one URL or up to 20 URLs; successful content and per-URL errors remain separate.
Unscripted URLs receive a synthetic retrieval failure, never a network request.

## Controls

Options searches, extractions and apiKeys seed SQLite collections with exported SearchScript,
Extraction and ApiKey records. Alternatively POST /__admin/state/searches with {id, value};
extraction records match their value.url (use any simple id); apiKeys ids must equal the synthetic key.
Default key: mock_tavily_key. Key status quota yields 429; plan_limit 432; payg_limit 433.
Invalid/missing keys return 401 with detail.error. No real credentials belong in fixture state.
Search results may include scripted answer and response_time (numeric seconds, default zero).

The standard /__admin provides state, reset, Timeline, clock, journal, metrics, health and UI.
Namespaces: x-mockingbird-namespace, /__admin/ns/name and Bearer credential mapping through
PUT /__admin/credentials. Journals contain metadata only, not query text, content or credentials.
No webhooks are emitted. Presets: invalid_key, quota_exceeded, plan_limit, payg_limit,
internal_error, timeout (one-second latency), connection_drop. Generic faults also support
deterministic latency. The clock is available for consumer workflows; no quota scheduler is simulated.

## Verification

`bun test` runs acceptance, independent OpenAPI self-parity and divergence detection.
`bun scripts/sdk.ts` runs exact tavily-python 0.7.17 using uv against the served emulator:
AsyncTavilyClient search/extract, InvalidAPIKeyError, UsageLimitExceededError, ForbiddenError and TimeoutError.
No real API key or crawl is used. `bun run parity` requires TAVILY_API_KEY and sends only an invalid
missing-query request to compare validation status, never a search or extraction. Missing credentials
exit 2. SDK tests are compatibility evidence, not live vendor search-result parity.

## Deliberately not modelled

Real web crawling/search/ranking, generated answers, billing or quota accounting, image retrieval,
date-window filtering beyond explicit scripted selectors, automatic parameters, advanced extraction
formatting, crawl/map/research endpoints and precise vendor validation error prose. Empty fixture
queries and unseeded URL failures are local test controls, not predictions of live search results.
Extraction ordering follows input order; Tavily does not guarantee it. The response_time number
follows the published field type; documentation example strings are not a guarantee of wire type.

## API

Main runtime exports: TavilyAPI, TAVILY_NAMESPACE, createRuntime, TAVILY_PRESETS, document,
operationIds, supportedOperationIds.
Types: SearchHit, SearchScript, Extraction, ApiKey, TavilyAPIOptions, TavilyRuntimeOptions, TavilyRuntime.
Server entry: createServer, DEFAULT_PORT, serveTarget; type TavilyServerOptions.
CLI entry runs serve and exports no runtime values.
