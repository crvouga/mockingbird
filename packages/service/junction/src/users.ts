import { HttpError, jsonRes, type OperationContext } from "@crvouga/mockingbird-service"
import type { JunctionState, UserRecord } from "./state.js"
import { MOCK_TEAM_ID } from "./state.js"

const jsonBody = (context: OperationContext): Record<string, unknown> => {
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

const render = (user: UserRecord, rawEnd = false) => ({
  user_id: user.user_id,
  team_id: user.team_id,
  client_user_id: user.client_user_id,
  created_on: user.created_on,
  connected_sources: user.connected_sources,
  fallback_time_zone: user.fallback_time_zone,
  fallback_birth_date: user.fallback_birth_date,
  ingestion_start: user.ingestion_start,
  ingestion_end: rawEnd
    ? user.ingestion_end
    : user.ingestion_start === null
      ? null
      : (user.ingestion_end ?? "0001-01-01"),
})

const listUsers = (state: JunctionState, offset: number, limit: number) => {
  const all = state.users.list({ order: "newest" })
  const users = all.slice(offset, offset + limit).map((entry) => render(entry.value, true))
  return {
    users,
    total: users.length === 0 ? 0 : all.length,
    offset,
    limit,
  }
}

const isValidUuid = (value: string): boolean =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)

function notFound(detail: string): never {
  throw new HttpError(404, { detail })
}

const queryInt = (context: OperationContext, name: string, fallback: number): number => {
  const raw = context.query[name]
  if (raw === undefined) return fallback
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw))
    throw new HttpError(422, { detail: `${name} must be an integer` })
  return Number(raw)
}

const isValidIanaTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

const isValidDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const y = year ?? 0
  const m = month ?? 0
  const d = day ?? 0
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

const stringError = (path: string, value: unknown) => ({
  type: "string_type",
  loc: ["body", ...path.split(".")],
  msg: "Input should be a valid string",
  input: value,
})

const missingError = (path: string, input: unknown) => ({
  type: "missing",
  loc: ["body", ...path.split(".")],
  msg: "Field required",
  input,
})

const dateError = (path: string, value: unknown) => {
  const input = String(value)
  if (input.length <= 7) {
    return {
      type: "date_from_datetime_parsing",
      loc: ["body", ...path.split(".")],
      msg: "Input should be a valid date or datetime, input is too short",
      input: value,
      ctx: { error: "input is too short" },
    }
  }
  return {
    type: "date_from_datetime_parsing",
    loc: ["body", ...path.split(".")],
    msg: "Input should be a valid date or datetime, invalid character in year",
    input: value,
    ctx: { error: "invalid character in year" },
  }
}

/** Pydantic-style email validation mirroring the sandbox's error reasons. */
const emailErrorOf = (value: string): { msg: string; reason: string } | undefined => {
  if (!value.includes("@")) {
    return {
      msg: "value is not a valid email address: An email address must have an @-sign.",
      reason: "An email address must have an @-sign.",
    }
  }
  const [local = "", ...domainParts] = value.split("@")
  const domain = domainParts.join("@")
  if (local === "") {
    return {
      msg: "value is not a valid email address: There must be something before the @-sign.",
      reason: "There must be something before the @-sign.",
    }
  }
  if (domain === "") {
    return {
      msg: "value is not a valid email address: There must be something after the @-sign.",
      reason: "There must be something after the @-sign.",
    }
  }
  if (/\s/.test(local)) {
    return {
      msg: `value is not a valid email address: The email address contains invalid characters before the @-sign: ${describeLocalChar(local)}.`,
      reason: `The email address contains invalid characters before the @-sign: ${describeLocalChar(local)}.`,
    }
  }
  if (domain.includes("@") || /[^a-zA-Z0-9.\-_]/.test(domain)) {
    return {
      msg: `value is not a valid email address: The part after the @-sign contains invalid characters: '@'.`,
      reason: `The part after the @-sign contains invalid characters: '@'.`,
    }
  }
  if (!domain.includes(".")) {
    return {
      msg: "value is not a valid email address: The part after the @-sign is not valid. It should have a period.",
      reason: "The part after the @-sign is not valid. It should have a period.",
    }
  }
  return undefined
}

