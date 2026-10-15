import { randomUUID } from "node:crypto"
import type { FleetClient } from "./fleet-client.js"

export type RunDescriptor = {
  namespace: string
  generation: string
  baseline?: string
  endpoints: Record<string, string>
  expiresAt?: number
}
export type RunContext = RunDescriptor & { registerCleanup(close: () => Promise<void>): void }
export class FleetRunError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly run: RunDescriptor | undefined,
    readonly evidence: unknown,
  ) {
    super(errors, "fleet run or teardown failed")
  }
}
export type RunOptions = {
  baseline?: string
  scenario?: string
  preserveOnFailureMs?: number
  verify?(context: RunContext): Promise<void>
}
/** Owns one isolated run; the supplied client keeps admin credentials outside the descriptor. */
export async function withFleetRun<T>(
  client: FleetClient,
  options: RunOptions,
  run: (context: RunContext) => Promise<T>,
): Promise<T> {
  if (
    options.preserveOnFailureMs !== undefined &&
    (!Number.isSafeInteger(options.preserveOnFailureMs) ||
      options.preserveOnFailureMs < 1 ||
      options.preserveOnFailureMs > 86400000)
  )
    throw new Error("debug preservation must expire within one day")
  const namespace = `run-${randomUUID()}`,
    cleanup: (() => Promise<void>)[] = [],
    failures: unknown[] = []
  let descriptor: RunDescriptor | undefined,
    evidence: unknown,
    value: T | undefined,
    created = false
  try {
    const result = await client.createNamespace(namespace, options.baseline)
    created = true
    descriptor = {
      namespace,
      generation: String(result.generation),
      endpoints: result.connections as Record<string, string>,
      ...(options.baseline ? { baseline: options.baseline } : {}),
    }
    const context = {
      ...descriptor,
      registerCleanup: (close: () => Promise<void>) => cleanup.push(close),
    }
    if (options.scenario)
      await client.request(`scenarios/${encodeURIComponent(options.scenario)}/apply`, {
        namespace,
        body: {},
      })
    await options.verify?.(context)
    value = await run(context)
  } catch (error) {
    failures.push(error)
  } finally {
    for (const close of cleanup.reverse())
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    if (created) {
      if (failures.length)
        try {
          evidence = await client.request("diagnostics", { namespace })
        } catch (error) {
          failures.push(error)
        }
      if (failures.length && options.preserveOnFailureMs) {
        try {
          const expiresAt = Date.now() + options.preserveOnFailureMs
          await client.request(`namespaces/${namespace}/policy`, {
            body: { expiresInMs: options.preserveOnFailureMs },
          })
          if (descriptor) descriptor.expiresAt = expiresAt
        } catch (error) {
          failures.push(error)
        }
      } else
        try {
          await client.deleteNamespace(namespace)
        } catch (error) {
          failures.push(error)
        }
    }
  }
  if (failures.length) throw new FleetRunError(failures, descriptor, evidence)
  return value as T
}

