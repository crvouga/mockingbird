# @crvouga/mockingbird-service-sns

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful local emulator of Amazon Simple Notification Service. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { CreateTopicCommand, PublishCommand, SNSClient } from "@aws-sdk/client-sns"
import { createServer } from "@crvouga/mockingbird-service-sns/server"

// Test setup: start the emulator and point the SDK's endpoint at it.
const server = await createServer()
const sns = new SNSClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the SNS SDK calls it already makes.
const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "orders" }))
const published = await sns.send(
  new PublishCommand({ TopicArn, Message: JSON.stringify({ orderId: "ord_1" }) }),
)
console.log(TopicArn, published.MessageId) // arn:aws:sns:us-east-1:000000000000:orders <message id>

await server.close()
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `CreateTopic`, `DeleteTopic`, `ListTopics`, `GetTopicAttributes`, `SetTopicAttributes`, `Subscribe`, `Unsubscribe`, `ListSubscriptions`, `ListSubscriptionsByTopic`, `GetSubscriptionAttributes`, `SetSubscriptionAttributes`, `ConfirmSubscription`, `Publish`, `PublishBatch`, `TagResource`, `UntagResource`, `ListTagsForResource`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @crvouga/mockingbird-service-sns
```

## API

- `SnsAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
