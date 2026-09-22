import {
  type AdminRoutes,
  type Clock,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  accessKeyCredential,
  STEP_FUNCTIONS_NAMESPACE,
  type StateMachineSeed,
  StepFunctionsAPI,
} from "./index.js"
import type { ExecutionStatus } from "./state.js"

export const STEP_FUNCTIONS_PRESETS: Record<string, FaultPreset> = {
  throttled: {
    description: "Step Functions answers ThrottlingException",
    rules: [
      {
        status: 400,
        body: { __type: "ThrottlingException", message: "Rate exceeded" },
        headers: { "content-type": "application/x-amz-json-1.0" },
      },
    ],
  },
  unavailable: { description: "The next request loses its connection", rules: [{ drop: true }] },
}
export type StepFunctionsRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  region?: string
  accountId?: string
  stateMachines?: readonly StateMachineSeed[]
}
export type StepFunctionsRuntime = ServiceRuntime<StepFunctionsAPI>
const problem = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const admin = (runtime: ServiceRuntime<StepFunctionsAPI>): AdminRoutes => ({
  "GET /state-machines": ({ namespace }) =>
    Response.json({
      stateMachines: runtime
        .instance(namespace)
        .state.machines.list()
        .map(({ value }) => value),
    }),
  "POST /state-machines": ({ namespace, body }) => {
    const input = body as StateMachineSeed | null
    if (!input || typeof input.name !== "string") return problem(400, "name is required")
    return Response.json(runtime.instance(namespace).register(input), { status: 201 })
  },
  "GET /executions": ({ namespace }) =>
    Response.json({
      executions: runtime
        .instance(namespace)
        .state.executions.list({ order: "oldest" })
        .map(({ value }) => ({ ...value, taskToken: value.taskToken ? "[REDACTED]" : undefined })),
    }),
  "GET /executions/:arn/task-token": ({ namespace, params }) => {
    const execution = runtime.instance(namespace).state.executions.get(params.arn as string)
    return execution?.taskToken
      ? Response.json({ taskToken: execution.taskToken })
      : problem(404, "active callback token not found")
  },
  "POST /executions/:arn/transition": ({ namespace, params, body }) => {
    const input = body as {
      status?: unknown
      output?: unknown
      error?: unknown
      cause?: unknown
    } | null
    const allowed = new Set<ExecutionStatus>(["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"])
    if (!input || typeof input.status !== "string" || !allowed.has(input.status as ExecutionStatus))
      return problem(400, "terminal status is required")
    const moved = runtime
      .instance(namespace)
      .transition(params.arn as string, input.status as Exclude<ExecutionStatus, "RUNNING">, {
        ...(typeof input.output === "string" ? { output: input.output } : {}),
        ...(typeof input.error === "string" ? { error: input.error } : {}),
        ...(typeof input.cause === "string" ? { cause: input.cause } : {}),
      })
    return moved ? Response.json(moved) : problem(404, "running execution not found")
  },
})
export const createRuntime = (options: StepFunctionsRuntimeOptions = {}): StepFunctionsRuntime =>
  serviceRuntime({
    name: STEP_FUNCTIONS_NAMESPACE,
    document,
    presets: STEP_FUNCTIONS_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    create: ({ sqlite, namespace, clock }) =>
      new StepFunctionsAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.region ? { region: options.region } : {}),
        ...(options.accountId ? { accountId: options.accountId } : {}),
        ...(options.stateMachines ? { stateMachines: options.stateMachines } : {}),
      }),
    admin,
  })
