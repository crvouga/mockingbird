import { randomUUID } from "node:crypto"

export type AuditEvent = {
  id: string
  actor: string
  namespace: string
  action: string
  services: string[]
  operationId?: string
  stage: "denied" | "attempt" | "terminal"
  timestamp: string
  result?: "succeeded" | "failed" | "cancelled"
  durable?: boolean
}
export type AuditPolicy = {
  write(event: AuditEvent): Promise<void>
  failurePolicy: "open" | "closed"
}
export type TelemetryEvent = {
  participant?: string
  operationId: string
  phase: string
  action: string
  services: string[]
  status: string
  elapsedMs: number
  recoveryRequired: boolean
}
export type InstrumentationOptions = {
  audit?: AuditPolicy
  telemetry?(event: TelemetryEvent): void | Promise<void>
}
export class FleetInstrumentation {
  private readonly auditEntries: AuditEvent[] = []
  private readonly started = new Map<string, number>()
  private readonly terminal = new Set<string>()
  private readonly metrics = {
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    recoveryRequired: 0,
    phaseEvents: 0,
    auditFailures: 0,
    rollbackAttempts: 0,
    rollbackFailures: 0,
    telemetryFailures: 0,
    durationsMs: { count: 0, sum: 0, max: 0 },
  }
  constructor(private readonly options: InstrumentationOptions = {}) {}
  async audit(input: Omit<AuditEvent, "id" | "timestamp" | "durable">): Promise<boolean> {
    const event: AuditEvent = { ...input, id: randomUUID(), timestamp: new Date().toISOString() }
    let accepted = true
    try {
      if (this.options.audit) {
        await this.options.audit.write(event)
        event.durable = true
      } else event.durable = false
    } catch {
      this.metrics.auditFailures++
      event.durable = false
      accepted = this.options.audit?.failurePolicy !== "closed"
    }
    this.auditEntries.push(event)
    if (this.auditEntries.length > 200) this.auditEntries.shift()
    return accepted
  }
  phase(
    operation: {
      id: string
      participant?: string
      phase: string
      action: string
      services?: string[]
      status: string
    },
    recoveryRequired: boolean,
  ) {
    if (!this.started.has(operation.id)) {
      this.started.set(operation.id, performance.now())
      this.metrics.started++
    }
    const elapsedMs = Math.max(0, performance.now() - (this.started.get(operation.id) as number))
    this.metrics.phaseEvents++
    if (operation.phase === "rolling-back") this.metrics.rollbackAttempts++
    if (operation.phase === "rollback-failed") this.metrics.rollbackFailures++
    if (operation.status !== "running" && !this.terminal.has(operation.id)) {
      this.terminal.add(operation.id)
      if (operation.status === "succeeded") this.metrics.succeeded++
      else if (operation.status === "cancelled") this.metrics.cancelled++
      else this.metrics.failed++
      if (recoveryRequired) this.metrics.recoveryRequired++
      this.metrics.durationsMs.count++
      this.metrics.durationsMs.sum += elapsedMs
      this.metrics.durationsMs.max = Math.max(this.metrics.durationsMs.max, elapsedMs)
    }
    const action = operation.action
      .replace(/\/namespaces\/[^/]+/g, "/namespaces/{namespace}")
      .replace(/\/snapshots\/[^/]+/g, "/snapshots/{id}")
      .replace(/\/scenarios\/[^/]+/g, "/scenarios/{name}")
    try {
      const sent = this.options.telemetry?.({
        ...(operation.participant ? { participant: operation.participant } : {}),
        operationId: operation.id,
        phase: operation.phase,
        action,
        services: operation.services ?? [],
        status: operation.status,
        elapsedMs,
        recoveryRequired,
      })
      if (sent)
        void sent.catch(() => {
          this.metrics.telemetryFailures++
        })
    } catch {
      this.metrics.telemetryFailures++
    }
    while (this.started.size > 200) {
      const id = this.started.keys().next().value as string
      this.started.delete(id)
      this.terminal.delete(id)
    }
  }
  snapshot() {
    return {
      version: 1,
      metrics: structuredClone(this.metrics),
      cardinality: "aggregate-no-namespace-labels",
    }
  }
  auditTrail() {
    return {
      version: 1,
      entries: structuredClone(this.auditEntries),
      retention: 200,
      durableSink: Boolean(this.options.audit),
      failurePolicy: this.options.audit?.failurePolicy ?? "memory-only",
    }
  }
}
