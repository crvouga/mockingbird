import type { ExpectedResult, LabTestRecord } from "./catalog.js"
import type { GetCacheEntry } from "./state.js"

/**
 * Version of the sealed-corpus on-disk format. Bumped whenever the shape changes so a
 * stale recording is rejected instead of half-applied.
 */
export const SEALED_CORPUS_VERSION = 1

/**
 * Exact sandbox recording of the provider-owned reads a drop-in consumer depends on:
 * parameter-stable GET observations (area/PSC inventory), the lab catalog, team labs, and
 * lab accounts. Availability is intentionally absent — its slot dates and single-use
 * `booking_key`s can never match a live cache key, so it stays with the generator.
 */
export type SealedCorpus = {
  version: typeof SEALED_CORPUS_VERSION
  recordedAt: string
  source: string
  observations: Record<string, GetCacheEntry>
  catalog: {
    labTests: LabTestRecord[]
    labs: Record<string, unknown>[]
    expectedResults: Record<string, ExpectedResult[]>
  }
  labAccounts: Record<string, unknown>[]
}

/** Throws on a non-object or an unrecognized `version`. */
export const parseSealedCorpus = (value: unknown): SealedCorpus => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("sealed corpus must be an object")
  }
  const record = value as Record<string, unknown>
  if (record.version !== SEALED_CORPUS_VERSION) {
    throw new Error(`unsupported sealed corpus version: ${String(record.version)}`)
  }
  return record as unknown as SealedCorpus
}
