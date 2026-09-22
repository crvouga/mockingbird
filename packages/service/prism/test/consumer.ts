/**
 * A port of our backend's Prism adapter (`apps/backend/src/modules/body-scan/adapters/
 * outbound/prism-scan.adapter.ts`) and the capture page's upload
 * (`packages/body-scan-capture-page/src/main.ts`): the same paths, `Accept:
 * application/json;v=1`, bearer key, `unit-system=metric`, timeouts (30 s, 5 s for stage
 * states), result statuses (404 → `not_found`, any other failure, schema mismatch or thrown
 * fetch → `unavailable`, no credentials → `unavailable` without a request), and the mapping of
 * scans, stages, body composition, measurements, metabolic age and assets. The zod schemas are
 * hand-ported as the same field checks.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>
export type LookupResult<T> =
  | { status: "ok"; data: T }
  | { status: "not_found" }
  | { status: "unavailable" }

const PRISM_ACCEPT_HEADER = "application/json;v=1"
const PRISM_REQUEST_TIMEOUT_MS = 30_000
const PRISM_STAGE_STATES_TIMEOUT_MS = 5_000
const POUNDS_TO_KILOGRAMS = 0.45359237
export const PRISM_BODYFAT_METHOD = "coco2"
export const PRISM_ASSET_CONFIG_ID_1_2_2_EBRO = "25f6d3a6-a634-40c3-8452-0342bee242d0"
export const PRISM_ASSET_CONFIG_ID_1_2_2_EBRO_WEB = "ee651a9e-6de1-4621-a5c9-5d31ca874718"
const STAGES = ["captureData", "body", "fittedBody", "measurement"] as const
const STAGE_STATUSES = ["started", "succeeded", "failed"]
const STATUSES = ["CREATED", "PROCESSING", "READY", "FAILED"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const optionalNumbers = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((k) => value[k] === undefined || typeof value[k] === "number")

type Parser<T> = (value: unknown) => T | undefined

const subject: Parser<{ id: string | number; token: string }> = (v) =>
  isRecord(v) &&
  (typeof v.id === "string" || typeof v.id === "number") &&
  typeof v.token === "string"
    ? (v as { id: string | number; token: string })
    : undefined

type ProviderScan = {
  id: string
  status: string
  weight?: { value: number; unit: string } | null
  createdAt?: string | null
  updatedAt?: string | null
}
const scanSchema: Parser<ProviderScan> = (v) => {
  if (!isRecord(v) || typeof v.id !== "string" || !STATUSES.includes(v.status as string))
    return undefined
  if (
    v.weight != null &&
    !(isRecord(v.weight) && typeof v.weight.value === "number" && typeof v.weight.unit === "string")
  ) {
    return undefined
  }
  return v as ProviderScan
}

/** `providerScanAssetsSchema`: each stage field `.catch(undefined)`, so junk values drop out. */
const assetsSchema: Parser<Record<string, string | undefined>> = (v) => {
  if (!isRecord(v)) return undefined
  const out: Record<string, string | undefined> = {}
  for (const stage of STAGES) {
    const status = v[stage]
    out[stage] = typeof status === "string" && STAGE_STATUSES.includes(status) ? status : undefined
    const at = v[`${stage}UpdatedAt`]
    out[`${stage}UpdatedAt`] = typeof at === "string" ? at : undefined
  }
  return out
}

const uploadSchema: Parser<{ url: string; expirationTime: string }> = (v) =>
  isRecord(v) && typeof v.url === "string" && typeof v.expirationTime === "string"
    ? (v as { url: string; expirationTime: string })
    : undefined

type Composition = {
  bodyfatMethod?: string
  bodyfatPercentage?: number
  leanMass?: number
  fatMass?: number
  skeletalMuscleMass?: number
}
const compositionSchema: Parser<Composition> = (v) =>
  isRecord(v) &&
  (v.bodyfatMethod === undefined || typeof v.bodyfatMethod === "string") &&
  optionalNumbers(v, ["bodyfatPercentage", "leanMass", "fatMass", "skeletalMuscleMass"])
    ? (v as Composition)
    : undefined

