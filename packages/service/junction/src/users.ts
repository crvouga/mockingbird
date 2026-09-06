import { HttpError, jsonResponse, type OperationContext } from "@crvouga/mockingbird-service"
import type { JunctionState, UserRecord } from "./state.js"
import { MOCK_TEAM_ID } from "./state.js"

const jsonBody = (context: OperationContext): Record<string, unknown> => {
  if (
    context.body.kind !== "json" ||
    typeof context.body.value !== "object" ||
    context.body.value === null
  ) {
    throw new HttpError(422, { detail: "expected a JSON object body" })
  }
  return context.body.value as Record<string, unknown>
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

function notFound(): never {
  throw new HttpError(404, { detail: "User not found" })
}

const queryInt = (context: OperationContext, name: string, fallback: number): number => {
  const raw = context.query[name]
  if (raw === undefined) return fallback
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw))
    throw new HttpError(422, { detail: `${name} must be an integer` })
  return Number(raw)
}

export const userHandlers = (state: JunctionState) => ({
  create_user_v2_user_post: async (context: OperationContext) => {
    const body = jsonBody(context)
    const clientUserId = body.client_user_id
    if (typeof clientUserId !== "string" || clientUserId.length === 0) {
      throw new HttpError(422, { detail: "client_user_id is required" })
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
    if (!user) notFound()
    return jsonResponse(200, render(user))
  },

  delete_user_v2_user__user_id__delete: async (context: OperationContext) => {
    const id = context.params.user_id ?? ""
    const user = state.users.get(id)
    if (!user) notFound()
    state.users.delete(id)
    state.byClientId.delete(user.client_user_id)
    return jsonResponse(200, { success: true })
  },

  get_user_by_client_user_id_v2_user_resolve__client_user_id__get: async (
    context: OperationContext,
  ) => {
    const clientUserId = context.params.client_user_id ?? ""
    const binding = state.byClientId.get(clientUserId)
    if (!binding) notFound()
    const user = state.users.get(binding.user_id)
    if (!user) notFound()
    return jsonResponse(200, render(user))
  },

  patch_user_v2_user__user_id__patch: async (context: OperationContext) => {
    const id = context.params.user_id ?? ""
    const user = state.users.get(id)
    if (!user) notFound()
    const body = jsonBody(context)
    const now = state.isoNow(context.now)
    if (body.client_user_id !== undefined) {
      const raw = body.client_user_id
      if (raw !== null && (typeof raw !== "string" || raw.length === 0)) {
        throw new HttpError(422, { detail: "client_user_id must be a non-empty string" })
      }
      if (typeof raw === "string") {
        const taken = state.byClientId.get(raw)
        if (taken && taken.user_id !== id)
          throw new HttpError(422, { detail: "client_user_id already in use" })
        state.byClientId.delete(user.client_user_id)
        state.byClientId.insert(raw, { user_id: id })
        user.client_user_id = raw
      }
    }
    if (body.fallback_time_zone !== undefined) {
      const raw = body.fallback_time_zone
      if (raw !== null && typeof raw !== "string")
        throw new HttpError(422, { detail: "fallback_time_zone must be a string or null" })
      user.fallback_time_zone =
        typeof raw === "string" ? { id: raw, source_slug: "manual", updated_at: now } : null
    }
    if (body.fallback_birth_date !== undefined) {
      const raw = body.fallback_birth_date
      if (raw !== null && typeof raw !== "string")
        throw new HttpError(422, { detail: "fallback_birth_date must be a string or null" })
      user.fallback_birth_date =
        typeof raw === "string" ? { value: raw, source_slug: "manual", updated_at: now } : null
    }
    if (body.ingestion_start !== undefined) {
      const raw = body.ingestion_start
      if (raw !== null && typeof raw !== "string")
        throw new HttpError(422, { detail: "ingestion_start must be a string or null" })
      user.ingestion_start = typeof raw === "string" ? raw : null
    }
    if (body.ingestion_end !== undefined) {
      const raw = body.ingestion_end
      if (raw !== null && typeof raw !== "string")
        throw new HttpError(422, { detail: "ingestion_end must be a string or null" })
      user.ingestion_end = typeof raw === "string" ? raw : null
    }
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
