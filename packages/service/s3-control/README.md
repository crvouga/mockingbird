# @crvouga/mockingbird-service-s3-control

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Transport scaffold for Amazon S3 Control. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { ListAccessPointsCommand, S3ControlClient } from "@aws-sdk/client-s3-control"
import { createServer } from "@crvouga/mockingbird-service-s3-control/server"

// Test setup: start the emulator and point the SDK's endpoint at it. The S3 Control SDK
// prefixes the account ID to the endpoint host, so listen on a name, not an IP address.
const server = await createServer({ host: "localhost" })
const s3control = new S3ControlClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the S3 Control SDK calls it already makes.
// No operation is implemented yet, so every call rejects.
try {
  await s3control.send(new ListAccessPointsCommand({ AccountId: "000000000000" }))
} catch (error) {
  console.log((error as Error).name) // UnknownOperationException
}

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

**Planned, not implemented**, AWS operations: `PutPublicAccessBlock`, `GetPublicAccessBlock`, `DeletePublicAccessBlock`, `CreateAccessPoint`, `GetAccessPoint`, `ListAccessPoints`, `DeleteAccessPoint`, `PutAccessPointPolicy`, `GetAccessPointPolicy`, `DeleteAccessPointPolicy`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Implementation status

No vendor operations are implemented. Requests fail explicitly with `UnknownOperationException`; transport tests cover this boundary and malformed input. This package is not a usable vendor replacement yet. No LocalStack or live AWS parity is claimed.

## Install

```sh
bun add @crvouga/mockingbird-service-s3-control
```

## API

- `S3ControlAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