type Measurements = {
  waistFit?: number
  hipsFit?: number
  chestFit?: number
  waistToHipRatio?: number
  bodyRoundnessIndex?: number
  bmiPredicted?: number
}
const measurementsSchema: Parser<Measurements> = (v) =>
  isRecord(v) &&
  optionalNumbers(v, [
    "waistFit",
    "hipsFit",
    "chestFit",
    "waistToHipRatio",
    "bodyRoundnessIndex",
    "bmiPredicted",
  ])
    ? (v as Measurements)
    : undefined

const objectSchema: Parser<Record<string, unknown>> = (v) => (isRecord(v) ? v : undefined)
const assetUrlsSchema: Parser<Record<string, unknown>> = (v) =>
  isRecord(v) &&
  ["previewImage", "model", "canonicalBody", "texture", "material", "stripes"].every(
    (k) => v[k] === undefined || typeof v[k] === "string",
  )
    ? v
    : undefined

export type ExternalScan = {
  externalId: string
  status: "initiated" | "processing" | "complete" | "failed"
  createdAt: string | null
  updatedAt: string | null
  weightKg: number | null
}

export type SubjectInput = {
  token: string
  sex: "male" | "female" | "neutral" | "undefined"
  region: string
  birthDate: string
  weight: { value: number; unit: "kg" | "lb" }
  height: { value: number; unit: "m" | "in" }
  researchConsent: boolean
  termsOfService: { accepted: boolean; version: string }
}

/** `PrismScanAdapter`, over an injected fetch and `PRISM_API_URL` / `PRISM_API_KEY`. */
export class PrismConsumer {
  readonly warnings: Record<string, unknown>[] = []

  constructor(
    private readonly env: { PRISM_API_URL?: string; PRISM_API_KEY?: string },
    private readonly fetchImpl: Fetch,
  ) {}

  async upsertSubject(input: SubjectInput) {
    const result = await this.requestJson("/users", {
      method: "POST",
      body: { ...input },
      schema: subject,
      endpoint: "users_upsert",
      map: (p) => ({ externalId: String(p.id), token: p.token }),
    })
    return result.status === "ok" ? result : ({ status: "unavailable" } as const)
  }

  async createScan(input: {
    subjectToken: string
    devicePlatform: "ios" | "android"
    captureMethod?: "native" | "web"
  }) {
    const result = await this.requestJson("/scans", {
      method: "POST",
      body: {
        userToken: input.subjectToken,
        deviceConfigName: input.devicePlatform === "ios" ? "IPHONE_SCANNER" : "ANDROID_SCANNER",
        bodyfatMethod: PRISM_BODYFAT_METHOD,
        ...(input.captureMethod
          ? {
              assetConfigId:
                input.captureMethod === "native"
                  ? PRISM_ASSET_CONFIG_ID_1_2_2_EBRO
                  : PRISM_ASSET_CONFIG_ID_1_2_2_EBRO_WEB,
            }
          : {}),
      },
      schema: scanSchema,
      endpoint: "scans_create",
      map: (p) => this.mapScan(p),
    })
    return result.status === "ok" ? result : ({ status: "unavailable" } as const)
  }

  getScanUploadTarget(externalScanId: string) {
    return this.requestJson(`/scans/${encodeURIComponent(externalScanId)}/upload-url`, {
      method: "POST",
      schema: uploadSchema,
      endpoint: "scan_upload_url",
      map: (p) => ({ url: p.url, expiresAt: p.expirationTime }),
    })
  }

  getScan(externalScanId: string) {
    const params = new URLSearchParams({ "unit-system": "metric" })
    return this.requestJson(`/scans/${encodeURIComponent(externalScanId)}?${params}`, {
      method: "GET",
      schema: scanSchema,
      endpoint: "scan_get",
      map: (p) => this.mapScan(p),
    })
  }

  getScanStageStates(externalScanId: string) {
    return this.requestJson(`/scans/${encodeURIComponent(externalScanId)}/scan-assets`, {
      method: "GET",
      schema: assetsSchema,
      endpoint: "scan_assets",
      timeoutMs: PRISM_STAGE_STATES_TIMEOUT_MS,
      map: (p) =>
        STAGES.flatMap((stage) => {
          const status = p[stage]
          if (!status) return []
          const updatedAt = p[`${stage}UpdatedAt`]
          return [{ stage, status, updatedAt: typeof updatedAt === "string" ? updatedAt : null }]
        }),
    })
  }

