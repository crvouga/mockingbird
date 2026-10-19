import type { Clock, ClockState } from "./clock.js"
import {
  type BootPlan,
  type ClockPlan,
  ControlError,
  type ControlPlan,
  isRecord,
  type LatencyState,
  normalizeSeed,
  type SnapshotDocument,
} from "./controls.js"
import {
  createFaultRegistry,
  type FaultListing,
  type FaultPreset,
  type FaultRegistry,
  type FaultRule,
  type FaultSnapshot,
  faultHasAction,
  normalizeFault,
  STANDARD_FAULT_PRESETS,
} from "./faults.js"
import { createLatencyRegistry, type LatencyRegistry } from "./latency.js"
import { createRng, type Rng } from "./rng.js"

/** The controls of a namespace that are plain settings, not registries. */
export type ControlSettings = {
  seed: number | string
  virtualTime: boolean
  autoAdvanceMs: number
}

/** Clock state as the admin API reports it. */
export type ControlClock = ClockState & {
  /** `now`, as ISO-8601. */
  iso: string
  /** Milliseconds the clock steps before every vendor request. */
  autoAdvanceMs: number
}

/** One namespace's controls: the body of `GET /__admin/controls`. */
export type ControlState = {
  namespace: string
  seed: number | string
  clock: ControlClock
  virtualTime: boolean
  latency: LatencyState
  faults: FaultListing[]
}

/**
 * A namespace's controls as a snapshot holds them. Every part is optional: restoring puts
 * back what is there and leaves the rest of the namespace as it is.
 */
export type ControlsSnapshot = {
  settings?: Partial<ControlSettings>
  /** Where the fault and latency streams stand. */
  streams?: { faults?: number; latency?: number }
  faults?: FaultSnapshot
  latency?: LatencyState
}

/** A change to a clock: {@link ClockPlan} plus the one-shot moves `POST /clock` accepts. */
export type ClockChange = ClockPlan & { advanceMs?: number; reset?: boolean }

/** What a reboot puts back: everything a boot snapshot holds, or only its controls. */
export type BootScope = "all" | "controls"

export type NamespaceControls = {
  readonly faults: FaultRegistry
  readonly latency: LatencyRegistry
  /** Standard presets, with the service's own taking precedence. */
  readonly presets: Readonly<Record<string, FaultPreset>>
  /** Boot the namespace the first time it is used. Idempotent. */
  ensure(namespace: string): void
  settings(namespace: string): Readonly<ControlSettings>
  clock(namespace: string): ControlClock
  describe(namespace: string): ControlState
  /** Throw {@link ControlError} unless every part of `plan` can be applied. Changes nothing. */
  check(plan: ControlPlan): void
  /**
   * Apply seed, clock, virtual time, latency and faults. A given key replaces that control.
   * The whole plan is checked first, so a plan that is rejected has changed nothing.
   */
  apply(namespace: string, plan: ControlPlan): void
  changeClock(namespace: string, change: ClockChange): ControlClock
  /** Add one fault from an untrusted body: a rule, or `{"preset": "<name>", …overrides}`. */
  addFault(namespace: string, input: unknown): FaultRule[]
  /** The rules one request scripts for itself in its headers. Nothing is stored. */
  scriptFaults(
    namespace: string,
    request: { fault?: Record<string, unknown>; timeoutMs?: number },
  ): FaultRule[]
  /** Restart every random stream of a namespace from `seed`. */
  reseed(namespace: string, seed: number | string): void
  /** Put a namespace back to what it was at boot: all of it, or only its controls. */
  reboot(namespace: string, scope?: BootScope): void
  /** Forget every namespace; each boots again when next used. */
  rebootAll(): void
  snapshot(namespace: string): Required<ControlsSnapshot>
  restore(namespace: string, snapshot: ControlsSnapshot): void
  /** Drop a namespace's controls entirely. */
  forget(namespace: string): void
}

