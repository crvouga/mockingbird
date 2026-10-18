import {
  ControlError,
  type Duration,
  durationMs,
  type Instant,
  isRecord,
  KEY_PATTERN,
  parseDuration,
  parseInstant,
} from "./controls.js"
import { createRng, type Rng } from "./rng.js"

/**
 * A deliberate failure injected in front of an operation.
 *
 * This is how a suite reaches the vendor's failure modes without the vendor: the
 * quota error that only appears when a shared sandbox is full, the 429 that only
 * appears under load, the 5xx that proves a retry path works.
 *
 * A rule has three parts. What it **matches** (`operationId`, `method`, `path`, …), **when**
 * it fires among the matching requests (`after`, `every`, `count`, `rate`, `from`, `until`),
 * and what it **does** (`status`, `delay`, `timeout`, `drop`, `truncate`, `effect`).
 */
export type FaultRule = {
  /** Stable id, so a suite can retire exactly the rule it added. Unique within a namespace. */
  id: string

  /** Fault only this operation. Omit to match every operation. */
  operationId?: string
  /** Fault only this HTTP method, case-insensitive. Omit to match every method. */
  method?: string
  /** Fault only this exact path. */
  path?: string
  /** Fault only paths starting with this prefix. Omit to match every path. */
  pathPrefix?: string
  /** Fault only paths matching this regular expression (JavaScript syntax, unanchored). */
  pathPattern?: string
  /** Fault only requests carrying these headers. `"*"` matches any value. */
  requestHeaders?: Record<string, string>
  /** Fault only requests carrying these query parameters. `"*"` matches any value. */
  query?: Record<string, string>
  /**
   * Fault only requests whose JSON body carries these fields. Each key is a dotted path into
   * the parsed body (`"patient_details.email"`; a number steps into an array, `"items.0.sku"`)
   * and each value is what the field must equal: a string, number, boolean or `null`, compared
   * strictly (`3` is not `"3"`). `"*"` matches any value that is present. A request whose body
   * is missing, is not JSON, or is not a JSON object never matches. Not `body`, which is the
   * response a rule injects.
   */
  requestBody?: Record<string, RequestBodyValue>
  /**
   * Fault only this namespace. Omit (or `"*"`) to fault every namespace — which is what
   * an in-process caller usually wants, and what a parallel worker usually does not:
   * rules added through `POST /__admin/faults` default to the calling namespace.
   */
  namespace?: string

  /** Let this many matching requests through first. */
  after?: number
  /** Then fault only every nth matching request: `3` faults the 3rd, 6th, 9th. */
  every?: number
  /** Retire the rule after this many faults. Omit to keep it until removed. */
  count?: number
  /** Fault this fraction of the remaining requests, `0`–`1`, drawn from the seed. Default `1`. */
  rate?: number
  /**
   * Fault only from this instant on the namespace clock. A duration (`"5m"`) counts from the
   * clock when the rule was added. Listed as epoch ms.
   */
  from?: Instant | Duration
  /** Stop faulting at this instant on the namespace clock. A duration counts from when added. */
  until?: Instant | Duration

  /**
   * Status of the injected response. Omit for a rule that only delays, times out, drops,
   * truncates, or switches on an `effect`: the request then still reaches the service.
   */
  status?: number
  /** Response body, serialized as JSON. A string is sent as-is. */
  body?: unknown
  /** Response headers. */
  headers?: Record<string, string>
  /** Hold the response back this long. Listed as `delayMs`. */
  delay?: Duration
  /** `delay`, in milliseconds. */
  delayMs?: number
  /** Alias of `delayMs`. */
  latencyMs?: number
  /** Extra seeded delay in `[0, jitter]`. Listed as `jitterMs`. */
  jitter?: Duration
  jitterMs?: number
  /**
   * Never answer: hold the request this long, then drop the connection. Listed as
   * `timeoutMs`. With virtual time the wait is spent on the mock clock.
   */
  timeout?: Duration
  timeoutMs?: number
  /**
   * Drop the connection instead of answering: an in-process `fetch` rejects with a
   * `TypeError`, and a served mock destroys the socket. Models "unknown outcome" failures.
   */
  drop?: boolean
  /**
   * Cut the response body off after this many bytes: the status and headers arrive, then
   * the connection dies mid-body.
   */
  truncate?: number
  /**
   * A named service behaviour to switch on for the matching request instead of (or
   * before) a canned response, e.g. `created_but_500` or `numeric_tracking_id`. Services
   * read it with `faultEffects(request)`.
   */
  effect?: string
  /** Parameters for `effect`. */
  params?: Record<string, unknown>
  /** The preset this rule was expanded from, if any. */
  fromPreset?: string
}

