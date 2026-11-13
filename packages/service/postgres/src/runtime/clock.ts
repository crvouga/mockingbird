/** Fixed reference instant used when callers do not supply a clock (`2000-01-01T00:00:00.000Z`). */
export const DEFAULT_NOW = new Date("2000-01-01T00:00:00.000Z");

/** Function that returns the current instant for `now()` and related builtins. */
export type Clock = () => Date;

/**
 * Optional extras a {@link Clock} may carry: a microsecond reading (`clock_timestamp()` has
 * microsecond precision in PostgreSQL) and whether it follows real wall time (so `pg_sleep` sleeps).
 */
interface ClockExtras {
  /** Unix epoch microseconds. */
  micros?: () => bigint;
  /** True when the clock is the real wall clock. */
  wall?: () => boolean;
}

/**
 * Clock that always returns a copy of `instant` (default {@link DEFAULT_NOW}).
 *
 * @throws {RangeError} If `instant` is an invalid `Date`.
 */
export function fixedClock(instant: Date = DEFAULT_NOW): Clock {
  const ms = instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError("invalid clock instant");
  return () => new Date(ms);
}

let lastSystemMicros = 0n;

/** Wall-clock unix microseconds: `Date.now()` refined by the monotonic `performance.now()`. */
function systemMicros(): bigint {
  const perf = globalThis.performance;
  const ms = perf && Number.isFinite(perf.timeOrigin) ? perf.timeOrigin + perf.now() : Date.now();
  let micros = BigInt(Math.floor(ms * 1000));
  // never earlier than Date.now() (what `new Date()` reports) and never backwards
  const floor = BigInt(Date.now()) * 1000n;
  if (micros < floor) micros = floor;
  if (micros < lastSystemMicros) micros = lastSystemMicros;
  lastSystemMicros = micros;
  return micros;
}

/** Wall-clock `now()` matching PostgreSQL (`new Date()` each call, microseconds via {@link clockMicros}). */
export function systemClock(): Clock {
  return Object.assign(() => new Date(Number(systemMicros() / 1000n)), {
    micros: systemMicros,
    wall: () => true,
  });
}

/** Unix epoch microseconds of `clock`'s current reading. */
export function clockMicros(clock: Clock): bigint {
  const micros = (clock as Clock & ClockExtras).micros;
  if (micros) return micros();
  return BigInt(Math.round(clock().getTime())) * 1000n;
}

/** Whether `clock` follows real wall time (`{ now: "system" }`), so a sleep must really wait. */
export function isWallClock(clock: Clock): boolean {
  return (clock as Clock & ClockExtras).wall?.() ?? false;
}

/** A clock that reads whatever clock `current()` returns at each call, keeping its extras. */
export function delegatingClock(current: () => Clock): Clock {
  return Object.assign(() => current()(), {
    micros: () => clockMicros(current()),
    wall: () => isWallClock(current()),
  });
}

/** Normalize a `Date`, {@link Clock}, `"system"`, or `undefined` into a {@link Clock}. */
export function resolveClock(now?: Date | Clock | "system"): Clock {
  if (now === undefined) return fixedClock(DEFAULT_NOW);
  if (now === "system") return systemClock();
  if (typeof now === "function") {
    return Object.assign(() => new Date(now().getTime()), {
      micros: () => clockMicros(now),
      wall: () => isWallClock(now),
    });
  }
  return fixedClock(now);
}
