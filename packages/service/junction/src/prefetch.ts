import type { SeedCacheEntry } from "@crvouga/mockingbird-parity"
import {
  availabilityAddressForZip,
  COVERAGE_ZIPS,
  PHLEBOTOMY_AVAILABILITY_ZIPS,
  PSC_AVAILABILITY_ZIPS,
  PSC_LAB_IDS,
} from "./coverage-corpus.js"
import { AVAILABILITY_START_DATE } from "./reshape.js"
import { observationCacheKey } from "./state.js"

export type PrefetchTarget = {
  baseUrl: string
  fetch: (request: Request) => Promise<Response>
  headers: () => Promise<Record<string, string>> | Record<string, string>
}

export const recordObservation = async (
  target: PrefetchTarget,
  method: string,
  pathAndQuery: string,
  getCache: Map<string, SeedCacheEntry>,
  body?: unknown,
): Promise<unknown> => {
  const headers: Record<string, string> = {
    ...(await target.headers()),
    accept: "application/json",
  }
  if (body !== undefined) headers["content-type"] = "application/json"
  const url = `${target.baseUrl}${pathAndQuery}`
  const response = await target.fetch(
    new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text === "" ? undefined : (JSON.parse(text) as unknown)
  } catch {
    parsed = text
  }
  const headerRecord: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headerRecord[name.toLowerCase()] = value
  })
  const cacheKey = observationCacheKey(url, method, body)
  // Seal-once: a walk-local warmup seal for this request is authoritative — prefetch
  // must not clobber it, because the oracle rotates booking_key per serve and only the
  // sealed observation's keys were paired into the walk's resource table.
  if (getCache.has(cacheKey)) return getCache.get(cacheKey)?.body
  getCache.set(cacheKey, {
    status: response.status,
    headers: headerRecord,
    body: parsed,
  })
  return parsed
}

/**
 * Seal coverage-corpus routing ZIPs + availability POSTs into the seed observation cache.
 * Call after warmup, before `seedFrom`, so compare walks can forceInclude geo/scheduling reads.
 */
export const prefetchCoverageObservations = async (args: {
  real: PrefetchTarget
  getCache: Map<string, SeedCacheEntry>
  zips?: readonly string[]
  /** ZIPs that also get PSC availability POST seals. Defaults to scheduling corpus. */
  schedulingZips?: readonly string[]
  /** ZIPs for phlebotomy availability (narrow served set). Defaults to PHLEBOTOMY_ZIPS. */
  phlebotomyZips?: readonly string[]
  labIds?: readonly number[]
  /** Also prefetch phlebotomy + PSC availability. Default true. */
  includeAvailability?: boolean
  sleep?: (ms: number) => Promise<void>
  minIntervalMs?: number
}) => {
  const zips = args.zips ?? COVERAGE_ZIPS
  const schedulingZips = args.schedulingZips ?? PSC_AVAILABILITY_ZIPS
  const phlebotomyZips = args.phlebotomyZips ?? PHLEBOTOMY_AVAILABILITY_ZIPS
  const labIds = args.labIds ?? PSC_LAB_IDS
  const includeAvailability = args.includeAvailability !== false
  const sleep = args.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const gap = args.minIntervalMs ?? 50

  for (const zip of zips) {
    await recordObservation(args.real, "GET", `/v3/order/area/info?zip_code=${zip}`, args.getCache)
    await sleep(gap)
    for (const labId of labIds) {
      await recordObservation(
        args.real,
        "GET",
        `/v3/order/psc/info?zip_code=${zip}&lab_id=${labId}`,
        args.getCache,
      )
      await sleep(gap)
    }
  }

  if (!includeAvailability) return
  for (const zip of phlebotomyZips) {
    const body = availabilityAddressForZip(zip)
    await recordObservation(
      args.real,
      "POST",
      `/v3/order/phlebotomy/appointment/availability?start_date=${AVAILABILITY_START_DATE}`,
      args.getCache,
      body,
    )
    await sleep(gap)
  }
  for (const zip of schedulingZips) {
    const body = availabilityAddressForZip(zip)
    await recordObservation(
      args.real,
      "POST",
      `/v3/order/psc/appointment/availability?lab=quest&start_date=${AVAILABILITY_START_DATE}`,
      args.getCache,
      body,
    )
    await sleep(gap)
  }
}

/** Extract every `central_labs[*].lab_id` from an area-serviceability body. */
const labIdsFromAreaBody = (body: unknown): number[] => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return []
  const central = (body as Record<string, unknown>).central_labs
  if (central === null || typeof central !== "object") return []
  const entries = Array.isArray(central)
    ? central
    : Object.values(central as Record<string, unknown>)
  const ids: number[] = []
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
    const labId = (entry as Record<string, unknown>).lab_id
    if (typeof labId === "number" && Number.isInteger(labId)) ids.push(labId)
  }
  return ids
}

/**
 * Record the parameter-stable provider reads a sealed corpus covers: area serviceability and
 * PSC site inventory for every coverage ZIP, in both the SDK-shaped `radius=100` request and
 * the bare query the parity walks use. Availability is deliberately not recorded — its slot
 * dates and single-use `booking_key`s can never match a live cache key.
 */
export const recordSandboxCorpus = async (args: {
  real: PrefetchTarget
  getCache: Map<string, SeedCacheEntry>
  zips?: readonly string[]
  labIds?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  minIntervalMs?: number
}): Promise<{ observations: number; labIds: number[] }> => {
  const zips = args.zips ?? COVERAGE_ZIPS
  const sleep = args.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const gap = args.minIntervalMs ?? 50
  const discovered = new Set<number>(args.labIds ?? PSC_LAB_IDS)

  for (const zip of zips) {
    for (const path of [
      `/v3/order/area/info?zip_code=${zip}&radius=100`,
      `/v3/order/area/info?zip_code=${zip}`,
    ]) {
      const body = await recordObservation(args.real, "GET", path, args.getCache)
      for (const labId of labIdsFromAreaBody(body)) discovered.add(labId)
      await sleep(gap)
    }
  }

  const labIds = [...discovered].sort((a, b) => a - b)
  for (const zip of zips) {
    for (const labId of labIds) {
      for (const path of [
        `/v3/order/psc/info?zip_code=${zip}&lab_id=${labId}&radius=100`,
        `/v3/order/psc/info?zip_code=${zip}&lab_id=${labId}`,
      ]) {
        await recordObservation(args.real, "GET", path, args.getCache)
        await sleep(gap)
      }
    }
  }

  return { observations: args.getCache.size, labIds }
}
