import { describe, expect, test } from "bun:test"
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs"
import { createClock } from "@crvouga/mockingbird-service"
import { createServer } from "./src/server.js"

const clientFor = (endpoint: string) =>
  new SQSClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })

describe("AWS SDK v3 against SQS mock", () => {
  test("send, visibility expiry, redelivery, visibility change and deletion", async () => {
    const clock = createClock(() => Date.now())
    const server = await createServer({ clock })
    const client = clientFor(server.url)
    try {
      const { QueueUrl } = await client.send(
        new CreateQueueCommand({ QueueName: "jobs", Attributes: { VisibilityTimeout: "30" } }),
      )
      const sent = await client.send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: "run",
          MessageAttributes: { Kind: { DataType: "String", StringValue: "lab" } },
        }),
      )
      expect(sent.MessageId).toBeString()
      const first = (
        await client.send(
          new ReceiveMessageCommand({
            QueueUrl,
            AttributeNames: ["All"],
            MessageAttributeNames: ["All"],
            VisibilityTimeout: 10,
          }),
        )
      ).Messages?.[0]
      expect(first?.Body).toBe("run")
      expect(first?.MessageAttributes?.Kind?.StringValue).toBe("lab")
      expect(first?.Attributes?.ApproximateReceiveCount).toBe("1")
      expect((await client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages).toBeUndefined()
      clock.advance(10_001)
      const second = (
        await client.send(new ReceiveMessageCommand({ QueueUrl, AttributeNames: ["All"] }))
      ).Messages?.[0]
      expect(second?.Attributes?.ApproximateReceiveCount).toBe("2")
      expect(second?.ReceiptHandle).not.toBe(first?.ReceiptHandle)
      await expect(
        client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: first?.ReceiptHandle })),
      ).rejects.toMatchObject({ name: "ReceiptHandleIsInvalid" })
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl,
          ReceiptHandle: second?.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      )
      const third = (await client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0]
      await client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: third?.ReceiptHandle }))
      expect(
        (await client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] })))
          .Attributes?.ApproximateNumberOfMessages,
      ).toBe("0")
      await client.send(new PurgeQueueCommand({ QueueUrl }))
      await expect(client.send(new PurgeQueueCommand({ QueueUrl }))).rejects.toMatchObject({
        name: "PurgeQueueInProgress",
      })
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("batch reports per-entry failures and FIFO deduplicates in group order", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const { QueueUrl } = await client.send(
        new CreateQueueCommand({ QueueName: "events.fifo", Attributes: { FifoQueue: "true" } }),
      )
      const batch = await client.send(
        new SendMessageBatchCommand({
          QueueUrl,
          Entries: [
            { Id: "good", MessageBody: "one", MessageGroupId: "g", MessageDeduplicationId: "d1" },
            {
              Id: "bad",
              MessageBody: "x".repeat(1_048_577),
              MessageGroupId: "g",
              MessageDeduplicationId: "d2",
            },
          ],
        }),
      )
      expect(batch.Successful?.map((entry) => entry.Id)).toEqual(["good"])
      expect(batch.Failed?.map((entry) => entry.Id)).toEqual(["bad"])
      const duplicate = await client.send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: "one",
          MessageGroupId: "g",
          MessageDeduplicationId: "d1",
        }),
      )
      expect(duplicate.MessageId).toBe(batch.Successful?.[0]?.MessageId)
      expect(
        (
          await client.send(
            new GetQueueAttributesCommand({
              QueueUrl,
              AttributeNames: ["ApproximateNumberOfMessages"],
            }),
          )
        ).Attributes?.ApproximateNumberOfMessages,
      ).toBe("1")
    } finally {
      client.destroy()
      await server.close()
    }
  })
})
