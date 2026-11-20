import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import {
  CANCEL_REASONS,
  DEFAULT_TEST_TYPES,
  LANGUAGES,
  LINE_STATUSES,
  resolveState,
  STATUS,
  type TestType,
  US_COUNTRY_ID,
} from "./catalog.js"
import { parseStoredDate, parseWireDate, wireDate } from "./wire.js"

export type PatientInput = {
  practitionerAccountId?: number | null
  customerPatientId?: string | null
  firstName?: string | null
  middleName?: string | null
  lastName?: string | null
  birthDate?: string | null
  sex?: string | null
  weight?: number | null
  phone?: string | null
  phoneCell?: string | null
  allowTextMessages?: boolean | null
  email?: string | null
  address?: string | null
  address2?: string | null
  city?: string | null
  postalCode?: string | null
  countryId?: number | null
  stateId?: number | null
  stateCode?: string | null
  instructionLanguageId?: number
}

export type OrderInput = {
  practitionerAccountId?: number | null
  patientAccountId: number
  kitIds: number[]
  prepaidIds: number[]
  portalTestTypeIds: number[]
  paySourceId?: number | null
  paymentMethodId?: number | null
  shippingMethod?: number | null
  shippingNotificationToPatient?: boolean
  includeBrochure?: boolean
  reimburseInsurance?: boolean
  dropShip?: boolean | null
  dropship?: boolean | null
  shippingCountryId?: number | null
  shippingAddress?: string | null
  shippingAddress2?: string | null
  shippingCity?: string | null
  shippingStateId?: number | null
  shippingState?: string | null
  shippingPostalCode?: string | null
  icD10Code1?: string | null
  icD10Code2?: string | null
  icD10Code3?: string | null
  icD10Code4?: string | null
  icD10Code5?: string | null
  includePediatricBag?: boolean | null
  pediatricBagQuantity?: number | null
}

export type PatientRecord = ReturnType<typeof patientRecord>
export type OrderRecord = ReturnType<typeof orderRecord>
export type LineRecord = {
  orderId: number
  portalTestTypeId: number
  testTypeName: string
  statusId: number
  price: number
  requisitionNumber: number | null
  trackingNumber: string | null
  courier: string | null
  shippedDate: string | null
  receivedDate: string | null
  estimatedCompletion: string | null
  completedDate: string | null
  cancelReasonId: number | null
  resultFileName: string | null
  fileName: string | null
}
export type Result = { pdfBase64?: string; reportJson?: string; portalTestTypeId?: number }
export const resultTestTypeId = (line: LineRecord, result?: Result) =>
  result?.portalTestTypeId ?? line.portalTestTypeId

export type Transition = Partial<
  Pick<
    LineRecord,
    | "trackingNumber"
    | "courier"
    | "shippedDate"
    | "receivedDate"
    | "requisitionNumber"
    | "estimatedCompletion"
    | "completedDate"
    | "resultFileName"
    | "fileName"
    | "cancelReasonId"
  >
> & { statusId: number }

const patientRecord = (
  body: PatientInput,
  patientAccountId: number,
  id: number,
  previous?: { practitionerAccountId: number },
) => {
  const countryId = body.countryId ?? US_COUNTRY_ID
  const stateId = body.stateId ?? 0
  const stateCode = body.stateCode ?? ""
  const state = resolveState(countryId, stateId, stateCode)
  const birthDate = body.birthDate ? wireDate(parseWireDate(body.birthDate)) : null
  return {
    id,
    patientAccountId,
    practitionerAccountId: body.practitionerAccountId ?? previous?.practitionerAccountId ?? 0,
    customerPatientId: body.customerPatientId ?? null,
    firstName: body.firstName ?? "",
    middleName: body.middleName ?? null,
    lastName: body.lastName ?? "",
    birthDate,
    gender: body.sex ?? "",
    weight: body.weight ?? 0,
    phone: body.phone ?? "",
    phoneCell: body.phoneCell ?? null,
    allowTextMessages: body.allowTextMessages ?? null,
    email: body.email ?? "",
    address: body.address ?? "",
    address2: body.address2 ?? "",
    city: body.city ?? "",
    postalCode: body.postalCode ?? "",
    countryId,
    state: state?.code ?? stateCode,
    stateId: state?.id ?? stateId,
    languageId: body.instructionLanguageId ?? 1,
  }
}

