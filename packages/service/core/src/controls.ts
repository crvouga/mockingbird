import type { FaultRule } from "./faults.js"

/**
 * The admin controls every mock shares, as one document.
 *
 * The same shape is accepted in three places, and means the same thing in each:
 *
 * - at boot: `createRuntime({ adminControls })`, `serve --admin-controls`,
 *   `MOCKINGBIRD_ADMIN_CONTROLS`
 * - over HTTP: `PUT /__admin/controls`
 * - per request: the `x-mockingbird-*` headers in {@link CONTROL_HEADERS}
 *
 * Every control is deterministic: given the same seed, clock and requests, a mock answers
 * the same bytes. Nothing here reads the wall clock or `Math.random`.
 */

/** Milliseconds, or a string like `"250ms"`, `"2s"`, `"15m"`, `"1h"`, `"3d"`. */
export type Duration = number | string
/** Epoch milliseconds, or an ISO-8601 string. */
export type Instant = number | string

/** A control that cannot be applied: a bad value, an unknown key, a missing snapshot. */
export class ControlError extends RangeError {
  constructor(message: string) {
    super(message)
    this.name = "ControlError"
  }
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Milliseconds from a number, a numeric string, or a duration like `"90s"`, `"15m"`, `"2h"`. */
export const parseDuration = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const match = /^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(value.trim())
  if (!match) return undefined
  return Number(match[1]) * (UNITS[match[2] ?? "ms"] as number)
}

