import {
  ADMIN_PREFIX,
  type AdminRequest,
  type AdminRoute,
  type AdminRoutes,
  assertAdminPrefixAvailable,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  fromBase64,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { MosaicAPI, SERVER_ERROR_EFFECT } from "./api.js"
import { CANCEL_REASONS, LINE_STATUSES, type TestType } from "./catalog.js"
import { document } from "./generated/openapi.js"
import { normalizeVendorRequest } from "./routing.js"
import { lineWire, type MosaicState, type Result, type Transition } from "./state.js"
import { apiKey, envelope, integer, isRecord, textDate } from "./wire.js"

export type MosaicRuntime = ServiceRuntime<MosaicAPI>
export type MosaicRuntimeOptions = Pick<
  RuntimeOptions<MosaicAPI>,
  | "sqlite"
  | "clock"
  | "seed"
  | "adminPrefix"
  | "adminKey"
  | "adminControls"
  | "onLog"
  | "journalSize"
  | "maxCheckpoints"
>

const PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "The next vendor request answers 429 with Retry-After.",
    rules: [{ pathPrefix: "/api/", status: 429, headers: { "retry-after": "1" }, count: 1 }],
  },
  server_error: {
    description: "The next vendor request answers 500.",
    rules: [{ pathPrefix: "/api/", effect: SERVER_ERROR_EFFECT, count: 1 }],
  },
  timeout: {
    description: "The next vendor request stalls and drops the connection.",
    rules: [{ pathPrefix: "/api/", timeoutMs: 100, count: 1 }],
  },
  unsuccessful: {
    description: "The next vendor request answers 200 with success false.",
    rules: [
      {
        pathPrefix: "/api/",
        status: 200,
        body: envelope(null, "The request could not be completed."),
        count: 1,
      },
    ],
  },
}

const adminError = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })

const stringFields = ["trackingNumber", "courier", "resultFileName", "fileName"] as const
const dateFields = ["shippedDate", "receivedDate", "estimatedCompletion", "completedDate"] as const
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== ""

const parseTransition = (body: unknown): Transition | string => {
  if (
    !isRecord(body) ||
    !integer(body.statusId) ||
    !LINE_STATUSES.some(({ id }) => id === body.statusId)
  ) {
    return "statusId must be a known sales order line status"
  }
  const change: Transition = { statusId: body.statusId }
  for (const key of stringFields) {
    const value = body[key]
    if (value === undefined) continue
    if (!nonempty(value)) return `${key} must be a non-empty string`
    change[key] = value
  }
  for (const key of dateFields) {
    const value = body[key]
    if (value === undefined) continue
    if (!textDate(value)) return `${key} must be a date or timestamp`
    change[key] = value
  }
  if (body.requisitionNumber !== undefined) {
    if (!integer(body.requisitionNumber) || body.requisitionNumber <= 0)
      return "requisitionNumber must be a positive integer"
    change.requisitionNumber = body.requisitionNumber
  }
  if (body.cancelReasonId !== undefined) {
    if (
      !integer(body.cancelReasonId) ||
      !CANCEL_REASONS.some(({ id }) => id === body.cancelReasonId)
    ) {
      return "cancelReasonId must be a known reason"
    }
    change.cancelReasonId = body.cancelReasonId
  }
  return change
}

const parseResult = (body: unknown): Result | string => {
  if (body === undefined) return {}
  if (!isRecord(body)) return "expected a JSON object"
  const result: Result = {}
  const { pdfBase64, reportJson, portalTestTypeId } = body
  if (portalTestTypeId !== undefined) {
    if (!integer(portalTestTypeId)) return "portalTestTypeId must be an integer"
    result.portalTestTypeId = portalTestTypeId
  }
  if (pdfBase64 !== undefined) {
    if (!nonempty(pdfBase64)) return "pdfBase64 must contain a base64 PDF"
    try {
      const bytes = fromBase64(pdfBase64)
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
        return "pdfBase64 must contain a base64 PDF"
    } catch {
      return "pdfBase64 must contain a base64 PDF"
    }
    result.pdfBase64 = pdfBase64
  }
  if (reportJson !== undefined) {
    if (typeof reportJson !== "string") return "reportJson must be a JSON string"
    try {
      JSON.parse(reportJson)
    } catch {
      return "reportJson must be a JSON string"
    }
    result.reportJson = reportJson
  }
  return result
}