  async getCompletedScanData(externalScanId: string, scan?: ExternalScan) {
    const scanResult: LookupResult<ExternalScan> = scan
      ? { status: "ok", data: scan }
      : await this.getScan(externalScanId)
    if (scanResult.status !== "ok") return scanResult
    const id = encodeURIComponent(externalScanId)
    const [composition, measurements, report, assets] = await Promise.all([
      this.requestJson(`/scans/${id}/bodyfat`, {
        method: "GET",
        schema: compositionSchema,
        endpoint: "scan_body_composition",
        map: (p) => p,
      }),
      this.requestJson(
        `/scans/${id}/measurements?${new URLSearchParams({ "unit-system": "metric" })}`,
        {
          method: "GET",
          schema: measurementsSchema,
          endpoint: "scan_measurements",
          map: (p) => p,
        },
      ),
      this.requestJson(`/scans/${id}/health-report`, {
        method: "GET",
        schema: objectSchema,
        endpoint: "scan_health_report",
        map: (p) => p,
      }),
      this.getAssetUrls(externalScanId),
    ])
    if (composition.status !== "ok") return composition
    if (measurements.status !== "ok") return measurements
    if (report.status !== "ok") return report
    if (assets.status !== "ok") return assets
    const n = (v: number | null | undefined) =>
      typeof v !== "number" || !Number.isFinite(v) || v < 0 ? null : v
    return {
      status: "ok" as const,
      data: {
        bodyFatPercentage: n(composition.data.bodyfatPercentage),
        leanMass: n(composition.data.leanMass),
        fatMass: n(composition.data.fatMass),
        skeletalMuscleMass: n(composition.data.skeletalMuscleMass),
        waistFit: n(measurements.data.waistFit),
        hipsFit: n(measurements.data.hipsFit),
        chestFit: n(measurements.data.chestFit),
        waistToHipRatio: n(measurements.data.waistToHipRatio),
        bodyRoundnessIndex: n(measurements.data.bodyRoundnessIndex),
        bmiPredicted: n(measurements.data.bmiPredicted),
        ...this.metabolicAge(report.data, externalScanId),
        weightKg: n(scanResult.data.weightKg),
        bodyfatMethod: composition.data.bodyfatMethod ?? null,
        assets: assets.data,
      },
    }
  }

  getAssetUrls(externalScanId: string) {
    return this.requestJson(`/scans/${encodeURIComponent(externalScanId)}/asset-urls`, {
      method: "GET",
      schema: assetUrlsSchema,
      endpoint: "scan_asset_urls",
      map: (p) =>
        ["previewImage", "model", "canonicalBody", "texture", "material", "stripes"].flatMap(
          (assetType) => {
            const url = p[assetType]
            return typeof url === "string" && url.length > 0
              ? [{ assetType, url, expiresAt: null }]
              : []
          },
        ),
    })
  }

  private metabolicAge(payload: Record<string, unknown>, externalScanId: string) {
    const empty = { metabolicAge: null, chronologicalAgeYears: null, ageDeltaYears: null }
    const report = payload.metabolicAgeReport
    if (report === undefined || report === null) return empty
    if (
      !isRecord(report) ||
      !["metabolicAgeYears", "chronologicalAgeYears", "ageDeltaYears", "percentile"].every(
        (k) => report[k] == null || typeof report[k] === "number",
      )
    ) {
      this.warnings.push({ event: "body_scan.metabolic_age_report_unreadable", externalScanId })
      return empty
    }
    const r = report as {
      metabolicAgeYears?: number | null
      chronologicalAgeYears?: number | null
      ageDeltaYears?: number | null
    }
    if (r.metabolicAgeYears == null && r.chronologicalAgeYears == null && r.ageDeltaYears == null) {
      this.warnings.push({
        event: "body_scan.metabolic_age_report_unrecognized_shape",
        externalScanId,
      })
      return empty
    }
    const n = (v: number | null | undefined) =>
      typeof v !== "number" || !Number.isFinite(v) || v < 0 ? null : v
    const metabolicAge = n(r.metabolicAgeYears)
    const chronologicalAgeYears = n(r.chronologicalAgeYears)
    let ageDeltaYears: number | null = null
    if (metabolicAge !== null && chronologicalAgeYears !== null) {
      ageDeltaYears =
        typeof r.ageDeltaYears === "number" && Number.isFinite(r.ageDeltaYears)
          ? r.ageDeltaYears
          : metabolicAge - chronologicalAgeYears
    }
    const reasons: string[] = []
    if (metabolicAge !== null && (metabolicAge < 10 || metabolicAge > 120))
      reasons.push("metabolic_age_out_of_range")
    if (ageDeltaYears !== null && Math.abs(ageDeltaYears) > 20)
      reasons.push("age_delta_out_of_range")
    if (reasons.length > 0)
      this.warnings.push({ event: "body_scan.metabolic_age_implausible", externalScanId, reasons })
    return { metabolicAge, chronologicalAgeYears, ageDeltaYears }
  }

