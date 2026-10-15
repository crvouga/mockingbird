import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { OutboundPolicy, RequestLog } from "@crvouga/mockingbird-service"
import { type Clock, normalizeControls, restoreClock } from "@crvouga/mockingbird-service"
import type { MockingbirdConfig } from "./cli.js"
import type { EndpointManifest, FleetChild } from "./fleet.js"
import {
  canonical,
  diffArchives,
  digest,
  type FleetArchive,
  inspectArchive,
  sealArchive,
  validateArchive,
} from "./fleet-archive.js"
import {
  planRestoreBindings,
  type RestoreBindings,
  rebaseArchiveNamespace,
} from "./fleet-bindings.js"
import { FleetInstrumentation, type InstrumentationOptions } from "./fleet-instrumentation.js"
import { type JournalRecord, type OperationJournal, reconcileOperation } from "./fleet-journal.js"
import { type AssertionAllowance, FleetObservations } from "./fleet-observations.js"
import type { ArchiveProtector } from "./fleet-protection.js"
import { ingressSupport } from "./fleet-proxy.js"
import type { ArchiveRepository } from "./fleet-repository.js"
import { type ClockSynchronization, FleetTimeController } from "./fleet-time.js"

export type Operation = {
  scope?: string[]
  participant?: string
  actor?: string
  services?: string[]
  id: string
  namespace: string
  action: string
  phase: string
  startedAt: string
  finishedAt?: string
  status: "running" | "succeeded" | "failed" | "cancelled"
  completed: number
  total: number
  result?: unknown
}
export type WorkloadContext = {
  namespace: string
  services: string[]
  signal: AbortSignal
  operationId: string
}
export type WorkloadAdapter = {
  prepare?(context: WorkloadContext): Promise<void>
  verify?(context: WorkloadContext): Promise<void>
  resume?(context: WorkloadContext): Promise<void>
}
export type ScenarioBundle = {
  format: "mockingbird.scenario/v1"
  version: number
  description?: string
  services: Record<
    string,
    { protocol: FleetChild["protocol"]; controls?: Record<string, unknown>; fixtures?: unknown }
  >
  seed?: string | number
  clock?: { now: string | number; frozen?: boolean }
  seedApplication?(
    context: WorkloadContext & {
      manifest: EndpointManifest
      connections: Record<string, { url: string; namespaces: Record<string, string> }>
      headers: Record<string, string>
    },
  ): Promise<void>
}
export type ManagementOptions = InstrumentationOptions & {
  trace?: boolean
  journal?: OperationJournal
  synchronizeClock?: ClockSynchronization
  outbound?: OutboundPolicy
  archiveProtection?: ArchiveProtector
  resolveArchiveSecret?(reference: string): Promise<string>
  cors?: { origins: string[]; methods?: string[]; headers?: string[] }
  retention?: { maxCount?: number; ttlMs?: number }
  limits?: { maxNamespaces?: number; maxListeners?: number; connections?: number }
  workload?: WorkloadAdapter
  hookTimeoutMs?: number
  profiles?: Record<string, Record<string, Record<string, unknown>>>
  scenarios?: Record<string, ScenarioBundle>
  repository?: ArchiveRepository
  backupPolicy?: { intervalMs: number; namespaces?: string[]; keep?: number }
  expiry?: { idleMs: number; intervalMs?: number; finalBackup?: boolean }
  memberStatus?: boolean
}
type Point = {
  namespace: string
  values: Map<string, unknown>
  clock: ReturnType<Clock["state"]>
  createdAt?: string
  label?: unknown
}
type Context = {
  id: string
  config: MockingbirdConfig
  options: ManagementOptions
  children: Map<string, FleetChild>
  checkpoints: Map<string, Point>
  clock(namespace: string): Clock
  transaction(
    namespace: string,
    selected: Map<string, FleetChild>,
    run: (name: string, child: FleetChild) => Promise<unknown>,
    recover?: boolean,
  ): Promise<Response>
  manifest(): EndpointManifest
  publish(): Promise<void>
  recovery: Map<string, (() => void)[]>
  controlling: Map<string, string>
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
export const fleetError = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  Response.json(
    {
      ...extra,
      error: {
        type: "mockingbird_admin",
        code:
          (
            {
              400: "invalid_request",
              401: "unauthorized",
              403: "forbidden",
              404: "not_found",
              409: "conflict",
              413: "too_large",
              429: "quota_exceeded",
              500: "operation_failed",
              503: "unavailable",
            } as Record<number, string>
          )[status] ?? "request_failed",
        message,
      },
    },
    { status },
  )
const checked = (body: Record<string, unknown>, keys: string[]) => {
  const unknown = Object.keys(body).filter((k) => !keys.includes(k))
  if (unknown.length) throw new Error(`unknown fields: ${unknown.join(", ")}`)
}
const namePattern = /^[A-Za-z0-9_.-]{1,64}$/

export class FleetManagement {
  private readonly operationContext = new AsyncLocalStorage<Operation>()
  private readonly interrupted = new Map<string, JournalRecord>()
  private readonly durable = new Map<string, JournalRecord>()
  async recoverOperations() {
    if (!this.ctx.options.journal) return
    if (!this.ctx.options.repository)
      throw new Error("durable journal requires a portable archive repository")
    let records: JournalRecord[]
    try {
      records = await this.ctx.options.journal.load()
    } catch {
      throw new Error("durable operation journal unavailable")
    }
    for (const record of records) {
      const decision = await reconcileOperation(record, this.ctx.options.repository)
      if (decision.status === "terminal") continue
      if (
        decision.status === "abandoned-before-commit" ||
        decision.status === "verified-publication"
      ) {
        if (decision.status === "verified-publication")
          await this.restoreArchive(await this.ctx.options.repository.get(decision.archive))
        await this.ctx.options.journal.write({
          ...record,
          revision: record.revision + 1,
          phase: "resolved",
          resolution: decision.status,
          timestamp: new Date().toISOString(),
        })
        continue
      }
      this.interrupted.set(record.operationId, record)
      for (const namespace of record.scope) {
        if (!this.namespaces.has(namespace)) {
          const result = await this.createNamespace(namespace)
          if (!result.ok) throw new Error("cannot prepare interrupted namespace for recovery")
        }
        if (this.ctx.recovery.has(namespace)) continue
        const releases: (() => void)[] = []
        for (const child of this.ctx.children.values())
          try {
            releases.push(child.lock(namespace))
          } catch {}
        this.ctx.recovery.set(namespace, releases)
      }
    }
  }
  private fenceNamespaces(scope: string[]) {
    for (const namespace of scope) {
      const releases = this.ctx.recovery.get(namespace) ?? []
      for (const child of this.ctx.children.values())
        try {
          releases.push(child.lock(namespace))
        } catch {}
      this.ctx.recovery.set(namespace, releases)
    }
  }
  private async journalPhase(
    operationId: string,
    phase: JournalRecord["phase"],
    extra: Partial<Pick<JournalRecord, "after" | "writerGeneration" | "resolution">> = {},
  ) {
    const current = this.durable.get(operationId)
    if (!current || !this.ctx.options.journal) return
    const next = {
      ...current,
      ...extra,
      revision: current.revision + 1,
      phase,
      timestamp: new Date().toISOString(),
    }
    await this.ctx.options.journal.write(next)
    this.durable.set(operationId, next)
  }
  readonly observations: FleetObservations
  private requestPath(service: string, request: Request) {
    const prefix =
      this.ctx.config.services[service]?.adminPrefix ?? this.ctx.config.adminPrefix ?? "/__admin"
    let path = new URL(request.url).pathname
    if (path.startsWith(`${prefix}/ns/`)) {
      const tail = path.slice(`${prefix}/ns/`.length),
        slash = tail.indexOf("/")
      path = slash < 0 ? "/" : tail.slice(slash)
    }
    return { path, admin: path === prefix || path.startsWith(`${prefix}/`) }
  }
  beginRequest(service: string, namespace: string, request: Request) {
    const route = this.requestPath(service, request)
    return route.admin
      ? undefined
      : this.observations.beginHTTP(namespace, service, request, route.path)
  }
  async finishRequest(
    service: string,
    namespace: string,
    _request: Request,
    response: Response,
    log: RequestLog,
    token: unknown,
  ) {
    if (this.requestPath(service, _request).admin) return
    const pathFingerprint = createHash("sha256").update(log.path).digest("hex")
    this.observations.record({
      namespace,
      service,
      kind: "http",
      method: log.method,
      pathFingerprint,
      status: log.status,
      unmatched: log.unmatched,
      fault: log.faultId !== undefined,
      ...(log.operationId ? { operationId: log.operationId } : {}),
    })
    await this.observations.finishHTTP(
      token as Parameters<FleetObservations["finishHTTP"]>[0],
      response,
    )
  }
  observeDelivery(
    service: string,
    event: { namespace: string; state: string; deliveryId: string },
  ) {
    this.observations.record({
      namespace: event.namespace,
      service,
      kind: "webhook",
      deliveryState: event.state,
    })
  }
  readonly instrumentation: FleetInstrumentation
  readonly initializationToken = randomBytes(32).toString("base64url")
  private readonly environmentContext = new AsyncLocalStorage<string>()
  private environment: { id: string; fences: Map<string, Map<string, () => void>> } | undefined
  private ownsEnvironment() {
    return (
      this.environment !== undefined && this.environmentContext.getStore() === this.environment.id
    )
  }
  topologyBusy(namespace: string) {
    return (
      this.topology.has(namespace) || (this.environment !== undefined && !this.ownsEnvironment())
    )
  }
  environmentFence(namespace: string, service: string) {
    return this.ownsEnvironment() && this.environment?.fences.get(namespace)?.has(service) === true
  }
  checkCancelled(namespace: string) {
    const id = this.operationId(namespace)
    if (id && this.aborts.get(id)?.signal.aborted)
      throw new Error("operation cancelled before commit")
  }
  private activeOperation(namespace: string) {
    const current = this.operationContext.getStore()
    return current?.status === "running"
      ? current
      : [...this.operations.values()].find(
          (operation) => operation.namespace === namespace && operation.status === "running",
        )
  }
  operationId(namespace: string) {
    return this.activeOperation(namespace)?.id
  }
  private async withEnvironment<T>(
    namespaces: string[],
    selected: Map<string, FleetChild>,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.ownsEnvironment()) return run()
    if (this.environment || this.ctx.controlling.size || this.topology.size)
      throw new Error("environment operation conflicts with active namespace work")
    const env = { id: randomUUID(), fences: new Map<string, Map<string, () => void>>() }
    this.environment = env
    return this.environmentContext.run(env.id, async () => {
      try {
        for (const ns of namespaces) {
          if (!this.namespaces.has(ns)) continue
          await this.hook("prepare", ns, selected)
          const fences = new Map<string, () => void>()
          env.fences.set(ns, fences)
          for (const [name, child] of selected) {
            if (
              child.protocol !== "http" &&
              !Object.hasOwn((child.namespaces.endpoints ?? {}) as object, ns)
            )
              continue
            if (this.ctx.recovery.has(ns)) continue
            fences.set(name, child.lock(ns))
          }
          if (this.busy(ns, selected).length) throw new Error(`namespace ${ns} is not quiescent`)
        }
        return await run()
      } finally {
        for (const [ns, fences] of env.fences) {
          if (this.ctx.recovery.has(ns)) this.ctx.recovery.get(ns)?.push(...fences.values())
          else for (const unlock of [...fences.values()].reverse()) unlock()
        }
        this.environment = undefined
      }
    })
  }
  readonly operations = new Map<string, Operation>()
  readonly namespaces = new Map<
    string,
    {
      generation: string
      createdAt: number
      activityAt: number
      pinned: boolean
      expiresAt?: number
    }
  >()
  private readonly credentials = new Map<
    string,
    { id: string; namespaces: string[]; actions: string[]; expiresAt: number }
  >()
  private readonly retries = new Map<
    string,
    { fingerprint: string; expires: number; response: Promise<Response> }
  >()
  private readonly events: { id: string; namespace: string; operation: Operation }[] = []
  private readonly subscribers = new Set<{
    namespace: string
    member: boolean
    push(event: string): void
  }>()
  private readonly aborts = new Map<string, AbortController>()
  private readonly topology = new Set<string>()
  private readonly privateRequests = new Map<string, string>()
  privateRequest(namespace: string, request: Request) {
    const token = request.headers.get("x-mockingbird-initializer")
    return (
      token !== null &&
      (this.privateRequests.get(namespace) === token ||
        (this.lifecycle === "initializing" && token === this.initializationToken))
    )
  }
  private sequence = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private expiryTimer: ReturnType<typeof setInterval> | undefined
  private backupRunning = false
  private backupStatus: {
    lastAttempt?: string
    lastSuccess?: string
    lastFailure?: string
    nextRun?: string
    archiveId?: string
  } = {}
  lifecycle: "starting" | "initializing" | "ready" | "draining" | "failed" | "stopped" = "starting"
  constructor(private readonly ctx: Context) {
    this.instrumentation = new FleetInstrumentation(ctx.options)
    this.observations = new FleetObservations(ctx.id)
    this.remember("default")
    for (const child of ctx.children.values())
      for (const ns of Object.keys((child.namespaces.endpoints ?? {}) as object)) this.remember(ns)
    for (const value of Object.values(ctx.options.limits ?? {}))
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("limits must be nonnegative integers")
    for (const child of ctx.children.values())
      child.setAdmission?.((namespace) => {
        const entry = this.namespaces.get(namespace)
        if (entry) entry.activityAt = Date.now()
        if (
          this.lifecycle === "initializing" ||
          this.lifecycle === "draining" ||
          this.lifecycle === "failed" ||
          this.environment ||
          this.topology.has(namespace) ||
          this.ctx.recovery.has(namespace)
        )
          return false
        const limit = this.ctx.options.limits?.connections
        if (limit === undefined) return true
        let connections = 0
        for (const c of ctx.children.values()) {
          if (
            c.protocol !== "http" &&
            !Object.hasOwn((c.namespaces.endpoints ?? {}) as object, namespace)
          )
            continue
          const d = c.diagnostics(namespace)
          connections += d.activeConnections + (c.protocol === "http" ? d.activeRequests : 0)
        }
        return connections < limit
      })
    const retention = ctx.options.retention
    if (
      retention?.maxCount !== undefined &&
      (!Number.isSafeInteger(retention.maxCount) || retention.maxCount < 1)
    )
      throw new Error("retention maxCount must be positive")
    if (
      retention?.ttlMs !== undefined &&
      (!Number.isFinite(retention.ttlMs) || retention.ttlMs < 1)
    )
      throw new Error("retention ttlMs must be positive")
  }
  remember(namespace: string) {
    if (!this.namespaces.has(namespace))
      this.namespaces.set(namespace, {
        generation: randomUUID(),
        createdAt: Date.now(),
        activityAt: Date.now(),
        pinned: false,
      })
    return this.namespaces.get(namespace) as NonNullable<ReturnType<typeof this.namespaces.get>>
  }
  generation(namespace: string) {
    return this.remember(namespace).generation
  }
  admit(namespace: string, request: Request): Response | undefined {
    if (this.privateRequest(namespace, request)) return undefined
    if (this.topology.has(namespace) || this.environment)
      return fleetError(409, "namespace lifecycle operation in progress", { namespace })
    if (
      this.lifecycle === "initializing" &&
      request.headers.get("x-mockingbird-initializer") === this.initializationToken
    )
      return undefined
    if (this.lifecycle !== "ready" && this.lifecycle !== "starting")
      return fleetError(503, `fleet is ${this.lifecycle}`)
    if (
      !this.namespaces.has(namespace) &&
      this.ctx.options.limits?.maxNamespaces !== undefined &&
      this.namespaces.size + this.topology.size >= this.ctx.options.limits.maxNamespaces
    )
      return fleetError(429, "maximum namespaces reached")
    const entry = this.remember(namespace)
    entry.activityAt = Date.now()
    const expected = request.headers.get("x-mockingbird-generation")
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      expected !== null &&
      expected !== entry.generation
    )
      return fleetError(409, "stale namespace generation", { generation: entry.generation })
    const limits = this.ctx.options.limits
    if (limits)
      for (const child of this.ctx.children.values()) {
        if (
          child.protocol !== "http" &&
          !Object.hasOwn((child.namespaces.endpoints ?? {}) as object, namespace)
        )
          continue
        const usage = child.diagnostics(namespace)
        if (
          limits.connections !== undefined &&
          usage.activeConnections + usage.activeRequests >= limits.connections
        )
          return fleetError(429, "namespace admission quota reached", { namespace })
      }
    return undefined
  }
  private emit(operation: Operation) {
    this.instrumentation.phase(
      operation,
      (operation.scope ?? [operation.namespace]).some((namespace) =>
        this.ctx.recovery.has(namespace),
      ),
    )
    const event = {
      id: `${this.ctx.id}:${++this.sequence}`,
      namespace: operation.namespace,
      operation: structuredClone(operation),
    }
    this.events.push(event)
    if (this.events.length > 500) this.events.shift()
    for (const sub of this.subscribers)
      if (sub.namespace === operation.namespace) {
        const data = sub.member
          ? {
              id: event.id,
              namespace: event.namespace,
              operation: {
                id: operation.id,
                phase: operation.phase,
                status: operation.status,
                completed: operation.completed,
                total: operation.total,
              },
            }
          : event
        sub.push(`id: ${event.id}\nevent: lifecycle\ndata: ${JSON.stringify(data)}\n\n`)
      }
  }
  phase(
    namespace: string,
    phase: string,
    completed?: number,
    total?: number,
    participant?: string,
  ) {
    const operation = this.activeOperation(namespace)
    if (operation) {
      operation.phase = phase
      if (participant) operation.participant = participant
      else delete operation.participant
      if (completed !== undefined) operation.completed = completed
      if (total !== undefined) operation.total = total
      this.emit(operation)
    }
  }
  private prune() {
    const { maxCount = 50, ttlMs = 24 * 3600000 } = this.ctx.options.retention ?? {}
    const entries = [...this.ctx.checkpoints]
    for (const [id, point] of entries)
      if (Date.now() - Date.parse(point.createdAt ?? new Date().toISOString()) > ttlMs)
        this.ctx.checkpoints.delete(id)
    while (this.ctx.checkpoints.size > maxCount)
      this.ctx.checkpoints.delete(this.ctx.checkpoints.keys().next().value as string)
  }
  private select(body: Record<string, unknown>) {
    if (body.services === undefined) return this.ctx.children
    if (
      !Array.isArray(body.services) ||
      !body.services.length ||
      body.services.some((n) => typeof n !== "string" || !this.ctx.children.has(n))
    )
      throw new Error("services must be a nonempty list of configured service names")
    return new Map(
      (body.services as string[]).map((n) => [n, this.ctx.children.get(n) as FleetChild]),
    )
  }
  private scope(namespace: string, selected: Map<string, FleetChild>) {
    for (const [name, child] of selected)
      if (
        child.protocol !== "http" &&
        !Object.hasOwn((child.namespaces.endpoints ?? {}) as object, namespace)
      )
        throw new Error(`namespace ${namespace} is not configured for ${name}`)
  }
  private capability() {
    return {
      version: 1,
      archiveFormat: "mockingbird.fleet/v1",
      archiveProtection: this.ctx.options.archiveProtection?.policy ?? { format: "none" },
      processId: this.ctx.id,
      authentication: ["admin-key", "scoped-credential"],
      scopes: ["namespace", "services", "environment"],
      routes: [
        ["GET", ""],
        ["GET", "/namespaces"],
        ["POST", "/namespaces/{namespace}/fork"],
        ["GET", "/audit"],
        ["GET", "/telemetry"],
        ["GET", "/recovery"],
        ["POST", "/recovery/{id}/rollback"],
        ["POST", "/time/step-next"],
        ["POST", "/time/run-until"],
        ["POST", "/assertions/baseline"],
        ["POST", "/assertions/{id}/check"],
        ["POST", "/trace/start"],
        ["POST", "/trace/stop"],
        ["GET", "/trace"],
        ["POST", "/archives/bindings"],
        ["POST", "/namespaces/{namespace}"],
        ["DELETE", "/namespaces/{namespace}"],
        ["GET", "/namespaces/{namespace}/snapshots"],
        ["POST", "/namespaces/{namespace}/snapshots"],
        ["GET", "/namespaces/{namespace}/snapshots/{id}"],
        ["DELETE", "/namespaces/{namespace}/snapshots/{id}"],
        ["POST", "/namespaces/{namespace}/snapshots/{id}/restore"],
        ["GET", "/metrics"],
        ["GET", "/clock"],
        ["POST", "/clock"],
        ["POST", "/can-checkpoint"],
        ["POST", "/wait-until-idle"],
        ["POST", "/archives/export"],
        ["POST", "/archives/import"],
        ["POST", "/archives/inspect"],
        ["POST", "/archives/diff"],
        ["GET", "/operations"],
        ["GET", "/operations/{id}"],
        ["POST", "/operations/{id}/cancel"],
        ["GET", "/events"],
        ["POST", "/profiles/apply"],
        ["POST", "/profiles/baseline"],
        ["GET", "/scenarios"],
        ["POST", "/scenarios/{name}/apply"],
        ["GET", "/inspect"],
        ["GET", "/diagnostics"],
        ["POST", "/credentials"],
        ["DELETE", "/credentials/{id}"],
        ["POST", "/backups"],
        ["GET", "/backups"],
        ["GET", "/cleanup"],
        ["POST", "/cleanup"],
        ["POST", "/namespaces/{namespace}/policy"],
      ].map(([method, path]) => ({ method, path })),
      services: Object.fromEntries(
        [...this.ctx.children].map(([name, c]) => [
          name,
          {
            protocol: c.protocol,
            coverage: c.coverage,
            ingress: c.targetName === "stripe" ? ingressSupport.stripe : ingressSupport.other,
            target: c.targetName,
            outboundPolicy: c.outboundPolicy ?? "unsupported",
            version: 1,
            packageVersion: c.packageVersion,
            nextEvent: Boolean(c.nextEvent),
            externalWorkerClock: "requires explicit harness synchronization",
            checkpoint: true,
            portable: Boolean(c.exportCheckpoint && c.importCheckpoint),
            provisioning: Boolean(c.createNamespace && c.deleteNamespace),
            inspect: Boolean(c.inspect),
            controls: c.protocol === "http" ? ["clock", "faults", "latency", "seed"] : ["clock"],
            stalePrecondition: c.protocol === "http",
          },
        ]),
      ),
      limits: {
        usage: {
          namespaces: this.namespaces.size,
          listeners: [...this.ctx.children.values()].reduce(
            (n, c) =>
              n +
              (c.protocol === "http"
                ? 1
                : Object.keys((c.namespaces.endpoints ?? {}) as object).length),
            1,
          ),
        },
        headroom: {
          namespaces:
            this.ctx.options.limits?.maxNamespaces === undefined
              ? null
              : this.ctx.options.limits.maxNamespaces - this.namespaces.size,
        },
        checkpoints: this.ctx.options.retention?.maxCount ?? 50,
        eventHistory: 500,
        operationHistory: 200,
        idempotencyMs: 3600000,
        supportedBudgets: ["maxNamespaces", "maxListeners", "connections"],
        unsupportedBudgets: ["objectBytes", "records", "pendingJobs"],
        ...this.ctx.options.limits,
      },
    }
  }
  private action(path: string, method: string) {
    if (["GET", "HEAD"].includes(method)) return "read"
    if (/\/credentials/.test(path)) return "credentials"
    if (/\/reset$/.test(path)) return "reset"
    if (/\/restore$/.test(path) || path.endsWith("/archives/import")) return "restore"
    if (/\/snapshots/.test(path) || path.endsWith("/archives/export")) return "snapshot"
    if (/\/namespaces\/[^/]+$/.test(path)) return "namespace"
    return "control"
  }
  private auth(
    request: Request,
    namespace: string,
    action: string,
    path: string,
  ): string | Response {
    const key = request.headers.get("x-mockingbird-admin-key")
    const adminKey = this.ctx.config.adminKey ?? process.env.MOCKINGBIRD_ADMIN_KEY
    if (key !== null && (adminKey === undefined || key !== adminKey)) {
      const credential = this.credentials.get(digest(key))
      if (credential && credential.expiresAt > Date.now()) {
        if (
          !credential.namespaces.includes(namespace) ||
          !credential.actions.includes(action) ||
          /\/(credentials|cleanup|backups)(\/|$)/.test(path) ||
          ["/fleet", "/fleet/namespaces"].includes(path) ||
          path === "/fleet/archives/import" ||
          path === "/fleet/archives/export"
        )
          return fleetError(403, "credential does not permit this scope or action")
        return credential.id
      }
      return fleetError(401, "invalid or expired credential")
    }
    if (adminKey !== undefined && key !== adminKey) return fleetError(401, "admin key required")
    return "admin"
  }
  async dispatch(request: Request, fallback: () => Promise<Response>): Promise<Response> {
    const cors = this.ctx.options.cors
    const url = new URL(request.url),
      prefix = this.ctx.config.adminPrefix ?? "/__admin"
    const controlled =
      url.pathname === `${prefix}/fleet` ||
      url.pathname.startsWith(`${prefix}/fleet/`) ||
      url.pathname === `${prefix}/ui`
    const origin = request.headers.get("origin")
    const allowed =
      controlled && cors !== undefined && origin !== null && cors.origins.includes(origin)
    const methods = cors?.methods ?? ["GET", "POST", "DELETE", "OPTIONS"]
    const headers = cors?.headers ?? [
      "content-type",
      "x-mockingbird-admin-key",
      "x-mockingbird-namespace",
      "idempotency-key",
      "last-event-id",
    ]
    if (controlled && cors && request.method === "OPTIONS" && origin !== null) {
      const method = request.headers.get("access-control-request-method")
      const requested = (request.headers.get("access-control-request-headers") ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
      if (
        !allowed ||
        !method ||
        !methods.includes(method) ||
        requested.some((h) => !headers.map((v) => v.toLowerCase()).includes(h))
      )
        return fleetError(403, "CORS preflight denied")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": methods.join(", "),
          "access-control-allow-headers": headers.join(", "),
          vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        },
      })
    }
    const response = await this.dispatchControl(request, fallback)
    if (controlled && cors) {
      response.headers.append("vary", "Origin")
      if (allowed && origin) response.headers.set("access-control-allow-origin", origin)
    }
    return response
  }
  private async dispatchControl(
    request: Request,
    fallback: () => Promise<Response>,
  ): Promise<Response> {
    const url = new URL(request.url),
      prefix = this.ctx.config.adminPrefix ?? "/__admin"
    if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) return fallback()
    const path = url.pathname.slice(prefix.length).replace(/\/$/, "")
    if (path === "/live" && request.method === "GET")
      return Response.json(
        { status: this.lifecycle === "stopped" ? "stopped" : "alive", id: this.ctx.id },
        { status: this.lifecycle === "stopped" ? 503 : 200 },
      )
    if (
      path === "/health" &&
      (this.lifecycle !== "ready" ||
        this.ctx.controlling.size ||
        this.ctx.recovery.size ||
        this.environment)
    )
      return Response.json(
        {
          status: this.ctx.recovery.size
            ? "failed"
            : this.ctx.controlling.size || this.environment
              ? "maintenance"
              : this.lifecycle,
          alive: this.lifecycle !== "stopped",
          operations: [...this.ctx.controlling].map(([namespace, operationId]) => ({
            namespace,
            operationId,
          })),
          fenced: [...this.ctx.recovery.keys()],
        },
        { status: 503 },
      )
    if (!path.startsWith("/fleet") && path !== "/ui") return fallback()
    let namespace: string
    try {
      namespace = /^\/fleet\/namespaces\/([^/]+)/.test(path)
        ? decodeURIComponent(path.split("/")[3] as string)
        : (url.searchParams.get("namespace") ??
          request.headers.get("x-mockingbird-namespace") ??
          this.ctx.config.namespace ??
          "default")
    } catch {
      return fleetError(400, "invalid namespace encoding")
    }
    if (!namePattern.test(namespace)) return fleetError(400, "invalid namespace")
    const action = this.action(path, request.method),
      caller = this.auth(request, namespace, action, path)
    const member =
      path === "/fleet/events" && request.method === "GET" && this.ctx.options.memberStatus === true
    if (caller instanceof Response && !member) {
      const audited = await this.instrumentation.audit({
        actor: "unauthorized",
        namespace,
        action: `${request.method} ${this.action(path, request.method)}`,
        services: [],
        stage: "denied",
      })
      if (!audited) return fleetError(503, "required audit sink unavailable")
      return caller
    }
    let body: Record<string, unknown> = {}
    if (!["GET", "HEAD", "DELETE"].includes(request.method)) {
      try {
        const text = await request.clone().text()
        const parsed: unknown = text ? JSON.parse(text) : {}
        if (!object(parsed)) throw new Error()
        body = parsed
      } catch {
        return fleetError(400, "expected JSON object")
      }
    }
    this.prune()
    const mutating = !["GET", "HEAD"].includes(request.method)
    const run = async () => {
      let operation: Operation | undefined
      if (
        mutating &&
        !path.includes("/operations/") &&
        !path.endsWith("/can-checkpoint") &&
        !path.endsWith("/wait-until-idle")
      ) {
        operation = {
          id: randomUUID(),
          scope: body.allNamespaces === true ? [...this.namespaces.keys()] : [namespace],
          actor: typeof caller === "string" ? caller : "member",
          services:
            Array.isArray(body.services) &&
            body.services.every((s) => typeof s === "string" && this.ctx.children.has(s))
              ? (body.services as string[])
              : [...this.ctx.children.keys()],
          namespace,
          action: `${request.method} ${path}`,
          phase: "validating",
          startedAt: new Date().toISOString(),
          status: "running",
          completed: 0,
          total: this.ctx.children.size,
        }
        this.operations.set(operation.id, operation)
        this.aborts.set(operation.id, new AbortController())
        this.emit(operation)
      }
      const execute = async () => {
        try {
          if (
            operation &&
            !(await this.instrumentation.audit({
              actor: operation.actor ?? "admin",
              namespace,
              action,
              services: operation.services ?? [],
              operationId: operation.id,
              stage: "attempt",
            }))
          )
            throw new Error("required audit sink unavailable before mutation")
          if (
            operation &&
            this.ctx.options.journal &&
            !path.startsWith("/fleet/recovery") &&
            !path.includes("/assertions/") &&
            !path.startsWith("/fleet/trace")
          ) {
            if (!this.ctx.options.repository)
              throw new Error("durable journal requires a repository")
            let before: string | undefined
            if (this.namespaces.has(namespace) && !this.ctx.recovery.has(namespace)) {
              const archive = await this.capture(
                body.allNamespaces === true ? [...this.namespaces.keys()] : [namespace],
                this.select(body),
              )
              before = await this.ctx.options.repository.put(archive)
              await this.ctx.options.repository.get(before)
            }
            const record: JournalRecord = {
              version: 1,
              revision: 1,
              operationId: operation.id,
              controller: this.ctx.id,
              namespace,
              scope: body.allNamespaces === true ? [...this.namespaces.keys()] : [namespace],
              action,
              phase: "prepared",
              timestamp: new Date().toISOString(),
              requestFingerprint: digest({ path, body, method: request.method }),
              ...(before ? { before } : {}),
            }
            await this.ctx.options.journal.write(record)
            this.durable.set(operation.id, record)
            await this.journalPhase(operation.id, "committing")
          }
          const result =
            (await this.handle(
              request,
              path,
              namespace,
              body,
              caller === "admin" && (!member || request.headers.has("x-mockingbird-admin-key")),
            )) ?? (await fallback())
          if (operation) {
            operation.status = this.aborts.get(operation.id)?.signal.aborted
              ? "cancelled"
              : result.ok
                ? "succeeded"
                : "failed"
            operation.phase = operation.status
            operation.finishedAt = new Date().toISOString()
            const payload: unknown = await result
              .clone()
              .json()
              .catch(() => undefined)
            operation.result = object(payload)
              ? Object.fromEntries(
                  Object.entries(payload).filter(([key]) =>
                    [
                      "status",
                      "id",
                      "namespace",
                      "failedService",
                      "rollback",
                      "rolledBack",
                      "error",
                      "sha256",
                    ].includes(key),
                  ),
                )
              : { status: result.status }
            if (result.ok) operation.completed = operation.total
            await this.journalPhase(
              operation.id,
              result.ok
                ? "succeeded"
                : this.ctx.recovery.has(namespace)
                  ? "recovery-required"
                  : "failed",
            )
            if (result.ok && (action === "reset" || action === "restore")) {
              for (const record of this.interrupted.values())
                if (record.scope.includes(namespace)) {
                  const scope = record.scope.filter((ns) => ns !== namespace)
                  const resolved: JournalRecord = {
                    ...record,
                    scope,
                    revision: record.revision + 1,
                    phase: scope.length ? "recovery-required" : "resolved",
                    resolution: `explicit-${action}`,
                    timestamp: new Date().toISOString(),
                  }
                  try {
                    await this.ctx.options.journal?.write(resolved)
                  } catch (error) {
                    this.fenceNamespaces(record.scope)
                    throw error
                  }
                  if (scope.length) this.interrupted.set(record.operationId, resolved)
                  else this.interrupted.delete(record.operationId)
                }
              await this.ctx.publish()
            }
            if (
              !(await this.instrumentation.audit({
                actor: operation.actor ?? "admin",
                namespace,
                action,
                services: operation.services ?? [],
                operationId: operation.id,
                stage: "terminal",
                result:
                  operation.status === "succeeded"
                    ? "succeeded"
                    : operation.status === "cancelled"
                      ? "cancelled"
                      : "failed",
              }))
            ) {
              const fences: (() => void)[] = []
              for (const name of operation.services ?? [])
                try {
                  const release = this.ctx.children.get(name)?.lock(namespace)
                  if (release) fences.push(release)
                } catch {}
              this.ctx.recovery.set(namespace, fences)
              await this.journalPhase(operation.id, "recovery-required")
              throw new Error("required terminal audit unavailable; recovery required")
            }
            result.headers.set("x-mockingbird-operation-id", operation.id)
            this.emit(operation)
            if (
              result.ok &&
              request.method !== "DELETE" &&
              (action === "restore" || action === "reset" || action === "namespace")
            )
              this.remember(namespace).generation = randomUUID()
          }
          if (result.ok && request.method === "POST") {
            if (path === "/fleet/clock") this.observations.control(namespace, "clock", body)
            else if (/^\/fleet\/namespaces\/[^/]+\/reset$/.test(path))
              this.observations.control(namespace, "reset", body)
            else if (!path.startsWith("/fleet/trace") && !path.includes("/assertions/"))
              this.observations.unsupportedControl(namespace, action)
          }
          for (const point of this.ctx.checkpoints.values())
            if (!point.createdAt) {
              point.createdAt = new Date().toISOString()
              if (body.label !== undefined) point.label = body.label
            }
          this.prune()
          if (this.ctx.recovery.size) await this.ctx.publish()
          return result
        } catch (error) {
          if (
            operation &&
            ["committing", "uploading", "publishing"].includes(
              this.durable.get(operation.id)?.phase ?? "",
            )
          ) {
            const releases = this.ctx.recovery.get(namespace) ?? []
            for (const child of this.ctx.children.values())
              try {
                releases.push(child.lock(namespace))
              } catch {}
            this.ctx.recovery.set(namespace, releases)
          }
          if (operation) {
            operation.status = "failed"
            operation.phase = "failed"
            operation.finishedAt = new Date().toISOString()
            operation.result = {
              message: error instanceof Error ? error.message : "operation failed",
            }
            this.emit(operation)
          }
          if (this.ctx.recovery.size) await this.ctx.publish().catch(() => {})
          return fleetError(400, error instanceof Error ? error.message : "invalid control")
        } finally {
          if (operation) this.aborts.delete(operation.id)
          while (this.operations.size > 200) {
            const entry = [...this.operations].find(([, o]) => o.status !== "running")
            if (!entry) break
            this.operations.delete(entry[0])
          }
        }
      }
      return operation ? this.operationContext.run(operation, execute) : execute()
    }
    const key = request.headers.get("idempotency-key")
    if (!key || !mutating) return run()
    if (key.length > 256) return fleetError(400, "idempotency key too long")
    for (const [id, kept] of this.retries) if (kept.expires < Date.now()) this.retries.delete(id)
    const scope = `${typeof caller === "string" ? caller : "member"}:${namespace}:${key}`
    const fingerprint = digest({ path, method: request.method, body })
    const existing = this.retries.get(scope)
    if (existing)
      return existing.fingerprint === fingerprint
        ? (await existing.response).clone()
        : fleetError(409, "idempotency key reused with different request")
    if (this.retries.size >= 1000) return fleetError(429, "idempotency retention capacity reached")
    const response = Promise.resolve().then(run)
    this.retries.set(scope, { fingerprint, expires: Date.now() + 3600000, response })
    return (await response).clone()
  }
  private async handle(
    request: Request,
    path: string,
    namespace: string,
    body: Record<string, unknown>,
    admin: boolean,
  ): Promise<Response | undefined> {
    const route = path.slice("/fleet".length),
      method = request.method
    if (path === "/ui")
      return new Response(fleetConsole(this.ctx.config.adminPrefix ?? "/__admin"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    if (route === "" && method === "GET")
      return Response.json({
        ...this.capability(),
        manifest: this.ctx.manifest(),
        namespaces: this.namespaceStatus(),
      })
    if (route === "/recovery" && method === "GET")
      return admin
        ? Response.json({
            version: 1,
            interrupted: [...this.interrupted.values()],
            resumable: Boolean(this.ctx.options.journal),
          })
        : fleetError(403, "recovery administration required")
    const recovery = /^\/recovery\/([^/]+)\/rollback$/.exec(route)
    if (recovery && method === "POST") {
      checked(body, [])
      if (!admin) return fleetError(403, "recovery administration required")
      const record = this.interrupted.get(recovery[1] as string)
      if (!record?.before || !this.ctx.options.repository || !this.ctx.options.journal)
        throw new Error(
          "interrupted operation has no verified portable before-state; explicit namespace reset is required",
        )
      const beforeArchive = await this.ctx.options.repository.get(record.before)
      const { sha256: _identity, ...content } = beforeArchive
      await this.restoreArchive(
        sealArchive({
          ...content,
          namespaces: Object.fromEntries(
            Object.entries(beforeArchive.namespaces).filter(([namespace]) =>
              record.scope.includes(namespace),
            ),
          ),
        }),
      )
      try {
        await this.ctx.options.journal.write({
          ...record,
          revision: record.revision + 1,
          phase: "resolved",
          resolution: "explicit-restore-before",
          timestamp: new Date().toISOString(),
        })
      } catch (error) {
        this.fenceNamespaces(record.scope)
        throw error
      }

      this.interrupted.delete(record.operationId)
      await this.ctx.publish()
      return Response.json({
        status: "resolved",
        operationId: record.operationId,
        resolution: "restored-before-state",
      })
    }
    if (route === "/telemetry" && method === "GET")
      return admin
        ? Response.json(this.instrumentation.snapshot())
        : fleetError(403, "operator telemetry requires administrator scope")
    if (route === "/audit" && method === "GET")
      return admin
        ? Response.json(this.instrumentation.auditTrail())
        : fleetError(403, "audit trail requires administrator scope")
    if (route === "/namespaces" && method === "GET")
      return Response.json({ namespaces: this.namespaceStatus() })
    const fork = /^\/namespaces\/[^/]+\/fork$/.test(route)
    if (fork && method === "POST") {
      checked(body, ["destination", "bindings"])
      if (!admin) return fleetError(403, "namespace fork requires administrator scope")
      if (typeof body.destination !== "string" || !namePattern.test(body.destination))
        throw new Error("destination namespace required")
      const destination = body.destination
      if (this.namespaces.has(destination))
        return fleetError(409, "destination namespace already exists")
      return this.withEnvironment([namespace, destination], this.ctx.children, async () => {
        let archive = await this.capture([namespace])
        let bindings: unknown = {
          changes: [],
          limitations: ["opaque namespace-bearing keys and application credentials are unchanged"],
        }
        if (body.bindings !== undefined) {
          const prepared = await planRestoreBindings(
            archive,
            body.bindings as RestoreBindings,
            this.ctx.options.resolveArchiveSecret,
          )
          archive = prepared.archive
          bindings = prepared.report
        }
        await this.restoreArchive(rebaseArchiveNamespace(archive, namespace, destination))
        return Response.json(
          {
            namespace: destination,
            generation: this.generation(destination),
            manifest: this.ctx.manifest(),
            bindings,
            connections: Object.fromEntries(
              [...this.ctx.children].map(([name, child]) => [
                name,
                child.connections?.[destination] ??
                  `${child.url}${this.ctx.config.adminPrefix ?? "/__admin"}/ns/${destination}`,
              ]),
            ),
          },
          { status: 201 },
        )
      })
    }
    if (route === "/archives/bindings" && method === "POST") {
      if (!admin) return fleetError(403, "restore binding plans require administrator scope")
      checked(body, ["archive", "plan"])
      const prepared = await planRestoreBindings(
        body.archive,
        body.plan as RestoreBindings,
        this.ctx.options.resolveArchiveSecret,
      )
      return Response.json(prepared.report)
    }
    if (route === "/assertions/baseline" && method === "POST") {
      checked(body, ["services"])
      const selected = this.select(body)
      this.scope(namespace, selected)
      return Response.json(this.observations.baseline(namespace, [...selected.keys()]))
    }
    const assertion = /^\/assertions\/([^/]+)\/check$/.exec(route)
    if (assertion && method === "POST") {
      checked(body, ["allowances", "allowCheckpointablePending"])
      if (
        body.allowCheckpointablePending !== undefined &&
        typeof body.allowCheckpointablePending !== "boolean"
      )
        throw new Error("allowCheckpointablePending must be boolean")
      const diagnostics = Object.fromEntries(
        [...this.ctx.children]
          .filter(
            ([, child]) =>
              child.protocol === "http" ||
              Object.hasOwn((child.namespaces.endpoints ?? {}) as object, namespace),
          )
          .map(([name, child]) => [name, child.diagnostics(namespace)]),
      )
      const report = this.observations.assertClean(
        assertion[1] as string,
        namespace,
        diagnostics,
        body as { allowances?: AssertionAllowance[]; allowCheckpointablePending?: boolean },
      )
      return Response.json(report, { status: report.clean ? 200 : 409 })
    }
    if (route.startsWith("/trace")) {
      if (!admin) return fleetError(403, "trace capture requires administrator scope")
      if (!this.ctx.options.trace) return fleetError(400, "trace capture is not enabled")
      if (route === "/trace/start" && method === "POST") {
        checked(body, ["includeBodies"])
        if (body.includeBodies !== undefined && typeof body.includeBodies !== "boolean")
          throw new Error("includeBodies must be boolean")
        const baseline = await this.capture([namespace])
        const limitations = [...this.ctx.children.values()].some(
          (child) => child.protocol !== "http",
        )
          ? ["protocol/external interactions are not captured"]
          : []
        return Response.json(
          this.observations.startTrace(
            namespace,
            baseline,
            body.includeBodies === true,
            limitations,
          ),
        )
      }
      if (route === "/trace" && method === "GET")
        return Response.json(this.observations.trace(namespace))
      if (route === "/trace/stop" && method === "POST") {
        checked(body, [])
        return Response.json(this.observations.trace(namespace, true))
      }
    }
    const nsRoute = /^\/namespaces\/([^/]+)$/.exec(route)
    if (nsRoute && method === "POST") {
      checked(body, ["baseline"])
      if (body.baseline !== undefined && typeof body.baseline !== "string")
        throw new Error("baseline must be a checkpoint id")
      return this.createNamespace(namespace, body.baseline as string | undefined)
    }
    if (nsRoute && method === "DELETE") return this.deleteNamespace(namespace)
    if (/^\/namespaces\/[^/]+\/policy$/.test(route) && method === "POST") {
      checked(body, ["pinned", "expiresInMs"])
      if (body.pinned !== undefined && typeof body.pinned !== "boolean")
        throw new Error("pinned must be boolean")
      if (
        body.expiresInMs !== undefined &&
        (typeof body.expiresInMs !== "number" ||
          !Number.isSafeInteger(body.expiresInMs) ||
          body.expiresInMs < 1 ||
          body.expiresInMs > 86400000)
      )
        throw new Error("expiry must be within one host day")
      if (body.pinned === undefined && body.expiresInMs === undefined)
        throw new Error("namespace policy required")
      if (typeof body.pinned === "boolean") this.remember(namespace).pinned = body.pinned
      if (typeof body.expiresInMs === "number") {
        this.remember(namespace).expiresAt = Date.now() + body.expiresInMs
        if (!this.expiryTimer) {
          this.expiryTimer = setInterval(
            () => {
              for (const entry of this.cleanupPreview())
                if (entry.eligible) void this.deleteNamespace(entry.namespace).catch(() => {})
            },
            Math.max(10, Math.min(60000, body.expiresInMs as number)),
          )
          this.expiryTimer.unref?.()
        }
      }
      return Response.json({ namespace, ...this.remember(namespace) })
    }
    const snapshot = /^\/namespaces\/[^/]+\/snapshots(?:\/([^/]+))?$/.exec(route)
    if (snapshot && (method === "GET" || method === "DELETE")) {
      const info = (id: string, p: Point) => ({
        id,
        namespace: p.namespace,
        label: p.label,
        createdAt: p.createdAt,
        services: [...p.values.keys()],
        portable: [...p.values.keys()].every((s) =>
          Boolean(this.ctx.children.get(s)?.exportCheckpoint),
        ),
      })
      if (!snapshot[1]) {
        if (method !== "GET") return fleetError(405, "select a checkpoint to delete")
        return Response.json({
          snapshots: [...this.ctx.checkpoints]
            .filter(([, p]) => p.namespace === namespace)
            .map(([id, p]) => info(id, p)),
        })
      }
      const point = this.ctx.checkpoints.get(snapshot[1])
      if (!point || point.namespace !== namespace)
        return fleetError(404, "no checkpoint in this namespace")
      if (method === "DELETE") this.ctx.checkpoints.delete(snapshot[1])
      return Response.json(
        method === "DELETE" ? { status: "deleted", id: snapshot[1] } : info(snapshot[1], point),
      )
    }
    if ((route === "/time/step-next" || route === "/time/run-until") && method === "POST") {
      checked(body, ["services", "condition", "maxEvents", "maxAdvanceMs", "timeoutMs"])
      const selected = this.select(body)
      this.scope(namespace, selected)
      const controller = new FleetTimeController({
        clock: this.ctx.clock,
        transaction: this.ctx.transaction,
        phase: (ns, phase, done, total) => this.phase(ns, phase, done, total),
        recovery: this.ctx.recovery,
        ...(this.ctx.options.synchronizeClock
          ? { synchronize: this.ctx.options.synchronizeClock }
          : {}),
      })
      return controller.run(namespace, selected, body, route === "/time/step-next")
    }
    if (route === "/can-checkpoint" && method === "POST") {
      checked(body, ["services", "timeoutMs"])
      if (
        body.timeoutMs !== undefined &&
        (typeof body.timeoutMs !== "number" || body.timeoutMs < 0 || body.timeoutMs > 30000)
      )
        throw new Error("timeoutMs must be between 0 and 30000")
      const selected = this.select(body)
      this.scope(namespace, selected)
      const until = Date.now() + ((body.timeoutMs as number) ?? 0)
      for (;;) {
        const services = Object.fromEntries(
          [...selected].map(([n, c]) => {
            const d = c.diagnostics(namespace)
            return [
              n,
              {
                ...d,
                checkpointReady:
                  d.activeRequests + d.blockedCommands + d.pendingWebhooks + (d.activeJobs ?? 0) ===
                  0,
                idle:
                  d.activeRequests + d.blockedCommands + d.pendingWebhooks + d.pendingJobs === 0,
              },
            ]
          }),
        )
        const ready =
          !this.ctx.controlling.has(namespace) &&
          !this.ctx.recovery.has(namespace) &&
          Object.values(services).every((d) => d.checkpointReady)
        if (ready || Date.now() >= until)
          return Response.json(
            { namespace, checkpointReady: ready, services },
            { status: ready ? 200 : 409 },
          )
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    if (route === "/operations" && method === "GET")
      return Response.json({
        operations: [...this.operations.values()].filter((o) => o.namespace === namespace),
      })
    const operationRoute = /^\/operations\/([^/]+)(\/cancel)?$/.exec(route)
    if (operationRoute) {
      const op = this.operations.get(operationRoute[1] as string)
      if (!op || op.namespace !== namespace) return fleetError(404, "operation not found")
      if (operationRoute[2] && method === "POST") {
        checked(body, [])
        if (
          op.status !== "running" ||
          !["validating", "preparing", "checkpointing"].includes(op.phase)
        )
          return fleetError(409, "operation has passed cancellable phase")
        this.aborts.get(op.id)?.abort()
        return Response.json({ id: op.id, cancellationRequested: true })
      }
      if (method === "GET") return Response.json(op)
    }
    if (route === "/events" && method === "GET") {
      const cursor = request.headers.get("last-event-id")
      const encode = new TextEncoder()
      let subscription: { namespace: string; member: boolean; push(event: string): void }
      let heartbeat: ReturnType<typeof setInterval>
      const cleanup = () => {
        if (subscription) this.subscribers.delete(subscription)
        clearInterval(heartbeat)
      }
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          subscription = {
            namespace,
            member: this.ctx.options.memberStatus === true && !admin,
            push: (event) => {
              if ((controller.desiredSize ?? 0) < -32) {
                cleanup()
                controller.close()
              } else controller.enqueue(encode.encode(event))
            },
          }
          this.subscribers.add(subscription)
          const at = this.events.findIndex((e) => e.id === cursor)
          if (cursor === null || at < 0)
            subscription.push(
              `event: resync\ndata: ${JSON.stringify({ processId: this.ctx.id, namespace, generation: this.generation(namespace), lifecycle: this.lifecycle })}\n\n`,
            )
          for (const event of this.events.slice(at < 0 ? 0 : at + 1))
            if (event.namespace === namespace) {
              const data =
                this.ctx.options.memberStatus && !admin
                  ? {
                      id: event.id,
                      namespace,
                      operation: {
                        id: event.operation.id,
                        phase: event.operation.phase,
                        status: event.operation.status,
                        completed: event.operation.completed,
                        total: event.operation.total,
                      },
                    }
                  : event
              subscription.push(
                `id: ${event.id}\nevent: lifecycle\ndata: ${JSON.stringify(data)}\n\n`,
              )
            }
          heartbeat = setInterval(() => subscription.push(": heartbeat\n\n"), 15000)
          heartbeat.unref?.()
          request.signal.addEventListener(
            "abort",
            () => {
              cleanup()
              try {
                controller.close()
              } catch {}
            },
            { once: true },
          )
        },
        cancel: cleanup,
      })
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    if (route === "/archives/export" && method === "POST") {
      checked(body, ["services", "allNamespaces"])
      if (body.allNamespaces !== undefined && typeof body.allNamespaces !== "boolean")
        throw new Error("allNamespaces must be boolean")
      const archive = await this.capture(
        body.allNamespaces === true ? [...this.namespaces.keys()] : [namespace],
        this.select(body),
      )
      return Response.json(
        this.ctx.options.archiveProtection
          ? await this.ctx.options.archiveProtection.seal(archive)
          : archive,
      )
    }
    if (route === "/archives/import" && method === "POST") {
      checked(body, ["archive", "namespace", "bindings"])
      let archive = this.ctx.options.archiveProtection
        ? await this.ctx.options.archiveProtection.open(body.archive)
        : validateArchive(body.archive)
      if (
        body.namespace !== undefined &&
        (typeof body.namespace !== "string" || !namePattern.test(body.namespace))
      )
        throw new Error("invalid selected archive namespace")
      if (body.bindings !== undefined)
        archive = (
          await planRestoreBindings(
            archive,
            body.bindings as RestoreBindings,
            this.ctx.options.resolveArchiveSecret,
          )
        ).archive
      await this.restoreArchive(archive, body.namespace as string | undefined)
      return Response.json({
        status: "restored",
        sha256: archive.sha256,
        namespaces: body.namespace ? [body.namespace] : Object.keys(archive.namespaces),
      })
    }
    if (route === "/archives/inspect" && method === "POST") {
      checked(body, ["archive"])
      return Response.json(inspectArchive(body.archive))
    }
    if (route === "/archives/diff" && method === "POST") {
      checked(body, ["left", "right", "namespace", "service", "values", "limit"])
      if (
        (body.values !== undefined && typeof body.values !== "boolean") ||
        (body.limit !== undefined &&
          (typeof body.limit !== "number" ||
            !Number.isInteger(body.limit) ||
            body.limit < 1 ||
            body.limit > 1000))
      )
        throw new Error("invalid diff options")
      return Response.json(
        diffArchives(
          body.left,
          body.right,
          body as { namespace?: string; service?: string; values?: boolean; limit?: number },
        ),
      )
    }
    if (route === "/profiles/apply" && method === "POST") {
      checked(body, ["name", "profile"])
      const profile =
        typeof body.name === "string" ? this.ctx.options.profiles?.[body.name] : body.profile
      return this.applyProfile(namespace, profile)
    }
    if (route === "/profiles/baseline" && method === "POST") {
      checked(body, ["services"])
      return this.applyProfile(
        namespace,
        Object.fromEntries(
          [...this.select(body)].map(([name, c]) => [
            name,
            c.protocol === "http" ? { faults: [], latency: 0 } : {},
          ]),
        ),
      )
    }
    if (route === "/scenarios" && method === "GET")
      return Response.json({
        scenarios: Object.entries(this.ctx.options.scenarios ?? {}).map(([name, b]) => ({
          name,
          format: b.format,
          version: b.version,
          description: b.description,
          services: Object.keys(b.services),
        })),
      })
    const scenario = /^\/scenarios\/([^/]+)\/apply$/.exec(route)
    if (scenario && method === "POST") {
      checked(body, [])
      const bundle = this.ctx.options.scenarios?.[scenario[1] as string]
      if (
        bundle?.format !== "mockingbird.scenario/v1" ||
        !Number.isSafeInteger(bundle.version) ||
        bundle.version < 1
      )
        throw new Error("unknown or incompatible scenario bundle")
      for (const [name, entry] of Object.entries(bundle.services))
        if (this.ctx.children.get(name)?.protocol !== entry.protocol)
          throw new Error(`incompatible scenario service ${name}`)
      for (const [name, entry] of Object.entries(bundle.services))
        if (entry.fixtures !== undefined) {
          const child = this.ctx.children.get(name)
          if (entry.protocol !== "http" || !child?.importCheckpoint)
            throw new Error(`scenario fixtures unsupported for ${name}`)
          await child.importCheckpoint(namespace, {
            format: "mockingbird.snapshot/v1",
            service: name,
            records: entry.fixtures,
          })
        }
      const profile = Object.fromEntries(
        Object.entries(bundle.services).map(([name, entry]) => [
          name,
          {
            ...entry.controls,
            ...(bundle.seed !== undefined && entry.protocol === "http"
              ? { seed: bundle.seed }
              : {}),
            ...(bundle.clock ? { clock: bundle.clock } : {}),
          },
        ]),
      )
      const response = await this.applyProfile(
        namespace,
        profile,
        async (name, child) => {
          const fixtures = bundle.services[name]?.fixtures
          if (fixtures !== undefined) {
            if (!child.configure) throw new Error(`fixtures unsupported for ${name}`)
            const document = { format: "mockingbird.snapshot/v1", service: name, records: fixtures }
            await child.configure(namespace, { snapshot: document })
          }
        },
        bundle.seedApplication,
      )
      return response
    }
    if (route === "/inspect" && method === "GET") {
      const url = new URL(request.url),
        service = url.searchParams.get("service")
      const child = service ? this.ctx.children.get(service) : undefined
      if (!child?.inspect) return fleetError(400, "service inspection is unsupported")
      const offset = Number(url.searchParams.get("offset") ?? 0),
        limit = Number(url.searchParams.get("limit") ?? 100)
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Error("invalid pagination")
      this.scope(namespace, new Map([[service as string, child]]))
      const collection = url.searchParams.get("collection")
      return Response.json({
        namespace,
        service,
        result: await child.inspect(namespace, {
          offset,
          limit,
          ...(collection !== null ? { collection } : {}),
        }),
      })
    }
    if (route === "/diagnostics" && method === "GET") {
      const selected = new URL(request.url).searchParams.getAll("service")
      const children = selected.length ? this.select({ services: selected }) : this.ctx.children
      this.scope(namespace, children)
      return Response.json({
        format: "mockingbird.diagnostics/v1",
        createdAt: new Date().toISOString(),
        processId: this.ctx.id,
        namespace,
        generation: this.generation(namespace),
        configurationFingerprint: digest(this.ctx.config),
        capabilities: this.capability(),
        services: Object.fromEntries(
          [...children].map(([name, c]) => [
            name,
            {
              protocol: c.protocol,
              diagnostics: c.diagnostics(namespace),
              unmatched: c.unmatched?.(namespace, 50),
            },
          ]),
        ),
        operations: [...this.operations.values()]
          .filter((o) => o.namespace === namespace)
          .slice(-50)
          .map(({ id, phase, action, status, startedAt, finishedAt }) => ({
            id,
            phase,
            action,
            status,
            startedAt,
            finishedAt,
          })),
        truncated:
          [...this.operations.values()].filter((o) => o.namespace === namespace).length > 50,
        excluded: ["credentials", "requestBodies", "records", "modelText", "operationPayloads"],
      })
    }
    if (route === "/credentials" && method === "POST") {
      checked(body, ["namespaces", "actions", "ttlMs"])
      if (!admin) return fleetError(403, "admin credential required")
      if (
        !Array.isArray(body.namespaces) ||
        !body.namespaces.length ||
        body.namespaces.some((n) => typeof n !== "string" || !namePattern.test(n)) ||
        !Array.isArray(body.actions) ||
        !body.actions.length ||
        body.actions.some(
          (a) => !["read", "reset", "restore", "snapshot", "control"].includes(String(a)),
        ) ||
        typeof body.ttlMs !== "number" ||
        body.ttlMs <= 0 ||
        body.ttlMs > 86400000
      )
        throw new Error("expected namespaces, actions and ttlMs (at most one day)")
      const credential = randomBytes(32).toString("base64url"),
        id = randomUUID(),
        expiresAt = Date.now() + body.ttlMs
      this.credentials.set(digest(credential), {
        id,
        namespaces: body.namespaces as string[],
        actions: body.actions as string[],
        expiresAt,
      })
      return Response.json({ id, credential, expiresAt }, { status: 201 })
    }
    const credential = /^\/credentials\/([^/]+)$/.exec(route)
    if (credential && method === "DELETE") {
      if (!admin) return fleetError(403, "admin credential required")
      for (const [key, c] of this.credentials)
        if (c.id === credential[1]) {
          this.credentials.delete(key)
          return Response.json({ status: "revoked", id: c.id })
        }
      return fleetError(404, "credential not found")
    }
    if (route === "/backups" && method === "GET")
      return Response.json({
        ...this.backupStatus,
        running: this.backupRunning,
        archives: (await this.ctx.options.repository?.list()) ?? [],
      })
    if (route === "/backups" && method === "POST") {
      checked(body, ["allNamespaces"])
      return Response.json(
        await this.backup(
          body.allNamespaces === true ? [...this.namespaces.keys()] : [namespace],
          [...this.operations.values()]
            .reverse()
            .find((o) => o.status === "running" && o.namespace === namespace)?.id,
        ),
      )
    }
    if (route === "/cleanup" && method === "GET")
      return Response.json({ candidates: this.cleanupPreview() })
    if (route === "/cleanup" && method === "POST") {
      checked(body, [])
      const results: Record<string, unknown> = {}
      for (const entry of this.cleanupPreview())
        if (entry.eligible) {
          try {
            if (this.ctx.options.expiry?.finalBackup) await this.backup([entry.namespace])
            const response = await this.deleteNamespace(entry.namespace)
            results[entry.namespace] = { status: response.status, result: await response.json() }
          } catch (error) {
            results[entry.namespace] = {
              status: "failed",
              message: error instanceof Error ? error.message : "cleanup failed",
            }
          }
        }
      return Response.json({ results })
    }
    return undefined
  }
  private namespaceStatus() {
    return [...this.namespaces].map(([namespace, state]) => ({
      namespace,
      ...state,
      status: this.ctx.recovery.has(namespace)
        ? "failed"
        : this.ctx.controlling.has(namespace) || this.topology.has(namespace)
          ? "maintenance"
          : "ready",
      operationId: this.ctx.controlling.get(namespace),
      expiresAt:
        state.expiresAt ??
        (this.ctx.options.expiry
          ? Math.max(
              state.activityAt,
              ...[...this.ctx.children.values()].map((c) => c.lastActivity?.(namespace) ?? 0),
            ) + this.ctx.options.expiry.idleMs
          : undefined),
    }))
  }
  private busy(namespace: string, selected = this.ctx.children) {
    return [...selected]
      .filter(([, c]) => {
        const d = c.diagnostics(namespace)
        return d.activeRequests + d.blockedCommands + d.pendingWebhooks + (d.activeJobs ?? 0) > 0
      })
      .map(([name]) => name)
  }
  async hook(
    phase: "prepare" | "verify" | "resume",
    namespace: string,
    selected: Map<string, FleetChild>,
  ) {
    const hook = this.ctx.options.workload?.[phase]
    const op = this.activeOperation(namespace)
    this.phase(
      namespace,
      phase === "prepare" ? "preparing" : phase === "verify" ? "verifying" : "resuming",
    )
    const controller = op ? this.aborts.get(op.id) : new AbortController()
    if (controller?.signal.aborted && phase !== "resume")
      throw new Error("operation cancelled before commit")
    if (!hook) return
    const timeout = AbortSignal.timeout(this.ctx.options.hookTimeoutMs ?? 30000)
    const signal =
      controller && !controller.signal.aborted
        ? AbortSignal.any([controller.signal, timeout])
        : timeout
    await Promise.race([
      hook({
        namespace,
        services: [...selected.keys()],
        signal,
        operationId: op?.id ?? randomUUID(),
      }),
      new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error(`${phase} hook aborted or timed out`)),
          { once: true },
        ),
      ),
    ])
  }
  async createNamespace(namespace: string, baseline?: string): Promise<Response> {
    if (this.environment && !this.ownsEnvironment())
      return fleetError(409, "environment operation in progress")
    if (this.namespaces.has(namespace) || this.topology.has(namespace))
      return fleetError(409, "namespace already exists or is provisioning")
    if (this.ctx.controlling.has(namespace))
      return fleetError(409, "namespace operation in progress", {
        operationId: this.ctx.controlling.get(namespace),
      })
    const limits = this.ctx.options.limits
    if (
      limits?.maxNamespaces !== undefined &&
      this.namespaces.size + this.topology.size >= limits.maxNamespaces
    )
      return fleetError(429, "maximum namespaces reached")
    const protocolCount = [...this.ctx.children.values()].filter(
      (c) => c.protocol !== "http",
    ).length
    const listenerCount = [...this.ctx.children.values()].reduce(
      (n, c) =>
        n +
        (c.protocol === "external"
          ? 0
          : c.protocol === "http"
            ? 1
            : Object.keys((c.namespaces.endpoints ?? {}) as object).length),
      1,
    )
    if (
      limits?.maxListeners !== undefined &&
      listenerCount + (this.topology.size + 1) * protocolCount > limits.maxListeners
    )
      return fleetError(429, "maximum listeners reached")
    for (const [name, c] of this.ctx.children)
      if (!c.createNamespace || !c.deleteNamespace)
        throw new Error(`namespace provisioning unsupported for ${name}`)
    const point = baseline ? this.ctx.checkpoints.get(baseline) : undefined
    if (baseline && !point) throw new Error("baseline checkpoint not found")
    this.topology.add(namespace)
    const created: FleetChild[] = []
    try {
      this.phase(namespace, "provisioning")
      // Decode a baseline through each child's portable format so namespace identities are rebased.
      const docs = new Map<string, unknown>()
      if (point)
        for (const [name, value] of point.values) {
          const child = this.ctx.children.get(name)
          if (!child?.exportCheckpoint || !child.importCheckpoint)
            throw new Error(`portable baseline unsupported for ${name}`)
          docs.set(name, await child.exportCheckpoint(point.namespace, value))
        }
      for (const [name, child] of this.ctx.children) {
        await child.createNamespace?.(namespace)
        created.push(child)
        if (docs.has(name))
          await child.restore(namespace, await child.importCheckpoint?.(namespace, docs.get(name)))
      }
      if (point) restoreClock(this.ctx.clock(namespace), point.clock)
      this.remember(namespace)
      await this.ctx.publish()
      return Response.json(
        {
          namespace,
          generation: this.generation(namespace),
          manifest: this.ctx.manifest(),
          connections: Object.fromEntries(
            [...this.ctx.children].map(([n, c]) => [
              n,
              c.connections?.[namespace] ??
                `${c.url}${this.ctx.config.adminPrefix ?? "/__admin"}/ns/${encodeURIComponent(namespace)}`,
            ]),
          ),
        },
        { status: 201 },
      )
    } catch (error) {
      const results = await Promise.allSettled(
        created.reverse().map((c) => c.deleteNamespace?.(namespace)),
      )
      this.namespaces.delete(namespace)
      if (results.some((r) => r.status === "rejected"))
        return fleetError(500, "namespace provisioning cleanup failed", {
          namespace,
          recoveryRequired: true,
        })
      throw error
    } finally {
      this.topology.delete(namespace)
    }
  }
  private async deleteNamespace(namespace: string): Promise<Response> {
    if (this.environment && !this.ownsEnvironment())
      return fleetError(409, "environment operation in progress")
    if (namespace === "default") return fleetError(409, "default namespace cannot be deleted")
    if (!this.namespaces.has(namespace)) return fleetError(404, "namespace not found")
    if (this.remember(namespace).pinned) return fleetError(409, "namespace is pinned")
    if (
      this.topology.has(namespace) ||
      this.ctx.controlling.has(namespace) ||
      this.ctx.recovery.has(namespace)
    )
      return fleetError(409, "namespace is busy or requires recovery")
    this.scope(namespace, this.ctx.children)
    const busy = this.busy(namespace)
    // Connections are rejected on deletion, even for otherwise checkpointable idle Redis clients.
    for (const [name, c] of this.ctx.children)
      if (c.diagnostics(namespace).activeConnections) busy.push(name)
    if (busy.length)
      return fleetError(409, "namespace has active work or clients", {
        services: [...new Set(busy)],
      })
    const selected = this.ctx.children
    for (const [name, child] of selected)
      if (
        !child.deleteNamespace ||
        !child.createNamespace ||
        !child.exportCheckpoint ||
        !child.importCheckpoint
      )
        throw new Error(`transactional namespace deletion unsupported for ${name}`)
    this.topology.add(namespace)
    const release: (() => void)[] = []
    const documents = new Map<string, unknown>()
    const deleted = new Set<string>()
    const original = { ...this.remember(namespace) }
    try {
      for (const child of selected.values()) release.push(child.lock(namespace))
      if (this.busy(namespace).length)
        return fleetError(409, "namespace acquired active work before deletion")
      for (const [name, child] of selected)
        documents.set(
          name,
          await child.exportCheckpoint?.(namespace, await child.checkpoint(namespace)),
        )
      for (const [name, child] of selected) {
        await child.deleteNamespace?.(namespace)
        deleted.add(name)
      }
      this.namespaces.delete(namespace)
      await this.ctx.publish()
      for (const [id, p] of this.ctx.checkpoints)
        if (p.namespace === namespace) this.ctx.checkpoints.delete(id)
      return Response.json({ status: "deleted", namespace })
    } catch (error) {
      const rollback: Record<string, string> = {}
      for (const [name, child] of selected)
        if (documents.has(name)) {
          try {
            if (
              deleted.has(name) ||
              (child.protocol !== "http" &&
                !Object.hasOwn((child.namespaces.endpoints ?? {}) as object, namespace))
            )
              await child.createNamespace?.(namespace)
            await child.restore(
              namespace,
              await child.importCheckpoint?.(namespace, documents.get(name)),
            )
            rollback[name] = "restored"
          } catch {
            rollback[name] = "failed"
          }
        }
      this.namespaces.set(namespace, original)
      if (Object.values(rollback).includes("failed")) {
        const fences: (() => void)[] = []
        for (const child of selected.values())
          try {
            fences.push(child.lock(namespace))
          } catch {}
        this.ctx.recovery.set(namespace, fences)
      }
      await this.ctx.publish().catch(() => {})
      return fleetError(500, error instanceof Error ? error.message : "namespace deletion failed", {
        namespace,
        rollback,
        rolledBack: Object.values(rollback).every((v) => v === "restored"),
      })
    } finally {
      for (const unlock of release.reverse()) unlock()
      this.topology.delete(namespace)
    }
  }

  async capture(namespaces: string[], selected = this.ctx.children): Promise<FleetArchive> {
    if (namespaces.length > 1 && !this.ownsEnvironment())
      return this.withEnvironment(namespaces, selected, () => this.capture(namespaces, selected))
    const contents: FleetArchive["namespaces"] = {}
    for (const [name, child] of selected)
      if (!child.exportCheckpoint || !child.importCheckpoint)
        throw new Error(`portable snapshots unsupported for ${name}`)
    for (const namespace of namespaces) {
      this.scope(namespace, selected)
      const services: FleetArchive["namespaces"][string]["services"] = {}
      const response = await this.ctx.transaction(namespace, selected, async (name, child) => {
        const point = await child.checkpoint(namespace)
        services[name] = {
          protocol: child.protocol,
          target: child.targetName ?? name,
          version: 1,
          ...(child.packageVersion ? { packageVersion: child.packageVersion } : {}),
          state: await child.exportCheckpoint?.(namespace, point),
        }
      })
      if (!response.ok)
        throw new Error(`capture ${namespace} refused: ${canonical(await response.json())}`)
      contents[namespace] = { clock: this.ctx.clock(namespace).state(), services }
    }
    return sealArchive({
      format: "mockingbird.fleet/v1",
      createdAt: new Date().toISOString(),
      sourceId: this.ctx.id,
      namespaces: contents,
    })
  }
  async restoreArchive(input: FleetArchive, selectedNamespace?: string): Promise<void> {
    const archive = validateArchive(input)
    const entries = Object.entries(archive.namespaces).filter(
      ([ns]) => selectedNamespace === undefined || ns === selectedNamespace,
    )
    if (!entries.length) throw new Error("selected namespace absent from archive")
    if (entries.length > 1 && !this.ownsEnvironment()) {
      const selected = new Map(
        [...new Set(entries.flatMap(([, ns]) => Object.keys(ns.services)))].map((name) => [
          name,
          this.ctx.children.get(name) as FleetChild,
        ]),
      )
      for (const [name, child] of selected)
        if (!child) throw new Error(`unsupported archive service ${name}`)
      return this.withEnvironment(
        entries.map(([ns]) => ns),
        selected,
        () => this.restoreArchive(archive, selectedNamespace),
      )
    }
    // Decode every child before creating a namespace or changing any live state.
    for (const [namespace, ns] of entries)
      for (const [name, state] of Object.entries(ns.services)) {
        const child = this.ctx.children.get(name)
        if (
          !child ||
          child.protocol !== state.protocol ||
          !child.importCheckpoint ||
          (state.target ?? name) !== (child.targetName ?? name)
        )
          throw new Error(`unsupported archive service ${name}`)
        await child.importCheckpoint(namespace, state.state)
      }
    const rollback: {
      namespace: string
      selected: Map<string, FleetChild>
      values: Map<string, unknown>
      clock: ReturnType<Clock["state"]>
    }[] = []
    const created: string[] = []
    try {
      for (const [namespace, ns] of entries) {
        if (!this.namespaces.has(namespace)) {
          const response = await this.createNamespace(namespace)
          if (!response.ok)
            throw new Error(`namespace creation refused: ${canonical(await response.json())}`)
          created.push(namespace)
        }
        const selected = new Map(
          Object.keys(ns.services).map((name) => [name, this.ctx.children.get(name) as FleetChild]),
        )
        const values = new Map<string, unknown>()
        const oldClock = this.ctx.clock(namespace).state()
        const response = await this.ctx.transaction(
          namespace,
          selected,
          async (name, child) => {
            values.set(name, await child.checkpoint(namespace))
            await child.restore(
              namespace,
              await child.importCheckpoint?.(namespace, ns.services[name]?.state),
            )
          },
          true,
        )
        if (!response.ok)
          throw new Error(`restore ${namespace} failed: ${canonical(await response.json())}`)
        rollback.push({ namespace, selected, values, clock: oldClock })
        restoreClock(this.ctx.clock(namespace), ns.clock)
        this.remember(namespace).generation = randomUUID()
      }
    } catch (error) {
      const failures: string[] = []
      for (const point of rollback.reverse()) {
        const response = await this.ctx.transaction(
          point.namespace,
          point.selected,
          async (name, child) => child.restore(point.namespace, point.values.get(name)),
          true,
        )
        if (!response.ok) failures.push(point.namespace)
        else restoreClock(this.ctx.clock(point.namespace), point.clock)
      }
      for (const namespace of created.reverse()) {
        const response = await this.deleteNamespace(namespace)
        if (!response.ok) failures.push(namespace)
      }
      if (failures.length)
        throw new Error(`archive rollback requires recovery for ${failures.join(", ")}`, {
          cause: error,
        })
      throw error
    }
  }
  private async applyProfile(
    namespace: string,
    input: unknown,
    extra?: (name: string, child: FleetChild) => Promise<void>,
    seedApplication?: ScenarioBundle["seedApplication"],
  ) {
    if (!object(input) || !Object.keys(input).length)
      throw new Error("expected nonempty service control profile")
    const selected = this.select({ services: Object.keys(input) })
    for (const [name, child] of selected) {
      const controls = input[name]
      if (!object(controls)) throw new Error(`expected controls for ${name}`)
      normalizeControls(controls, `profile.${name}`)
      if (child.protocol !== "http" && Object.keys(controls).some((key) => key !== "clock"))
        throw new Error(`unsupported protocol controls for ${name}`)
    }
    return this.ctx.transaction(namespace, selected, async (name, child) => {
      const controls = input[name] as Record<string, unknown>
      if (child.configure) await child.configure(namespace, controls)
      else {
        const plan = normalizeControls(controls)
        if (plan.clock?.frozen === true) child.clock(namespace).freeze()
        if (plan.clock?.now !== undefined) child.clock(namespace).set(plan.clock.now)
        if (plan.clock?.frozen === false) child.clock(namespace).unfreeze()
      }
      await extra?.(name, child)
      if (name === [...selected.keys()].at(-1) && seedApplication) {
        const operation = [...this.operations.values()].find(
          (o) => o.namespace === namespace && o.status === "running",
        )
        const token = randomBytes(32).toString("base64url")
        this.privateRequests.set(namespace, token)
        const access: { connections: Record<string, string>; close(): Promise<void> }[] = []
        const connections: Record<string, { url: string; namespaces: Record<string, string> }> = {}
        try {
          for (const [service, target] of selected) {
            if (target.initializationAccess) {
              const seedAccess = await target.initializationAccess()
              access.push(seedAccess)
              const url = seedAccess.connections[namespace]
              if (url) connections[service] = { url, namespaces: { [namespace]: url } }
            } else connections[service] = { url: target.url, namespaces: {} }
          }
          const signal = AbortSignal.timeout(this.ctx.options.hookTimeoutMs ?? 30000)
          await Promise.race([
            seedApplication({
              namespace,
              services: [...selected.keys()],
              operationId: operation?.id ?? randomUUID(),
              signal,
              manifest: this.ctx.manifest(),
              connections,
              headers: { "x-mockingbird-initializer": token, "x-mockingbird-namespace": namespace },
            }),
            new Promise<never>((_, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new Error("application seed hook timed out")),
                { once: true },
              ),
            ),
          ])
        } catch (error) {
          throw Object.assign(
            new Error("application seed hook failed; recovery required", { cause: error }),
            { code: "MOCKINGBIRD_WORKLOAD_UNCERTAIN" },
          )
        } finally {
          this.privateRequests.delete(namespace)
          await Promise.all(access.map((a) => a.close()))
        }
      }
    })
  }
  async backup(namespaces: string[], operationId?: string) {
    if (!this.ctx.options.repository) throw new Error("archive repository is not configured")
    if (this.backupRunning) throw new Error("backup is already running; overlapping run skipped")
    this.backupRunning = true
    this.backupStatus.lastAttempt = new Date().toISOString()
    try {
      const archive = await this.capture(namespaces)
      for (const namespace of namespaces) this.phase(namespace, "uploading")
      if (operationId) await this.journalPhase(operationId, "uploading", { after: archive.sha256 })
      const id = await this.ctx.options.repository.put(archive)
      for (const namespace of namespaces) this.phase(namespace, "verifying-upload")
      const verified = validateArchive(await this.ctx.options.repository.get(id))
      if (verified.sha256 !== archive.sha256) throw new Error("backup verification failed")
      if (operationId)
        await this.journalPhase(
          operationId,
          "publishing",
          this.ctx.options.repository.writerGeneration !== undefined
            ? { writerGeneration: this.ctx.options.repository.writerGeneration }
            : {},
        )
      for (const namespace of namespaces) this.phase(namespace, "publishing")
      await this.ctx.options.repository.publishLatest(id)
      const publication = await this.ctx.options.repository.publicationMetadata?.()
      if (operationId && publication)
        await this.journalPhase(operationId, "publishing", {
          writerGeneration: publication.generation,
        })
      this.backupStatus.lastSuccess = new Date().toISOString()
      this.backupStatus.archiveId = id
      delete this.backupStatus.lastFailure
      const keep = this.ctx.options.backupPolicy?.keep
      if (keep !== undefined) {
        const archives = await this.ctx.options.repository.list()
        for (const old of archives.slice(0, Math.max(0, archives.length - keep)))
          if (old !== id) await this.ctx.options.repository.delete(old)
      }
      return { id, sha256: archive.sha256, verified: true }
    } catch (error) {
      this.backupStatus.lastFailure = error instanceof Error ? error.message : "backup failed"
      throw error
    } finally {
      this.backupRunning = false
    }
  }
  private cleanupPreview() {
    return this.namespaceStatus()
      .filter((entry) => entry.namespace !== "default")
      .map((entry) => {
        let busy = true
        try {
          busy =
            this.busy(entry.namespace).length > 0 ||
            [...this.ctx.children.values()].some(
              (c) => c.diagnostics(entry.namespace).activeConnections > 0,
            )
        } catch {}
        return {
          namespace: entry.namespace,
          expiresAt: entry.expiresAt,
          pinned: entry.pinned,
          eligible:
            entry.expiresAt !== undefined &&
            !entry.pinned &&
            !busy &&
            entry.status === "ready" &&
            !this.topology.has(entry.namespace) &&
            Date.now() >= (entry.expiresAt ?? Infinity),
        }
      })
  }
  async startPolicies() {
    if (this.ctx.options.repository && this.ctx.options.backupPolicy) {
      try {
        const id = await this.ctx.options.repository.latest()
        if (id) {
          await this.ctx.options.repository.get(id)
          this.backupStatus.archiveId = id
          this.backupStatus.lastSuccess = new Date().toISOString()
        }
      } catch (error) {
        this.backupStatus.lastFailure =
          error instanceof Error ? error.message : "repository recovery failed"
      }
    }
    this.lifecycle = "ready"
    const policy = this.ctx.options.backupPolicy
    if (policy) {
      if (!Number.isFinite(policy.intervalMs) || policy.intervalMs < 10)
        throw new Error("backup intervalMs must be at least 10")
      const schedule = () => {
        this.backupStatus.nextRun = new Date(Date.now() + policy.intervalMs).toISOString()
        if (!this.backupRunning)
          void this.backup(policy.namespaces ?? [...this.namespaces.keys()]).catch(() => {})
      }
      this.backupStatus.nextRun = new Date(Date.now() + policy.intervalMs).toISOString()
      this.timer = setInterval(schedule, policy.intervalMs)
      this.timer.unref?.()
    }
    const expiry = this.ctx.options.expiry
    if (expiry) {
      if (!Number.isFinite(expiry.idleMs) || expiry.idleMs < 1)
        throw new Error("expiry idleMs must be positive")
      this.expiryTimer = setInterval(() => {
        for (const entry of this.cleanupPreview())
          if (entry.eligible)
            void (async () => {
              if (expiry.finalBackup) await this.backup([entry.namespace])
              await this.deleteNamespace(entry.namespace)
            })().catch(() => {})
      }, expiry.intervalMs ?? 60000)
      this.expiryTimer.unref?.()
    }
  }
  stopPolicies() {
    clearInterval(this.timer)
    clearInterval(this.expiryTimer)
  }
}

