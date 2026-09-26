/**
 * The test backdoor: users and orders put straight into a namespace, with ids a suite
 * chooses — the Junction `user_id`s a database fixture already carries, or an order
 * already in some status — plus the lenient identity mode that adopts unknown users.
 *
 * Everything inserted here goes through the records `create_user` and `create_order`
 * build, so no read path can tell a fixture from an API-created resource.
 */
import { HttpError, type OperationContext } from "@crvouga/mockingbird-service"
import { resolveTransition } from "./admin.js"
import { missing } from "./not-found.js"
import { buildOrderRecord, persistOrderRecord } from "./orders.js"
import { forceOrderStatus } from "./scheduling.js"
import type { JunctionState, OrderRecord, ResultFixture, UserRecord } from "./state.js"

/** How requests referring to a user the namespace does not hold are answered. */
export type IdentityMode = "strict" | "adopt-users"

export const IDENTITY_MODES: readonly IdentityMode[] = ["strict", "adopt-users"]

export type UserFixture = {
  /** Default: a fresh id, as `create_user` would mint. */
  user_id?: string
  client_user_id: string
  /** ISO-8601. Default: the mock clock's now. */
  created_on?: string
  /** An IANA zone, or the full `{ id, source_slug, updated_at }` object. */
  fallback_time_zone?: string | UserRecord["fallback_time_zone"]
  /** `YYYY-MM-DD`, or the full `{ value, source_slug, updated_at }` object. */
  fallback_birth_date?: string | UserRecord["fallback_birth_date"]
  ingestion_start?: string | null
  ingestion_end?: string | null
}

export type OrderFixture = {
  /** Default: a fresh id, as `create_order` would mint. */
  order_id?: string
  user_id: string
  lab_test_id: string
  lab_account_id?: string
  /** A transition target (`completed`, `at_lab`, or a full status). Default: just ordered. */
  status?: string
  /** Default: the lab test's own method. */
  collection_method?: string
  patient_details?: Record<string, unknown>
  patient_address?: Record<string, unknown>
  billing_type?: string
  icd_codes?: string[] | null
  passthrough?: string | null
  clinical_notes?: string | null
  /** ISO-8601. Default: the mock clock's now. */
  created_at?: string
  /** Results served for the order, as `PUT /__admin/results/{id}` takes them. */
  result_fixture?: Omit<ResultFixture, "name"> & { name?: string }
}

export type JunctionFixtures = {
  users?: readonly UserFixture[]
  orders?: readonly OrderFixture[]
}

export type InsertOptions = {
  /** Publish the webhooks the equivalent API calls would. Default `false`. */
  emitWebhooks?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: string): boolean => UUID.test(value)

/** A backdoor failure: `status` 400 for a bad fixture, 404 for a missing reference, 409 for a clash. */
export class FixtureError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = "FixtureError"
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const instant = (value: unknown, field: string, fallback: string): string => {
  if (value === undefined) return fallback
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new FixtureError(400, `${field} must be an ISO-8601 timestamp`)
  return value
}

const DEFAULT_PATIENT_DETAILS = {
  first_name: "Mockingbird",
  last_name: "Fixture",
  dob: "1990-01-01",
  gender: "female",
  phone_number: "+14155550100",
  email: "fixture@example.com",
}

const DEFAULT_PATIENT_ADDRESS = {
  first_line: "1 Main St",
  second_line: "",
  city: "New York",
  state: "NY",
  zip: "10001",
  country: "US",
}

/** The user record `create_user` would store for `input`, validated but not stored. */
export const buildUser = (
  state: JunctionState,
  input: UserFixture,
  now: () => number,
): UserRecord => {
  if (!isRecord(input)) throw new FixtureError(400, "a user fixture must be an object")
  if (typeof input.client_user_id !== "string" || input.client_user_id === "")
    throw new FixtureError(400, "client_user_id must be a non-empty string")
  if (input.user_id !== undefined && (typeof input.user_id !== "string" || !isUuid(input.user_id)))
    throw new FixtureError(400, `user_id must be a UUID (got ${JSON.stringify(input.user_id)})`)
  const createdOn = instant(input.created_on, "created_on", state.isoNow(now))
  const zone = input.fallback_time_zone
  const birth = input.fallback_birth_date
  return {
    user_id: input.user_id ?? state.nextUserId(),
    team_id: state.teamId,
    client_user_id: input.client_user_id,
    created_on: createdOn,
    connected_sources: [],
    fallback_time_zone:
      typeof zone === "string"
        ? { id: zone, source_slug: "manual", updated_at: createdOn }
        : (zone ?? null),
    fallback_birth_date:
      typeof birth === "string"
        ? { value: birth, source_slug: "manual", updated_at: createdOn }
        : (birth ?? null),
    ingestion_start: input.ingestion_start ?? null,
    ingestion_end: input.ingestion_end ?? null,
  }
}