  private mapScan(payload: ProviderScan): ExternalScan {
    const status =
      payload.status === "CREATED"
        ? "initiated"
        : payload.status === "PROCESSING"
          ? "processing"
          : payload.status === "READY"
            ? "complete"
            : "failed"
    let weightKg: number | null = null
    if (payload.weight && Number.isFinite(payload.weight.value)) {
      const unit = payload.weight.unit.toLowerCase()
      const value =
        unit === "kg"
          ? payload.weight.value
          : unit === "lb"
            ? payload.weight.value * POUNDS_TO_KILOGRAMS
            : null
      weightKg = value !== null && value >= 0 ? value : null
    }
    return {
      externalId: payload.id,
      status,
      createdAt: payload.createdAt ?? null,
      updatedAt: payload.updatedAt ?? null,
      weightKg,
    }
  }

  private async requestJson<P, T>(
    path: string,
    params: {
      method: "GET" | "POST"
      schema: Parser<P>
      endpoint: string
      map: (payload: P) => T
      body?: Record<string, unknown>
      timeoutMs?: number
    },
  ): Promise<LookupResult<T>> {
    const baseUrl = this.env.PRISM_API_URL?.replace(/\/+$/, "")
    const apiKey = this.env.PRISM_API_KEY
    if (!baseUrl || !apiKey) {
      this.warnings.push({ event: "body_scan.provider_credentials_missing" })
      return { status: "unavailable" }
    }
    try {
      const response = await this.fetchImpl(`${baseUrl}${path}`, {
        method: params.method,
        headers: {
          accept: PRISM_ACCEPT_HEADER,
          authorization: `Bearer ${apiKey}`,
          ...(params.body ? { "content-type": "application/json" } : {}),
        },
        ...(params.body ? { body: JSON.stringify(params.body) } : {}),
        signal: AbortSignal.timeout(params.timeoutMs ?? PRISM_REQUEST_TIMEOUT_MS),
      })
      if (response.status === 404) return { status: "not_found" }
      if (!response.ok) {
        this.warnings.push({
          event: "body_scan.provider_unavailable",
          endpoint: params.endpoint,
          httpStatus: response.status,
          detail: (await response.text()).slice(0, 500) || "<empty body>",
        })
        return { status: "unavailable" }
      }
      const parsed = params.schema(await response.json())
      if (parsed === undefined) {
        this.warnings.push({
          event: "body_scan.provider_unavailable",
          endpoint: params.endpoint,
          reason: "schema_validation_failed",
        })
        return { status: "unavailable" }
      }
      return { status: "ok", data: params.map(parsed) }
    } catch (error) {
      this.warnings.push({
        event: "body_scan.provider_unavailable",
        endpoint: params.endpoint,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      })
      return { status: "unavailable" }
    }
  }
}

/** The capture page's upload: a plain PUT of the video blob to the presigned URL. */
export const uploadCapture = async (fetchImpl: Fetch, uploadUrl: string, video: Uint8Array) => {
  const response = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: new Blob([video as BlobPart]),
  })
  return response.status >= 200 && response.status < 300
    ? ({ type: "upload-complete" } as const)
    : ({ type: "error", code: "upload_failed", message: `HTTP ${response.status}` } as const)
}