const fleetConsole = (prefix: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mockingbird Fleet</title><style>body{font:16px system-ui;max-width:1000px;margin:3rem auto;padding:1rem;background:#10151b;color:#e0e9f2}input,select,button{padding:.7rem;margin:.3rem;background:#233142;color:inherit;border:1px solid #60768b;border-radius:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#9fdbff}</style><h1>Mockingbird Fleet</h1><label>Admin key <input id="key" type="password" autocomplete="off"></label><label>Namespace <input id="ns" value="default"></label><button id="refresh">Refresh</button><section id="children"></section><label>Action <select id="action"><option value="snapshots">Capture checkpoint</option><option value="reset">Reset namespace</option></select></label><button id="run">Run</button><h2>Lifecycle and operations</h2><pre id="result"></pre><script type="module">const base=${JSON.stringify(`${prefix}/fleet`)};const key=document.querySelector('#key'),ns=document.querySelector('#ns'),result=document.querySelector('#result');async function api(path,method='GET',body){const r=await fetch(base+path,{method,headers:{'content-type':'application/json','x-mockingbird-admin-key':key.value},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();result.textContent=JSON.stringify(data,null,2);return data}document.querySelector('#refresh').onclick=async()=>{const data=await api('');const host=document.querySelector('#children');host.replaceChildren();for(const [name,child]of Object.entries(data.manifest?.services??{})){const link=document.createElement('a');link.href=child.adminUrl;link.textContent=name+' ('+child.protocol+') ';host.append(link)}await api('/operations?namespace='+encodeURIComponent(ns.value))};document.querySelector('#run').onclick=()=>api('/namespaces/'+encodeURIComponent(ns.value)+'/'+document.querySelector('#action').value,'POST',{});</script></html>`