const isTestType = (value: unknown): value is TestType =>
  isRecord(value) &&
  integer(value.testTypeId) &&
  (value.testName === null || typeof value.testName === "string") &&
  (value.sampleTypeName === null || typeof value.sampleTypeName === "string") &&
  (value.kitTypeIds === null ||
    (Array.isArray(value.kitTypeIds) && value.kitTypeIds.every(integer))) &&
  (value.price === null || (typeof value.price === "number" && Number.isFinite(value.price)))

const resolveLine = (state: MosaicState, params: AdminRequest["params"]) => {
  if (params.id !== undefined) {
    const value = state.lines.get(params.id)
    return value ? { id: params.id, value } : adminError(404, "order line not found")
  }
  const { salesOrderId, testTypeId } = params
  if (!salesOrderId || !testTypeId || !/^\d+$/.test(salesOrderId) || !/^-?\d+$/.test(testTypeId))
    return adminError(404, "order line not found")
  const matches = state
    .orderLines(Number(salesOrderId))
    .filter(({ value }) => value.portalTestTypeId === Number(testTypeId))
  if (matches.length > 1)
    return adminError(409, "order has multiple lines for this test type; use a line storage id")
  return matches[0] ?? adminError(404, "order line not found")
}

const adminRoutes = (runtime: MosaicRuntime): AdminRoutes => {
  const transition: AdminRoute = ({ namespace, params, body }) => {
    const state = runtime.instance(namespace).state
    const match = resolveLine(state, params)
    if (match instanceof Response) return match
    const { id, value: line } = match
    const order = state.orders.get(String(line.orderId))
    if (!order) return adminError(404, "sales order not found")
    const change = parseTransition(body)
    if (typeof change === "string") return adminError(400, change)
    const conflict = state.lines
      .list({
        where: (other) =>
          [change.fileName, change.resultFileName].some(
            (name) =>
              name !== undefined && (other.fileName === name || other.resultFileName === name),
          ),
      })
      .some((row) => row.id !== id)
    if (conflict) return adminError(409, "result file name already belongs to another order line")
    const next = state.transition(id, line, change, runtime.namespaceClock(namespace).now())
    return Response.json(lineWire(next, order, state.patients.get(String(order.patientAccountId))))
  }
  const putResult: AdminRoute = ({ namespace, params, body }) => {
    const state = runtime.instance(namespace).state
    const match = resolveLine(state, params)
    if (match instanceof Response) return match
    const { id } = match
    const change = parseResult(body)
    if (typeof change === "string") return adminError(400, change)
    const result = { ...state.results.get(id), ...change }
    if (!state.results.update(id, result)) state.results.insert(id, result)
    return Response.json({ lineId: id, hasReportJson: result.reportJson !== undefined })
  }
  return {
    "POST /lines/:id/transition": transition,
    "POST /lines/:salesOrderId/:testTypeId/transition": transition,
    "PUT /lines/:id/result": putResult,
    "PUT /lines/:salesOrderId/:testTypeId/result": putResult,
    "GET /test-types": ({ namespace }) =>
      Response.json({ testTypes: runtime.instance(namespace).state.testTypes() }),
    "PUT /test-types": ({ namespace, body }) => {
      if (!isRecord(body) || !Array.isArray(body.testTypes) || !body.testTypes.every(isTestType)) {
        return adminError(
          400,
          "expected { testTypes: [{ testTypeId, testName, sampleTypeName, kitTypeIds, price }] }",
        )
      }
      const testTypes = body.testTypes.map(
        ({ testTypeId, testName, sampleTypeName, kitTypeIds, price }) => ({
          testTypeId,
          testName,
          sampleTypeName,
          kitTypeIds,
          price,
        }),
      )
      runtime.instance(namespace).state.catalog.insert("testTypes", { testTypes })
      return Response.json({ testTypes })
    },
  }
}

export const createRuntime = (options: MosaicRuntimeOptions = {}): MosaicRuntime => {
  const adminPrefix = options.adminPrefix ?? ADMIN_PREFIX
  assertAdminPrefixAvailable(
    adminPrefix.toLowerCase(),
    Object.keys(document.paths ?? {}).map((path) => path.toLowerCase()),
  )
  const runtime = createServiceRuntime({
    ...options,
    name: "mosaic",
    document,
    credential: apiKey,
    presets: PRESETS,
    create: ({ sqlite, namespace, clock }) => new MosaicAPI({ sqlite, namespace, now: clock.now }),
    admin: adminRoutes,
  })
  const fetch = runtime.fetch
  runtime.fetch = (request) => fetch(normalizeVendorRequest(request, adminPrefix))
  return runtime
}
