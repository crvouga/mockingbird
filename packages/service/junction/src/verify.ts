import { canonicalJson, DEFAULT_JUNCTION_BASE_URL } from "./corpus-tools.js"
import { ORDER_NOT_FOUND } from "./not-found.js"
import type { SealedCorpus } from "./sealed-corpus.js"

/**
 * Differential verification: the same requests against real Junction and the mock,
 * with every divergence reported. Two checks:
 *
 * - drift: each recorded corpus observation re-fetched from the real API. A stale
 *   entry means the corpus no longer matches production and should be re-pulled.
 * - scenario: a fixed script of stateful calls (users, catalog, serviceability, and
 *   optionally orders) run against both sides, comparing status codes, response
 *   shapes, and — for the documented error bodies — exact bytes.
 *
 * The scenario also replays every order-scoped operation against a random unknown order
 * (each 404 body compared exactly) and, with `orders` and a corpus holding an account whose
 * `team_id_allowlist` is empty, orders through that account with and without its id. With
 * `orders`, it also orders through every other active account by id with `billing_type`
 * omitted, which shows the billing type the team defaults to.
 *
 * Only a sandbox team should be used: the scenario creates, and always deletes, one
 * user (and, with `orders`, places and cancels its orders).
 */
export type VerifyOptions = {
  realKey: string
  realUrl?: string
  /** The mock under test, e.g. `createRuntime({ corpus })`. */
  mock: { fetch(request: Request): Promise<Response> }
  corpus: SealedCorpus
  /** Re-fetch at most this many observations (spread evenly). Default: all of them. */
  sample?: number
  /** Skip the drift check. */
  skipDrift?: boolean
  /** Also place, read and cancel an order on the real team. */
  orders?: boolean
  fetch?: (request: Request) => Promise<Response>
  minIntervalMs?: number
  onProgress?: (message: string) => void
}

export type Divergence = {
  check: string
  kind: "status" | "shape" | "body" | "error"
  /** JSON path of the first difference, when there is one. */
  at?: string
  real: unknown
  mock: unknown
}

export type VerifyReport = {
  ok: boolean
  drift: { checked: number; stale: number }
  scenario: { steps: number; divergent: number }
  divergences: Divergence[]
}

type Side = "real" | "mock"
type Reply = { status: number; body: unknown }

const readReply = async (response: Response): Promise<Reply> => {
  const text = await response.text()
  try {
    return { status: response.status, body: text === "" ? null : JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

/** The structure of a JSON value: object keys and value types, never the values. */
export const shapeOf = (value: unknown): unknown => {
  if (value === null) return "null"
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])]
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, shapeOf(record[key])]),
    )
  }
  return typeof value
}

