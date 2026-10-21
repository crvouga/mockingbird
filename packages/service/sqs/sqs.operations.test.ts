import { describe, expect, test } from "bun:test"
import {
  ChangeMessageVisibilityBatchCommand,
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListDeadLetterSourceQueuesCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
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

const rpc = async (url: string, target: string, body: unknown = {}) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": target },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("SQS operations beyond send and receive", () => {
  test("DeleteMessageBatch deletes valid handles and reports a stale one in Failed", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: "jobs" }))
      for (const body of ["a", "b", "c"])
        await client.send(new SendMessageCommand({ QueueUrl, MessageBody: body }))
      const received =
        (await client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 })))
          .Messages ?? []
      expect(received).toHaveLength(3)
      const result = await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl,
          Entries: [
            ...received.map((message, index) => ({
              Id: `m${index}`,
              ReceiptHandle: message.ReceiptHandle,
            })),
            { Id: "stale", ReceiptHandle: "not-a-receipt-handle" },
          ],
        }),
      )
      expect(result.Successful?.map((entry) => entry.Id)).toEqual(["m0", "m1", "m2"])
      expect(result.Failed).toHaveLength(1)
      expect(result.Failed?.[0]).toMatchObject({ Id: "stale", Code: "ReceiptHandleIsInvalid" })
      const attributes = await client.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }),
      )
      expect(attributes.Attributes?.ApproximateNumberOfMessages).toBe("0")
      expect(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("0")
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("ChangeMessageVisibilityBatch with 0 releases exactly the chosen messages", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: "jobs" }))
      for (const body of ["a", "b", "c"])
        await client.send(new SendMessageCommand({ QueueUrl, MessageBody: body }))
      const received =
        (await client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 })))
          .Messages ?? []
      const result = await client.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl,
          Entries: [
            { Id: "x", ReceiptHandle: received[0]?.ReceiptHandle, VisibilityTimeout: 0 },
            { Id: "y", ReceiptHandle: received[2]?.ReceiptHandle, VisibilityTimeout: 0 },
          ],
        }),
      )
      expect(result.Successful?.map((entry) => entry.Id)).toEqual(["x", "y"])
      expect(result.Failed).toEqual([])
      const again = (
        await client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }))
      ).Messages
      expect(again?.map((message) => message.Body).sort()).toEqual(["a", "c"])
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("ListQueues filters by prefix and pages with MaxResults and NextToken", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      for (const QueueName of ["a-1", "a-2", "b-1"])
        await client.send(new CreateQueueCommand({ QueueName }))
      const prefixed = await client.send(new ListQueuesCommand({ QueueNamePrefix: "a-" }))
      expect(prefixed.QueueUrls?.map((url) => url.split("/").at(-1))).toEqual(["a-1", "a-2"])
      const first = await client.send(
        new ListQueuesCommand({ QueueNamePrefix: "a-", MaxResults: 1 }),
      )
      expect(first.QueueUrls).toHaveLength(1)
      expect(first.NextToken).toBeString()
      const second = await client.send(
        new ListQueuesCommand({ QueueNamePrefix: "a-", MaxResults: 1, NextToken: first.NextToken }),
      )
      expect(second.QueueUrls?.map((url) => url.split("/").at(-1))).toEqual(["a-2"])
      expect(second.NextToken).toBeUndefined()
      expect(
        (await client.send(new ListQueuesCommand({ QueueNamePrefix: "zzz" }))).QueueUrls ?? [],
      ).toEqual([])
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("SetQueueAttributes changes VisibilityTimeout and RedrivePolicy for later receives", async () => {
    const clock = createClock(() => Date.now())
    clock.freeze()
    const server = await createServer({ clock })
    const client = clientFor(server.url)
    try {
      const { QueueUrl: dlqUrl } = await client.send(new CreateQueueCommand({ QueueName: "dead" }))
      const dlqArn = (
        await client.send(
          new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
        )
      ).Attributes?.QueueArn
      const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: "source" }))
      const redrive = JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: "1" })
      await client.send(
        new SetQueueAttributesCommand({
          QueueUrl,
          Attributes: { VisibilityTimeout: "5", RedrivePolicy: redrive },
        }),
      )
      const attributes = (
        await client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }))
      ).Attributes
      expect(attributes?.VisibilityTimeout).toBe("5")
      expect(attributes?.RedrivePolicy).toBe(redrive)
      await client.send(new SendMessageCommand({ QueueUrl, MessageBody: "poison" }))
      await client.send(new ReceiveMessageCommand({ QueueUrl }))
      clock.advance(5_001)
      expect((await client.send(new ReceiveMessageCommand({ QueueUrl }))).Messages).toBeUndefined()
      expect(
        (await client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl }))).Messages?.[0]?.Body,
      ).toBe("poison")
      await expect(
        client.send(
          new SetQueueAttributesCommand({ QueueUrl, Attributes: { VisibilityTimeout: "99999" } }),
        ),
      ).rejects.toMatchObject({ name: "InvalidAttributeValue" })
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("DeleteQueue removes the queue and its messages", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: "jobs" }))
      await client.send(new SendMessageCommand({ QueueUrl, MessageBody: "kept?" }))
      await client.send(new DeleteQueueCommand({ QueueUrl }))
      const missing = await rpc(server.url, "AmazonSQS.GetQueueUrl", { QueueName: "jobs" })
      expect(missing.status).toBe(400)
      expect(String(missing.body.__type)).toContain("NonExistentQueue")
      expect(server.runtime.instance().state.messages.list()).toHaveLength(0)
      const recreated = await client.send(new CreateQueueCommand({ QueueName: "jobs" }))
      expect(
        (await client.send(new ReceiveMessageCommand({ QueueUrl: recreated.QueueUrl }))).Messages,
      ).toBeUndefined()
      await expect(
        client.send(new GetQueueUrlCommand({ QueueName: "jobs" })),
      ).resolves.toBeDefined()
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("ListDeadLetterSourceQueues returns every queue that redrives into the DLQ", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const { QueueUrl: dlqUrl } = await client.send(new CreateQueueCommand({ QueueName: "dead" }))
      const dlqArn = (
        await client.send(
          new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
        )
      ).Attributes?.QueueArn
      const sources: string[] = []
      for (const QueueName of ["one", "two"])
        sources.push(
          (
            await client.send(
              new CreateQueueCommand({
                QueueName,
                Attributes: {
                  RedrivePolicy: JSON.stringify({
                    deadLetterTargetArn: dlqArn,
                    maxReceiveCount: "3",
                  }),
                },
              }),
            )
          ).QueueUrl as string,
        )
      await client.send(new CreateQueueCommand({ QueueName: "unrelated" }))
      const listed = await client.send(new ListDeadLetterSourceQueuesCommand({ QueueUrl: dlqUrl }))
      expect([...(listed.queueUrls ?? [])].sort()).toEqual([...sources].sort())
    } finally {
      client.destroy()
      await server.close()
    }
  })
})

