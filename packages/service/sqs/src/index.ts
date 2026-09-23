import { type APIOptions, bootSqlite, sigV4AccessKeyId } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import { type SqsMessage, type SqsMessageAttribute, type SqsQueue, SqsState } from "./state.js"

export type { SqsRuntime, SqsRuntimeOptions } from "./runtime.js"
export { createRuntime, SQS_PRESETS } from "./runtime.js"
export type { SqsMessage, SqsMessageAttribute, SqsQueue } from "./state.js"
export { document, operationIds, supportedOperationIds }
export const SQS_NAMESPACE = "sqs"
export const accessKeyCredential = sigV4AccessKeyId
export type SqsSeedQueue = { name: string; attributes?: Record<string, string> }
export type SqsAPIOptions = APIOptions & {
  region?: string
  accountId?: string
  queues?: readonly SqsSeedQueue[]
}

type Input = Record<string, unknown>
const jsonHeaders = (requestId: string) => ({
  "content-type": "application/x-amz-json-1.0",
  "x-amzn-requestid": requestId,
})
const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
const md5 = (value: string) => {
  const source = new TextEncoder().encode(value)
  const length = Math.ceil((source.length + 9) / 64) * 64
  const bytes = new Uint8Array(length)
  bytes.set(source)
  bytes[source.length] = 0x80
  const view = new DataView(bytes.buffer)
  const bits = BigInt(source.length) * 8n
  view.setUint32(length - 8, Number(bits & 0xffffffffn), true)
  view.setUint32(length - 4, Number(bits >> 32n), true)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const add = (left: number, right: number) => (left + right) >>> 0
  for (let offset = 0; offset < length; offset += 64) {
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const sum = add(
        add(add(a, f), Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32)),
        view.getUint32(offset + g * 4, true),
      )
      const shift = shifts[Math.floor(i / 16) * 4 + (i % 4)] as number
      ;[a, b, c, d] = [d, add(b, (sum << shift) | (sum >>> (32 - shift))), b, c]
    }
    a0 = add(a0, a)
    b0 = add(b0, b)
    c0 = add(c0, c)
    d0 = add(d0, d)
  }
  return [a0, b0, c0, d0]
    .flatMap((word) => [word & 255, (word >>> 8) & 255, (word >>> 16) & 255, (word >>> 24) & 255])
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
const stringRecord = (value: unknown): Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {}

