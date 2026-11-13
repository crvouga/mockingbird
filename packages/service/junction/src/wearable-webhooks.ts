/**
 * Webhook events past the three the lab-testing flow publishes on its own (#758), sent on demand
 * through `POST /__admin/webhooks/emit` and signed like every other delivery.
 *
 * Payloads follow Junction's webhook docs (https://docs.junction.com/webhooks/event-structure,
 * https://docs.junction.com/webhooks/introduction) and the `@tryvital/vital-node` event types:
 * a summary event carries the summary object as `data`; a timeseries event wraps its samples
 * as `data.data` beside `source`, `source_id` and `user_id`; `historical.data.*` is the
 * data-less `{ user_id, start_date, end_date, provider, is_final }`. `labtest.appointment.created`
 * has no documented payload: it carries the appointment, like `labtest.appointment.updated`.
 * All of it is a **best guess, not oracle-verified**.
 */
import type { JunctionState, JunctionWebhookEvent, UserRecord } from "./state.js"
import {
  addDays,
  type ConnectionRecord,
  connectionKey,
  connectionsOf,
  EVENT_RESOURCE,
  isCalendarDate,
  providerRef,
  resourceAvailability,
  SUMMARY_RESOURCES,
  type SummaryResource,
  summaryRecords,
  TIMESERIES_RESOURCES,
  type TimeseriesResource,
  timeseriesSamples,
  type WearableResource,
  wearableProvider,
} from "./wearables.js"

/** A request the emitter refuses; `status` is the admin answer's. */
export class EmitError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "EmitError"
  }
}

export type EmitInput = {
  event_type: string
  user_id?: string
  order_id?: string
  provider?: string
  /** The day a `daily.data.*` event reports. Default: the connection's latest seeded day. */
  calendar_date?: string
  /** `provider.connection.error` only. Default `token_refresh_failed`. */
  error_type?: string
}

const RESOURCE_BY_EVENT_NAME = new Map<string, WearableResource>(
  [...SUMMARY_RESOURCES, ...TIMESERIES_RESOURCES].map((resource) => [
    EVENT_RESOURCE[resource],
    resource,
  ]),
)

/**
 * Documented Junction events the emulator does not model: emitting one is refused with 501,
 * never answered with an invented payload.
 */
const DOCUMENTED_UNMODELLED = [
  /^lab_report\.parsing_job\.(created|updated)$/,
  /^provider\.device\.(created|updated)$/,
  /^labtest\.result\.critical$/,
  /^(daily\.data\.[a-z_0-9]+\.(created|updated)|historical\.data\.[a-z_0-9]+\.created)$/,
]

/** Every event type `POST /__admin/webhooks/emit` sends. */
export const EMITTABLE_EVENT_TYPES: readonly string[] = [
  "labtest.order.created",
  "labtest.order.updated",
  "labtest.appointment.created",
  "labtest.appointment.updated",
  "provider.connection.created",
  "provider.connection.error",
  ...[...RESOURCE_BY_EVENT_NAME.keys()].flatMap((name) => [
    `daily.data.${name}.created`,
    `daily.data.${name}.updated`,
    `historical.data.${name}.created`,
  ]),
]

const requireUser = (state: JunctionState, userId: string | undefined): UserRecord => {
  if (typeof userId !== "string") throw new EmitError(400, 'this event needs "user_id"')
  const user = state.users.get(userId)
  if (!user) throw new EmitError(404, `no user ${userId}`)
  return user
}

/** The user's connection for `provider`, or their only one that reports `resource`. */
const requireConnection = (
  state: JunctionState,
  user: UserRecord,
  provider: string | undefined,
  resource?: WearableResource,
): ConnectionRecord => {
  if (provider !== undefined) {
    const connection = state.connections.get(connectionKey(user.user_id, provider))
    if (!connection)
      throw new EmitError(
        409,
        `user ${user.user_id} has no ${provider} connection; add one with POST /__admin/users/${user.user_id}/connections`,
      )
    if (resource && !wearableProvider(provider)?.resources.includes(resource))
      throw new EmitError(409, `${provider} does not report ${resource}`)
    return connection
  }
  const candidates = connectionsOf(state, user.user_id).filter(
    (connection) =>
      resource === undefined || wearableProvider(connection.provider)?.resources.includes(resource),
  )
  if (candidates.length === 1 && candidates[0]) return candidates[0]
  throw new EmitError(
    candidates.length === 0 ? 409 : 400,
    candidates.length === 0
      ? `user ${user.user_id} has no connection${resource ? ` that reports ${resource}` : ""}; add one with POST /__admin/users/${user.user_id}/connections`
      : `user ${user.user_id} has several connections; name one with "provider"`,
  )
}

const envelope = (
  eventType: JunctionWebhookEvent["event_type"],
  user: UserRecord,
  data: Record<string, unknown>,
): JunctionWebhookEvent => ({
  event_type: eventType,
  data,
  team_id: user.team_id,
  user_id: user.user_id,
  client_user_id: user.client_user_id,
})

