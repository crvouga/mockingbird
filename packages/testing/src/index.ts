import type fc from "fast-check"

/** Env-var names honoured by every Mockingbird property suite. */
export const FC_SEED = "FC_SEED"
export const FC_NUM_RUNS = "FC_NUM_RUNS"

const integer = (raw: string | undefined) => {
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`expected an integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Build fast-check `Parameters` from an environment record.
 * Pass `process.env` (or `Deno.env.toObject()`) — the function itself touches no globals.
 */
export const fcParameters = (
  env: Record<string, string | undefined>,
): Pick<fc.Parameters<unknown>, "seed" | "numRuns"> => {
  const seed = integer(env[FC_SEED])
  const numRuns = integer(env[FC_NUM_RUNS])
  return {
    ...(seed === undefined ? {} : { seed }),
    ...(numRuns === undefined ? {} : { numRuns }),
  }
}
