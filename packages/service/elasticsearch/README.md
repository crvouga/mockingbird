# @crvouga/mockingbird-service-elasticsearch

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Transport scaffold for Amazon Elasticsearch Service. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-elasticsearch/server"

// Test setup: start the emulator.
const server = await createServer()

// Application code: the request `ListDomainNames` sends, against the emulator's base URL.
// No operation is implemented yet, so every request is rejected.
const response = await fetch(`${server.url}/2015-01-01/domain`)
console.log(response.status, await response.text()) // 400 <ErrorResponse>...UnknownOperationException...

await server.close()
```

The scaffold answers with an XML error body, which `@aws-sdk/client-elasticsearch-service` (a
REST-JSON client) cannot parse, so this example uses plain `fetch` until operations are implemented.

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

**Planned, not implemented**, AWS operations: `CreateElasticsearchDomain`, `DescribeElasticsearchDomain`, `DescribeElasticsearchDomains`, `ListDomainNames`, `DeleteElasticsearchDomain`, `UpdateElasticsearchDomainConfig`, `DescribeElasticsearchDomainConfig`, `AddTags`, `RemoveTags`, `ListTags`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Implementation status

No vendor operations are implemented. Requests fail explicitly with `UnknownOperationException`; transport tests cover this boundary and malformed input. This package is not a usable vendor replacement yet. No LocalStack or live AWS parity is claimed.

## Install

```sh
bun add @crvouga/mockingbird-service-elasticsearch
```

## API

- `ElasticsearchAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