const dataEvents = (
  state: JunctionState,
  input: EmitInput,
  kind: "daily" | "historical",
  resource: WearableResource,
  eventType: JunctionWebhookEvent["event_type"],
): JunctionWebhookEvent[] => {
  const user = requireUser(state, input.user_id)
  const connection = requireConnection(state, user, input.provider, resource)
  const provider = wearableProvider(connection.provider)
  if (!provider || connection.data_start === null || connection.data_end === null)
    throw new EmitError(
      409,
      `the ${connection.provider} connection has no data; reconnect it with "days" above 0`,
    )
  if (kind === "historical") {
    return [
      envelope(eventType, user, {
        user_id: user.user_id,
        start_date: `${connection.data_start}T00:00:00+00:00`,
        end_date: `${addDays(connection.data_end, 1)}T00:00:00+00:00`,
        provider: provider.slug,
        is_final: true,
      }),
    ]
  }
  const day = input.calendar_date ?? connection.data_end
  if (!isCalendarDate(day)) throw new EmitError(400, "calendar_date must be YYYY-MM-DD")
  if (day < connection.data_start || day > connection.data_end)
    throw new EmitError(
      409,
      `the ${provider.slug} connection has data from ${connection.data_start} to ${connection.data_end}, not ${day}`,
    )
  if ((SUMMARY_RESOURCES as readonly string[]).includes(resource)) {
    return summaryRecords(
      state,
      user.user_id,
      resource as SummaryResource,
      { start: day, end: day },
      provider.slug,
    ).map((record) => envelope(eventType, user, record))
  }
  return [
    envelope(eventType, user, {
      data: timeseriesSamples(resource as TimeseriesResource, {
        userId: user.user_id,
        provider,
        day,
        createdAt: connection.created_on,
      }),
      source_id: provider.source_id,
      source: providerRef(provider),
      user_id: user.user_id,
    }),
  ]
}

/**
 * Build the events one emit request sends (a day of meals is one event per meal). Updates state
 * where the event implies it: `provider.connection.error` marks the connection errored.
 */
export const buildEmitEvents = (
  state: JunctionState,
  input: EmitInput,
  now: number,
): JunctionWebhookEvent[] => {
  const type = input.event_type
  if (typeof type !== "string" || type === "")
    throw new EmitError(400, `body needs "event_type": one of ${EMITTABLE_EVENT_TYPES.join(", ")}`)

  if (type === "labtest.order.created" || type === "labtest.order.updated") {
    if (typeof input.order_id !== "string") throw new EmitError(400, `${type} needs "order_id"`)
    const order = state.orders.get(input.order_id)
    if (!order) throw new EmitError(404, `no order ${input.order_id}`)
    const user = requireUser(state, order.user_id)
    return [
      {
        ...envelope(type, user, order as unknown as Record<string, unknown>),
        team_id: order.team_id,
      },
    ]
  }

  if (type === "labtest.appointment.created" || type === "labtest.appointment.updated") {
    if (typeof input.order_id !== "string") throw new EmitError(400, `${type} needs "order_id"`)
    const order = state.orders.get(input.order_id)
    if (!order) throw new EmitError(404, `no order ${input.order_id}`)
    const link = state.appointmentsByOrder.get(order.id)
    const appointment = link ? state.appointments.get(link.appointment_id) : undefined
    if (!appointment)
      throw new EmitError(409, `order ${order.id} has no appointment; book one first`)
    const user = requireUser(state, order.user_id)
    return [
      {
        ...envelope(type, user, appointment as unknown as Record<string, unknown>),
        team_id: order.team_id,
      },
    ]
  }

  if (type === "provider.connection.created") {
    const user = requireUser(state, input.user_id)
    const connection = requireConnection(state, user, input.provider)
    const provider = wearableProvider(connection.provider)
    if (!provider) throw new EmitError(409, `unknown provider ${connection.provider}`)
    return [
      envelope(type, user, {
        user_id: user.user_id,
        source: providerRef(provider),
        provider: providerRef(provider),
        external_user_id: connection.external_user_id,
        resource_availability: resourceAvailability(provider),
      }),
    ]
  }

  if (type === "provider.connection.error") {
    const user = requireUser(state, input.user_id)
    const connection = requireConnection(state, user, input.provider)
    const errorType =
      input.error_type ?? connection.error_details?.error_type ?? "token_refresh_failed"
    const message = `The ${wearableProvider(connection.provider)?.name ?? connection.provider} connection needs to be re-authorised.`
    const erroredAt = state.isoNow(() => now)
    state.connections.update(connectionKey(user.user_id, connection.provider), {
      ...connection,
      status: "error",
      error_details: { error_type: errorType, error_message: message, errored_at: erroredAt },
    })
    return [
      envelope(type, user, {
        provider: connection.provider,
        user_id: user.user_id,
        message,
        error_type: errorType,
        error_details: message,
      }),
    ]
  }

  const daily = /^daily\.data\.([a-z_0-9]+)\.(created|updated)$/.exec(type)
  const historical = /^historical\.data\.([a-z_0-9]+)\.created$/.exec(type)
  const name = daily?.[1] ?? historical?.[1]
  const resource = name === undefined ? undefined : RESOURCE_BY_EVENT_NAME.get(name)
  if (resource)
    return dataEvents(
      state,
      input,
      daily ? "daily" : "historical",
      resource,
      type as JunctionWebhookEvent["event_type"],
    )

  if (DOCUMENTED_UNMODELLED.some((pattern) => pattern.test(type)))
    throw new EmitError(
      501,
      `mockingbird: the Junction emulator does not model ${type}; it emits ${EMITTABLE_EVENT_TYPES.join(", ")}`,
    )
  throw new EmitError(
    400,
    `${type} is not in Junction's documented event catalog or the @tryvital/vital-node SDK, so the emulator has no payload to send; it emits ${EMITTABLE_EVENT_TYPES.join(", ")}`,
  )
}