/** What a field of the request body must equal in {@link FaultRule.requestBody}. */
export type RequestBodyValue = string | number | boolean | null

/** A fault that fired for one request. */
export type FaultHit = {
  id: string
  /** The injected response; absent when the rule only delays, drops, or sets an effect. */
  response?: Response
  drop?: boolean
  /** Set with `drop` when the rule held the request for its `timeout` first. */
  timeout?: boolean
  /** Bytes of response body to let through before the connection dies. */
  truncate?: number
  effect?: { name: string; params: Record<string, unknown> }
}

/**
 * A named, documented fault a suite switches on by name
 * (`POST /__admin/faults {"preset": "rate_limited"}`): one or more rules, and optionally a
 * webhook delivery fault.
 */
export type FaultPreset = {
  description: string
  rules?: Omit<FaultRule, "id">[]
  webhook?: { mode: "duplicate" | "reorder" | "drop"; count?: number }
}

/**
 * Presets every mock answers to, so a suite uses one vocabulary across vendors. A service
 * preset of the same name replaces the standard one with the vendor's own error body.
 */
export const STANDARD_FAULT_PRESETS: Record<string, FaultPreset> = {
  server_error: {
    description: "The vendor answers 500.",
    rules: [{ status: 500 }],
  },
  bad_gateway: {
    description: "A proxy in front of the vendor answers 502.",
    rules: [{ status: 502 }],
  },
  unavailable: {
    description: "The vendor is down: 503 with retry-after.",
    rules: [{ status: 503, headers: { "retry-after": "1" } }],
  },
  gateway_timeout: {
    description: "A proxy gives up on the vendor: 504.",
    rules: [{ status: 504 }],
  },
  rate_limited: {
    description: "Too many requests: 429 with retry-after.",
    rules: [{ status: 429, headers: { "retry-after": "1" } }],
  },
  unauthorized: {
    description: "The credential is rejected: 401.",
    rules: [{ status: 401 }],
  },
  forbidden: {
    description: "The credential lacks permission: 403.",
    rules: [{ status: 403 }],
  },
  slow: {
    description: "Every response takes two more seconds.",
    rules: [{ delayMs: 2_000 }],
  },
  timeout: {
    description:
      "The vendor never answers: the request hangs 30 seconds, then the connection drops.",
    rules: [{ timeoutMs: 30_000 }],
  },
  connection_reset: {
    description: "The connection dies before any response.",
    rules: [{ drop: true }],
  },
  truncated_response: {
    description: "The response starts, then the connection dies mid-body.",
    rules: [{ truncate: 0 }],
  },
  flaky: {
    description: "Half of the requests answer 503, chosen by the seed.",
    rules: [{ status: 503, rate: 0.5 }],
  },
}

/**
 * Body of `GET /__admin/faults/presets`.
 * `presets` is a list of named presets. A record keyed by name is not this type:
 * the admin page maps the list.
 */
export type FaultPresetList = {
  presets: readonly { name: string }[]
}

type _AssertFaultPresetList<T extends FaultPresetList> = T
// @ts-expect-error presets is a list of { name }, not a record keyed by name
type _RecordIsNotAPresetList = _AssertFaultPresetList<{ presets: Record<string, { name: string }> }>

