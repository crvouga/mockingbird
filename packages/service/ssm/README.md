# @crvouga/mockingbird-service-ssm

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Systems Manager Parameter Store. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { createServer } from "@crvouga/mockingbird-service-ssm/server"

// Test setup: start the emulator and point the SDK's endpoint at it.
const server = await createServer()
const ssm = new SSMClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the SSM SDK calls it already makes.
await ssm.send(
  new PutParameterCommand({
    Name: "/app/database-url",
    Value: "postgres://localhost/app",
    Type: "SecureString",
  }),
)
const { Parameter } = await ssm.send(
  new GetParameterCommand({ Name: "/app/database-url", WithDecryption: true }),
)
console.log(Parameter?.Value, Parameter?.Version) // postgres://localhost/app 1

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `PutParameter`, `GetParameter`, `GetParameters`, `GetParametersByPath`, `DeleteParameter`, `DeleteParameters`, `DescribeParameters`, `GetParameterHistory`, `AddTagsToResource`, `RemoveTagsFromResource`, `ListTagsForResource`, `LabelParameterVersion`, `UnlabelParameterVersion`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-ssm
```

## API

- `SsmAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
