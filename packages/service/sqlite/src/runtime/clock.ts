/** Fixed reference instant used when callers do not supply a clock (`2000-01-01T00:00:00.000Z`). */
export const DEFAULT_NOW = new Date("2000-01-01T00:00:00.000Z");

/** Function that returns the current instant for `date('now')` and related builtins. */
export type Clock = () => Date;

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

/** Wall-clock `'now'` matching SQLite (`new Date()` each call). */
export function systemClock(): Clock {
  return () => new Date();
}

/** Normalize a `Date`, {@link Clock}, `"system"`, or `undefined` into a {@link Clock}. */
export function resolveClock(now?: Date | Clock | "system"): Clock {
  if (now === undefined) return fixedClock(DEFAULT_NOW);
  if (now === "system") return systemClock();
  if (typeof now === "function") return () => new Date(now().getTime());
  return fixedClock(now);
}