export type NamespaceControlsOptions = {
  /** What every stream starts from, unless a namespace is given a seed of its own. */
  seed: number | string
  clock(namespace: string): Clock
  boot?: BootPlan
  /** The service's presets. The standard ones fill in behind them. */
  presets?: Readonly<Record<string, FaultPreset>>
  /** How a fault waits on the wall clock, when the request does not say. */
  sleep?(ms: number): Promise<void>
  /** Reseed whatever else draws from the namespace's seed (the service's own stream). */
  onReseed?(namespace: string, seed: number | string): void
  /** A preset was switched on: do the part of it that is not a fault rule. */
  onPreset?(preset: FaultPreset, namespace: string, overrides: Partial<FaultRule>): void
  /** Put a snapshot document into a namespace: the boot `snapshot` control. */
  restoreDocument?(namespace: string, document: SnapshotDocument, scope: BootScope): void
}

const NO_BOOT: BootPlan = { shared: {}, namespaces: {}, credentials: {} }

/** What a rule does, without what it matches or when: all one request can script for itself. */
const ACTION = [
  "status",
  "body",
  "headers",
  "delayMs",
  "jitterMs",
  "timeoutMs",
  "drop",
  "truncate",
  "effect",
  "params",
] as const

/** Keys that choose requests. A fault in a header has already chosen its request. */
const CHOOSES_REQUESTS = [
  "id",
  "operationId",
  "method",
  "path",
  "pathPrefix",
  "pathPattern",
  "requestHeaders",
  "query",
  "requestBody",
  "namespace",
  "after",
  "every",
  "count",
  "rate",
  "from",
  "until",
]

type Resolved = {
  /** `assign`: the rule takes the namespace's next `fault_<n>` id when it is stored. */
  rules: { rule: FaultRule; assign: boolean }[]
  preset?: { preset: FaultPreset; overrides: Partial<FaultRule> }
}

/**
 * Per-namespace seed, clock settings, latency and faults, and the one place a control
 * document is checked and applied — at boot, from `PUT /__admin/controls`, and from request
 * headers. It owns the seeded streams too: a namespace's seed lives here and nowhere else.
 */