const describeLocalChar = (local: string): string => {
  for (const character of local) {
    if (/\s/.test(character)) return character === " " ? "SPACE" : "WS"
  }
  return characterDescription(local)
}

const characterDescription = (value: string): string => {
  for (const character of value) {
    if (!/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]/.test(character)) {
      const code = character.codePointAt(0) ?? 0
      if (code > 126) return "NON printable"
      return `'${character}'`
    }
  }
  return "SPACE"
}

const emailValidationError = (value: string) => {
  const error = emailErrorOf(value)
  if (!error) return undefined
  return {
    type: "value_error",
    loc: ["body", "email"],
    msg: error.msg,
    input: value,
    ctx: { reason: error.reason },
  }
}

/** Pydantic date parsing mirroring the sandbox's `date` field error taxonomy. */
const dobValidationError = (value: unknown) => {
  if (typeof value === "string") {
    const codePoints = [...value]
    if (codePoints.some((character) => (character.codePointAt(0) ?? 0) > 127)) {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, invalid character in year",
        input: value,
        ctx: { error: "invalid character in year" },
      }
    }
    if (/^\d+$/.test(value)) {
      return {
        type: "date_from_datetime_inexact",
        loc: ["body", "dob"],
        msg: "Datetimes provided to dates should have zero time - e.g. be exact dates",
        input: value,
      }
    }
    if (value.length < 10) {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, input is too short",
        input: value,
        ctx: { error: "input is too short" },
      }
    }
    const iso = value.match(/^(\d{4})([-/])(\d{2}|[^-])\2(\d{2}|[^-]*)(.*)$/)
    if (iso === null) {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, invalid character in year",
        input: value,
        ctx: { error: "invalid character in year" },
      }
    }
    const [, year = "", separator = "-", monthRaw = "", dayRaw = "", rest = ""] = iso
    if (separator !== "-") {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, invalid date separator, expected `-`",
        input: value,
        ctx: { error: "invalid date separator, expected `-`" },
      }
    }
    if (!/^\d+$/.test(year ?? "")) {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, invalid character in year",
        input: value,
        ctx: { error: "invalid character in year" },
      }
    }
    if (!/^\d+$/.test(monthRaw ?? "")) {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, invalid character in month",
        input: value,
        ctx: { error: "invalid character in month" },
      }
    }
    if (!/^\d+$/.test(dayRaw ?? "")) {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, invalid character in day",
        input: value,
        ctx: { error: "invalid character in day" },
      }
    }
    const month = Number(monthRaw)
    if (month < 1 || month > 12) {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, month value is outside expected range of 1-12",
        input: value,
        ctx: { error: "month value is outside expected range of 1-12" },
      }
    }
    const day = Number(dayRaw)
    const yearNumber = Number(year)
    const daysInMonth = new Date(Date.UTC(yearNumber, month, 0)).getUTCDate()
    if (day < 1 || day > daysInMonth) {
      return {
        type: "date_from_datetime_parsing",
        loc: ["body", "dob"],
        msg: "Input should be a valid date or datetime, day value is outside expected range",
        input: value,
        ctx: { error: "day value is outside expected range" },
      }
    }
    if (rest !== "" && !/^T00:00:00(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(rest)) {
      return {
        type: "date_from_datetime_inexact",
        loc: ["body", "dob"],
        msg: "Datetimes provided to dates should have zero time - e.g. be exact dates",
        input: value,
      }
    }
    return undefined
  }
  if (typeof value === "number") {
    return {
      type: "date_from_datetime_inexact",
      loc: ["body", "dob"],
      msg: "Datetimes provided to dates should have zero time - e.g. be exact dates",
      input: value,
    }
  }
  return {
    type: "date_type",
    loc: ["body", "dob"],
    msg: "Input should be a valid date",
    input: value,
  }
}

