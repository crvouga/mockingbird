import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type S3Target,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { accessKeyCredential, SPEECH_NAMESPACE, SpeechAPI } from "./index.js"
import type { Settings, TranscriptScript } from "./state.js"

const effect = (
  type: string,
  operationId: string,
  description: string,
  params: Record<string, unknown> = {},
): FaultPreset => ({
  description,
  rules: [{ operationId, effect: "speech_fault", params: { type, ...params } }],
})

/**
 * Every named Polly / Transcribe misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>", "count"?: n}`.
 */
export const SPEECH_PRESETS: Record<string, FaultPreset> = {
  polly_throttling: effect(
    "polly_throttling",
    "SynthesizeSpeech",
    "SynthesizeSpeech answers 429 ThrottlingException",
  ),
  polly_service_failure: effect(
    "polly_service_failure",
    "SynthesizeSpeech",
    "SynthesizeSpeech answers 500 ServiceFailureException",
  ),
  polly_stream_throttling: effect(
    "polly_stream_throttling",
    "StartSpeechSynthesisStream",
    "The speech stream opens, then a ThrottlingException event before any audio (our adapter falls back to SynthesizeSpeech)",
  ),
  polly_stream_validation: effect(
    "polly_stream_validation",
    "StartSpeechSynthesisStream",
    "A ValidationException event before any audio",
  ),
  polly_stream_quota: effect(
    "polly_stream_quota",
    "StartSpeechSynthesisStream",
    "A ServiceQuotaExceededException event before any audio",
  ),
  polly_stream_failure: effect(
    "polly_stream_failure",
    "StartSpeechSynthesisStream",
    "A ServiceFailureException event after the first text's audio",
    { afterEvents: 1 },
  ),
  polly_stream_no_close: effect(
    "polly_stream_no_close",
    "StartSpeechSynthesisStream",
    "Audio, but the stream ends without the required StreamClosedEvent",
  ),
  transcribe_bad_request: effect(
    "transcribe_bad_request",
    "StartStreamTranscription",
    "400 BadRequestException before the stream opens",
  ),
  transcribe_limit_exceeded: effect(
    "transcribe_limit_exceeded",
    "StartStreamTranscription",
    "429 LimitExceededException (concurrent stream limit)",
  ),
  transcribe_service_unavailable: effect(
    "transcribe_service_unavailable",
    "StartStreamTranscription",
    "503 ServiceUnavailableException",
  ),
  transcribe_mid_stream_failure: effect(
    "transcribe_mid_stream_failure",
    "StartStreamTranscription",
    "An InternalFailureException event after the first partial result",
    { afterEvents: 1 },
  ),
  transcribe_job_limit: effect(
    "transcribe_job_limit",
    "TranscribeJsonRpc",
    "StartTranscriptionJob answers LimitExceededException",
  ),
  transcribe_job_failed: effect(
    "transcribe_job_failed",
    "TranscribeJsonRpc",
    "The next started job is FAILED with a FailureReason",
  ),
}

export type SpeechRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /** Transcripts every namespace starts with (and returns to on reset). */
  transcripts?: readonly TranscriptScript[]
  /** Write completed batch transcripts into this S3 (the stack's s3rver); bucket = OutputBucketName. */
  transcriptStore?: Omit<S3Target, "bucket">
}

export type SpeechRuntime = ServiceRuntime<SpeechAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** `{match, partials, final}` (the catalog's single form), `{transcripts: [...]}`, or a list. */
const parseTranscripts = (body: unknown, existing: number): TranscriptScript[] | string => {
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.transcripts)
      ? body.transcripts
      : [body]
  const out: TranscriptScript[] = []
  for (const [index, each] of list.entries()) {
    const path = `transcripts[${index}]`
    if (!isRecord(each)) return `${path}: an object`
    if (typeof each.final !== "string") return `${path}.final: a string`
    if (
      each.partials !== undefined &&
      (!Array.isArray(each.partials) || each.partials.some((p) => typeof p !== "string"))
    ) {
      return `${path}.partials: string[]`
    }
    const match = each.match
    if (match !== undefined) {
      if (!isRecord(match)) return `${path}.match: {sessionIndex} | {jobName} | {any: true}`
      if (
        match.sessionIndex !== undefined &&
        (typeof match.sessionIndex !== "number" || match.sessionIndex < 0)
      ) {
        return `${path}.match.sessionIndex: a 0-based index`
      }
      if (match.jobName !== undefined && typeof match.jobName !== "string")
        return `${path}.match.jobName: a string`
    }
    if (each.times !== undefined && (typeof each.times !== "number" || each.times < 1))
      return `${path}.times: a positive count`
    out.push({
      ...(each as TranscriptScript),
      id: typeof each.id === "string" ? each.id : `transcript_${existing + index + 1}`,
    })
  }
  return out
}

