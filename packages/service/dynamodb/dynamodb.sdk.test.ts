import { describe, expect, test } from "bun:test"
import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb"
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb"
import { createServer } from "./src/server.js"

const clients = (endpoint: string) => {
  const low = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })
  return {
    low,
    doc: DynamoDBDocumentClient.from(low, { marshallOptions: { removeUndefinedValues: true } }),
  }
}

describe("AWS DynamoDB SDK v3 against the mock", () => {
  test("low-level typed values and DocumentClient CRUD/update expressions", async () => {
    const server = await createServer()
    const { low, doc } = clients(server.url)
    try {
      await low.send(
        new CreateTableCommand({
          TableName: "records",
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
      await low.send(
        new PutItemCommand({
          TableName: "records",
          Item: { pk: { S: "a" }, sk: { N: "1" }, exact: { N: "900719925474099312345" } },
        }),
      )
      expect(
        (
          await low.send(
            new GetItemCommand({ TableName: "records", Key: { pk: { S: "a" }, sk: { N: "1" } } }),
          )
        ).Item?.exact?.N,
      ).toBe("900719925474099312345")
      await doc.send(
        new PutCommand({ TableName: "records", Item: { pk: "a", sk: 2, status: "new", count: 1 } }),
      )
      const updated = await doc.send(
        new UpdateCommand({
          TableName: "records",
          Key: { pk: "a", sk: 2 },
          UpdateExpression: "SET #status = :done ADD #count :one",
          ExpressionAttributeNames: { "#status": "status", "#count": "count" },
          ExpressionAttributeValues: { ":done": "done", ":one": 1 },
          ReturnValues: "ALL_NEW",
        }),
      )
      expect(updated.Attributes).toMatchObject({ status: "done", count: 2 })
      expect(
        (await doc.send(new GetCommand({ TableName: "records", Key: { pk: "a", sk: 2 } }))).Item
          ?.status,
      ).toBe("done")
      expect(
        (
          await doc.send(
            new DeleteCommand({
              TableName: "records",
              Key: { pk: "a", sk: 2 },
              ReturnValues: "ALL_OLD",
            }),
          )
        ).Attributes?.status,
      ).toBe("done")
    } finally {
      low.destroy()
      await server.close()
    }
  })

  test("query ordering/cursors, filters, projections and conditional compare-and-set", async () => {
    const server = await createServer()
    const { low, doc } = clients(server.url)
    try {
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
      for (let sk = 1; sk <= 4; sk++)
        await doc.send(
          new PutCommand({
            TableName: "events",
            Item: { pk: "tenant", sk, kind: sk % 2 ? "odd" : "even", version: 0 },
          }),
        )
      const first = await doc.send(
        new QueryCommand({
          TableName: "events",
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": "tenant" },
          Limit: 2,
        }),
      )
      expect(first.Items?.map((item) => item.sk)).toEqual([1, 2])
      const second = await doc.send(
        new QueryCommand({
          TableName: "events",
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": "tenant" },
          ExclusiveStartKey: first.LastEvaluatedKey,
          Limit: 2,
        }),
      )
      expect(second.Items?.map((item) => item.sk)).toEqual([3, 4])
      const descending = await doc.send(
        new QueryCommand({
          TableName: "events",
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": "tenant" },
          ScanIndexForward: false,
          Limit: 2,
        }),
      )
      expect(descending.Items?.map((item) => item.sk)).toEqual([4, 3])
      const scanned = await doc.send(
        new ScanCommand({
          TableName: "events",
          FilterExpression: "#kind = :kind",
          ProjectionExpression: "#pk, #kind",
          ExpressionAttributeNames: { "#pk": "pk", "#kind": "kind" },
          ExpressionAttributeValues: { ":kind": "even" },
        }),
      )
      expect(scanned.Items).toEqual([
        { pk: "tenant", kind: "even" },
        { pk: "tenant", kind: "even" },
      ])
      const outcomes = await Promise.allSettled(
        [0, 1].map(() =>
          doc.send(
            new UpdateCommand({
              TableName: "events",
              Key: { pk: "tenant", sk: 1 },
              UpdateExpression: "SET #version = :one",
              ConditionExpression: "#version = :zero",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
            }),
          ),
        ),
      )
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1)
    } finally {
      low.destroy()
      await server.close()
    }
  })
})