const userInfoValidationErrors = (body: Record<string, unknown>): unknown[] => {
  const errors: unknown[] = []
  const push = (error: unknown) => {
    if (error) errors.push(error)
  }

  // Field-by-field, in the sandbox's fixed order; each field emits its missing OR
  // type/value error before moving to the next.
  for (const field of ["first_name", "last_name"] as const) {
    const value = body[field]
    if (value === undefined) push(missingError(field, body))
    else if (typeof value !== "string") push(stringError(field, value))
  }

  const email = body.email
  if (email === undefined) push(missingError("email", body))
  else if (typeof email !== "string") push(stringError("email", email))
  else push(emailValidationError(email))

  const phone = body.phone_number
  if (phone === undefined) push(missingError("phone_number", body))
  else if (phone === null) {
    push({
      type: "value_error",
      loc: ["body", "phone_number"],
      msg: "Value error, Phone number cannot be None",
      input: null,
      ctx: { error: {} },
    })
  } else if (typeof phone === "string") {
    const digits = phone.replace(/\D/g, "")
    if (digits.length < 10 || !/^[\d\s()+-]*$/.test(phone)) {
      push({
        type: "value_error",
        loc: ["body", "phone_number"],
        msg: `Value error, Invalid phone number: ${phone}`,
        input: phone,
        ctx: { error: {} },
      })
    }
  }

  const gender = body.gender
  if (gender === undefined) push(missingError("gender", body))
  else if (typeof gender !== "string") push(stringError("gender", gender))

  if (body.dob === undefined) push(missingError("dob", body))
  else push(dobValidationError(body.dob))

  const address = body.address
  if (address === undefined) push(missingError("address", body))
  else if (address === null || typeof address !== "object" || Array.isArray(address)) {
    push({
      type: "model_attributes_type",
      loc: ["body", "address"],
      msg: "Input should be a valid dictionary or object to extract fields from",
      input: address,
    })
  } else {
    const addressRecord = address as Record<string, unknown>
    for (const field of ["first_line", "country", "zip", "city", "state"] as const) {
      const value = addressRecord[field]
      if (value === undefined) push(missingError(`address.${field}`, addressRecord))
      else if (typeof value !== "string") push(stringError(`address.${field}`, value))
    }
    if (addressRecord.second_line !== undefined && typeof addressRecord.second_line !== "string") {
      push(stringError("address.second_line", addressRecord.second_line))
    }
  }
  return errors
}

