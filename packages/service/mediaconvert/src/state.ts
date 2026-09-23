import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type MediaConvertJobStatus = "SUBMITTED" | "PROGRESSING" | "COMPLETE" | "ERROR" | "CANCELED"
export type OutputDetail = {
  durationInMs: number
  videoDetails?: { widthInPx: number; heightInPx: number }
}
export type OutputGroupDetail = {
  outputDetails: OutputDetail[]
  type: string
  playlistFilePaths?: string[]
}
export type MediaConvertJob = {
  id: string
  arn: string
  status: MediaConvertJobStatus
  createdAt: number
  queue: string
  role: string
  settings: Record<string, unknown>
  userMetadata?: Record<string, string>
  clientRequestToken?: string
  jobPercentComplete?: number
  outputGroupDetails?: OutputGroupDetail[]
  errorCode?: number
  errorMessage?: string
}
export class MediaConvertState {
  readonly jobs: Collection<MediaConvertJob>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.jobs = new Collection(sqlite, namespace, "mediaconvert_jobs")
    this.ids = new IdSequence(sqlite, namespace, "mediaconvert")
  }
}
