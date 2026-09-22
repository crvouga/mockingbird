/**
 * A port of our EasyPost tracking lookup (`packages/lib/src/shipment-tracking-status/
 * easypost-client.ts` and the carrier resolver it uses, `gxg-shipment-tracking/
 * resolve-carrier.ts`): the same form body, Basic `key:` auth, error extraction and status /
 * carrier mapping. The only change is the base URL (the app hardcodes
 * `https://api.easypost.com`, seam G-Y1). The acceptance tests drive the mock through it.
 */
export type ShipmentTrackingStatus =
  | "unknown"
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "failure"
  | "cancelled"

export type TrackingCarrier = "UPS" | "USPS" | "FedEx" | "DHL"

export type TrackingStatusLookupResult = {
  trackingNumber: string
  status: ShipmentTrackingStatus
  carrier: TrackingCarrier | null
  statusDetail: string
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const CARRIER_PATTERNS: ReadonlyArray<{ carrier: TrackingCarrier; pattern: RegExp }> = [
  { carrier: "UPS", pattern: /^1Z[A-Z0-9]{16}$/i },
  { carrier: "USPS", pattern: /^(420\d{4,5}\d{20,22}|9[0-9]{21,27}|[A-Z]{2}[0-9]{9}US)$/i },
  { carrier: "FedEx", pattern: /^[0-9]{12,22}$/ },
  { carrier: "DHL", pattern: /^[0-9]{10,11}$/ },
]

export const resolveCarrier = (trackingNumber: string): TrackingCarrier | null => {
  const cleaned = trackingNumber.trim().toUpperCase()
  if (cleaned.length === 0) return null
  for (const entry of CARRIER_PATTERNS) {
    if (entry.pattern.test(cleaned)) return entry.carrier
  }
  return null
}

const EASYPOST_STATUS_MAP: Record<string, ShipmentTrackingStatus> = {
  unknown: "unknown",
  pre_transit: "pre_transit",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  available_for_pickup: "in_transit",
  return_to_sender: "failure",
  failure: "failure",
  cancelled: "cancelled",
  error: "failure",
}

const EASYPOST_CARRIER_MAP: Record<string, TrackingCarrier> = {
  UPS: "UPS",
  USPS: "USPS",
  FedEx: "FedEx",
  FEDEX: "FedEx",
  DHL: "DHL",
  DHLExpress: "DHL",
}

export const mapEasyPostStatus = (raw: unknown): ShipmentTrackingStatus =>
  typeof raw === "string" ? (EASYPOST_STATUS_MAP[raw.trim().toLowerCase()] ?? "unknown") : "unknown"

const mapEasyPostCarrier = (raw: unknown): TrackingCarrier | null =>
  typeof raw === "string" ? (EASYPOST_CARRIER_MAP[raw.trim()] ?? null) : null

const basicAuthHeader = (apiKey: string) => `Basic ${btoa(`${apiKey}:`)}`

export const lookupTrackingStatus = async (params: {
  baseUrl: string
  trackingNumber: string
  apiKey: string
  fetchImpl: Fetch
}): Promise<TrackingStatusLookupResult> => {
  const trackingNumber = params.trackingNumber.trim()
  if (trackingNumber.length === 0) {
    return {
      trackingNumber: "",
      status: "unknown",
      carrier: null,
      statusDetail: "empty tracking number",
    }
  }
  const carrierHint = resolveCarrier(trackingNumber)
  const body = new URLSearchParams()
  body.set("tracker[tracking_code]", trackingNumber)
  if (carrierHint != null) body.set("tracker[carrier]", carrierHint)

  const response = await params.fetchImpl(`${params.baseUrl}/v2/trackers`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(params.apiKey),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  })
  const text = await response.text()
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      parsed = null
    }
  }
  if (!response.ok) {
    const message =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).error === "object" &&
      (parsed as { error?: { message?: unknown } }).error?.message != null
        ? String((parsed as { error: { message: unknown } }).error.message)
        : `EasyPost tracker request failed (${String(response.status)})`
    return { trackingNumber, status: "unknown", carrier: carrierHint, statusDetail: message }
  }
  const record =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  return {
    trackingNumber,
    status: mapEasyPostStatus(record?.status),
    carrier: mapEasyPostCarrier(record?.carrier) ?? carrierHint,
    statusDetail: typeof record?.status_detail === "string" ? record.status_detail : "",
  }
}

/** `batchLookupTrackingStatuses`: dedupe, a small worker pool, a thrown fetch becomes `unknown`. */
export const batchLookupTrackingStatuses = async (params: {
  baseUrl: string
  trackingNumbers: readonly string[]
  apiKey: string
  concurrency?: number
  fetchImpl: Fetch
  onWarning?: (message: string) => void
}): Promise<Map<string, TrackingStatusLookupResult>> => {
  const unique = [
    ...new Set(params.trackingNumbers.map((v) => v.trim()).filter((v) => v.length > 0)),
  ]
  const concurrency = Math.max(1, params.concurrency ?? 5)
  const results = new Map<string, TrackingStatusLookupResult>()
  let cursor = 0
  const worker = async () => {
    while (cursor < unique.length) {
      const index = cursor
      cursor += 1
      const trackingNumber = unique[index] as string
      try {
        results.set(
          trackingNumber,
          await lookupTrackingStatus({
            baseUrl: params.baseUrl,
            trackingNumber,
            apiKey: params.apiKey,
            fetchImpl: params.fetchImpl,
          }),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        params.onWarning?.(`tracking lookup failed for ${trackingNumber}: ${message}`)
        results.set(trackingNumber, {
          trackingNumber,
          status: "unknown",
          carrier: resolveCarrier(trackingNumber),
          statusDetail: message,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()))
  return results
}
