import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type TextractBlock = Record<string, unknown> & { id: string; blockType: string }
export type TextractCorpus = {
  bucket: string
  name: string
  version?: string
  blocks: TextractBlock[]
  pages?: number
  warnings?: Record<string, unknown>[]
  modelVersion?: string
  pageSize?: number
}
export type TextractJobStatus = "IN_PROGRESS" | "SUCCEEDED" | "PARTIAL_SUCCESS" | "FAILED"
export type TextractJob = {
  id: string
  status: TextractJobStatus
  document: { bucket: string; name: string; version?: string }
  featureTypes: string[]
  clientRequestToken?: string
  requestFingerprint: string
  jobTag?: string
  notificationChannel?: { roleArn?: string; snsTopicArn?: string }
  blocks: TextractBlock[]
  pages: number
  warnings?: Record<string, unknown>[]
  modelVersion: string
  pageSize?: number
  statusMessage?: string
  createdAt: number
}
export class TextractState {
  readonly corpora: Collection<TextractCorpus>
  readonly jobs: Collection<TextractJob>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.corpora = new Collection(sqlite, namespace, "textract_corpora")
    this.jobs = new Collection(sqlite, namespace, "textract_jobs")
    this.ids = new IdSequence(sqlite, namespace, "textract")
  }
  corpusId(bucket: string, name: string, version?: string) {
    return `${bucket}\0${name}\0${version ?? ""}`
  }
}