/** Path to the first place two JSON values differ, or `undefined` when they are equal. */
export const firstDifference = (a: unknown, b: unknown, path = "$"): string | undefined => {
  if (canonicalJson(a) === canonicalJson(b)) return undefined
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return path
  if (Array.isArray(a) !== Array.isArray(b)) return path
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of [...keys].sort()) {
    const at = Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`
    const found = firstDifference(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      at,
    )
    if (found) return found
  }
  return path
}

type Context = {
  clientUserId: string
  userId?: string
  orderId?: string
  /** Orders placed by the lab-account probes, cancelled with the rest. */
  extraOrders: string[]
}

/** How to reach each order-scoped operation for an unknown order, past its validation. */
const orderScopedCalls = (
  orderId: string,
): Record<string, { method: string; path: string; body?: unknown }> => {
  const base = `/v3/order/${orderId}`
  const key = { booking_key: "00000000-0000-4000-8000-00000000b00c" }
  const reason = { cancellation_reason_id: "00000000-0000-4000-8000-00000000c0de" }
  return {
    get_order_v3_order__order_id__get: { method: "GET", path: base },
    cancel_order_v3_order__order_id__cancel_post: { method: "POST", path: `${base}/cancel` },
    simulate_order_v3_order__order_id__test_post: {
      method: "POST",
      path: `${base}/test?final_status=completed.at_home_phlebotomy.completed`,
      body: {},
    },
    get_order_requisition_pdf_v3_order__order_id__requisition_pdf_get: {
      method: "GET",
      path: `${base}/requisition/pdf`,
    },
    get_result_raw_v3_order__order_id__result_get: { method: "GET", path: `${base}/result` },
    get_result_metadata_v3_order__order_id__result_metadata_get: {
      method: "GET",
      path: `${base}/result/metadata`,
    },
    get_result_pdf_v3_order__order_id__result_pdf_get: {
      method: "GET",
      path: `${base}/result/pdf`,
    },
    get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get: {
      method: "GET",
      path: `${base}/phlebotomy/appointment`,
    },
    book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post: {
      method: "POST",
      path: `${base}/phlebotomy/appointment/book`,
      body: key,
    },
    reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch: {
      method: "PATCH",
      path: `${base}/phlebotomy/appointment/reschedule`,
      body: key,
    },
    cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch: {
      method: "PATCH",
      path: `${base}/phlebotomy/appointment/cancel`,
      body: reason,
    },
    get_psc_appointment_v3_order__order_id__psc_appointment_get: {
      method: "GET",
      path: `${base}/psc/appointment`,
    },
    book_psc_appointment_v3_order__order_id__psc_appointment_book_post: {
      method: "POST",
      path: `${base}/psc/appointment/book`,
      body: key,
    },
    reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch: {
      method: "PATCH",
      path: `${base}/psc/appointment/reschedule`,
      body: key,
    },
    cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch: {
      method: "PATCH",
      path: `${base}/psc/appointment/cancel`,
      body: reason,
    },
  }
}

const orderBody = (
  userId: string | undefined,
  labTestId: string,
  extra: Record<string, unknown> = {},
) => ({
  user_id: userId,
  patient_details: {
    first_name: "Mockingbird",
    last_name: "Verify",
    dob: "1990-01-01",
    gender: "female",
    phone_number: "+14155551234",
    email: "verify@example.com",
  },
  patient_address: {
    first_line: "1 Main St",
    city: "San Diego",
    state: "CA",
    zip: "92101",
    country: "US",
  },
  order_set: { lab_test_ids: [labTestId] },
  ...extra,
})

const captureExtraOrder = (reply: Reply, ctx: Context) => {
  const id = (reply.body as { order?: { id?: unknown } } | null)?.order?.id
  if (typeof id === "string") ctx.extraOrders.push(id)
}

type Step = {
  name: string
  /** `exact`: bodies must match byte for byte; `shape`: structure and types only. */
  compare: "exact" | "shape"
  skip?: (ctx: Record<Side, Context>) => boolean
  request(ctx: Context): { method: string; path: string; body?: unknown }
  capture?(reply: Reply, ctx: Context): void
}

const scenario = (corpus: SealedCorpus, withOrders: boolean): Step[] => {
  const zip =
    Object.keys(corpus.observations)
      .map((key) => /\/v3\/order\/area\/info\?.*zip_code=(\d{5})/.exec(key)?.[1])
      .find((found) => found !== undefined) ?? "92101"
  const labTestId = corpus.catalog.labTests[0]?.id
  const steps: Step[] = [
    {
      name: "user.create",
      compare: "shape",
      request: (ctx) => ({
        method: "POST",
        path: "/v2/user",
        body: { client_user_id: ctx.clientUserId },
      }),
      capture: (reply, ctx) => {
        const id = (reply.body as { user_id?: unknown } | null)?.user_id
        if (typeof id === "string") ctx.userId = id
      },
    },
    {
      name: "user.create duplicate",
      compare: "shape",
      request: (ctx) => ({
        method: "POST",
        path: "/v2/user",
        body: { client_user_id: ctx.clientUserId },
      }),
    },
    {
      name: "user.get",
      compare: "shape",
      request: (ctx) => ({ method: "GET", path: `/v2/user/${ctx.userId}` }),
    },
    {
      name: "user.getByClientUserId",
      compare: "shape",
      request: (ctx) => ({ method: "GET", path: `/v2/user/resolve/${ctx.clientUserId}` }),
    },
    {
      name: "user.get unknown (documented 404 body)",
      compare: "exact",
      request: () => ({ method: "GET", path: "/v2/user/00000000-0000-4000-8000-000000000000" }),
    },
    {
      name: "user.getByClientUserId unknown (documented 404 body)",
      compare: "exact",
      request: (ctx) => ({ method: "GET", path: `/v2/user/resolve/${ctx.clientUserId}-missing` }),
    },
    {
      name: "labs",
      compare: "shape",
      request: () => ({ method: "GET", path: "/v3/lab_tests/labs" }),
    },
    {
      name: "lab tests (bare array)",
      compare: "shape",
      request: () => ({ method: "GET", path: "/v3/lab_tests" }),
    },
    {
      name: `area info ${zip}`,
      compare: "exact",
      request: () => ({ method: "GET", path: `/v3/order/area/info?zip_code=${zip}&radius=100` }),
    },
  ]
  if (withOrders && labTestId) {
    steps.push(
      {
        name: "order.create",
        compare: "shape",
        request: (ctx) => ({
          method: "POST",
          path: "/v3/order",
          body: orderBody(ctx.userId, labTestId),
        }),
        capture: (reply, ctx) => {
          const id = (reply.body as { order?: { id?: unknown } } | null)?.order?.id
          if (typeof id === "string") ctx.orderId = id
        },
      },
      {
        name: "order.get",
        compare: "shape",
        skip: (ctx) => !ctx.real.orderId || !ctx.mock.orderId,
        request: (ctx) => ({ method: "GET", path: `/v3/order/${ctx.orderId}` }),
      },
      {
        name: "order.cancel",
        compare: "shape",
        skip: (ctx) => !ctx.real.orderId || !ctx.mock.orderId,
        request: (ctx) => ({ method: "POST", path: `/v3/order/${ctx.orderId}/cancel` }),
      },
    )
  }
  // Unknown-order 404s: Junction words each endpoint's differently, so every one is exact.
  const unknownOrder = crypto.randomUUID()
  const calls = orderScopedCalls(unknownOrder)
  for (const operationId of Object.keys(ORDER_NOT_FOUND)) {
    const call = calls[operationId]
    if (!call) continue
    steps.push({
      name: `unknown order 404 ${operationId}`,
      compare: "exact",
      request: () => call,
    })
  }
  // What an empty `team_id_allowlist` means for ordering is unverified (SUPPORT.md): order
  // through such an account by explicit id, and with the id omitted, and compare.
  const openAccount = corpus.labAccounts.find(
    (account) =>
      Array.isArray(account.team_id_allowlist) &&
      account.team_id_allowlist.length === 0 &&
      account.status === "active",
  )
  const openLabTest = openAccount
    ? corpus.catalog.labTests.find(
        (test) =>
          String(test.lab?.slug ?? "").toLowerCase() === String(openAccount.lab).toLowerCase(),
      )
    : undefined
  if (withOrders && openAccount && openLabTest) {
    steps.push(
      {
        name: `order.create via empty-allowlist account ${String(openAccount.id)}`,
        compare: "shape",
        request: (ctx) => ({
          method: "POST",
          path: "/v3/order",
          body: orderBody(ctx.userId, openLabTest.id, { lab_account_id: openAccount.id }),
        }),
        capture: captureExtraOrder,
      },
      {
        name: `order.create for ${String(openAccount.lab)} with lab_account_id omitted`,
        compare: "shape",
        request: (ctx) => ({
          method: "POST",
          path: "/v3/order",
          body: orderBody(ctx.userId, openLabTest.id),
        }),
        capture: captureExtraOrder,
      },
    )
  }
  // Which billing_type an order that omits it is evaluated as is not visible from outside
  // (documented: client_bill; one sandbox team evaluated BioReference as
  // patient_bill_passthrough). Order through each active account by id with billing_type
  // omitted, so a mock whose `defaultBillingTypes` disagree with the team diverges here.
  if (withOrders) {
    const labTestFor = (lab: unknown) =>
      corpus.catalog.labTests.find(
        (test) => String(test.lab?.slug ?? "").toLowerCase() === String(lab).toLowerCase(),
      )
    for (const account of corpus.labAccounts) {
      const labTest = labTestFor(account.lab)
      if (account.status !== "active" || account === openAccount || !labTest) continue
      steps.push({
        name: `order.create via ${String(account.lab)} account ${String(account.id)} with billing_type omitted`,
        compare: "shape",
        request: (ctx) => ({
          method: "POST",
          path: "/v3/order",
          body: orderBody(ctx.userId, labTest.id, { lab_account_id: account.id }),
        }),
        capture: captureExtraOrder,
      })
    }
  }
  steps.push({
    name: "user.delete",
    compare: "shape",
    request: (ctx) => ({ method: "DELETE", path: `/v2/user/${ctx.userId}` }),
    capture: (_reply, ctx) => {
      delete ctx.userId
    },
  })
  return steps
}

export const verifyAgainstReal = async (options: VerifyOptions): Promise<VerifyReport> => {
  const realUrl = (options.realUrl ?? DEFAULT_JUNCTION_BASE_URL).replace(/\/$/, "")
  const send = options.fetch ?? ((request: Request) => fetch(request))
  const gap = options.minIntervalMs ?? 50
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const progress = options.onProgress ?? (() => {})
  const divergences: Divergence[] = []

  const call = async (side: Side, method: string, path: string, body?: unknown): Promise<Reply> => {
    const base = side === "real" ? realUrl : "http://mock.mockingbird.local"
    const request = new Request(`${base}${path}`, {
      method,
      headers: {
        "x-vital-api-key": side === "real" ? options.realKey : "sk_us_mockingbird_verify",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const response = side === "real" ? await send(request) : await options.mock.fetch(request)
    return readReply(response)
  }

  // ── drift ────────────────────────────────────────────────────────
  let checked = 0
  let stale = 0
  if (!options.skipDrift) {
    const keys = Object.keys(options.corpus.observations).filter((key) => key.startsWith("GET "))
    const limit = options.sample ?? keys.length
    const stride = Math.max(1, Math.floor(keys.length / Math.max(1, limit)))
    const picked = keys.filter((_, index) => index % stride === 0).slice(0, limit)
    progress(`drift: re-fetching ${picked.length} of ${keys.length} recorded observations`)
    for (const key of picked) {
      const path = key.slice("GET ".length)
      const recorded = options.corpus.observations[key]
      if (!recorded) continue
      checked++
      try {
        const live = await call("real", "GET", path)
        if (live.status !== recorded.status) {
          stale++
          divergences.push({
            check: `drift ${key}`,
            kind: "status",
            real: live.status,
            mock: recorded.status,
          })
        } else {
          const at = firstDifference(live.body, recorded.body)
          if (at) {
            stale++
            divergences.push({
              check: `drift ${key}`,
              kind: "body",
              at,
              real: live.body,
              mock: recorded.body,
            })
          }
        }
      } catch (error) {
        stale++
        divergences.push({ check: `drift ${key}`, kind: "error", real: String(error), mock: null })
      }
      await sleep(gap)
    }
  }

  // ── scenario ─────────────────────────────────────────────────────
  const clientUserId = `mockingbird-verify-${Date.now().toString(36)}`
  const ctx: Record<Side, Context> = {
    real: { clientUserId, extraOrders: [] },
    mock: { clientUserId, extraOrders: [] },
  }
  const steps = scenario(options.corpus, options.orders === true)
  let ran = 0
  let divergent = 0
  progress(`scenario: ${steps.length} steps as client_user_id ${clientUserId}`)
  try {
    for (const step of steps) {
      if (step.skip?.(ctx)) continue
      ran++
      const replies = {} as Record<Side, Reply>
      for (const side of ["real", "mock"] as const) {
        const { method, path, body } = step.request(ctx[side])
        replies[side] = await call(side, method, path, body)
        step.capture?.(replies[side], ctx[side])
      }
      const { real, mock } = replies
      let divergence: Divergence | undefined
      if (real.status !== mock.status) {
        divergence = { check: step.name, kind: "status", real: real.status, mock: mock.status }
      } else if (step.compare === "exact") {
        const at = firstDifference(real.body, mock.body)
        if (at)
          divergence = { check: step.name, kind: "body", at, real: real.body, mock: mock.body }
      } else {
        const at = firstDifference(shapeOf(real.body), shapeOf(mock.body))
        if (at) {
          divergence = {
            check: step.name,
            kind: "shape",
            at,
            real: shapeOf(real.body),
            mock: shapeOf(mock.body),
          }
        }
      }
      if (divergence) {
        divergent++
        divergences.push(divergence)
      }
      progress(`  ${divergence ? "DIVERGED" : "ok"}  ${step.name}`)
      await sleep(gap)
    }
  } finally {
    // Never leave the verify user behind on the real team: it counts against the sandbox cap.
    for (const orderId of [ctx.real.orderId, ...ctx.real.extraOrders]) {
      if (orderId === undefined) continue
      await call("real", "POST", `/v3/order/${orderId}/cancel`).catch(() => undefined)
    }
    if (ctx.real.userId) {
      await call("real", "DELETE", `/v2/user/${ctx.real.userId}`).catch(() => undefined)
    }
  }

  return {
    ok: divergences.length === 0,
    drift: { checked, stale },
    scenario: { steps: ran, divergent },
    divergences,
  }
}
