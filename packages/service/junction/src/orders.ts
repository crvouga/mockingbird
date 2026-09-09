import type { FormValue } from "@crvouga/mockingbird-http-codec"
import {
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import { applySimulateTransition, cascadeCancelAppointments } from "./scheduling.js"
import type { JunctionState, OrderRecord } from "./state.js"
import { deterministicUuid, MOCK_TEAM_ID } from "./state.js"

const RESULT_TYPES = ["numeric", "range", "comment", "coded_value"] as const
const INTERPRETATIONS = ["normal", "abnormal", "critical", "unknown"] as const

const simulationFlagsOf = (context: OperationContext): Record<string, unknown> | null => {
  const body = context.body
  if (body.kind !== "json") return null
  const value = body.value
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const flags: Record<string, unknown> = {}
  if (
    typeof raw.interpretation === "string" &&
    INTERPRETATIONS.includes(raw.interpretation as never)
  )
    flags.interpretation = raw.interpretation
  if (Array.isArray(raw.result_types)) {
    const types = raw.result_types.filter(
      (entry): entry is string =>
        typeof entry === "string" && RESULT_TYPES.includes(entry as never),
    )
    if (types.length > 0) flags.result_types = types
  }
  if (typeof raw.has_missing_results === "boolean")
    flags.has_missing_results = raw.has_missing_results
  return Object.keys(flags).length > 0 ? flags : null
}

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

const aoeQuestion = (
  state: JunctionState,
  markerId: number,
  questionId: number,
): AoeQuestion | undefined => {
  for (const test of state.listLabTests()) {
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

const MARKERS_DEFAULT_SIZE = 50
const MARKERS_MAX_SIZE = 100

const markersBoundsError = (name: string, value: string, bound: "ge" | "le", limit: number) => ({
  type: bound === "ge" ? "greater_than_equal" : "less_than_equal",
  loc: ["query", name],
  msg: `Input should be ${bound === "ge" ? "greater than or equal to" : "less than or equal to"} ${limit}`,
  input: value,
  ctx: bound === "ge" ? { ge: limit } : { le: limit },
})

const parseMarkersInt = (raw: FormValue | undefined, name: string, fallback: number): number => {
  if (raw === undefined) return fallback
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
    throw new HttpError(422, {
      detail: [
        {
          type: "int_parsing",
          loc: ["query", name],
          msg: "Input should be a valid integer, unable to parse string as an integer",
          input: raw,
        },
      ],
    })
  }
  return Number(raw)
}

/**
 * Pagination mirrors the sandbox markers endpoints: `total` counts the returned page,
 * `pages` is ceil(overall/size) over the whole marker list, and page/size accept
 * 1..100 with 422s outside those bounds.
 */
const paginateMarkers = (
  query: OperationContext["query"],
  markers: readonly Record<string, unknown>[],
) => {
  const page = parseMarkersInt(query.page, "page", 1)
  const size = parseMarkersInt(query.size, "size", MARKERS_DEFAULT_SIZE)
  if (page < 1) {
    throw new HttpError(422, {
      detail: [markersBoundsError("page", String(page), "ge", 1)],
    })
  }
  if (size < 1 || size > MARKERS_MAX_SIZE) {
    throw new HttpError(422, {
      detail: [
        markersBoundsError(
          "size",
          String(size),
          size < 1 ? "ge" : "le",
          size < 1 ? 1 : MARKERS_MAX_SIZE,
        ),
      ],
    })
  }
  const start = (page - 1) * size
  const pageMarkers = markers.slice(start, start + size)
  const pages = Math.ceil(markers.length / size)
  return {
    markers: pageMarkers,
    total: pageMarkers.length,
    page,
    size,
    pages,
  }
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
  const osWrongType =
    os !== undefined && (typeof os !== "object" || os === null || Array.isArray(os))
  if (osWrongType) {
    errors.push({
      type: "model_attributes_type",
      loc: ["body", "order_set"],
      msg: "Input should be a valid dictionary or object to extract fields from",
      input: os,
    })
  } else if (os !== undefined) {
    const o = os as Record<string, unknown>
    const ids = o.lab_test_ids
    if (ids === undefined) errors.push(missingError(["body", "order_set", "lab_test_ids"], o))
    else if (!Array.isArray(ids)) {
      errors.push({
        type: "list_type",
        loc: ["body", "order_set", "lab_test_ids"],
        msg: "Input should be a valid list",
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
      else if (field === "gender" && p[field] === null) {
        errors.push({
          type: "value_error",
          loc: ["body", "patient_details", "gender"],
          msg: "Value error, gender cannot be None.",
          input: null,
          ctx: { error: {} },
        })
      } else if (field === "phone_number" && p[field] === null) {
        errors.push({
          type: "value_error",
          loc: ["body", "patient_details", "phone_number"],
          msg: "Value error, Phone number cannot be None",
          input: null,
          ctx: { error: {} },
        })
      } else if (field === "dob" && typeof p[field] === "number") {
        const asSeconds = Math.abs(p[field] as number) < 1e12
        const normalized = new Date((p[field] as number) * (asSeconds ? 1000 : 1))
          .toISOString()
          .replace(/\.\d{3}Z$/, "+00:00")
          .replace(/Z$/, "+00:00")
        errors.push({
          type: "date_from_datetime_inexact",
          loc: ["body", "patient_details", "dob"],
          msg: "Datetimes provided to dates should have zero time - e.g. be exact dates",
          input: normalized,
        })
      } else if (field === "dob" && (p[field] === null || typeof p[field] === "object")) {
        errors.push({
          type: "value_error",
          loc: ["body", "patient_details", "dob"],
          msg: "Value error, date of birth is not specified.",
          input: p[field],
          ctx: { error: {} },
        })
      } else if (typeof p[field] !== "string")
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
      else if (field === "email") {
        const emailError = userEmailError(p[field] as string)
        if (emailError) errors.push(emailError)
      } else if (field === "dob") {
        const dobError = orderDobError(p[field] as string)
        if (dobError) errors.push(dobError)
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

/** Sandbox email validation for `patient_details.email` (only the missing-@ sign case is reachable here). */
const userEmailError = (value: string) => {
  if (!value.includes("@")) {
    return {
      type: "value_error",
      loc: ["body", "patient_details", "email"],
      msg: "value is not a valid email address: An email address must have an @-sign.",
      input: value,
      ctx: { reason: "An email address must have an @-sign." },
    }
  }
  return undefined
}

/**
 * Sandbox dob validation for create_order: many string formats are accepted
 * (`1990-01-01`, `1990-01`, `1990/01/01`, `19900101`, ...); exact zero-time datetimes are
 * accepted, non-zero times produce `date_from_datetime_inexact` with a normalized input,
 * and unmatchable strings produce the "Could not match" value error.
 */
const orderDobError = (dob: string) => {
  if (/^\d{4}-\d{2}-\d{2}T/.test(dob)) {
    if (/^\d{4}-\d{2}-\d{2}T00:00:00/.test(dob)) {
      const dateOnly = dob.slice(0, 10)
      if (new Date(`${dateOnly}T00:00:00Z`).getTime() > Date.now()) {
        return {
          type: "value_error",
          loc: ["body", "patient_details", "dob"],
          msg: "Value error, dob cannot be in the future",
          input: `${dateOnly}T00:00:00+00:00`,
          ctx: { error: {} },
        }
      }
      return undefined
    }
    return {
      type: "date_from_datetime_inexact",
      loc: ["body", "patient_details", "dob"],
      msg: "Datetimes provided to dates should have zero time - e.g. be exact dates",
      input: pyIso(dob),
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const [year = "0", month = "0", day = "0"] = dob.split("-")
    const monthNumber = Number(month)
    const dayNumber = Number(day)
    if (monthNumber < 1 || monthNumber > 12) {
      return {
        type: "value_error",
        loc: ["body", "patient_details", "dob"],
        msg: `Value error, month must be in 1..12, not ${monthNumber}`,
        input: dob,
        ctx: { error: {} },
      }
    }
    const daysInMonth = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate()
    if (dayNumber < 1 || dayNumber > daysInMonth) {
      return {
        type: "value_error",
        loc: ["body", "patient_details", "dob"],
        msg: `Value error, day ${dayNumber} must be in range 1..${daysInMonth} for month ${monthNumber} in year ${year}`,
        input: dob,
        ctx: { error: {} },
      }
    }
    if (new Date(`${dob}T00:00:00Z`).getTime() > Date.now()) {
      return {
        type: "value_error",
        loc: ["body", "patient_details", "dob"],
        msg: "Value error, dob cannot be in the future",
        input: `${dob}T00:00:00+00:00`,
        ctx: { error: {} },
      }
    }
    return undefined
  }
  return {
    type: "value_error",
    loc: ["body", "patient_details", "dob"],
    msg:
      "Value error, Could not match input '" +
      dob +
      "' to any of the following formats: YYYY-MM-DD, YYYY-M-DD, YYYY-M-D, YYYY/MM/DD, YYYY/M/DD, YYYY/M/D, YYYY.MM.DD, YYYY.M.DD, YYYY.M.D, YYYYMMDD, YYYY-DDDD, YYYYDDDD, YYYY-MM, YYYY/MM, YYYY.MM, YYYY, W.",
    input: dob,
    ctx: { error: {} },
  }
}

const aoeValidationError = (
  state: JunctionState,
  body: Record<string, unknown>,
): string | undefined => {
  const answers = body.aoe_answers
  if (!Array.isArray(answers)) return undefined
  for (const answer of answers) {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) continue
    const record = answer as Record<string, unknown>
    if (typeof record.marker_id !== "number") continue
    const marker = state
      .listLabTests()
      .flatMap((test) => test.markers ?? [])
      .find((entry) => entry.id === record.marker_id)
    if (!marker?.aoe) return `Marker id ${record.marker_id} does not have AOE.`
    const question = aoeQuestion(state, record.marker_id, record.question_id as number)
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

/** Sandbox Labcorp rejects these patient states (`Lab Labcorp does not support state XX`). */
const LAB_UNSUPPORTED_STATES: Readonly<Record<string, readonly string[]>> = {
  labcorp: ["NY", "NJ", "RI"],
}

/** Low-level events that Junction allows transitioning to `cancelled.*.cancelled`. */
const CANCELLABLE_ORDER_EVENTS = new Set([
  "received.walk_in_test.ordered",
  "received.walk_in_test.requisition_created",
  "received.walk_in_test.requisition_bypassed",
  "collecting_sample.walk_in_test.appointment_scheduled",
  "collecting_sample.walk_in_test.appointment_cancelled",
  "collecting_sample.walk_in_test.appointment_pending",
  "received.at_home_phlebotomy.ordered",
  "received.at_home_phlebotomy.requisition_created",
  "received.at_home_phlebotomy.requisition_bypassed",
  "collecting_sample.at_home_phlebotomy.appointment_pending",
  "collecting_sample.at_home_phlebotomy.appointment_scheduled",
  "collecting_sample.at_home_phlebotomy.appointment_cancelled",
  "collecting_sample.at_home_phlebotomy.draw_completed",
  "received.testkit.ordered",
  "received.testkit.awaiting_registration",
  "received.testkit.requisition_created",
  "received.testkit.requisition_bypassed",
  "received.testkit.testkit_registered",
  "received.on_site_collection.ordered",
  "received.on_site_collection.requisition_created",
  "received.on_site_collection.requisition_bypassed",
  "collecting_sample.on_site_collection.draw_completed",
])

const labStateSupportError = (
  labTest: { lab?: Record<string, unknown> | null },
  state: unknown,
): string | undefined => {
  if (typeof state !== "string" || state.length === 0) return undefined
  const lab = labTest.lab
  if (!lab || typeof lab !== "object") return undefined
  const slug = typeof lab.slug === "string" ? lab.slug.toLowerCase() : ""
  const name = typeof lab.name === "string" ? lab.name : "Lab"
  const unsupported = LAB_UNSUPPORTED_STATES[slug]
  if (!unsupported) return undefined
  const normalized = state.trim().toUpperCase()
  if (!unsupported.includes(normalized)) return undefined
  return `Lab ${name} does not support state ${normalized}`
}
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
    jsonRes(200, {
      data: state.listLabTests().filter((test) => test.auto_generated !== true),
      next_cursor: null,
    }),

  get_lab_test_for_team_v3_lab_tests__lab_test_id__get: async (context: OperationContext) => {
    const id = context.params.lab_test_id ?? ""
    const test = state.labTestById(id)
    if (!test) notFound("Lab test does not exist")
    return jsonRes(200, test)
  },

  get_labs_v3_lab_tests_labs_get: async () => jsonRes(200, state.listLabs()),

  get_markers_for_lab_test_v3_lab_tests__lab_test_id__markers_get: async (
    context: OperationContext,
  ) => {
    const id = context.params.lab_test_id ?? ""
    const test = state.labTestById(id)
    if (!test) notFound("Lab test does not exist")
    const expected = state.expectedResultsFor(id)
    const markers = (test.markers ?? []).map((marker) => ({
      ...marker,
      expected_results: expected,
    }))
    return jsonRes(200, paginateMarkers(context.query, markers))
  },

  list_order_set_markers_v3_lab_tests_list_order_set_markers_post: async (
    context: OperationContext,
  ) => {
    const body = jsonObject(context)
    const orderSetId = body.order_set_id
    if (typeof orderSetId !== "string" || !isUuid(orderSetId)) {
      throw new HttpError(422, {
        detail: [uuidError(String(orderSetId ?? ""), 0, ["body", "order_set_id"])],
      })
    }
    const binding = state.orderByTransaction.get(orderSetId)
    const order = binding ? state.orders.get(binding.order_id) : undefined
    if (!order) notFound("Order set not found")
    const providerId = typeof body.provider_id === "string" ? body.provider_id : null
    const markers = (order.lab_test.markers ?? [])
      .filter((marker) => providerId === null || marker.provider_id === providerId)
      .map((marker) => ({
        ...marker,
        expected_results: state.expectedResultsFor(order.lab_test.id),
      }))
    return jsonRes(200, paginateMarkers(context.query, markers))
  },

  create_order_v3_order_post: async (context: OperationContext) => {
    const rawBody = jsonObject(context)
    const body = trimStrings(rawBody) as Record<string, unknown>
    body.aoe_answers = rawBody.aoe_answers
    const patient = rawBody.patient_details
    if (typeof patient === "object" && patient !== null && !Array.isArray(patient)) {
      const details = patient as Record<string, unknown>
      const crashes = Object.entries(details).some(([key, value]) => {
        if (
          (key === "first_name" || key === "last_name") &&
          (typeof value === "number" || typeof value === "boolean")
        )
          return true
        if (key === "gender" && value !== null && typeof value !== "string") return true
        if (key === "phone_number" && value !== null && typeof value !== "string") return true
        if (key === "dob" && typeof value === "boolean") return true
        return false
      })
      if (crashes) {
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      }
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
    const aoeError = aoeValidationError(state, body)
    if (aoeError) throw new HttpError(400, { detail: aoeError })
    const rawOrderSet = body.order_set
    if (rawOrderSet === undefined && body.lab_test_id === undefined) {
      throw new HttpError(400, { detail: "Either lab_test_id or order_set must be set" })
    }
    if (
      typeof rawOrderSet === "object" &&
      rawOrderSet !== null &&
      !Array.isArray(rawOrderSet) &&
      (rawOrderSet as Record<string, unknown>).lab_test_ids === undefined &&
      (rawOrderSet as Record<string, unknown>).add_on === undefined
    ) {
      throw new HttpError(400, { detail: "lab_test_ids or add_on must be set in order_set" })
    }
    const details = body.patient_details as Record<string, unknown>
    const address = body.patient_address as Record<string, unknown>
    const labTestIds = (body.order_set as Record<string, unknown>).lab_test_ids as string[]
    const labTests = labTestIds.map((id) => state.labTestById(id))
    const resolved = labTests.filter(
      (test): test is NonNullable<(typeof labTests)[number]> => test !== undefined,
    )
    if (resolved.length !== labTestIds.length || resolved.length === 0) {
      throw new HttpError(400, {
        detail: "No markers found for the supplied lab tests. Please check the lab test ids",
      })
    }
    const markerCount = resolved.reduce((sum, test) => sum + (test.markers?.length ?? 0), 0)
    if (markerCount === 0) {
      throw new HttpError(400, {
        detail: "No markers found for the supplied lab tests. Please check the lab test ids",
      })
    }
    const labTest = resolved[0]

    const stateError = labStateSupportError(labTest, address.state)
    if (stateError) throw new HttpError(400, { detail: stateError })

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
    const eventId =
      Number.parseInt(opaqueToken(`junction:order-event:${orderId}`, 8), 16) % 1_000_000_000 || 1
    const event = {
      id: eventId,
      created_at: nowIso,
      status: eventStatus,
      status_detail: null,
    }
    // Sandbox: same collection_method as the panel → embed the panel as-is.
    // Different method → reuse one auto_generated lab_test per (markers, method).
    const nativeMethod =
      typeof labTest.method === "string" && labTest.method.length > 0
        ? labTest.method
        : method
    let orderLabTest: typeof labTest
    if (method === nativeMethod) {
      orderLabTest = labTest
    } else {
      const markerFingerprint = (test: { markers?: Array<{ id: number }> | null }) =>
        (test.markers ?? [])
          .map((marker) => marker.id)
          .sort((a, b) => a - b)
          .join(",")
      const sourceFingerprint = markerFingerprint(labTest)
      const existingAuto = state
        .listLabTests()
        .find(
          (test) =>
            test.auto_generated === true &&
            test.method === method &&
            markerFingerprint(test) === sourceFingerprint,
        )
      const orderLabTestKey = `${labTest.id}:${method}`
      const orderLabTestName =
        existingAuto?.name ?? opaqueToken(`junction:order-lab-name:${orderLabTestKey}`, 16)
      orderLabTest = existingAuto ?? {
        ...labTest,
        id: deterministicUuid(`junction:order-lab-test:${orderLabTestKey}`),
        method,
        auto_generated: true,
        name: orderLabTestName,
        slug: `afd62b39-${orderLabTestName}`,
      }
    }
    const order: OrderRecord = {
      id: orderId,
      user_id: userId,
      team_id: MOCK_TEAM_ID,
      patient_details: patientDetails(details as Record<string, unknown>),
      patient_address: patientAddress(address as Record<string, unknown>),
      lab_test: orderLabTest,
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
      result_types: null,
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
    state.upsertLabTest(
      orderLabTest,
      orderLabTest.id === labTest.id
        ? undefined
        : state.expectedResultsFor(labTest.id),
    )
    const demographics = {
      first_name: details.first_name ?? null,
      last_name: details.last_name ?? null,
      dob: details.dob ?? null,
      gender: details.gender ?? null,
      phone_number: details.phone_number ?? null,
      email: details.email ?? null,
      gender_identity: null,
      sexual_orientation: null,
      race: null,
      ethnicity: null,
      medical_proxy: null,
      address: {
        first_line: address.first_line ?? "",
        second_line: typeof address.second_line === "string" ? address.second_line : "",
        country: address.country ?? "",
        zip: address.zip ?? "",
        city: address.city ?? "",
        state: address.state ?? "",
        access_notes: null,
      },
    }
    if (state.userInfo.get(userId)) state.userInfo.update(userId, demographics)
    else state.userInfo.insert(userId, demographics)
    const responseOrder = { ...order } as Record<string, unknown>
    if (responseOrder.result_types === null) delete responseOrder.result_types
    const response = {
      order: responseOrder,
      status: "success",
      message: "Order created successfully",
    }
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
    const alreadyCancelled =
      order.status === "cancelled" ||
      order.order_transaction.status === "cancelled" ||
      (typeof order.last_event?.status === "string" &&
        order.last_event.status.startsWith("cancelled."))
    if (alreadyCancelled) {
      const responseOrder = { ...order } as Record<string, unknown>
      if (responseOrder.result_types === null) delete responseOrder.result_types
      return jsonRes(200, {
        order: responseOrder,
        status: "success",
        message: "order already cancelled",
      })
    }
    const lowLevel =
      typeof order.last_event?.status === "string"
        ? order.last_event.status
        : typeof order.events[order.events.length - 1]?.status === "string"
          ? order.events[order.events.length - 1]!.status
          : ""
    if (!CANCELLABLE_ORDER_EVENTS.has(lowLevel)) {
      throw new HttpError(400, {
        detail:
          "This order is not in a Cancellable Status. Refer to the documentation to check the order lifecycle (https://docs.tryvital.io/lab/workflow/lab-test-lifecycle).",
      })
    }
    const now = state.isoNow(context.now)
    const method =
      typeof order.lab_test.method === "string" && order.lab_test.method.length > 0
        ? order.lab_test.method
        : typeof order.details?.type === "string" && order.details.type.length > 0
          ? order.details.type
          : "at_home_phlebotomy"
    order.status = "cancelled"
    order.updated_at = now
    const event = {
      id: order.events.length + 1,
      created_at: now,
      status: `cancelled.${method}.cancelled`,
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
    // Junction auto-cancels mobile phlebotomy appointments on order cancel, but
    // leaves walk-in PSC appointments alone (patient may already be en route).
    if (method === "at_home_phlebotomy") {
      cascadeCancelAppointments(state, id, context.now())
    }
    const responseOrder = { ...order } as Record<string, unknown>
    if (responseOrder.result_types === null) delete responseOrder.result_types
    const response = {
      order: responseOrder,
      status: "success",
      message: "order cancelled",
    }
    return jsonRes(200, response)
  },

  simulate_order_v3_order__order_id__test_post: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const finalStatus = context.query.final_status
    if (!isUuid(id))
      throw new HttpError(422, { detail: [uuidError(id, undefined, ["path", "order_id"])] })
    if (
      finalStatus !== undefined &&
      (typeof finalStatus !== "string" ||
        !FINAL_STATUSES.includes(finalStatus as (typeof FINAL_STATUSES)[number]))
    )
      throw new HttpError(422, { detail: [finalStatusError(String(finalStatus ?? ""))] })
    const delayRaw = context.query.delay
    let delaySeconds = 0
    if (delayRaw !== undefined) {
      if (typeof delayRaw !== "string" || !/^\d+$/.test(delayRaw))
        throw new HttpError(422, { detail: "delay must be a non-negative integer" })
      delaySeconds = Number(delayRaw)
    }
    const body = context.body
    if (body.kind === "json") {
      const value = body.value
      if (typeof value !== "object" || Array.isArray(value)) {
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
    }
    const order = state.orders.get(id)
    if (!order) notFound("Order doesn't exist")
    if (
      typeof finalStatus !== "string" ||
      !FINAL_STATUSES.includes(finalStatus as (typeof FINAL_STATUSES)[number])
    )
      throw new HttpError(422, { detail: [finalStatusError(String(finalStatus ?? ""))] })
    const flags = simulationFlagsOf(context)
    if (delaySeconds > 0) {
      state.queueSimulateTransition({
        order_id: id,
        due_at: context.now() + delaySeconds * 1000,
        final_status: finalStatus,
        flags,
      })
      return jsonRes(200, "Success")
    }
    applySimulateTransition(state, order, finalStatus, flags, context)
    return jsonRes(200, "Success")
  },

  get_order_v3_order__order_id__get: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const order = state.orders.get(id)
    if (!order) notFound("This order doesn't exist")
    state.applyDueSimulateTransitions(context.now(), (due, finalStatus, flags) => {
      applySimulateTransition(state, due, finalStatus, flags, context)
    })
    const fresh = state.orders.get(id)
    if (!fresh) notFound("This order doesn't exist")
    const body = { ...fresh } as Record<string, unknown>
    if (body.result_types === null) delete body.result_types
    return jsonRes(200, body)
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
    all = [...all].sort((left, right) => {
      const leftAt = Date.parse(String(left.value.created_at ?? "")) || 0
      const rightAt = Date.parse(String(right.value.created_at ?? "")) || 0
      if (rightAt !== leftAt) return rightAt - leftAt
      // Deterministic, seed-independent tie-break (seq is insert-order and
      // flips after seedFrom copies newest-first API pages).
      return right.id.localeCompare(left.id)
    })
    const pageItems = all.slice((page - 1) * size, page * size)
    return jsonRes(200, {
      orders: pageItems.map((entry) => {
        const order = { ...entry.value } as Record<string, unknown>
        if (order.result_types === null) delete order.result_types
        return order
      }),
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