const fullName = ({ firstName, lastName }: PatientRecord) =>
  [firstName, lastName].filter(Boolean).join(" ")

export const patientWire = ({ practitionerAccountId, ...patient }: PatientRecord, now: number) => {
  const today = wireDate(now).slice(0, 10)
  const birthday = patient.birthDate?.slice(0, 10)
  const age = birthday
    ? Math.max(
        0,
        Number(today.slice(0, 4)) -
          Number(birthday.slice(0, 4)) -
          Number(today.slice(5) < birthday.slice(5)),
      )
    : null
  return {
    ...patient,
    name: fullName({ ...patient, practitionerAccountId }),
    age,
    createdById: 0,
    physicianId: practitionerAccountId,
    postalCodeId: 0,
    inactive: false,
    comments: null,
    ethnicityId: null,
    fax: null,
    guarantorId: null,
    guardian: null,
    guarantorType: null,
    notifyViaMail: null,
    phoneOther: null,
    phoneWork: null,
    raceId: null,
    relationId: null,
    paymentMethodId: null,
    contactInfos: [],
    insuranceInfo: null,
  }
}

export const isDropShip = (body: OrderInput) => body.dropShip ?? body.dropship ?? false

const orderRecord = (body: OrderInput, patient: PatientRecord, id: number, now: number) => {
  const shippingCountryId = body.shippingCountryId ?? patient.countryId
  const requestedState = body.shippingState ?? patient.state
  const requestedStateId = body.shippingStateId ?? (body.shippingState ? 0 : patient.stateId)
  const state = resolveState(shippingCountryId, requestedStateId, requestedState)
  return {
    id,
    patientAccountId: patient.patientAccountId,
    patientId: patient.id,
    practitionerId: body.practitionerAccountId ?? patient.practitionerAccountId,
    shippingMethod: body.shippingMethod ?? 0,
    shippingNotificationToPatient: body.shippingNotificationToPatient ?? false,
    includeBrochure: body.includeBrochure ?? false,
    paySourceId: body.paySourceId ?? 0,
    paymentMethodId: body.paymentMethodId ?? 0,
    reimburseInsurance: body.reimburseInsurance ?? false,
    icD10Code1: body.icD10Code1 ?? "",
    icD10Code2: body.icD10Code2 ?? "",
    icD10Code3: body.icD10Code3 ?? "",
    icD10Code4: body.icD10Code4 ?? "",
    icD10Code5: body.icD10Code5 ?? "",
    shippingCountryId,
    shippingAddress: body.shippingAddress ?? patient.address,
    shippingAddress2: body.shippingAddress2 ?? patient.address2,
    shippingCity: body.shippingCity ?? patient.city,
    shippingStateId: state?.id ?? requestedStateId,
    shippingState: state?.code ?? requestedState,
    shippingPostalCode: body.shippingPostalCode ?? patient.postalCode,
    dropShip: isDropShip(body),
    dropShipId: null as number | null,
    kitIds: body.kitIds.filter((kitId) => kitId !== 0),
    portalTestTypeIds: body.portalTestTypeIds,
    dateCreated: new Date(now).toISOString(),
    includePediatricBag: body.includePediatricBag ?? false,
    pediatricBagQuantity: body.pediatricBagQuantity ?? 0,
  }
}

const lineDateWire = (value: string | null) =>
  value === null ? null : wireDate(parseStoredDate(value))

