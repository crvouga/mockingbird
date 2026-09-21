import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  sha,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { analyzeAnthropic, analyzeConverse, analyzeHarness, ValidationProblem } from "./analyze.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type Plan, type PlanContext, planDefault, planTurn, truncatePlan } from "./plan.js"
import {
  anthropicBody,
  converseBody,
  converseStreamSteps,
  harnessSteps,
  paced,
  type Sleep,
} from "./render.js"
import {
  type CallAnalysis,
  type ModelOperation,
  matches,
  type Script,
  selectTurn,
  type TurnFault,
} from "./scripts.js"
import { sonicSession } from "./sonic.js"
import { BedrockState, type ModelStats, type Settings } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type {
  EventStreamMessage,
  HeaderValue,
  MessageInput,
} from "./eventstream.js"
export {
  crc32,
  decodeMessage,
  EventStreamError,
  encodeMessage,
  eventFrame,
  exceptionFrame,
  FrameReader,
  readFrames,
  unwrapSigned,
} from "./eventstream.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { Plan, PlanBlock, Usage } from "./plan.js"
export {
  DEFAULT_CHAT_TEXT,
  DEFAULT_CLASSIFIER,
  DEFAULT_SOAP_NOTE,
  GUARDRAIL_BLOCKED_TEXT,
} from "./plan.js"
export { sampleSchema } from "./schema-sample.js"
export type {
  ModelOperation,
  Script,
  ScriptMatch,
  ScriptToolUse,
  ScriptTurn,
  ScriptUsage,
  StopReason,
  TextMatch,
  TurnFault,
  TurnFaultType,
} from "./scripts.js"
export { MODEL_OPERATIONS, parseScript, STOP_REASONS, TURN_FAULTS } from "./scripts.js"
export type { ModelStats, Settings } from "./state.js"
export { DEFAULT_SETTINGS } from "./state.js"

export const BEDROCK_NAMESPACE = "bedrock"

/** The `x-amzn-ErrorType` suffix Bedrock puts after the error name. */
const ERROR_TYPE_SUFFIX = ":http://internal.amazon.com/coral/com.amazon.bedrock/"

/** The Titan embedding models (InvokeModel with `{inputText}`). */
const TITAN_EMBED = /amazon\.titan-embed-(text|g1-text)/i

/** `(status, x-amzn-ErrorType, default message)` for each pre-stream fault. */
const FAULT_ERRORS: Record<string, [number, string, string]> = {
  throttling: [429, "ThrottlingException", "Too many requests, please wait before trying again."],
  validation: [
    400,
    "ValidationException",
    "The input fails to satisfy the constraints specified by the service.",
  ],
  access_denied: [
    403,
    "AccessDeniedException",
    "You don't have access to the model with the specified model ID.",
  ],
  model_timeout: [
    408,
    "ModelTimeoutException",
    "Model has timed out in processing the request. Try your request again.",
  ],
  service_unavailable: [
    503,
    "ServiceUnavailableException",
    "Bedrock is unable to process your request.",
  ],
  internal_server: [
    500,
    "InternalServerException",
    "The system encountered an unexpected error during processing. Try your request again.",
  ],
}

/** A Bedrock error response: status, `x-amzn-ErrorType`, `{message}`. */
export const bedrockError = (
  status: number,
  type: string,
  message: string,
  requestId?: string,
): Response =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-amzn-errortype": `${type}${ERROR_TYPE_SUFFIX}`,
      ...(requestId ? { "x-amzn-requestid": requestId } : {}),
    },
  })

/** The fault a runtime preset switched on for this request (`effect: "bedrock_fault"`). */
const presetFault = (request: Request): TurnFault | undefined => {
  const params = faultEffect(request, "bedrock_fault")
  return params && typeof params.type === "string" ? (params as TurnFault) : undefined
}

/**
 * The namespace credential of an AWS request: its SigV4 access key id. Map it with
 * `PUT /__admin/credentials {"credentials": {"<AWS_ACCESS_KEY_ID>": "<namespace>"}}`.
 */
export const accessKeyCredential = sigV4AccessKeyId

/** Real-time sleep, for instances built without a runtime clock. */
const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })

/**
 * Wait `ms` on a (possibly frozen) mock clock: polls `now()` so a frozen clock waits until
 * a test advances it, and a live clock waits in real time.
 */
