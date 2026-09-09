import {
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import type { JunctionState, OrderRecord } from "./state.js"
import { LAB_TEST_CATALOG, labTestById, MOCK_TEAM_ID } from "./state.js"

type AoeQuestion = {
  id: number
  required: boolean
  code: string
  value: string
  type: string
  sequence: number
  answers: Array<{ id: number; code: string; value: string }>
  constraint: unknown
  default: unknown
}

const aoeQuestion = (markerId: number, questionId: number): AoeQuestion | undefined => {
  for (const test of LAB_TEST_CATALOG) {
    for (const marker of test.markers ?? []) {
      if (marker.id !== markerId) continue
      const aoe = marker.aoe as { questions?: AoeQuestion[] } | null | undefined
      if (!aoe) return undefined
      return aoe.questions?.find((question) => question.id === questionId) ?? undefined
    }
  }
  return undefined
}

function notFound(message: string): never {
  throw new HttpError(404, { detail: message })
}

const queryInt = (context: OperationContext, name: string, fallback: number): number => {
  const raw = context.query[name]
  if (raw === undefined) return fallback
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw))
    throw new HttpError(422, { detail: `${name} must be an integer` })
  return Number(raw)
}

const jsonObject = (context: OperationContext): Record<string, unknown> => {
  const body = context.body
  const value = body.kind === "json" ? body.value : undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(422, {
      detail: [
        {
          type: "model_attributes_type",
          loc: ["body"],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: value,
        },
      ],
    })
  }
  return value as Record<string, unknown>
}

/** Pydantic `str_strip_whitespace`: trim every string value before validation and use. */
const trimStrings = (value: unknown): unknown => {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map(trimStrings)
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = trimStrings(entry)
    return out
  }
  return value
}

const patientDetails = (input: Record<string, unknown>): Record<string, unknown> => ({
  ...input,
  dob:
    typeof input.dob === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dob)
      ? `${input.dob}T00:00:00+00:00`
      : input.dob,
  medical_proxy: null,
  race: null,
  ethnicity: null,
  sexual_orientation: null,
  gender_identity: null,
})

const patientAddress = (input: Record<string, unknown>): Record<string, unknown> => ({
  ...input,
  second_line: null,
  access_notes: null,
})

const isValidDate = (value: string): boolean => {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const y = year ?? 0
  const m = month ?? 0
  const d = day ?? 0
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

const missingError = (loc: Array<string | number>, input: unknown) => ({
  type: "missing",
  loc,
  msg: "Field required",
  input,
})

const stringTypeError = (loc: string[], value: unknown) => ({
  type: "string_type",
  loc,
  msg: "Input should be a valid string",
  input: value,
})

const stringTooShortError = (loc: string[], value: string) => ({
  type: "string_too_short",
  loc,
  msg: "String should have at least 1 character",
  input: value,
  ctx: { min_length: 1 },
})

const patternError = (loc: string[], value: unknown, pattern: string) => ({
  type: "string_pattern_mismatch",
  loc,
  msg: `String should match pattern '${pattern}'`,
  input: value,
  ctx: { pattern },
})

const stateError = (value: unknown) => ({
  type: "value_error",
  loc: ["body", "patient_address", "state"],
  msg: `Value error, Invalid state: ${value}`,
  input: value,
  ctx: { error: {} },
})

const phoneError = (loc: string[], value: unknown) => ({
  type: "value_error",
  loc,
  msg: `Value error, Invalid phone number: ${value}`,
  input: value,
  ctx: { error: {} },
})

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const uuidError = (value: string, index?: number, loc?: string[]) => {
  const characters = Array.from(value)
  const invalidIndex = characters.findIndex((character) => !/^[0-9a-f-]$/i.test(character))
  const error =
    invalidIndex >= 0
      ? `invalid character: expected an optional prefix of \`urn:uuid:\` followed by [0-9a-fA-F-], found \`${characters[invalidIndex]}\` at ${invalidIndex + 1}`
      : `invalid length: expected length 32 for simple format, found ${value.replaceAll("-", "").length}`
  return {
    type: "uuid_parsing",
    loc:
      loc ??
      (index === undefined
        ? ["body", "lab_account_id"]
        : ["body", "order_set", "lab_test_ids", index]),
    msg: `Input should be a valid UUID, ${error}`,
    input: value,
    ctx: { error },
  }
}

const isValidPhone = (value: string): boolean => {
  const digits = value.replace(/\D/g, "")
  if (digits.length < 10 || digits.length > 15) return false
  if (/[a-zA-Z]/.test(value)) return false
  if (digits.length === 10 || digits.length === 11) {
    const area = digits.length === 11 ? digits.slice(1, 4) : digits.slice(0, 3)
    if (area[0] === "0" || area[0] === "1") return false
  }
  return true
}

const isValidName = (value: string): boolean => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 .,'-]*$/.test(value)) return false
  if (/\s\s/.test(value)) return false
  return true
}

