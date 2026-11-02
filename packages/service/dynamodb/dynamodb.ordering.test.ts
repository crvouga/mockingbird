import { describe, expect, test } from "bun:test"
import {
  CreateTableCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb"
import { createServer } from "./src/server.js"

const client = (endpoint: string) =>
  new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })

describe("DynamoDB sort key order", () => {
  test("binary sort keys order by unsigned bytes, not by their base64 text", async () => {
    const server = await createServer()
    const low = client(server.url)
    try {
      await low.send(
        new CreateTableCommand({
          TableName: "blobs",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "B" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
        }),
      )
      // base64 text order is "/w==" (0xff) < "AQ==" (0x01) < "gA==" (0x80).
      for (const byte of [0xff, 0x01, 0x80])
        await low.send(
          new PutItemCommand({
            TableName: "blobs",
            Item: { pk: { S: "p" }, sk: { B: Uint8Array.of(byte) } },
          }),
        )
      const page = await low.send(
        new QueryCommand({
          TableName: "blobs",
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": { S: "p" } },
        }),
      )
      expect(page.Items?.map((item) => [...(item.sk?.B ?? [])])).toEqual([[0x01], [0x80], [0xff]])
    } finally {
      low.destroy()
      await server.close()
    }
  })

  test("string sort keys order by UTF-8 bytes", async () => {
    const server = await createServer()
    const low = client(server.url)
    try {
      await low.send(
        new CreateTableCommand({
          TableName: "names",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
        }),
      )
      // UTF-16 puts the emoji (0xD83D…) before U+FFFD; UTF-8 puts it after (F0… > EF…).
      for (const sk of ["\u{1F600}", "�", "a"])
        await low.send(
          new PutItemCommand({ TableName: "names", Item: { pk: { S: "p" }, sk: { S: sk } } }),
        )
      const page = await low.send(
        new QueryCommand({
          TableName: "names",
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": { S: "p" } },
        }),
      )
      expect(page.Items?.map((item) => item.sk?.S)).toEqual(["a", "�", "\u{1F600}"])
    } finally {
      low.destroy()
      await server.close()
    }
  })
})
