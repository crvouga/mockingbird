import {
  type AdminRequest,
  type AdminRoutes,
  type FaultRule,
  jsonRes,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import {
  fixtureErrorMessage,
  IDENTITY_MODES,
  type IdentityMode,
  type JunctionFixtures,
  type OrderFixture,
  type UserFixture,
} from "./fixtures.js"
import type { JunctionAPI } from "./index.js"
import {
  LAB_ACCOUNT_PRESETS,
  type LabAccountLayout,
  labAccountFromPreset,
} from "./lab-account-presets.js"
import { type LabAccountInput, renderLabAccount } from "./lab-accounts.js"
import { sandboxUserQuotaBody } from "./limits.js"
import type { GeoMode, ResultFixture } from "./state.js"
import type { WebhookDispatcher } from "./webhooks.js"

/**
 * Every order status the contract defines, by collection method (from the vendored
 * OpenAPI enum). An admin transition may only target a status real Junction can emit.
 */
export const ORDER_STATUSES_BY_METHOD: Readonly<Record<string, readonly string[]>> = {
  at_home_phlebotomy: [
    "received.ordered",
    "received.requisition_created",
    "received.requisition_bypassed",
    "collecting_sample.appointment_pending",
    "collecting_sample.appointment_scheduled",
    "collecting_sample.appointment_cancelled",
    "collecting_sample.draw_completed",
    "sample_with_lab.partial_results",
    "completed.completed",
    "completed.corrected",
    "cancelled.cancelled",
    "failed.sample_error",
  ],
  on_site_collection: [
    "received.ordered",
    "received.requisition_created",
    "received.requisition_bypassed",
    "sample_with_lab.draw_completed",
    "sample_with_lab.partial_results",
    "completed.completed",
    "completed.corrected",
    "cancelled.cancelled",
    "failed.sample_error",
  ],
  testkit: [
    "received.ordered",
    "received.awaiting_registration",
    "received.registered",
    "received.requisition_created",
    "received.requisition_bypassed",
    "collecting_sample.transit_customer",
    "collecting_sample.out_for_delivery",
    "collecting_sample.with_customer",
    "collecting_sample.transit_lab",
    "collecting_sample.problem_in_transit_customer",
    "collecting_sample.problem_in_transit_lab",
    "sample_with_lab.delivered_to_lab",
    "sample_with_lab.lab_processing_blocked",
    "completed.completed",
    "completed.corrected",
    "cancelled.cancelled",
    "cancelled.do_not_process",
    "failed.sample_error",
    "failed.failure_to_deliver_to_customer",
    "failed.failure_to_deliver_to_lab",
    "failed.lost",
  ],
  walk_in_test: [
    "received.ordered",
    "received.requisition_created",
    "received.requisition_bypassed",
    "collecting_sample.appointment_pending",
    "collecting_sample.appointment_scheduled",
    "collecting_sample.appointment_cancelled",
    "collecting_sample.redraw_available",
    "sample_with_lab.partial_results",
    "completed.completed",
    "completed.corrected",
    "cancelled.cancelled",
    "failed.sample_error",
  ],
}

/**
 * Friendly transition targets, per method, mapped onto the contract's own statuses.
 * A name is absent for a method when no real status means it — walk-in tests have no
 * draw event, so `collected` is refused there rather than approximated.
 */
export const TRANSITION_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  at_home_phlebotomy: {
    requisition_created: "received.requisition_created",
    scheduled: "collecting_sample.appointment_scheduled",
    collected: "collecting_sample.draw_completed",
    partial_results: "sample_with_lab.partial_results",
    completed: "completed.completed",
    corrected: "completed.corrected",
    cancelled: "cancelled.cancelled",
    failed: "failed.sample_error",
  },
  on_site_collection: {
    requisition_created: "received.requisition_created",
    collected: "sample_with_lab.draw_completed",
    at_lab: "sample_with_lab.draw_completed",
    partial_results: "sample_with_lab.partial_results",
    completed: "completed.completed",
    corrected: "completed.corrected",
    cancelled: "cancelled.cancelled",
    failed: "failed.sample_error",
  },
  testkit: {
    requisition_created: "received.requisition_created",
    shipped: "collecting_sample.transit_customer",
    delivered: "collecting_sample.with_customer",
    collected: "collecting_sample.transit_lab",
    at_lab: "sample_with_lab.delivered_to_lab",
    completed: "completed.completed",
    corrected: "completed.corrected",
    cancelled: "cancelled.cancelled",
    failed: "failed.sample_error",
  },
  walk_in_test: {
    requisition_created: "received.requisition_created",
    scheduled: "collecting_sample.appointment_scheduled",
    partial_results: "sample_with_lab.partial_results",
    completed: "completed.completed",
    corrected: "completed.corrected",
    cancelled: "cancelled.cancelled",
    failed: "failed.sample_error",
  },
}