/** Epoch milliseconds from a number, a string of digits, or an ISO-8601 string. */
export const parseInstant = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (/^-?\d+$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** {@link parseDuration}, or a {@link ControlError} naming `label`. Negative only when allowed. */
export const durationMs = (value: unknown, label: string, negative = false): number => {
  const parsed = parseDuration(value)
  if (parsed === undefined)
    throw new ControlError(`${label}: expected milliseconds or a duration like "250ms" or "15m"`)
  if (!negative && parsed < 0) throw new ControlError(`${label}: must not be negative`)
  return parsed
}

/** {@link parseInstant}, or a {@link ControlError} naming `label`. */
export const instantMs = (value: unknown, label: string): number => {
  const parsed = parseInstant(value)
  if (parsed === undefined) throw new ControlError(`${label}: expected epoch ms or ISO-8601`)
  return parsed
}

/** A string of digits is that number, so `--seed 7`, `{"seed": 7}` and a header agree. */
export const normalizeSeed = (seed: unknown, label = "seed"): number | string => {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed
  if (typeof seed === "string" && seed !== "") return /^\d+$/.test(seed) ? Number(seed) : seed
  throw new ControlError(`${label}: expected a number or a non-empty string`)
}

export type ClockControls = {
  /** Move the clock to this instant. */
  now?: Instant
  /** Stop time. A frozen clock moves only when told to, so timestamps replay exactly. */
  frozen?: boolean
  /**
   * Step the clock forward by this much before every vendor request. With a frozen clock
   * each request still gets its own, reproducible timestamp.
   */
  autoAdvance?: Duration
}

/** How long a response takes: a fixed delay plus seeded jitter in `[0, jitter]`. */
export type LatencyRuleInput = { delay?: Duration; jitter?: Duration }

export type LatencyControls = LatencyRuleInput & {
  /** Per-operation overrides, keyed by operationId. A bare duration is its `delay`. */
  operations?: Record<string, Duration | LatencyRuleInput>
}

/** A fault to add: a rule (the id is assigned when omitted), or a named preset with overrides. */
export type FaultInput =
  | (Omit<FaultRule, "id"> & { id?: string })
  | ({ preset: string } & Partial<FaultRule>)

/** Identifies a {@link SnapshotDocument}. */
export const SNAPSHOT_FORMAT = "mockingbird.snapshot/v1"

/**
 * A namespace, as portable JSON: what `GET /__admin/snapshots/:id` returns and what
 * `PUT /__admin/snapshots/:id` and the boot `snapshot` control accept. Only `format` and
 * `records` are required, so a hand-written seed file is a valid snapshot.
 */
export type SnapshotDocument = {
  format: typeof SNAPSHOT_FORMAT
  /** The service that wrote it. A snapshot is rejected by any other service. */
  service?: string
  /**
   * Stored rows. `seq` orders a collection; omitted, rows keep their listed order. `raw` is
   * the stored text of a row that is not a plain record, and replaces `value` when present.
   */
  records: { collection: string; id: string; seq?: number; value?: unknown; raw?: string }[]
  /** Id counters, so the next generated id continues where the snapshot left off. */
  sequences?: { name: string; kind: string; value: number }[]
  clock?: { now: number; frozen: boolean; autoAdvanceMs?: number }
  seed?: number | string
  /** Positions of the seeded random streams. */
  rng?: { state: number; faults?: number; latency?: number }
  faults?: unknown
  latency?: unknown
  virtualTime?: boolean
}

/** Controls for one namespace. */
export type NamespaceControls = {
  /** Seeds every random choice: fault rates, jitter, and whatever the service invents. */
  seed?: number | string
  clock?: ClockControls
  /**
   * Spend injected waits (latency, fault delays, timeouts) on the mock clock instead of the
   * wall clock: the request returns at once, the clock has moved, and the journal records
   * the wait exactly. Default `false`: waits are real, so a client's own timeout can fire.
   */
  virtualTime?: boolean
  /** Baseline response time for every vendor request. A bare duration is its `delay`. */
  latency?: Duration | LatencyControls
  faults?: readonly FaultInput[]
  /** Start from this state instead of the service's own seed data. */
  snapshot?: SnapshotDocument
}

/** {@link NamespaceControls} for every namespace, with per-namespace overrides. */
export type MockControls = NamespaceControls & {
  /** Vendor credential → namespace, for SDKs that cannot send a namespace header. */
  credentials?: Record<string, string>
  /** Overrides for named namespaces. A key given here replaces the shared value. */
  namespaces?: Record<string, NamespaceControls>
}

const NAMESPACE_KEYS = new Set(["seed", "clock", "virtualTime", "latency", "faults", "snapshot"])
const MOCK_KEYS = new Set([...NAMESPACE_KEYS, "credentials", "namespaces"])
/**
 * What `GET /__admin/controls` reports beside the controls themselves. Accepted and ignored,
 * so what was read from one namespace can be applied to another as it is.
 */
const REPORTED_KEYS = new Set(["namespace", "snapshots"])
const REPORTED_CLOCK_KEYS = new Set(["iso", "offsetMs"])

/** What a namespace, a branch, a snapshot and a fault's namespace may be called. */
export const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const unknownKeys = (
  value: Record<string, unknown>,
  known: Set<string>,
  label: string,
  reported?: Set<string>,
): void => {
  for (const key of Object.keys(value)) {
    if (!known.has(key) && !reported?.has(key))
      throw new ControlError(
        `${label}: unknown control ${JSON.stringify(key)}; expected ${[...known].join(", ")}`,
      )
  }
}

/** A latency rule in milliseconds. */
export type LatencyRule = { delayMs: number; jitterMs: number }
/** Baseline latency for a namespace, normalized. */
export type LatencyState = LatencyRule & { operations: Record<string, LatencyRule> }

const latencyRule = (value: unknown, label: string): LatencyRule => {
  if (!isRecord(value)) return { delayMs: durationMs(value, label), jitterMs: 0 }
  unknownKeys(value, new Set(["delay", "jitter", "delayMs", "jitterMs", "operations"]), label)
  return {
    delayMs: durationMs(value.delay ?? value.delayMs ?? 0, `${label}.delay`),
    jitterMs: durationMs(value.jitter ?? value.jitterMs ?? 0, `${label}.jitter`),
  }
}

/** Validate and normalize a `latency` control. */
export const normalizeLatency = (value: unknown, label = "latency"): LatencyState => {
  const base = latencyRule(value, label)
  const operations: Record<string, LatencyRule> = {}
  if (isRecord(value) && value.operations !== undefined) {
    if (!isRecord(value.operations))
      throw new ControlError(`${label}.operations: expected an object keyed by operationId`)
    for (const [operationId, rule] of Object.entries(value.operations)) {
      if (isRecord(rule) && rule.operations !== undefined)
        throw new ControlError(`${label}.operations.${operationId}: cannot nest operations`)
      operations[operationId] = latencyRule(rule, `${label}.operations.${operationId}`)
    }
  }
  return { ...base, operations }
}

/** A clock control, normalized. Absent keys leave that part of the clock alone. */
export type ClockPlan = { now?: number; frozen?: boolean; autoAdvanceMs?: number }

/** Validate and normalize a `clock` control. Accepts the `POST /clock` spellings too. */
export const normalizeClock = (value: unknown, label = "clock"): ClockPlan => {
  if (!isRecord(value)) throw new ControlError(`${label}: expected an object`)
  unknownKeys(
    value,
    new Set(["now", "set", "frozen", "freeze", "autoAdvance", "autoAdvanceMs"]),
    label,
    REPORTED_CLOCK_KEYS,
  )
  const plan: ClockPlan = {}
  const now = value.now ?? value.set
  if (now !== undefined) plan.now = instantMs(now, `${label}.now`)
  const frozen = value.frozen ?? value.freeze
  if (frozen !== undefined) {
    if (typeof frozen !== "boolean") throw new ControlError(`${label}.frozen: expected a boolean`)
    plan.frozen = frozen
  }
  const auto = value.autoAdvance ?? value.autoAdvanceMs
  if (auto !== undefined) plan.autoAdvanceMs = durationMs(auto, `${label}.autoAdvance`)
  return plan
}

/** {@link NamespaceControls} with every value checked and every duration in milliseconds. */
export type ControlPlan = {
  seed?: number | string
  clock?: ClockPlan
  virtualTime?: boolean
  latency?: LatencyState
  faults?: readonly FaultInput[]
  snapshot?: SnapshotDocument
}

/** Check a snapshot document's shape. The runtime checks `service` when it restores one. */
export const assertSnapshotDocument = (value: unknown, label = "snapshot"): SnapshotDocument => {
  if (!isRecord(value)) throw new ControlError(`${label}: expected a snapshot document`)
  if (value.format !== SNAPSHOT_FORMAT)
    throw new ControlError(`${label}.format: expected ${JSON.stringify(SNAPSHOT_FORMAT)}`)
  if (!Array.isArray(value.records)) throw new ControlError(`${label}.records: expected a list`)
  value.records.forEach((row: unknown, index: number) => {
    if (
      !isRecord(row) ||
      typeof row.collection !== "string" ||
      typeof row.id !== "string" ||
      (row.value === undefined && typeof row.raw !== "string") ||
      (row.seq !== undefined && !Number.isSafeInteger(row.seq))
    )
      throw new ControlError(`${label}.records[${index}]: expected {collection, id, value, seq?}`)
  })
  if (value.sequences !== undefined) {
    if (!Array.isArray(value.sequences))
      throw new ControlError(`${label}.sequences: expected a list`)
    value.sequences.forEach((row: unknown, index: number) => {
      if (
        !isRecord(row) ||
        typeof row.name !== "string" ||
        typeof row.kind !== "string" ||
        !Number.isSafeInteger(row.value)
      )
        throw new ControlError(`${label}.sequences[${index}]: expected {name, kind, value}`)
    })
  }
  if (value.clock !== undefined) {
    if (
      !isRecord(value.clock) ||
      typeof value.clock.now !== "number" ||
      typeof value.clock.frozen !== "boolean"
    )
      throw new ControlError(`${label}.clock: expected {now, frozen}`)
  }
  return value as SnapshotDocument
}

/** Validate one namespace's controls. Fault rules are checked when they are added. */
export const normalizeControls = (value: unknown, label = "controls"): ControlPlan => {
  if (!isRecord(value)) throw new ControlError(`${label}: expected an object`)
  unknownKeys(value, NAMESPACE_KEYS, label, REPORTED_KEYS)
  const plan: ControlPlan = {}
  if (value.seed !== undefined) plan.seed = normalizeSeed(value.seed, `${label}.seed`)
  if (value.clock !== undefined) plan.clock = normalizeClock(value.clock, `${label}.clock`)
  if (value.virtualTime !== undefined) {
    if (typeof value.virtualTime !== "boolean")
      throw new ControlError(`${label}.virtualTime: expected a boolean`)
    plan.virtualTime = value.virtualTime
  }
  if (value.latency !== undefined)
    plan.latency = normalizeLatency(value.latency, `${label}.latency`)
  if (value.faults !== undefined) {
    if (!Array.isArray(value.faults) || !value.faults.every(isRecord))
      throw new ControlError(`${label}.faults: expected a list of fault rules`)
    plan.faults = value.faults as FaultInput[]
  }
  if (value.snapshot !== undefined)
    plan.snapshot = assertSnapshotDocument(value.snapshot, `${label}.snapshot`)
  return plan
}

/** Boot controls, checked once when the runtime is created. */
export type BootPlan = {
  shared: ControlPlan
  namespaces: Record<string, ControlPlan>
  credentials: Record<string, string>
}

/** Validate a boot {@link MockControls} document. */
export const normalizeBootControls = (value: unknown, label = "controls"): BootPlan => {
  if (value === undefined) return { shared: {}, namespaces: {}, credentials: {} }
  if (!isRecord(value)) throw new ControlError(`${label}: expected an object`)
  unknownKeys(value, MOCK_KEYS, label)
  const { credentials, namespaces, ...shared } = value
  const plan: BootPlan = {
    shared: normalizeControls(shared, label),
    namespaces: {},
    credentials: {},
  }
  if (namespaces !== undefined) {
    if (!isRecord(namespaces)) throw new ControlError(`${label}.namespaces: expected an object`)
    for (const [name, each] of Object.entries(namespaces)) {
      if (!KEY_PATTERN.test(name))
        throw new ControlError(`${label}.namespaces: bad namespace ${JSON.stringify(name)}`)
      plan.namespaces[name] = normalizeControls(each, `${label}.namespaces.${name}`)
    }
  }
  if (credentials !== undefined) {
    if (!isRecord(credentials)) throw new ControlError(`${label}.credentials: expected an object`)
    for (const [credential, namespace] of Object.entries(credentials)) {
      if (typeof namespace !== "string" || !KEY_PATTERN.test(namespace))
        throw new ControlError(`${label}.credentials: bad namespace for a credential`)
      plan.credentials[credential] = namespace
    }
  }
  return plan
}

// ── request headers ────────────────────────────────────────────────

/**
 * Every header a request can carry a control in. Selection headers pick what a request
 * reads; the rest act exactly like the matching admin call made just before the request.
 */
export const CONTROL_HEADERS = {
  namespace: "x-mockingbird-namespace",
  adminKey: "x-mockingbird-admin-key",
  branch: "x-mockingbird-branch",
  at: "x-mockingbird-at",
  reset: "x-mockingbird-reset",
  restore: "x-mockingbird-restore",
  seed: "x-mockingbird-seed",
  time: "x-mockingbird-time",
  advance: "x-mockingbird-advance",
  virtualTime: "x-mockingbird-virtual-time",
  fault: "x-mockingbird-fault",
  delay: "x-mockingbird-delay",
  timeout: "x-mockingbird-timeout",
  snapshot: "x-mockingbird-snapshot",
} as const

export type ControlHeaderName = keyof typeof CONTROL_HEADERS

/**
 * What each control header does, in the order the runtime applies them. This list is the
 * source for `GET /__admin` and is checked against the guide in `docs/ADMIN_CONTROLS.md`.
 */
export const CONTROL_HEADER_REFERENCE: readonly {
  header: string
  value: string
  /** `select` picks what is read; `namespace` changes it and persists; `request` is one request. */
  scope: "select" | "namespace" | "request"
  /** Needs `x-mockingbird-admin-key` when the mock has an admin key. */
  guarded: boolean
  summary: string
}[] = [
  {
    header: CONTROL_HEADERS.namespace,
    value: "<key>",
    scope: "select",
    guarded: false,
    summary:
      "Isolation key. Each key has its own records, clock, random streams, faults, latency, journal and snapshots.",
  },
  {
    header: CONTROL_HEADERS.branch,
    value: "<name>",
    scope: "select",
    guarded: false,
    summary: "Read and write a named copy-on-write branch of the namespace's history.",
  },
  {
    header: CONTROL_HEADERS.at,
    value: "<checkpoint>",
    scope: "select",
    guarded: false,
    summary: "Read the namespace as it was at a checkpoint. With a branch, start the branch there.",
  },
  {
    header: CONTROL_HEADERS.reset,
    value: "true",
    scope: "namespace",
    guarded: true,
    summary: "Reset the namespace to its boot state before the request is handled.",
  },
  {
    header: CONTROL_HEADERS.restore,
    value: "<snapshot>",
    scope: "namespace",
    guarded: true,
    summary: "Restore a snapshot before the request is handled.",
  },
  {
    header: CONTROL_HEADERS.seed,
    value: "<seed>",
    scope: "namespace",
    guarded: true,
    summary: "Restart the namespace's random streams from this seed.",
  },
  {
    header: CONTROL_HEADERS.time,
    value: "<epoch ms | ISO-8601>",
    scope: "namespace",
    guarded: true,
    summary: "Freeze the namespace clock at this instant.",
  },
  {
    header: CONTROL_HEADERS.advance,
    value: "<duration>",
    scope: "namespace",
    guarded: true,
    summary: "Move the namespace clock by this much, forward or (negative) back.",
  },
  {
    header: CONTROL_HEADERS.virtualTime,
    value: "true | false",
    scope: "namespace",
    guarded: true,
    summary: "Spend injected waits on the mock clock (true) or the wall clock (false).",
  },
  {
    header: CONTROL_HEADERS.delay,
    value: "<duration>",
    scope: "request",
    guarded: true,
    summary: "Hold this response back this long, on top of the namespace's latency.",
  },
  {
    header: CONTROL_HEADERS.timeout,
    value: "<duration>",
    scope: "request",
    guarded: true,
    summary: "Never answer this request: hold it this long, then drop the connection.",
  },
  {
    header: CONTROL_HEADERS.fault,
    value: '<status> | drop | <preset> | key=value; … | {"status": 503, …}',
    scope: "request",
    guarded: true,
    summary: "Fault this request only. Stored fault rules are not consulted when it answers.",
  },
  {
    header: CONTROL_HEADERS.snapshot,
    value: "<name>",
    scope: "namespace",
    guarded: true,
    summary: "Snapshot the namespace after the request is handled. Echoed on the response.",
  },
]

/** The controls one request carries in its headers, parsed and checked. */
export type RequestControls = {
  reset?: true
  restore?: string
  seed?: number | string
  time?: number
  advance?: number
  virtualTime?: boolean
  delay?: number
  timeout?: number
  fault?: Record<string, unknown>
  snapshot?: string
}

const flag = (value: string, header: string): boolean => {
  const text = value.trim().toLowerCase()
  if (text === "true" || text === "1") return true
  if (text === "false" || text === "0") return false
  throw new ControlError(`${header}: expected true or false`)
}

const name = (value: string, header: string): string => {
  const text = value.trim()
  if (!KEY_PATTERN.test(text)) throw new ControlError(`${header}: must match ${KEY_PATTERN}`)
  return text
}

const FAULT_PAIRS = new Set([
  "status",
  "delay",
  "jitter",
  "timeout",
  "drop",
  "truncate",
  "effect",
  "preset",
  "body",
])

/**
 * Parse an `x-mockingbird-fault` value into a fault rule (or preset reference):
 *
 * - `503` — answer with that status
 * - `drop` — drop the connection
 * - `rate_limited` — a preset, by name
 * - `status=503; delay=2s; header.retry-after=5` — `key=value` pairs
 * - `{"status": 503, "body": {…}}` — a rule as JSON
 */
export const parseFaultHeader = (
  value: string,
  header: string = CONTROL_HEADERS.fault,
): Record<string, unknown> => {
  const text = value.trim()
  if (text === "") throw new ControlError(`${header}: expected a fault`)
  if (text.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ControlError(`${header}: not valid JSON`)
    }
    if (!isRecord(parsed)) throw new ControlError(`${header}: expected a JSON object`)
    return parsed
  }
  const rule: Record<string, unknown> = {}
  const headers: Record<string, string> = {}
  for (const [index, raw] of text.split(";").entries()) {
    const part = raw.trim()
    if (part === "") continue
    const equals = part.indexOf("=")
    if (equals < 0) {
      if (index > 0 && part !== "drop")
        throw new ControlError(`${header}: expected key=value, got ${JSON.stringify(part)}`)
      if (/^\d{3}$/.test(part)) rule.status = Number(part)
      else if (part === "drop") rule.drop = true
      else rule.preset = name(part, header)
      continue
    }
    const key = part.slice(0, equals).trim().toLowerCase()
    const item = part.slice(equals + 1).trim()
    if (key.startsWith("header.")) headers[key.slice("header.".length)] = item
    else if (!FAULT_PAIRS.has(key))
      throw new ControlError(
        `${header}: unknown key ${JSON.stringify(key)}; expected ${[...FAULT_PAIRS].join(", ")} or header.<name>`,
      )
    else if (key === "status" || key === "truncate") {
      if (!/^\d+$/.test(item)) throw new ControlError(`${header}: ${key} must be a number`)
      rule[key] = Number(item)
    } else if (key === "drop") rule.drop = flag(item, `${header} drop`)
    else rule[key] = item
  }
  if (Object.keys(headers).length > 0) rule.headers = headers
  if (Object.keys(rule).length === 0) throw new ControlError(`${header}: expected a fault`)
  return rule
}

