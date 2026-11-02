import { describe, expect, test } from "bun:test"
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { createServer } from "./src/server.js"

const open = async () => {
  const server = await createServer({
    tables: [
      {
        name: "data",
        keySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        items: [{ pk: { S: "a" }, value: { N: "1" } }],
      },
    ],
  })
  const low = new DynamoDBClient({
    endpoint: server.url,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })
  return { server, low, doc: DynamoDBDocumentClient.from(low) }
}

describe("DynamoDB TransactWriteItems", () => {
  test("a cancelled transaction lists one CancellationReason per action, in order", async () => {
    const { server, low, doc } = await open()
    try {
      const error = await doc
        .send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: "data", Item: { pk: "b" } } },
              {
                ConditionCheck: {
                  TableName: "data",
                  Key: { pk: "a" },
                  ConditionExpression: "#value = :wrong",
                  ExpressionAttributeNames: { "#value": "value" },
                  ExpressionAttributeValues: { ":wrong": 99 },
                  ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                },
              },
            ],
          }),
        )
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(TransactionCanceledException)
      expect((error as TransactionCanceledException).message).toBe(
        "Transaction cancelled, please refer cancellation reasons for specific reasons [None, ConditionalCheckFailed]",
      )
      expect((error as TransactionCanceledException).CancellationReasons).toEqual([
        { Code: "None" },
        {
          Code: "ConditionalCheckFailed",
          Message: "The conditional request failed",
          Item: { pk: { S: "a" }, value: { N: "1" } },
        },
      ])
      expect(
        (await doc.send(new GetCommand({ TableName: "data", Key: { pk: "b" } }))).Item,
      ).toBeUndefined()
    } finally {
      low.destroy()
      await server.close()
    }
  })

  test("two actions on the same item are a ValidationException", async () => {
    const { server, low, doc } = await open()
    try {
      await expect(
        doc.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: "data", Item: { pk: "a", value: 2 } } },
              {
                Update: {
                  TableName: "data",
                  Key: { pk: "a" },
                  UpdateExpression: "SET #value = :three",
                  ExpressionAttributeNames: { "#value": "value" },
                  ExpressionAttributeValues: { ":three": 3 },
                },
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({
        name: "ValidationException",
        message: "Transaction request cannot include multiple operations on one item",
      })
      expect(
        (await doc.send(new GetCommand({ TableName: "data", Key: { pk: "a" } }))).Item,
      ).toEqual({ pk: "a", value: 1 })
    } finally {
      low.destroy()
      await server.close()
    }
  })
})
