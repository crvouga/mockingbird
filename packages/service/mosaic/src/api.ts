import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  jsonRes,
  type OperationContext,
} from "@crvouga/mockingbird-service"
import {
  CANCEL_REASONS,
  COUNTRIES,
  LANGUAGES,
  LINE_STATUSES,
  STATES,
  STATUS,
  US_COUNTRY_ID,
} from "./catalog.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { fixturePdf } from "./pdf.js"
import { normalizeVendorRequest } from "./routing.js"
import {
  isDropShip,
  lineWire,
  MosaicState,
  type OrderInput,
  orderWire,
  type PatientInput,
  patientWire,
  resultTestTypeId,
} from "./state.js"
import {
  apiKey,
  envelope,
  input,
  ok,
  parseWireDate,
  problem,
  query,
  queryValue,
  textDate,
  unauthenticated,
} from "./wire.js"

export type MosaicAPIOptions = APIOptions & { now?: () => number }
const MISSING_REFERENCE = "Object reference not set to an instance of an object."
export const SERVER_ERROR_EFFECT = "mosaic_server_error"

const missingPatient = () => jsonRes(200, envelope(null, MISSING_REFERENCE))
const pathId = (context: OperationContext, name: string, read: (id: number) => Response) => {
  const value = context.params[name] ?? ""
  const id = Number(value)
  return /^-?\d+$/.test(value) && Number.isSafeInteger(id) ? read(id) : problem(context, 400)
}
const tagged = (response: Response, ids: Record<string, number | string>) =>
  annotateResponse(response, {
    ids: Object.fromEntries(Object.entries(ids).map(([key, value]) => [key, String(value)])),
  })

const textMatches = (filter: string | undefined, value: string) =>
  filter === undefined || filter.toLowerCase() === value.toLowerCase()

const dateInRange = (value: string | null, from?: string, to?: string) => {
  if (!from && !to) return true
  if (!value) return false
  const time = parseWireDate(value)
  return (!from || time >= parseWireDate(from)) && (!to || time <= parseWireDate(to))
}

export class MosaicAPI implements FetchAPI {
  readonly state: MosaicState
  private readonly service: ReturnType<typeof createService>

  constructor(options: MosaicAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? "mosaic"
    this.state = new MosaicState(sqlite, namespace)
    const serverError = (request: Request) =>
      faultEffect(request, SERVER_ERROR_EFFECT) ? problem({ sqlite, namespace }, 500) : undefined
    const handlers = defineOperations<SupportedOperationId>({
      CreatePatient: (context) => this.savePatient(context),
      GetPatient: (context) =>
        pathId(context, "patientAccountId", (id) => {
          const patient = this.state.patients.get(String(id))
          return patient
            ? tagged(ok(patientWire(patient, context.now())), { patientAccountId: id })
            : missingPatient()
        }),
      ListPatients: (context) => this.listPatients(context),
      UpdatePatient: (context) => this.savePatient(context, true),
      CreateOrder: (context) =>
        input<OrderInput>(context, (body) => {
          const patient = this.state.patients.get(String(body.patientAccountId))
          if (!patient) {
            const error = isDropShip(body)
              ? "Patient required with dropship order."
              : "Something went wrong saving the data. StatusCode:BadRequest"
            return jsonRes(200, envelope(0, error))
          }
          const order = this.state.createOrder(body, patient, context.now())
          if (!order) return jsonRes(200, envelope(0, MISSING_REFERENCE))
          return tagged(ok(order.id), {
            orderId: order.id,
            patientAccountId: patient.patientAccountId,
          })
        }),
      GetOrder: (context) =>
        pathId(context, "salesOrderId", (id) => {
          const order = this.state.orders.get(String(id))
          return tagged(
            ok(
              order
                ? orderWire(
                    order,
                    this.state.orderLines(id).map(({ value }) => value),
                  )
                : null,
            ),
            { orderId: id },
          )
        }),
      ListOrderLines: (context) => this.listLines(context),
      CancelOrderLines: (context) =>
        input<{ salesOrderId: number; portalTestTypeIds: number[]; cancelReasonId: number }>(
          context,
          (body) => {
            this.state.cancel(body.salesOrderId, body.portalTestTypeIds, body.cancelReasonId)
            return tagged(ok(true), { orderId: body.salesOrderId })
          },
        ),
      ListLineStatuses: () => ok(LINE_STATUSES),
      ListCancelReasons: () => ok(CANCEL_REASONS),
      ListResults: (context) =>
        pathId(context, "salesOrderId", (orderId) => {
          const files = this.state.orderLines(orderId).flatMap(({ id, value: line }) => {
            const fileName = line.resultFileName
            if (!fileName) return []
            return [
              { portalTestTypeId: resultTestTypeId(line, this.state.results.get(id)), fileName },
            ]
          })
          return tagged(ok(files), { orderId })
        }),
      DownloadResult: (context) => this.downloadResult(context),
      GetReportJson: (context) =>
        pathId(context, "testTypeId", (testTypeId) => {
          const reqNum = queryValue(context, "reqNum")
          const lines = this.state.lines.list({
            where: (line) =>
              line.requisitionNumber !== null && String(line.requisitionNumber) === reqNum,
          })
          const report = lines
            .map(({ id, value: line }) => {
              const result = this.state.results.get(id)
              return resultTestTypeId(line, result) === testTypeId ? result?.reportJson : undefined
            })
            .find((value) => value !== undefined)
          return jsonRes(200, envelope(report ?? "", null, report !== undefined))
        }),
      ListTestTypes: () => jsonRes(200, this.state.testTypes()),
      ListCountries: () => jsonRes(200, COUNTRIES),
      ListStates: (context) =>
        query(context, [["CountryId", "id"]], (get) =>
          ok(
            STATES.filter((state) => state.countryId === Number(get("CountryId") ?? US_COUNTRY_ID)),
          ),
        ),
      ListLanguages: () => jsonRes(200, LANGUAGES),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: options.now ?? Date.now,
      before: ({ request }) =>
        serverError(request) ?? (apiKey(request) ? undefined : unauthenticated()),
      notFound: (request) =>
        serverError(request) ??
        (apiKey(request) ? problem({ sqlite, namespace }, 404) : unauthenticated()),
      unsupported: (request, operation) =>
        serverError(request) ??
        (apiKey(request)
          ? jsonRes(501, {
              message: `Mockingbird: ${operation.operationId} is not implemented`,
              code: "mockingbird_unsupported",
            })
          : unauthenticated()),
      onError: () => problem({ sqlite, namespace }, 500),
    })
  }

