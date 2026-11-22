# @crvouga/mockingbird-service-cloudwatch-logs

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon CloudWatch Logs. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs"
import { createServer } from "@crvouga/mockingbird-service-cloudwatch-logs/server"

// Test setup: start the emulator and point the AWS SDK client your application uses at it.
const emulator = await createServer()
const logs = new CloudWatchLogsClient({
  endpoint: emulator.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: ordinary SDK calls.
await logs.send(new CreateLogGroupCommand({ logGroupName: "/app/api" }))
const { logGroups } = await logs.send(new DescribeLogGroupsCommand({}))
// logGroups[0].logGroupName === "/app/api"

await emulator.close() // after the test
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `CreateLogGroup`, `DeleteLogGroup`, `DescribeLogGroups`, `CreateLogStream`, `DeleteLogStream`, `DescribeLogStreams`, `PutLogEvents`, `GetLogEvents`, `FilterLogEvents`, `PutRetentionPolicy`, `DeleteRetentionPolicy`, `TagLogGroup`, `UntagLogGroup`, `ListTagsLogGroup`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-cloudwatch-logs
```

## API

- `CloudwatchLogsAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
