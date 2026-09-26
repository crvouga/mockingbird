import { describe, expect, test } from "bun:test"
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs"
import { createServer } from "./src/server.js"

const clientFor = (endpoint: string) =>
  new SQSClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })

describe("SQS acceptance", () => {
  test("FIFO preserves group order and content-based deduplication", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const { QueueUrl } = await client.send(
        new CreateQueueCommand({
          QueueName: "ordered.fifo",
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
        }),
      )
      const first = await client.send(
        new SendMessageCommand({ QueueUrl, MessageBody: "first", MessageGroupId: "one" }),
      )
      const duplicate = await client.send(
        new SendMessageCommand({ QueueUrl, MessageBody: "first", MessageGroupId: "one" }),
      )
      await client.send(
        new SendMessageCommand({ QueueUrl, MessageBody: "second", MessageGroupId: "one" }),
      )
      expect(duplicate.MessageId).toBe(first.MessageId)
      const received = (
        await client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }))
      ).Messages
      expect(received?.map((message) => message.Body)).toEqual(["first"])
      await client.send(
        new DeleteMessageCommand({ QueueUrl, ReceiptHandle: received?.[0]?.ReceiptHandle }),
      )
      expect((await client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0]?.Body).toBe(
        "second",
      )
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("redrive moves poison messages to the configured DLQ", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const { QueueUrl: dlqUrl } = await client.send(new CreateQueueCommand({ QueueName: "dead" }))
      const dlqArn = (
        await client.send(
          new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
        )
      ).Attributes?.QueueArn
      const { QueueUrl } = await client.send(
        new CreateQueueCommand({
          QueueName: "source",
          Attributes: {
            VisibilityTimeout: "0",
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: "2" }),
          },
        }),
      )
      await client.send(new SendMessageCommand({ QueueUrl, MessageBody: "poison" }))
      expect((await client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0]?.Body).toBe(
        "poison",
      )
      expect((await client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages?.[0]?.Body).toBe(
        "poison",
      )
      expect((await client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages).toBeUndefined()
      expect(
        (await client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl }))).Messages?.[0]?.Body,
      ).toBe("poison")
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("namespaces isolate queue state", async () => {
    const server = await createServer()
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonSQS.CreateQueue",
        "x-mockingbird-namespace": "one",
      },
      body: JSON.stringify({ QueueName: "only-one" }),
    })
    expect(response.status).toBe(200)
    const missing = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonSQS.GetQueueUrl",
        "x-mockingbird-namespace": "two",
      },
      body: JSON.stringify({ QueueName: "only-one" }),
    })
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { __type: string }).__type).toContain("NonExistentQueue")
    await server.close()
  })
})
