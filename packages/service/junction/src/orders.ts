import {
  HttpError,
  jsonResponse,
  type OperationContext,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import type { JunctionState, OrderRecord } from "./state.js"
import { LAB_TEST_CATALOG, labTestById, MOCK_TEAM_ID } from "./state.js"

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

const patternError = (loc: string[], value: unknown, pattern: string) => ({
  type: "string_pattern_mismatch",
  loc,
  msg: `String should match pattern '${pattern}'`,
  input: value,
  ctx: { pattern },
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
  const labAccountId = body.lab_account_id
  if (typeof labAccountId === "string" && !isUuid(labAccountId)) {
    errors.push({
      type: "uuid_parsing",
      loc: ["body", "lab_account_id"],
      msg: "Input should be a valid UUID, invalid length: expected length 32 for simple format, found 0",
      input: labAccountId,
      ctx: { error: "invalid length: expected length 32 for simple format, found 0" },
    })
  }
  const aoeAnswers = body.aoe_answers
  if (Array.isArray(aoeAnswers)) {
    for (const [index, answer] of aoeAnswers.entries()) {
      if (typeof answer !== "object" || answer === null || Array.isArray(answer)) continue
      const record = answer as Record<string, unknown>
      for (const field of ["marker_id", "question_id", "answer"]) {
        if (record[field] === undefined)
          errors.push(missingError(["body", "aoe_answers", index, field].map(String), answer))
      }
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
        !isValidName(p[field] as string)
      )
        errors.push(nameError(field, p[field]))
    }
    if (typeof p.dob === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(p.dob)) {
        // valid date-only
      } else if (/^\d{4}-\d{2}-\d{2}T/.test(p.dob)) {
        if (!/^\d{4}-\d{2}-\d{2}T00:00:00/.test(p.dob)) {
          errors.push({
            type: "date_from_datetime_inexact",
            loc: ["body", "patient_details", "dob"],
            msg: "Datetimes provided to dates should have zero time - e.g. be exact dates",
            input: pyIso(p.dob),
          })
        }
      } else if (!isValidDate(p.dob)) {
        errors.push({
          type: "date_from_datetime_parsing",
          loc: ["body", "patient_details", "dob"],
          msg: "Input should be a valid date or datetime, invalid character in year",
          input: p.dob,
          ctx: { error: "invalid character in year" },
        })
      }
    }
    if (typeof p.phone_number === "string" && !isValidPhone(p.phone_number)) {
      errors.push(phoneError(["body", "patient_details", "phone_number"], p.phone_number))
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
    if (typeof a.zip === "string" && !/^\d{5}(-\d{4})?$/.test(a.zip)) {
      errors.push(patternError(["body", "patient_address", "zip"], a.zip, "^\\d{5}(-\\d{4})?$"))
    }
    if (typeof a.phone_number === "string" && !isValidPhone(a.phone_number)) {
      errors.push(phoneError(["body", "patient_address", "phone_number"], a.phone_number))
    }
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
    else if (!Array.isArray(ids) || ids.length === 0)
      errors.push({
        type: "string_type",
        loc: ["body", "order_set", "lab_test_ids"],
        msg: "Input should be a valid string",
        input: ids,
      })
  }
  return errors
}

const METHOD_DETAILS = (method: string, id: string, at: string) => {
  switch (method) {
    case "testkit":
      return {
        type: "testkit",
        data: { id, shipment: null, created_at: at, updated_at: at },
      }
    case "walk_in_test":
      return {
        type: "walk_in_test",
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

export const orderHandlers = (state: JunctionState) => ({
  get_paginated_lab_tests_for_team_v3_lab_test_get: async () =>
    jsonResponse(200, { data: LAB_TEST_CATALOG, next_cursor: null }),

  get_lab_test_for_team_v3_lab_tests__lab_test_id__get: async (context: OperationContext) => {
    const id = context.params.lab_test_id ?? ""
    const test = labTestById(id)
    if (!test) notFound("Lab test does not exist")
    return jsonResponse(200, test)
  },

  create_order_v3_order_post: async (context: OperationContext) => {
    const body = trimStrings(jsonObject(context)) as Record<string, unknown>
    const errors = orderValidation(body)
    if (errors.length > 0) throw new HttpError(422, { detail: errors })
    const userId = body.user_id
    if (typeof userId !== "string") throw new HttpError(422, { detail: "user_id must be a string" })
    if (!state.users.has(userId) && !state.deletedUsers.has(userId))
      notFound("User does not exist on this team")
    const phone = (body.patient_details as Record<string, unknown> | undefined)?.phone_number
    if (typeof phone === "string" && /^\+1\d{10}$/.test(phone) && phone.slice(2, 5) === "555") {
      throw new HttpError(400, { detail: "Phone number is not correct" })
    }
    const details = body.patient_details as Record<string, unknown>
    const address = body.patient_address as Record<string, unknown>
    const labTestIds = (body.order_set as Record<string, unknown>).lab_test_ids as string[]
    const labTests = labTestIds.map((id) => labTestById(id))
    if (labTests.some((test) => test === undefined))
      throw new HttpError(400, { detail: "Test does not exist" })
    const labTest = labTests[0] as NonNullable<(typeof labTests)[number]>

    const nowIso = state.isoNow(context.now)
    const nowMicro = new Date(context.now()).toISOString()
    const orderId = state.nextOrderId()
    const transactionId = state.transactionIdFor(orderId)
    const method =
      typeof body.collection_method === "string" ? body.collection_method : labTest.method
    const idempotencyKey = body.idempotency_key
    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
      const replay = state.orderIdempotency.get(idempotencyKey)
      if (replay) return jsonResponse(200, replay.response)
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
      state.orderIdempotency.insert(idempotencyKey, { order_id: orderId, response })
    return jsonResponse(200, response)
  },

  cancel_order_v3_order__order_id__cancel_post: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const order = state.orders.get(id)
    if (!order) notFound("This order doesn't exist")
    if (order.status !== "cancelled") {
      const now = state.isoNow(context.now)
      order.status = "cancelled"
      order.updated_at = now
      const event = {
        id: order.events.length + 1,
        created_at: now,
        status: "cancelled",
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
    }
    const response = { order, status: "SUCCESS", message: "Order cancelled" }
    return jsonResponse(200, response)
  },

  simulate_order_v3_order__order_id__test_post: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const order = state.orders.get(id)
    if (!order) notFound("This order doesn't exist")
    const finalStatus = context.query.final_status
    if (typeof finalStatus !== "string" || finalStatus.length === 0)
      throw new HttpError(422, { detail: "final_status is required" })
    order.status = finalStatus
    order.updated_at = state.isoNow(context.now)
    state.orders.update(id, order)
    return new Response(null, { status: 204 })
  },

  get_order_v3_order__order_id__get: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const order = state.orders.get(id)
    if (!order) notFound("This order doesn't exist")
    return jsonResponse(200, order)
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
    return jsonResponse(200, {
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
    return jsonResponse(200, {
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
    return jsonResponse(200, {
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

const orderSummary = (order: OrderRecord) => ({
  id: order.id,
  origin: "initial",
  parent_id: null,
  last_status: "ordered",
  last_status_created_at: order.created_at,
  updated_at: order.updated_at,
  created_at: order.created_at,
})

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
