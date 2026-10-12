import type { LatencyRule, LatencyState } from "./controls.js"
import type { Rng } from "./rng.js"

/**
 * Baseline response time, per namespace: how long every vendor request takes before any
 * fault is considered. Jitter draws from a stream the caller owns, one per namespace and
 * separate from the fault stream, so adding latency never shifts which requests a `rate`
 * fault hits.
 */
export type LatencyRegistry = {
  get(namespace: string): LatencyState
  set(namespace: string, state: LatencyState): LatencyState
  /** Remove one namespace's latency, or every namespace's. */
  clear(namespace?: string): void
  /** Milliseconds this request waits. Draws jitter, so call it once per request. */
  take(namespace: string, operationId: string | undefined): number
}

const NONE: LatencyState = Object.freeze({ delayMs: 0, jitterMs: 0, operations: {} })

const copy = (state: LatencyState): LatencyState => ({
  delayMs: state.delayMs,
  jitterMs: state.jitterMs,
  operations: Object.fromEntries(
    Object.entries(state.operations).map(([id, rule]) => [id, { ...rule }]),
  ),
})

/** `random` is the namespace's jitter stream. The registry never seeds or rewinds it. */
export const createLatencyRegistry = (random: (namespace: string) => Rng): LatencyRegistry => {
  const states = new Map<string, LatencyState>()
  return {
    get: (namespace) => copy(states.get(namespace) ?? NONE),
    set(namespace, state) {
      states.set(namespace, copy(state))
      return copy(state)
    },
    clear(namespace) {
      if (namespace === undefined) states.clear()
      else states.delete(namespace)
    },
    take(namespace, operationId) {
      const state = states.get(namespace)
      if (!state) return 0
      const rule: LatencyRule =
        (operationId !== undefined ? state.operations[operationId] : undefined) ?? state
      // Whole milliseconds, inclusive of both ends, so a jitter of 1 can still be 0 or 1.
      const jitter = rule.jitterMs > 0 ? random(namespace).int(0, Math.floor(rule.jitterMs)) : 0
      return rule.delayMs + jitter
    },
  }
}
