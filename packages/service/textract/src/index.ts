import { type APIOptions, bootSqlite, sigV4AccessKeyId } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  type TextractBlock,
  type TextractCorpus,
  type TextractJob,
  type TextractJobStatus,
  TextractState,
} from "./state.js"

export type { TextractRuntime, TextractRuntimeOptions } from "./runtime.js"
export { createRuntime, TEXTRACT_PRESETS } from "./runtime.js"
export type { TextractBlock, TextractCorpus, TextractJob, TextractJobStatus } from "./state.js"
export { document, operationIds, supportedOperationIds }
export const TEXTRACT_NAMESPACE = "textract"
export const accessKeyCredential = sigV4AccessKeyId
export type TextractNotification = {
  JobId: string
  Status: TextractJobStatus
  API: "StartDocumentAnalysis"
  JobTag?: string
  Timestamp: number
  DocumentLocation: { S3ObjectName: string; S3Bucket: string }
}
export type TextractAPIOptions = APIOptions & {
  corpora?: readonly TextractCorpus[]
  onNotification?: (notification: TextractNotification) => void
}
type Input = Record<string, unknown>
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value as Input)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
const copy = <T>(value: T): T => structuredClone(value)
const read = (input: Input, name: string) =>
  input[name] ??
  input[`${name[0]?.toUpperCase()}${name.slice(1)}`] ??
  Object.entries(input).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
const wire = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(wire)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Input).map(([key, item]) => [
      `${key[0]?.toUpperCase()}${key.slice(1)}`,
      wire(item),
    ]),
  )
}

