import type { SeedCacheEntry } from "@crvouga/mockingbird-parity"
import { GEVITI_QA_PSC_LAB_IDS, GEVITI_QA_ROUTING_ZIPS } from "./qa-corpus.js"
import {
  GEVITI_QA_AVAILABILITY_ADDRESS,
  GEVITI_QA_AVAILABILITY_START_DATE,
} from "./reshape-qa.js"
import { observationCacheKey } from "./state.js"

type PrefetchTarget = {
  baseUrl: string
  fetch: (request: Request) => Promise<Response>
  headers: () => Promise<Record<string, string>> | Record<string, string>
}

const recordResponse = async (
  target: PrefetchTarget,
  method: string,
  pathAndQuery: string,
  getCache: Map<string, SeedCacheEntry>,
  body?: unknown,
) => {
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
  getCache.set(observationCacheKey(url, method, body), {
    status: response.status,
    headers: headerRecord,
    body: parsed,
  })
}

const availabilityBody = (zip: string) => ({
  first_line: GEVITI_QA_AVAILABILITY_ADDRESS.first_line,
  second_line: GEVITI_QA_AVAILABILITY_ADDRESS.second_line,
  city: GEVITI_QA_AVAILABILITY_ADDRESS.city,
  state: GEVITI_QA_AVAILABILITY_ADDRESS.state,
  zip_code: zip,
  unit: GEVITI_QA_AVAILABILITY_ADDRESS.unit,
})

/**
 * Seal Geviti routing ZIPs + availability POSTs into the seed observation cache.
 * Call after warmup, before `seedFrom`, so compare walks can forceInclude geo/scheduling reads.
 */
export const prefetchGevitiQaObservations = async (args: {
  real: PrefetchTarget
  getCache: Map<string, SeedCacheEntry>
  zips?: readonly string[]
  /** ZIPs that also get availability POST seals. Defaults to `zips`. */
  schedulingZips?: readonly string[]
  labIds?: readonly number[]
  /** Also prefetch phlebotomy + PSC availability. Default true. */
  includeAvailability?: boolean
  sleep?: (ms: number) => Promise<void>
  minIntervalMs?: number
}) => {
  const zips = args.zips ?? GEVITI_QA_ROUTING_ZIPS
  const schedulingZips = args.schedulingZips ?? zips
  const labIds = args.labIds ?? GEVITI_QA_PSC_LAB_IDS
  const includeAvailability = args.includeAvailability !== false
  const sleep = args.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const gap = args.minIntervalMs ?? 50

  for (const zip of zips) {
    await recordResponse(args.real, "GET", `/v3/order/area/info?zip_code=${zip}`, args.getCache)
    await sleep(gap)
    for (const labId of labIds) {
      await recordResponse(
        args.real,
        "GET",
        `/v3/order/psc/info?zip_code=${zip}&lab_id=${labId}`,
        args.getCache,
      )
      await sleep(gap)
    }
  }

  if (!includeAvailability) return
  for (const zip of schedulingZips) {
    const body = availabilityBody(zip)
    await recordResponse(
      args.real,
      "POST",
      `/v3/order/phlebotomy/appointment/availability?start_date=${GEVITI_QA_AVAILABILITY_START_DATE}`,
      args.getCache,
      body,
    )
    await sleep(gap)
    await recordResponse(
      args.real,
      "POST",
      `/v3/order/psc/appointment/availability?lab=quest&start_date=${GEVITI_QA_AVAILABILITY_START_DATE}`,
      args.getCache,
      body,
    )
    await sleep(gap)
  }
}