const nameError = (field: string, value: unknown) => ({
  type: "value_error",
  loc: ["body", "patient_details", field],
  msg: "Value error, The field must start with a letter (a-z or A-Z or 0-9) and can only contain -,. special characters, but cannot start with a space or hyphen.",
  input: value,
  ctx: { error: {} },
})

const pyIso = (value: string): string => {
  const d = new Date(value)
  const iso = d.toISOString()
  const [date, time = ""] = iso.split("T")
  const match = time.match(/\.(\d+)Z$/)
  const ms = (match?.[1] ?? "000").padEnd(6, "0")
  return `${date}T${time.slice(0, 8)}.${ms}+00:00`
}

const orderValidation = (body: Record<string, unknown>): unknown[] => {
  const errors: unknown[] = []
  const userId = body.user_id
  if (userId === undefined) errors.push(missingError(["body", "user_id"], body))
  else if (typeof userId !== "string") errors.push(stringTypeError(["body", "user_id"], userId))
  else if (!isUuid(userId)) errors.push(uuidError(userId))
  const labAccountId = body.lab_account_id
  if (typeof labAccountId === "string" && !isUuid(labAccountId)) {
    errors.push(uuidError(labAccountId))
  }
  const os = body.order_set
  if (os === undefined) {
    errors.push(missingError(["body", "order_set"], body))
  } else if (typeof os !== "object" || os === null || Array.isArray(os)) {
    errors.push({
      type: "model_attributes_type",
      loc: ["body", "order_set"],
      msg: "Input should be a valid dictionary or object to extract fields from",
      input: os,
    })
  } else {
    const o = os as Record<string, unknown>
    const ids = o.lab_test_ids
    if (ids === undefined) errors.push(missingError(["body", "order_set", "lab_test_ids"], o))
    else if (!Array.isArray(ids)) {
      errors.push({
        type: "string_type",
        loc: ["body", "order_set", "lab_test_ids"],
        msg: "Input should be a valid string",
        input: ids,
      })
    } else {
      ids.forEach((id, index) => {
        if (typeof id !== "string" || !isUuid(id)) errors.push(uuidError(String(id), index))
      })
    }
  }
  const pd = body.patient_details
  if (pd === undefined) {
    errors.push(missingError(["body", "patient_details"], body))
  } else if (typeof pd !== "object" || pd === null || Array.isArray(pd)) {
    errors.push({
      type: "model_attributes_type",
      loc: ["body", "patient_details"],
      msg: "Input should be a valid dictionary or object to extract fields from",
      input: pd,
    })
  } else {
    const p = pd as Record<string, unknown>
    for (const field of ["first_name", "last_name", "dob", "gender", "phone_number", "email"]) {
      if (p[field] === undefined) errors.push(missingError(["body", "patient_details", field], p))
      else if (typeof p[field] !== "string")
        errors.push(stringTypeError(["body", "patient_details", field], p[field]))
      else if (
        (field === "first_name" || field === "last_name") &&
        typeof p[field] === "string" &&
        p[field].length === 0
      )
        errors.push(stringTooShortError(["body", "patient_details", field], p[field]))
      else if (
        (field === "first_name" || field === "last_name") &&
        !isValidName(p[field] as string)
      )
        errors.push(nameError(field, p[field]))
      else if (field === "email" && (p[field] as string) === "") {
        errors.push({
          type: "value_error",
          loc: ["body", "patient_details", "email"],
          msg: "value is not a valid email address: An email address must have an @-sign.",
          input: p[field],
          ctx: { reason: "An email address must have an @-sign." },
        })
      } else if (field === "dob") {
        const dob = p[field] as string
        if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
          if (new Date(`${dob}T00:00:00Z`).getTime() > Date.now()) {
            errors.push({
              type: "value_error",
              loc: ["body", "patient_details", "dob"],
              msg: "Value error, dob cannot be in the future",
              input: `${dob}T00:00:00+00:00`,
              ctx: { error: {} },
            })
          }
          continue
        }
        if (/^\d{4}-\d{2}-\d{2}T/.test(dob)) {
          if (!/^\d{4}-\d{2}-\d{2}T00:00:00/.test(dob)) {
            errors.push({
              type: "date_from_datetime_inexact",
              loc: ["body", "patient_details", "dob"],
              msg: "Datetimes provided to dates should have zero time - e.g. be exact dates",
              input: pyIso(dob),
            })
          } else {
            const dateOnly = dob.slice(0, 10)
            if (new Date(`${dateOnly}T00:00:00Z`).getTime() > Date.now()) {
              errors.push({
                type: "value_error",
                loc: ["body", "patient_details", "dob"],
                msg: "Value error, dob cannot be in the future",
                input: `${dateOnly}T00:00:00+00:00`,
                ctx: { error: {} },
              })
            }
          }
        } else if (!isValidDate(dob)) {
          errors.push({
            type: "date_from_datetime_parsing",
            loc: ["body", "patient_details", "dob"],
            msg: "Input should be a valid date or datetime, invalid character in year",
            input: dob,
            ctx: { error: "invalid character in year" },
          })
        }
      } else if (field === "phone_number" && !isValidPhone(p[field] as string)) {
        errors.push(phoneError(["body", "patient_details", "phone_number"], p[field]))
      }
    }
  }
  const pa = body.patient_address
  if (pa === undefined) {
    errors.push(missingError(["body", "patient_address"], body))
  } else if (typeof pa !== "object" || pa === null || Array.isArray(pa)) {
    errors.push({
      type: "model_attributes_type",
      loc: ["body", "patient_address"],
      msg: "Input should be a valid dictionary or object to extract fields from",
      input: pa,
    })
  } else {
    const a = pa as Record<string, unknown>
    for (const field of ["first_line", "city", "state", "zip", "country"]) {
      if (a[field] === undefined) errors.push(missingError(["body", "patient_address", field], a))
      else if (typeof a[field] !== "string")
        errors.push(stringTypeError(["body", "patient_address", field], a[field]))
    }
    if (typeof a.state === "string" && !/^[A-Z]{2}$/.test(a.state)) {
      errors.push(stateError(a.state))
    }
    if (typeof a.zip === "string" && !/^\d{5}(-\d{4})?$/.test(a.zip)) {
      errors.push(patternError(["body", "patient_address", "zip"], a.zip, "^\\d{5}(-\\d{4})?$"))
    }
    if (typeof a.phone_number === "string" && !isValidPhone(a.phone_number)) {
      errors.push(phoneError(["body", "patient_address", "phone_number"], a.phone_number))
    }
  }
  return errors
}