/** What a request looks like to the fault matcher. */
export type FaultCandidate = {
  operationId: string | undefined
  method: string
  path: string
  namespace: string
  /** Request headers and query, for rules that match on them. */
  headers?: Headers
  query?: URLSearchParams
  /**
   * The request body parsed as JSON, read only when a rule matches on `requestBody`. Resolve
   * `undefined` for a body that is missing or not JSON. It must leave the request readable.
   */
  readJson?: () => Promise<unknown>
  /** The namespace clock, for `from` / `until`. Rules with a window are skipped without it. */
  now?: number
  /** How to spend a delay for this request. Default: the registry's own sleep. */
  wait?: (ms: number) => Promise<void>
}

/** A stored rule and how often it was consulted. */
export type FaultListing = FaultRule & {
  /** Faults left before the rule retires. `null` when it has no `count`. */
  remaining: number | null
  /** Times the rule faulted a request. */
  hits: number
  /** Requests that matched the rule, faulted or not. */
  seen: number
}

/** A namespace's own rules, with their counters, in the order they are tried. */
export type FaultSnapshot = {
  /**
   * `position` is how many `"*"` rules are tried before the rule, which is what its place
   * in the order means to a request and holds in any process.
   */
  rules: (FaultListing & { position?: number })[]
  /** How many `fault_<n>` ids the namespace has handed out. */
  nextId?: number
}

export type FaultRegistry = {
  snapshot(namespace: string): FaultSnapshot
  /** Add a rule, or replace the rule with the same id in the same namespace. */
  add(rule: FaultRule): FaultRule
  /** The next unused `fault_<n>` id in `namespace`. */
  nextId(namespace: string): string
  /** Every rule, or the rules a namespace's requests can hit: its own and the global ones. */
  list(namespace?: string): FaultListing[]
  get(id: string, namespace?: string): FaultListing | undefined
  /** Remove a rule by id: from `namespace` (its own, then a global one), or wherever it is. */
  remove(id: string, namespace?: string): boolean
  /** Remove every rule, or one namespace's own rules. */
  clear(namespace?: string): void
  /** Replace a namespace's own rules with a snapshot's, wherever the snapshot was taken. */
  restore(namespace: string, state: FaultSnapshot): void
  /**
   * Every fault this request should get, in rule order, stopping at the first that answers
   * or drops (effect-only and delay-only rules let later rules match too). Consumes one of
   * each matching rule's remaining uses.
   */
  take(candidate: FaultCandidate): Promise<FaultHit[]>
  /**
   * Fire these rules at one request without storing them: no matching, no schedule, in order,
   * stopping at the first that answers or drops. Jitter draws from the namespace's stream.
   */
  fire(rules: readonly FaultRule[], candidate: FaultCandidate): Promise<FaultHit[]>
}

/** The namespace of a rule that faults every namespace. */
const GLOBAL = "*"

const RULE_KEYS = new Set([
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
  "status",
  "body",
  "headers",
  "delay",
  "delayMs",
  "latencyMs",
  "jitter",
  "jitterMs",
  "timeout",
  "timeoutMs",
  "drop",
  "truncate",
  "effect",
  "params",
  "fromPreset",
])
/** Counters a listed rule carries. Accepted and ignored, so a listing can be applied again. */
const LISTING_KEYS = new Set(["remaining", "hits", "seen"])

const stringMap = (value: unknown, label: string): Record<string, string> => {
  if (!isRecord(value) || !Object.values(value).every((each) => typeof each === "string"))
    throw new ControlError(`${label}: expected an object of strings`)
  return value as Record<string, string>
}

const requestBodyMap = (value: unknown): Record<string, RequestBodyValue> => {
  if (!isRecord(value)) throw new ControlError("fault.requestBody: expected an object")
  for (const [path, expected] of Object.entries(value)) {
    if (path === "" || path.split(".").includes(""))
      throw new ControlError(`fault.requestBody: ${JSON.stringify(path)} is not a dotted path`)
    const scalar =
      expected === null ||
      typeof expected === "string" ||
      typeof expected === "boolean" ||
      (typeof expected === "number" && Number.isFinite(expected))
    if (!scalar)
      throw new ControlError(
        `fault.requestBody.${path}: expected a string, number, boolean or null`,
      )
  }
  return value as Record<string, RequestBodyValue>
}

