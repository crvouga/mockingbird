import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb"
import { createServer } from "./src/server.js"

// Condition, filter and key-condition expressions follow the grammar in
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html
// and https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.KeyConditionExpressions.html

let server: Awaited<ReturnType<typeof createServer>>
let low: DynamoDBClient
let doc: DynamoDBDocumentClient

beforeAll(async () => {
  server = await createServer()
  low = new DynamoDBClient({
    endpoint: server.url,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })
  doc = DynamoDBDocumentClient.from(low)
  await low.send(
    new CreateTableCommand({
      TableName: "events",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "N" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  )
  const items = [
    { pk: "t", sk: 1, status: "open", tags: ["a", "b"], owner: "ann", title: "first" },
    { pk: "t", sk: 2, status: "closed", tags: ["b"], owner: "bob", title: "second" },
    { pk: "t", sk: 3, status: "open", tags: ["c"], title: "third" },
    { pk: "t", sk: 4, status: "pending", tags: [], owner: "ann", title: "fourth" },
    { pk: "u", sk: 2, status: "open", tags: ["a"], owner: "ann", title: "other" },
  ]
  for (const Item of items) await doc.send(new PutCommand({ TableName: "events", Item }))
})

afterAll(async () => {
  low.destroy()
  await server.close()
})

const sks = (items: Record<string, unknown>[] | undefined) => (items ?? []).map((item) => item.sk)

describe("DynamoDB expressions", () => {
  test("Query with a BETWEEN sort-key condition after the partition-key equality", async () => {
    const page = await doc.send(
      new QueryCommand({
        TableName: "events",
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
        ExpressionAttributeValues: { ":pk": "t", ":lo": 2, ":hi": 3 },
      }),
    )
    expect(sks(page.Items)).toEqual([2, 3])
  })

  test("a filter that combines BETWEEN with another AND term", async () => {
    const page = await doc.send(
      new ScanCommand({
        TableName: "events",
        FilterExpression: "sk BETWEEN :lo AND :hi AND #s = :open",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":lo": 1, ":hi": 3, ":open": "open" },
      }),
    )
    expect(page.Items?.map((item) => `${item.pk}${item.sk}`).sort()).toEqual(["t1", "t3", "u2"])
  })

  test("parentheses group OR under AND", async () => {
    const page = await doc.send(
      new QueryCommand({
        TableName: "events",
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "(#s = :open OR #s = :pending) AND #o = :ann",
        ExpressionAttributeNames: { "#s": "status", "#o": "owner" },
        ExpressionAttributeValues: {
          ":pk": "t",
          ":open": "open",
          ":pending": "pending",
          ":ann": "ann",
        },
      }),
    )
    expect(sks(page.Items)).toEqual([1, 4])
  })

  test("AND binds tighter than OR", async () => {
    const page = await doc.send(
      new QueryCommand({
        TableName: "events",
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "#s = :closed OR #s = :open AND #o = :ann",
        ExpressionAttributeNames: { "#s": "status", "#o": "owner" },
        ExpressionAttributeValues: {
          ":pk": "t",
          ":closed": "closed",
          ":open": "open",
          ":ann": "ann",
        },
      }),
    )
    expect(sks(page.Items)).toEqual([1, 2])
  })

  test("NOT, IN, contains, size and attribute_type", async () => {
    const run = async (FilterExpression: string, values: Record<string, unknown> = {}) =>
      sks(
        (
          await doc.send(
            new QueryCommand({
              TableName: "events",
              KeyConditionExpression: "pk = :pk",
              FilterExpression,
              ExpressionAttributeNames: { "#s": "status", "#o": "owner" },
              ExpressionAttributeValues: { ":pk": "t", ...values },
            }),
          )
        ).Items,
      )
    expect(await run("NOT attribute_exists(#o)")).toEqual([3])
    expect(await run("NOT (#s = :open)", { ":open": "open" })).toEqual([2, 4])
    expect(
      await run("#s IN (:closed, :pending)", { ":closed": "closed", ":pending": "pending" }),
    ).toEqual([2, 4])
    expect(await run("contains(tags, :b)", { ":b": "b" })).toEqual([1, 2])
    expect(await run("contains(title, :ir)", { ":ir": "ir" })).toEqual([1, 3])
    expect(await run("size(tags) > :one", { ":one": 1 })).toEqual([1])
    expect(await run("size(tags) = :zero", { ":zero": 0 })).toEqual([4])
    expect(await run("attribute_type(#o, :s)", { ":s": "S" })).toEqual([1, 2, 4])
    expect(await run("sk > :one AND sk <> :three", { ":one": 1, ":three": 3 })).toEqual([2, 4])
  })

  test("a comparison between two attribute paths", async () => {
    await doc.send(
      new PutCommand({ TableName: "events", Item: { pk: "v", sk: 1, low: 1, high: 5 } }),
    )
    await doc.send(
      new PutCommand({ TableName: "events", Item: { pk: "v", sk: 2, low: 9, high: 5 } }),
    )
    const page = await doc.send(
      new QueryCommand({
        TableName: "events",
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "low < high",
        ExpressionAttributeValues: { ":pk": "v" },
      }),
    )
    expect(sks(page.Items)).toEqual([1])
  })

  test("a grouped condition guards UpdateItem", async () => {
    const update = (expected: string) =>
      doc.send(
        new UpdateCommand({
          TableName: "events",
          Key: { pk: "t", sk: 2 },
          UpdateExpression: "SET #s = :reopened",
          ConditionExpression: "attribute_exists(pk) AND (#s = :expected OR #s = :pending)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":reopened": "reopened",
            ":expected": expected,
            ":pending": "pending",
          },
          ReturnValues: "ALL_NEW",
        }),
      )
    await expect(update("open")).rejects.toMatchObject({ name: "ConditionalCheckFailedException" })
    expect((await update("closed")).Attributes?.status).toBe("reopened")
  })

  test("a malformed expression is a ValidationException", async () => {
    await expect(
      doc.send(
        new ScanCommand({
          TableName: "events",
          FilterExpression: "(#s = :open",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":open": "open" },
        }),
      ),
    ).rejects.toMatchObject({ name: "ValidationException" })
  })
})
