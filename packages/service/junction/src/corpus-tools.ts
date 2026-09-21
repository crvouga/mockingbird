import { COVERAGE_ZIPS } from "./coverage-corpus.js"
import { type PrefetchTarget, recordObservation, recordSandboxCorpus } from "./prefetch.js"
import { SEALED_CORPUS_VERSION, type SealedCorpus } from "./sealed-corpus.js"
import { expectedFromMarkersResponse, mapLabTest, type SeedSource } from "./seed-from.js"
import type { ExpectedResult, GetCacheEntry, LabTestRecord } from "./state.js"

export const DEFAULT_JUNCTION_BASE_URL = "https://api.sandbox.tryvital.io"

export { isSandboxKey, SANDBOX_KEY_PREFIXES } from "./limits.js"

export type PullCorpusOptions = {
  apiKey: string
  baseUrl?: string
  /** ZIPs to record area and PSC coverage for. Default: the shipped coverage set. */
  zips?: readonly string[]
  /**
   * Refresh only `zips` on top of this corpus, keeping everything else. How a single
   * ZIP is added to a committed corpus without re-recording the whole thing.
   */
  base?: SealedCorpus
  /** Skip the team's catalog and lab accounts (coverage only). */
  coverageOnly?: boolean
  fetch?: (request: Request) => Promise<Response>
  /** Pause between vendor calls, to stay under rate limits. Default 50 ms. */
  minIntervalMs?: number
  onProgress?: (message: string) => void
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** `GET /v3/lab_test/lab_account` answers `{ data: [...] }`; older recordings saved a bare array. */
const listOf = (body: unknown): Record<string, unknown>[] => {
  const items = Array.isArray(body) ? body : asRecord(body)?.data
  return Array.isArray(items)
    ? items.map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry)
    : []
}