const count = (value: unknown, label: string, min: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new ControlError(`${label}: expected an integer of at least ${min}`)
  return value
}

/** An instant, or a duration counted from `now`. A bare number is always an instant. */
const windowEdge = (value: unknown, label: string, now: number | undefined): number => {
  if (typeof value === "string" && /[a-z]\s*$/i.test(value) && !/[T:Z]/.test(value)) {
    const relative = parseDuration(value)
    if (relative !== undefined) {
      if (now === undefined) throw new ControlError(`${label}: a duration needs a clock`)
      return now + relative
    }
  }
  const instant = parseInstant(value)
  if (instant === undefined)
    throw new ControlError(`${label}: expected epoch ms, ISO-8601, or a duration like "5m"`)
  return instant
}

/** Whether a rule does anything at all when it fires. */
export const faultHasAction = (rule: Partial<FaultRule>): boolean =>
  rule.status !== undefined ||
  (rule.delayMs ?? 0) > 0 ||
  (rule.jitterMs ?? 0) > 0 ||
  rule.timeoutMs !== undefined ||
  rule.drop === true ||
  rule.truncate !== undefined ||
  rule.effect !== undefined

/**
 * Check a fault rule and put it in its stored form: durations in milliseconds
 * (`delayMs`, `jitterMs`, `timeoutMs`), windows as epoch ms. Throws {@link ControlError}.
 *
 * `strict` rejects unknown keys, so a typo in a request body is an error and not a rule
 * that silently never matches.
 */
export const normalizeFault = (
  input: unknown,
  context: { id?: string; namespace?: string; now?: number; strict?: boolean } = {},
): FaultRule => {
  if (!isRecord(input)) throw new ControlError("fault: expected an object")
  if (context.strict) {
    for (const key of Object.keys(input)) {
      if (!RULE_KEYS.has(key) && !LISTING_KEYS.has(key))
        throw new ControlError(`fault: unknown field ${JSON.stringify(key)}`)
    }
  }
  const id = input.id ?? context.id
  if (typeof id !== "string" || id === "") throw new ControlError("fault.id: expected a string")
  const rule: FaultRule = { id }
  for (const key of [
    "operationId",
    "method",
    "path",
    "pathPrefix",
    "effect",
    "fromPreset",
  ] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== "string") throw new ControlError(`fault.${key}: expected a string`)
    rule[key] = value
  }
  if (input.pathPattern !== undefined) {
    if (typeof input.pathPattern !== "string")
      throw new ControlError("fault.pathPattern: expected a string")
    try {
      new RegExp(input.pathPattern)
    } catch {
      throw new ControlError("fault.pathPattern: not a valid regular expression")
    }
    rule.pathPattern = input.pathPattern
  }
  if (input.requestHeaders !== undefined)
    rule.requestHeaders = Object.fromEntries(
      Object.entries(stringMap(input.requestHeaders, "fault.requestHeaders")).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    )
  if (input.query !== undefined) rule.query = stringMap(input.query, "fault.query")
  if (input.requestBody !== undefined) rule.requestBody = requestBodyMap(input.requestBody)
  const namespace = input.namespace ?? context.namespace
  if (namespace !== undefined) {
    // A rule for a namespace that cannot exist would be stored and never fire.
    if (typeof namespace !== "string" || (namespace !== GLOBAL && !KEY_PATTERN.test(namespace)))
      throw new ControlError(`fault.namespace: expected "*" or a key matching ${KEY_PATTERN}`)
    rule.namespace = namespace
  }
  if (input.after !== undefined) rule.after = count(input.after, "fault.after", 0)
  if (input.every !== undefined) rule.every = count(input.every, "fault.every", 1)
  if (input.count !== undefined) rule.count = count(input.count, "fault.count", 0)
  if (input.rate !== undefined) {
    if (typeof input.rate !== "number" || !(input.rate >= 0 && input.rate <= 1))
      throw new ControlError("fault.rate: expected a number from 0 to 1")
    rule.rate = input.rate
  }
  if (input.from !== undefined) rule.from = windowEdge(input.from, "fault.from", context.now)
  if (input.until !== undefined) rule.until = windowEdge(input.until, "fault.until", context.now)
  if (input.status !== undefined) {
    if (
      typeof input.status !== "number" ||
      !Number.isInteger(input.status) ||
      input.status < 200 ||
      input.status > 599
    )
      throw new ControlError("fault.status: expected an HTTP status from 200 to 599")
    rule.status = input.status
  }
  if (input.body !== undefined) rule.body = input.body
  if (input.headers !== undefined) rule.headers = stringMap(input.headers, "fault.headers")
  const delay = input.delay ?? input.delayMs ?? input.latencyMs
  if (delay !== undefined) rule.delayMs = durationMs(delay, "fault.delay")
  const jitter = input.jitter ?? input.jitterMs
  if (jitter !== undefined) rule.jitterMs = durationMs(jitter, "fault.jitter")
  const timeout = input.timeout ?? input.timeoutMs
  if (timeout !== undefined) rule.timeoutMs = durationMs(timeout, "fault.timeout")
  if (input.drop !== undefined) {
    if (typeof input.drop !== "boolean") throw new ControlError("fault.drop: expected a boolean")
    if (input.drop) rule.drop = true
  }
  if (input.truncate !== undefined) rule.truncate = count(input.truncate, "fault.truncate", 0)
  if (input.params !== undefined) {
    if (!isRecord(input.params)) throw new ControlError("fault.params: expected an object")
    rule.params = input.params
  }
  return rule
}

