import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type AttributeValue = {
  S?: string
  N?: string
  B?: string
  BOOL?: boolean
  NULL?: boolean
  M?: Item
  L?: AttributeValue[]
  SS?: string[]
  NS?: string[]
  BS?: string[]
}
export type Item = Record<string, AttributeValue>
export type KeySchemaElement = { AttributeName: string; KeyType: "HASH" | "RANGE" }
export type DynamoIndex = {
  IndexName: string
  KeySchema: KeySchemaElement[]
  Projection?: Record<string, unknown>
}
export type DynamoTable = {
  name: string
  arn: string
  id: string
  createdAt: number
  keySchema: KeySchemaElement[]
  attributeDefinitions: { AttributeName: string; AttributeType: string }[]
  globalSecondaryIndexes: DynamoIndex[]
  ttlAttribute?: string
}
export type DynamoItem = { table: string; key: string; value: Item; updatedAt: number }
export type StreamRecord = {
  id: string
  table: string
  eventName: "INSERT" | "MODIFY" | "REMOVE"
  keys: Item
  oldImage?: Item
  newImage?: Item
  createdAt: number
}
export class DynamoState {
  readonly tables: Collection<DynamoTable>
  readonly items: Collection<DynamoItem>
  readonly streams: Collection<StreamRecord>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.tables = new Collection(sqlite, namespace, "dynamodb_tables")
    this.items = new Collection(sqlite, namespace, "dynamodb_items")
    this.streams = new Collection(sqlite, namespace, "dynamodb_streams")
    this.ids = new IdSequence(sqlite, namespace, "dynamodb")
  }
}