/**
 * Named results, as the flags `simulate_order` accepts. They steer the generator, so
 * the payload keeps Junction's exact shape; `PUT /__admin/results/{order}` installs an
 * exact payload instead.
 */
export const RESULT_FIXTURES: Readonly<Record<string, Record<string, unknown>>> = {
  normal: { interpretation: "normal" },
  abnormal: { interpretation: "abnormal" },
  critical: { interpretation: "critical" },
  missing_results: { interpretation: "normal", has_missing_results: true },
}

/**
 * Junction failure modes a suite can switch on by name. `sandbox_user_quota` reproduces
 * the shared-sandbox error byte for byte (message as observed from a real sandbox team);
 * the others are shape-plausible, not verified against Junction.
 */
export const FAULT_PRESETS: Readonly<Record<string, Omit<FaultRule, "id">>> = {
  sandbox_user_quota: {
    operationId: "create_user_v2_user_post",
    status: 400,
    body: sandboxUserQuotaBody(50),
  },
  rate_limited: {
    status: 429,
    body: { detail: "Too Many Requests" },
    headers: { "retry-after": "1" },
  },
  server_error: { status: 500, body: { detail: "Internal Server Error" } },
  bad_gateway: { status: 502, body: { detail: "Bad Gateway" } },
  unavailable: { status: 503, body: { detail: "Service Unavailable" } },
}

const methodOf = (order: { lab_test: { method?: unknown }; details?: { type?: unknown } }) =>
  typeof order.lab_test.method === "string" && order.lab_test.method !== ""
    ? order.lab_test.method
    : typeof order.details?.type === "string" && order.details.type !== ""
      ? order.details.type
      : "at_home_phlebotomy"

/** Resolve a target (`completed`, `completed.completed`, or a full status) for a method. */
export const resolveTransition = (
  method: string,
  target: string,
): { status: string } | { error: string } => {
  const allowed = ORDER_STATUSES_BY_METHOD[method]
  if (!allowed) return { error: `unknown collection method ${method}` }
  const alias = TRANSITION_ALIASES[method]?.[target]
  const short = alias ?? (target.split(".").length === 3 ? null : target)
  if (short !== null && allowed.includes(short)) {
    const [phase, event] = short.split(".")
    return { status: `${phase}.${method}.${event}` }
  }
  if (target.split(".").length === 3) {
    const [phase, targetMethod, event] = target.split(".")
    if (targetMethod === method && allowed.includes(`${phase}.${event}`)) return { status: target }
  }
  const names = Object.keys(TRANSITION_ALIASES[method] ?? {})
  return {
    error: `${JSON.stringify(target)} is not a ${method} status. Use one of: ${names.join(", ")}, or a full status such as ${allowed
      .slice(0, 2)
      .map((s) => `${s.split(".")[0]}.${method}.${s.split(".")[1]}`)
      .join(", ")}`,
  }
}

const adminError = (status: number, message: string) =>
  jsonRes(status, { error: { type: "mockingbird_admin", message } })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Run an admin mutation, turning a bad input into a 400 naming the field, a clash into a
 * 409, and a missing reference into a 404 — all in the admin error shape.
 */
const guarded = (run: () => Response): Response => {
  try {
    return run()
  } catch (error) {
    if (error instanceof TypeError) return adminError(400, error.message)
    if (error instanceof Error && error.name === "LabAccountConflict") {
      return adminError(409, error.message)
    }
    const { status, message } = fixtureErrorMessage(error)
    return adminError(status, message)
  }
}

export type JunctionAdminOptions = {
  webhooks: WebhookDispatcher | undefined
}