/** JSON with object keys sorted, so equal content always serializes identically. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) => {
    const record = asRecord(inner)
    if (!record) return inner
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    )
  })

/** SHA-256 over a corpus's content — not its recording time — so a re-pull of unchanged data matches. */
export const fingerprintCorpus = async (corpus: SealedCorpus): Promise<string> => {
  const content = canonicalJson({
    observations: corpus.observations,
    catalog: corpus.catalog,
    labAccounts: corpus.labAccounts,
    // Absent from version-1 corpora, whose fingerprints stay what they were.
    ...(corpus.teamId !== undefined ? { teamId: corpus.teamId } : {}),
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The calling team's id, read without writing anything: a listed user's `team_id`, else
 * the one team every non-empty lab-account allowlist names. `undefined` when neither
 * says (a team with no users and no linked accounts).
 */
export const readTeamId = async (
  real: PrefetchTarget,
  labAccounts: readonly Record<string, unknown>[],
): Promise<string | undefined> => {
  const headers = { ...(await real.headers()), accept: "application/json" }
  const response = await real
    .fetch(new Request(`${real.baseUrl}/v2/user?offset=0&limit=1`, { headers }))
    .catch(() => undefined)
  if (response?.ok) {
    const body = asRecord(await response.json().catch(() => undefined))
    const first = Array.isArray(body?.users) ? asRecord(body.users[0]) : undefined
    if (typeof first?.team_id === "string" && UUID.test(first.team_id)) return first.team_id
  }
  const named = new Set<string>()
  for (const account of labAccounts) {
    const allowlist = account.team_id_allowlist
    if (!Array.isArray(allowlist) || allowlist.length === 0) continue
    const ids = allowlist.filter((id): id is string => typeof id === "string")
    if (named.size === 0) for (const id of ids) named.add(id)
    else for (const id of [...named]) if (!ids.includes(id)) named.delete(id)
  }
  return named.size === 1 ? [...named][0] : undefined
}

/** Record a sealed corpus from a real Junction team. Read-only: it only issues GETs. */
export const pullCorpus = async (options: PullCorpusOptions): Promise<SealedCorpus> => {
  const baseUrl = (options.baseUrl ?? DEFAULT_JUNCTION_BASE_URL).replace(/\/$/, "")
  const send = options.fetch ?? ((request: Request) => fetch(request))
  const headers = { "x-vital-api-key": options.apiKey }
  const gap = options.minIntervalMs ?? 50
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const progress = options.onProgress ?? (() => {})
  const real: PrefetchTarget = { baseUrl, fetch: send, headers: () => headers }
  const source: SeedSource = { baseUrl, fetch: send, headers }
  const getCache = new Map<string, GetCacheEntry>()

  const zips = options.zips ?? (options.base ? [] : COVERAGE_ZIPS)
  if (zips.length > 0) {
    progress(`recording area + PSC coverage for ${zips.length} ZIP(s)`)
    const { labIds } = await recordSandboxCorpus({ real, getCache, zips, minIntervalMs: gap })
    progress(`coverage recorded across ${labIds.length} PSC lab(s)`)
  }

  let catalog = options.base?.catalog ?? { labTests: [], labs: [], expectedResults: {} }
  let labAccounts = options.base?.labAccounts ?? []
  if (!options.coverageOnly) {
    progress("recording lab-test catalog")
    const labTests: LabTestRecord[] = []
    let cursor: string | null = null
    for (;;) {
      const path =
        cursor === null ? "/v3/lab_test" : `/v3/lab_test?next_cursor=${encodeURIComponent(cursor)}`
      const body = asRecord(await recordObservation(real, "GET", path, getCache))
      for (const entry of Array.isArray(body?.data) ? body.data : []) {
        const test = mapLabTest(entry)
        if (test) labTests.push(test)
      }
      cursor = typeof body?.next_cursor === "string" ? body.next_cursor : null
      if (cursor === null) break
      await sleep(gap)
    }
    const labs = listOf(await recordObservation(real, "GET", "/v3/lab_tests/labs", getCache))
    const expectedResults: Record<string, ExpectedResult[]> = {}
    for (const test of labTests) {
      await recordObservation(real, "GET", `/v3/lab_tests/${test.id}/markers`, getCache)
      expectedResults[test.id] = await expectedFromMarkersResponse(source, test)
      await sleep(gap)
    }
    catalog = { labTests, labs, expectedResults }
    progress(`catalog: ${labTests.length} lab test(s), ${labs.length} lab(s)`)
    labAccounts = listOf(await recordObservation(real, "GET", "/v3/lab_test/lab_account", getCache))
    progress(`lab accounts: ${labAccounts.length}`)
  }

  const observations = Object.fromEntries(
    [...Object.entries(options.base?.observations ?? {}), ...getCache.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  )
  const teamId = (await readTeamId(real, labAccounts)) ?? options.base?.teamId
  const corpus: SealedCorpus = {
    version: SEALED_CORPUS_VERSION,
    recordedAt: new Date().toISOString(),
    source: baseUrl,
    ...(teamId !== undefined ? { teamId } : {}),
    observations,
    catalog,
    labAccounts,
  }
  corpus.fingerprint = await fingerprintCorpus(corpus)
  return corpus
}

export type SetDiff = { added: string[]; removed: string[]; changed: string[] }

export type CorpusDiff = {
  identical: boolean
  /** Set when the recorded team differs (or one side recorded none). */
  teamId?: { before: string | null; after: string | null }
  observations: SetDiff
  labTests: SetDiff
  labAccounts: SetDiff
  zips: { added: string[]; removed: string[] }
}

const diffById = <T>(before: Iterable<[string, T]>, after: Iterable<[string, T]>): SetDiff => {
  const a = new Map(before)
  const b = new Map(after)
  const sorted = (values: string[]) => values.sort()
  return {
    added: sorted([...b.keys()].filter((key) => !a.has(key))),
    removed: sorted([...a.keys()].filter((key) => !b.has(key))),
    changed: sorted(
      [...b.keys()].filter(
        (key) => a.has(key) && canonicalJson(a.get(key)) !== canonicalJson(b.get(key)),
      ),
    ),
  }
}

const zipsOf = (corpus: SealedCorpus): Set<string> =>
  new Set(
    Object.keys(corpus.observations).flatMap((key) => {
      const zip = /\/v3\/order\/(?:area|psc)\/info\?.*zip_code=(\d{5})/.exec(key)?.[1]
      return zip ? [zip] : []
    }),
  )

/** What changed between two recordings: coverage, catalog, accounts and raw observations. */
export const diffCorpus = (before: SealedCorpus, after: SealedCorpus): CorpusDiff => {
  const observations = diffById(
    Object.entries(before.observations),
    Object.entries(after.observations),
  )
  const labTests = diffById(
    before.catalog.labTests.map((test) => [test.id, test] as [string, unknown]),
    after.catalog.labTests.map((test) => [test.id, test] as [string, unknown]),
  )
  const accountEntries = (corpus: SealedCorpus) =>
    corpus.labAccounts.map((account) => [String(account.id), account] as [string, unknown])
  const labAccounts = diffById(accountEntries(before), accountEntries(after))
  const beforeZips = zipsOf(before)
  const afterZips = zipsOf(after)
  const zips = {
    added: [...afterZips].filter((zip) => !beforeZips.has(zip)).sort(),
    removed: [...beforeZips].filter((zip) => !afterZips.has(zip)).sort(),
  }
  const empty = (d: SetDiff) => d.added.length + d.removed.length + d.changed.length === 0
  const teamChanged = (before.teamId ?? null) !== (after.teamId ?? null)
  return {
    identical: empty(observations) && empty(labTests) && empty(labAccounts) && !teamChanged,
    ...(teamChanged
      ? { teamId: { before: before.teamId ?? null, after: after.teamId ?? null } }
      : {}),
    observations,
    labTests,
    labAccounts,
    zips,
  }
}
