import { describe, expect, test } from "bun:test"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  PutCommand,
  TransactGetCommand,
} from "@aws-sdk/lib-dynamodb"
import { createClock } from "@crvouga/mockingbird-service"
import { createServer } from "./src/server.js"

describe("DynamoDB TTL on multi-item reads", () => {
  test("BatchGetItem and TransactGetItems skip expired items, as GetItem does", async () => {
    const clock = createClock(() => 1_800_000_000_000)
    const server = await createServer({
      clock,
      tables: [
        {
          name: "sessions",
          keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
          ttlAttribute: "expires",
        },
      ],
    })
    const low = new DynamoDBClient({
      endpoint: server.url,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    const doc = DynamoDBDocumentClient.from(low)
    try {
      await doc.send(
        new PutCommand({ TableName: "sessions", Item: { id: "old", expires: 1_800_000_001 } }),
      )
      await doc.send(
        new PutCommand({ TableName: "sessions", Item: { id: "live", expires: 1_800_000_100 } }),
      )
      clock.advance(2_000)
      const batch = await doc.send(
        new BatchGetCommand({
          RequestItems: { sessions: { Keys: [{ id: "old" }, { id: "live" }] } },
        }),
      )
      expect(batch.Responses?.sessions?.map((item) => item.id)).toEqual(["live"])
      const transaction = await doc.send(
        new TransactGetCommand({
          TransactItems: [
            { Get: { TableName: "sessions", Key: { id: "old" } } },
            { Get: { TableName: "sessions", Key: { id: "live" } } },
          ],
        }),
      )
      expect(transaction.Responses?.map((entry) => entry.Item?.id)).toEqual([undefined, "live"])
    } finally {
      low.destroy()
      await server.close()
    }
  })
})
