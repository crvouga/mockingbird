import { createRng, type Rng } from "./rng.js"

/**
 * A deliberate failure injected in front of an operation.
 *
 * This is how a suite reaches the vendor's failure modes without the vendor: the
 * quota error that only appears when a shared sandbox is full, the 429 that only
 * appears under load, the 5xx that proves a retry path works.
 */
export type FaultRule = {
  /** Stable id, so a suite can retire exactly the rule it added. */
  id: string
  /** Fault only this operation. Omit to match every operation. */
  operationId?: string
  /** Fault only this HTTP method, case-insensitive. Omit to match every method. */
  method?: string
  /** Fault only paths starting with this prefix. Omit to match every path. */
  pathPrefix?: string
  /**
   * Fault only this namespace. Omit (or `"*"`) to fault every namespace — which is what
   * an in-process caller usually wants, and what a parallel worker usually does not:
   * rules added through `POST /__admin/faults` default to the calling namespace.
   */
  namespace?: string
  /**
   * Status of the injected response. Omit for a rule that only delays (`delayMs` /
   * `latencyMs`), only drops the connection (`drop`), or only switches on an `effect`:
   * the request then still reaches the service.
   */
  status?: number
  /** Response body, serialized as JSON. A string is sent as-is. */
  body?: unknown
  headers?: Record<string, string>
  /** Retire the rule after this many faults. Omit to keep it until removed. */
  count?: number
  /** Fault this fraction of matching requests, `0`–`1`. Default `1`. */
  rate?: number
  /** Hold the response back this long, to exercise timeouts. */
  delayMs?: number
  /** Alias of `delayMs`. */
  latencyMs?: number
  /**
   * Drop the connection instead of answering: an in-process `fetch` rejects with a
   * `TypeError`, and a served mock destroys the socket. Models "unknown outcome" failures.
   */
  drop?: boolean
  /**
   * A named service behaviour to switch on for the matching request instead of (or
   * before) a canned response, e.g. `created_but_500` or `numeric_tracking_id`. Services
   * read it with `faultEffects(request)`.
   */
  effect?: string
  /** Parameters for `effect`. */
  params?: Record<string, unknown>
  /** From the preset this rule was expanded from, if any. */
  preset?: string
}

/** A fault that fired for one request. */
export type FaultHit = {
  id: string
  /** The injected response; absent when the rule only delays, drops, or sets an effect. */
  response?: Response
  drop?: boolean
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

/** What a request looks like to the fault matcher. */
export type FaultCandidate = {
  operationId: string | undefined
  method: string
  path: string
  namespace: string
}

export type FaultRegistry = {
  add(rule: FaultRule): FaultRule
  list(): (FaultRule & { remaining: number | null; hits: number })[]
  remove(id: string): boolean
  clear(): void
  /**
   * Every fault this request should get, in rule order, stopping at the first that answers
   * or drops (effect-only and delay-only rules let later rules match too). Consumes one of
   * each matching rule's remaining uses.
   */
  take(candidate: FaultCandidate): Promise<FaultHit[]>
}

type Entry = { rule: FaultRule; remaining: number | null; hits: number }

const matches = (rule: FaultRule, candidate: FaultCandidate): boolean => {
  if (
    rule.namespace !== undefined &&
    rule.namespace !== "*" &&
    rule.namespace !== candidate.namespace
  ) {
    return false
  }
  if (rule.operationId !== undefined && rule.operationId !== candidate.operationId) return false
  if (rule.method !== undefined && rule.method.toUpperCase() !== candidate.method.toUpperCase()) {
    return false
  }
  if (rule.pathPrefix !== undefined && !candidate.path.startsWith(rule.pathPrefix)) return false
  return true
}

const faultResponse = (rule: FaultRule): Response => {
  const status = rule.status ?? 500
  const headers = { "content-type": "application/json", ...rule.headers }
  if (typeof rule.body === "string") return new Response(rule.body, { status, headers })
  if (rule.body === null) return new Response(null, { status, headers: rule.headers ?? {} })
  const body = rule.body === undefined ? { detail: "Injected by Mockingbird" } : rule.body
  return new Response(JSON.stringify(body), { status, headers })
}

/**
 * Rules are matched in the order they were added, so a narrow rule added first
 * wins over a later catch-all. `rate` draws from `rng`, which is seeded, so a
 * partial-failure run replays identically.
 */
export const createFaultRegistry = (rng: Rng = createRng(0)): FaultRegistry => {
  const entries: Entry[] = []
  return {
    add(rule) {
      const existing = entries.findIndex((e) => e.rule.id === rule.id)
      const entry: Entry = { rule, remaining: rule.count ?? null, hits: 0 }
      if (existing >= 0) entries[existing] = entry
      else entries.push(entry)
      return rule
    },
    list: () => entries.map((e) => ({ ...e.rule, remaining: e.remaining, hits: e.hits })),
    remove(id) {
      const index = entries.findIndex((e) => e.rule.id === id)
      if (index < 0) return false
      entries.splice(index, 1)
      return true
    },
    clear() {
      entries.length = 0
    },
    async take(candidate) {
      const hits: FaultHit[] = []
      for (const entry of entries) {
        if (entry.remaining === 0) continue
        if (!matches(entry.rule, candidate)) continue
        const rate = entry.rule.rate ?? 1
        // Draw even when the rule always fires, so a seeded stream stays aligned.
        if (rng.next() >= rate) continue
        entry.hits++
        if (entry.remaining !== null) entry.remaining--
        const delay = entry.rule.delayMs ?? entry.rule.latencyMs
        if (delay !== undefined && delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
        const hit: FaultHit = { id: entry.rule.id }
        if (entry.rule.effect !== undefined) {
          hit.effect = { name: entry.rule.effect, params: entry.rule.params ?? {} }
        }
        if (entry.rule.drop === true) hit.drop = true
        else if (entry.rule.status !== undefined) hit.response = faultResponse(entry.rule)
        hits.push(hit)
        if (hit.drop || hit.response) break
      }
      return hits
    },
  }
}
