import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type ExecutionStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED"
export type StateMachine = {
  arn: string
  name: string
  definition?: string
  scripted?: {
    status: Exclude<ExecutionStatus, "RUNNING">
    output?: string
    error?: string
    cause?: string
    afterMs?: number
  }
  taskToken?: boolean
}
export type Execution = {
  arn: string
  stateMachineArn: string
  name: string
  input: string
  traceHeader?: string
  status: ExecutionStatus
  startDate: number
  stopDate?: number
  output?: string
  error?: string
  cause?: string
  taskToken?: string
  dueAt?: number
}
export type HistoryEvent = {
  id: number
  executionArn: string
  timestamp: number
  type: string
  previousEventId: number
  details?: Record<string, unknown>
}
export class StepFunctionsState {
  readonly machines: Collection<StateMachine>
  readonly executions: Collection<Execution>
  readonly history: Collection<HistoryEvent>
  readonly ids: IdSequence
  constructor(sqlite: SqliteClient, namespace: string) {
    this.machines = new Collection(sqlite, namespace, "sfn_machines")
    this.executions = new Collection(sqlite, namespace, "sfn_executions")
    this.history = new Collection(sqlite, namespace, "sfn_history")
    this.ids = new IdSequence(sqlite, namespace, "sfn")
  }
}
