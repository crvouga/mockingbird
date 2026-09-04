import { HttpError, jsonResponse, type OperationContext } from "@crvouga/mockingbird-service"
import type { JunctionState, UserRecord } from "./state.js"
import { MOCK_TEAM_ID } from "./state.js"

const jsonBody = (context: OperationContext): Record<string, unknown> => {
  if (context.body.kind !== "json" || typeof context.body.value !== "object" || context.body.value === null) {
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

const notFound = () => {
  throw new HttpError(404, { detail: "User not found" })
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
    return jsonResponse(200, render(user as UserRecord))
  },

  delete_user_v2_user__user_id__delete: async (context: OperationContext) => {
    const id = context.params.user_id ?? ""
    const user = state.users.get(id)
    if (!user) notFound()
    state.users.delete(id)
    state.byClientId.delete((user as UserRecord).client_user_id)
    return jsonResponse(200, { success: true })
  },
})