describe("unknown X-Amz-Target actions", () => {
  test("an operation SQS does not have is UnknownOperationException, not a queue error", async () => {
    const server = await createServer()
    try {
      const unknown = await rpc(server.url, "AmazonSQS.Nope")
      expect(unknown.status).toBe(400)
      expect(unknown.body.__type).toBe("UnknownOperationException")
      expect(String(unknown.body.message)).toContain("Nope")
      const withQueue = await rpc(server.url, "AmazonSQS.Nope", {
        QueueUrl: "http://mock/000000000000/missing",
      })
      expect(withQueue.body.__type).toBe("UnknownOperationException")
      const empty = await rpc(server.url, "")
      expect(empty.body.__type).toBe("UnknownOperationException")
    } finally {
      await server.close()
    }
  })

  test("a real SQS operation the emulator lacks says so, and is not a queue error", async () => {
    const server = await createServer()
    try {
      for (const target of ["AddPermission", "RemovePermission", "StartMessageMoveTask"]) {
        const answer = await rpc(server.url, `AmazonSQS.${target}`, {
          QueueUrl: "http://mock/000000000000/missing",
        })
        expect(answer.status).toBe(400)
        expect(answer.body.__type).toBe("UnknownOperationException")
        expect(String(answer.body.message)).toContain(target)
        expect(String(answer.body.message)).toContain("does not implement")
      }
    } finally {
      await server.close()
    }
  })

  test("a missing queue is still NonExistentQueue for a known operation", async () => {
    const server = await createServer()
    try {
      const answer = await rpc(server.url, "AmazonSQS.SendMessage", {
        QueueUrl: "http://mock/000000000000/missing",
        MessageBody: "x",
      })
      expect(String(answer.body.__type)).toContain("NonExistentQueue")
    } finally {
      await server.close()
    }
  })
})