/** Junction's admin routes, served under `/__admin` next to the shared ones. */
export const junctionAdminRoutes =
  (options: JunctionAdminOptions) =>
  (runtime: ServiceRuntime<JunctionAPI>): AdminRoutes => {
    const api = (request: AdminRequest) => runtime.instance(request.namespace)
    return {
      "GET /orders": (request) =>
        jsonRes(200, {
          orders: api(request)
            .orders()
            .map((order) => ({
              id: order.id,
              user_id: order.user_id,
              method: methodOf(order),
              status: order.last_event.status,
              updated_at: order.updated_at,
            })),
        }),

      "POST /orders/:id/transition": (request) => {
        const body = isRecord(request.body) ? request.body : {}
        const order = api(request).order(request.params.id as string)
        if (!order) return adminError(404, `no order ${request.params.id} in ${request.namespace}`)
        if (typeof body.to !== "string") {
          return adminError(400, 'body needs "to": a status like "completed" or "at_lab"')
        }
        const method = methodOf(order)
        const resolved = resolveTransition(method, body.to)
        if ("error" in resolved) return adminError(400, resolved.error)
        let flags = isRecord(body.flags) ? body.flags : null
        if (typeof body.result === "string") {
          const named = RESULT_FIXTURES[body.result]
          if (!named) {
            return adminError(
              400,
              `no result fixture ${body.result}; one of ${Object.keys(RESULT_FIXTURES).join(", ")}`,
            )
          }
          flags = { ...named, ...flags }
        }
        const updated = api(request).transitionOrder(order.id, resolved.status, {
          now: runtime.clock.now,
          flags,
        })
        return jsonRes(200, {
          id: order.id,
          status: updated?.last_event.status,
          events: updated?.events,
        })
      },

      "GET /result-fixtures": () => jsonRes(200, { fixtures: RESULT_FIXTURES }),
      "GET /results/:id": (request) => {
        const fixture = api(request).resultFixture(request.params.id as string)
        return fixture ? jsonRes(200, fixture) : adminError(404, "no result fixture for that order")
      },
      "PUT /results/:id": (request) => {
        if (!isRecord(request.body)) return adminError(400, "expected a result fixture object")
        const fixture = { name: "custom", ...request.body } as ResultFixture
        if (fixture.results !== undefined && !Array.isArray(fixture.results)) {
          return adminError(400, "results must be an array of result lines")
        }
        return api(request).installResultFixture(request.params.id as string, fixture)
          ? jsonRes(200, fixture)
          : adminError(404, `no order ${request.params.id} in ${request.namespace}`)
      },

      "GET /lab-accounts": (request) => jsonRes(200, { data: api(request).labAccounts() }),
      "PUT /lab-accounts": (request) => {
        const body = isRecord(request.body) ? request.body : {}
        const accounts = body.accounts
        const presets = body.presets
        if (
          (accounts === undefined && presets === undefined) ||
          (accounts !== undefined && accounts !== null && !Array.isArray(accounts)) ||
          (presets !== undefined && !Array.isArray(presets))
        ) {
          return adminError(
            400,
            'body needs "accounts": an array (or null to restore the default), and/or "presets": an array of preset names',
          )
        }
        const layout: LabAccountLayout | undefined =
          presets !== undefined
            ? {
                presets: presets as string[],
                ...(Array.isArray(accounts) ? { accounts: accounts as LabAccountInput[] } : {}),
              }
            : accounts === null
              ? undefined
              : (accounts as LabAccountInput[])
        return guarded(() => jsonRes(200, { data: api(request).configureLabAccounts(layout) }))
      },
      "POST /lab-accounts": (request) => {
        if (!isRecord(request.body)) return adminError(400, "expected one lab account object")
        const input = request.body as LabAccountInput
        return guarded(() => jsonRes(201, api(request).addLabAccount(input)))
      },
      "PATCH /lab-accounts/:id": (request) => {
        if (!isRecord(request.body))
          return adminError(400, "expected an object of fields to change")
        const patch = request.body as Partial<LabAccountInput>
        return guarded(() => {
          const updated = api(request).patchLabAccount(request.params.id as string, patch)
          return updated
            ? jsonRes(200, updated)
            : adminError(404, `no lab account ${request.params.id} in ${request.namespace}`)
        })
      },
      "DELETE /lab-accounts/:id": (request) =>
        api(request).removeLabAccount(request.params.id as string)
          ? jsonRes(200, { status: "ok" })
          : adminError(404, `no lab account ${request.params.id} in ${request.namespace}`),
      "GET /lab-accounts/presets": (request) =>
        jsonRes(200, {
          presets: Object.fromEntries(
            Object.keys(LAB_ACCOUNT_PRESETS).map((name) => {
              const record = labAccountFromPreset(name, { teamId: api(request).teamId })
              return [name, record ? renderLabAccount(record) : null]
            }),
          ),
        }),
      "POST /lab-accounts/presets/:name": (request) => {
        const body = isRecord(request.body) ? request.body : {}
        if (body.id !== undefined && typeof body.id !== "string") {
          return adminError(400, "id must be a string")
        }
        const name = request.params.name as string
        return guarded(() => {
          const record = api(request).addLabAccountPreset(name, body.id as string | undefined)
          return record
            ? jsonRes(201, record)
            : adminError(
                404,
                `no lab-account preset ${name}; one of ${Object.keys(LAB_ACCOUNT_PRESETS).join(", ")}`,
              )
        })
      },

      "GET /team": (request) => jsonRes(200, { teamId: api(request).teamId }),

      "GET /limits": (request) => jsonRes(200, { limits: api(request).limits }),
      "PUT /limits": (request) => {
        if (!isRecord(request.body)) return adminError(400, "expected an object of limits")
        const input = request.body
        return guarded(() => jsonRes(200, { limits: api(request).configureLimits(input) }))
      },

      "GET /identity": (request) => jsonRes(200, { identity: api(request).identity }),
      "PUT /identity": (request) => {
        const mode = isRecord(request.body) ? request.body.mode : undefined
        if (!IDENTITY_MODES.includes(mode as IdentityMode)) {
          return adminError(400, `body needs "mode": one of ${IDENTITY_MODES.join(", ")}`)
        }
        api(request).identity = mode as IdentityMode
        return jsonRes(200, { identity: mode })
      },

      "POST /users": (request) => {
        if (!isRecord(request.body)) return adminError(400, "expected one user object")
        const input = request.body as UserFixture
        return guarded(() => jsonRes(201, api(request).insertUsers([input])[0]))
      },
      "POST /users/bulk": (request) => {
        const users = isRecord(request.body) ? request.body.users : undefined
        if (!Array.isArray(users)) return adminError(400, 'body needs "users": an array')
        return guarded(() =>
          jsonRes(201, { users: api(request).insertUsers(users as UserFixture[]) }),
        )
      },
      "DELETE /users/:id": (request) =>
        api(request).hardDeleteUser(request.params.id as string)
          ? jsonRes(200, { status: "ok" })
          : adminError(404, `no user ${request.params.id} in ${request.namespace}`),
      "POST /orders": (request) => {
        if (!isRecord(request.body)) return adminError(400, "expected one order object")
        const { emitWebhooks, ...input } = request.body
        return guarded(() =>
          jsonRes(
            201,
            api(request).insertOrders([input as OrderFixture], {
              emitWebhooks: emitWebhooks === true,
            })[0],
          ),
        )
      },
      "POST /import": (request) => {
        if (!isRecord(request.body)) {
          return adminError(400, 'expected { "users": [...], "orders": [...] }')
        }
        const { emitWebhooks, ...fixtures } = request.body
        return guarded(() => {
          const loaded = api(request).importFixtures(fixtures as JunctionFixtures, {
            emitWebhooks: emitWebhooks === true,
          })
          return jsonRes(201, loaded)
        })
      },

      "GET /corpus": (request) =>
        jsonRes(200, {
          corpus: api(request).corpusInfo() ?? null,
          geo: api(request).geoMode,
        }),
      "PUT /geo": (request) => {
        const mode = isRecord(request.body) ? request.body.mode : undefined
        if (mode !== "corpus" && mode !== "synthetic") {
          return adminError(400, 'body needs "mode": "corpus" or "synthetic"')
        }
        api(request).geoMode = mode as GeoMode
        return jsonRes(200, { geo: mode })
      },

      "GET /webhooks/events": (request) => jsonRes(200, { events: api(request).webhookEvents() }),
      "GET /webhooks": (request) =>
        options.webhooks
          ? jsonRes(200, { deliveries: options.webhooks.deliveries(request.namespace) })
          : adminError(
              409,
              "webhook delivery is off; serve with --webhook-url and --webhook-secret",
            ),
      "POST /webhooks/:id/replay": async (request) => {
        if (!options.webhooks) return adminError(409, "webhook delivery is off")
        const delivery = await options.webhooks.replay(request.params.id as string)
        return delivery
          ? jsonRes(200, delivery)
          : adminError(404, `no message ${request.params.id}`)
      },
      "POST /webhooks/flush": async () => {
        if (!options.webhooks) return adminError(409, "webhook delivery is off")
        await options.webhooks.flush()
        return jsonRes(200, { status: "ok" })
      },

      "GET /faults/presets": () => jsonRes(200, { presets: FAULT_PRESETS }),
      "POST /faults/presets/:name": (request) => {
        const preset = FAULT_PRESETS[request.params.name as string]
        if (!preset) {
          return adminError(
            404,
            `no preset ${request.params.name}; one of ${Object.keys(FAULT_PRESETS).join(", ")}`,
          )
        }
        const overrides = isRecord(request.body) ? request.body : {}
        const rule = runtime.faults.add({
          namespace: request.namespace,
          ...preset,
          ...overrides,
          id: typeof overrides.id === "string" ? overrides.id : (request.params.name as string),
        } as FaultRule)
        return jsonRes(201, rule)
      },
    }
  }