export const userHandlers = (state: JunctionState) => ({
  patch_user_info_v2_user__user_id__info_patch: async (context: OperationContext) => {
    const id = context.params.user_id ?? ""
    const body = jsonBody(context)
    const errors = userInfoValidationErrors(body)
    if (errors.length > 0) throw new HttpError(422, { detail: errors })
    if (!state.users.has(id)) notFound("User not found")
    const existing = state.userInfo.get(id) ?? {}
    const rawAddress =
      typeof body.address === "object" && body.address !== null && !Array.isArray(body.address)
        ? (body.address as Record<string, unknown>)
        : undefined
    const info = {
      ...existing,
      ...body,
      ...(rawAddress === undefined
        ? {}
        : {
            address: {
              first_line: rawAddress.first_line ?? "",
              second_line: typeof rawAddress.second_line === "string" ? rawAddress.second_line : "",
              country: rawAddress.country ?? "",
              zip: rawAddress.zip ?? "",
              city: rawAddress.city ?? "",
              state: rawAddress.state ?? "",
              access_notes:
                typeof rawAddress.access_notes === "string" ? rawAddress.access_notes : null,
            },
          }),
    }
    state.userInfo.insert(id, info)
    return jsonRes(200, info)
  },

  create_user_v2_user_post: async (context: OperationContext) => {
    const body = jsonBody(context)
    const clientUserId = body.client_user_id
    if (clientUserId === undefined) {
      throw new HttpError(422, {
        detail: [
          {
            type: "missing",
            loc: ["body", "client_user_id"],
            msg: "Field required",
            input: body,
          },
        ],
      })
    }
    if (typeof clientUserId !== "string") {
      throw new HttpError(422, {
        detail: [
          {
            type: "string_type",
            loc: ["body", "client_user_id"],
            msg: "Input should be a valid string",
            input: clientUserId,
          },
        ],
      })
    }
    const existing = state.byClientId.get(clientUserId)
    if (existing) {
      const user = state.users.get(existing.user_id)
      throw new HttpError(400, {
        detail: {
          error_type: "INVALID_REQUEST",
          error_message: "Client user id already exists.",
          user_id: existing.user_id,
          created_on: user?.created_on ?? state.isoNow(context.now),
        },
      })
    }
    const userId = state.nextUserId()
    const createdOn = state.isoNow(context.now)
    const tz =
      typeof body.fallback_time_zone === "string"
        ? { id: body.fallback_time_zone, source_slug: "manual", updated_at: createdOn }
        : null
    const user: UserRecord = {
      user_id: userId,
      team_id: MOCK_TEAM_ID,
      client_user_id: clientUserId,
      created_on: createdOn,
      connected_sources: [],
      fallback_time_zone: tz,
      fallback_birth_date: null,
      ingestion_start: null,
      ingestion_end: null,
    }
    state.users.insert(userId, user)
    state.byClientId.insert(clientUserId, { user_id: userId })
    return jsonRes(200, render(user))
  },

  get_user_v2_user__user_id__get: async (context: OperationContext) => {
    const id = context.params.user_id ?? ""
    if (!isValidUuid(id)) {
      throw new HttpError(422, {
        detail: `Invalid format for parameter user_id: error unmarshaling '${id}' text as *uuid.UUID: invalid UUID length: ${id.length}`,
      })
    }
    const user = state.users.get(id)
    if (user) return jsonRes(200, render(user))
    if (state.deletedUsers.has(id)) {
      throw new HttpError(404, { detail: "You have scheduled this user for deletion." })
    }
    notFound("Not found")
  },

  delete_user_v2_user__user_id__delete: async (context: OperationContext) => {
    const id = context.params.user_id ?? ""
    const user = state.users.get(id)
    if (!user) {
      if (state.deletedUsers.has(id)) {
        throw new HttpError(404, {
          detail: "The user has been scheduled for deletion as per your previous request",
        })
      }
      notFound("The user does not or no longer exists in this team")
    }
    state.users.delete(id)
    state.byClientId.delete(user.client_user_id)
    state.deletedUsers.insert(id, { user_id: id })
    return jsonRes(200, { success: true })
  },

  get_user_by_client_user_id_v2_user_resolve__client_user_id__get: async (
    context: OperationContext,
  ) => {
    const clientUserId = context.params.client_user_id ?? ""
    const binding = state.byClientId.get(clientUserId)
    if (!binding) notFound("User not found")
    const user = state.users.get(binding.user_id)
    if (!user) notFound("User not found")
    return jsonRes(200, render(user))
  },

  patch_user_v2_user__user_id__patch: async (context: OperationContext) => {
    const id = context.params.user_id ?? ""
    const user = state.users.get(id)
    if (!user) {
      if (state.deletedUsers.has(id)) {
        throw new HttpError(404, {
          detail: "The user has been scheduled for deletion as per your previous request",
        })
      }
      notFound("The user does not or no longer exists in this team")
    }
    const body = jsonBody(context)
    const now = state.isoNow(context.now)
    const patchable = [
      "client_user_id",
      "fallback_time_zone",
      "fallback_birth_date",
      "ingestion_start",
      "ingestion_end",
    ]
    if (!patchable.some((key) => body[key] !== undefined)) {
      throw new HttpError(400, { detail: "Nothing to patch" })
    }
    const validationError = (): unknown => {
      const tz = body.fallback_time_zone
      if (tz !== undefined && tz !== null) {
        if (typeof tz !== "string") return stringError("fallback_time_zone", tz)
        if (!isValidIanaTimezone(tz)) {
          return {
            type: "value_error",
            loc: ["body", "fallback_time_zone"],
            msg: `Value error, Invalid IANA time zone: ${tz}`,
            input: tz,
            ctx: { error: {} },
          }
        }
      }
      const birth = body.fallback_birth_date
      if (birth !== undefined && birth !== null) {
        if (typeof birth !== "string") return stringError("fallback_birth_date", birth)
        if (!isValidDate(birth)) return dateError("fallback_birth_date", birth)
      }
      const start = body.ingestion_start
      if (start !== undefined && start !== null) {
        if (typeof start !== "string") return stringError("ingestion_start", start)
        if (!isValidDate(start)) return dateError("ingestion_start", start)
      }
      const end = body.ingestion_end
      if (end !== undefined && end !== null) {
        if (typeof end !== "string") return stringError("ingestion_end", end)
        if (!isValidDate(end)) return dateError("ingestion_end", end)
      }
      const cid = body.client_user_id
      if (cid !== undefined) {
        if (cid === null) {
          return {
            type: "value_error",
            loc: ["body"],
            msg: "Value error, client_user_id is not a field that can be reset to null.",
            input: body,
            ctx: { error: {} },
          }
        }
        if (typeof cid !== "string") return stringError("client_user_id", cid)
      }
      return undefined
    }
    const error = validationError()
    if (error) throw new HttpError(422, { detail: [error] })
    if (body.client_user_id !== undefined) {
      const raw = body.client_user_id as string
      const taken = state.byClientId.get(raw)
      if (taken && taken.user_id !== id)
        throw new HttpError(409, { detail: "Client user id already exists" })
      state.byClientId.delete(user.client_user_id)
      state.byClientId.insert(raw, { user_id: id })
      user.client_user_id = raw
    }
    if (body.fallback_time_zone !== undefined) {
      const raw = body.fallback_time_zone
      user.fallback_time_zone =
        typeof raw === "string" ? { id: raw, source_slug: "manual", updated_at: now } : null
    }
    if (body.fallback_birth_date !== undefined) {
      const raw = body.fallback_birth_date
      user.fallback_birth_date =
        typeof raw === "string" ? { value: raw, source_slug: "manual", updated_at: now } : null
    }
    const startProvided = body.ingestion_start !== undefined
    const endProvided = body.ingestion_end !== undefined
    if (startProvided) {
      const raw = body.ingestion_start
      user.ingestion_start = typeof raw === "string" ? raw : null
    }
    if (endProvided) {
      const rawEnd = body.ingestion_end
      user.ingestion_end = typeof rawEnd === "string" ? rawEnd : null
    }
    state.users.update(id, user)
    return new Response(null, { status: 204 })
  },

  get_latest_user_info_user_v2_user__user_id__info_latest_get: async (
    context: OperationContext,
  ) => {
    const id = context.params.user_id ?? ""
    if (!isValidUuid(id)) {
      throw new HttpError(422, {
        detail: `Invalid format for parameter user_id: error unmarshaling '${id}' text as *uuid.UUID: invalid UUID length: ${id.length}`,
      })
    }
    if (!state.users.has(id) && !state.deletedUsers.has(id)) notFound("User not found")
    const info = state.userInfo.get(id)
    if (!info) notFound("User demographics data not found")
    return jsonRes(200, info)
  },

  get_teams_users_v2_user_get: async (context: OperationContext) => {
    const offset = queryInt(context, "offset", 0)
    const limit = queryInt(context, "limit", 100)
    if (offset < 0 || limit < 0 || limit > 500) {
      throw new HttpError(500, "Internal Server Error", { "content-type": "text/plain" })
    }
    return jsonRes(200, listUsers(state, offset, limit))
  },
})
