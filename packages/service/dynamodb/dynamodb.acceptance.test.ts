import { describe, expect, test } from "bun:test"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb"
import { createClock } from "@crvouga/mockingbird-service"
import { createServer } from "./src/server.js"

const open = (endpoint: string) => {
  const low = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })
  return { low, doc: DynamoDBDocumentClient.from(low) }
}

describe("DynamoDB acceptance", () => {
  test("batch and transaction operations preserve atomic conditions", async () => {
    const server = await createServer({
      tables: [{ name: "data", keySchema: [{ AttributeName: "pk", KeyType: "HASH" }] }],
    })
    const { low, doc } = open(server.url)
    try {
      await doc.send(
        new BatchWriteCommand({
          RequestItems: {
            data: [
              { PutRequest: { Item: { pk: "a", value: 1 } } },
              { PutRequest: { Item: { pk: "b", value: 2 } } },
            ],
          },
        }),
      )
      const batch = await doc.send(
        new BatchGetCommand({ RequestItems: { data: { Keys: [{ pk: "a" }, { pk: "b" }] } } }),
      )
      expect(batch.Responses?.data?.map((item) => item.value)).toEqual([1, 2])
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: "data",
                Key: { pk: "a" },
                UpdateExpression: "SET #value = :next",
                ConditionExpression: "#value = :old",
                ExpressionAttributeNames: { "#value": "value" },
                ExpressionAttributeValues: { ":old": 1, ":next": 3 },
              },
            },
            {
              Put: {
                TableName: "data",
                Item: { pk: "c", value: 4 },
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" },
              },
            },
          ],
        }),
      )
      const transaction = await doc.send(
        new TransactGetCommand({
          TransactItems: [
            { Get: { TableName: "data", Key: { pk: "a" } } },
            { Get: { TableName: "data", Key: { pk: "c" } } },
          ],
        }),
      )
      expect(transaction.Responses?.map((entry) => entry.Item?.value)).toEqual([3, 4])
      await expect(
        doc.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: "data", Item: { pk: "never" } } },
              {
                ConditionCheck: {
                  TableName: "data",
                  Key: { pk: "a" },
                  ConditionExpression: "#value = :wrong",
                  ExpressionAttributeNames: { "#value": "value" },
                  ExpressionAttributeValues: { ":wrong": 99 },
                },
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ name: "TransactionCanceledException" })
      expect(
        (await doc.send(new GetCommand({ TableName: "data", Key: { pk: "never" } }))).Item,
      ).toBeUndefined()
    } finally {
      low.destroy()
      await server.close()
    }
  })

  test("GSI ordering, TTL expiry, stream records and namespaces are deterministic", async () => {
    const clock = createClock(() => 1_800_000_000_000)
    const server = await createServer({
      clock,
      tables: [
        {
          name: "sessions",
          keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
          globalSecondaryIndexes: [
            {
              IndexName: "by-user",
              KeySchema: [
                { AttributeName: "user", KeyType: "HASH" },
                { AttributeName: "created", KeyType: "RANGE" },
              ],
            },
          ],
          ttlAttribute: "expires",
        },
      ],
    })
    const { low, doc } = open(server.url)
    try {
      await doc.send(
        new PutCommand({
          TableName: "sessions",
          Item: { id: "one", user: "u", created: 2, expires: 1_800_000_001 },
        }),
      )
      await doc.send(
        new PutCommand({
          TableName: "sessions",
          Item: { id: "two", user: "u", created: 1, expires: 1_800_000_100 },
        }),
      )
      expect(
        (
          await doc.send(
            new QueryCommand({
              TableName: "sessions",
              IndexName: "by-user",
              KeyConditionExpression: "#user = :user",
              ExpressionAttributeNames: { "#user": "user" },
              ExpressionAttributeValues: { ":user": "u" },
            }),
          )
        ).Items?.map((item) => item.id),
      ).toEqual(["two", "one"])
      clock.advance(2_000)
      expect(
        (await doc.send(new GetCommand({ TableName: "sessions", Key: { id: "one" } }))).Item,
      ).toBeUndefined()
      const streams = (await (
        await fetch(`${server.url}/__admin/streams?table=sessions`)
      ).json()) as { records: { eventName: string }[] }
      expect(streams.records.map((record) => record.eventName)).toEqual([
        "INSERT",
        "INSERT",
        "REMOVE",
      ])
      const isolated = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "DynamoDB_20120810.GetItem",
          "x-mockingbird-namespace": "other",
        },
        body: JSON.stringify({ TableName: "sessions", Key: { id: { S: "two" } } }),
      })
      expect(isolated.status).toBe(200)
      expect(await isolated.json()).toEqual({})
    } finally {
      low.destroy()
      await server.close()
    }
  })
})
