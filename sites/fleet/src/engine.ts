import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { ownedTransport } from "@crvouga/mockingbird-service"
import { HttpError } from "./errors.js"
import { LOADERS } from "./generated/catalog.js"
import type { ObjectStore } from "./objects.js"
import type { Telemetry } from "./telemetry.js"

/**
 * How much of an emulator's state survives, per emulator:
 *
 * - `strict`: every request is serialized, reads the latest committed state, and answers only
 *   after its changes are committed to object storage with a compare-and-swap. Nothing
 *   acknowledged is lost, and any number of replicas stay consistent. The price is at least two
 *   object-store round trips per request and no concurrency or streaming within one emulator.
 * - `buffered`: requests run from memory at full speed; changes are written to object storage a
 *   short interval after the first one, and at shutdown. A crash loses that interval.
 * - `ephemeral`: state lives in memory only and is gone when the process restarts.
 */
export const DURABILITY = ["strict", "buffered", "ephemeral"] as const
export type Durability = (typeof DURABILITY)[number]

export type EmulatorSpec = {
  target: string
  durability: Durability
  seed?: string
  settings?: Record<string, unknown>
  /** `buffered` only: milliseconds from the first unsaved change to its write. Default 2000. */
  flushIntervalMs?: number
  /** Origins this emulator may deliver webhooks to. Empty or absent: deliveries are disabled. */
  webhookOrigins?: string[]
}

type Runtime = {
  fetch(request: Request): Promise<Response>
  namespaces(): string[]
  fleetSnapshot(namespace: string): object
  fleetRestore(snapshot: unknown, namespace: string): void
  fleetExport(snapshot: unknown): unknown
  fleetImport(namespace: string, document: unknown): object
  stop?(): void
  webhooks?: {
    setTransportPolicy(policy: unknown): void
    clear(): void
    idle(namespace?: string): Promise<void>
    /** Run every scheduled retry now, until no delivery is pending. */
    flush?(): Promise<void>
  }
}

export type EmulatorTarget = {
  name: string
  packageVersion?: string
  parseSettings?(settings: Record<string, unknown>): Record<string, unknown>
  create(values: Record<string, unknown>, common: Record<string, unknown>): unknown
}

export type StateDocument = {
  format: "mockingbird.fleet-cloud.state/v1"
  target: string
  namespaces: Record<string, unknown>
}

export type EmulatorStatus = {
  loaded: boolean
  durability: Durability
  /** Unsaved changes are waiting for the next buffered write. */
  dirty: boolean
  lastSavedAt: string | null
  storedBytes: number | null
  lastError: string | null
}

type Instance = {
  key: string
  objectKey: string
  spec: EmulatorSpec
  runtimeHash: string
  baseUrl: string
  target: EmulatorTarget
  runtime: Runtime
  /** ETag of the committed state, or `null` when nothing is stored. */
  revision: string | null
  savedHash: string | undefined
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  queue: Promise<unknown>
  active: number
  lastUsed: number
  lastSavedAt: string | null
  storedBytes: number | null
  lastError: string | null
  closed: boolean
  maxStateBytes: number
  /** Set when a buffered emulator outgrew its quota: it refuses requests until it is reset. */
  blocked: string | null
}

const FORMAT = "mockingbird.fleet-cloud.state/v1"
const DEFAULT_NAMESPACE = "default"
const RUNTIME_METHODS = [
  "fetch",
  "namespaces",
  "fleetSnapshot",
  "fleetRestore",
  "fleetExport",
  "fleetImport",
] as const
const STRICT_ATTEMPTS = 5
/** Largest request body a `strict` emulator buffers so it can re-run the request after a conflict. */
const MAX_STRICT_BODY = 16 * 1024 * 1024

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

/** Load an emulator package from the generated catalog. Only catalog names are ever imported. */
export async function loadTarget(name: string): Promise<EmulatorTarget> {
  const load = Object.hasOwn(LOADERS, name) ? LOADERS[name] : undefined
  if (!load) throw new HttpError(400, "unknown_emulator", `No emulator named "${name}"`)
  const target = (await load()).serveTarget as (EmulatorTarget & { protocol?: unknown }) | undefined
  if (!target || typeof target.create !== "function" || target.protocol !== undefined)
    throw new HttpError(400, "unsupported_emulator", `Emulator "${name}" is not an HTTP emulator`)
  return target
}

export type EngineOptions = {
  objects: ObjectStore
  telemetry: Telemetry
  load?: (name: string) => Promise<EmulatorTarget>
  maxInstances?: number
  idleMs?: number
  now?: () => number
}

