# @crvouga/mockingbird-service-config

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Transport scaffold for Amazon Config. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { ConfigServiceClient, DescribeConfigRulesCommand } from "@aws-sdk/client-config-service"
import { createServer } from "@crvouga/mockingbird-service-config/server"

// Test setup: start the emulator and point the AWS SDK client your application uses at it.
const emulator = await createServer()
const config = new ConfigServiceClient({
  endpoint: emulator.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// No operation is implemented yet, so every SDK call rejects.
const failure = await config
  .send(new DescribeConfigRulesCommand({}))
  .catch((error: Error) => error)
// failure.name === "UnknownOperationException"

await emulator.close() // after the test
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

**Planned, not implemented**, AWS operations: `PutConfigurationRecorder`, `DescribeConfigurationRecorders`, `DeleteConfigurationRecorder`, `StartConfigurationRecorder`, `StopConfigurationRecorder`, `DescribeConfigurationRecorderStatus`, `PutDeliveryChannel`, `DescribeDeliveryChannels`, `DeleteDeliveryChannel`, `PutConfigRule`, `DescribeConfigRules`, `DeleteConfigRule`, `GetComplianceDetailsByConfigRule`, `DescribeComplianceByConfigRule`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Implementation status

No vendor operations are implemented. Requests fail explicitly with `UnknownOperationException`; transport tests cover this boundary and malformed input. This package is not a usable vendor replacement yet. No LocalStack or live AWS parity is claimed.

## Install

```sh
bun add @crvouga/mockingbird-service-config
```

## API

- `ConfigAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
