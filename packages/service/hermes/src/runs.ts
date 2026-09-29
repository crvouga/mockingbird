import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export const runStatuses = [
  "queued",
  "running",
  "waiting_for_approval",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const
export type RunStatus = (typeof runStatuses)[number]
export type RunUsage = { input_tokens: number; output_tokens: number; total_tokens: number }
export type RunRecord = {
  object: "hermes.run"
  run_id: string
  status: RunStatus
  created_at: number
  updated_at: number
  session_id: unknown
  model: unknown
  last_event?: string
  output?: string
  usage?: RunUsage
  error?: string
  approval?: Record<string, unknown>
  pending_steer?: string
}
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
/** JSON values use Python truthiness at this pinned boundary. */
const truthy = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0
  if (record(value)) return Object.keys(value).length > 0
  return Boolean(value)
}
export class HermesError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly type = "invalid_request_error",
  ) {
    super(message)
  }
  envelope() {
    return { error: { message: this.message, type: this.type, param: null, code: this.code } }
  }
}
export const unsupported = (message: string): never => {
  throw new HermesError(
    501,
    `Mockingbird: ${message}`,
    "operation_not_implemented",
    "mockingbird_unsupported",
  )
}
const invalid = (message: string): never => {
  throw new HermesError(400, message)
}
export const terminal = (status: RunStatus) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status)

/** Synthetic public observations only: no prompts, credentials, workers or timers. */
export class HermesRuns {
  readonly records: Collection<RunRecord>
  private readonly ids: IdSequence
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly now: () => number,
  ) {
    this.records = new Collection(sqlite, namespace, "hermes-runs")
    this.ids = new IdSequence(sqlite, namespace, `hermes-runs:${namespace}`)
  }
  validate(body: unknown): Record<string, unknown> {
    if (!record(body))
      return unsupported("non-object submission roots are outside the verified subset")
    if ("hosted_room_dispatch" in body || "_room_execution_policy" in body)
      return unsupported("hosted-room dispatch is outside the peer-run subset")
    const input = body.input
    if (!truthy(input)) return invalid("Missing 'input' field")
    let message: unknown = typeof input === "string" ? input : ""
    if (Array.isArray(input)) {
      const last = input[input.length - 1]
      if (!record(last))
        return unsupported("malformed input elements are outside the verified subset")
      message = last.content
    }
    if (!truthy(message)) return invalid("No user message found in input")
    const history = body.conversation_history
    if (truthy(history)) {
      if (!Array.isArray(history))
        return invalid("'conversation_history' must be an array of message objects")
      for (const [i, entry] of history.entries())
        if (!record(entry) || !("role" in entry) || !("content" in entry))
          return invalid(`conversation_history[${i}] must have 'role' and 'content' fields`)
    }
    return body
  }
  create(body: unknown): RunRecord {
    this.validate(body)
    if (!record(body)) throw new TypeError("Expected validated body")
    // Preserve deterministic opaque identities using the shared snapshot-aware sequence.
    // Hex-encode the token: shape matches the provider; it is not a random UUID claim.
    const token = this.ids.next("run_", 16).slice(4)
    const id = `run_${Array.from(token, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`
    const time = this.now() / 1000
    const result: RunRecord = {
      object: "hermes.run",
      run_id: id,
      status: "queued",
      created_at: time,
      updated_at: time,
      session_id: truthy(body.session_id) ? body.session_id : id,
      model: "model" in body ? body.model : "hermes-agent",
    }
    this.records.insert(id, result)
    return result
  }
  get(id: string): RunRecord {
    const run = this.records.get(id)
    if (!run) throw new HermesError(404, `Run not found: ${id}`, "run_not_found")
    return run
  }
  interruptStale(id: string): RunRecord {
    const current = this.get(id)
    if (terminal(current.status)) return current
    // Pinned durable hydration updates fields directly (unlike normal status
    // updates, it does not clear a retained approval payload).
    const next: RunRecord = {
      ...current,
      status: "interrupted",
      error: "The gateway restarted before this run settled.",
      last_event: "run.interrupted",
      updated_at: this.now() / 1000,
    }
    this.records.update(id, next)
    return next
  }
  /** Mock control, not a vendor route. Advance only when the caller explicitly scripts it. */
  observe(id: string, body: unknown): RunRecord {
    const current = this.get(id)
    if (!record(body) || !runStatuses.includes(body.status as RunStatus))
      return invalid("observe: expected a supported status")
    const status = body.status as RunStatus
    const allowed = [
      "status",
      "last_event",
      "output",
      "usage",
      "error",
      "approval",
      "pending_steer",
    ]
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      return invalid("observe: unsupported field")
    for (const key of ["last_event", "output", "error", "pending_steer"])
      if (key in body && typeof body[key] !== "string")
        return invalid(`observe: ${key} must be a string`)
    if (("output" in body || "usage" in body || "pending_steer" in body) && status !== "completed")
      return invalid("observe: result fields require completed status")
    if ("error" in body && status !== "failed" && status !== "interrupted")
      return invalid("observe: error requires failed or interrupted status")
    if ("approval" in body && (status !== "waiting_for_approval" || !record(body.approval)))
      return invalid("observe: approval requires waiting_for_approval and an object")
    if ("usage" in body) {
      const usage = body.usage
      const keys = ["input_tokens", "output_tokens", "total_tokens"]
      if (
        !record(usage) ||
        Object.keys(usage).some((key) => !keys.includes(key)) ||
        keys.some((key) => !Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0)
      )
        return invalid("observe: usage requires three nonnegative token counts")
    }
    if (terminal(current.status))
      throw new HermesError(409, "observe: terminal runs cannot be changed", "mock_terminal_run")
    const fields = { ...body } as Partial<RunRecord>
    const next: RunRecord = { ...current, ...fields, status, updated_at: this.now() / 1000 }
    if (status !== "waiting_for_approval") delete next.approval
    if (status === "waiting_for_approval")
      next.last_event = (body.last_event as string) ?? "approval.request"
    if (terminal(status) || status === "stopping")
      next.last_event = (body.last_event as string) ?? `run.${status}`
    if (status === "completed") {
      next.output ??= ""
      next.usage ??= { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    }
    if (status === "failed") next.error ??= "agent run failed"
    if (status === "interrupted") next.error ??= "The gateway restarted before this run settled."
    this.records.update(id, next)
    return next
  }
}
