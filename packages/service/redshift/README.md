# @crvouga/mockingbird-service-redshift

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Transport scaffold for Amazon Redshift. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { DescribeClustersCommand, RedshiftClient } from "@aws-sdk/client-redshift"
import { createServer } from "@crvouga/mockingbird-service-redshift/server"

// Test setup: the Redshift client your application already uses, pointed at the emulator.
const server = await createServer()
const redshift = new RedshiftClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// No Redshift operation is implemented yet, so every command rejects.
const failure = await redshift
  .send(new DescribeClustersCommand({}))
  .catch((error: Error) => error.name)
// "UnknownOperationException"

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

**Planned, not implemented**, AWS operations: `CreateCluster`, `DescribeClusters`, `ModifyCluster`, `DeleteCluster`, `PauseCluster`, `ResumeCluster`, `CreateClusterSnapshot`, `DescribeClusterSnapshots`, `DeleteClusterSnapshot`, `CreateTags`, `DeleteTags`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Implementation status

No vendor operations are implemented. Requests fail explicitly with `UnknownOperationException`; transport tests cover this boundary and malformed input. This package is not a usable vendor replacement yet. No LocalStack or live AWS parity is claimed.

## Install

```sh
bun add @crvouga/mockingbird-service-redshift
```

## API

- `RedshiftAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
