import type { ExpectedResult, LabTestRecord } from "./catalog.js"
import type { GetCacheEntry } from "./state.js"

/**
 * Version of the sealed-corpus on-disk format. Bumped whenever the shape changes so a
 * stale recording is rejected instead of half-applied.
 *
 * - 1: observations, catalog and lab accounts.
 * - 2: adds `teamId`, the recording team, so lab-account allowlists load verbatim.
 */
export const SEALED_CORPUS_VERSION = 2

/** Versions `parseSealedCorpus` still loads. A version-1 corpus behaves as it did in 0.2.0. */
export const SUPPORTED_SEALED_CORPUS_VERSIONS: readonly number[] = [1, 2]

/**
 * Exact sandbox recording of the provider-owned reads a drop-in consumer depends on:
 * parameter-stable GET observations (area/PSC inventory), the lab catalog, team labs, and
 * lab accounts. Availability is intentionally absent — its slot dates and single-use
 * `booking_key`s can never match a live cache key, so it stays with the generator.
 */
export type SealedCorpus = {
  version: 1 | typeof SEALED_CORPUS_VERSION
  recordedAt: string
  source: string
  /**
   * The recording team's id (version 2+). When present it is the mock's default team,
   * and each lab account's `team_id_allowlist` is kept exactly as recorded.
   */
  teamId?: string
  /** SHA-256 of the recording's content, written by `corpus pull`. Identifies it in logs. */
  fingerprint?: string
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
  if (!SUPPORTED_SEALED_CORPUS_VERSIONS.includes(record.version as number)) {
    throw new Error(`unsupported sealed corpus version: ${String(record.version)}`)
  }
  if (record.teamId !== undefined && typeof record.teamId !== "string") {
    throw new Error("sealed corpus teamId must be a string")
  }
  return record as unknown as SealedCorpus
}