export const orderWire = ({ patientAccountId, ...order }: OrderRecord, lines: LineRecord[]) => ({
  ...order,
  dateCreated: wireDate(parseStoredDate(order.dateCreated), "milliseconds"),
  sampleReceivedDate: lineDateWire(
    lines.find((line) => line.receivedDate !== null)?.receivedDate ?? null,
  ),
  requisitionNumber:
    lines.find((line) => line.requisitionNumber !== null)?.requisitionNumber ?? null,
  dropShipId: order.dropShipId ?? null,
  distributorId: null,
  shippingPostalCodeId: 0,
  guarantorId: null,
  totalShippingFee: null,
  totalOvernightFee: null,
  multiTestDiscount: null,
  otherParty: null,
  courier: null,
  legacyOrder: null,
  portalTestTypeAttributes: [],
  discounts: [],
  batchId: null,
  delayShipping: null,
})

export const lineWire = (line: LineRecord, order: OrderRecord, patient?: PatientRecord) => {
  const language =
    line.requisitionNumber !== null && patient
      ? LANGUAGES.find(({ id }) => id === patient.languageId)
      : undefined
  return {
    ...line,
    patientId: order.patientId,
    patientName: patient ? fullName(patient) : "",
    practitionerId: order.practitionerId,
    practitionerName: "Example Practitioner",
    status: LINE_STATUSES.find(({ id }) => id === line.statusId)?.name ?? "",
    canCancel: line.statusId === STATUS.placed,
    canEdit: line.statusId === STATUS.placed,
    salesOrderDateCreated: wireDate(parseStoredDate(order.dateCreated)),
    shippedDate: lineDateWire(line.shippedDate),
    receivedDate: lineDateWire(line.receivedDate),
    estimatedCompletion: lineDateWire(line.estimatedCompletion),
    completedDate: lineDateWire(line.completedDate),
    languageId: language?.id ?? 0,
    language: language?.name ?? null,
    languageIds: language ? [language.id] : [],
    secondFileName: null,
    legacyOrder: null,
    standardPrice: line.price,
    discountedPrice: line.price,
    discountPercentage: 0,
    multiTestDiscountPercentage: 0,
    stopPatientReporting: false,
    stopDownloadResults: false,
    panelId: null,
    panelName: null,
    needsCaliforniaDisclosure: false,
    californiaDisclosure: null,
    kitId: null,
    hasPaperTRFFee: false,
  }
}

export class MosaicState {
  readonly patients: Collection<PatientRecord>
  readonly orders: Collection<OrderRecord>
  readonly lines: Collection<LineRecord>
  readonly results: Collection<Result>
  readonly catalog: Collection<{ testTypes: readonly TestType[] }>
  private readonly ids: IdSequence

  constructor(
    private readonly sqlite: SqliteClient,
    namespace: string,
  ) {
    this.patients = new Collection(sqlite, namespace, "patients")
    this.orders = new Collection(sqlite, namespace, "orders")
    this.lines = new Collection(sqlite, namespace, "lines")
    this.results = new Collection(sqlite, namespace, "results")
    this.catalog = new Collection(sqlite, namespace, "catalog")
    this.ids = new IdSequence(sqlite, namespace, "mosaic")
  }

  private nextInteger(prefix: string) {
    const token = this.ids.next(prefix, 8).slice(prefix.length)
    return (Number.parseInt(token, 36) % 900_000_000) + 100_000_000
  }

  savePatient(body: PatientInput, previous?: PatientRecord) {
    return this.sqlite.transaction(() => {
      let accountId = previous?.patientAccountId ?? this.nextInteger("account") * 2
      while (!previous && this.patients.has(String(accountId)))
        accountId = this.nextInteger("account") * 2
      let id = previous?.id ?? this.nextInteger("patient") * 2 + 1
      while (!previous && this.patients.list({ where: (patient) => patient.id === id }).length) {
        id = this.nextInteger("patient") * 2 + 1
      }
      const patient = patientRecord(
        previous
          ? {
              ...previous,
              sex: previous.gender,
              instructionLanguageId: previous.languageId,
              stateCode: previous.state,
              ...body,
              ...(body.stateId === undefined &&
              (body.stateCode !== undefined || body.countryId !== undefined)
                ? { stateId: 0 }
                : {}),
            }
          : body,
        accountId,
        id,
        previous,
      )
      if (previous) this.patients.update(String(accountId), patient)
      else this.patients.insert(String(accountId), patient)
      return patient
    })
  }