export const clockSleep =
  (now: () => number): Sleep =>
  (ms, signal) => {
    if (ms <= 0) return Promise.resolve()
    const until = now() + ms
    return new Promise((resolve) => {
      const tick = () => {
        if (signal?.aborted || now() >= until) return resolve()
        setTimeout(tick, Math.min(5, Math.max(1, until - now())))
      }
      tick()
    })
  }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const utf8 = new TextEncoder()

/** A deterministic 1024-d (or `dims`-d) unit vector: SHA-256(inputText) in counter mode. */
export const titanEmbedding = async (inputText: string, dims = 1024): Promise<number[]> => {
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(inputText)))
  const values: number[] = []
  for (let block = 0; values.length < dims; block++) {
    const input = new Uint8Array(seed.length + 4)
    input.set(seed)
    new DataView(input.buffer).setUint32(seed.length, block, false)
    const digest = new DataView(await crypto.subtle.digest("SHA-256", input))
    for (let at = 0; at + 4 <= 32 && values.length < dims; at += 4) {
      values.push((digest.getUint32(at, false) / 0xffffffff) * 2 - 1)
    }
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1
  return values.map((v) => v / norm)
}

export type BedrockAPIOptions = APIOptions & {
  /** Initial per-namespace settings. */
  settings?: Partial<Settings>
  /** Scripts every namespace starts with (re-applied on reset). */
  scripts?: readonly Script[]
  /** Wait on the mock clock. Default: real time. */
  sleep?: Sleep
}

/**
 * Stateful, scriptable mock of Amazon Bedrock Runtime (and the AgentCore harness).
 *
 * It never generates language: each model call is answered by the first script whose
 * `match` accepts it and that has a turn for this point in the conversation, or by an
 * unscripted default (counted as `unscripted`). Every answer can be rendered as a Converse
 * body, a ConverseStream event stream, an Anthropic Messages body, a harness stream or a
 * Nova Sonic session.
 */