  fetch(request: Request) {
    return this.service.fetch(normalizeVendorRequest(request))
  }

  reset() {
    return this.service.reset()
  }

  private savePatient(context: OperationContext, update = false) {
    return input<PatientInput & { patientAccountId?: number }>(context, (body) => {
      if (!update && Object.keys(body).every((key) => key === "practitionerAccountId"))
        return problem(context, 400)
      if (body.birthDate != null && !textDate(body.birthDate)) return problem(context, 400)
      const previous = update ? this.state.patients.get(String(body.patientAccountId)) : undefined
      if (update && !previous) return problem(context, 404)
      const patient = this.state.savePatient(body, previous)
      return tagged(
        update ? jsonRes(200, patientWire(patient, context.now())) : ok(patient.patientAccountId),
        { patientAccountId: patient.patientAccountId },
      )
    })
  }

  private listPatients(context: OperationContext) {
    return query(
      context,
      [
        ["PractitionerAccountId", "id"],
        ["BirthDate", "date"],
      ],
      (get) => {
        const practitioner = get("PractitionerAccountId")
        const birthDate = get("BirthDate")
        const rows = this.state.patients.list({
          where: (patient) =>
            (practitioner === undefined ||
              patient.practitionerAccountId === Number(practitioner)) &&
            textMatches(get("Email"), patient.email) &&
            textMatches(get("FirstName"), patient.firstName) &&
            textMatches(get("LastName"), patient.lastName) &&
            textMatches(
              get("FullName"),
              [patient.firstName, patient.lastName].filter(Boolean).join(" "),
            ) &&
            (birthDate === undefined || birthDate.slice(0, 10) === patient.birthDate?.slice(0, 10)),
        })
        return ok(rows.map(({ value }) => patientWire(value, context.now())))
      },
    )
  }

  private listLines(context: OperationContext) {
    const numeric = [
      "PageIndex",
      "RecordsPerPage",
      "OrderIdFrom",
      "OrderIdTo",
      "PractitionerAccountId",
      "PatientAccountId",
      "TestTypeId",
      "SalesOrderLineStatusId",
    ].map((name) => [name, "id"] as const)
    const dates = [
      "ReceivedDateFrom",
      "ReceivedDateTo",
      "CompletedDateFrom",
      "CompletedDateTo",
    ].map((name) => [name, "date"] as const)
    return query(context, [...numeric, ...dates], (get) => {
      const number = (name: string, fallback: number) => Number(get(name) ?? fallback)
      const equals = (name: string, actual: number) => number(name, actual) === actual
      const pageIndex = number("PageIndex", 1)
      const perPage = number("RecordsPerPage", 50)
      if (pageIndex < 0 || perPage < 1) return problem(context, 400)
      const rows = this.state.lines.list({ order: "oldest" }).flatMap(({ value: line }) => {
        const order = this.state.orders.get(String(line.orderId))
        if (
          !order ||
          line.orderId < number("OrderIdFrom", line.orderId) ||
          line.orderId > number("OrderIdTo", line.orderId) ||
          !equals("PractitionerAccountId", order.practitionerId) ||
          !equals("PatientAccountId", order.patientAccountId) ||
          !equals("TestTypeId", line.portalTestTypeId) ||
          !equals("SalesOrderLineStatusId", line.statusId) ||
          !dateInRange(line.receivedDate, get("ReceivedDateFrom"), get("ReceivedDateTo")) ||
          !dateInRange(line.completedDate, get("CompletedDateFrom"), get("CompletedDateTo"))
        )
          return []
        return [lineWire(line, order, this.state.patients.get(String(order.patientAccountId)))]
      })
      const offset = Math.max(0, pageIndex - 1) * perPage
      return jsonRes(200, {
        totalRecords: rows.length,
        pageIndex,
        ...envelope(rows.slice(offset, offset + perPage)),
      })
    })
  }

  private downloadResult(context: OperationContext) {
    const fileName = queryValue(context, "fileName")
    const match = this.state.lines.list({
      where: (line) =>
        typeof fileName === "string" &&
        fileName !== "" &&
        (line.resultFileName === fileName || line.fileName === fileName),
    })[0]
    if (!match) return problem(context, 404)
    const { id, value: line } = match
    const result = this.state.results.get(id)
    const pdf = result?.pdfBase64 ? Uint8Array.from(fromBase64(result.pdfBase64)) : fixturePdf()
    const response = new Response(pdf, { headers: { "content-type": "application/pdf" } })
    if (line.statusId === STATUS.completed) {
      this.state.transition(id, line, { statusId: STATUS.downloaded }, context.now())
    }
    return tagged(response, { orderId: line.orderId })
  }
}
