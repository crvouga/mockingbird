import { strict as assert } from "node:assert"
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueueTagsCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
  TagQueueCommand,
} from "@aws-sdk/client-sqs"

const config = (endpoint: string) => ({
  endpoint,
  region: "us-east-1",
  maxAttempts: 1,
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})
const errorName = async (action: () => Promise<unknown>) => {
  try {
    await action()
    return "NO_ERROR"
  } catch (error) {
    return error instanceof Error ? error.name : String(error)
  }
}

export async function sqsScenario(endpoint: string) {
  const client = new SQSClient(config(endpoint))
  const name = `mockingbird-parity-${crypto.randomUUID()}`
  let QueueUrl: string | undefined
  let fifoUrl: string | undefined
  try {
    QueueUrl = (await client.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl
    const different = await errorName(() =>
      client.send(
        new CreateQueueCommand({ QueueName: name, Attributes: { VisibilityTimeout: "40" } }),
      ),
    )
    await client.send(
      new SetQueueAttributesCommand({ QueueUrl, Attributes: { VisibilityTimeout: "60" } }),
    )
    await client.send(new TagQueueCommand({ QueueUrl, Tags: { fixture: "yes" } }))
    const tags = (await client.send(new ListQueueTagsCommand({ QueueUrl }))).Tags
    const sent = await client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: "hello",
        MessageAttributes: {
          kind: { DataType: "String", StringValue: "fixture" },
          count: { DataType: "Number", StringValue: "3" },
        },
      }),
    )
    const received = (
      await client.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MessageAttributeNames: ["kind"],
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      )
    ).Messages?.[0]
    const batch = await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl,
        Entries: [
          { Id: "ok", ReceiptHandle: received?.ReceiptHandle },
          { Id: "bad", ReceiptHandle: "invalid" },
        ],
      }),
    )
    const duplicateIds = await errorName(() =>
      client.send(
        new SendMessageBatchCommand({
          QueueUrl,
          Entries: [
            { Id: "same", MessageBody: "a" },
            { Id: "same", MessageBody: "b" },
          ],
        }),
      ),
    )
    const emptyBody = await errorName(() =>
      client.send(new SendMessageCommand({ QueueUrl, MessageBody: "" })),
    )
    const attributes = (
      await client.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: [
            "VisibilityTimeout",
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
          ],
        }),
      )
    ).Attributes
    fifoUrl = (
      await client.send(
        new CreateQueueCommand({
          QueueName: `${name}.fifo`,
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
        }),
      )
    ).QueueUrl
    const first = await client.send(
      new SendMessageCommand({ QueueUrl: fifoUrl, MessageBody: "first", MessageGroupId: "one" }),
    )
    const duplicate = await client.send(
      new SendMessageCommand({ QueueUrl: fifoUrl, MessageBody: "first", MessageGroupId: "one" }),
    )
    await client.send(
      new SendMessageCommand({ QueueUrl: fifoUrl, MessageBody: "second", MessageGroupId: "one" }),
    )
    const messages = (
      await client.send(new ReceiveMessageCommand({ QueueUrl: fifoUrl, MaxNumberOfMessages: 10 }))
    ).Messages?.map((item) => item.Body)
    return {
      different,
      tags,
      body: received?.Body,
      bodyMd5: sent.MD5OfMessageBody,
      attributesMd5: sent.MD5OfMessageAttributes,
      selectedAttributes: received?.MessageAttributes,
      receivedAttributesMd5: received?.MD5OfMessageAttributes,
      systemAttributes: received?.Attributes,
      batch: {
        successful: batch.Successful?.map((item) => item.Id),
        failed: batch.Failed?.map((item) => ({
          id: item.Id,
          code: item.Code,
          senderFault: item.SenderFault,
        })),
      },
      duplicateIds,
      emptyBody,
      attributes,
      fifo: { deduplicated: first.MessageId === duplicate.MessageId, messages },
    }
  } finally {
    if (QueueUrl) await client.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined)
    if (fifoUrl)
      await client.send(new DeleteQueueCommand({ QueueUrl: fifoUrl })).catch(() => undefined)
    client.destroy()
  }
}

export async function criticalParity(
  service: "sqs",
  mockUrl: string,
  oracleUrl = process.env.MOCKINGBIRD_AWS_ORACLE_URL ?? "http://127.0.0.1:4566",
) {
  const host = new URL(oracleUrl).hostname
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(host) &&
    !host.endsWith(".localhost.localstack.cloud")
  )
    throw new Error("AWS parity requires a local emulator endpoint")
  const health = (await fetch(`${oracleUrl}/_localstack/health`).then((response) => {
    if (!response.ok) throw new Error("LocalStack health failed")
    return response.json()
  })) as { version?: string; edition?: string }
  const oracle = await sqsScenario(oracleUrl)
  const mock = await sqsScenario(mockUrl)
  assert.deepEqual(mock, oracle)
  console.log(
    `${service}: LocalStack ${health.version} (${health.edition}) differential scenario passed`,
  )
}
