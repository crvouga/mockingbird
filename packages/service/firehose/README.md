# @crvouga/mockingbird-service-firehose

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Data Firehose. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import {
  CreateDeliveryStreamCommand,
  FirehoseClient,
  PutRecordCommand,
} from "@aws-sdk/client-firehose"
import { createServer } from "@crvouga/mockingbird-service-firehose/server"

// Test setup: the Firehose client your application already uses, pointed at the emulator.
const server = await createServer()
const firehose = new FirehoseClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code, unchanged.
await firehose.send(new CreateDeliveryStreamCommand({ DeliveryStreamName: "orders" }))
const { RecordId } = await firehose.send(
  new PutRecordCommand({
    DeliveryStreamName: "orders",
    Record: { Data: new TextEncoder().encode('{"id":"order-1"}\n') },
  }),
)

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `CreateDeliveryStream`, `DeleteDeliveryStream`, `ListDeliveryStreams`, `DescribeDeliveryStream`, `PutRecord`, `PutRecordBatch`, `UpdateDestination`, `TagDeliveryStream`, `UntagDeliveryStream`, `ListTagsForDeliveryStream`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-firehose
```

## API

- `FirehoseAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
