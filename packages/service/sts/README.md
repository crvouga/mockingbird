# @crvouga/mockingbird-service-sts

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Security Token Service. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts"
import { createServer } from "@crvouga/mockingbird-service-sts/server"

// Test setup: start the emulator and point the SDK's endpoint at it.
const server = await createServer()
const sts = new STSClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the STS SDK calls it already makes.
const identity = await sts.send(new GetCallerIdentityCommand({}))
console.log(identity.Arn) // arn:aws:iam::000000000000:root
const assumed = await sts.send(
  new AssumeRoleCommand({
    RoleArn: "arn:aws:iam::000000000000:role/deploy",
    RoleSessionName: "ci",
  }),
)
console.log(assumed.AssumedRoleUser?.Arn) // arn:aws:sts::000000000000:assumed-role/deploy/ci

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `GetCallerIdentity`, `AssumeRole`, `GetSessionToken`, `GetFederationToken`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-sts
```

## API

- `StsAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
