import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  PrismState,
  type Quantity,
  type ScanRecord,
  type Settings,
  STAGES,
  type Stage,
  type UserRecord,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  AutoAdvance,
  Quantity,
  ScanRecord,
  ScanStatus,
  Settings,
  Stage,
  StageStatus,
  UserRecord,
} from "./state.js"
export { STAGES } from "./state.js"

export const PRISM_NAMESPACE = "prism"

export type PrismAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  /**
   * The namespace requests select this instance by, so presigned upload and asset URLs carry
   * a `/ns/<name>` prefix (the capture page's PUT has no other namespace carrier).
   */
  publicNamespace?: string
}

const POUNDS_TO_KILOGRAMS = 0.45359237
const INCHES_TO_METERS = 0.0254
const ASSET_FILES: Record<string, string> = {
  previewImage: "preview.png",
  model: "model.obj",
  canonicalBody: "canonical-body.obj",
  texture: "texture.png",
  material: "material.mtl",
  stripes: "stripes.png",
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const prismError = (status: number, message: string, errors?: unknown[]) =>
  jsonRes(status, { message, ...(errors ? { errors } : {}) })

const kilograms = (q: Quantity) => (q.unit === "lb" ? q.value * POUNDS_TO_KILOGRAMS : q.value)
const meters = (q: Quantity) => (q.unit === "in" ? q.value * INCHES_TO_METERS : q.value)

/**
 * The deterministic results a READY scan answers, derived from the subject's height, weight,
 * sex and age (Deurenberg body fat, proportional circumferences), so tests can predict them.
 */
export const scanResults = (scan: ScanRecord, user: UserRecord | undefined, nowMs: number) => {
  const kg = kilograms(scan.weight)
  const m = meters(scan.height)
  const bmi = kg / (m * m)
  const birth = Date.parse(user?.birthDate ?? "1990-01-01")
  const age = Math.max(0, (nowMs - birth) / (365.25 * 86_400_000))
  const male = user?.sex === "male" ? 1 : 0
  const bodyfat = clamp(1.2 * bmi + 0.23 * age - 10.8 * male - 5.4, 3, 60)
  const fatMass = (kg * bodyfat) / 100
  const leanMass = kg - fatMass
  const waistM = m * 0.43 * (bmi / 22) ** 0.6
  const hipsM = waistM * (male ? 1.05 : 1.2)
  const chestM = waistM * 1.1
  const bri =
    364.2 - 365.5 * Math.sqrt(Math.max(0, 1 - (waistM / (2 * Math.PI)) ** 2 / (0.5 * m) ** 2))
  const metabolicAge = clamp(Math.round(age + (bodyfat - (male ? 18 : 25)) / 2), 10, 120)
  const chronological = Math.floor(age)
  return {
    kg,
    m,
    bmi,
    bodyfat: {
      bodyfatMethod: scan.bodyfatMethod,
      bodyfatPercentage: round(bodyfat, 1),
      leanMass: round(leanMass),
      fatMass: round(fatMass),
      skeletalMuscleMass: round(leanMass * 0.5),
      unit: "kg",
    },
    measurementsMetric: {
      waistFit: round(waistM * 100),
      hipsFit: round(hipsM * 100),
      chestFit: round(chestM * 100),
      waistToHipRatio: round(waistM / hipsM, 3),
      bodyRoundnessIndex: round(bri, 2),
      bmiPredicted: round(bmi, 1),
      unit: "cm",
    },
    measurementsImperial: {
      waistFit: round((waistM / INCHES_TO_METERS) * 1),
      hipsFit: round(hipsM / INCHES_TO_METERS),
      chestFit: round(chestM / INCHES_TO_METERS),
      waistToHipRatio: round(waistM / hipsM, 3),
      bodyRoundnessIndex: round(bri, 2),
      bmiPredicted: round(bmi, 1),
      unit: "in",
    },
    healthReport: {
      metabolicAgeReport: {
        metabolicAgeYears: metabolicAge,
        chronologicalAgeYears: chronological,
        ageDeltaYears: metabolicAge - chronological,
        percentile: clamp(50 - (metabolicAge - chronological) * 3, 1, 99),
      },
      bodyShapeReport: { bmi: round(bmi, 1), category: bmi < 25 ? "healthy" : "elevated" },
    },
  }
}

/**
 * Stateful mock of the Prism Labs body-scan API. A scan is `CREATED`, moves to `PROCESSING`
 * when its capture is PUT to the presigned upload URL, then walks the processing stages
 * (captureData → body → fittedBody → measurement) to `READY` (or `FAILED`) through admin
 * advances or an auto-advance plan on the mock clock.
 */
export class PrismAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: PrismState
  private readonly service: Service
  private readonly now: () => number
  private readonly prefix: string

  constructor(options: PrismAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? PRISM_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.prefix =
      options.publicNamespace && options.publicNamespace !== "default"
        ? `/ns/${encodeURIComponent(options.publicNamespace)}`
        : ""
    this.state = new PrismState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      UpsertUser: (context) => this.upsertUser(context),
      CreateScan: (context) => this.createScan(context),
      GetScan: (context) => {
        const scan = this.scan(context)
        const body = this.scanBody(scan, context.query["unit-system"] === "imperial")
        if (faultEffect(context.request, "schema_drift") !== undefined) {
          Object.assign(body, { status: "QUEUED" })
        }
        return annotateResponse(jsonRes(200, body), { ids: { scanId: scan.id } })
      },
      CreateUploadUrl: (context) => this.uploadUrl(context),
      GetScanAssets: (context) => {
        const scan = this.scan(context)
        const out: Record<string, string | null> = {}
        for (const stage of STAGES) {
          out[stage] = scan.stages[stage]?.status ?? null
          out[`${stage}UpdatedAt`] = scan.stages[stage]?.updatedAt ?? null
        }
        return jsonRes(200, out)
      },
      GetBodyfat: (context) => {
        const { results } = this.ready(context)
        return jsonRes(200, results.bodyfat)
      },
      GetMeasurements: (context) => {
        const { results } = this.ready(context)
        return jsonRes(
          200,
          context.query["unit-system"] === "imperial"
            ? results.measurementsImperial
            : results.measurementsMetric,
        )
      },
      GetHealthReport: (context) => {
        const { results } = this.ready(context)
        if (faultEffect(context.request, "metabolic_age_missing") !== undefined) {
          return jsonRes(200, { ...results.healthReport, metabolicAgeReport: null })
        }
        if (faultEffect(context.request, "metabolic_age_implausible") !== undefined) {
          return jsonRes(200, {
            ...results.healthReport,
            metabolicAgeReport: {
              metabolicAgeYears: 150,
              chronologicalAgeYears: results.healthReport.metabolicAgeReport.chronologicalAgeYears,
              ageDeltaYears: null,
              percentile: null,
            },
          })
        }
        return jsonRes(200, results.healthReport)
      },
      GetAssetUrls: (context) => {
        const { scan } = this.ready(context)
        const origin = new URL(context.request.url).origin
        const expires = this.now() + 3_600_000
        return jsonRes(
          200,
          Object.fromEntries(
            Object.entries(ASSET_FILES).map(([key, file]) => [
              key,
              `${origin}${this.prefix}/assets/${scan.id}/${file}?expires=${expires}&signature=${opaqueToken(`${scan.id}:${file}:${expires}`, 24)}`,
            ]),
          ),
        )
      },
      UploadCapture: (context) => this.upload(context),
      GetAsset: (context) => {
        const scan = this.state.scans.get(context.params.scanId ?? "")
        const file = context.params.file ?? ""
        if (scan?.status !== "READY" || !Object.values(ASSET_FILES).includes(file)) {
          return new Response(null, { status: 404 })
        }
        return new Response(new TextEncoder().encode(`prism-mock:${scan.id}:${file}`), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        })
      },
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => prismError(404, "Not Found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        this.tick()
        const id = context.operation.operationId
        if (id === "UploadCapture" || id === "GetAsset") return undefined
        const key = bearerToken(context.request)
        const allowed = this.state.current().apiKeys
        if (!key || (allowed.length > 0 && !allowed.includes(key))) {
          return prismError(401, "Unauthorized")
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private body(context: OperationContext): Record<string, unknown> {
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      throw new HttpError(400, {
        message: "Validation failed",
        errors: issues.map((issue) => ({ field: issue.path || "body", message: issue.message })),
      })
    }
    return context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
  }

  private scan(context: OperationContext): ScanRecord {
    const scan = this.state.scans.get(context.params.scanId ?? "")
    if (!scan) throw new HttpError(404, { message: "Scan not found" })
    return scan
  }

  private ready(context: OperationContext) {
    const scan = this.scan(context)
    if (scan.status !== "READY") {
      throw new HttpError(404, { message: "Scan results are not available" })
    }
    return { scan, results: scanResults(scan, this.state.user(scan.userToken), this.now()) }
  }

  private scanBody(scan: ScanRecord, imperial: boolean) {
    const kg = kilograms(scan.weight)
    const m = meters(scan.height)
    return {
      id: scan.id,
      status: scan.status,
      userToken: scan.userToken,
      deviceConfigName: scan.deviceConfigName,
      bodyfatMethod: scan.bodyfatMethod,
      assetConfigId: scan.assetConfigId,
      weight: imperial
        ? { value: round(kg / POUNDS_TO_KILOGRAMS), unit: "lb" }
        : { value: round(kg), unit: "kg" },
      height: imperial
        ? { value: round(m / INCHES_TO_METERS), unit: "in" }
        : { value: round(m, 3), unit: "m" },
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
    }
  }

  private upsertUser(context: OperationContext): Response {
    const body = this.body(context)
    const token = String(body.token)
    const existing = this.state.user(token)
    const now = this.iso()
    const user: UserRecord = {
      id: existing?.id ?? this.state.ids.next("usr_", 20),
      token,
      sex: body.sex as UserRecord["sex"],
      region: String(body.region),
      birthDate: String(body.birthDate),
      weight: body.weight as Quantity,
      height: body.height as Quantity,
      researchConsent: Boolean(body.researchConsent),
      termsOfService: body.termsOfService as UserRecord["termsOfService"],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.state.users.insert(token, user)
    return annotateResponse(jsonRes(existing ? 200 : 201, user), { ids: { userId: user.id } })
  }

  private createScan(context: OperationContext): Response {
    const body = this.body(context)
    const user = this.state.user(String(body.userToken))
    if (!user) return prismError(404, "User not found")
    const now = this.iso()
    const token = this.state.ids.next("scan", 32).toLowerCase()
    const id = `${token.slice(0, 8)}-${token.slice(8, 12)}-4${token.slice(13, 16)}-a${token.slice(17, 20)}-${token.slice(20, 32)}`
    const scan: ScanRecord = {
      id,
      status: "CREATED",
      userToken: user.token,
      deviceConfigName: String(body.deviceConfigName),
      bodyfatMethod: String(body.bodyfatMethod),
      assetConfigId: typeof body.assetConfigId === "string" ? body.assetConfigId : null,
      weight: user.weight,
      height: user.height,
      stages: {},
      upload: null,
      uploadedBytes: null,
      uploadedAtMs: null,
      createdAt: now,
      updatedAt: now,
    }
    this.state.scans.insert(id, scan)
    return annotateResponse(jsonRes(201, this.scanBody(scan, false)), { ids: { scanId: id } })
  }

  private uploadUrl(context: OperationContext): Response {
    const scan = this.scan(context)
    if (scan.status !== "CREATED") return prismError(409, "Scan capture already uploaded")
    const expiresAtMs = this.now() + this.state.current().uploadUrlTtlMs
    const signature = opaqueToken(`${scan.id}:${expiresAtMs}`, 24)
    this.state.scans.update(scan.id, { ...scan, upload: { signature, expiresAtMs } })
    const origin = new URL(context.request.url).origin
    return annotateResponse(
      jsonRes(200, {
        url: `${origin}${this.prefix}/uploads/${scan.id}?expires=${expiresAtMs}&signature=${signature}`,
        expirationTime: new Date(expiresAtMs).toISOString(),
      }),
      { ids: { scanId: scan.id } },
    )
  }

  private upload(context: OperationContext): Response {
    const s3Error = (code: string, message: string) =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
        {
          status: 403,
          headers: { "content-type": "application/xml" },
        },
      )
    const scan = this.state.scans.get(context.params.scanId ?? "")
    if (!scan) return new Response(null, { status: 404 })
    const expires = Number(context.query.expires)
    if (
      !scan.upload ||
      String(context.query.signature) !== scan.upload.signature ||
      expires !== scan.upload.expiresAtMs
    ) {
      return s3Error(
        "SignatureDoesNotMatch",
        "The request signature we calculated does not match the signature you provided.",
      )
    }
    if (this.now() > expires) return s3Error("AccessDenied", "Request has expired")
    const body = context.body
    const bytes =
      body.kind === "bytes"
        ? body.value.byteLength
        : body.kind === "text"
          ? new TextEncoder().encode(body.value).byteLength
          : body.kind === "empty"
            ? 0
            : 1
    if (scan.status === "CREATED") {
      const now = this.iso()
      const next: ScanRecord =
        bytes === 0
          ? {
              ...scan,
              status: "FAILED",
              stages: { captureData: { status: "failed", updatedAt: now } },
              uploadedBytes: 0,
              updatedAt: now,
            }
          : {
              ...scan,
              status: "PROCESSING",
              stages: {
                captureData: { status: "succeeded", updatedAt: now },
                body: { status: "started", updatedAt: now },
              },
              uploadedBytes: bytes,
              uploadedAtMs: this.now(),
              updatedAt: now,
            }
      this.state.scans.update(scan.id, next)
    }
    return annotateResponse(
      new Response(null, {
        status: 200,
        headers: { etag: `"${opaqueToken(`${scan.id}:${bytes}`, 32)}"` },
      }),
      {
        ids: { scanId: scan.id },
      },
    )
  }

  /**
   * Move a PROCESSING scan one stage on: the started stage succeeds (or fails, when `fail` is
   * set) and the next one starts; after `measurement` the scan is READY.
   */
  advance(scanId: string, fail = false): ScanRecord | undefined {
    const scan = this.state.scans.get(scanId)
    if (scan?.status !== "PROCESSING") return scan
    const now = this.iso()
    const current = STAGES.find((stage) => scan.stages[stage]?.status === "started")
    if (!current) return scan
    const stages = {
      ...scan.stages,
      [current]: { status: fail ? "failed" : "succeeded", updatedAt: now },
    }
    const nextStage = STAGES[STAGES.indexOf(current) + 1] as Stage | undefined
    if (!fail && nextStage) stages[nextStage] = { status: "started", updatedAt: now }
    const next: ScanRecord = {
      ...scan,
      stages,
      status: fail ? "FAILED" : nextStage ? "PROCESSING" : "READY",
      updatedAt: now,
    }
    this.state.scans.update(scanId, next)
    return next
  }

  /** Walk every uploaded scan along the auto-advance plan, as far as the mock clock allows. */
  tick(): number {
    const plan = this.state.current().autoAdvance
    if (!plan) return 0
    let applied = 0
    for (const { value } of this.state.scans.list({
      order: "oldest",
      where: (s) => s.status === "PROCESSING",
    })) {
      let scan: ScanRecord | undefined = value
      while (scan && scan.status === "PROCESSING" && scan.uploadedAtMs !== null) {
        const done = STAGES.filter((stage) => scan?.stages[stage]?.status === "succeeded").length
        if (this.now() < scan.uploadedAtMs + plan.afterMs * done) break
        const started = STAGES.find((stage) => scan?.stages[stage]?.status === "started")
        scan = this.advance(scan.id, started !== undefined && started === plan.failAt)
        applied++
      }
    }
    return applied
  }

  scans(): ScanRecord[] {
    return this.state.scans.list({ order: "oldest" }).map((r) => r.value)
  }
}

export type { PrismRuntime, PrismRuntimeOptions } from "./runtime.js"
export { createRuntime, PRISM_PRESETS } from "./runtime.js"
