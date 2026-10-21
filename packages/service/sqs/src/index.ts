import {
  type APIOptions,
  bootSqlite,
  awsMd5 as md5,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
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
  /** Hold an empty ReceiveMessage for its wait time, as SQS does. Default true; false answers at once. */
  longPoll?: boolean
  /** Whether the namespace spends waits on the clock instead of sleeping (virtual time). */
  virtualTime?: () => boolean
  /** Move the namespace's clock forward; used by virtual time to spend a long-poll wait. */
  advance?: (ms: number) => void
}

type Input = Record<string, unknown>
/** The operations this emulator answers, the rest of SQS's API as `UNIMPLEMENTED_OPERATIONS`. */
const OPERATIONS = new Set([
  "CreateQueue",
  "ListQueues",
  "GetQueueUrl",
  "DeleteQueue",
  "SetQueueAttributes",
  "TagQueue",
  "UntagQueue",
  "ListQueueTags",
  "ListDeadLetterSourceQueues",
  "GetQueueAttributes",
  "SendMessage",
  "SendMessageBatch",
  "DeleteMessageBatch",
  "ChangeMessageVisibilityBatch",
  "ReceiveMessage",
  "DeleteMessage",
  "ChangeMessageVisibility",
  "PurgeQueue",
])
/** Operations SQS has (API_Operations) that the emulator does not model. */
const UNIMPLEMENTED_OPERATIONS = new Set([
  "AddPermission",
  "RemovePermission",
  "StartMessageMoveTask",
  "CancelMessageMoveTask",
  "ListMessageMoveTasks",
])
const jsonHeaders = (requestId: string) => ({
  "content-type": "application/x-amz-json-1.0",
  "x-amzn-requestid": requestId,
})
/** How often a held long-poll receive re-reads the clock, in real milliseconds. */
const LONG_POLL_TICK_MS = 25
const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

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
  /** Held long-poll receives; each resolver releases one to re-check its queue. */
  private readonly waiters = new Set<() => void>()
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
    this.wake()
  }
  private wake() {
    for (const release of [...this.waiters]) release()
  }
  /** Sleep up to `ms` of real time, or until a send, a reset or the caller's disconnect. */
  private pause(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const release = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", release)
        this.waiters.delete(release)
        resolve()
      }
      const timer = setTimeout(release, ms)
      signal.addEventListener("abort", release, { once: true })
      this.waiters.add(release)
    })
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
      attributes: {
        VisibilityTimeout: "30",
        MaximumMessageSize: "1048576",
        MessageRetentionPeriod: "345600",
        DelaySeconds: "0",
        ReceiveMessageWaitTimeSeconds: "0",
        SqsManagedSseEnabled: "true",
        ...attributes,
      },
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
      SenderId: this.accountId,
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
    if (!body) throw new TypeError("MessageBody is required")
    if (
      [...body].some((character) => {
        const code = character.codePointAt(0) ?? 0
        return !(
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 0x20 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          (code >= 0x10000 && code <= 0x10ffff)
        )
      })
    )
      throw new TypeError("Invalid characters in MessageBody")
    const messageAttributes = (input.MessageAttributes ?? {}) as Record<string, SqsMessageAttribute>
    const attributesMd5 = this.attributeMd5(messageAttributes)
    if (
      new TextEncoder().encode(body).length + this.attributeSize(messageAttributes) >
      Number(queue.attributes.MaximumMessageSize ?? 1048576)
    )
      throw new RangeError("Message must be shorter than 1 MiB")
    const fifo = queue.name.endsWith(".fifo")
    const groupId = typeof input.MessageGroupId === "string" ? input.MessageGroupId : undefined
    if (fifo && input.DelaySeconds !== undefined)
      throw new TypeError("DelaySeconds is not supported for FIFO messages")
    if (!fifo && input.MessageDeduplicationId !== undefined)
      throw new TypeError("MessageDeduplicationId is only supported for FIFO queues")
    if (fifo && !groupId) throw new TypeError("MessageGroupId is required for FIFO queues")
    let deduplicationId =
      typeof input.MessageDeduplicationId === "string" ? input.MessageDeduplicationId : undefined
    if (fifo && !deduplicationId && queue.attributes.ContentBasedDeduplication === "true")
      deduplicationId = await sha256(body)
    if (fifo && !deduplicationId)
      throw new TypeError("MessageDeduplicationId is required for FIFO queues")
    if (deduplicationId && fifo) {
      const key = `${queue.name}:${queue.attributes.DeduplicationScope === "messageGroup" ? `${groupId}:` : ""}${deduplicationId}`
      const prior = this.state.deduplications.get(key)
      if (prior && prior.expiresAt > this.now()) {
        const message = this.state.messages.get(prior.messageId)
        return {
          MessageId: prior.messageId,
          MD5OfMessageBody: prior.md5 ?? message?.md5 ?? md5(body),
          SequenceNumber: prior.sequenceNumber ?? message?.sequenceNumber,
          ...(attributesMd5 ? { MD5OfMessageAttributes: attributesMd5 } : {}),
        }
      }
    }
    const id = this.state.ids.next("msg-", 24)
    const sequence = (this.state.queues.get(queue.name)?.sequence ?? 0) + 1
    this.state.queues.insert(queue.name, { ...queue, sequence })
    const sequenceNumber = fifo ? String(sequence).padStart(20, "0") : undefined
    const delaySeconds = Number(input.DelaySeconds ?? queue.attributes.DelaySeconds ?? 0)
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 900)
      throw new TypeError("DelaySeconds must be between 0 and 900")
    const delay = delaySeconds * 1000
    const message: SqsMessage = {
      id,
      queue: queue.name,
      body,
      md5: md5(body),
      sentAt: this.now(),
      visibleAt: this.now() + delay,
      receiveCount: 0,
      messageAttributes,
      ...(groupId ? { groupId } : {}),
      ...(deduplicationId ? { deduplicationId } : {}),
      ...(sequenceNumber ? { sequenceNumber } : {}),
    }
    this.state.messages.insert(id, message)
    this.wake()
    if (deduplicationId)
      this.state.deduplications.insert(
        `${queue.name}:${queue.attributes.DeduplicationScope === "messageGroup" ? `${groupId}:` : ""}${deduplicationId}`,
        {
          queue: queue.name,
          id: deduplicationId,
          messageId: id,
          expiresAt: this.now() + 300_000,
          md5: message.md5,
          ...(sequenceNumber ? { sequenceNumber } : {}),
        },
      )
    return {
      MessageId: id,
      MD5OfMessageBody: message.md5,
      ...(attributesMd5 ? { MD5OfMessageAttributes: attributesMd5 } : {}),
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
    this.expire(queue)
    const all = this.state.messages
      .list({ where: (message) => message.queue === queue.name, order: "oldest" })
      .map(({ value }) => value)
    const selected: SqsMessage[] = []
    for (const [index, message] of all.entries()) {
      if (selected.length >= max || message.visibleAt > this.now()) continue
      if (
        queue.name.endsWith(".fifo") &&
        message.groupId &&
        all
          .slice(0, index)
          .some(
            (other) =>
              other.groupId === message.groupId &&
              this.state.messages.get(other.id)?.queue === queue.name &&
              !selected.some((picked) => picked.id === other.id),
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
        Attributes: this.attributes(
          message,
          input.MessageSystemAttributeNames ?? input.AttributeNames,
        ),
        MessageAttributes: this.selectedAttributes(
          message.messageAttributes,
          input.MessageAttributeNames,
        ),
        MD5OfMessageAttributes: this.attributeMd5(
          this.selectedAttributes(message.messageAttributes, input.MessageAttributeNames) ?? {},
        ),
      })),
    }
  }
  /**
   * ReceiveMessage with long polling. An empty queue holds the request for `WaitTimeSeconds`
   * (or the queue's `ReceiveMessageWaitTimeSeconds`) on the emulator clock: a frozen clock
   * waits until a test advances it, a live clock waits in real time, and virtual time spends
   * the wait on the clock at once. A send, a visibility change or a reset re-checks the queue
   * immediately; a disconnect stops the wait before anything is received for it.
   */
  private async receiveHeld(name: string, input: Input, signal: AbortSignal): Promise<Response> {
    const first = this.state.queues.get(name)
    const seconds = Number(
      input.WaitTimeSeconds ?? first?.attributes.ReceiveMessageWaitTimeSeconds ?? 0,
    )
    const deadline = this.now() + (this.options.longPoll === false ? 0 : seconds * 1000)
    for (;;) {
      const queue = this.state.queues.get(name)
      if (!queue) return this.nonExistentQueue()
      if (signal.aborted) return this.response({})
      this.expire(queue)
      const received = this.receive(queue, input)
      const remaining = deadline - this.now()
      if (received.Messages || remaining <= 0) return this.response(received)
      // The next moment a delayed or in-flight message of this queue becomes visible.
      const due = this.state.messages
        .list({ where: (message) => message.queue === name && message.visibleAt > this.now() })
        .reduce((soonest, { value }) => Math.min(soonest, value.visibleAt - this.now()), remaining)
      if (this.options.virtualTime?.() && this.options.advance)
        this.options.advance(Math.max(1, due))
      else await this.pause(Math.min(LONG_POLL_TICK_MS, Math.max(1, due)), signal)
    }
  }
  private nonExistentQueue() {
    return this.error(
      "AWS.SimpleQueueService.NonExistentQueue",
      "The specified queue does not exist.",
    )
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
    // An operation is answered or refused before any queue is looked up, so a misspelled or
    // missing operation never reads as a missing queue (AWS JSON 1.0: `__type` names the failure).
    if (!OPERATIONS.has(target))
      return this.error(
        "UnknownOperationException",
        UNIMPLEMENTED_OPERATIONS.has(target)
          ? `${target} is an Amazon SQS operation this emulator does not implement.`
          : `Unknown operation ${target || "(no X-Amz-Target)"}`,
      )
    const input = (await request.json().catch(() => ({}))) as Input
    if (target === "CreateQueue") {
      const name = typeof input.QueueName === "string" ? input.QueueName : ""
      const attributes = stringRecord(input.Attributes)
      if (
        !/^[a-zA-Z0-9_-]{1,80}(\.fifo)?$/.test(name) ||
        name.length > 80 ||
        name.endsWith(".fifo") !== (attributes.FifoQueue === "true")
      )
        return this.error("InvalidParameterValue", "Invalid queue name or FIFO attributes")
      const validation = this.validateAttributes(attributes, name)
      if (validation) return validation
      const prior = this.state.queues.get(name)
      if (
        prior &&
        Object.entries(attributes).some(([key, value]) => prior.attributes[key] !== value)
      )
        return this.error(
          "QueueNameExists",
          "A queue already exists with the same name and a different value for attribute",
        )
      const queue = this.createQueue(name, attributes, new URL(request.url).origin)
      if (!prior && input.tags)
        this.state.queues.insert(name, { ...queue, tags: stringRecord(input.tags) })
      return this.response({ QueueUrl: queue.url })
    }
    if (target === "ListQueues") {
      const queues = this.state.queues
        .list({
          order: "oldest",
          where: (queue) => queue.name.startsWith(String(input.QueueNamePrefix ?? "")),
        })
        .map(({ value }) => value.url)
      const offset = Number(input.NextToken ?? 0),
        max = Number(input.MaxResults ?? 1000)
      if (
        !Number.isInteger(max) ||
        max < 1 ||
        max > 1000 ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        return this.error("InvalidParameterValue", "Invalid pagination")
      return this.response({
        QueueUrls: queues.slice(offset, offset + max),
        ...(offset + max < queues.length ? { NextToken: String(offset + max) } : {}),
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
    if (!queue) return this.nonExistentQueue()
    this.expire(queue)
    if (target === "DeleteQueue") {
      for (const row of this.state.messages.list({
        where: (message) => message.queue === queue.name,
      }))
        this.state.messages.delete(row.id)
      for (const row of this.state.deduplications.list({
        where: (value) => value.queue === queue.name,
      }))
        this.state.deduplications.delete(row.id)
      this.state.queues.delete(queue.name)
      return this.response({})
    }
    if (target === "SetQueueAttributes") {
      const attributes = stringRecord(input.Attributes)
      if ("FifoQueue" in attributes)
        return this.error("InvalidAttributeName", "FifoQueue cannot be changed")
      const validation = this.validateAttributes(attributes, queue.name)
      if (validation) return validation
      this.state.queues.insert(queue.name, {
        ...queue,
        attributes: { ...queue.attributes, ...attributes },
        modifiedAt: this.now(),
      })
      return this.response({})
    }
    if (target === "TagQueue") {
      this.state.queues.insert(queue.name, {
        ...queue,
        tags: { ...queue.tags, ...stringRecord(input.Tags) },
      })
      return this.response({})
    }
    if (target === "UntagQueue") {
      const keys = Array.isArray(input.TagKeys) ? input.TagKeys : []
      this.state.queues.insert(queue.name, {
        ...queue,
        tags: Object.fromEntries(
          Object.entries(queue.tags ?? {}).filter(([key]) => !keys.includes(key)),
        ),
      })
      return this.response({})
    }
    if (target === "ListQueueTags") return this.response({ Tags: queue.tags ?? {} })
    if (target === "ListDeadLetterSourceQueues")
      return this.response({
        queueUrls: this.state.queues
          .list({
            where: (candidate) => {
              try {
                return (
                  JSON.parse(candidate.attributes.RedrivePolicy ?? "{}").deadLetterTargetArn ===
                  queue.arn
                )
              } catch {
                return false
              }
            },
          })
          .map(({ value }) => value.url),
      })
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
            where: (message) =>
              message.queue === queue.name &&
              message.visibleAt > this.now() &&
              message.receiveCount > 0,
          }).length,
        ),
        ApproximateNumberOfMessagesDelayed: String(
          this.state.messages.list({
            where: (message) =>
              message.queue === queue.name &&
              message.receiveCount === 0 &&
              message.visibleAt > this.now(),
          }).length,
        ),
        CreatedTimestamp: String(Math.floor(queue.createdAt / 1000)),
        LastModifiedTimestamp: String(Math.floor((queue.modifiedAt ?? queue.createdAt) / 1000)),
        ...queue.attributes,
      }
      return this.response({
        Attributes: names.includes("All")
          ? derived
          : Object.fromEntries(Object.entries(derived).filter(([name]) => names.includes(name))),
      })
    }
    if (target === "SendMessage") {
      if (!input.MessageBody)
        return this.error("MissingParameter", "The request must contain the parameter MessageBody.")
      try {
        return this.response(await this.enqueue(queue, input))
      } catch (error) {
        return this.error(
          "InvalidParameterValue",
          error instanceof Error ? error.message : "Invalid message",
        )
      }
    }
    if (
      ["SendMessageBatch", "DeleteMessageBatch", "ChangeMessageVisibilityBatch"].includes(target)
    ) {
      const invalid = this.validateBatch(input.Entries)
      if (invalid) return invalid
      const successful: unknown[] = []
      const failed: unknown[] = []
      for (const entry of Array.isArray(input.Entries) ? (input.Entries as Input[]) : []) {
        try {
          if (target === "SendMessageBatch")
            successful.push({ Id: String(entry.Id), ...(await this.enqueue(queue, entry)) })
          else {
            const response = this.receiptOperation(queue, entry, target === "DeleteMessageBatch")
            if (response) {
              const error = (await response.json()) as { __type: string; message: string }
              failed.push({
                Id: String(entry.Id),
                SenderFault: false,
                Code: error.__type,
                Message: error.message,
              })
            } else successful.push({ Id: String(entry.Id) })
          }
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
    if (target === "ReceiveMessage") {
      for (const [name, min, max] of [
        ["MaxNumberOfMessages", 1, 10],
        ["VisibilityTimeout", 0, 43200],
        ["WaitTimeSeconds", 0, 20],
      ] as const) {
        if (
          input[name] !== undefined &&
          (!Number.isInteger(input[name]) || Number(input[name]) < min || Number(input[name]) > max)
        )
          return this.error("InvalidParameterValue", `Invalid ${name}`)
      }
      return this.receiveHeld(queue.name, input, request.signal)
    }
    if (target === "DeleteMessage" || target === "ChangeMessageVisibility")
      return this.receiptOperation(queue, input, target === "DeleteMessage") ?? this.response({})
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
    return this.error("UnknownOperationException", `Unknown operation ${target}`)
  }
  private receiptOperation(queue: SqsQueue, input: Input, remove: boolean): Response | undefined {
    const message = this.byReceipt(queue, input.ReceiptHandle)
    if (!message)
      return this.error("ReceiptHandleIsInvalid", "The input receipt handle is invalid.")
    if (remove) this.state.messages.delete(message.id)
    else {
      const visibility = Number(input.VisibilityTimeout)
      if (!Number.isInteger(visibility) || visibility < 0 || visibility > 43200)
        return this.error("InvalidParameterValue", "Invalid VisibilityTimeout")
      if (message.visibleAt <= this.now())
        return this.error("MessageNotInflight", "Message is not in flight")
      this.state.messages.insert(message.id, {
        ...message,
        visibleAt: this.now() + visibility * 1000,
      })
      this.wake()
    }
    return undefined
  }
  private expire(queue: SqsQueue) {
    const cutoff = this.now() - Number(queue.attributes.MessageRetentionPeriod ?? 345600) * 1000
    for (const row of this.state.messages.list({
      where: (message) => message.queue === queue.name && message.sentAt < cutoff,
    }))
      this.state.messages.delete(row.id)
  }
  private validateAttributes(
    attributes: Record<string, string>,
    name: string,
  ): Response | undefined {
    const ranges: Record<string, [number, number]> = {
      DelaySeconds: [0, 900],
      VisibilityTimeout: [0, 43200],
      MaximumMessageSize: [1024, 1048576],
      MessageRetentionPeriod: [60, 1209600],
      ReceiveMessageWaitTimeSeconds: [0, 20],
      KmsDataKeyReusePeriodSeconds: [60, 86400],
    }
    const other = [
      "Policy",
      "RedrivePolicy",
      "RedriveAllowPolicy",
      "FifoQueue",
      "ContentBasedDeduplication",
      "KmsMasterKeyId",
      "SqsManagedSseEnabled",
      "DeduplicationScope",
      "FifoThroughputLimit",
    ]
    for (const [key, value] of Object.entries(attributes)) {
      const range = ranges[key]
      if (
        range &&
        (!Number.isInteger(Number(value)) || Number(value) < range[0] || Number(value) > range[1])
      )
        return this.error("InvalidAttributeValue", `Invalid value for ${key}`)
      if (!range && !other.includes(key))
        return this.error("InvalidAttributeName", `Unknown attribute ${key}`)
      if (
        ["FifoQueue", "ContentBasedDeduplication", "SqsManagedSseEnabled"].includes(key) &&
        !["true", "false"].includes(value)
      )
        return this.error("InvalidAttributeValue", `Invalid value for ${key}`)
      if (key === "ContentBasedDeduplication" && !name.endsWith(".fifo"))
        return this.error(
          "InvalidAttributeName",
          "ContentBasedDeduplication is only valid for FIFO queues",
        )
      if (["Policy", "RedrivePolicy", "RedriveAllowPolicy"].includes(key)) {
        try {
          JSON.parse(value)
        } catch {
          return this.error("InvalidAttributeValue", `Invalid JSON for ${key}`)
        }
      }
    }
    return undefined
  }
  private validateBatch(entries: unknown): Response | undefined {
    if (!Array.isArray(entries) || entries.length === 0)
      return this.error("EmptyBatchRequest", "The batch request doesn't contain any entries")
    if (entries.length > 10)
      return this.error(
        "TooManyEntriesInBatchRequest",
        "Maximum number of entries per request are 10",
      )
    const ids = entries.map((entry) => (entry as Input).Id)
    if (ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)))
      return this.error("InvalidBatchEntryId", "Invalid batch entry ID")
    if (new Set(ids).size !== ids.length)
      return this.error("BatchEntryIdsNotDistinct", "Two or more batch entries have the same Id")
    return undefined
  }
  private attributeSize(attributes: Record<string, SqsMessageAttribute>) {
    return Object.entries(attributes).reduce(
      (total, [name, attr]) =>
        total +
        new TextEncoder().encode(name + attr.DataType + (attr.StringValue ?? "")).length +
        (attr.BinaryValue ? atob(attr.BinaryValue).length : 0),
      0,
    )
  }
  private attributeMd5(attributes: Record<string, SqsMessageAttribute>): string | undefined {
    const entries = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (entries.length === 0) return undefined
    if (entries.length > 10) throw new TypeError("Maximum 10 message attributes")
    const bytes: number[] = []
    const append = (value: Uint8Array) => {
      const size = value.length
      bytes.push((size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...value)
    }
    const encoder = new TextEncoder()
    for (const [name, value] of entries) {
      if (
        !/^[a-zA-Z0-9_.-]{1,256}$/.test(name) ||
        /^(aws|amazon)\./i.test(name) ||
        name.startsWith(".") ||
        name.endsWith(".") ||
        name.includes("..")
      )
        throw new TypeError("Invalid message attribute name")
      const kind = value.DataType?.split(".")[0]
      if (!["String", "Number", "Binary"].includes(kind ?? ""))
        throw new TypeError("Invalid message attribute type")
      const binary = kind === "Binary"
      if (binary ? !value.BinaryValue : typeof value.StringValue !== "string" || !value.StringValue)
        throw new TypeError("Message attribute value is required")
      append(encoder.encode(name))
      append(encoder.encode(value.DataType))
      bytes.push(binary ? 2 : 1)
      append(
        binary
          ? Uint8Array.from(atob(value.BinaryValue ?? ""), (char) => char.charCodeAt(0))
          : encoder.encode(value.StringValue ?? ""),
      )
    }
    return md5(new Uint8Array(bytes))
  }
  private selectedAttributes(attributes: Record<string, SqsMessageAttribute>, names: unknown) {
    const requested = Array.isArray(names) ? names.map(String) : []
    const result = Object.fromEntries(
      Object.entries(attributes).filter(([name]) =>
        requested.some(
          (pattern) =>
            pattern === "All" ||
            pattern === ".*" ||
            pattern === name ||
            (pattern.endsWith(".*") && name.startsWith(pattern.slice(0, -1))),
        ),
      ),
    )
    return Object.keys(result).length ? result : undefined
  }
}
