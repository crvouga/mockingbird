# @crvouga/mockingbird-service-sqs

Stateful Amazon SQS mock for AWS SDK v3. It models standard and FIFO queues, message attributes, visibility and receipt handles, batches, deduplication, purge locking, and dead-letter redrive without contacting AWS.

## Install

```bash
npm install -D @crvouga/mockingbird-service-sqs
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point `SQS_ENDPOINT_URL` or the AWS SDK `endpoint` option at the served mock. Fixture SigV4 credentials are accepted.

```ts
import { createServer } from "@crvouga/mockingbird-service-sqs/server"

const mock = await createServer({
  queues: [{ name: "jobs", attributes: { VisibilityTimeout: "30" } }],
})
const health = await fetch(`${mock.url}/health`)
```

Supported operations are CreateQueue, GetQueueUrl, GetQueueAttributes, SendMessage, SendMessageBatch, ReceiveMessage, DeleteMessage, ChangeMessageVisibility, and PurgeQueue. Receive honors maximum messages, visibility timeout, system attribute selection, and message attribute selection. The injected shared clock controls visibility expiry and redrive without sleeps.

### Admin and deterministic controls

- `GET /__admin/queues` shows queue depths; `GET /__admin/messages?queue=…` exposes raw local messages.
- `POST /__admin/messages` enqueues a fixture; `POST /__admin/messages/:id/receive-count` sets redrive state; `POST /__admin/messages/:id/duplicate` makes an in-flight message immediately redeliverable.
- `POST /__admin/queues/:name/drain` atomically empties one queue.
- Fault presets are `throttled` and one-shot `unavailable`; generic faults can delay or duplicate a receive at the caller level.

The shared runtime supplies reset, clock, journal, timeline, metrics, faults, and namespace isolation. Select a namespace through `x-mockingbird-namespace`, `/ns/<name>`, or SigV4 access-key mappings.

### Deliberately not modelled

Operations outside the surface listed above, IAM policy evaluation, server-side encryption, queue tagging, production throughput and size limits beyond the 1 MiB message limit, real long-poll wall-clock waits, AWS dashboards, and billing are not modelled.

## API

- `SqsAPI`, `SqsAPIOptions`, `SqsSeedQueue`: portable AWS JSON handler and fixtures.
- `SqsMessage`, `SqsMessageAttribute`, `SqsQueue`: state types.
- `createRuntime`, `SqsRuntime`, `SqsRuntimeOptions`: full Mockingbird runtime.
- `SQS_NAMESPACE`, `SQS_PRESETS`, `accessKeyCredential`: constants and controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `SqsServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [Amazon SQS API Reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/Welcome.html).
