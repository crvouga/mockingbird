import {
  type APIOptions,
  bootSqlite,
  putObject,
  type S3Target,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  type MediaConvertJob,
  type MediaConvertJobStatus,
  MediaConvertState,
  type OutputGroupDetail,
} from "./state.js"

export type { MediaConvertRuntime, MediaConvertRuntimeOptions } from "./runtime.js"
export { createRuntime, MEDIACONVERT_PRESETS } from "./runtime.js"
export type { MediaConvertJob, MediaConvertJobStatus, OutputGroupDetail } from "./state.js"
export { document, operationIds, supportedOperationIds }
export const MEDIACONVERT_NAMESPACE = "mediaconvert"
export const accessKeyCredential = sigV4AccessKeyId

type Input = Record<string, unknown>
export type MediaConvertEvent = {
  version: "0"
  id: string
  "detail-type": "MediaConvert Job State Change"
  source: "aws.mediaconvert"
  account: string
  time: string
  region: string
  resources: string[]
  detail: Record<string, unknown>
}
export type MediaConvertAPIOptions = APIOptions & {
  region?: string
  accountId?: string
  endpoint?: string
  s3?: Omit<S3Target, "bucket">
  onEvent?: (event: MediaConvertEvent) => void
}
export type TransitionOptions = {
  progress?: number
  durationInMs?: number
  size?: number
  names?: string[]
  errorCode?: number
  errorMessage?: string
}
const encoder = new TextEncoder()