export class TextractAPI {
  readonly state: TextractState
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  constructor(private readonly options: TextractAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? TEXTRACT_NAMESPACE
    this.now = options.now ?? Date.now
    this.state = new TextractState(this.sqlite, this.namespace)
    this.seed()
  }
  private seed() {
    for (const corpus of this.options.corpora ?? []) this.putCorpus(corpus)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  putCorpus(corpus: TextractCorpus) {
    const value = copy(corpus)
    this.state.corpora.insert(
      this.state.corpusId(corpus.bucket, corpus.name, corpus.version),
      value,
    )
    return value
  }
  private response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amzn-requestid": this.state.ids.next("req-", 20),
      },
    })
  }
  private error(type: string, message: string) {
    return this.response({ __type: type, message }, 400)
  }
  private s3(input: unknown) {
    if (!input || typeof input !== "object") return undefined
    const object = read(input as Input, "s3Object")
    if (!object || typeof object !== "object") return undefined
    const value = object as Input
    const bucket = read(value, "bucket")
    const name = read(value, "name")
    const version = read(value, "version")
    if (typeof bucket !== "string" || typeof name !== "string") return undefined
    return {
      bucket,
      name,
      ...(typeof version === "string" ? { version } : {}),
    }
  }
  private corpus(documentLocation: unknown) {
    const location = this.s3(documentLocation)
    if (!location) return undefined
    return this.state.corpora.get(
      this.state.corpusId(location.bucket, location.name, location.version),
    )
  }
  private notify(job: TextractJob) {
    if (job.status === "IN_PROGRESS" || !job.notificationChannel?.snsTopicArn) return
    this.options.onNotification?.({
      JobId: job.id,
      Status: job.status,
      API: "StartDocumentAnalysis",
      ...(job.jobTag ? { JobTag: job.jobTag } : {}),
      Timestamp: this.now(),
      DocumentLocation: {
        S3ObjectName: job.document.name,
        S3Bucket: job.document.bucket,
      },
    })
  }
  transition(
    id: string,
    status: Exclude<TextractJobStatus, "IN_PROGRESS">,
    statusMessage?: string,
  ) {
    const current = this.state.jobs.get(id)
    if (current?.status !== "IN_PROGRESS") return undefined
    const next: TextractJob = {
      ...current,
      status,
      ...(statusMessage ? { statusMessage } : {}),
    }
    this.state.jobs.insert(id, next)
    this.notify(next)
    return next
  }
  private result(input: {
    blocks: TextractBlock[]
    pages: number
    warnings?: Record<string, unknown>[]
    modelVersion: string
  }) {
    return {
      DocumentMetadata: { Pages: input.pages },
      Blocks: wire(copy(input.blocks)),
      AnalyzeDocumentModelVersion: input.modelVersion,
      ...(input.warnings?.length ? { Warnings: wire(copy(input.warnings)) } : {}),
    }
  }
  private token(jobId: string, offset: number) {
    return btoa(JSON.stringify({ jobId, offset }))
  }
  private parseToken(token: unknown, jobId: string) {
    if (token === undefined) return 0
    if (typeof token !== "string") return undefined
    try {
      const decoded = JSON.parse(atob(token)) as { jobId?: unknown; offset?: unknown }
      return decoded.jobId === jobId &&
        Number.isInteger(decoded.offset) &&
        Number(decoded.offset) >= 0
        ? Number(decoded.offset)
        : undefined
    } catch {
      return undefined
    }
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return this.error("InvalidParameterException", "Only POST is supported")
    const operation = (request.headers.get("x-amz-target") ?? "").split(".").at(-1) ?? ""
    const input = (await request.json().catch(() => ({}))) as Input
    if (operation === "AnalyzeDocument") {
      const featureTypesInput = read(input, "featureTypes")
      const featureTypes = Array.isArray(featureTypesInput) ? featureTypesInput : []
      if (!featureTypes.length)
        return this.error("InvalidParameterException", "FeatureTypes is required")
      const corpus = this.corpus(read(input, "document"))
      if (!corpus)
        return this.error("InvalidS3ObjectException", "Unable to access the requested S3 object")
      return this.response(
        this.result({
          blocks: corpus.blocks,
          pages:
            corpus.pages ?? Math.max(1, corpus.blocks.filter((b) => b.blockType === "PAGE").length),
          ...(corpus.warnings ? { warnings: corpus.warnings } : {}),
          modelVersion: corpus.modelVersion ?? "1.0",
        }),
      )
    }
    if (operation === "StartDocumentAnalysis") {
      const documentLocation = read(input, "documentLocation")
      const location = this.s3(documentLocation)
      if (!location)
        return this.error("InvalidParameterException", "DocumentLocation.S3Object is required")
      const featureTypesInput = read(input, "featureTypes")
      const featureTypes = Array.isArray(featureTypesInput)
        ? featureTypesInput.filter((item): item is string => typeof item === "string")
        : []
      if (!featureTypes.length)
        return this.error("InvalidParameterException", "FeatureTypes is required")
      const corpus = this.corpus(documentLocation)
      if (!corpus)
        return this.error("InvalidS3ObjectException", "Unable to access the requested S3 object")
      const requestShape = {
        documentLocation,
        featureTypes: featureTypesInput,
        jobTag: read(input, "jobTag"),
        notificationChannel: read(input, "notificationChannel"),
        outputConfig: read(input, "outputConfig"),
        kmsKeyId: read(input, "kmsKeyId"),
        adaptersConfig: read(input, "adaptersConfig"),
      }
      const fingerprint = stable(requestShape)
      const clientRequestToken =
        typeof read(input, "clientRequestToken") === "string"
          ? (read(input, "clientRequestToken") as string)
          : undefined
      const prior = clientRequestToken
        ? this.state.jobs
            .list({ where: (job) => job.clientRequestToken === clientRequestToken })
            .map(({ value }) => value)[0]
        : undefined
      if (prior)
        return prior.requestFingerprint === fingerprint
          ? this.response({ JobId: prior.id })
          : this.error(
              "IdempotentParameterMismatchException",
              "Parameters differ from the previous request with this ClientRequestToken",
            )
      const id = this.state.ids.next("job-", 48)
      const notification =
        read(input, "notificationChannel") && typeof read(input, "notificationChannel") === "object"
          ? (read(input, "notificationChannel") as Input)
          : undefined
      const job: TextractJob = {
        id,
        status: "IN_PROGRESS",
        document: location,
        featureTypes,
        requestFingerprint: fingerprint,
        blocks: copy(corpus.blocks),
        pages:
          corpus.pages ?? Math.max(1, corpus.blocks.filter((b) => b.blockType === "PAGE").length),
        ...(corpus.warnings ? { warnings: copy(corpus.warnings) } : {}),
        modelVersion: corpus.modelVersion ?? "1.0",
        ...(corpus.pageSize ? { pageSize: corpus.pageSize } : {}),
        ...(clientRequestToken ? { clientRequestToken } : {}),
        ...(typeof read(input, "jobTag") === "string"
          ? { jobTag: read(input, "jobTag") as string }
          : {}),
        ...(notification
          ? {
              notificationChannel: {
                ...(typeof read(notification, "roleArn") === "string"
                  ? { roleArn: read(notification, "roleArn") as string }
                  : {}),
                ...(typeof read(notification, "snsTopicArn") === "string"
                  ? { snsTopicArn: read(notification, "snsTopicArn") as string }
                  : {}),
              },
            }
          : {}),
        createdAt: this.now(),
      }
      this.state.jobs.insert(id, job)
      return this.response({ JobId: id })
    }
    if (operation === "GetDocumentAnalysis") {
      const jobId = read(input, "jobId")
      if (typeof jobId !== "string")
        return this.error("InvalidParameterException", "JobId is required")
      const job = this.state.jobs.get(jobId)
      if (!job) return this.error("InvalidJobIdException", "The specified JobId is invalid")
      if (job.status === "IN_PROGRESS") return this.response({ JobStatus: job.status })
      const offset = this.parseToken(read(input, "nextToken"), job.id)
      if (offset === undefined)
        return this.error("InvalidParameterException", "NextToken is invalid for this job")
      const requested = Number(read(input, "maxResults") ?? job.pageSize ?? 1000)
      if (!Number.isInteger(requested) || requested < 1 || requested > 1000)
        return this.error("InvalidParameterException", "MaxResults must be between 1 and 1000")
      const blocks = job.status === "FAILED" ? [] : job.blocks.slice(offset, offset + requested)
      const nextOffset = offset + blocks.length
      return this.response({
        JobStatus: job.status,
        ...(job.statusMessage ? { StatusMessage: job.statusMessage } : {}),
        ...this.result({
          blocks,
          pages: job.pages,
          ...(job.warnings ? { warnings: job.warnings } : {}),
          modelVersion: job.modelVersion,
        }),
        ...(job.status !== "FAILED" && nextOffset < job.blocks.length
          ? { NextToken: this.token(job.id, nextOffset) }
          : {}),
      })
    }
    return this.error("InvalidParameterException", `Unknown operation ${operation}`)
  }
}
