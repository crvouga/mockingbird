# @crvouga/mockingbird-service-support

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Transport scaffold for Amazon Support API. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { DescribeServicesCommand, SupportClient } from "@aws-sdk/client-support"
import { createServer } from "@crvouga/mockingbird-service-support/server"

// Test setup: start the emulator and point the SDK's endpoint at it.
const server = await createServer()
const support = new SupportClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the Support SDK calls it already makes.
// No operation is implemented yet, so every call rejects.
try {
  await support.send(new DescribeServicesCommand({}))
} catch (error) {
  console.log((error as Error).name) // UnknownOperationException
}

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

**Planned, not implemented**, AWS operations: `DescribeServices`, `DescribeSeverityLevels`, `CreateCase`, `DescribeCases`, `ResolveCase`, `AddCommunicationToCase`, `DescribeCommunications`, `AddAttachmentsToSet`, `DescribeTrustedAdvisorChecks`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Implementation status

No vendor operations are implemented. Requests fail explicitly with `UnknownOperationException`; transport tests cover this boundary and malformed input. This package is not a usable vendor replacement yet. No LocalStack or live AWS parity is claimed.

## Install

```sh
bun add @crvouga/mockingbird-service-support
```

## API

- `SupportAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
