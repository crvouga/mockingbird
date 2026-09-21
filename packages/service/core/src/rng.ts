/**
 * Seeded pseudo-random numbers, so anything a mock invents — ids, jitter, which
 * request a percentage fault hits — is reproducible from a seed.
 *
 * mulberry32: small, fast, and stable across runtimes, which matters more here
 * than statistical quality.
 */
export type Rng = {
  /** Next value in `[0, 1)`. */
  next(): number
  /** Next integer in `[min, max]`. */
  int(min: number, max: number): number
  /** Restart the stream from its seed. */
  reset(): void
  seed: number
}

/** Hash an arbitrary string into a 32-bit seed, so callers can seed by name. */
export const seedFrom = (value: string): number => {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export const createRng = (seed: number | string = 0): Rng => {
  const numeric = typeof seed === "string" ? seedFrom(seed) : seed >>> 0
  let state = numeric
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    reset: () => {
      state = numeric
    },
    seed: numeric,
  }
}