export const createNamespaceControls = (options: NamespaceControlsOptions): NamespaceControls => {
  const boot = options.boot ?? NO_BOOT
  const presets: Record<string, FaultPreset> = { ...options.presets }
  for (const [name, preset] of Object.entries(STANDARD_FAULT_PRESETS)) presets[name] ??= preset

  const settings = new Map<string, ControlSettings>()
  const streams = new Map<string, { faults: Rng; latency: Rng }>()
  const ensured = new Set<string>()

  const settingsOf = (namespace: string): ControlSettings => {
    let found = settings.get(namespace)
    if (!found) {
      found = { seed: options.seed, virtualTime: false, autoAdvanceMs: 0 }
      settings.set(namespace, found)
    }
    return found
  }
  const streamsOf = (namespace: string) => {
    let found = streams.get(namespace)
    if (!found) {
      const { seed } = settingsOf(namespace)
      found = { faults: createRng(seed), latency: createRng(seed) }
      streams.set(namespace, found)
    }
    return found
  }
  const faults = createFaultRegistry((namespace) => streamsOf(namespace).faults, options.sleep)
  const latency = createLatencyRegistry((namespace) => streamsOf(namespace).latency)

  const reseed = (namespace: string, seed: number | string): void => {
    const next = normalizeSeed(seed)
    settingsOf(namespace).seed = next
    const own = streamsOf(namespace)
    own.faults.reseed(next)
    own.latency.reseed(next)
    options.onReseed?.(namespace, next)
  }

  const changeClock = (namespace: string, change: ClockChange): void => {
    const clock = options.clock(namespace)
    if (change.reset === true) {
      clock.reset()
      settingsOf(namespace).autoAdvanceMs = 0
    }
    // Freeze before applying mutations so a compound `{ now, frozen: true }` change is
    // atomic. Setting a live clock adjusts its offset; freezing it afterward would read the
    // source again and could pin it a millisecond past the requested instant.
    if (change.frozen === true) clock.freeze()
    if (change.now !== undefined) clock.set(change.now)
    if (change.advanceMs !== undefined) clock.advance(change.advanceMs)
    if (change.frozen === false) clock.unfreeze()
    if (change.autoAdvanceMs !== undefined)
      settingsOf(namespace).autoAdvanceMs = change.autoAdvanceMs
  }

  /** A rule or a preset reference, as the rules it stands for. Checks everything; stores nothing. */
  const resolve = (namespace: string, input: unknown, now: number): Resolved => {
    if (!isRecord(input)) throw new ControlError("fault: expected an object")
    if (typeof input.preset !== "string") {
      const rule = normalizeFault(input, {
        id: "unassigned",
        // Scoped to the caller's namespace unless it asks for every one, so one worker's
        // injected failure never lands on another's request.
        namespace,
        now,
        strict: true,
      })
      if (!faultHasAction(rule))
        throw new ControlError(
          "a fault needs a status, a delay, a timeout, drop: true, truncate, an effect, or a preset",
        )
      return { rules: [{ rule, assign: typeof input.id !== "string" }] }
    }
    const { preset: name, ...given } = input
    const preset = presets[name]
    if (!preset)
      throw new ControlError(
        `no fault preset ${JSON.stringify(name)}; known: ${Object.keys(presets).join(", ")}`,
      )
    // Both sides in stored form first, so an override wins whichever spelling it uses.
    const { id, ...overrides } = normalizeFault(
      { ...given, id: given.id ?? name },
      { now, strict: true },
    )
    const rules = preset.rules ?? []
    return {
      preset: { preset, overrides },
      rules: rules.map((each, index) => {
        const { id: _id, ...base } = normalizeFault({ ...each, id: name }, { now })
        return {
          assign: false,
          rule: {
            namespace,
            ...base,
            ...overrides,
            fromPreset: name,
            id: `${id}${rules.length > 1 ? `_${index + 1}` : ""}`,
          },
        }
      }),
    }
  }

  const store = (namespace: string, resolved: Resolved): FaultRule[] => {
    const added = resolved.rules.map(({ rule, assign }) =>
      // Only a rule that is accepted takes the next id, so a rejected request leaves no gap.
      faults.add(assign ? { ...rule, id: faults.nextId(rule.namespace ?? namespace) } : rule),
    )
    if (resolved.preset)
      options.onPreset?.(resolved.preset.preset, namespace, resolved.preset.overrides)
    return added
  }

  const check = (plan: ControlPlan): void => {
    for (const each of (plan.faults ?? []) as readonly unknown[]) {
      // A document is one namespace's controls. A rule for every namespace would be added
      // again each time another namespace booted or reset.
      if (isRecord(each) && each.namespace === "*")
        throw new ControlError(
          'faults: a control document cannot hold a "*" rule; add it with POST /faults',
        )
      resolve("default", each, 0)
    }
  }

  /** Apply a plan that has been checked. `replace` clears the namespace's rules first. */
  const commit = (namespace: string, plan: ControlPlan, replace: boolean): void => {
    if (plan.seed !== undefined) reseed(namespace, plan.seed)
    if (plan.clock !== undefined) changeClock(namespace, plan.clock)
    if (plan.virtualTime !== undefined) settingsOf(namespace).virtualTime = plan.virtualTime
    if (plan.latency !== undefined) latency.set(namespace, plan.latency)
    if (plan.faults !== undefined) {
      if (replace) faults.clear(namespace)
      // Resolved now, not when checked: a window given as a duration counts from the clock
      // this same plan may just have moved.
      const now = options.clock(namespace).now()
      for (const each of plan.faults as readonly Record<string, unknown>[])
        store(namespace, resolve(namespace, { ...each, namespace }, now))
    }
  }

  /** The namespace's boot plan: the shared controls with its own overrides on top. */
  const bootPlan = (namespace: string): ControlPlan => ({
    ...boot.shared,
    ...boot.namespaces[namespace],
  })

  const start = (namespace: string, scope: BootScope): void => {
    ensured.add(namespace)
    const { snapshot, ...plan } = bootPlan(namespace)
    // Rules a caller added in process before the namespace's first use are kept, after the
    // rules it boots with.
    const early = faults.snapshot(namespace).rules
    if (early.length > 0) faults.clear(namespace)
    // The snapshot first, so a control named beside it wins over the one it carries.
    if (snapshot) options.restoreDocument?.(namespace, snapshot, scope)
    commit(namespace, plan, true)
    for (const { remaining: _r, hits: _h, seen: _s, position: _p, ...rule } of early)
      faults.add(rule)
  }

  const ensure = (namespace: string): void => {
    if (!ensured.has(namespace)) start(namespace, "all")
  }

  const clockOf = (namespace: string): ControlClock => {
    ensure(namespace)
    const state = options.clock(namespace).state()
    return {
      ...state,
      iso: new Date(state.now).toISOString(),
      autoAdvanceMs: settingsOf(namespace).autoAdvanceMs,
    }
  }

  const wipe = (namespace: string): void => {
    faults.clear(namespace)
    latency.clear(namespace)
    settings.delete(namespace)
    streams.delete(namespace)
    ensured.delete(namespace)
  }

  // Fail when the runtime is created, not on the first request to hit a bad boot rule.
  check(boot.shared)
  for (const plan of Object.values(boot.namespaces)) check(plan)

  return {
    faults,
    latency,
    presets,
    ensure,
    settings(namespace) {
      ensure(namespace)
      return settingsOf(namespace)
    },
    clock: clockOf,
    describe(namespace) {
      ensure(namespace)
      const current = settingsOf(namespace)
      return {
        namespace,
        seed: current.seed,
        clock: clockOf(namespace),
        virtualTime: current.virtualTime,
        latency: latency.get(namespace),
        faults: faults.list(namespace),
      }
    },
    check,
    apply(namespace, plan) {
      check(plan)
      ensure(namespace)
      commit(namespace, plan, true)
    },
    changeClock(namespace, change) {
      ensure(namespace)
      changeClock(namespace, change)
      return clockOf(namespace)
    },
    addFault(namespace, input) {
      ensure(namespace)
      return store(namespace, resolve(namespace, input, options.clock(namespace).now()))
    },
    scriptFaults(namespace, request) {
      const rules: FaultRule[] = []
      if (request.fault) {
        if (typeof request.fault.preset !== "string") {
          const chooses = CHOOSES_REQUESTS.find((key) => key in (request.fault ?? {}))
          if (chooses)
            throw new ControlError(
              `fault: ${chooses} has no meaning here; a fault in a header is for its own request`,
            )
        }
        // A preset's rules say which requests to fault. This request has already been chosen.
        for (const { rule } of resolve(namespace, request.fault, 0).rules) {
          const action: FaultRule = { id: "request" }
          for (const key of ACTION)
            if (rule[key] !== undefined) Object.assign(action, { [key]: rule[key] })
          rules.push(action)
        }
      }
      if (request.timeoutMs !== undefined)
        rules.push({ id: "request", timeoutMs: request.timeoutMs })
      return rules
    },
    reseed(namespace, seed) {
      ensure(namespace)
      reseed(namespace, seed)
    },
    reboot(namespace, scope = "all") {
      wipe(namespace)
      options.clock(namespace).reset()
      options.onReseed?.(namespace, options.seed)
      start(namespace, scope)
    },
    rebootAll() {
      const known = new Set([...ensured, ...settings.keys()])
      faults.clear()
      latency.clear()
      settings.clear()
      streams.clear()
      ensured.clear()
      for (const namespace of known) {
        options.clock(namespace).reset()
        options.onReseed?.(namespace, options.seed)
      }
    },
    snapshot(namespace) {
      ensure(namespace)
      const own = streamsOf(namespace)
      return {
        settings: { ...settingsOf(namespace) },
        streams: { faults: own.faults.state(), latency: own.latency.state() },
        faults: faults.snapshot(namespace),
        latency: latency.get(namespace),
      }
    },
    restore(namespace, snapshot) {
      ensure(namespace)
      const { seed, ...rest } = snapshot.settings ?? {}
      Object.assign(settingsOf(namespace), rest)
      // The seed first: it restarts the streams, and their positions are set after it.
      if (seed !== undefined) reseed(namespace, seed)
      const own = streamsOf(namespace)
      if (snapshot.streams?.faults !== undefined) own.faults.setState(snapshot.streams.faults)
      if (snapshot.streams?.latency !== undefined) own.latency.setState(snapshot.streams.latency)
      if (snapshot.faults) faults.restore(namespace, snapshot.faults)
      if (snapshot.latency) latency.set(namespace, snapshot.latency)
    },
    forget: wipe,
  }
}