  testTypes() {
    return this.catalog.get("testTypes")?.testTypes ?? DEFAULT_TEST_TYPES
  }

  createOrder(body: OrderInput, patient: PatientRecord, now: number) {
    return this.sqlite.transaction(() => {
      const tests = this.testTypes()
      const orderedTests = body.portalTestTypeIds.map((id) =>
        tests.find((row) => row.testTypeId === id),
      )
      if (orderedTests.some((test) => test === undefined)) return undefined
      let id = this.nextInteger("order")
      while (this.orders.has(String(id))) id = this.nextInteger("order")
      const order = orderRecord(body, patient, id, now)
      this.orders.insert(String(id), order)
      for (const [index, portalTestTypeId] of body.portalTestTypeIds.entries()) {
        const test = orderedTests[index]
        this.lines.insert(`${id}-${index + 1}`, {
          orderId: id,
          portalTestTypeId,
          testTypeName: test?.testName ?? "",
          price: test?.price ?? 0,
          statusId: STATUS.placed,
          requisitionNumber: null,
          trackingNumber: null,
          courier: null,
          shippedDate: null,
          receivedDate: null,
          estimatedCompletion: null,
          completedDate: null,
          cancelReasonId: null,
          resultFileName: null,
          fileName: null,
        })
      }
      return order
    })
  }

  orderLines(orderId: number) {
    return this.lines.list({ order: "oldest", where: (line) => line.orderId === orderId })
  }

  cancel(orderId: number, testTypeIds: number[], cancelReasonId: number) {
    if (!CANCEL_REASONS.some(({ id }) => id === cancelReasonId)) return
    this.sqlite.transaction(() => {
      const lines = this.orderLines(orderId).filter(({ value }) =>
        testTypeIds.includes(value.portalTestTypeId),
      )
      for (const { id, value } of lines) {
        if (value.statusId === STATUS.placed) {
          this.lines.update(id, { ...value, statusId: STATUS.cancelled, cancelReasonId })
        }
      }
    })
  }

  transition(id: string, line: LineRecord, change: Transition, now: number) {
    return this.sqlite.transaction(() => this.applyTransition(id, line, change, now))
  }

  private nextRequisitionNumber() {
    const next = () => 1_000_000_000 + this.nextInteger("requisition")
    let number = next()
    while (this.lines.list({ where: (line) => line.requisitionNumber === number }).length)
      number = next()
    return number
  }

  private applyTransition(id: string, line: LineRecord, change: Transition, now: number) {
    const second = Math.floor(now / 1000) * 1000
    const stamp = new Date(second).toISOString()
    const next = { ...line, ...change }
    if (change.statusId === STATUS.processing || change.statusId === STATUS.completed) {
      next.requisitionNumber ??= this.nextRequisitionNumber()
      next.estimatedCompletion ??= new Date(second + 7 * 86_400_000).toISOString()
    }
    switch (change.statusId) {
      case STATUS.shipped:
        next.trackingNumber ??= `TRACK-${id}`
        next.courier ??= "Example Courier"
        next.shippedDate ??= stamp
        break
      case STATUS.processing:
        next.receivedDate ??= stamp
        break
      case STATUS.completed:
        next.completedDate ??= stamp
        next.resultFileName =
          change.resultFileName ?? change.fileName ?? next.resultFileName ?? `result-${id}.pdf`
        next.fileName =
          change.fileName ?? change.resultFileName ?? next.fileName ?? next.resultFileName
        break
    }
    const order = this.orders.get(String(line.orderId))
    const shippingStatuses: readonly number[] = [
      STATUS.shipped,
      STATUS.inTransit,
      STATUS.processing,
      STATUS.completed,
      STATUS.downloaded,
    ]
    if (
      order?.dropShip &&
      order.dropShipId == null &&
      (next.shippedDate || shippingStatuses.includes(next.statusId))
    ) {
      this.orders.update(String(order.id), { ...order, dropShipId: this.nextInteger("drop-ship") })
    }
    this.lines.update(id, next)
    return next
  }
}