/** Insert every user, or none: all are validated (ids and client ids unique) first. */
export const insertUsers = (
  state: JunctionState,
  inputs: readonly UserFixture[],
  now: () => number,
): UserRecord[] => {
  const users: UserRecord[] = []
  const ids = new Set<string>()
  const clientIds = new Set<string>()
  for (const input of inputs) {
    const user = buildUser(state, input, now)
    if (
      ids.has(user.user_id) ||
      state.users.has(user.user_id) ||
      state.deletedUsers.has(user.user_id)
    )
      throw new FixtureError(409, `user ${user.user_id} already exists`)
    if (clientIds.has(user.client_user_id) || state.byClientId.has(user.client_user_id))
      throw new FixtureError(409, `client_user_id ${user.client_user_id} already exists`)
    ids.add(user.user_id)
    clientIds.add(user.client_user_id)
    users.push(user)
  }
  for (const user of users) state.insertUser(user)
  return users
}

/** Remove a user outright: unlike `DELETE /v2/user/{id}` it leaves no deletion tombstone. */
export const hardDeleteUser = (state: JunctionState, userId: string): boolean => {
  const user = state.users.get(userId)
  const tombstoned = state.deletedUsers.delete(userId)
  if (!user) return tombstoned
  state.users.delete(userId)
  state.byClientId.delete(user.client_user_id)
  state.userInfo.delete(userId)
  return true
}

type PreparedOrder = {
  input: OrderFixture
  order: OrderRecord
  labTest: NonNullable<ReturnType<JunctionState["labTestById"]>>
  details: Record<string, unknown>
  address: Record<string, unknown>
  status: string | undefined
}

/**
 * Insert orders through `create_order`'s record builder. Request validation is skipped
 * (a fixture may hold what the API would refuse) but references are not: the user and
 * lab test must exist. Every order is checked before any is stored.
 */
