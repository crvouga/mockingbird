import { describe, expect, test } from "bun:test"
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb"
import { createServer } from "./src/server.js"

const open = async () => {
  const server = await createServer({
    tables: [{ name: "sets", keySchema: [{ AttributeName: "pk", KeyType: "HASH" }] }],
  })
  const low = new DynamoDBClient({
    endpoint: server.url,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })
  return { server, low }
}

describe("DynamoDB UpdateExpression ADD/DELETE on sets", () => {
  test("ADD and DELETE work on number and binary sets", async () => {
    const { server, low } = await open()
    try {
      await low.send(
        new PutItemCommand({
          TableName: "sets",
          Item: { pk: { S: "a" }, scores: { NS: ["1"] }, blobs: { BS: [Uint8Array.of(1)] } },
        }),
      )
      await low.send(
        new UpdateItemCommand({
          TableName: "sets",
          Key: { pk: { S: "a" } },
          UpdateExpression: "ADD scores :scores, blobs :blobs",
          ExpressionAttributeValues: {
            ":scores": { NS: ["1", "2"] },
            ":blobs": { BS: [Uint8Array.of(1), Uint8Array.of(2)] },
          },
        }),
      )
      const added = (
        await low.send(new GetItemCommand({ TableName: "sets", Key: { pk: { S: "a" } } }))
      ).Item
      expect(added?.scores?.NS?.sort()).toEqual(["1", "2"])
      expect(added?.blobs?.BS?.map((blob) => [...blob]).sort()).toEqual([[1], [2]])
      await low.send(
        new UpdateItemCommand({
          TableName: "sets",
          Key: { pk: { S: "a" } },
          UpdateExpression: "DELETE scores :one, blobs :blob",
          ExpressionAttributeValues: {
            ":one": { NS: ["1"] },
            ":blob": { BS: [Uint8Array.of(1)] },
          },
        }),
      )
      const deleted = (
        await low.send(new GetItemCommand({ TableName: "sets", Key: { pk: { S: "a" } } }))
      ).Item
      expect(deleted?.scores).toEqual({ NS: ["2"] })
      expect(deleted?.blobs?.BS?.map((blob) => [...blob])).toEqual([[2]])
    } finally {
      low.destroy()
      await server.close()
    }
  })

  test("DELETE that empties a set removes the attribute", async () => {
    const { server, low } = await open()
    try {
      await low.send(
        new PutItemCommand({
          TableName: "sets",
          Item: { pk: { S: "a" }, tags: { SS: ["x", "y"] } },
        }),
      )
      const updated = await low.send(
        new UpdateItemCommand({
          TableName: "sets",
          Key: { pk: { S: "a" } },
          UpdateExpression: "DELETE tags :all",
          ExpressionAttributeValues: { ":all": { SS: ["x", "y"] } },
          ReturnValues: "ALL_NEW",
        }),
      )
      expect(updated.Attributes).toEqual({ pk: { S: "a" } })
    } finally {
      low.destroy()
      await server.close()
    }
  })
})