export class MediaConvertAPI {
  readonly state: MediaConvertState
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly region: string
  private readonly accountId: string
  private endpoint: string
  constructor(private readonly options: MediaConvertAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? MEDIACONVERT_NAMESPACE
    this.now = options.now ?? Date.now
    this.region = options.region ?? "us-east-1"
    this.accountId = options.accountId ?? "000000000000"
    this.endpoint = (options.endpoint ?? "http://127.0.0.1:8817").replace(/\/$/, "")
    this.state = new MediaConvertState(this.sqlite, this.namespace)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
  }
  setEndpoint(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, "")
  }
  private response(body: unknown, status = 200) {
    return Response.json(body, {
      status,
      headers: { "x-amzn-requestid": this.state.ids.next("req-", 20) },
    })
  }
  private error(name: string, message: string, status = 400) {
    return this.response({ __type: name, message }, status)
  }
  private publicJob(job: MediaConvertJob) {
    return {
      id: job.id,
      arn: job.arn,
      status: job.status,
      createdAt: job.createdAt / 1000,
      queue: job.queue,
      role: job.role,
      settings: job.settings,
      ...(job.userMetadata ? { userMetadata: job.userMetadata } : {}),
      ...(job.jobPercentComplete !== undefined
        ? { jobPercentComplete: job.jobPercentComplete }
        : {}),
      ...(job.outputGroupDetails ? { outputGroupDetails: job.outputGroupDetails } : {}),
      ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {}),
      ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    }
  }
  private destinations(settings: Record<string, unknown>) {
    const groups = Array.isArray(settings.outputGroups) ? settings.outputGroups : []
    return groups.flatMap((raw, index) => {
      if (!raw || typeof raw !== "object") return []
      const group = raw as Input
      const groupSettings = (group.outputGroupSettings ?? {}) as Input
      const hls = (groupSettings.hlsGroupSettings ?? {}) as Input
      const file = (groupSettings.fileGroupSettings ?? {}) as Input
      const destination = typeof hls.destination === "string" ? hls.destination : file.destination
      if (typeof destination !== "string" || !destination.startsWith("s3://")) return []
      return [
        {
          destination,
          type: typeof hls.destination === "string" ? "HLS_GROUP" : "FILE_GROUP",
          index,
        },
      ]
    })
  }
  private emit(job: MediaConvertJob) {
    this.options.onEvent?.({
      version: "0",
      id: this.state.ids.next("event-", 24),
      "detail-type": "MediaConvert Job State Change",
      source: "aws.mediaconvert",
      account: this.accountId,
      time: new Date(this.now()).toISOString(),
      region: this.region,
      resources: [job.arn],
      detail: {
        timestamp: this.now(),
        accountId: this.accountId,
        queue: job.queue,
        jobId: job.id,
        status: job.status,
        ...(job.jobPercentComplete !== undefined
          ? { jobProgress: { jobPercentComplete: job.jobPercentComplete } }
          : {}),
        ...(job.outputGroupDetails ? { outputGroupDetails: job.outputGroupDetails } : {}),
        ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {}),
        ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
        ...(job.userMetadata ? { userMetadata: job.userMetadata } : {}),
      },
    })
  }
  private async writeOutputs(job: MediaConvertJob, options: TransitionOptions) {
    const destinations = this.destinations(job.settings)
    if (!this.options.s3 || destinations.length === 0) return []
    const details: OutputGroupDetail[] = []
    for (const [groupIndex, output] of destinations.entries()) {
      const url = new URL(output.destination)
      const prefix = url.pathname.replace(/^\/+/, "")
      const defaults =
        output.type === "HLS_GROUP" ? ["index.m3u8", "segment-00001.ts"] : ["output.mp4"]
      const names = options.names?.length ? options.names : defaults
      const paths: string[] = []
      for (const name of names) {
        const key = `${prefix}${prefix && !prefix.endsWith("/") ? "/" : ""}${name}`
        const base =
          output.type === "HLS_GROUP" && name.endsWith(".m3u8")
            ? "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1.000,\nsegment-00001.ts\n#EXT-X-ENDLIST\n"
            : `mockingbird-mediaconvert:${job.id}:${groupIndex}:${name}`
        const requested = Math.max(0, options.size ?? encoder.encode(base).length)
        const bytes = encoder.encode(base.padEnd(requested, "0").slice(0, requested))
        await putObject(
          { ...this.options.s3, bucket: url.hostname },
          key,
          bytes,
          name.endsWith(".m3u8")
            ? "application/vnd.apple.mpegurl"
            : name.endsWith(".mp4")
              ? "video/mp4"
              : "video/mp2t",
        )
        paths.push(`s3://${url.hostname}/${key}`)
      }
      details.push({
        type: output.type,
        outputDetails: [{ durationInMs: options.durationInMs ?? 1000 }],
        playlistFilePaths: paths,
      })
    }
    return details
  }
  async transition(id: string, status: MediaConvertJobStatus, options: TransitionOptions = {}) {
    const current = this.state.jobs.get(id)
    if (!current || ["COMPLETE", "ERROR", "CANCELED"].includes(current.status)) return undefined
    const outputGroupDetails =
      status === "COMPLETE" ? await this.writeOutputs(current, options) : undefined
    const next: MediaConvertJob = {
      ...current,
      status,
      ...(options.progress !== undefined ? { jobPercentComplete: options.progress } : {}),
      ...(outputGroupDetails?.length ? { outputGroupDetails } : {}),
      ...(status === "ERROR"
        ? {
            errorCode: options.errorCode ?? 1040,
            errorMessage: options.errorMessage ?? "Mockingbird injected transcoding failure",
          }
        : {}),
    }
    this.state.jobs.insert(id, next)
    this.emit(next)
    return next
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/2017-08-29/endpoints")
      return this.response({ endpoints: [{ url: this.endpoint }] })
    if (request.method === "POST" && url.pathname === "/2017-08-29/jobs") {
      const input = (await request.json().catch(() => ({}))) as Input
      if (typeof input.role !== "string" || !input.role)
        return this.error("BadRequestException", "Role is required")
      if (!input.settings || typeof input.settings !== "object")
        return this.error("BadRequestException", "Settings are required")
      const settings = input.settings as Record<string, unknown>
      const inputs = Array.isArray(settings.inputs) ? settings.inputs : []
      if (
        !inputs.some(
          (item) =>
            item && typeof item === "object" && typeof (item as Input).fileInput === "string",
        )
      )
        return this.error("BadRequestException", "Settings must contain an S3 input")
      if (this.destinations(settings).length === 0)
        return this.error("BadRequestException", "Settings must contain an S3 output destination")
      const token =
        typeof input.clientRequestToken === "string" ? input.clientRequestToken : undefined
      const prior = token
        ? this.state.jobs
            .list({ where: (job) => job.clientRequestToken === token })
            .map(({ value }) => value)[0]
        : undefined
      if (prior) return this.response({ job: this.publicJob(prior) }, 201)
      const id = this.state.ids.next("job-", 24)
      const queue =
        typeof input.queue === "string"
          ? input.queue
          : `arn:aws:mediaconvert:${this.region}:${this.accountId}:queues/Default`
      const job: MediaConvertJob = {
        id,
        arn: `arn:aws:mediaconvert:${this.region}:${this.accountId}:jobs/${id}`,
        status: "SUBMITTED",
        createdAt: this.now(),
        queue,
        role: input.role,
        settings: structuredClone(settings),
        ...(input.userMetadata && typeof input.userMetadata === "object"
          ? { userMetadata: input.userMetadata as Record<string, string> }
          : {}),
        ...(token ? { clientRequestToken: token } : {}),
      }
      this.state.jobs.insert(id, job)
      this.emit(job)
      return this.response({ job: this.publicJob(job) }, 201)
    }
    const match = url.pathname.match(/^\/2017-08-29\/jobs\/([^/]+)$/)
    if (match) {
      const id = decodeURIComponent(match[1] as string)
      const job = this.state.jobs.get(id)
      if (!job) return this.error("NotFoundException", `Job ${id} was not found`, 404)
      if (request.method === "GET") return this.response({ job: this.publicJob(job) })
      if (request.method === "DELETE") {
        const moved = await this.transition(id, "CANCELED")
        return moved
          ? this.response({ job: this.publicJob(moved) }, 202)
          : this.error("ConflictException", `Job ${id} can no longer be canceled`, 409)
      }
    }
    return this.error("NotFoundException", "Unknown MediaConvert operation", 404)
  }
}