type Entry = {
  rule: FaultRule
  scope: string
  remaining: number | null
  hits: number
  seen: number
  pattern: RegExp | undefined
}

const scopeOf = (rule: FaultRule): string =>
  rule.namespace === undefined || rule.namespace === GLOBAL ? GLOBAL : rule.namespace

const matchesAll = (
  wanted: Record<string, string> | undefined,
  read: (name: string) => string | null | undefined,
): boolean => {
  if (!wanted) return true
  for (const [key, value] of Object.entries(wanted)) {
    const actual = read(key)
    if (actual === null || actual === undefined) return false
    if (value !== "*" && actual !== value) return false
  }
  return true
}

/** The value at a dotted path of a parsed JSON body; `undefined` when any step is missing. */
const field = (body: unknown, path: string): unknown => {
  let at = body
  for (const step of path.split(".")) {
    if (Array.isArray(at)) {
      if (!/^(0|[1-9]\d*)$/.test(step)) return undefined
      at = at[Number(step)]
    } else if (isRecord(at) && Object.hasOwn(at, step)) at = at[step]
    else return undefined
  }
  return at
}

/** Whether the parsed body has every field `wanted` names. Only a JSON object can. */
const bodyMatches = (wanted: Record<string, RequestBodyValue>, body: unknown): boolean => {
  if (!isRecord(body)) return false
  for (const [path, expected] of Object.entries(wanted)) {
    const actual = field(body, path)
    if (actual === undefined) return false
    if (expected !== "*" && actual !== expected) return false
  }
  return true
}

const matches = (entry: Entry, candidate: FaultCandidate, body: { value: unknown }): boolean => {
  const { rule } = entry
  if (entry.scope !== GLOBAL && entry.scope !== candidate.namespace) return false
  if (rule.operationId !== undefined && rule.operationId !== candidate.operationId) return false
  if (rule.method !== undefined && rule.method.toUpperCase() !== candidate.method.toUpperCase()) {
    return false
  }
  if (rule.path !== undefined && rule.path !== candidate.path) return false
  if (rule.pathPrefix !== undefined && !candidate.path.startsWith(rule.pathPrefix)) return false
  if (entry.pattern && !entry.pattern.test(candidate.path)) return false
  if (!matchesAll(rule.requestHeaders, (name) => candidate.headers?.get(name))) return false
  if (!matchesAll(rule.query, (name) => candidate.query?.get(name))) return false
  if (rule.requestBody && !bodyMatches(rule.requestBody, body.value)) return false
  if (rule.from !== undefined || rule.until !== undefined) {
    if (candidate.now === undefined) return false
    if (rule.from !== undefined && candidate.now < (rule.from as number)) return false
    if (rule.until !== undefined && candidate.now >= (rule.until as number)) return false
  }
  return true
}

