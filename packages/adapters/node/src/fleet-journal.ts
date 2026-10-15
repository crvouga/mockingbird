import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { ArchiveRepository } from "./fleet-repository.js"
import { filesystemConditionalStore } from "./fleet-writer.js"

export type JournalRecord = {
  version: 1
  revision: number
  operationId: string
  controller: string
  namespace: string
  scope: string[]
  action: string
  phase:
    | "prepared"
    | "committing"
    | "uploading"
    | "publishing"
    | "succeeded"
    | "failed"
    | "recovery-required"
    | "resolved"
  timestamp: string
  requestFingerprint: string
  before?: string
  after?: string
  writerGeneration?: number
  resolution?: string
}
export type OperationJournal = {
  load(): Promise<JournalRecord[]>
  write(record: JournalRecord): Promise<void>
}
const validate = (record: JournalRecord) => {
  if (
    record?.version !== 1 ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    !/^[a-f0-9-]{36}$/.test(record.operationId) ||
    !Array.isArray(record.scope) ||
    record.scope.length > 1000 ||
    record.scope.some((ns) => !/^[A-Za-z0-9_.-]{1,64}$/.test(ns)) ||
    ![
      "prepared",
      "committing",
      "uploading",
      "publishing",
      "succeeded",
      "failed",
      "recovery-required",
      "resolved",
    ].includes(record.phase) ||
    [record.before, record.after].some((id) => id !== undefined && !/^[a-f0-9]{64}$/.test(id)) ||
    Object.keys(record).some(
      (key) =>
        ![
          "version",
          "revision",
          "operationId",
          "controller",
          "namespace",
          "scope",
          "action",
          "phase",
          "timestamp",
          "requestFingerprint",
          "before",
          "after",
          "writerGeneration",
          "resolution",
        ].includes(key),
    )
  )
    throw new Error("invalid durable operation metadata")
}
/** One fsynced CAS record per operation. Stale controllers cannot overwrite later reconciliation. */
export function filesystemOperationJournal(directory: string): OperationJournal {
  return {
    async load() {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const names = (await readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      if (names.length > 10000)
        throw new Error(
          "operation journal requires explicit archival before exceeding 10000 records",
        )
      const records: JournalRecord[] = []
      for (const name of names) {
        const record = (
          await filesystemConditionalStore<JournalRecord>(join(directory, name), {
            durable: true,
          }).read()
        )?.value
        if (!record) throw new Error("operation journal record disappeared")
        validate(record)
        records.push(record)
      }
      return records.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    },
    async write(record) {
      validate(record)
      const store = filesystemConditionalStore<JournalRecord>(
          join(directory, `${record.operationId}.json`),
          { durable: true },
        ),
        previous = await store.read()
      if (
        record.revision !== (previous?.value.revision ?? 0) + 1 ||
        !(await store.compareAndSwap(previous?.revision, record))
      )
        throw new Error("durable operation revision conflict")
    },
  }
}
export async function reconcileOperation(record: JournalRecord, repository: ArchiveRepository) {
  validate(record)
  if (["succeeded", "failed", "resolved"].includes(record.phase))
    return { status: "terminal" as const, operationId: record.operationId }
  if (record.phase === "prepared")
    return { status: "abandoned-before-commit" as const, operationId: record.operationId }
  if (record.after) {
    try {
      const archive = await repository.get(record.after),
        publication = await repository.publicationMetadata?.()
      if (
        archive.sha256 === record.after &&
        publication?.id === record.after &&
        record.writerGeneration !== undefined &&
        publication.generation === record.writerGeneration
      )
        return {
          status: "verified-publication" as const,
          operationId: record.operationId,
          archive: record.after,
        }
    } catch {
      /* missing or unverified objects require recovery, never a retry of the mutation */
    }
  }
  if (record.before)
    try {
      await repository.get(record.before)
    } catch {
      return {
        status: "recovery-required" as const,
        operationId: record.operationId,
        reason: "before-state archive unavailable",
        scope: record.scope,
      }
    }
  return {
    status: "recovery-required" as const,
    operationId: record.operationId,
    reason: "commit or rollback cannot be proven",
    scope: record.scope,
  }
}
