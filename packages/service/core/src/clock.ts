/**
 * The single source of time for a service.
 *
 * Every timestamp a mock writes reads from here, so a suite moves time instead of
 * sleeping: appointment windows, result delays and expiries become reachable in
 * milliseconds. A frozen clock also makes timestamps reproducible from a seed.
 */
export type ClockState = {
  /** Current epoch milliseconds. */
  now: number
  /** True while time does not advance on its own. */
  frozen: boolean
  /** Milliseconds this clock adds to its underlying source. */
  offsetMs: number
}

export type Clock = {
  now(): number
  /** Pin the clock to an exact instant, keeping it frozen if it already was. */
  set(epochMs: number): void
  /** Move the clock forward, or back with a negative delta. */
  advance(deltaMs: number): void
  /** Stop time at the current instant. */
  freeze(): void
  /** Resume from the current instant. */
  unfreeze(): void
  /** Drop back to the underlying source, live. */
  reset(): void
  state(): ClockState
}

/** A {@link Clock} over `source` (default `Date.now`), live and unfrozen. */
export const createClock = (source: () => number = Date.now): Clock => {
  let offsetMs = 0
  let frozenAt: number | undefined
  const now = () => frozenAt ?? source() + offsetMs
  return {
    now,
    set: (epochMs) => {
      if (frozenAt !== undefined) frozenAt = epochMs
      else offsetMs = epochMs - source()
    },
    advance: (deltaMs) => {
      if (frozenAt !== undefined) frozenAt += deltaMs
      else offsetMs += deltaMs
    },
    freeze: () => {
      frozenAt = now()
    },
    unfreeze: () => {
      if (frozenAt === undefined) return
      offsetMs = frozenAt - source()
      frozenAt = undefined
    },
    reset: () => {
      offsetMs = 0
      frozenAt = undefined
    },
    state: () => ({ now: now(), frozen: frozenAt !== undefined, offsetMs }),
  }
}
