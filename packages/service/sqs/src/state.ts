import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type SqsQueue = {
  name: string
  url: string
  arn: string
  attributes: Record<string, string>
  createdAt: number
  modifiedAt?: number
  tags?: Record<string, string>
  sequence?: number
  lastPurgeAt?: number
}
export type SqsMessageAttribute = { DataType: string; StringValue?: string; BinaryValue?: string }
export type SqsMessage = {
  id: string
  queue: string
  body: string
  md5: string
  sentAt: number
  visibleAt: number
  receiveCount: number
  firstReceivedAt?: number
  receiptHandle?: string
  /** Handles from earlier receives of this message, superseded by `receiptHandle`. */
  staleReceiptHandles?: string[]
  messageAttributes: Record<string, SqsMessageAttribute>
  groupId?: string
  deduplicationId?: string
  sequenceNumber?: string
  /** ARN of the queue whose redrive policy moved this message to its dead-letter queue. */
  deadLetterQueueSourceArn?: string
}
export type SqsDeduplication = {
  queue: string
  id: string
  messageId: string
  expiresAt: number
  sequenceNumber?: string
}

export class SqsState {
  readonly queues: Collection<SqsQueue>
  readonly messages: Collection<SqsMessage>
  readonly deduplications: Collection<SqsDeduplication>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.queues = new Collection(sqlite, namespace, "sqs_queues")
    this.messages = new Collection(sqlite, namespace, "sqs_messages")
    this.deduplications = new Collection(sqlite, namespace, "sqs_deduplications")
    this.ids = new IdSequence(sqlite, namespace, "sqs")
  }
}
