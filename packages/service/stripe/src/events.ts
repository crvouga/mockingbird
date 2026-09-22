import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { invalidRequest, resourceMissing } from "./errors.js"
import { requestScope, type Services } from "./internal.js"
import { clampLimit, matchesCreated } from "./list.js"
import { queryParams } from "./params.js"
import { renderEvent } from "./render.js"
import type { WebhookEventRecord } from "./state.js"

/**
 * The event ledger is keyed by insertion sequence, not by `evt_` id, so cursors resolve against
 * the record's public id rather than its storage key. `list` already returns newest first.
 */
const pageEvents = (records: WebhookEventRecord[], params: Record<string, unknown>) => {
  const startingAfter = params.starting_after
  const endingBefore = params.ending_before
  if (
    typeof startingAfter === "string" &&
    startingAfter !== "" &&
    typeof endingBefore === "string" &&
    endingBefore !== ""
  )
    throw invalidRequest(
      "Received both starting_after and ending_before parameters. Please pass in only one.",
    )
  const type = typeof params.type === "string" ? params.type : undefined
  const types = Array.isArray(params.types)
    ? (params.types as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : []
  const where = (record: WebhookEventRecord) =>
    matchesCreated(record.created, params.created) &&
    (type === undefined || type === "" || record.type === type) &&
    (types.length === 0 || types.includes(record.type))
  const cursorIndex = (id: string, param: string) => {
    const index = records.findIndex((record) => record.id === id)
    if (index === -1) throw resourceMissing("notification", id, param, 400)
    return index
  }
  const limit = clampLimit(params.limit)
  let data: WebhookEventRecord[]
  let hasMore: boolean
  if (typeof startingAfter === "string" && startingAfter !== "") {
    const rest = records.slice(cursorIndex(startingAfter, "starting_after") + 1).filter(where)
    data = rest.slice(0, limit)
    hasMore = rest.length > limit
  } else if (typeof endingBefore === "string" && endingBefore !== "") {
    const before = records.slice(0, cursorIndex(endingBefore, "ending_before")).filter(where)
    data = before.slice(Math.max(0, before.length - limit))
    hasMore = before.length > limit
  } else {
    const rows = records.filter(where)
    data = rows.slice(0, limit)
    hasMore = rows.length > limit
  }
  return {
    object: "list" as const,
    data: data.map(renderEvent),
    has_more: hasMore,
    url: "/v1/events",
  }
}

export const eventHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetEvents: async (context) => {
    const scope = requestScope(services, context)
    const records = scope.account.events.list({ order: "newest" }).map((entry) => entry.value)
    // Cursors are checked in Stripe's parameter order, before `types`.
    const cursor = (key: string) => (params: Record<string, unknown>) => {
      const id = params[key]
      if (typeof id === "string" && id !== "" && !records.some((record) => record.id === id))
        throw resourceMissing("notification", id, key, 400)
    }
    const params = queryParams(context, {
      validate: {
        ending_before: cursor("ending_before"),
        starting_after: cursor("starting_after"),
      },
    })
    return jsonResponse(200, pageEvents(records, params))
  },

  GetEventsId: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const id = context.params.id ?? ""
    const record = scope.account.events
      .list({ order: "newest" })
      .find((entry) => entry.value.id === id)?.value
    if (!record) throw resourceMissing("event", id, "id")
    return jsonResponse(200, renderEvent(record))
  },
})