export class BedrockAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: BedrockState
  private readonly service: Service
  private readonly now: () => number
  private readonly sleep: Sleep

  constructor(options: BedrockAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? BEDROCK_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? realSleep
    this.state = new BedrockState(sqlite, namespace, {
      settings: options.settings ?? {},
      scripts: options.scripts ?? [],
    })
    const handlers = defineOperations<SupportedOperationId>({
      Converse: (context) => this.converse(context, false),
      ConverseStream: (context) => this.converse(context, true),
      InvokeModel: (context) => this.invokeModel(context),
      // Served by `fetch` before routing, so the duplex body is never buffered.
      InvokeModelWithBidirectionalStream: (context) =>
        this.bidirectional(context.request, context.params.modelId ?? ""),
      InvokeHarness: (context) => this.invokeHarness(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) =>
        bedrockError(
          404,
          "UnknownOperationException",
          `No operation matches ${request.method} ${new URL(request.url).pathname}`,
        ),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        if (error instanceof ValidationProblem)
          return bedrockError(400, "ValidationException", error.message)
        throw error
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const bidi = /^\/model\/([^/]+)\/invoke-with-bidirectional-stream\/?$/.exec(path)
    if (bidi && request.method === "POST") {
      return this.bidirectional(request, decodeURIComponent(bidi[1] as string))
    }
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  // ── admin surface ───────────────────────────────────────────────

  scripts(): Script[] {
    return this.state.list()
  }

  putScripts(scripts: readonly Script[], replace = true): Script[] {
    return this.state.put(scripts, replace)
  }

  removeScripts(id?: string): number {
    return this.state.remove(id)
  }

  stats(): ModelStats {
    return this.state.currentStats()
  }

  // ── shared machinery ────────────────────────────────────────────

  private requestId(): string {
    const hex = opaqueToken(`request:${this.state.ids.next("rq_", 8)}`, 32)
      .split("")
      .map((c) => (c.charCodeAt(0) % 16).toString(16))
      .join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  }

  private planContext(body: Record<string, unknown>, maxTokens: number | undefined): PlanContext {
    const settings = this.state.current()
    const guardrail = isRecord(body.guardrailConfig) ? body.guardrailConfig : undefined
    return {
      nextToolUseId: () => this.state.ids.next("tooluse_", 22),
      chunkSize: settings.chunkSize,
      delayMsPerChunk: settings.delayMsPerChunk,
      ...(typeof guardrail?.guardrailIdentifier === "string"
        ? { guardrailId: guardrail.guardrailIdentifier }
        : {}),
      traceEnabled: guardrail?.trace === "enabled" || guardrail?.trace === "enabled_full",
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    }
  }

  /**
   * First script with a turn for this call, else the default (which `unscripted` may
   * replace with an operation-specific one); records stats either way.
   */
  private async resolve(
    call: CallAnalysis,
    context: PlanContext,
    unscripted: (plan: Plan) => Plan = (plan) => plan,
  ): Promise<Plan> {
    const callIndex = this.state.nextCallIndex()
    const systemHash = await sha("SHA-256", call.systemText)
    for (const script of this.state.list()) {
      if (script.times !== undefined && this.state.usesOf(script.id) >= script.times) continue
      if (!matches(script.match, call, { systemHash, callIndex })) continue
      const turn = selectTurn(script, call)
      if (!turn) continue
      this.state.use(script.id)
      this.state.record(call.operation, script.id, undefined)
      return planTurn(script.id, turn, call, context)
    }
    const plan = unscripted(planDefault(call, context, this.state.current().defaultText))
    this.state.record(call.operation, undefined, plan.fallback)
    return plan
  }

  /** Journal notes: metadata only (never message or prompt text). */
  private notes(response: Response, call: CallAnalysis, plan: Plan | undefined): Response {
    const flags = [
      call.hasCachePoint ? "cachePoint" : undefined,
      call.hasGuardrail ? "guardrail" : undefined,
      call.hasDocument ? "document" : undefined,
      call.hasImage ? "image" : undefined,
      call.structured ? `structured:${call.structured.form}` : undefined,
    ].filter((f): f is string => f !== undefined)
    return annotateResponse(response, {
      ids: {
        modelId: call.modelId,
        script: plan?.scriptId ?? `unscripted:${plan?.fallback ?? "chat"}`,
        ...(call.tools.length > 0 ? { tools: call.tools.join(",") } : {}),
        ...(flags.length > 0 ? { flags: flags.join(",") } : {}),
        ...(plan
          ? {
              stopReason: plan.stopReason,
              inputTokens: String(plan.usage.inputTokens),
              outputTokens: String(plan.usage.outputTokens),
            }
          : {}),
      },
    })
  }

  private jsonBody(context: OperationContext): unknown {
    const body = context.body
    if (body.kind === "json") return body.value
    if (body.kind === "bytes" || body.kind === "text") {
      try {
        return JSON.parse(
          body.kind === "text" ? body.value : new TextDecoder().decode(body.value),
        ) as unknown
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /** A pre-stream fault as the vendor's error, or `undefined` to carry on. */
  private async preStream(
    fault: TurnFault | undefined,
    requestId: string,
    signal: AbortSignal,
    streaming: boolean,
  ): Promise<Response | undefined> {
    if (!fault) return undefined
    if (fault.type === "latency") {
      await this.sleep(fault.latencyMs ?? 1_000, signal)
      return undefined
    }
    const known = FAULT_ERRORS[fault.type]
    if (known) return bedrockError(known[0], known[1], fault.message ?? known[2], requestId)
    if (!streaming && (fault.type === "mid_stream_exception" || fault.type === "truncated_frame")) {
      const [status, type, message] = FAULT_ERRORS.internal_server as [number, string, string]
      return bedrockError(status, type, fault.message ?? message, requestId)
    }
    return undefined
  }

  private eventStream(body: ReadableStream<Uint8Array>, requestId: string): Response {
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/vnd.amazon.eventstream",
        "x-amzn-requestid": requestId,
      },
    })
  }

  // ── operations ──────────────────────────────────────────────────

  private async converse(context: OperationContext, streaming: boolean): Promise<Response> {
    const requestId = this.requestId()
    const operation: ModelOperation = streaming ? "ConverseStream" : "Converse"
    const modelId = context.params.modelId ?? ""
    const body = this.jsonBody(context)
    if (!isRecord(body)) {
      return bedrockError(
        400,
        "ValidationException",
        "Malformed input request, please reformat your input and try again.",
        requestId,
      )
    }
    const issues = bodyIssues(context).filter(
      (issue) => issue.message !== "request body is not valid application/json",
    )
    if (issues.length > 0) {
      const first = issues[0] as { path: string; message: string }
      return bedrockError(
        400,
        "ValidationException",
        `${issues.length} validation error${issues.length > 1 ? "s" : ""} detected: Value at '${first.path || "body"}' failed to satisfy constraint: ${first.message}`,
        requestId,
      )
    }
    let call: CallAnalysis
    try {
      call = analyzeConverse(operation, modelId, body)
    } catch (error) {
      if (error instanceof ValidationProblem)
        return bedrockError(400, "ValidationException", error.message, requestId)
      throw error
    }
    const inference = isRecord(body.inferenceConfig) ? body.inferenceConfig : {}
    const maxTokens = typeof inference.maxTokens === "number" ? inference.maxTokens : undefined
    let plan = await this.resolve(call, this.planContext(body, maxTokens))
    const fault = presetFault(context.request) ?? plan.fault
    if (fault?.type === "max_tokens") plan = truncatePlan(plan)
    const failed = await this.preStream(fault, requestId, context.request.signal, streaming)
    if (failed) return this.notes(failed, call, plan)
    if (!streaming) {
      return this.notes(
        jsonRes(200, converseBody(plan, 0), { "x-amzn-requestid": requestId }),
        call,
        plan,
      )
    }
    const stream = paced(converseStreamSteps(plan, 0), {
      sleep: this.sleep,
      delayMsPerChunk: plan.delayMsPerChunk,
      fault,
      defaultException: "modelStreamErrorException",
      signal: context.request.signal,
    })
    return this.notes(this.eventStream(stream, requestId), call, plan)
  }

  private async invokeModel(context: OperationContext): Promise<Response> {
    const requestId = this.requestId()
    const modelId = context.params.modelId ?? ""
    const body = this.jsonBody(context)
    if (!isRecord(body)) {
      return bedrockError(
        400,
        "ValidationException",
        "Malformed input request, please reformat your input and try again.",
        requestId,
      )
    }
    if (TITAN_EMBED.test(modelId)) return this.titan(context, modelId, body, requestId)
    if (!/anthropic|claude/i.test(modelId)) {
      return bedrockError(
        400,
        "ValidationException",
        "The provided model identifier is invalid.",
        requestId,
      )
    }
    let call: CallAnalysis
    try {
      call = analyzeAnthropic(modelId, body)
    } catch (error) {
      if (error instanceof ValidationProblem)
        return bedrockError(400, "ValidationException", error.message, requestId)
      throw error
    }
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined
    let plan = await this.resolve(call, this.planContext(body, maxTokens))
    const fault = presetFault(context.request) ?? plan.fault
    if (fault?.type === "max_tokens") plan = truncatePlan(plan)
    const failed = await this.preStream(fault, requestId, context.request.signal, false)
    if (failed) return this.notes(failed, call, plan)
    return this.notes(
      jsonRes(200, anthropicBody(plan, modelId, `msg_bdrk_${this.state.ids.next("", 24)}`), {
        "x-amzn-requestid": requestId,
        "x-amzn-bedrock-input-token-count": String(plan.usage.inputTokens),
        "x-amzn-bedrock-output-token-count": String(plan.usage.outputTokens),
        "x-amzn-bedrock-invocation-latency": "0",
      }),
      call,
      plan,
    )
  }

  private async titan(
    context: OperationContext,
    modelId: string,
    body: Record<string, unknown>,
    requestId: string,
  ): Promise<Response> {
    const v2 = /v2/i.test(modelId)
    const inputText = body.inputText
    if (typeof inputText !== "string" || inputText.length === 0) {
      return bedrockError(
        400,
        "ValidationException",
        "Malformed input request: #/inputText: expected minLength: 1, actual: 0, please reformat your input and try again.",
        requestId,
      )
    }
    const dimensions = body.dimensions ?? (v2 ? 1024 : 1536)
    if (v2 && ![256, 512, 1024].includes(dimensions as number)) {
      return bedrockError(
        400,
        "ValidationException",
        `Malformed input request: #/dimensions: ${String(dimensions)} is not a valid enum value, please reformat your input and try again.`,
        requestId,
      )
    }
    this.state.nextCallIndex()
    this.state.record("InvokeModel", undefined, "titan")
    const fault = presetFault(context.request)
    const failed = await this.preStream(fault, requestId, context.request.signal, false)
    const inputTextTokenCount = Math.max(1, Math.ceil(inputText.length / 4))
    const notes = (response: Response) =>
      annotateResponse(response, {
        ids: { modelId, script: "unscripted:titan", inputTokens: String(inputTextTokenCount) },
      })
    if (failed) return notes(failed)
    const embedding = await titanEmbedding(inputText, dimensions as number)
    return notes(
      jsonRes(
        200,
        {
          embedding,
          inputTextTokenCount,
          ...(Array.isArray(body.embeddingTypes) ? { embeddingsByType: { float: embedding } } : {}),
        },
        {
          "x-amzn-requestid": requestId,
          "x-amzn-bedrock-input-token-count": String(inputTextTokenCount),
          "x-amzn-bedrock-invocation-latency": "0",
        },
      ),
    )
  }

  private async invokeHarness(context: OperationContext): Promise<Response> {
    const requestId = this.requestId()
    const harnessArn = context.url.searchParams.get("harnessArn") ?? ""
    if (!harnessArn) {
      return bedrockError(
        400,
        "ValidationException",
        "1 validation error detected: Value null at 'harnessArn' failed to satisfy constraint: Member must not be null",
        requestId,
      )
    }
    const body = this.jsonBody(context)
    let call: CallAnalysis
    try {
      call = analyzeHarness(harnessArn, body)
    } catch (error) {
      if (error instanceof ValidationProblem)
        return bedrockError(400, "ValidationException", error.message, requestId)
      throw error
    }
    let plan = await this.resolve(call, this.planContext({}, undefined), (fallback) =>
      this.harnessDefault(call, fallback),
    )
    const fault = presetFault(context.request) ?? plan.fault
    if (fault?.type === "max_tokens") plan = truncatePlan(plan)
    const failed = await this.preStream(fault, requestId, context.request.signal, true)
    if (failed) return this.notes(failed, call, plan)
    const stream = paced(harnessSteps(plan, 0), {
      sleep: this.sleep,
      delayMsPerChunk: plan.delayMsPerChunk,
      fault,
      defaultException: "internalServerException",
      signal: context.request.signal,
    })
    const response = this.eventStream(stream, requestId)
    const session = context.request.headers.get("x-amzn-bedrock-agentcore-runtime-session-id")
    if (session) response.headers.set("x-amzn-bedrock-agentcore-runtime-session-id", session)
    return this.notes(response, call, plan)
  }

  /** The unscripted eRx prescreen answer: eligible for clinician review. */
  private harnessDefault(call: CallAnalysis, plan: Plan): Plan {
    let productKey = "unknown"
    try {
      const parsed = JSON.parse(call.lastUserText) as { product_key?: unknown }
      if (typeof parsed.product_key === "string") productKey = parsed.product_key
    } catch {
      // not the prescreen payload: keep the generic key
    }
    const summary = {
      status: "eligible_for_clinician_review",
      summary: "Mock prescreen: no hard stops found; ready for clinician review.",
      narrative: "Generated by the Mockingbird Bedrock mock. No clinical rules were evaluated.",
      protocolVersion: `${productKey}-mock-1`,
      ranAt: new Date(this.now()).toISOString(),
      hardStops: [],
      cautions: [],
      missingData: [],
    }
    return {
      ...plan,
      fallback: "harness",
      blocks: [{ kind: "text", text: JSON.stringify(summary) }],
      stopReason: "end_turn",
    }
  }

  private async bidirectional(request: Request, modelId: string): Promise<Response> {
    const requestId = this.requestId()
    if (!/sonic/i.test(modelId)) {
      return bedrockError(
        400,
        "ValidationException",
        `The model ${modelId} does not support bidirectional streaming.`,
        requestId,
      )
    }
    const fault = presetFault(request)
    if (fault && FAULT_ERRORS[fault.type]) {
      const failed = await this.preStream(fault, requestId, request.signal, true)
      if (failed) return annotateResponse(failed, { ids: { modelId } })
    }
    const settings = this.state.current()
    const body = sonicSession(request, modelId, {
      resolve: (call) =>
        this.resolve(
          call,
          {
            nextToolUseId: () => this.state.ids.next("tooluse_", 22),
            chunkSize: settings.chunkSize,
            delayMsPerChunk: settings.delayMsPerChunk,
            traceEnabled: false,
          },
          (plan) => ({ ...plan, fallback: "sonic" }),
        ),
      sleep: this.sleep,
      nextId: (prefix) => {
        const hex = opaqueToken(`${prefix}:${this.state.ids.next(`${prefix}_`, 8)}`, 32)
          .split("")
          .map((c) => (c.charCodeAt(0) % 16).toString(16))
          .join("")
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
      },
      audioTurnChunks: settings.audioTurnChunks,
      ...(fault && !FAULT_ERRORS[fault.type] ? { fault } : {}),
    })
    return annotateResponse(this.eventStream(body, requestId), { ids: { modelId } })
  }
}

export type { BedrockRuntime, BedrockRuntimeOptions } from "./runtime.js"
export { BEDROCK_PRESETS, createRuntime } from "./runtime.js"