/** The response a rule with a `status` answers with. */
export const faultResponse = (rule: FaultRule): Response => {
  const status = rule.status ?? 500
  const headers = { "content-type": "application/json", ...rule.headers }
  if (typeof rule.body === "string") return new Response(rule.body, { status, headers })
  if (rule.body === null) return new Response(null, { status, headers: rule.headers ?? {} })
  const body = rule.body === undefined ? { detail: "Injected by Mockingbird" } : rule.body
  return new Response(JSON.stringify(body), { status, headers })
}

const listing = (entry: Entry): FaultListing => ({
  ...entry.rule,
  remaining: entry.remaining,
  hits: entry.hits,
  seen: entry.seen,
})

/**
 * Rules are matched in the order they were added, so a narrow rule added first
 * wins over a later catch-all. `rate` and `jitter` draw from a seeded stream per namespace,
 * so a partial-failure run replays identically whatever other namespaces are doing.
 *
 * `random` is that stream: a function from namespace to stream, owned by the caller, which
 * the registry draws from and never seeds or rewinds. A single stream is accepted too, for a
 * registry used on its own: it serves `default`, and every other namespace gets a stream of
 * its own from the same seed.
 */
export const createFaultRegistry = (
  random: Rng | ((namespace: string) => Rng) = createRng(0),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): FaultRegistry => {
  const entries: Entry[] = []
  const counters = new Map<string, number>()
  const own = new Map<string, Rng>()
  const stream =
    typeof random === "function"
      ? random
      : (namespace: string): Rng => {
          if (namespace === "default") return random
          let found = own.get(namespace)
          if (!found) {
            found = createRng(random.seed)
            own.set(namespace, found)
          }
          return found
        }
  const toEntry = (input: FaultRule, previous?: Partial<Entry>): Entry => {
    const rule = normalizeFault(input)
    return {
      rule,
      scope: scopeOf(rule),
      remaining: previous?.remaining !== undefined ? previous.remaining : (rule.count ?? null),
      hits: previous?.hits ?? 0,
      seen: previous?.seen ?? 0,
      pattern: rule.pathPattern !== undefined ? new RegExp(rule.pathPattern) : undefined,
    }
  }
  const find = (id: string, namespace?: string): number => {
    if (namespace === undefined) return entries.findIndex((e) => e.rule.id === id)
    const mine = entries.findIndex((e) => e.rule.id === id && e.scope === namespace)
    return mine >= 0 ? mine : entries.findIndex((e) => e.rule.id === id && e.scope === GLOBAL)
  }
  const drop = (namespace: string): void => {
    for (let i = entries.length - 1; i >= 0; i--)
      if (entries[i]?.scope === namespace) entries.splice(i, 1)
  }
  return {
    snapshot(namespace) {
      const rules: FaultSnapshot["rules"] = []
      let globals = 0
      for (const entry of entries) {
        if (entry.scope === GLOBAL) globals++
        else if (entry.scope === namespace) rules.push({ ...listing(entry), position: globals })
      }
      return { rules: structuredClone(rules), nextId: counters.get(namespace) ?? 0 }
    },
    add(input) {
      const entry = toEntry(input)
      const existing = entries.findIndex(
        (e) => e.rule.id === entry.rule.id && e.scope === entry.scope,
      )
      if (existing >= 0) entries[existing] = entry
      else entries.push(entry)
      return entry.rule
    },
    nextId(namespace) {
      let next = counters.get(namespace) ?? 0
      let id: string
      do {
        next++
        id = `fault_${next}`
      } while (entries.some((e) => e.rule.id === id && e.scope === namespace))
      counters.set(namespace, next)
      return id
    },
    list: (namespace) =>
      entries
        .filter((e) => namespace === undefined || e.scope === namespace || e.scope === GLOBAL)
        .map(listing),
    get(id, namespace) {
      const entry = entries[find(id, namespace)]
      return entry ? listing(entry) : undefined
    },
    remove(id, namespace) {
      const index = find(id, namespace)
      if (index < 0) return false
      entries.splice(index, 1)
      return true
    },
    clear(namespace) {
      if (namespace === undefined) {
        entries.length = 0
        counters.clear()
        // A registry given one stream owns it, and starts it over with the rules.
        if (typeof random !== "function") random.reset()
        own.clear()
        return
      }
      drop(namespace)
      counters.delete(namespace)
    },
    restore(namespace, state) {
      drop(namespace)
      for (const { remaining, hits, seen, position, ...rule } of state.rules) {
        const entry = toEntry({ ...rule, namespace }, { remaining, hits, seen })
        // Back where it stood among the global rules: ahead of the one that followed it.
        let globals = 0
        let index = entries.length
        if (position !== undefined) {
          for (const [at, each] of entries.entries()) {
            if (each.scope !== GLOBAL) continue
            if (globals === position) {
              index = at
              break
            }
            globals++
          }
        }
        entries.splice(index, 0, entry)
      }
      counters.set(namespace, state.nextId ?? 0)
    },
    async take(candidate) {
      const hits: FaultHit[] = []
      const wait = candidate.wait ?? sleep
      const draw = stream(candidate.namespace)
      // Parsed once, and only if a rule that reaches the body gets this far.
      const body: { value: unknown } = { value: undefined }
      let read = false
      // A copy: a rule added while this request waits must not join it halfway.
      for (const entry of [...entries]) {
        if (entry.remaining === 0) continue
        if (entry.rule.requestBody && !read) {
          read = true
          body.value = await candidate.readJson?.().catch(() => undefined)
        }
        if (!matches(entry, candidate, body)) continue
        const { rule } = entry
        entry.seen++
        const position = entry.seen - (rule.after ?? 0)
        if (position <= 0) continue
        if (rule.every !== undefined && position % rule.every !== 0) continue
        // Draw even when the rule always fires, so a seeded stream stays aligned.
        if (draw.next() >= (rule.rate ?? 1)) continue
        entry.hits++
        if (entry.remaining !== null) entry.remaining--
        const hit = await act(rule, draw, wait)
        hits.push(hit)
        if (hit.drop || hit.response) break
      }
      return hits
    },
    async fire(rules, candidate) {
      const hits: FaultHit[] = []
      for (const rule of rules) {
        const hit = await act(rule, stream(candidate.namespace), candidate.wait ?? sleep)
        hits.push(hit)
        if (hit.drop || hit.response) break
      }
      return hits
    },
  }
}

/** Do what a rule that fired says: wait, then answer, drop, or let the request through. */
const act = async (
  rule: FaultRule,
  draw: Rng,
  wait: (ms: number) => Promise<void>,
): Promise<FaultHit> => {
  const jitter = (rule.jitterMs ?? 0) > 0 ? draw.int(0, Math.floor(rule.jitterMs ?? 0)) : 0
  const delay = (rule.delayMs ?? 0) + jitter
  if (delay > 0) await wait(delay)
  const hit: FaultHit = { id: rule.id }
  if (rule.effect !== undefined) hit.effect = { name: rule.effect, params: rule.params ?? {} }
  if (rule.truncate !== undefined) hit.truncate = rule.truncate
  if (rule.timeoutMs !== undefined) {
    if (rule.timeoutMs > 0) await wait(rule.timeoutMs)
    hit.drop = true
    hit.timeout = true
  } else if (rule.drop === true) hit.drop = true
  else if (rule.status !== undefined) hit.response = faultResponse(rule)
  return hit
}