const GUARDED = CONTROL_HEADER_REFERENCE.filter((each) => each.guarded).map((each) => each.header)

/** Whether a request carries a control that changes the mock or injects a failure. */
export const hasGuardedControlHeader = (headers: Headers): boolean =>
  GUARDED.some((header) => headers.has(header))

/** Read a request's control headers. `undefined` when it carries none. Throws {@link ControlError}. */
export const parseControlHeaders = (headers: Headers): RequestControls | undefined => {
  if (!hasGuardedControlHeader(headers)) return undefined
  const controls: RequestControls = {}
  const read = (key: ControlHeaderName) => headers.get(CONTROL_HEADERS[key])
  const reset = read("reset")
  if (reset !== null && flag(reset, CONTROL_HEADERS.reset)) controls.reset = true
  const restore = read("restore")
  if (restore !== null) controls.restore = name(restore, CONTROL_HEADERS.restore)
  const seed = read("seed")
  if (seed !== null) controls.seed = normalizeSeed(seed.trim(), CONTROL_HEADERS.seed)
  const time = read("time")
  if (time !== null) controls.time = instantMs(time, CONTROL_HEADERS.time)
  const advance = read("advance")
  if (advance !== null) controls.advance = durationMs(advance, CONTROL_HEADERS.advance, true)
  const virtualTime = read("virtualTime")
  if (virtualTime !== null) controls.virtualTime = flag(virtualTime, CONTROL_HEADERS.virtualTime)
  const delay = read("delay")
  if (delay !== null) controls.delay = durationMs(delay, CONTROL_HEADERS.delay)
  const timeout = read("timeout")
  if (timeout !== null) controls.timeout = durationMs(timeout, CONTROL_HEADERS.timeout)
  const fault = read("fault")
  if (fault !== null) controls.fault = parseFaultHeader(fault)
  const snapshot = read("snapshot")
  if (snapshot !== null) controls.snapshot = name(snapshot, CONTROL_HEADERS.snapshot)
  return controls
}

