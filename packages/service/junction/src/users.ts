import { HttpError, jsonResponse, type OperationContext } from "@crvouga/mockingbird-service"
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

const render = (user: UserRecord) => ({
  user_id: user.user_id,
  team_id: user.team_id,
  client_user_id: user.client_user_id,
  created_on: user.created_on,
  connected_sources: user.connected_sources,
  fallback_time_zone: user.fallback_time_zone,
  fallback_birth_date: user.fallback_birth_date,
  ingestion_start: user.ingestion_start,
  ingestion_end: user.ingestion_end,
})

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
  loc: ["body", path],
  msg: "Input should be a valid string",
  input: value,
})

const dateError = (path: string, value: unknown) => {
  const input = String(value)
  if (input === "" || input.length < 4) {
    return {
      type: "date_from_datetime_parsing",
      loc: ["body", path],
      msg: "Input should be a valid date or datetime, input is too short",
      input: value,
      ctx: { error: "input is too short" },
    }
  }
  return {
    type: "date_from_datetime_parsing",
    loc: ["body", path],
    msg: "Input should be a valid date or datetime, invalid character in year",
    input: value,
    ctx: { error: "invalid character in year" },
  }
}

export const userHandlers = (state: JunctionState) => ({
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
    return jsonResponse(200, render(user))
  },

  get_user_v2_user__user_id__get: async (context: OperationContext) => {
    const id = context.params.user_id ?? ""
    const user = state.users.get(id)
    if (user) return jsonResponse(200, render(user))
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
    return jsonResponse(200, { success: true })
  },

  get_user_by_client_user_id_v2_user_resolve__client_user_id__get: async (
    context: OperationContext,
  ) => {
    const clientUserId = context.params.client_user_id ?? ""
    const binding = state.byClientId.get(clientUserId)
    if (!binding) notFound("User not found")
    const user = state.users.get(binding.user_id)
    if (!user) notFound("User not found")
    return jsonResponse(200, render(user))
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
    if (body.client_user_id !== undefined) {
      const raw = body.client_user_id
      if (raw === null) {
        throw new HttpError(422, {
          detail: [
            {
              type: "value_error",
              loc: ["body"],
              msg: "Value error, client_user_id is not a field that can be reset to null.",
              input: body,
              ctx: { error: {} },
            },
          ],
        })
      }
      if (typeof raw !== "string")
        throw new HttpError(422, { detail: [stringError("client_user_id", raw)] })
      const taken = state.byClientId.get(raw)
      if (taken && taken.user_id !== id)
        throw new HttpError(409, { detail: "Client user id already exists" })
      state.byClientId.delete(user.client_user_id)
      state.byClientId.insert(raw, { user_id: id })
      user.client_user_id = raw
    }
    if (body.fallback_time_zone !== undefined) {
      const raw = body.fallback_time_zone
      if (raw !== null && typeof raw !== "string")
        throw new HttpError(422, { detail: [stringError("fallback_time_zone", raw)] })
      if (typeof raw === "string" && !isValidIanaTimezone(raw)) {
        throw new HttpError(422, {
          detail: [
            {
              type: "value_error",
              loc: ["body", "fallback_time_zone"],
              msg: `Value error, Invalid IANA time zone: ${raw}`,
              input: raw,
              ctx: { error: {} },
            },
          ],
        })
      }
      user.fallback_time_zone =
        typeof raw === "string" ? { id: raw, source_slug: "manual", updated_at: now } : null
    }
    if (body.fallback_birth_date !== undefined) {
      const raw = body.fallback_birth_date
      if (raw !== null && typeof raw !== "string")
        throw new HttpError(422, { detail: [stringError("fallback_birth_date", raw)] })
      if (typeof raw === "string" && !isValidDate(raw)) {
        throw new HttpError(422, { detail: [dateError("fallback_birth_date", raw)] })
      }
      user.fallback_birth_date =
        typeof raw === "string" ? { value: raw, source_slug: "manual", updated_at: now } : null
    }
    const startProvided = body.ingestion_start !== undefined
    const endProvided = body.ingestion_end !== undefined
    let newStart = user.ingestion_start
    if (startProvided) {
      const raw = body.ingestion_start
      if (raw !== null && typeof raw !== "string")
        throw new HttpError(422, { detail: [stringError("ingestion_start", raw)] })
      if (typeof raw === "string" && !isValidDate(raw)) {
        throw new HttpError(422, { detail: [dateError("ingestion_start", raw)] })
      }
      newStart = typeof raw === "string" ? raw : null
    }
    let newEnd = user.ingestion_end
    if (newStart === null) {
      newEnd = null
    } else if (endProvided) {
      const raw = body.ingestion_end
      if (raw !== null && typeof raw !== "string")
        throw new HttpError(422, { detail: [stringError("ingestion_end", raw)] })
      if (typeof raw === "string" && !isValidDate(raw)) {
        throw new HttpError(422, { detail: [dateError("ingestion_end", raw)] })
      }
      newEnd = typeof raw === "string" ? raw : "0001-01-01"
    } else if (startProvided) {
      newEnd = "0001-01-01"
    }
    user.ingestion_start = newStart
    user.ingestion_end = newEnd
    state.users.update(id, user)
    return new Response(null, { status: 204 })
  },

  get_teams_users_v2_user_get: async (context: OperationContext) => {
    const offset = queryInt(context, "offset", 0)
    const limit = queryInt(context, "limit", 100)
    if (offset < 0 || limit < 1 || limit > 500)
      throw new HttpError(422, { detail: "offset must be >= 0 and limit must be 1..500" })
    const all = state.users.list({ order: "oldest" })
    return jsonResponse(200, {
      users: all.slice(offset, offset + limit).map((entry) => render(entry.value)),
      total: all.length,
      offset,
      limit,
    })
  },
})
