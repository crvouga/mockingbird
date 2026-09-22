import { type APIOptions, bootSqlite, sigV4AccessKeyId } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  type Execution,
  type ExecutionStatus,
  type StateMachine,
  StepFunctionsState,
} from "./state.js"

export type { StepFunctionsRuntime, StepFunctionsRuntimeOptions } from "./runtime.js"
export { createRuntime, STEP_FUNCTIONS_PRESETS } from "./runtime.js"
export type { Execution, ExecutionStatus, HistoryEvent, StateMachine } from "./state.js"
export { document, operationIds, supportedOperationIds }
export const STEP_FUNCTIONS_NAMESPACE = "step-functions"
export const accessKeyCredential = sigV4AccessKeyId
export type StateMachineSeed = Omit<StateMachine, "arn"> & { arn?: string }
export type StepFunctionsAPIOptions = APIOptions & {
  region?: string
  accountId?: string
  stateMachines?: readonly StateMachineSeed[]
}
type Input = Record<string, unknown>

export class StepFunctionsAPI {
  readonly state: StepFunctionsState
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly region: string
  private readonly accountId: string
  constructor(private readonly options: StepFunctionsAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? STEP_FUNCTIONS_NAMESPACE
    this.now = options.now ?? Date.now
    this.region = options.region ?? "us-east-1"
    this.accountId = options.accountId ?? "000000000000"
    this.state = new StepFunctionsState(this.sqlite, this.namespace)
    this.seed()
  }
  private seed() {
    for (const machine of this.options.stateMachines ?? []) this.register(machine)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  register(input: StateMachineSeed) {
    const machine: StateMachine = {
      ...input,
      arn:
        input.arn ?? `arn:aws:states:${this.region}:${this.accountId}:stateMachine:${input.name}`,
    }
    this.state.machines.insert(machine.arn, machine)
    return machine
  }
  private response(body: unknown, status = 200) {
    const id = this.state.ids.next("req-", 20)
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/x-amz-json-1.0", "x-amzn-requestid": id },
    })
  }
  private error(type: string, message: string) {
    return this.response({ __type: type, message }, 400)
  }
  private execution(arn: unknown) {
    return typeof arn === "string" ? this.state.executions.get(arn) : undefined
  }
  private events(arn: string) {
    return this.state.history
      .list({ where: (event) => event.executionArn === arn, order: "oldest" })
      .map(({ value }) => value)
  }
  private event(execution: Execution, type: string, details?: Record<string, unknown>) {
    const existing = this.events(execution.arn)
    const event = {
      id: existing.length + 1,
      executionArn: execution.arn,
      timestamp: this.now(),
      type,
      previousEventId: existing.at(-1)?.id ?? 0,
      ...(details ? { details } : {}),
    }
    this.state.history.insert(`${execution.arn}:${event.id}`, event)
    return event
  }
  private json(value: unknown, type: "input" | "output") {
    if (typeof value !== "string") throw new SyntaxError(`${type} must be a JSON string`)
    try {
      JSON.parse(value)
    } catch {
      throw new SyntaxError(`InvalidExecution${type === "input" ? "Input" : "Output"}`)
    }
    return value
  }
  private refresh(execution: Execution) {
    if (
      execution.status === "RUNNING" &&
      execution.dueAt !== undefined &&
      execution.dueAt <= this.now()
    ) {
      const machine = this.state.machines.get(execution.stateMachineArn)
      const scripted = machine?.scripted
      if (scripted)
        return (
          this.transition(execution.arn, scripted.status, {
            ...(scripted.output !== undefined ? { output: scripted.output } : {}),
            ...(scripted.error !== undefined ? { error: scripted.error } : {}),
            ...(scripted.cause !== undefined ? { cause: scripted.cause } : {}),
          }) ?? execution
        )
    }
    return execution
  }
  transition(
    arn: string,
    status: Exclude<ExecutionStatus, "RUNNING">,
    values: { output?: string; error?: string; cause?: string } = {},
  ) {
    const current = this.state.executions.get(arn)
    if (current?.status !== "RUNNING") return undefined
    if (values.output !== undefined) this.json(values.output, "output")
    const next: Execution = {
      ...current,
      status,
      stopDate: this.now(),
      ...(values.output !== undefined ? { output: values.output } : {}),
      ...(values.error !== undefined ? { error: values.error } : {}),
      ...(values.cause !== undefined ? { cause: values.cause } : {}),
    }
    this.state.executions.insert(arn, next)
    const suffix =
      status === "SUCCEEDED"
        ? "Succeeded"
        : status === "FAILED"
          ? "Failed"
          : status === "TIMED_OUT"
            ? "TimedOut"
            : "Aborted"
    this.event(next, `Execution${suffix}`, {
      ...(next.output !== undefined ? { output: next.output } : {}),
      ...(next.error !== undefined ? { error: next.error } : {}),
      ...(next.cause !== undefined ? { cause: next.cause } : {}),
    })
    return next
  }
  private publicExecution(execution: Execution) {
    const current = this.refresh(execution)
    return {
      executionArn: current.arn,
      stateMachineArn: current.stateMachineArn,
      name: current.name,
      status: current.status,
      startDate: current.startDate / 1000,
      ...(current.stopDate !== undefined ? { stopDate: current.stopDate / 1000 } : {}),
      input: current.input,
      ...(current.output !== undefined ? { output: current.output } : {}),
      ...(current.error !== undefined ? { error: current.error } : {}),
      ...(current.cause !== undefined ? { cause: current.cause } : {}),
      ...(current.traceHeader ? { traceHeader: current.traceHeader } : {}),
    }
  }
  private callback(token: unknown) {
    return typeof token === "string"
      ? this.state.executions
          .list({
            where: (execution) => execution.status === "RUNNING" && execution.taskToken === token,
          })
          .map(({ value }) => value)[0]
      : undefined
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return this.error("InvalidExecutionInput", "Only POST is supported")
    const operation = (request.headers.get("x-amz-target") ?? "").split(".").at(-1) ?? ""
    const input = (await request.json().catch(() => ({}))) as Input
    try {
      if (operation === "StartExecution") {
        const arn = typeof input.stateMachineArn === "string" ? input.stateMachineArn : ""
        if (!arn.startsWith("arn:")) return this.error("InvalidArn", "Invalid Arn")
        const machine = this.state.machines.get(arn)
        if (!machine)
          return this.error("StateMachineDoesNotExist", `State Machine Does Not Exist: '${arn}'`)
        const executionInput = this.json(input.input ?? "{}", "input")
        const name = typeof input.name === "string" ? input.name : this.state.ids.next("exec-", 20)
        const prior = this.state.executions
          .list({
            where: (execution) => execution.stateMachineArn === arn && execution.name === name,
          })
          .map(({ value }) => value)[0]
        if (prior) {
          const current = this.refresh(prior)
          if (current.status === "RUNNING" && current.input === executionInput)
            return this.response({ executionArn: current.arn, startDate: current.startDate / 1000 })
          return this.error("ExecutionAlreadyExists", `Execution Already Exists: '${current.arn}'`)
        }
        const executionArn = `${arn.replace(":stateMachine:", ":execution:")}:${name}`
        const execution: Execution = {
          arn: executionArn,
          stateMachineArn: arn,
          name,
          input: executionInput,
          status: "RUNNING",
          startDate: this.now(),
          ...(typeof input.traceHeader === "string" ? { traceHeader: input.traceHeader } : {}),
          ...(machine.taskToken ? { taskToken: this.state.ids.next("task-", 48) } : {}),
          ...(machine.scripted?.afterMs !== undefined
            ? { dueAt: this.now() + machine.scripted.afterMs }
            : {}),
        }
        this.state.executions.insert(executionArn, execution)
        this.event(execution, "ExecutionStarted", {
          input: executionInput,
          ...(execution.traceHeader ? { traceHeader: execution.traceHeader } : {}),
        })
        if (execution.taskToken) {
          this.event(execution, "TaskScheduled", { resource: "mockingbird:callback" })
          this.event(execution, "TaskStarted", { taskToken: execution.taskToken })
        }
        return this.response({ executionArn, startDate: execution.startDate / 1000 })
      }
      if (operation === "DescribeExecution") {
        const execution = this.execution(input.executionArn)
        return execution
          ? this.response(this.publicExecution(execution))
          : this.error(
              "ExecutionDoesNotExist",
              `Execution Does Not Exist: '${String(input.executionArn)}'`,
            )
      }
      if (operation === "StopExecution") {
        const execution = this.execution(input.executionArn)
        if (!execution) return this.error("ExecutionDoesNotExist", "Execution does not exist")
        const moved = this.transition(execution.arn, "ABORTED", {
          ...(typeof input.error === "string" ? { error: input.error } : {}),
          ...(typeof input.cause === "string" ? { cause: input.cause } : {}),
        })
        return this.response({
          stopDate: (moved?.stopDate ?? execution.stopDate ?? this.now()) / 1000,
        })
      }
      if (operation === "GetExecutionHistory") {
        const execution = this.execution(input.executionArn)
        if (!execution) return this.error("ExecutionDoesNotExist", "Execution does not exist")
        this.refresh(execution)
        const all = this.events(execution.arn)
        const offset = typeof input.nextToken === "string" ? Number(atob(input.nextToken)) : 0
        const max = Math.max(1, Math.min(1000, Number(input.maxResults ?? 100)))
        let selected = all.slice(offset, offset + max)
        if (input.reverseOrder === true) selected = [...all].reverse().slice(offset, offset + max)
        const events = selected.map((event) => ({
          timestamp: event.timestamp / 1000,
          type: event.type,
          id: event.id,
          previousEventId: event.previousEventId,
          ...(event.details
            ? {
                [`${event.type[0]?.toLowerCase()}${event.type.slice(1)}EventDetails`]:
                  event.details,
              }
            : {}),
        }))
        return this.response({
          events,
          ...(offset + max < all.length ? { nextToken: btoa(String(offset + max)) } : {}),
        })
      }
      if (["SendTaskSuccess", "SendTaskFailure", "SendTaskHeartbeat"].includes(operation)) {
        const execution = this.callback(input.taskToken)
        if (!execution) return this.error("TaskDoesNotExist", "Task Token does not exist")
        if (operation === "SendTaskHeartbeat") return this.response({})
        if (operation === "SendTaskSuccess") {
          const output = this.json(input.output ?? "{}", "output")
          this.event(execution, "TaskSucceeded", { output })
          this.transition(execution.arn, "SUCCEEDED", { output })
        } else {
          this.event(execution, "TaskFailed", { error: input.error, cause: input.cause })
          this.transition(execution.arn, "FAILED", {
            ...(typeof input.error === "string" ? { error: input.error } : {}),
            ...(typeof input.cause === "string" ? { cause: input.cause } : {}),
          })
        }
        return this.response({})
      }
      return this.error("InvalidExecutionInput", `Unknown operation ${operation}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid input"
      return this.error(
        message.startsWith("InvalidExecution") ? message : "InvalidExecutionInput",
        message,
      )
    }
  }
}