/** What {@link controlHeaders} turns into request headers. */
export type ControlHeaderInput = {
  namespace?: string
  adminKey?: string
  branch?: string
  at?: string
  reset?: boolean
  restore?: string
  seed?: number | string
  time?: Instant | Date
  advance?: Duration
  virtualTime?: boolean
  delay?: Duration
  timeout?: Duration
  /** A status, `"drop"`, a preset name, or a fault rule. */
  fault?: number | string | Record<string, unknown>
  snapshot?: string
}

/**
 * Build the request headers for a set of controls, to spread into a `fetch` or hand to an
 * SDK's default headers. Values are checked, so a typo fails here and not as a `400` later.
 */
export const controlHeaders = (input: ControlHeaderInput): Record<string, string> => {
  const headers: Record<string, string> = {}
  const set = (key: ControlHeaderName, value: string) => {
    headers[CONTROL_HEADERS[key]] = value
  }
  if (input.namespace !== undefined) set("namespace", name(input.namespace, "namespace"))
  if (input.adminKey !== undefined) set("adminKey", input.adminKey)
  if (input.branch !== undefined) set("branch", name(input.branch, "branch"))
  if (input.at !== undefined) set("at", input.at)
  if (input.reset === true) set("reset", "true")
  if (input.restore !== undefined) set("restore", name(input.restore, "restore"))
  if (input.seed !== undefined) set("seed", String(normalizeSeed(input.seed)))
  if (input.time !== undefined) {
    const time = input.time instanceof Date ? input.time.getTime() : input.time
    set("time", new Date(instantMs(time, "time")).toISOString())
  }
  if (input.advance !== undefined)
    set("advance", String(durationMs(input.advance, "advance", true)))
  if (input.virtualTime !== undefined) set("virtualTime", String(input.virtualTime))
  if (input.delay !== undefined) set("delay", String(durationMs(input.delay, "delay")))
  if (input.timeout !== undefined) set("timeout", String(durationMs(input.timeout, "timeout")))
  if (input.fault !== undefined) {
    const fault =
      typeof input.fault === "object" ? JSON.stringify(input.fault) : String(input.fault)
    parseFaultHeader(fault, "fault")
    set("fault", fault)
  }
  if (input.snapshot !== undefined) set("snapshot", name(input.snapshot, "snapshot"))
  return headers
}