export class SqsAPI {
  readonly state: SqsState
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly region: string
  private readonly accountId: string
  constructor(private readonly options: SqsAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? SQS_NAMESPACE
    this.now = options.now ?? Date.now
    this.region = options.region ?? "us-east-1"
    this.accountId = options.accountId ?? "000000000000"
    this.state = new SqsState(this.sqlite, this.namespace)
    this.seed()
  }
  private seed() {
    for (const queue of this.options.queues ?? [])
      if (!this.state.queues.has(queue.name))
        this.createQueue(queue.name, queue.attributes ?? {}, "http://mock")
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  private requestId() {
    return this.state.ids.next("req-", 20)
  }
  private response(body: unknown, status = 200) {
    const id = this.requestId()
    return new Response(JSON.stringify(body), { status, headers: jsonHeaders(id) })
  }
  private error(code: string, message: string, status = 400) {
    return this.response({ __type: code, message }, status)
  }
  private createQueue(name: string, attributes: Record<string, string>, origin: string) {
    const existing = this.state.queues.get(name)
    if (existing) return existing
    const queue: SqsQueue = {
      name,
      url: `${origin.replace(/\/$/, "")}/${this.accountId}/${encodeURIComponent(name)}`,
      arn: `arn:aws:sqs:${this.region}:${this.accountId}:${name}`,
      attributes,
      createdAt: this.now(),
    }
    this.state.queues.insert(name, queue)
    return queue
  }
  private queue(input: Input) {
    const url = typeof input.QueueUrl === "string" ? input.QueueUrl : ""
    const name = decodeURIComponent(url.split("/").filter(Boolean).at(-1) ?? "")
    return this.state.queues.get(name)
  }
  private attributes(message: SqsMessage, names: unknown) {
    const requested = Array.isArray(names) ? names.map(String) : []
    if (!requested.includes("All") && requested.length === 0) return undefined
    const values: Record<string, string> = {
      ApproximateReceiveCount: String(message.receiveCount),
      SentTimestamp: String(message.sentAt),
    }
    if (message.firstReceivedAt !== undefined)
      values.ApproximateFirstReceiveTimestamp = String(message.firstReceivedAt)
    if (message.groupId) values.MessageGroupId = message.groupId
    if (message.deduplicationId) values.MessageDeduplicationId = message.deduplicationId
    if (message.sequenceNumber) values.SequenceNumber = message.sequenceNumber
    return requested.includes("All")
      ? values
      : Object.fromEntries(Object.entries(values).filter(([name]) => requested.includes(name)))
  }
  async enqueue(queue: SqsQueue, input: Input) {
    const body = typeof input.MessageBody === "string" ? input.MessageBody : ""
    if (new TextEncoder().encode(body).length > 1_048_576)
      throw new RangeError("Message must be shorter than 1 MiB")
    const fifo = queue.name.endsWith(".fifo")
    const groupId = typeof input.MessageGroupId === "string" ? input.MessageGroupId : undefined
    if (fifo && !groupId) throw new TypeError("MessageGroupId is required for FIFO queues")
    let deduplicationId =
      typeof input.MessageDeduplicationId === "string" ? input.MessageDeduplicationId : undefined
    if (fifo && !deduplicationId && queue.attributes.ContentBasedDeduplication === "true")
      deduplicationId = await sha256(body)
    if (fifo && !deduplicationId)
      throw new TypeError("MessageDeduplicationId is required for FIFO queues")
    if (deduplicationId) {
      const key = `${queue.name}:${deduplicationId}`
      const prior = this.state.deduplications.get(key)
      if (prior && prior.expiresAt > this.now()) {
        const message = this.state.messages.get(prior.messageId)
        return {
          MessageId: prior.messageId,
          MD5OfMessageBody: message?.md5 ?? md5(body),
          SequenceNumber: message?.sequenceNumber,
        }
      }
    }
    const id = this.state.ids.next("msg-", 24)
    const sequenceNumber = fifo
      ? `${String(this.now()).padStart(13, "0")}${String(this.state.messages.list().length + 1).padStart(7, "0")}`
      : undefined
    const delay =
      Math.max(0, Number(input.DelaySeconds ?? queue.attributes.DelaySeconds ?? 0)) * 1000
    const message: SqsMessage = {
      id,
      queue: queue.name,
      body,
      md5: md5(body),
      sentAt: this.now(),
      visibleAt: this.now() + delay,
      receiveCount: 0,
      messageAttributes: (input.MessageAttributes ?? {}) as Record<string, SqsMessageAttribute>,
      ...(groupId ? { groupId } : {}),
      ...(deduplicationId ? { deduplicationId } : {}),
      ...(sequenceNumber ? { sequenceNumber } : {}),
    }
    this.state.messages.insert(id, message)
    if (deduplicationId)
      this.state.deduplications.insert(`${queue.name}:${deduplicationId}`, {
        queue: queue.name,
        id: deduplicationId,
        messageId: id,
        expiresAt: this.now() + 300_000,
      })
    return {
      MessageId: id,
      MD5OfMessageBody: message.md5,
      ...(sequenceNumber ? { SequenceNumber: sequenceNumber } : {}),
    }
  }
  private moveToDlq(message: SqsMessage, queue: SqsQueue): boolean {
    if (!queue.attributes.RedrivePolicy) return false
    try {
      const policy = JSON.parse(queue.attributes.RedrivePolicy) as {
        deadLetterTargetArn?: string
        maxReceiveCount?: string
      }
      if (message.receiveCount < Number(policy.maxReceiveCount)) return false
      const target = [...this.state.queues.list()]
        .map(({ value }) => value)
        .find((value) => value.arn === policy.deadLetterTargetArn)
      if (!target) return false
      const { receiptHandle: _receiptHandle, ...rest } = message
      this.state.messages.insert(message.id, { ...rest, queue: target.name, visibleAt: this.now() })
      return true
    } catch {
      return false
    }
  }
  private receive(queue: SqsQueue, input: Input) {
    const max = Math.max(1, Math.min(10, Number(input.MaxNumberOfMessages ?? 1)))
    const visibility =
      Math.max(0, Number(input.VisibilityTimeout ?? queue.attributes.VisibilityTimeout ?? 30)) *
      1000
    const all = this.state.messages
      .list({ where: (message) => message.queue === queue.name })
      .map(({ value }) => value)
      .sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))
    const selected: SqsMessage[] = []
    for (const message of all) {
      if (selected.length >= max || message.visibleAt > this.now()) continue
      if (
        message.groupId &&
        all.some(
          (other) =>
            other.groupId === message.groupId &&
            (other.sentAt < message.sentAt ||
              (other.sentAt === message.sentAt && other.id < message.id)),
        )
      )
        continue
      if (this.moveToDlq(message, queue)) continue
      const receiptHandle = this.state.ids.next("rct-", 40)
      const next = {
        ...message,
        receiveCount: message.receiveCount + 1,
        firstReceivedAt: message.firstReceivedAt ?? this.now(),
        visibleAt: this.now() + visibility,
        receiptHandle,
      }
      this.state.messages.insert(message.id, next)
      selected.push(next)
    }
    if (selected.length === 0) return {}
    return {
      Messages: selected.map((message) => ({
        MessageId: message.id,
        ReceiptHandle: message.receiptHandle,
        MD5OfBody: message.md5,
        Body: message.body,
        Attributes: this.attributes(message, input.AttributeNames),
        MessageAttributes:
          Array.isArray(input.MessageAttributeNames) && input.MessageAttributeNames.length === 0
            ? undefined
            : message.messageAttributes,
      })),
    }
  }
  private byReceipt(queue: SqsQueue, receipt: unknown) {
    return this.state.messages
      .list({
        where: (message) => message.queue === queue.name && message.receiptHandle === receipt,
      })
      .map(({ value }) => value)[0]
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return this.error("InvalidAction", "Only POST is supported")
    const target = (request.headers.get("x-amz-target") ?? "").split(".").at(-1) ?? ""
    const input = (await request.json().catch(() => ({}))) as Input
    if (target === "CreateQueue") {
      const name = typeof input.QueueName === "string" ? input.QueueName : ""
      if (!name || (name.endsWith(".fifo") && stringRecord(input.Attributes).FifoQueue !== "true"))
        return this.error("InvalidParameterValue", "Invalid queue name or FIFO attributes")
      return this.response({
        QueueUrl: this.createQueue(
          name,
          stringRecord(input.Attributes),
          new URL(request.url).origin,
        ).url,
      })
    }
    if (target === "GetQueueUrl") {
      const queue =
        typeof input.QueueName === "string" ? this.state.queues.get(input.QueueName) : undefined
      return queue
        ? this.response({ QueueUrl: queue.url })
        : this.error(
            "AWS.SimpleQueueService.NonExistentQueue",
            "The specified queue does not exist.",
          )
    }
    const queue = this.queue(input)
    if (!queue)
      return this.error(
        "AWS.SimpleQueueService.NonExistentQueue",
        "The specified queue does not exist.",
      )
    if (target === "GetQueueAttributes") {
      const names = Array.isArray(input.AttributeNames) ? input.AttributeNames.map(String) : []
      const derived: Record<string, string> = {
        QueueArn: queue.arn,
        ApproximateNumberOfMessages: String(
          this.state.messages.list({
            where: (message) => message.queue === queue.name && message.visibleAt <= this.now(),
          }).length,
        ),
        ApproximateNumberOfMessagesNotVisible: String(
          this.state.messages.list({
            where: (message) => message.queue === queue.name && message.visibleAt > this.now(),
          }).length,
        ),
        CreatedTimestamp: String(Math.floor(queue.createdAt / 1000)),
        LastModifiedTimestamp: String(Math.floor(queue.createdAt / 1000)),
        ...queue.attributes,
      }
      return this.response({
        Attributes: names.includes("All")
          ? derived
          : Object.fromEntries(Object.entries(derived).filter(([name]) => names.includes(name))),
      })
    }
    if (target === "SendMessage") {
      try {
        return this.response(await this.enqueue(queue, input))
      } catch (error) {
        return this.error(
          "InvalidParameterValue",
          error instanceof Error ? error.message : "Invalid message",
        )
      }
    }
    if (target === "SendMessageBatch") {
      const successful: unknown[] = []
      const failed: unknown[] = []
      for (const entry of Array.isArray(input.Entries) ? (input.Entries as Input[]) : []) {
        try {
          successful.push({ Id: String(entry.Id), ...(await this.enqueue(queue, entry)) })
        } catch (error) {
          failed.push({
            Id: String(entry.Id),
            SenderFault: true,
            Code: "InvalidParameterValue",
            Message: error instanceof Error ? error.message : "Invalid message",
          })
        }
      }
      return this.response({ Successful: successful, Failed: failed })
    }
    if (target === "ReceiveMessage") return this.response(this.receive(queue, input))
    if (target === "DeleteMessage") {
      const message = this.byReceipt(queue, input.ReceiptHandle)
      if (!message)
        return this.error("ReceiptHandleIsInvalid", "The input receipt handle is invalid.")
      this.state.messages.delete(message.id)
      return this.response({})
    }
    if (target === "ChangeMessageVisibility") {
      const message = this.byReceipt(queue, input.ReceiptHandle)
      if (!message)
        return this.error("ReceiptHandleIsInvalid", "The input receipt handle is invalid.")
      this.state.messages.insert(message.id, {
        ...message,
        visibleAt: this.now() + Math.max(0, Number(input.VisibilityTimeout ?? 0)) * 1000,
      })
      return this.response({})
    }
    if (target === "PurgeQueue") {
      if (queue.lastPurgeAt !== undefined && this.now() - queue.lastPurgeAt < 60_000)
        return this.error(
          "PurgeQueueInProgress",
          "Only one PurgeQueue operation is allowed every 60 seconds.",
        )
      for (const row of this.state.messages.list({
        where: (message) => message.queue === queue.name,
      }))
        this.state.messages.delete(row.id)
      this.state.queues.insert(queue.name, { ...queue, lastPurgeAt: this.now() })
      return this.response({})
    }
    return this.error("InvalidAction", `Unknown operation ${target}`)
  }
}
