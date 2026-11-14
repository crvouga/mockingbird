import { describe, expect, test } from "bun:test"
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs"
import { awsMd5 } from "@crvouga/mockingbird-service"
import { createServer } from "./src/server.js"

// The AWS query protocol (form-encoded `Action=…`, XML answers) that older SDKs still speak.
// Shapes follow the SQS 2012-11-05 API reference query examples; best guess, not oracle-verified.
const NS = 'xmlns="http://queue.amazonaws.com/doc/2012-11-05/"'

const query = async (url: string, params: Record<string, string>, path = "/") => {
  const response = await fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams({ Version: "2012-11-05", ...params }).toString(),
  })
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    xml: await response.text(),
  }
}
/** Every `<tag>…</tag>` text in document order (no nested `tag` in these documents). */
const all = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1] ?? "")
const one = (xml: string, tag: string) => all(xml, tag)[0]

const clientFor = (endpoint: string) =>
  new SQSClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  })

describe("AWS query protocol", () => {
  test("SendMessage answers SendMessageResponse XML and stores the message and its attributes", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: "jobs" }))
      const sent = await query(server.url, {
        Action: "SendMessage",
        QueueUrl: QueueUrl as string,
        MessageBody: "a <b> & c",
        "MessageAttribute.1.Name": "Kind",
        "MessageAttribute.1.Value.DataType": "String",
        "MessageAttribute.1.Value.StringValue": "lab",
      })
      expect(sent.status).toBe(200)
      expect(sent.type).toContain("text/xml")
      expect(sent.xml).toStartWith(`<SendMessageResponse ${NS}><SendMessageResult>`)
      expect(one(sent.xml, "MD5OfMessageBody")).toBe(awsMd5("a <b> & c"))
      expect(one(sent.xml, "MD5OfMessageAttributes")).toMatch(/^[0-9a-f]{32}$/)
      expect(one(sent.xml, "MessageId")).toBeString()
      expect(one(sent.xml, "RequestId")).toBeString()
      const received = await client.send(
        new ReceiveMessageCommand({ QueueUrl, MessageAttributeNames: ["All"] }),
      )
      expect(received.Messages?.[0]?.Body).toBe("a <b> & c")
      expect(received.Messages?.[0]?.MessageId).toBe(one(sent.xml, "MessageId"))
      expect(received.Messages?.[0]?.MessageAttributes?.Kind?.StringValue).toBe("lab")
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("the queue may be named by the request path instead of a QueueUrl parameter", async () => {
    const server = await createServer()
    try {
      await query(server.url, { Action: "CreateQueue", QueueName: "jobs" })
      const sent = await query(
        server.url,
        { Action: "SendMessage", MessageBody: "by path" },
        "/000000000000/jobs/",
      )
      expect(sent.status).toBe(200)
      const received = await query(
        server.url,
        { Action: "ReceiveMessage", AttributeName: "All" },
        "/000000000000/jobs",
      )
      expect(one(received.xml, "Body")).toBe("by path")
    } finally {
      await server.close()
    }
  })

  test("ReceiveMessage lists Message elements with Attribute and MessageAttribute entries", async () => {
    const server = await createServer()
    try {
      const created = await query(server.url, { Action: "CreateQueue", QueueName: "jobs" })
      const QueueUrl = one(created.xml, "QueueUrl") as string
      for (const body of ["one", "two"])
        await query(server.url, {
          Action: "SendMessage",
          QueueUrl,
          MessageBody: body,
          "MessageAttribute.1.Name": "Kind",
          "MessageAttribute.1.Value.DataType": "String",
          "MessageAttribute.1.Value.StringValue": body,
          "MessageAttribute.2.Name": "Blob",
          "MessageAttribute.2.Value.DataType": "Binary",
          "MessageAttribute.2.Value.BinaryValue": btoa("raw"),
        })
      const received = await query(server.url, {
        Action: "ReceiveMessage",
        QueueUrl,
        MaxNumberOfMessages: "10",
        VisibilityTimeout: "15",
        "AttributeName.1": "ApproximateReceiveCount",
        "MessageSystemAttributeName.1": "SentTimestamp",
        "MessageAttributeName.1": "Kind",
      })
      expect(received.status).toBe(200)
      expect(received.xml).toStartWith(
        `<ReceiveMessageResponse ${NS}><ReceiveMessageResult><Message>`,
      )
      expect(all(received.xml, "Body")).toEqual(["one", "two"])
      expect(all(received.xml, "MD5OfBody")).toEqual([awsMd5("one"), awsMd5("two")])
      expect(all(received.xml, "ReceiptHandle")).toHaveLength(2)
      // MessageSystemAttributeName takes precedence over the deprecated AttributeName, as in JSON.
      expect(received.xml).toContain("<Attribute><Name>SentTimestamp</Name><Value>")
      expect(received.xml).not.toContain("<Name>ApproximateReceiveCount</Name>")
      expect(received.xml).toContain(
        "<MessageAttribute><Name>Kind</Name><Value><StringValue>one</StringValue><DataType>String</DataType></Value></MessageAttribute>",
      )
      expect(received.xml).not.toContain("<Name>Blob</Name>")
      const empty = await query(server.url, { Action: "ReceiveMessage", QueueUrl })
      expect(empty.xml).toContain("<ReceiveMessageResult></ReceiveMessageResult>")
    } finally {
      await server.close()
    }
  })

  test("queue management maps Attribute.N, AttributeName.N, Tag.N and TagKey.N", async () => {
    const server = await createServer()
    const client = clientFor(server.url)
    try {
      const created = await query(server.url, {
        Action: "CreateQueue",
        QueueName: "jobs",
        "Attribute.1.Name": "VisibilityTimeout",
        "Attribute.1.Value": "45",
        "Attribute.2.Name": "DelaySeconds",
        "Attribute.2.Value": "2",
        "Tag.1.Key": "team",
        "Tag.1.Value": "core",
      })
      expect(created.xml).toStartWith(`<CreateQueueResponse ${NS}><CreateQueueResult><QueueUrl>`)
      const QueueUrl = one(created.xml, "QueueUrl") as string
      expect(QueueUrl).toEndWith("/000000000000/jobs")
      const sdk = await client.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["VisibilityTimeout"] }),
      )
      expect(sdk.Attributes?.VisibilityTimeout).toBe("45")

      const set = await query(server.url, {
        Action: "SetQueueAttributes",
        QueueUrl,
        "Attribute.1.Name": "VisibilityTimeout",
        "Attribute.1.Value": "60",
      })
      // An operation without output answers only ResponseMetadata.
      expect(set.xml).toBe(
        `<SetQueueAttributesResponse ${NS}><ResponseMetadata><RequestId>${one(set.xml, "RequestId")}</RequestId></ResponseMetadata></SetQueueAttributesResponse>`,
      )
      const attributes = await query(server.url, {
        Action: "GetQueueAttributes",
        QueueUrl,
        "AttributeName.1": "VisibilityTimeout",
        "AttributeName.2": "DelaySeconds",
      })
      expect(all(attributes.xml, "Attribute").sort()).toEqual([
        "<Name>DelaySeconds</Name><Value>2</Value>",
        "<Name>VisibilityTimeout</Name><Value>60</Value>",
      ])

      await query(server.url, {
        Action: "TagQueue",
        QueueUrl,
        "Tag.1.Key": "env",
        "Tag.1.Value": "dev",
      })
      await query(server.url, { Action: "UntagQueue", QueueUrl, "TagKey.1": "team" })
      const tags = await query(server.url, { Action: "ListQueueTags", QueueUrl })
      expect(tags.xml).toContain(
        "<ListQueueTagsResult><Tag><Key>env</Key><Value>dev</Value></Tag></ListQueueTagsResult>",
      )

      await query(server.url, { Action: "CreateQueue", QueueName: "jobs-two" })
      await query(server.url, { Action: "CreateQueue", QueueName: "other" })
      const listed = await query(server.url, {
        Action: "ListQueues",
        QueueNamePrefix: "jobs",
        MaxResults: "1",
      })
      expect(all(listed.xml, "QueueUrl")).toEqual([QueueUrl])
      expect(one(listed.xml, "NextToken")).toBe("1")
      const byName = await query(server.url, { Action: "GetQueueUrl", QueueName: "jobs" })
      expect(one(byName.xml, "QueueUrl")).toBe(QueueUrl)

      const deleted = await query(server.url, { Action: "DeleteQueue", QueueUrl })
      expect(deleted.status).toBe(200)
      expect(deleted.xml).toStartWith(`<DeleteQueueResponse ${NS}><ResponseMetadata>`)
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("batches map <Action>RequestEntry.N and answer result and error entries", async () => {
    const server = await createServer()
    try {
      const created = await query(server.url, { Action: "CreateQueue", QueueName: "jobs" })
      const QueueUrl = one(created.xml, "QueueUrl") as string
      const sent = await query(server.url, {
        Action: "SendMessageBatch",
        QueueUrl,
        "SendMessageBatchRequestEntry.1.Id": "a",
        "SendMessageBatchRequestEntry.1.MessageBody": "first",
        "SendMessageBatchRequestEntry.1.MessageAttribute.1.Name": "Kind",
        "SendMessageBatchRequestEntry.1.MessageAttribute.1.Value.DataType": "Number",
        "SendMessageBatchRequestEntry.1.MessageAttribute.1.Value.StringValue": "7",
        "SendMessageBatchRequestEntry.2.Id": "b",
        "SendMessageBatchRequestEntry.2.MessageBody": "second",
        "SendMessageBatchRequestEntry.2.DelaySeconds": "901",
      })
      expect(sent.status).toBe(200)
      expect(sent.xml).toContain("<SendMessageBatchResult><SendMessageBatchResultEntry><Id>a</Id>")
      expect(one(sent.xml, "MD5OfMessageBody")).toBe(awsMd5("first"))
      expect(sent.xml).toContain(
        "<BatchResultErrorEntry><Id>b</Id><SenderFault>true</SenderFault><Code>InvalidParameterValue</Code>",
      )
      const received = await query(server.url, {
        Action: "ReceiveMessage",
        QueueUrl,
        MaxNumberOfMessages: "10",
      })
      const handle = one(received.xml, "ReceiptHandle") as string
      const visibility = await query(server.url, {
        Action: "ChangeMessageVisibilityBatch",
        QueueUrl,
        "ChangeMessageVisibilityBatchRequestEntry.1.Id": "v",
        "ChangeMessageVisibilityBatchRequestEntry.1.ReceiptHandle": handle,
        "ChangeMessageVisibilityBatchRequestEntry.1.VisibilityTimeout": "100",
      })
      expect(visibility.xml).toContain(
        "<ChangeMessageVisibilityBatchResult><ChangeMessageVisibilityBatchResultEntry><Id>v</Id></ChangeMessageVisibilityBatchResultEntry></ChangeMessageVisibilityBatchResult>",
      )
      const deleted = await query(server.url, {
        Action: "DeleteMessageBatch",
        QueueUrl,
        "DeleteMessageBatchRequestEntry.1.Id": "ok",
        "DeleteMessageBatchRequestEntry.1.ReceiptHandle": handle,
        "DeleteMessageBatchRequestEntry.2.Id": "stale",
        "DeleteMessageBatchRequestEntry.2.ReceiptHandle": "not-a-handle",
      })
      expect(deleted.xml).toContain(
        "<DeleteMessageBatchResult><DeleteMessageBatchResultEntry><Id>ok</Id></DeleteMessageBatchResultEntry><BatchResultErrorEntry><Id>stale</Id><SenderFault>false</SenderFault><Code>ReceiptHandleIsInvalid</Code>",
      )
      expect(server.runtime.instance().state.messages.list()).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  test("DeleteMessage, ChangeMessageVisibility and PurgeQueue take ReceiptHandle and VisibilityTimeout", async () => {
    const server = await createServer()
    try {
      const created = await query(server.url, { Action: "CreateQueue", QueueName: "jobs" })
      const QueueUrl = one(created.xml, "QueueUrl") as string
      await query(server.url, { Action: "SendMessage", QueueUrl, MessageBody: "x" })
      const received = await query(server.url, { Action: "ReceiveMessage", QueueUrl })
      const ReceiptHandle = one(received.xml, "ReceiptHandle") as string
      const changed = await query(server.url, {
        Action: "ChangeMessageVisibility",
        QueueUrl,
        ReceiptHandle,
        VisibilityTimeout: "0",
      })
      expect(changed.xml).toStartWith(`<ChangeMessageVisibilityResponse ${NS}><ResponseMetadata>`)
      const again = await query(server.url, { Action: "ReceiveMessage", QueueUrl })
      const deleted = await query(server.url, {
        Action: "DeleteMessage",
        QueueUrl,
        ReceiptHandle: one(again.xml, "ReceiptHandle") as string,
      })
      expect(deleted.status).toBe(200)
      expect(server.runtime.instance().state.messages.list()).toHaveLength(0)
      await query(server.url, { Action: "SendMessage", QueueUrl, MessageBody: "y" })
      const purged = await query(server.url, { Action: "PurgeQueue", QueueUrl })
      expect(purged.xml).toStartWith(`<PurgeQueueResponse ${NS}><ResponseMetadata>`)
      expect(server.runtime.instance().state.messages.list()).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  test("errors answer ErrorResponse XML with Type, Code, Message, Detail and RequestId", async () => {
    const server = await createServer()
    try {
      const missing = await query(server.url, {
        Action: "SendMessage",
        QueueUrl: "http://mock/000000000000/missing",
        MessageBody: "x",
      })
      expect(missing.status).toBe(400)
      expect(missing.type).toContain("text/xml")
      expect(missing.xml).toMatch(
        new RegExp(
          `^<ErrorResponse ${NS}><Error><Type>Sender</Type><Code>AWS\\.SimpleQueueService\\.NonExistentQueue</Code><Message>The specified queue does not exist\\.</Message><Detail/></Error><RequestId>[^<]+</RequestId></ErrorResponse>$`,
        ),
      )
      await query(server.url, { Action: "CreateQueue", QueueName: "jobs" })
      const noBody = await query(server.url, { Action: "SendMessage" }, "/000000000000/jobs")
      expect(one(noBody.xml, "Code")).toBe("MissingParameter")
      const badWait = await query(
        server.url,
        { Action: "ReceiveMessage", WaitTimeSeconds: "21" },
        "/000000000000/jobs",
      )
      expect(one(badWait.xml, "Code")).toBe("InvalidParameterValue")
      const fraction = await query(
        server.url,
        { Action: "ReceiveMessage", MaxNumberOfMessages: "1.5" },
        "/000000000000/jobs",
      )
      expect(one(fraction.xml, "Code")).toBe("InvalidParameterValue")
    } finally {
      await server.close()
    }
  })

  test("an unknown Action is InvalidAction and an unmodelled SQS action is refused, without state changes", async () => {
    const server = await createServer()
    try {
      await query(server.url, { Action: "CreateQueue", QueueName: "jobs" })
      const before = JSON.stringify(server.runtime.instance().state.queues.list())
      const unknown = await query(server.url, {
        Action: "Nope",
        QueueUrl: "http://mock/000000000000/jobs",
      })
      expect(unknown.status).toBe(400)
      expect(one(unknown.xml, "Code")).toBe("InvalidAction")
      expect(one(unknown.xml, "Message")).toBe("The action Nope is not valid for this endpoint.")
      const unmodelled = await query(server.url, {
        Action: "AddPermission",
        QueueUrl: "http://mock/000000000000/jobs",
        Label: "x",
        "AWSAccountId.1": "111122223333",
        "ActionName.1": "SendMessage",
      })
      expect(unmodelled.status).toBe(400)
      expect(one(unmodelled.xml, "Code")).toBe("UnknownOperationException")
      expect(one(unmodelled.xml, "Message")).toContain("does not implement")
      expect(JSON.stringify(server.runtime.instance().state.queues.list())).toBe(before)
      // GET with the parameters in the query string is the same protocol.
      const viaGet = await fetch(new URL("/?Action=GetQueueUrl&QueueName=jobs", server.url))
      expect(one(await viaGet.text(), "QueueUrl")).toEndWith("/000000000000/jobs")
    } finally {
      await server.close()
    }
  })
})
