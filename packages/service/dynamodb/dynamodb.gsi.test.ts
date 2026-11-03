import { describe, expect, test } from "bun:test"
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb"
import { createServer } from "./src/server.js"

describe("DynamoDB global secondary indexes", () => {
  test("a GSI query LastEvaluatedKey carries the table and index keys", async () => {
    const server = await createServer({
      tables: [
        {
          name: "tasks",
          keySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          globalSecondaryIndexes: [
            {
              IndexName: "by-status",
              KeySchema: [
                { AttributeName: "status", KeyType: "HASH" },
                { AttributeName: "created", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
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
      for (const item of [
        { pk: "a", status: "open", created: 1 },
        { pk: "b", status: "open", created: 2 },
        { pk: "c", status: "open", created: 3 },
        { pk: "no-status", created: 4 },
        { pk: "no-created", status: "open" },
      ])
        await doc.send(new PutCommand({ TableName: "tasks", Item: item }))

      const first = await doc.send(
        new QueryCommand({
          TableName: "tasks",
          IndexName: "by-status",
          KeyConditionExpression: "#status = :open",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":open": "open" },
          Limit: 2,
        }),
      )
      expect(first.Items?.map((item) => item.pk)).toEqual(["a", "b"])
      expect(first.LastEvaluatedKey).toEqual({ pk: "b", status: "open", created: 2 })
      const second = await doc.send(
        new QueryCommand({
          TableName: "tasks",
          IndexName: "by-status",
          KeyConditionExpression: "#status = :open",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":open": "open" },
          ExclusiveStartKey: first.LastEvaluatedKey,
        }),
      )
      expect(second.Items?.map((item) => item.pk)).toEqual(["c"])
      expect(second.LastEvaluatedKey).toBeUndefined()
    } finally {
      low.destroy()
      await server.close()
    }
  })

  test("a GSI holds only items that have every index key attribute", async () => {
    const server = await createServer({
      tables: [
        {
          name: "tasks",
          keySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          globalSecondaryIndexes: [
            {
              IndexName: "by-status",
              KeySchema: [
                { AttributeName: "status", KeyType: "HASH" },
                { AttributeName: "created", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
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
      for (const item of [
        { pk: "a", status: "open", created: 1 },
        { pk: "b", status: "open", created: 2 },
        { pk: "c", status: "open", created: 3 },
        { pk: "no-status", created: 4 },
        { pk: "no-created", status: "open" },
      ])
        await doc.send(new PutCommand({ TableName: "tasks", Item: item }))

      const scanned = await doc.send(
        new ScanCommand({ TableName: "tasks", IndexName: "by-status" }),
      )
      expect(scanned.Items?.map((item) => item.pk)).toEqual(["a", "b", "c"])
      const described = await low.send(new DescribeTableCommand({ TableName: "tasks" }))
      expect(described.Table?.GlobalSecondaryIndexes?.[0]?.ItemCount).toBe(3)
      expect(described.Table?.ItemCount).toBe(5)
    } finally {
      low.destroy()
      await server.close()
    }
  })
})
