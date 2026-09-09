import type { Exchange } from "@crvouga/mockingbird-canonicalize"
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
import { collectPlaceholders, pickRef, ResourceTable } from "@crvouga/mockingbird-model"
import { DEFAULT_PARITY_STEPS, DEFAULT_PROPERTY_RUNS } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  type ExecutionContext,
  executeCommand,
  executeWarmupCommand,
  type FetchLike,
  observationCacheKey,
  requestBodyForCacheKey,
  type Target,
} from "./execute.js"
import {
  formatReport,
  type ParityOptions,
  type ParityReport,
  type WalkWebhookEvents,
} from "./parity.js"
import { ParityError, type Redactor } from "./report.js"

export type SeedCacheEntry = {
  status: number
  headers: Record<string, string>
  body: unknown
}

export type SeedParityOptions = ParityOptions & {
  /** Warmup command budget N. Default 15. */
  warmupCommands?: number
  /** Compare command budget M. Default: resolved `maxCommands` (same as empty-start parity). */
  compareCommands?: number
  /** Called after warmup with the mock instance + observations from warmup GETs/POSTs. */
  seedMock: (args: {
    mock: FetchAPI
    real: Target
    table: ResourceTable
    getCache: ReadonlyMap<string, SeedCacheEntry>
    history: readonly string[]
  }) => Promise<void>
}

type WalkModel = { table: ResourceTable }
type WalkReal = ExecutionContext & {
  getCache: Map<string, SeedCacheEntry>
}

const unwrapCommand = (step: unknown): LogicalCommand | undefined => {
  if (typeof step !== "object" || step === null) return undefined
  if ("command" in step && isLogicalCommand((step as { command: unknown }).command)) {
    return (step as { command: LogicalCommand }).command
  }
  if ("cmd" in step) return unwrapCommand((step as { cmd: unknown }).cmd)
  return undefined
}

const isLogicalCommand = (value: unknown): value is LogicalCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { operationId?: unknown }).operationId === "string"

class WarmupStep implements fc.AsyncCommand<WalkModel, WalkReal> {
  constructor(readonly command: LogicalCommand) {}
  check(model: Readonly<WalkModel>) {
    return isEligible(this.command, (type) => model.table.count(type))
  }
  async run(_model: WalkModel, context: WalkReal) {
    const outcome = await executeWarmupCommand(context, this.command)
    if (
      shouldRecordObservation(
        outcome.request.method,
        this.command.operationId,
        outcome.request.path,
      )
    ) {
      const method = outcome.request.method.toUpperCase()
      const body =
        method === "POST" || method === "PUT" || method === "PATCH"
          ? requestBodyForCacheKey(outcome.request)
          : undefined
      context.getCache.set(observationCacheKey(outcome.request, body), {
        status: outcome.exchange.status,
        headers: outcome.exchange.headers,
        body: exchangeBodyForCache(outcome.exchange),
      })
    }
    applyDeletionTypes(context, this.command)
    recordHistory(context, this.command)
  }
  toString() {
    return describeCommand(this.command)
  }
}