const aoeValidationError = (body: Record<string, unknown>): string | undefined => {
  const answers = body.aoe_answers
  if (!Array.isArray(answers)) return undefined
  for (const answer of answers) {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) continue
    const record = answer as Record<string, unknown>
    if (typeof record.marker_id !== "number") continue
    const marker = LAB_TEST_CATALOG.flatMap((test) => test.markers ?? []).find(
      (entry) => entry.id === record.marker_id,
    )
    if (!marker?.aoe) return `Marker id ${record.marker_id} does not have AOE.`
    const question = aoeQuestion(record.marker_id, record.question_id as number)
    if (!question)
      return `Invalid question_id ${String(record.question_id)} for marker id ${record.marker_id}.`
    const answerCode = typeof record.answer === "string" ? record.answer.toUpperCase() : ""
    if (!question.answers.some((entry) => entry.code === answerCode))
      return `Invalid answer ${answerCode} for question ${question.value}.`
  }
  return undefined
}

const METHOD_DETAILS = (method: string, id: string, at: string) => {
  switch (method) {
    case "testkit":
      return {
        type: "testkit",
        data: { id, shipment: null, created_at: at, updated_at: at },
      }
    case "walk_in_test":
    case "on_site_collection":
      return {
        type: method,
        data: { id, appointment_id: null, created_at: at, updated_at: at },
      }
    default:
      return {
        type: method,
        data: { id, appointment_id: null, created_at: at, updated_at: at },
      }
  }
}