const adminRoutes = (runtime: ServiceRuntime<SpeechAPI>): AdminRoutes => {
  const store =
    (replace: boolean): AdminRoutes[string] =>
    ({ body, namespace }) => {
      const api = runtime.instance(namespace)
      const parsed = parseTranscripts(body, replace ? 0 : api.state.scripts().length)
      if (typeof parsed === "string") return adminError(400, parsed)
      return json(200, { transcripts: api.state.put(parsed, replace) })
    }
  return {
    "GET /transcripts": ({ namespace }) => {
      const api = runtime.instance(namespace)
      return json(200, { transcripts: api.state.scripts(), stats: api.stats() })
    },
    "PUT /transcripts": store(true),
    "POST /transcripts": store(false),
    "DELETE /transcripts": ({ url, namespace }) =>
      json(200, {
        removed: runtime.instance(namespace).state.remove(url.searchParams.get("id") ?? undefined),
      }),
    "GET /jobs": ({ namespace }) => json(200, { jobs: runtime.instance(namespace).jobs() }),
    "POST /jobs/:name/complete": ({ params, body, namespace }) => {
      const transcript =
        isRecord(body) && typeof body.transcript === "string" ? body.transcript : undefined
      const job = runtime.instance(namespace).complete(params.name as string, transcript)
      return job ? json(200, job) : adminError(404, `no job ${params.name}`)
    },
    "POST /jobs/:name/fail": ({ params, body, namespace }) => {
      const reason =
        isRecord(body) && typeof body.reason === "string" ? body.reason : "The job failed."
      const job = runtime.instance(namespace).fail(params.name as string, reason)
      return job ? json(200, job) : adminError(404, `no job ${params.name}`)
    },
    "GET /jobs/:name/transcript": ({ params, namespace }) => {
      const api = runtime.instance(namespace)
      const job = api.jobs().find((j) => j.TranscriptionJobName === params.name)
      if (!job) return adminError(404, `no job ${params.name}`)
      if (job.TranscriptionJobStatus !== "COMPLETED")
        return adminError(409, `job ${params.name} is ${job.TranscriptionJobStatus}`)
      return json(200, api.transcriptDocument(job))
    },
    "GET /speech": ({ namespace }) =>
      json(200, { entries: runtime.instance(namespace).speechLog() }),
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      if (body.defaultTranscript !== undefined) {
        if (typeof body.defaultTranscript !== "string")
          return adminError(400, "defaultTranscript: string")
        patch.defaultTranscript = body.defaultTranscript
      }
      if (body.jobDurationMs !== undefined) {
        if (typeof body.jobDurationMs !== "number" || body.jobDurationMs < 0)
          return adminError(400, "jobDurationMs: ms ≥ 0")
        patch.jobDurationMs = body.jobDurationMs
      }
      const unknown = Object.keys(body).find(
        (key) => key !== "defaultTranscript" && key !== "jobDurationMs",
      )
      if (unknown) return adminError(400, `unknown setting ${unknown}`)
      return json(200, runtime.instance(namespace).state.update(patch))
    },
  }
}

/**
 * The Polly + Transcribe mock with Mockingbird's full service contract: `/health`,
 * `/__admin/*`, namespaces by header, by `/ns/<name>` prefix, or by SigV4 access key id
 * (`PUT /__admin/credentials {"credentials": {"<AWS_ACCESS_KEY_ID>": "<namespace>"}}`), the
 * mock clock (batch jobs complete on it), fault presets and a metadata-only journal.
 */
export const createRuntime = (options: SpeechRuntimeOptions = {}): SpeechRuntime =>
  createServiceRuntime<SpeechAPI>({
    name: SPEECH_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    presets: SPEECH_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new SpeechAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.transcripts ? { transcripts: options.transcripts } : {}),
        ...(options.transcriptStore ? { transcriptStore: options.transcriptStore } : {}),
      }),
    describe: () => ({
      transcripts: options.transcripts?.length ?? 0,
      transcriptStore: options.transcriptStore ? "on" : "off",
    }),
    admin: adminRoutes,
  })
