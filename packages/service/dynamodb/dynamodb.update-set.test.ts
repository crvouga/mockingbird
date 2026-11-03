import { describe, expect, test } from "bun:test"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { createServer } from "./src/server.js"

const open = async () => {
  const server = await createServer({
    tables: [{ name: "items", keySchema: [{ AttributeName: "pk", KeyType: "HASH" }] }],
  })
  const low = new DynamoDBClient({
    endpoint: server.url,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })
  return { server, low, doc: DynamoDBDocumentClient.from(low) }
}

describe("DynamoDB UpdateExpression SET", () => {
  test("list_append, if_not_exists inside list_append, subtraction and attribute copy", async () => {
    const { server, low, doc } = await open()
    try {
      await doc.send(
        new PutCommand({
          TableName: "items",
          Item: { pk: "a", tags: ["x"], stock: 10, name: "n" },
        }),
      )
      const updated = await doc.send(
        new UpdateCommand({
          TableName: "items",
          Key: { pk: "a" },
          UpdateExpression:
            "SET tags = list_append(tags, :more), history = list_append(if_not_exists(history, :empty), :more), stock = stock - :sold, label = #name",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: { ":more": ["y"], ":empty": [], ":sold": 3 },
          ReturnValues: "ALL_NEW",
        }),
      )
      expect(updated.Attributes).toEqual({
        pk: "a",
        name: "n",
        tags: ["x", "y"],
        history: ["y"],
        stock: 7,
        label: "n",
      })
    } finally {
      low.destroy()
      await server.close()
    }
  })

  test("every operand reads the item as it was before the update", async () => {
    const { server, low, doc } = await open()
    try {
      await doc.send(new PutCommand({ TableName: "items", Item: { pk: "a", a: 1, b: 2, c: 3 } }))
      const updated = await doc.send(
        new UpdateCommand({
          TableName: "items",
          Key: { pk: "a" },
          UpdateExpression: "REMOVE a SET b = a, c = b",
          ReturnValues: "ALL_NEW",
        }),
      )
      expect(updated.Attributes).toEqual({ pk: "a", b: 1, c: 2 })
    } finally {
      low.destroy()
      await server.close()
    }
  })

  test("arithmetic on a missing attribute is a ValidationException", async () => {
    const { server, low, doc } = await open()
    try {
      await doc.send(new PutCommand({ TableName: "items", Item: { pk: "a" } }))
      await expect(
        doc.send(
          new UpdateCommand({
            TableName: "items",
            Key: { pk: "a" },
            UpdateExpression: "SET total = total + :one",
            ExpressionAttributeValues: { ":one": 1 },
          }),
        ),
      ).rejects.toMatchObject({
        name: "ValidationException",
        message: "The provided expression refers to an attribute that does not exist in the item",
      })
    } finally {
      low.destroy()
      await server.close()
    }
  })
})