export type EmulatorRef = {
  fleetId: string
  name: string
  spec: EmulatorSpec
  /** Public base URL of this emulator, e.g. https://host/f/<fleet>/<name> */
  baseUrl: string
  /** Largest stored (compressed) state allowed, in bytes. Absent or 0: no limit. */
  maxStateBytes?: number
}

/**
 * Runs emulators in process and keeps their state in object storage. Everything held here is a
 * cache: any replica can serve any emulator by loading its state object, which is what makes the
 * container stateless.
 */
export class Engine {
  private readonly instances = new Map<string, Promise<Instance>>()
  private readonly objects: ObjectStore
  private readonly telemetry: Telemetry
  private readonly load: (name: string) => Promise<EmulatorTarget>
  private readonly maxInstances: number
  private readonly idleMs: number
  private readonly now: () => number
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(options: EngineOptions) {
    this.objects = options.objects
    this.telemetry = options.telemetry
    this.load = options.load ?? loadTarget
    this.maxInstances = options.maxInstances ?? 64
    this.idleMs = options.idleMs ?? 600_000
    this.now = options.now ?? Date.now
    this.sweeper = setInterval(() => void this.sweep(), 30_000)
    this.sweeper.unref?.()
  }

  /** Check an emulator's settings against its own schema, returning them normalized. */
  async checkSettings(target: string, settings: Record<string, unknown> | undefined) {
    const loaded = await this.load(target)
    if (settings === undefined) return undefined
    if (!loaded.parseSettings)
      throw new HttpError(400, "invalid_settings", `Emulator "${target}" takes no settings`)
    try {
      return loaded.parseSettings(settings)
    } catch (error) {
      throw new HttpError(
        400,
        "invalid_settings",
        error instanceof Error ? error.message : "Invalid settings",
      )
    }
  }

  /** Send one request to an emulator, with the durability its spec asks for. */
  async handle(ref: EmulatorRef, request: Request): Promise<Response> {
    const instance = await this.acquire(ref)
    instance.lastUsed = this.now()
    if (instance.blocked) throw new HttpError(507, "state_too_large", instance.blocked)
    instance.active++
    try {
      if (instance.spec.durability === "ephemeral") return await instance.runtime.fetch(request)
      if (instance.spec.durability === "buffered") {
        const response = await instance.runtime.fetch(request)
        // Any request may change state (OAuth `GET /authorize` mints a code), so every one counts.
        this.markDirty(instance)
        return response
      }
      return await this.strict(instance, request)
    } finally {
      instance.active--
    }
  }