const PHYSICIAN = { first_name: "Leo", last_name: "Damasco", npi: "1134326366" }
const FINAL_STATUSES = [
  "received.walk_in_test.ordered",
  "received.walk_in_test.requisition_created",
  "received.walk_in_test.requisition_bypassed",
  "completed.walk_in_test.completed",
  "sample_with_lab.walk_in_test.partial_results",
  "failed.walk_in_test.sample_error",
  "cancelled.walk_in_test.cancelled",
  "collecting_sample.walk_in_test.appointment_pending",
  "collecting_sample.walk_in_test.appointment_scheduled",
  "collecting_sample.walk_in_test.appointment_cancelled",
  "collecting_sample.walk_in_test.redraw_available",
  "received.at_home_phlebotomy.ordered",
  "received.at_home_phlebotomy.requisition_created",
  "received.at_home_phlebotomy.requisition_bypassed",
  "collecting_sample.at_home_phlebotomy.appointment_pending",
  "collecting_sample.at_home_phlebotomy.appointment_scheduled",
  "collecting_sample.at_home_phlebotomy.draw_completed",
  "collecting_sample.at_home_phlebotomy.appointment_cancelled",
  "completed.at_home_phlebotomy.completed",
  "sample_with_lab.at_home_phlebotomy.partial_results",
  "cancelled.at_home_phlebotomy.cancelled",
  "failed.at_home_phlebotomy.sample_error",
  "received.testkit.ordered",
  "received.testkit.awaiting_registration",
  "received.testkit.requisition_created",
  "received.testkit.requisition_bypassed",
  "received.testkit.registered",
  "collecting_sample.testkit.transit_customer",
  "collecting_sample.testkit.out_for_delivery",
  "collecting_sample.testkit.with_customer",
  "collecting_sample.testkit.transit_lab",
  "sample_with_lab.testkit.delivered_to_lab",
  "sample_with_lab.testkit.lab_processing_blocked",
  "completed.testkit.completed",
  "failed.testkit.failure_to_deliver_to_customer",
  "failed.testkit.failure_to_deliver_to_lab",
  "failed.testkit.sample_error",
  "failed.testkit.lost",
  "cancelled.testkit.cancelled",
  "cancelled.testkit.do_not_process",
  "collecting_sample.testkit.problem_in_transit_customer",
  "collecting_sample.testkit.problem_in_transit_lab",
  "received.on_site_collection.ordered",
  "received.on_site_collection.requisition_created",
  "received.on_site_collection.requisition_bypassed",
  "sample_with_lab.on_site_collection.draw_completed",
  "completed.on_site_collection.completed",
  "cancelled.on_site_collection.cancelled",
  "sample_with_lab.on_site_collection.partial_results",
  "failed.on_site_collection.sample_error",
  "completed.walk_in_test.corrected",
  "completed.at_home_phlebotomy.corrected",
  "completed.on_site_collection.corrected",
  "completed.testkit.corrected",
] as const

