# @crvouga/mockingbird-service-sqs

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful Amazon SQS emulator for AWS SDK v3. It models standard and FIFO queues, message attributes, visibility and receipt handles, batches, deduplication, purge locking, and dead-letter redrive without contacting AWS.

## Install

```bash
npm install -D @crvouga/mockingbird-service-sqs
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point `SQS_ENDPOINT_URL` or the AWS SDK `endpoint` option at the served emulator. Fixture SigV4 credentials are accepted.

```ts
import {
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs"
import { createServer } from "@crvouga/mockingbird-service-sqs/server"

// Test setup: start the emulator with a seeded queue and point the SDK's endpoint at it.
const server = await createServer({
  queues: [{ name: "jobs", attributes: { VisibilityTimeout: "30" } }],
})
const sqs = new SQSClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the SQS SDK calls it already makes.
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: "jobs" }))
await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify({ job: "resize" }) }))
const { Messages } = await sqs.send(new ReceiveMessageCommand({ QueueUrl }))
console.log(Messages?.[0]?.Body) // {"job":"resize"}

await server.close()
```

Supported operations are CreateQueue, ListQueues, GetQueueUrl, DeleteQueue, SetQueueAttributes, GetQueueAttributes, TagQueue, UntagQueue, ListQueueTags, ListDeadLetterSourceQueues, SendMessage, SendMessageBatch, ReceiveMessage, DeleteMessage, DeleteMessageBatch, ChangeMessageVisibility, ChangeMessageVisibilityBatch, and PurgeQueue. Receive honors maximum messages, visibility timeout, wait time, system attribute selection, and message attribute selection. The injected shared clock controls visibility expiry and redrive without sleeps.

Batches answer per entry: `DeleteMessageBatch` and `ChangeMessageVisibilityBatch` list each entry in `Successful` or `Failed` (a stale handle fails as `ReceiptHandleIsInvalid` and the rest still succeed). `ListQueues` filters by `QueueNamePrefix` and pages with `MaxResults` and `NextToken`. `DeleteQueue` drops the queue and its messages. `SetQueueAttributes` validates and replaces the given attributes, and later receives use them.

### Long polling

An empty `ReceiveMessage` is held for `WaitTimeSeconds` (0 to 20), or the queue's `ReceiveMessageWaitTimeSeconds` when the call omits it; `WaitTimeSeconds: 0` never waits. The wait is measured on the emulator clock, so it stays deterministic:

- A message sent during the wait (`SendMessage`, a batch, `POST /__admin/messages`) or made visible (`ChangeMessageVisibility` to 0, an expiring delay or visibility timeout) releases the held request, which answers with it and `ApproximateReceiveCount` 1.
- On a live clock (a served stack) the wait is real. On a frozen clock it lasts until a test advances the clock by the wait time (`clock.advance(3000)` or `POST /__admin/clock`), then answers with no `Messages`.
- With virtual time on (`virtualTime: true`, see Admin controls) the wait is spent on the namespace clock at once, without sleeping.
- A client that disconnects while held stops the wait before anything is received for it, so no message is left hidden. A queue deleted during the wait answers `AWS.SimpleQueueService.NonExistentQueue`.
- `createServer({ longPoll: false })` (or `createRuntime`) keeps the old instant answer for suites that rely on it.

A held request polls the clock every 25 ms of real time while it waits, so an idle consumer costs little but is not free.

Evidence: [short and long polling](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-short-and-long-polling.html) and the [ReceiveMessage reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html), implemented from the documentation (not observed against live SQS). `WaitTimeSeconds` above 20 is `InvalidParameterValue`, as documented.

### Unknown operations

An `X-Amz-Target` the emulator does not answer is refused before any queue is looked up, as `400 UnknownOperationException` (`{"__type":"UnknownOperationException","message":"Unknown operation Nope"}`), never as a missing queue. The SQS operations that exist but are not modelled (`AddPermission`, `RemovePermission`, `StartMessageMoveTask`, `CancelMessageMoveTask`, `ListMessageMoveTasks`) get the same type with the message `<Operation> is an Amazon SQS operation this emulator does not implement.`, so a missing operation is told apart from a missing queue.

Best guess, not oracle-verified: the [AWS JSON 1.0 protocol](https://smithy.io/2.0/aws/protocols/aws-json-1_0-protocol.html) reports an unrecognized operation as a 400 whose `__type` names the failure, and this emulator uses the `UnknownOperationException` name the other AWS emulators in this repo use. The exact `__type` live SQS sends (it may be a `com.amazon.coral.service#UnknownOperationException` form) was not observed; SDK clients strip the namespace before the `#`, so they see the same error name.

### Admin and deterministic controls

- `GET /__admin/queues` shows queue depths; `GET /__admin/messages?queue=…` exposes raw local messages.
- `POST /__admin/messages` enqueues a fixture; `POST /__admin/messages/:id/receive-count` sets redrive state; `POST /__admin/messages/:id/duplicate` makes an in-flight message immediately redeliverable.
- `POST /__admin/queues/:name/drain` atomically empties one queue.
- Fault presets are `throttled` and one-shot `unavailable`; generic faults can delay or duplicate a receive at the caller level.

The shared runtime supplies reset, clock, journal, timeline, metrics, faults, and namespace isolation. Select a namespace through `x-mockingbird-namespace`, `/__admin/ns/<name>`, or SigV4 access-key mappings.

### Deliberately not modelled

Operations outside the surface listed above (queue permissions and message move tasks answer `UnknownOperationException`), IAM policy evaluation, server-side encryption, production throughput and size limits beyond the 1 MiB message limit, AWS dashboards, and billing are not modelled. Queue-missing errors use the legacy `AWS.SimpleQueueService.NonExistentQueue` code, not the `QueueDoesNotExist` name newer SDKs map it to; `GetQueueUrl` for a deleted queue fails with it.

## API

- `SqsAPI`, `SqsAPIOptions`, `SqsSeedQueue`: AWS JSON handler and fixtures.
- `SqsMessage`, `SqsMessageAttribute`, `SqsQueue`: state types.
- `createRuntime`, `SqsRuntime`, `SqsRuntimeOptions`: full Mockingbird runtime.
- `SQS_NAMESPACE`, `SQS_PRESETS`, `accessKeyCredential`: constants and controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `SqsServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [Amazon SQS API Reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/Welcome.html).