  private async strict(instance: Instance, request: Request): Promise<Response> {
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    if (body && body.length > MAX_STRICT_BODY)
      throw new HttpError(413, "body_too_large", "Request body exceeds the strict-mode limit")
    return this.serialize(instance, async () => {
      for (let attempt = 0; attempt < STRICT_ATTEMPTS; attempt++) {
        await this.refresh(instance)
        const response = await instance.runtime.fetch(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            ...(body ? { body } : {}),
          }),
        )
        // The whole response is read first: the handler has finished changing state, and the
        // request can be run again from the latest state if this commit loses a race.
        const payload = new Uint8Array(await response.arrayBuffer())
        const saved = await this.persist(instance).catch(async (error) => {
          // The change cannot be committed (over quota, or the store failed): it must not
          // linger in memory as if it had been, so fall back to the committed state.
          await this.rebuild(instance).catch(() => {})
          throw error
        })
        if (saved)
          return new Response(payload.length > 0 ? payload : null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        this.telemetry.count("fleet.state.conflicts", { durability: "strict" })
        await this.rebuild(instance)
      }
      throw new HttpError(503, "state_contention", "Could not commit state; retry the request")
    })
  }

  /** Write unsaved changes now and resolve once they are committed. */
  async flush(ref: EmulatorRef): Promise<void> {
    const instance = await this.acquire(ref)
    if (instance.spec.durability === "ephemeral") return
    await this.flushInstance(instance)
    if (instance.dirty)
      throw new HttpError(503, "flush_failed", instance.lastError ?? "Flush failed")
  }

  /** The emulator's current state as a portable document. */
  async exportState(ref: EmulatorRef): Promise<StateDocument> {
    const instance = await this.acquire(ref)
    return this.serialize(instance, async () => {
      if (instance.spec.durability === "strict") await this.refresh(instance)
      return this.capture(instance)
    })
  }

  /** Return an emulator to its boot state and delete what is stored for it. */
  async reset(fleetId: string, name: string): Promise<void> {
    await this.discard(`${fleetId}/${name}`)
    await this.objects.deletePrefix(`fleets/${fleetId}/${name}/`)
  }

  /** Forget every emulator of a fleet and delete everything stored for it. */
  async deleteFleet(fleetId: string): Promise<void> {
    for (const key of [...this.instances.keys()])
      if (key.startsWith(`${fleetId}/`)) await this.discard(key)
    await this.objects.deletePrefix(`fleets/${fleetId}/`)
  }

  status(fleetId: string, name: string, spec: EmulatorSpec): EmulatorStatus {
    const instance = this.loaded.get(`${fleetId}/${name}`)
    return {
      loaded: instance !== undefined,
      durability: spec.durability,
      dirty: instance?.dirty ?? false,
      lastSavedAt: instance?.lastSavedAt ?? null,
      storedBytes: instance?.storedBytes ?? null,
      lastError: instance?.lastError ?? null,
    }
  }

  /** Persist everything unsaved and stop. Called on SIGTERM before the process exits. */
  async close(): Promise<void> {
    clearInterval(this.sweeper)
    await Promise.all(
      [...this.instances.keys()].map((key) =>
        this.unload(key).catch((error) =>
          this.telemetry.log("error", "state not saved at shutdown", {
            emulator: key,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    )
  }

  get size(): number {
    return this.instances.size
  }

  /** Resolved instances, for synchronous reads such as {@link status}. */
  private readonly loaded = new Map<string, Instance>()

  private async acquire(ref: EmulatorRef): Promise<Instance> {
    const key = `${ref.fleetId}/${ref.name}`
    const runtimeHash = hash(
      JSON.stringify([
        ref.spec.target,
        ref.spec.seed ?? null,
        ref.spec.settings ?? null,
        ref.spec.webhookOrigins ?? [],
        ref.baseUrl,
      ]),
    )
    const pending = this.instances.get(key)
    if (pending) {
      const instance = await pending
      if (!instance.closed && instance.runtimeHash === runtimeHash) {
        instance.maxStateBytes = ref.maxStateBytes ?? 0
        await this.retune(instance, ref.spec)
        return instance
      }
      // The emulator was reconfigured: save under the old configuration, then start over.
      if (this.instances.get(key) === pending) await this.unload(key)
      return this.acquire(ref)
    }
    const created = this.telemetry.span(
      "fleet.emulator.load",
      { "emulator.target": ref.spec.target, "emulator.durability": ref.spec.durability },
      async () => {
        const target = await this.load(ref.spec.target)
        const instance: Instance = {
          key,
          objectKey: `fleets/${ref.fleetId}/${ref.name}/state.json.gz`,
          spec: ref.spec,
          runtimeHash,
          baseUrl: ref.baseUrl,
          target,
          runtime: await this.boot(target, ref.spec, ref.baseUrl),
          revision: null,
          savedHash: undefined,
          dirty: false,
          timer: undefined,
          queue: Promise.resolve(),
          active: 0,
          lastUsed: this.now(),
          lastSavedAt: null,
          storedBytes: null,
          lastError: null,
          closed: false,
          maxStateBytes: ref.maxStateBytes ?? 0,
          blocked: null,
        }
        if (ref.spec.durability !== "ephemeral") await this.refresh(instance)
        return instance
      },
    )
    this.instances.set(key, created)
    try {
      const instance = await created
      this.loaded.set(key, instance)
      this.telemetry.count("fleet.emulator.loads", { target: ref.spec.target })
      void this.sweep()
      return instance
    } catch (error) {
      if (this.instances.get(key) === created) this.instances.delete(key)
      throw error
    }
  }

  /** Apply a durability change without restarting the emulator. */
  private async retune(instance: Instance, spec: EmulatorSpec): Promise<void> {
    const previous = instance.spec
    instance.spec = spec
    if (previous.durability === spec.durability) return
    if (spec.durability === "ephemeral") {
      // No longer persisted: drop the stored copy so a later switch back cannot resurrect it.
      if (instance.timer) clearTimeout(instance.timer)
      instance.timer = undefined
      instance.dirty = false
      await this.serialize(instance, async () => {
        await this.objects.deletePrefix(instance.objectKey.replace(/state\.json\.gz$/, ""))
        instance.revision = null
        instance.savedHash = undefined
        instance.lastSavedAt = null
        instance.storedBytes = null
      })
    } else this.markDirty(instance)
  }

  private async boot(
    target: EmulatorTarget,
    spec: EmulatorSpec,
    baseUrl: string,
  ): Promise<Runtime> {
    const created = (await target.create(
      {},
      {
        adminKey: undefined,
        seed: spec.seed,
        onLog: undefined,
        baseUrl,
        ...(spec.settings !== undefined ? { settings: spec.settings } : {}),
      },
    )) as Record<string, unknown> | null
    if (!created || RUNTIME_METHODS.some((method) => typeof created[method] !== "function"))
      throw new HttpError(
        500,
        "unsupported_emulator",
        `Emulator "${spec.target}" does not implement the fleet runtime protocol`,
      )
    const runtime = created as unknown as Runtime
    // A hosted emulator must not be a way to make requests from inside the platform's network.
    runtime.webhooks?.setTransportPolicy(
      ownedTransport(
        spec.webhookOrigins?.length
          ? { mode: "allowlist", origins: spec.webhookOrigins, maxRedirects: 0 }
          : { mode: "offline" },
      ),
    )
    return runtime
  }

  private shutdown(runtime: Runtime): void {
    try {
      runtime.stop?.()
      runtime.webhooks?.clear()
    } catch {
      // Closing is best effort; the runtime is being dropped either way.
    }
  }

  private capture(instance: Instance): StateDocument {
    const { runtime } = instance
    const namespaces: Record<string, unknown> = {}
    for (const namespace of [...new Set([DEFAULT_NAMESPACE, ...runtime.namespaces()])].sort())
      namespaces[namespace] = runtime.fleetExport(runtime.fleetSnapshot(namespace))
    return { format: FORMAT, target: instance.spec.target, namespaces }
  }

  /** Bring the instance up to the committed state if another replica has written since. */
  private async refresh(instance: Instance): Promise<void> {
    await this.adopt(instance, instance.revision ?? undefined, false)
  }

  /** Discard local state and reload the committed one, after losing a write race. */
  private async rebuild(instance: Instance): Promise<void> {
    await this.adopt(instance, undefined, true)
  }

  private async adopt(instance: Instance, known: string | undefined, discardLocal: boolean) {
    const read = await this.telemetry.span(
      "fleet.state.read",
      { "emulator.target": instance.spec.target },
      () => this.objects.get(instance.objectKey, known),
      { kind: "client" },
    )
    if (read.status === "unchanged") return
    if (read.status === "missing") {
      // Stored state was deleted elsewhere (a reset on another replica): start clean here too.
      if (instance.revision !== null || discardLocal) await this.replaceRuntime(instance, undefined)
      instance.revision = null
      instance.savedHash = undefined
      instance.storedBytes = null
      return
    }
    const text = gunzipSync(read.bytes).toString("utf8")
    const document = JSON.parse(text) as StateDocument
    if (document.format !== FORMAT || document.target !== instance.spec.target)
      throw new HttpError(
        500,
        "incompatible_state",
        `Stored state is not a ${instance.spec.target} state document; reset the emulator`,
      )
    await this.replaceRuntime(instance, document)
    instance.revision = read.revision
    instance.savedHash = hash(text)
    instance.storedBytes = read.bytes.length
  }

  private async replaceRuntime(instance: Instance, document: StateDocument | undefined) {
    const runtime = await this.boot(instance.target, instance.spec, instance.baseUrl)
    for (const [namespace, state] of Object.entries(document?.namespaces ?? {}))
      runtime.fleetRestore(runtime.fleetImport(namespace, state), namespace)
    this.shutdown(instance.runtime)
    instance.runtime = runtime
  }

  /**
   * Commit the current state with a compare-and-swap. Resolves false, writing nothing, when the
   * stored state changed underneath this instance.
   */
  private async persist(instance: Instance): Promise<boolean> {
    return this.telemetry.span(
      "fleet.state.write",
      { "emulator.target": instance.spec.target, "emulator.durability": instance.spec.durability },
      async (span) => {
        // Webhook deliveries are part of the state, and a snapshot cannot be taken while one is
        // in flight or waiting for a retry. A failed delivery (always, when delivery is off)
        // would otherwise wait hours for its retries and block every save until then, so the
        // retries run now; then in-flight deliveries get a moment to settle.
        const hub = instance.runtime.webhooks
        await Promise.race([
          (hub?.flush ? hub.flush() : (hub?.idle() ?? Promise.resolve())).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ])
        const text = JSON.stringify(this.capture(instance))
        const digest = hash(text)
        if (instance.revision !== null && digest === instance.savedHash) return true
        const bytes = gzipSync(text)
        span.set({ "state.bytes": bytes.length })
        if (instance.maxStateBytes > 0 && bytes.length > instance.maxStateBytes)
          throw new HttpError(
            507,
            "state_too_large",
            `This emulator's state is ${bytes.length} bytes compressed, over the ${instance.maxStateBytes}-byte quota. Reset the emulator or delete data from it; the operator can raise stateBytes.`,
            { limit: "stateBytes", max: instance.maxStateBytes, current: bytes.length },
          )
        const revision = await this.objects.put(instance.objectKey, bytes, instance.revision)
        if (revision === undefined) return false
        instance.revision = revision
        instance.savedHash = digest
        instance.storedBytes = bytes.length
        instance.lastSavedAt = new Date(this.now()).toISOString()
        this.telemetry.count("fleet.state.writes", { durability: instance.spec.durability })
        return true
      },
      { kind: "client" },
    )
  }

  private markDirty(instance: Instance): void {
    instance.dirty = true
    if (instance.timer || instance.closed) return
    instance.timer = setTimeout(
      () => void this.flushInstance(instance),
      instance.spec.flushIntervalMs ?? 2000,
    )
  }

  /** Never rejects: a failed write leaves the instance dirty and is retried on the next interval. */
  private async flushInstance(instance: Instance): Promise<void> {
    if (instance.timer) clearTimeout(instance.timer)
    instance.timer = undefined
    await this.serialize(instance, async () => {
      if (!instance.dirty || instance.spec.durability === "ephemeral") return
      instance.dirty = false
      try {
        if (!(await this.persist(instance))) {
          // Another writer owns newer state. `buffered` promises no merge: theirs wins.
          this.telemetry.count("fleet.state.conflicts", { durability: "buffered" })
          this.telemetry.log("warn", "buffered state overwritten by another writer", {
            emulator: instance.key,
          })
          await this.rebuild(instance)
        }
        instance.lastError = null
      } catch (error) {
        instance.dirty = true
        instance.lastError = error instanceof Error ? error.message : String(error)
        if (error instanceof HttpError && error.code === "state_too_large") {
          // Retrying cannot help and the state would keep growing in memory: stop serving it.
          instance.blocked = error.message
          return
        }
        this.telemetry.log("error", "state write failed", {
          emulator: instance.key,
          error: instance.lastError,
        })
        if (!instance.closed) this.markDirty(instance)
      }
    })
  }

  private serialize<T>(instance: Instance, work: () => Promise<T>): Promise<T> {
    const next = instance.queue.then(work)
    instance.queue = next.catch(() => {})
    return next
  }

  /** Save and drop one instance. Rejects, keeping it loaded, if its state could not be saved. */
  private async unload(key: string): Promise<void> {
    const pending = this.instances.get(key)
    if (!pending) return
    const instance = await pending.catch(() => undefined)
    if (instance) {
      await this.flushInstance(instance)
      if (instance.dirty) throw new Error(instance.lastError ?? "state not saved")
      instance.closed = true
      if (instance.timer) clearTimeout(instance.timer)
      this.shutdown(instance.runtime)
    }
    if (this.instances.get(key) === pending) {
      this.instances.delete(key)
      this.loaded.delete(key)
    }
  }

  /** Drop one instance without saving it. */
  private async discard(key: string): Promise<void> {
    const pending = this.instances.get(key)
    if (!pending) return
    this.instances.delete(key)
    this.loaded.delete(key)
    const instance = await pending.catch(() => undefined)
    if (!instance) return
    instance.closed = true
    instance.dirty = false
    if (instance.timer) clearTimeout(instance.timer)
    await instance.queue
    this.shutdown(instance.runtime)
  }

  /**
   * Unload emulators that have been idle, and the least recently used ones when over capacity.
   * An `ephemeral` emulator has nowhere to be reloaded from, so it goes only under capacity pressure.
   */
  private async sweep(): Promise<void> {
    const idle = [...this.loaded.values()]
      .filter((instance) => instance.active === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    let excess = this.instances.size - this.maxInstances
    for (const instance of idle) {
      const expired =
        instance.spec.durability !== "ephemeral" && this.now() - instance.lastUsed > this.idleMs
      if (!expired && excess <= 0) continue
      try {
        await this.unload(instance.key)
        excess--
      } catch {
        // Its state could not be saved; keep it loaded and try again on the next sweep.
      }
    }
  }
}
