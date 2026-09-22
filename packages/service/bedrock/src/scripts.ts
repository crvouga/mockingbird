/**
 * The scripting model: the mock never generates language, it replays scripts.
 *
 * A script is a `match` (which model calls it answers) and a sequence of `turns`. The turn
 * a call gets is read off the conversation itself, not from server state: it is the number
 * of assistant messages since the member last said something (a user message with any
 * content other than tool results). So the first call of a user turn gets turn 0, the call
 * that resumes after a `toolResult` gets turn 1, and a new conversation starts over — with
 * no bookkeeping that parallel workers or retries could skew.
 *
 * Only metadata is derived from a request (tool names, flags, a SHA-256 of the system
 * prompt); prompt and message text are read for matching and never stored.
 */

/** Operations a script can answer. */
export const MODEL_OPERATIONS = [
  "Converse",
  "ConverseStream",
  "InvokeModel",
  "InvokeModelWithBidirectionalStream",
  "InvokeHarness",
] as const
export type ModelOperation = (typeof MODEL_OPERATIONS)[number]

export const STOP_REASONS = [
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "guardrail_intervened",
  "content_filtered",
] as const
export type StopReason = (typeof STOP_REASONS)[number]

/** Failure modes a turn (or a fault preset) can inject. */
export const TURN_FAULTS = [
  "throttling",
  "validation",
  "access_denied",
  "model_timeout",
  "service_unavailable",
  "internal_server",
  "mid_stream_exception",
  "max_tokens",
  "truncated_frame",
  "latency",
] as const
export type TurnFaultType = (typeof TURN_FAULTS)[number]

export type TurnFault = {
  type: TurnFaultType
  /** Error / exception message. Each type has a realistic default. */
  message?: string
  /** `mid_stream_exception` / `truncated_frame`: content chunks sent before the failure. Default 1. */
  afterChunks?: number
  /** `mid_stream_exception`: the exception frame's type. Default `modelStreamErrorException`. */
  exceptionType?: string
  /** `latency`: mock-clock milliseconds before the response starts. */
  latencyMs?: number
}

export type ScriptToolUse = {
  name: string
  input?: unknown
  /** Default: a deterministic `tooluse_…` id. */
  toolUseId?: string
}

export type ScriptUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

export type ScriptTurn = {
  /** Assistant text, streamed in `chunkSize`-character deltas. */
  text?: string
  chunkSize?: number
  /** Mock-clock delay before each streamed chunk (TTFT and pacing tests). */
  delayMsPerChunk?: number
  /** Reasoning text streamed as `reasoningContent` before the answer. */
  reasoning?: string
  toolUse?: ScriptToolUse | ScriptToolUse[]
  /** Structured output, rendered in whichever form the request asked for. */
  json?: unknown
  stopReason?: StopReason
  /** `true`, or the trace / blocked text, for a `guardrail_intervened` turn. */
  guardrail?: boolean | { text?: string; trace?: unknown }
  usage?: ScriptUsage
  /** This turn only answers a call whose last user message carries this tool's result. */
  expectToolResult?: { name: string }
  fault?: TurnFaultType | TurnFault
  /** Nova Sonic: the ASR transcript echoed back for a spoken user turn. */
  userTranscript?: string
  /** AgentCore InvokeHarness: a tool-result delta (`[{text}|{json}]`) instead of text. */
  toolResult?: unknown[]
}

export type TextMatch = { contains?: string; regex?: string; flags?: string }

export type ScriptMatch = {
  /** Glob (`*` wildcard, case-insensitive) over the decoded model id, ARN or harness ARN. */
  modelId?: string
  operation?: ModelOperation | ModelOperation[]
  lastUserText?: string | TextMatch
  /** SHA-256 hex of the system prompt (text blocks joined with "\n"). */
  systemHash?: string
  toolsInclude?: string[]
  /** `auto`, `any`, `none`, or a forced tool's name. */
  toolChoice?: string
  hasDocument?: boolean
  hasImage?: boolean
  /** 0-based index of this call among the namespace's model calls. */
  callIndex?: number
}