const finalStatusError = (value: string) => ({
  type: "enum",
  loc: ["query", "final_status"],
  msg: `Input should be ${FINAL_STATUSES.map((status) => `'${status}'`)
    .join(", ")
    .replace(/, ([^,]*)$/, " or $1")}`,
  input: value,
  ctx: { expected: FINAL_STATUSES.map((status) => `'${status}'`).join(", ") },
})

export const orderHandlers = (state: JunctionState) => ({
  get_paginated_lab_tests_for_team_v3_lab_test_get: async () =>
    jsonRes(200, { data: LAB_TEST_CATALOG, next_cursor: null }),

  get_lab_test_for_team_v3_lab_tests__lab_test_id__get: async (context: OperationContext) => {
    const id = context.params.lab_test_id ?? ""
    const test = labTestById(id)
    if (!test) notFound("Lab test does not exist")
    return jsonRes(200, test)
  },

  create_order_v3_order_post: async (context: OperationContext) => {
    const rawBody = jsonObject(context)
    const body = trimStrings(rawBody) as Record<string, unknown>
    body.aoe_answers = rawBody.aoe_answers
    const patient = rawBody.patient_details
    if (
      typeof patient === "object" &&
      patient !== null &&
      !Array.isArray(patient) &&
      Object.entries(patient).some(
        ([key, value]) => ["first_name", "last_name"].includes(key) && typeof value !== "string",
      )
    ) {
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    const errors = orderValidation(body)
    if (errors.length > 0) throw new HttpError(422, { detail: errors })
    const rawAddress = body.patient_address
    if (
      typeof rawAddress === "object" &&
      rawAddress !== null &&
      !Array.isArray(rawAddress) &&
      typeof (rawAddress as Record<string, unknown>).country === "string" &&
      /[^A-Za-z ]/.test((rawAddress as Record<string, string>).country ?? "")
    ) {
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    const userId = body.user_id
    if (typeof userId !== "string") throw new HttpError(422, { detail: "user_id must be a string" })
    if (!state.users.has(userId) && !state.deletedUsers.has(userId))
      notFound("User does not exist on this team")
    const phone = (body.patient_details as Record<string, unknown> | undefined)?.phone_number
    if (typeof phone === "string" && /^\+1\d{10}$/.test(phone) && phone.slice(2, 5) === "555") {
      throw new HttpError(400, { detail: "Phone number is not correct" })
    }
    if (body.collection_method === "testkit")
      throw new HttpError(400, { detail: "Cannot set collection_method to TESTKIT" })
    const aoeError = aoeValidationError(body)
    if (aoeError) throw new HttpError(400, { detail: aoeError })
    const details = body.patient_details as Record<string, unknown>
    const address = body.patient_address as Record<string, unknown>
    const labTestIds = (body.order_set as Record<string, unknown>).lab_test_ids as string[]
    const labTests = labTestIds.map((id) => labTestById(id))
    if (labTests.some((test) => test === undefined))
      throw new HttpError(422, {
        detail: labTests.flatMap((test, index) =>
          test === undefined ? [uuidError(labTestIds[index] ?? "", index)] : [],
        ),
      })
    const labTest = labTests[0] as NonNullable<(typeof labTests)[number]>

    const nowIso = state.isoNow(context.now)
    const nowMicro = new Date(context.now()).toISOString()
    const orderId = state.nextOrderId()
    const transactionId = state.transactionIdFor(orderId)
    const method =
      typeof body.collection_method === "string" ? body.collection_method : labTest.method
    const idempotencyKey = body.idempotency_key
    const requestFingerprint = JSON.stringify(body)
    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
      const replay = state.orderIdempotency.get(idempotencyKey)
      if (replay) {
        if (replay.fingerprint !== requestFingerprint)
          throw new HttpError(400, {
            detail: "Idempotency key was reused with a different request",
          })
        return jsonRes(200, replay.response)
      }
    }
    const eventStatus = `received.${method}.ordered`
    const event = {
      id: 1,
      created_at: nowIso,
      status: eventStatus,
      status_detail: null,
    }
    const order: OrderRecord = {
      id: orderId,
      user_id: userId,
      team_id: MOCK_TEAM_ID,
      patient_details: patientDetails(details as Record<string, unknown>),
      patient_address: patientAddress(address as Record<string, unknown>),
      lab_test: labTest,
      details: METHOD_DETAILS(method, state.testkitIdFor(orderId), nowIso),
      sample_id: null,
      notes: null,
      clinical_notes: typeof body.clinical_notes === "string" ? body.clinical_notes : null,
      passthrough: typeof body.passthrough === "string" ? body.passthrough : null,
      created_at: nowIso,
      updated_at: nowIso,
      events: [event],
      status: "received",
      last_event: event,
      physician: PHYSICIAN,
      health_insurance_id: null,
      requisition_form_url: null,
      shipping_details: null,
      has_abn: false,
      billing_type: "client_bill",
      priority: false,
      activate_by: null,
      icd_codes: null,
      interpretation: null,
      has_missing_results: null,
      expected_result_by_date: null,
      worst_case_result_by_date: null,
      origin: "initial",
      order_transaction: {
        id: transactionId,
        status: "active",
        orders: [
          {
            id: orderId,
            low_level_status: "ordered",
            low_level_status_created_at: nowMicro,
            origin: "initial",
            parent_id: null,
            created_at: nowMicro,
            updated_at: nowMicro,
          },
        ],
      },
    }
    state.orders.insert(orderId, order)
    state.orderByTransaction.insert(transactionId, { order_id: orderId })
    const response = { order, status: "SUCCESS", message: "Order submitted" }
    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0)
      state.orderIdempotency.insert(idempotencyKey, {
        order_id: orderId,
        response,
        fingerprint: requestFingerprint,
      })
    state.publishOrderWebhook(order, "labtest.order.created", context.now())
    return jsonRes(200, response)
  },

  cancel_order_v3_order__order_id__cancel_post: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const order = state.orders.get(id)
    if (!order) notFound("Order doesn't exist")
    if (order.status !== "cancelled") {
      const now = state.isoNow(context.now)
      order.status = "cancelled"
      order.updated_at = now
      const event = {
        id: order.events.length + 1,
        created_at: now,
        status: "cancelled.testkit.cancelled",
        status_detail: null,
      }
      order.events.push(event)
      order.last_event = event
      order.order_transaction.status = "cancelled"
      const transactionOrder = order.order_transaction.orders[0]
      if (transactionOrder) {
        transactionOrder.low_level_status = "cancelled"
        transactionOrder.updated_at = new Date(context.now()).toISOString()
      }
      state.orders.update(id, order)
      state.publishOrderWebhook(order, "labtest.order.updated", context.now())
    }
    const response = { order, status: "SUCCESS", message: "Order cancelled" }
    return jsonRes(200, response)
  },

  simulate_order_v3_order__order_id__test_post: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const finalStatus = context.query.final_status
    if (!isUuid(id))
      throw new HttpError(422, { detail: [uuidError(id, undefined, ["path", "order_id"])] })
    const order = state.orders.get(id)
    if (!order) notFound("Order doesn't exist")
    if (
      typeof finalStatus !== "string" ||
      !FINAL_STATUSES.includes(finalStatus as (typeof FINAL_STATUSES)[number])
    )
      throw new HttpError(422, { detail: [finalStatusError(String(finalStatus ?? ""))] })
    if (!order) notFound("Order doesn't exist")
    const now = state.isoNow(context.now)
    const lowLevelStatus = finalStatus.split(".").at(-1) ?? finalStatus
    const event = {
      id: order.events.length + 1,
      created_at: now,
      status: finalStatus,
      status_detail: null,
    }
    order.status = finalStatus
    order.updated_at = now
    order.events.push(event)
    order.last_event = event
    const transactionOrder = order.order_transaction.orders.find((entry) => entry.id === id)
    if (transactionOrder) {
      transactionOrder.low_level_status = lowLevelStatus
      transactionOrder.low_level_status_created_at = new Date(context.now()).toISOString()
      transactionOrder.updated_at = new Date(context.now()).toISOString()
    }
    if (finalStatus.startsWith("completed")) order.order_transaction.status = "completed"
    if (finalStatus.startsWith("cancelled")) order.order_transaction.status = "cancelled"
    state.orders.update(id, order)
    state.publishOrderWebhook(order, "labtest.order.updated", context.now())
    return new Response(null, { status: 204 })
  },

  get_order_v3_order__order_id__get: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const order = state.orders.get(id)
    if (!order) notFound("This order doesn't exist")
    return jsonRes(200, order)
  },

  get_orders_v3_orders_get: async (context: OperationContext) => {
    const page = queryInt(context, "page", 1)
    const size = queryInt(context, "size", 50)
    if (page < 1 || size < 1 || size > 100)
      throw new HttpError(422, { detail: "page must be >= 1 and size must be 1..100" })
    const userId = context.query.user_id
    if (userId !== undefined && typeof userId !== "string")
      throw new HttpError(422, { detail: "user_id must be a string" })
    if (userId !== undefined && !state.users.has(userId) && !state.deletedUsers.has(userId))
      notFound("User does not exist on this team")
    let all = state.orders.list({ order: "oldest" })
    if (userId !== undefined) all = all.filter((entry) => entry.value.user_id === userId)
    const pageItems = all.slice((page - 1) * size, page * size)
    return jsonRes(200, {
      orders: pageItems.map((entry) => entry.value),
      total: all.length,
      page,
      size,
    })
  },

  get_order_transaction_v3_order_transaction__transaction_id__get: async (
    context: OperationContext,
  ) => {
    const id = context.params.transaction_id ?? ""
    const binding = state.orderByTransaction.get(id)
    const order = binding ? state.orders.get(binding.order_id) : undefined
    if (!order) notFound("Order transaction not found")
    return jsonRes(200, {
      id,
      team_id: MOCK_TEAM_ID,
      status: order.order_transaction.status,
      orders: [orderSummary(order)],
    })
  },

  get_order_transaction_result_v3_order_transaction__transaction_id__result_get: async (
    context: OperationContext,
  ) => {
    const id = context.params.transaction_id ?? ""
    const binding = state.orderByTransaction.get(id)
    const order = binding ? state.orders.get(binding.order_id) : undefined
    if (!order) notFound("Order transaction not found")
    const user = order.user_id ? state.users.get(order.user_id) : undefined
    return jsonRes(200, {
      metadata: {
        age: "41",
        dob: "1983-06-23",
        patient: user?.client_user_id ?? order.user_id,
        date_reported: "2024-11-02",
        specimen_number: opaqueToken(`junction:specimen:${order.id}`, 24),
        status: "final",
        laboratory: "Mockingbird Central Lab",
        provider: null,
        interpretation: null,
        patient_id: null,
        account_id: null,
        date_collected: null,
        date_received: null,
        "clia_#": null,
      },
      results: biomarker(order, order.created_at),
      missing_results: null,
      sample_information: null,
      order_transaction: order.order_transaction,
    })
  },
})

const orderSummary = (order: OrderRecord) => {
  const transactionOrder = order.order_transaction.orders.find((entry) => entry.id === order.id)
  return {
    id: order.id,
    origin: transactionOrder?.origin ?? "initial",
    parent_id: transactionOrder?.parent_id ?? null,
    last_status: transactionOrder?.low_level_status ?? "ordered",
    last_status_created_at: transactionOrder?.low_level_status_created_at ?? order.created_at,
    updated_at: order.updated_at,
    created_at: order.created_at,
  }
}

const biomarker = (order: OrderRecord, created_at: string) =>
  (order.lab_test.markers ?? []).map((marker) => ({
    name: marker.name,
    slug: marker.slug,
    result: marker.slug,
    type: "numeric",
    unit: marker.unit,
    timestamp: created_at,
    reference_range: null,
    interpretation: "normal",
    performing_laboratory: "Mockingbird Central Lab",
    source_sample_id: null,
  }))
