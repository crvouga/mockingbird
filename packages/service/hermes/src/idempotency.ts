import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { canonicalFingerprintInput, sha256 } from "./fingerprint.js"
import { HermesError, type HermesRuns, type RunRecord, record, terminal } from "./runs.js"

type Scope = { profile: string; identity: string }
type Owner = { scope: string; keyed: boolean; local: boolean; alive: boolean }
type Reservation = {
  fingerprint: string
  runId: string
  scope: string
  status: RunRecord
  updatedAt: number
  owner: Owner
}
/** Python str.strip whitespace differs from JavaScript trim (notably U+0085). */
export const strip = (value: string): string => {
  const whitespace = (point: number) =>
    (point >= 9 && point <= 13) ||
    (point >= 28 && point <= 32) ||
    (point >= 0x2000 && point <= 0x200a) ||
    [0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(point)
  let start = 0
  let end = value.length
  while (start < end && whitespace(value.charCodeAt(start))) start++
  while (end > start && whitespace(value.charCodeAt(end - 1))) end--
  return value.slice(start, end)
}
const defaultScope: Scope = { profile: "default", identity: "unauthenticated-test-listener" }

/** Explicit synthetic listener/profile scope; never derive identity from credentials. */
export class HermesIdempotency {
  private readonly settings: Collection<Scope>
  private readonly reservations: Collection<Reservation>
  private readonly owners: Collection<Owner>
  private readonly maintenance: Collection<{ nextSweep: number }>
  constructor(
    private readonly sqlite: SqliteClient,
    namespace: string,
    private readonly runs: HermesRuns,
    private readonly now: () => number = Date.now,
  ) {
    this.settings = new Collection(sqlite, namespace, "hermes-scope")
    this.reservations = new Collection(sqlite, namespace, "hermes-idempotency")
    this.owners = new Collection(sqlite, namespace, "hermes-owners")
    this.maintenance = new Collection(sqlite, namespace, "hermes-retention")
  }
  setScope(body: unknown): Scope {
    if (
      !record(body) ||
      Object.keys(body).some((k) => !["profile", "identity"].includes(k)) ||
      typeof body.profile !== "string" ||
      !body.profile ||
      body.profile.includes("\0") ||
      typeof body.identity !== "string" ||
      !body.identity ||
      body.identity.includes("\0")
    )
      throw new HermesError(
        400,
        "scope: expected nonempty synthetic profile and identity without NUL",
      )
    const scope = { profile: body.profile, identity: body.identity }
    this.settings.insert("current", scope)
    return scope
  }
  scope(): Promise<string> {
    const { profile, identity } = this.settings.get("current") ?? defaultScope
    return sha256(`${profile}\0${identity}`)
  }
  /** Evaluate elapsed background ticks lazily, without expiring between ticks. */
  sweepDue(): void {
    const now = this.now() / 1000
    const schedule = this.maintenance.get("schedule")
    if (!schedule) {
      this.maintenance.insert("schedule", { nextSweep: now + 60 })
      return
    }
    if (now < schedule.nextSweep) return
    const tick = schedule.nextSweep + Math.floor((now - schedule.nextSweep) / 60) * 60
    this.cacheSweep(tick)
    this.maintenance.update("schedule", { nextSweep: tick + 60 })
  }
  /** Explicitly model one upstream sweep iteration at the controlled clock. */
  sweep(): { cacheRemoved: number; simulated: true } {
    return { cacheRemoved: this.cacheSweep(this.now() / 1000), simulated: true }
  }
  private cacheSweep(at: number): number {
    let removed = 0
    for (const { id, value } of this.runs.records.list()) {
      if (
        ["completed", "failed", "cancelled"].includes(value.status) &&
        at - value.updated_at > 3600
      ) {
        this.runs.records.delete(id)
        this.owners.delete(id)
        removed++
      }
    }
    return removed
  }
  private reservation(id: string) {
    return this.reservations.list({ where: (value) => value.runId === id })[0]
  }
  private persist(previous: RunRecord, next: RunRecord, fields: unknown): void {
    const changedPayload =
      record(fields) &&
      ["output", "error", "usage", "pending_steer", "session_id"].some((key) => key in fields)
    if (previous.status === next.status && !terminal(next.status) && !changedPayload) return
    const stored = this.reservation(next.run_id)
    if (stored)
      this.reservations.update(stored.id, {
        ...stored.value,
        status: next,
        updatedAt: this.now() / 1000,
      })
  }
  private pruneDurable(): void {
    const before = this.now() / 1000 - 86400
    for (const { id, value } of this.reservations.list()) {
      if (terminal(value.status.status) && value.updatedAt < before) this.reservations.delete(id)
    }
  }
  async get(id: string): Promise<RunRecord> {
    this.sweepDue()
    return this.hydrate(id, await this.scope())
  }
  private hydrate(id: string, scope: string): RunRecord {
    const cached = this.runs.records.get(id)
    if (cached && this.owners.get(id)?.scope === scope) return cached
    const durable = this.reservation(id)
    if (!durable || durable.value.scope !== scope)
      throw new HermesError(404, `Run not found: ${id}`, "run_not_found")
    const { status, owner } = durable.value
    this.runs.records.insert(id, status)
    this.owners.insert(id, owner)
    if (!owner.alive && !terminal(status.status)) {
      const interrupted = this.runs.interruptStale(id)
      this.persist(status, interrupted, { error: interrupted.error })
      return interrupted
    }
    return status
  }
  async observe(id: string, body: unknown): Promise<RunRecord> {
    const previous = await this.get(id)
    const next = this.runs.observe(id, body)
    this.persist(previous, next, body)
    return next
  }
  async stop(id: string): Promise<RunRecord | { run_id: string; status: "stopping" }> {
    const current = await this.get(id)
    if (terminal(current.status)) return current
    if (!this.owners.get(id)?.local)
      throw new HermesError(
        409,
        `Run is not active in this gateway process: ${id}`,
        "run_not_active",
      )
    const next = this.runs.observe(id, { status: "stopping", last_event: "run.stopping" })
    this.persist(current, next, {})
    return { run_id: id, status: "stopping" }
  }
  /** Restart discards the cache; only surviving durable reservations can hydrate. */
  restart(body: unknown): { owner: string; retained: number; discarded: number; simulated: true } {
    if (
      !record(body) ||
      Object.keys(body).some((key) => key !== "owner") ||
      typeof body.owner !== "string" ||
      !["stale", "alive"].includes(body.owner)
    )
      throw new HermesError(400, "restart: owner must be explicitly stale or alive")
    const owner = body.owner
    return this.sqlite.transaction(() => {
      const durable = this.reservations.list()
      const ids = new Set(durable.map((entry) => entry.value.runId))
      let discarded = 0
      for (const { id } of this.runs.records.list()) {
        if (!ids.has(id)) discarded++
        this.runs.records.delete(id)
        this.owners.delete(id)
      }
      for (const { id, value } of durable)
        this.reservations.update(id, {
          ...value,
          owner: { ...value.owner, local: false, alive: owner === "alive" },
        })
      this.maintenance.insert("schedule", { nextSweep: this.now() / 1000 + 60 })
      return { owner, retained: durable.length, discarded, simulated: true }
    })
  }
  async submit(
    raw: string,
    key: string,
    memoryKey: string,
  ): Promise<{ run: RunRecord; replayed: boolean }> {
    this.sweepDue()
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new HermesError(400, "Invalid JSON")
    }
    if (key.length > 255 || /[^\x21-\x7e]/.test(key))
      throw new HermesError(
        400,
        "Idempotency-Key must be 1-255 visible ASCII characters",
        "invalid_idempotency_key",
      )
    this.runs.validate(body)
    const scopePromise = this.scope()
    const fingerprintPromise = key
      ? sha256(canonicalFingerprintInput(raw, memoryKey))
      : Promise.resolve("")
    const [scope, fingerprint] = await Promise.all([scopePromise, fingerprintPromise])
    const reservationId = JSON.stringify([scope, key])
    // Upstream lookup commits pruning even when the subsequent request conflicts.
    if (key) this.sqlite.transaction(() => this.pruneDurable())
    // No async work inside the shared SQLite transaction: racing facades cannot
    // both observe a missing reservation and create distinct runs.
    return this.sqlite.transaction(() => {
      const existing = key ? this.reservations.get(reservationId) : undefined
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new HermesError(
            409,
            "Idempotency-Key was already used with a different request payload",
            "idempotency_key_conflict",
          )
        return { run: this.hydrate(existing.runId, scope), replayed: true }
      }
      const run = this.runs.create(body)
      const owner = { scope, keyed: Boolean(key), local: true, alive: true }
      this.owners.insert(run.run_id, owner)
      if (key)
        this.reservations.insert(reservationId, {
          fingerprint,
          runId: run.run_id,
          scope,
          owner,
          status: run,
          updatedAt: this.now() / 1000,
        })
      return { run, replayed: false }
    })
  }
}