export type Script = {
  id: string
  match?: ScriptMatch
  turns: ScriptTurn[]
  /** Stop matching after this many calls (counted per namespace). */
  times?: number
}

/** What a model call looks like to the matcher. Never stored or logged. */
export type CallAnalysis = {
  operation: ModelOperation
  modelId: string
  lastUserText: string
  systemText: string
  tools: string[]
  toolSchemas: Record<string, unknown>
  /** `auto` | `any` | `none` | `tool:<name>` | undefined. */
  toolChoice: string | undefined
  hasDocument: boolean
  hasImage: boolean
  hasCachePoint: boolean
  hasGuardrail: boolean
  /** Tool names whose results the last user message carries. */
  toolResults: string[]
  turnIndex: number
  structured: StructuredRequest | undefined
  /** Characters of input, for deterministic token estimates. */
  inputChars: number
}

/** How a request asked for structured output. */
export type StructuredRequest =
  | { form: "outputConfig"; schema: unknown; name?: string }
  | { form: "outputFormat"; schema: unknown }
  | { form: "tool"; tool: string; schema: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const escapeGlob = (value: string) =>
  new RegExp(
    `^${value
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  )

/** Whether `modelId` matches the glob `pattern`. */
export const globMatch = (pattern: string, modelId: string): boolean =>
  escapeGlob(pattern).test(modelId)

const textMatches = (rule: string | TextMatch, value: string): boolean => {
  if (typeof rule === "string") return value.toLowerCase().includes(rule.toLowerCase())
  if (rule.contains !== undefined && !value.toLowerCase().includes(rule.contains.toLowerCase())) {
    return false
  }
  if (rule.regex !== undefined && !new RegExp(rule.regex, rule.flags ?? "i").test(value))
    return false
  return true
}

/** Whether a script's `match` accepts this call (turn selection is separate). */
export const matches = (
  match: ScriptMatch | undefined,
  call: CallAnalysis,
  context: { systemHash: string; callIndex: number },
): boolean => {
  if (!match) return true
  if (match.modelId !== undefined && !globMatch(match.modelId, call.modelId)) return false
  if (match.operation !== undefined) {
    const ops = Array.isArray(match.operation) ? match.operation : [match.operation]
    if (!ops.includes(call.operation)) return false
  }
  if (match.lastUserText !== undefined && !textMatches(match.lastUserText, call.lastUserText)) {
    return false
  }
  if (match.systemHash !== undefined && match.systemHash.toLowerCase() !== context.systemHash) {
    return false
  }
  if (match.toolsInclude?.some((name) => !call.tools.includes(name))) return false
  if (match.toolChoice !== undefined) {
    const want = ["auto", "any", "none"].includes(match.toolChoice)
      ? match.toolChoice
      : `tool:${match.toolChoice}`
    if ((call.toolChoice ?? "auto") !== want) return false
  }
  if (match.hasDocument !== undefined && match.hasDocument !== call.hasDocument) return false
  if (match.hasImage !== undefined && match.hasImage !== call.hasImage) return false
  if (match.callIndex !== undefined && match.callIndex !== context.callIndex) return false
  return true
}

/** The turn a matching script plays for this call, or `undefined` when it has none left. */
export const selectTurn = (script: Script, call: CallAnalysis): ScriptTurn | undefined => {
  const turn = script.turns[call.turnIndex]
  if (!turn) return undefined
  if (turn.expectToolResult && !call.toolResults.includes(turn.expectToolResult.name)) {
    return undefined
  }
  return turn
}

// ── validation of PUT /__admin/scripts ─────────────────────────────

const fail = (path: string, message: string) => `${path}: ${message}`

const checkTurn = (turn: unknown, path: string): string | undefined => {
  if (!isRecord(turn)) return fail(path, "a turn is an object")
  const known = new Set([
    "text",
    "chunkSize",
    "delayMsPerChunk",
    "reasoning",
    "toolUse",
    "json",
    "stopReason",
    "guardrail",
    "usage",
    "expectToolResult",
    "fault",
    "userTranscript",
    "toolResult",
  ])
  for (const key of Object.keys(turn)) {
    if (!known.has(key)) return fail(`${path}.${key}`, "unknown turn field")
  }
  if (turn.text !== undefined && typeof turn.text !== "string")
    return fail(`${path}.text`, "string")
  for (const key of ["chunkSize", "delayMsPerChunk"] as const) {
    const value = turn[key]
    if (
      value !== undefined &&
      (typeof value !== "number" || value < (key === "chunkSize" ? 1 : 0))
    ) {
      return fail(`${path}.${key}`, key === "chunkSize" ? "a positive number" : "ms ≥ 0")
    }
  }
  if (turn.toolUse !== undefined) {
    const uses = Array.isArray(turn.toolUse) ? turn.toolUse : [turn.toolUse]
    for (const [i, use] of uses.entries()) {
      if (!isRecord(use) || typeof use.name !== "string" || use.name === "") {
        return fail(`${path}.toolUse[${i}]`, "needs a name")
      }
    }
  }
  if (turn.stopReason !== undefined && !STOP_REASONS.includes(turn.stopReason as StopReason)) {
    return fail(`${path}.stopReason`, `one of ${STOP_REASONS.join(", ")}`)
  }
  if (turn.fault !== undefined) {
    const type = isRecord(turn.fault) ? turn.fault.type : turn.fault
    if (!TURN_FAULTS.includes(type as TurnFaultType)) {
      return fail(`${path}.fault`, `one of ${TURN_FAULTS.join(", ")}`)
    }
  }
  if (turn.toolResult !== undefined && !Array.isArray(turn.toolResult)) {
    return fail(`${path}.toolResult`, "an array of {text} | {json}")
  }
  if (
    turn.expectToolResult !== undefined &&
    !(isRecord(turn.expectToolResult) && typeof turn.expectToolResult.name === "string")
  ) {
    return fail(`${path}.expectToolResult`, "{name}")
  }
  return undefined
}

/** Parse and validate one script; a string is the first problem found. */
export const parseScript = (value: unknown, index: number): Script | string => {
  const path = `scripts[${index}]`
  if (!isRecord(value)) return fail(path, "a script is an object")
  if (typeof value.id !== "string" || value.id === "")
    return fail(`${path}.id`, "a non-empty string")
  if (!Array.isArray(value.turns) || value.turns.length === 0) {
    return fail(`${path}.turns`, "a non-empty array")
  }
  for (const [i, turn] of value.turns.entries()) {
    const problem = checkTurn(turn, `${path}.turns[${i}]`)
    if (problem) return problem
  }
  if (value.match !== undefined) {
    if (!isRecord(value.match)) return fail(`${path}.match`, "an object")
    const match = value.match
    if (match.operation !== undefined) {
      const ops = Array.isArray(match.operation) ? match.operation : [match.operation]
      for (const op of ops) {
        if (!MODEL_OPERATIONS.includes(op as ModelOperation)) {
          return fail(`${path}.match.operation`, `one of ${MODEL_OPERATIONS.join(", ")}`)
        }
      }
    }
    if (isRecord(match.lastUserText) && typeof match.lastUserText.regex === "string") {
      try {
        new RegExp(match.lastUserText.regex)
      } catch {
        return fail(`${path}.match.lastUserText.regex`, "not a valid regular expression")
      }
    }
    if (match.toolsInclude !== undefined && !Array.isArray(match.toolsInclude)) {
      return fail(`${path}.match.toolsInclude`, "string[]")
    }
  }
  if (value.times !== undefined && (typeof value.times !== "number" || value.times < 1)) {
    return fail(`${path}.times`, "a positive count")
  }
  return value as Script
}

/** The fault a turn carries, normalised. */
export const turnFault = (turn: ScriptTurn | undefined): TurnFault | undefined => {
  if (!turn?.fault) return undefined
  return typeof turn.fault === "string" ? { type: turn.fault } : turn.fault
}
