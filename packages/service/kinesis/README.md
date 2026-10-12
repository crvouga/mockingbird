# @crvouga/mockingbird-service-kinesis

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Kinesis Data Streams. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { CreateStreamCommand, KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import { createServer } from "@crvouga/mockingbird-service-kinesis/server"

// Test setup: the Kinesis client your application already uses, pointed at the emulator.
// The client defaults to HTTP/2 on Node; the emulator serves HTTP/1.1, so pass NodeHttpHandler.
const server = await createServer()
const kinesis = new KinesisClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  requestHandler: new NodeHttpHandler(),
})

// Application code, unchanged.
await kinesis.send(new CreateStreamCommand({ StreamName: "orders", ShardCount: 1 }))
const { ShardId, SequenceNumber } = await kinesis.send(
  new PutRecordCommand({
    StreamName: "orders",
    PartitionKey: "order-1",
    Data: new TextEncoder().encode('{"id":"order-1"}'),
  }),
)
// ShardId === "shardId-000000000000"

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `CreateStream`, `DeleteStream`, `ListStreams`, `DescribeStream`, `DescribeStreamSummary`, `PutRecord`, `PutRecords`, `GetShardIterator`, `GetRecords`, `ListShards`, `UpdateShardCount`, `AddTagsToStream`, `RemoveTagsFromStream`, `ListTagsForStream`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-kinesis
```

## API

- `KinesisAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