export type NamespaceLease = RunDescriptor & {
  leaseId: string
  expiresAt: number
  registerCleanup(close: () => Promise<void>): void
}
type WarmEntry = {
  namespace: string
  version: string
  checkpoint: string
  descriptor: RunDescriptor
  state: "provisioning" | "warm" | "leased" | "quarantined"
  leaseId?: string
  expiresAt?: number
  cleanup: (() => Promise<void>)[]
  timer?: ReturnType<typeof setTimeout>
}
export class NamespacePool {
  private readonly entries = new Map<string, WarmEntry>()
  private readonly waiters = new Set<() => void>()
  private closed = false
  private baseline: { version: string; checkpoint?: string }
  constructor(
    private readonly client: FleetClient,
    private readonly options: {
      maxSize: number
      baselineVersion: string
      baseline?: string
      leaseMs?: number
      verify?(descriptor: RunDescriptor): Promise<void>
    },
  ) {
    if (!Number.isSafeInteger(options.maxSize) || options.maxSize < 1 || !options.baselineVersion)
      throw new Error("pool size and baseline version required")
    this.baseline = {
      version: options.baselineVersion,
      ...(options.baseline ? { checkpoint: options.baseline } : {}),
    }
  }
  private notify() {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }
  private async provision(): Promise<WarmEntry> {
    const namespace = `pool-${randomUUID()}`,
      version = this.baseline.version
    const entry: WarmEntry = {
      namespace,
      version,
      checkpoint: "",
      descriptor: { namespace, generation: "", endpoints: {} },
      state: "provisioning",
      cleanup: [],
    }
    this.entries.set(namespace, entry)
    try {
      const created = await this.client.createNamespace(namespace, this.baseline.checkpoint)
      entry.descriptor = {
        namespace,
        generation: String(created.generation),
        baseline: version,
        endpoints: created.connections as Record<string, string>,
      }
      entry.checkpoint = (await this.client.snapshot(namespace, { label: `pool:${version}` })).id
      await this.options.verify?.(entry.descriptor)
      entry.state = version === this.baseline.version ? "warm" : "quarantined"
      return entry
    } catch (error) {
      entry.state = "quarantined"
      try {
        await this.client.deleteNamespace(namespace)
        this.entries.delete(namespace)
      } catch {}
      this.notify()
      throw error
    }
  }
  async acquire(
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<NamespaceLease> {
    const timeout = options.timeoutMs ?? 1000
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30000)
      throw new Error("pool wait must be bounded within 30 seconds")
    const deadline = Date.now() + timeout
    for (;;) {
      if (this.closed || options.signal?.aborted)
        throw new Error("namespace pool acquisition cancelled or closed")
      let entry = [...this.entries.values()].find(
        (e) => e.state === "warm" && e.version === this.baseline.version,
      )
      if (!entry && this.entries.size < this.options.maxSize) entry = await this.provision()
      if (entry?.state === "warm") {
        entry.state = "leased"
        entry.leaseId = randomUUID()
        entry.expiresAt = Date.now() + (this.options.leaseMs ?? 300000)
        entry.cleanup = []
        entry.timer = setTimeout(() => {
          if (entry?.state === "leased") {
            entry.state = "quarantined"
            this.notify()
          }
        }, this.options.leaseMs ?? 300000)
        entry.timer.unref?.()
        return {
          ...entry.descriptor,
          leaseId: entry.leaseId,
          expiresAt: entry.expiresAt,
          registerCleanup: (close) => entry?.cleanup.push(close),
        }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error("namespace pool capacity exhausted")
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer)
          this.waiters.delete(finish)
          options.signal?.removeEventListener("abort", cancel)
          resolve()
        }
        const cancel = () => {
          clearTimeout(timer)
          this.waiters.delete(finish)
          reject(new Error("namespace pool acquisition cancelled"))
        }
        const timer = setTimeout(finish, remaining)
        this.waiters.add(finish)
        options.signal?.addEventListener("abort", cancel, { once: true })
      })
    }
  }
  async release(lease: NamespaceLease) {
    const entry = this.entries.get(lease.namespace)
    if (!entry || entry.leaseId !== lease.leaseId || entry.state !== "leased")
      throw new Error("stale or quarantined namespace lease")
    clearTimeout(entry.timer)
    entry.state = "provisioning"
    try {
      for (const close of entry.cleanup.reverse()) await close()
      const metrics = await this.client.request<{
        services: Record<
          string,
          {
            activeRequests: number
            activeConnections: number
            blockedCommands: number
            activeJobs?: number
            pendingWebhooks: number
          }
        >
      }>("metrics", { namespace: entry.namespace })
      if (
        Object.values(metrics.services).some(
          (d) =>
            d.activeRequests +
              d.activeConnections +
              d.blockedCommands +
              (d.activeJobs ?? 0) +
              d.pendingWebhooks >
            0,
        )
      )
        throw new Error("namespace lease retains active clients or work")
      if (entry.version !== this.baseline.version) {
        await this.client.deleteNamespace(entry.namespace)
        this.entries.delete(entry.namespace)
        return
      }
      await this.client.restore(entry.namespace, entry.checkpoint)
      const namespaces = (await this.client.namespaces()) as {
        namespaces: { namespace: string; generation: string }[]
      }
      entry.descriptor.generation =
        namespaces.namespaces.find((n) => n.namespace === entry.namespace)?.generation ?? ""
      await this.options.verify?.(entry.descriptor)
      entry.cleanup = []
      entry.state = "warm"
      delete entry.leaseId
      delete entry.expiresAt
    } catch (error) {
      entry.state = "quarantined"
      throw error
    } finally {
      this.notify()
    }
  }
  async setBaseline(version: string, checkpoint?: string) {
    if (!version) throw new Error("baseline version required")
    this.baseline = { version, ...(checkpoint ? { checkpoint } : {}) }
    for (const entry of this.entries.values())
      if (entry.state === "warm") {
        entry.state = "quarantined"
        try {
          await this.client.deleteNamespace(entry.namespace)
          this.entries.delete(entry.namespace)
        } catch {}
      }
    this.notify()
  }
  status() {
    return {
      version: this.baseline.version,
      entries: [...this.entries.values()].map(({ namespace, state, version, expiresAt }) => ({
        namespace,
        state,
        version,
        expiresAt,
      })),
    }
  }
  async close() {
    this.closed = true
    this.notify()
    const failures: unknown[] = []
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer)
      try {
        for (const close of entry.cleanup.reverse()) await close()
        await this.client.deleteNamespace(entry.namespace)
        this.entries.delete(entry.namespace)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, "namespace pool teardown failed")
  }
}