class CompareStep implements fc.AsyncCommand<WalkModel, WalkReal> {
  constructor(readonly command: LogicalCommand) {}
  check(model: Readonly<WalkModel>) {
    return isEligible(this.command, (type) => model.table.count(type))
  }
  async run(_model: WalkModel, context: WalkReal) {
    await executeCommand(context, this.command)
    applyDeletionTypes(context, this.command)
    recordHistory(context, this.command)
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

const webhookPayload = (events: readonly unknown[]) => JSON.stringify(events)

const webhookEventNames = (events: readonly unknown[]) =>
  events.map((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return "unknown"
    const eventType = (event as Record<string, unknown>).event_type
    return typeof eventType === "string" ? eventType : "unknown"
  })

const shouldRecordObservation = (method: string, operationId: string, path: string) => {
  if (method.toUpperCase() === "GET") return true
  const haystack = `${operationId} ${path}`.toLowerCase()
  return (
    haystack.includes("area") || haystack.includes("psc") || haystack.includes("availability")
  )
}

const exchangeBodyForCache = (exchange: Exchange): unknown => {
  if (exchange.body.kind === "json" || exchange.body.kind === "form") return exchange.body.value
  if (exchange.body.kind === "text") return exchange.body.value
  return undefined
}

const applyDeletionTypes = (context: ExecutionContext, command: LogicalCommand) => {
  const deletionTypes = context.deletionTypes?.[command.operationId] ?? []
  if (deletionTypes.length === 0) return
  for (const placeholder of collectPlaceholders([command.parameters, command.body])) {
    if (placeholder.$mockingbird !== "ref" || !deletionTypes.includes(placeholder.type)) continue
    const ref = pickRef(context.table, placeholder.type, placeholder.pick)
    if (ref) context.table.markDeleted(ref.handle)
  }
}

const recordHistory = (context: ExecutionContext, command: LogicalCommand) => {
  context.history.push(describeCommand(command))
  if (context.coverage) {
    context.coverage[command.operationId] = (context.coverage[command.operationId] ?? 0) + 1
  }
}

/**
 * Seed-then-walk differential: warmup N commands on the real oracle only, seed the mock from
 * observations + oracle state, then compare M lockstep commands. Throws the shrunk
 * {@link ParityError} on the first divergence.
 */
export const seedParity = async (options: SeedParityOptions): Promise<ParityReport> => {
  const env = options.env ?? {}
  const seed = options.seed ?? integerEnv(env, "FC_SEED") ?? Date.now() % 0x7fffffff
  const numRuns = options.numRuns ?? integerEnv(env, "FC_NUM_RUNS") ?? DEFAULT_PROPERTY_RUNS
  const maxCommands =
    options.maxCommands ?? integerEnv(env, "MOCKINGBIRD_MAX_COMMANDS") ?? DEFAULT_PARITY_STEPS
  const warmupN = options.warmupCommands ?? 15
  const compareCommands = options.compareCommands ?? maxCommands
  const trace = env.MOCKINGBIRD_TRACE === "1" || env.MOCKINGBIRD_TRACE === "true"
  const log = options.log ?? ((line: string) => console.log(line))
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const redact = options.redact ?? ((text: string) => text)
  const clockSkewSeconds = options.clockSkewSeconds ?? 2
  const deletedRefProbability = options.deletedRefProbability ?? 0.15
  const runId = options.runId ?? `mockingbird-seed-parity-${seed.toString(16)}`

  assertAllowedHost(options.real.baseUrl, options.real.allowedHosts)

  const plans = planOperations(options.spec, {
    includeUnsafe: options.includeUnsafe ?? false,
    ...(options.only ? { only: options.only } : {}),
    ...(options.forceInclude ? { forceInclude: options.forceInclude } : {}),
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

  log(`${options.provider} seed parity`)
  log(`  seed ${seed}  runs ${numRuns}  warmup ${warmupN}  compare ${compareCommands}`)
  log("")

  const exercised: Record<string, number> = {}
  let walks = 0
  let operations = 0
  let lastWalkEnd = 0
  let done = 0
  const width = String(numRuns).length
  const coverage: Record<string, number> = {}

  const commandOptions = {
    document: options.spec,
    plans,
    ...(options.invalidProbability === undefined
      ? {}
      : { invalidProbability: options.invalidProbability }),
    ...(options.weights === undefined ? {} : { weights: options.weights }),
    ...(options.coverageBias === undefined ? {} : { coverageBias: options.coverageBias }),
    coverage,
  }

  const warmupCommandsArb = fc.commands(
    [commandArbitrary(commandOptions).map((command) => new WarmupStep(command))],
    { maxCommands: warmupN, size: "max" },
  )
  const compareCommandsArb = fc.commands(
    [commandArbitrary(commandOptions).map((command) => new CompareStep(command))],
    { maxCommands: compareCommands, size: "max" },
  )

  const property = fc.asyncProperty(
    warmupCommandsArb,
    compareCommandsArb,
    async (warmupSteps, compareSteps) => {
      const walkNumber = walks + 1
      const gap = lastWalkEnd + (clockSkewSeconds + 1) * 1000 - now()
      if (lastWalkEnd > 0 && gap > 0) await sleep(gap)
      const table = new ResourceTable()
      const scope: Scope = { runId, walkStartUnix: Math.floor(now() / 1000) - clockSkewSeconds }
      const mock = await options.mock.create()
      const getCache = new Map<string, SeedCacheEntry>()
      const realTarget: Target = {
        baseUrl: options.real.baseUrl,
        fetch: realFetch,
        headers: realHeaders,
      }
      const context: WalkReal = {
        provider: options.provider,
        document: options.spec,
        plans: planById,
        table,
        scope,
        real: realTarget,
        mock: {
          baseUrl: mockBaseUrl,
          fetch: (request) => mock.fetch(request),
          headers: options.mock.headers ?? (() => ({})),
        },
        redact,
        history: [],
        coverage,
        deletedRefProbability,
        deletionTypes: options.deletionTypes ?? {},
        validateMock: options.validateMock ?? true,
        latencyToleranceMs: options.latencyToleranceMs ?? 0,
        step: (line) => log(`  [${String(walkNumber).padStart(width, " ")}/${numRuns}] ${line}`),
        trace: trace ? log : undefined,
        getCache,
      }

      let walkError: unknown
      let ok = false

      try {
        await fc.asyncModelRun(() => ({ model: { table }, real: context }), warmupSteps)
        await options.seedMock({
          mock,
          real: realTarget,
          table,
          getCache,
          history: context.history,
        })
        await fc.asyncModelRun(() => ({ model: { table }, real: context }), compareSteps)
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
      const firstCommand =
        unwrapCommand([...warmupSteps][0]) ??
        unwrapCommand([...compareSteps][0]) ??
        ({} as LogicalCommand)
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
          `  [${String(done).padStart(width, " ")}/${numRuns}] ✓ warmup+compare ${ops} op${ops === 1 ? "" : "s"}${webhookSummary}`,
        )
      }
    },
  )

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
    const header = `✗ ${options.provider} seed parity FAILED (seed ${seed}, FC_SEED=${seed} to replay)`
    if (error instanceof Error && error.cause instanceof ParityError) {
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
  log(formatReport(report).replace("parity passed", "seed parity passed"))
  return report
}
