import {
  commandArbitrary,
  describeCommand,
  isEligible,
  type LogicalCommand,
  type OperationPlan,
  planOperations,
  type Scope,
} from "@crvouga/mockingbird-commands"
import type { FetchAPI } from "@crvouga/mockingbird-core"
import { ResourceTable } from "@crvouga/mockingbird-model"
import type { OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { DEFAULT_PARITY_STEPS, DEFAULT_PROPERTY_RUNS } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { type ExecutionContext, executeCommand, type FetchLike, type Target } from "./execute.js"
import { ParityError, type Redactor } from "./report.js"

export type RealTarget = {
  baseUrl: string
  /** Hosts the runner may contact. Anything else fails before a single request is sent. */
  allowedHosts: readonly string[]
  headers?: Target["headers"]
  fetch?: FetchLike
  /** Minimum spacing between requests, for provider rate limits. Default 0. */
  minIntervalMs?: number
}

export type MockTarget = {
  /** Fresh mock per walk so walks are independent. */
  create: () => FetchAPI | Promise<FetchAPI>
  /** Default `https://mock.<provider>.local`. */
  baseUrl?: string
  /** Headers every mock request carries, e.g. a dummy API key when the mock enforces auth. */
  headers?: Target["headers"]
}

export type WalkWebhookEvents = {
  real: readonly unknown[]
  mock: readonly unknown[]
}

export type WebhookParityOptions = {
  collectReal: (scope: Scope) => Promise<readonly unknown[]>
  collectMock: (mock: FetchAPI, scope: Scope) => Promise<readonly unknown[]>
}

const webhookPayload = (events: readonly unknown[]) => JSON.stringify(events)

const webhookEventNames = (events: readonly unknown[]) =>
  events.map((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return "unknown"
    const eventType = (event as Record<string, unknown>).event_type
    return typeof eventType === "string" ? eventType : "unknown"
  })

export type WalkCleanup = (context: {
  table: ResourceTable
  real: { fetch: (request: Request) => Promise<Response>; baseUrl: string }
  scope: Scope
  webhookEvents?: WalkWebhookEvents
}) => Promise<void>

export type ParityOptions = {
  provider: string
  spec: OpenAPIDocument
  real: RealTarget
  mock: MockTarget
  /** Default 25. */
  numRuns?: number
  /** Default 30. */
  maxCommands?: number
  seed?: number
  /** Environment used for FC_SEED / FC_NUM_RUNS / MOCKINGBIRD_MAX_COMMANDS / MOCKINGBIRD_TRACE. */
  env?: Record<string, string | undefined>
  /** Tag threaded through `x-mockingbird-scope: run-id` values. Default derived from the seed. */
  runId?: string
  includeUnsafe?: boolean
  only?: readonly string[]
  /** Remove real-side resources after each walk. */
  cleanup?: WalkCleanup
  /** Also validate every mock response against the OpenAPI response schema. Default true. */
  validateMock?: boolean
  redact?: Redactor
  /** Seconds subtracted from the walk start for `walk-start-unix` to absorb clock skew. Default 2. */
  clockSkewSeconds?: number
  log?: (line: string) => void
  /** Injected clock/sleep for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Chance a generated body is invalid. Default 0.15. */
  invalidProbability?: number
  /** Shrink failing walks to a minimal reproduction (costs extra real requests). Default true. */
  shrink?: boolean
  /** Stop generating new walks after this many milliseconds; completed walks still count. */
  timeLimitMs?: number
  webhooks?: WebhookParityOptions
}

export type ParityReport = {
  provider: string
  seed: number
  walks: number
  operations: number
  /** Number of times each operation was executed. */
  exercised: Record<string, number>
  planned: string[]
}

type WalkModel = { table: ResourceTable }
type WalkReal = ExecutionContext

class Step implements fc.AsyncCommand<WalkModel, WalkReal> {
  constructor(readonly command: LogicalCommand) {}
  check(model: Readonly<WalkModel>) {
    return isEligible(this.command, (type) => model.table.count(type))
  }
  async run(_model: WalkModel, context: WalkReal) {
    await executeCommand(context, this.command)
    context.history.push(describeCommand(this.command))
  }
  toString() {
    return describeCommand(this.command)
  }
}

const integerEnv = (env: Record<string, string | undefined>, name: string) => {
  const raw = env[name]
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  if (!Number.isInteger(value))
    throw new RangeError(`${name} must be an integer, got ${JSON.stringify(raw)}`)
  return value
}

/** Drop fast-check's shrink trail ("Encountered failures were: …") — the minimal repro is on the Counterexample line. */
const minimalCounterexample = (message: string) => {
  const idx = message.indexOf("\nEncountered failures were:")
  return idx >= 0 ? message.slice(0, idx) : message
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const assertAllowedHost = (baseUrl: string, allowedHosts: readonly string[]) => {
  const { host, protocol } = new URL(baseUrl)
  if (
    protocol !== "https:" &&
    !host.endsWith(".local") &&
    !host.startsWith("localhost") &&
    !host.startsWith("127.0.0.1")
  ) {
    throw new Error(`refusing to run parity against non-https base url ${baseUrl}`)
  }
  if (!allowedHosts.includes(host)) {
    throw new Error(
      `refusing to run parity against ${host}; allowed hosts: ${allowedHosts.join(", ") || "(none)"}`,
    )
  }
}

const throttled = (
  fetchImpl: FetchLike,
  minIntervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): FetchLike => {
  let last = 0
  return async (request) => {
    if (minIntervalMs > 0) {
      const wait = last + minIntervalMs - now()
      if (wait > 0) await sleep(wait)
      last = now()
    }
    return fetchImpl(request)
  }
}

/**
 * Differential property test: random stateful walks through `spec`, executed against the real
 * API and a fresh mock, compared after every command. Throws the shrunk {@link ParityError}
 * (wrapped by fast-check with seed and counterexample) on the first divergence.
 */
export const parity = async (options: ParityOptions): Promise<ParityReport> => {
  const env = options.env ?? {}
  const seed = options.seed ?? integerEnv(env, "FC_SEED") ?? Date.now() % 0x7fffffff
  const numRuns = options.numRuns ?? integerEnv(env, "FC_NUM_RUNS") ?? DEFAULT_PROPERTY_RUNS
  const maxCommands =
    options.maxCommands ?? integerEnv(env, "MOCKINGBIRD_MAX_COMMANDS") ?? DEFAULT_PARITY_STEPS
  const trace = env.MOCKINGBIRD_TRACE === "1" || env.MOCKINGBIRD_TRACE === "true"
  const log = options.log ?? ((line: string) => console.log(line))
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const redact = options.redact ?? ((text: string) => text)
  const clockSkewSeconds = options.clockSkewSeconds ?? 2
  const runId = options.runId ?? `mockingbird-parity-${seed.toString(16)}`

  assertAllowedHost(options.real.baseUrl, options.real.allowedHosts)

  const plans = planOperations(options.spec, {
    includeUnsafe: options.includeUnsafe ?? false,
    ...(options.only ? { only: options.only } : {}),
  })
  if (plans.length === 0)
    throw new Error(`${options.provider}: no parity-enabled operations in spec`)
  const planById = new Map<string, OperationPlan>(
    plans.map((plan) => [plan.operation.operationId, plan]),
  )

  const realFetch = throttled(
    options.real.fetch ?? ((request) => fetch(request)),
    options.real.minIntervalMs ?? 0,
    now,
    sleep,
  )
  const realHeaders = options.real.headers ?? (() => ({}))
  const mockBaseUrl = options.mock.baseUrl ?? `https://mock.${options.provider}.local`

  log(`${options.provider} parity`)
  log(`  seed ${seed}  runs ${numRuns}  max ${maxCommands}`)
  log("")

  const exercised: Record<string, number> = {}
  let walks = 0
  let operations = 0
  let lastWalkEnd = 0
  let done = 0
  const width = String(numRuns).length

  const commands = fc.commands(
    [
      commandArbitrary({
        document: options.spec,
        plans,
        ...(options.invalidProbability === undefined
          ? {}
          : { invalidProbability: options.invalidProbability }),
      }).map((command) => new Step(command)),
    ],
    { maxCommands, size: "max" },
  )

  const property = fc.asyncProperty(commands, async (steps) => {
    const walkNumber = walks + 1
    const gap = lastWalkEnd + (clockSkewSeconds + 1) * 1000 - now()
    if (lastWalkEnd > 0 && gap > 0) await sleep(gap)
    const table = new ResourceTable()
    const scope: Scope = { runId, walkStartUnix: Math.floor(now() / 1000) - clockSkewSeconds }
    const mock = await options.mock.create()
    const context: ExecutionContext = {
      provider: options.provider,
      document: options.spec,
      plans: planById,
      table,
      scope,
      real: { baseUrl: options.real.baseUrl, fetch: realFetch, headers: realHeaders },
      mock: {
        baseUrl: mockBaseUrl,
        fetch: (request) => mock.fetch(request),
        headers: options.mock.headers ?? (() => ({})),
      },
      redact,
      history: [],
      validateMock: options.validateMock ?? true,
      step: (line) => log(`  [${String(walkNumber).padStart(width, " ")}/${numRuns}] ${line}`),
      trace: trace ? log : undefined,
    }
    let ok = false
    let walkError: unknown
    try {
      await fc.asyncModelRun(() => ({ model: { table }, real: context }), steps)
      ok = true
    } catch (error) {
      walkError = error
    }

    walks++
    operations += context.history.length
    for (const entry of context.history) {
      const operationId = entry.split(" ")[0] ?? entry
      exercised[operationId] = (exercised[operationId] ?? 0) + 1
    }
    lastWalkEnd = now()

    let webhookFailure: ParityError | undefined
    let webhookEvents: WalkWebhookEvents | undefined
    const firstStep = [...steps][0]
    const firstCommand = firstStep instanceof Step ? firstStep.command : ({} as LogicalCommand)
    if (options.webhooks) {
      const realEvents = await options.webhooks.collectReal(scope)
      const mockEvents = await options.webhooks.collectMock(mock, scope)
      webhookEvents = { real: realEvents, mock: mockEvents }
      log(
        `  [${String(walkNumber).padStart(width, " ")}/${numRuns}] webhook events real=${realEvents.length} mock=${mockEvents.length} real_types=${webhookEventNames(realEvents).join(",") || "none"} mock_types=${webhookEventNames(mockEvents).join(",") || "none"}`,
      )
      if (webhookPayload(realEvents) !== webhookPayload(mockEvents)) {
        const firstDifference =
          realEvents.length !== mockEvents.length
            ? `event count real=${realEvents.length} mock=${mockEvents.length}`
            : `event payload/order differs at index ${realEvents.findIndex((event, index) => JSON.stringify(event) !== JSON.stringify(mockEvents[index]))}`
        webhookFailure = new ParityError(
          {
            provider: options.provider,
            operationId: "webhooks",
            method: "WALK",
            path: "",
            command: firstCommand,
            history: [...context.history],
            kind: "webhook-mismatch",
            realEvents,
            mockEvents,
            firstDifference,
          },
          context.redact,
        )
      }
    }

    if (options.cleanup) {
      await options.cleanup({
        table,
        scope,
        ...(webhookEvents === undefined ? {} : { webhookEvents }),
        real: {
          baseUrl: options.real.baseUrl,
          fetch: async (request) => {
            const headers = new Headers(request.headers)
            const extra: Record<string, string> = await realHeaders()
            for (const [name, value] of Object.entries(extra)) headers.set(name, value)
            return realFetch(new Request(request, { headers }))
          },
        },
      })
    }

    if (webhookFailure) throw webhookFailure
    if (walkError !== undefined) throw walkError
    if (ok) {
      done++
      const ops = context.history.length
      const webhookSummary = options.webhooks
        ? `; webhook parity ✓ (${webhookEvents?.real.length ?? 0} events)`
        : ""
      log(
        `  [${String(done).padStart(width, " ")}/${numRuns}] ✓ ${ops} op${ops === 1 ? "" : "s"}${webhookSummary}`,
      )
    }
  })

  try {
    await fc.assert(property, {
      seed,
      numRuns,
      verbose: fc.VerbosityLevel.Verbose,
      endOnFailure: options.shrink === false,
      ...(options.timeLimitMs === undefined
        ? {}
        : { interruptAfterTimeLimit: options.timeLimitMs, markInterruptAsFailure: false }),
    })
  } catch (error) {
    const header = `✗ ${options.provider} parity FAILED (seed ${seed}, FC_SEED=${seed} to replay)`
    if (error instanceof Error && error.cause instanceof ParityError) {
      // Surface the minimal reproduction: fast-check's shrunk counterexample plus the divergence.
      const cause = error.cause
      cause.message = `${header}\n${minimalCounterexample(error.message)}\n\n${cause.message}`
      throw cause
    }
    if (error instanceof Error) error.message = `${header}\n${error.message}`
    throw error
  }

  const report: ParityReport = {
    provider: options.provider,
    seed,
    walks,
    operations,
    exercised,
    planned: plans.map((plan) => plan.operation.operationId),
  }
  log("")
  log(formatReport(report))
  return report
}

export const formatReport = (report: ParityReport) =>
  `✓ ${report.provider} parity passed: ${report.walks} walks / ${report.operations.toLocaleString()} operations / ${Object.keys(report.exercised).length}/${report.planned.length} operationIds (seed ${report.seed})`

export { ParityError }
