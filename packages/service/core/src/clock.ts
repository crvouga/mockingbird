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
  /** Milliseconds a running clock adds to its underlying source. `0` while frozen. */
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
    // A frozen clock does not follow its source, so it has no offset to report.
    state: () => ({
      now: now(),
      frozen: frozenAt !== undefined,
      offsetMs: frozenAt !== undefined ? 0 : offsetMs,
    }),
  }
}

/** A clock over a base clock, which can tell its own freeze from the base's. */
export type DerivedClock = Clock & {
  /** True while this clock itself is frozen, and so no longer follows the base. */
  pinned(): boolean
  /** Put the clock at an instant: pinned there, or following the base from there. */
  place(state: { now: number; pinned: boolean }): void
}

/**
 * A clock that follows `base` — its time, its freezes, its jumps — plus an offset and a
 * freeze of its own. Moving it never moves `base`, so a namespace can travel in time alone.
 * It reports `frozen` while either clock is, and no offset while it stands still. `moved` is
 * called after anything moves it, for whatever keeps a schedule by this clock.
 */
export const deriveClock = (base: Clock, moved: () => void = () => {}): DerivedClock => {
  const own = createClock(() => base.now())
  /** Tell whoever is driven by this clock that its time is no longer what it was. */
  const moving =
    <A extends unknown[]>(change: (...args: A) => void) =>
    (...args: A): void => {
      change(...args)
      moved()
    }
  return {
    ...own,
    set: moving(own.set),
    advance: moving(own.advance),
    reset: moving(own.reset),
    state: () => {
      const state = own.state()
      const frozen = state.frozen || base.state().frozen
      return { now: state.now, frozen, offsetMs: frozen ? 0 : state.offsetMs }
    },
    pinned: () => own.state().frozen,
    place: moving(({ now, pinned }) => {
      own.reset()
      // Frozen first, so the instant is set exactly instead of read back from the base.
      if (pinned) own.freeze()
      own.set(now)
    }),
  }
}

/**
 * Put a clock at an instant, frozen or running. Frozen first, so the instant is set exactly:
 * setting a live clock and freezing it afterwards reads the source again and can land a tick late.
 */
export const restoreClock = (clock: Clock, state: { now: number; frozen: boolean }): void => {
  clock.freeze()
  clock.set(state.now)
  if (!state.frozen) clock.unfreeze()
}
