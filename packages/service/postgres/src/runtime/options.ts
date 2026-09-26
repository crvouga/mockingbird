import type { Clock } from "./clock.ts";

/** Entropy source for `random()` / `gen_random_uuid()`. Default is seeded xorshift64*. */
export type RandomMode = "deterministic" | "os";

/** How `int8` columns surface in query row objects. Default `"bigint"`. */
export type Int8Mode = "bigint" | "number" | "string";

/** Options for {@link Database} construction. All fields are optional. */
export interface DatabaseOptions {
  /**
   * Seed for deterministic `random()` (and any other PRNG-backed builtins).
   * Defaults to {@link DEFAULT_DATABASE_SEED} (`1`). Ignored when {@link random} is `"os"`.
   */
  seed?: number | bigint;
  /**
   * Entropy for `random()` / `gen_random_uuid()`.
   * `"deterministic"` (default) uses {@link seed}. `"os"` uses CSPRNG like PostgreSQL
   * (not rolled back with transactions; not restored from snapshots).
   */
  random?: RandomMode;
  /**
   * Clock for `now()` / `current_timestamp` / etc.
   * Defaults to a fixed instant (`2000-01-01T00:00:00.000Z`).
   * Pass a `Date`, `() => Date`, or `"system"` for wall-clock `now()` like PostgreSQL.
   */
  now?: Date | Clock | "system";
  /**
   * How `int8` / `bigint` columns surface in query row objects.
   * Default `"bigint"` matches PostgreSQL's JS-unsafe 64-bit integers.
   * `"number"` uses IEEE number (unsafe beyond `Number.MAX_SAFE_INTEGER`).
   * `"string"` is JSON-safe.
   */
  int8?: Int8Mode;
}

/** Default {@link DatabaseOptions.seed} when constructing a {@link Database}. */
export const DEFAULT_DATABASE_SEED = 1;
