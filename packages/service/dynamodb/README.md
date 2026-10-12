# @crvouga/mockingbird-service-dynamodb

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful Amazon DynamoDB emulator for the AWS SDK v3 low-level client and `DynamoDBDocumentClient`. It preserves DynamoDB attribute types while modelling CRUD, expressions, indexes, pagination, batches, transactions, TTL, streams, and conditional writes without contacting AWS.

## Install

```bash
npm install -D @crvouga/mockingbird-service-dynamodb
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

Point the SDK's `endpoint` option at the emulator. Fixture SigV4 credentials are accepted.

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb"
import { createServer } from "@crvouga/mockingbird-service-dynamodb/server"

// Test setup: seed the emulator and point the AWS SDK client your application uses at it.
const emulator = await createServer({
  tables: [
    {
      name: "records",
      keySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      items: [{ pk: { S: "fixture" }, status: { S: "ready" } }],
    },
  ],
})
const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: emulator.url,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  }),
)

// Application code: ordinary SDK calls.
const { Item } = await db.send(new GetCommand({ TableName: "records", Key: { pk: "fixture" } }))
// Item: { pk: "fixture", status: "ready" }

await emulator.close() // after the test
```

Supported operations are CreateTable, DescribeTable, GetItem, PutItem, UpdateItem, DeleteItem, Query, Scan, BatchGetItem, BatchWriteItem, TransactGetItems, and TransactWriteItems. The expression subset includes expression name/value aliases, SET/ADD/REMOVE/DELETE, `if_not_exists`, `attribute_exists`, `attribute_not_exists`, `begins_with`, comparisons, BETWEEN, AND/OR, projection, conditions, limits, cursors, index ordering, and return values.

### Admin and deterministic controls

- Constructor fixtures define tables, indexes, typed items, and TTL attributes.
- `GET /__admin/tables`, `/__admin/items?table=…`, and `/__admin/streams?table=…` inspect local state and ordered INSERT/MODIFY/REMOVE records.
- Advance the shared emulator clock to expire TTL items without sleeps.
- Fault presets are `throttled` and one-shot `unavailable`; generic fault rules can model unprocessed batch responses or eventual-read failures.

The shared runtime also provides reset, timeline, request journal, metrics, faults, and namespace isolation through `x-mockingbird-namespace`, `/__admin/ns/<name>`, or SigV4 access-key mappings.

### Deliberately not modelled

PartiQL, control-plane operations outside Create/Describe, local/global table replication, IAM policy evaluation, encryption, backups, production capacity accounting, all DynamoDB expression grammar, real asynchronous streams, dashboards, and billing are not modelled.

## API

- `DynamoAPI`, `DynamoAPIOptions`, `DynamoSeedTable`: AWS JSON handler and fixtures.
- `AttributeValue`, `Item`, `KeySchemaElement`, `DynamoIndex`, `DynamoItem`, `DynamoTable`, `StreamRecord`: typed state.
- `createRuntime`, `DynamoRuntime`, `DynamoRuntimeOptions`: full Mockingbird runtime.
- `DYNAMODB_NAMESPACE`, `DYNAMODB_PRESETS`, `accessKeyCredential`: constants and controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `DynamoServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

Official oracle: [Amazon DynamoDB API Reference](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/Welcome.html).