export const insertOrders = (
  state: JunctionState,
  inputs: readonly OrderFixture[],
  now: () => number,
  options: InsertOptions = {},
): OrderRecord[] => {
  const prepared: PreparedOrder[] = []
  const ids = new Set<string>()
  for (const input of inputs) {
    if (!isRecord(input)) throw new FixtureError(400, "an order fixture must be an object")
    if (typeof input.user_id !== "string") throw new FixtureError(400, "user_id is required")
    if (typeof input.lab_test_id !== "string")
      throw new FixtureError(400, "lab_test_id is required")
    if (!state.users.has(input.user_id) && !state.deletedUsers.has(input.user_id))
      throw new FixtureError(404, `no user ${input.user_id} in this namespace`)
    const labTest = state.labTestById(input.lab_test_id)
    if (!labTest) throw new FixtureError(404, `no lab test ${input.lab_test_id} in the catalog`)
    if (
      input.order_id !== undefined &&
      (typeof input.order_id !== "string" || !isUuid(input.order_id))
    )
      throw new FixtureError(400, `order_id must be a UUID (got ${JSON.stringify(input.order_id)})`)
    const orderId = input.order_id ?? state.nextOrderId()
    if (ids.has(orderId) || state.orders.has(orderId))
      throw new FixtureError(409, `order ${orderId} already exists`)
    ids.add(orderId)
    const method =
      typeof input.collection_method === "string" && input.collection_method !== ""
        ? input.collection_method
        : typeof labTest.method === "string" && labTest.method !== ""
          ? labTest.method
          : "at_home_phlebotomy"
    let status: string | undefined
    if (input.status !== undefined) {
      if (typeof input.status !== "string") throw new FixtureError(400, "status must be a string")
      const resolved = resolveTransition(method, input.status)
      if ("error" in resolved) throw new FixtureError(400, resolved.error)
      status = resolved.status
    }
    const details = { ...DEFAULT_PATIENT_DETAILS, ...input.patient_details }
    const address = { ...DEFAULT_PATIENT_ADDRESS, ...input.patient_address }
    const createdAt = input.created_at
    const createdMs =
      createdAt === undefined ? undefined : Date.parse(instant(createdAt, "created_at", ""))
    const order = buildOrderRecord(
      state,
      {
        orderId,
        userId: input.user_id,
        labTest,
        method,
        patientDetails: details,
        patientAddress: address,
        billingType: input.billing_type ?? "client_bill",
        icdCodes: input.icd_codes ?? null,
        clinicalNotes: input.clinical_notes ?? null,
        passthrough: input.passthrough ?? null,
      },
      createdMs === undefined ? now : () => createdMs,
    )
    prepared.push({ input, order, labTest, details, address, status })
  }
  const run = () => {
    for (const { input, order, labTest, details, address, status } of prepared) {
      persistOrderRecord(state, order, labTest, details, address)
      state.orderLabAccounts.insert(order.id, { lab_account_id: input.lab_account_id ?? null })
      state.publishOrderWebhook(order, "labtest.order.created", now())
      if (status !== undefined) {
        const stored = state.orders.get(order.id)
        if (stored) forceOrderStatus(state, stored, status, null, { now })
      }
      if (input.result_fixture !== undefined) {
        state.resultFixtures.insert(order.id, { name: "custom", ...input.result_fixture })
        if (input.result_fixture.interpretation !== undefined) {
          const stored = state.orders.get(order.id)
          if (stored) {
            stored.interpretation = input.result_fixture.interpretation
            state.orders.update(order.id, stored)
          }
        }
      }
    }
  }
  if (options.emitWebhooks === true) run()
  else state.muteWebhooks(run)
  return prepared.flatMap(({ order }) => state.orders.get(order.id) ?? [])
}

/** Load users, then orders, in one call: how `POST /__admin/import` and `serve --fixtures` work. */
export const importFixtures = (
  state: JunctionState,
  fixtures: JunctionFixtures,
  now: () => number,
  options: InsertOptions = {},
): { users: UserRecord[]; orders: OrderRecord[] } => {
  if (!isRecord(fixtures))
    throw new FixtureError(400, 'fixtures must be { "users": [...], "orders": [...] }')
  const { users = [], orders = [] } = fixtures
  if (!Array.isArray(users)) throw new FixtureError(400, "users must be an array")
  if (!Array.isArray(orders)) throw new FixtureError(400, "orders must be an array")
  // Orders reference users from the same file, so users go in first; a failed order
  // check then leaves those users behind unless the whole import is rolled back.
  const inserted = insertUsers(state, users, now)
  try {
    return { users: inserted, orders: insertOrders(state, orders, now, options) }
  } catch (error) {
    for (const user of inserted) hardDeleteUser(state, user.user_id)
    throw error
  }
}

/**
 * The one place a request's `user_id` is resolved. In `strict` mode an unknown user is
 * Junction's 404; in `adopt-users` mode a well-formed UUID is created on first use (the
 * adoption is noted for the request journal). A deleted user still resolves, as in Junction.
 */
export const requireUser = (
  state: JunctionState,
  userId: string,
  context: Pick<OperationContext, "request" | "now">,
  detail = "User does not exist on this team",
): void => {
  if (state.users.has(userId) || state.deletedUsers.has(userId)) return
  if (state.identity === "adopt-users" && isUuid(userId)) {
    insertUsers(state, [{ user_id: userId, client_user_id: userId }], context.now)
    state.noteAdoption(context.request)
    return
  }
  missing(state, "user", userId, detail)
}

/** An admin-style error for a {@link FixtureError}; anything else is rethrown. */
export const fixtureErrorMessage = (error: unknown): { status: number; message: string } => {
  if (error instanceof FixtureError) return { status: error.status, message: error.message }
  if (error instanceof HttpError) {
    const detail = isRecord(error.body) ? error.body.detail : error.body
    return {
      status: error.status,
      message: typeof detail === "string" ? detail : JSON.stringify(detail),
    }
  }
  throw error
}
