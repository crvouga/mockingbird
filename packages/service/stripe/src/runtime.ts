import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createClock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type AccountConfig, AccountDirectory, validateAccounts } from "./accounts.js"
import { completeSession } from "./checkout.js"
import { STRIPE_NAMESPACE } from "./constants.js"
import type { Corpus } from "./corpus.js"
import { ACME_CORPUS } from "./corpus-data.js"
import { StripeError } from "./errors.js"
import { document } from "./generated/openapi.js"
import { StripeAPI, type StripeAPIOptions } from "./index.js"
import { openDispute, paymentMethodFromCard } from "./payments.js"
import { moveRefund } from "./refunds.js"
import { renderCharge, renderCheckoutSession, renderDispute, renderRefund } from "./render.js"
import { confirmSetup } from "./setup-intents.js"

/** `error` bodies of the canned responses, as Stripe words them. */
const RATE_LIMITED = {
  error: {
    code: "rate_limit",
    doc_url: "https://stripe.com/docs/error-codes/rate-limit",
    message:
      "Request rate limit exceeded. You can learn more about rate limits here https://stripe.com/docs/rate-limits.",
    type: "invalid_request_error",
  },
}
const API_ERROR = {
  error: {
    message: "An unknown error occurred",
    type: "api_error",
  },
}
const PERMISSION_ERROR = {
  error: {
    message:
      "The provided key 'rk_test_*********' does not have the required permissions for this endpoint on account 'acct_mockingbird'.",
    type: "invalid_request_error",
  },
}

const CHARGE_OPERATIONS = [
  "PostPaymentIntents",
  "PostPaymentIntentsIntentConfirm",
  "PostInvoicesInvoicePay",
  "PostSubscriptions",
  "PostCheckoutPage",
]
const SEARCH_OPERATIONS = ["GetCustomersSearch", "GetPaymentIntentsSearch", "GetProductsSearch"]

const declineRules = (declineCode: string) =>
  CHARGE_OPERATIONS.map((operationId) => ({
    operationId,
    effect: "card_declined",
    params: { decline_code: declineCode },
  }))

/**
 * Every named Stripe misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const STRIPE_PRESETS: Record<string, FaultPreset> = {
  card_declined: {
    description:
      "The next charge attempt (PaymentIntent create/confirm, invoice pay, subscription, hosted page) declines: 402 card_error card_declined / generic_decline with the payment_intent embedded",
    rules: declineRules("generic_decline"),
  },
  insufficient_funds: {
    description: "The next charge attempt declines with decline_code insufficient_funds",
    rules: declineRules("insufficient_funds"),
  },
  expired_card: {
    description: "The next charge attempt declines with code expired_card",
    rules: declineRules("expired_card"),
  },
  authentication_required: {
    description: "The next charge attempt declines with code authentication_required",
    rules: declineRules("authentication_required"),
  },
  rate_limited: {
    description: "Every API call answers 429 rate_limit (Stripe's test-mode rate limit)",
    rules: [{ pathPrefix: "/v1/", status: 429, body: RATE_LIMITED }],
  },
  api_error: {
    description: "Every API call answers 500 api_error",
    rules: [{ pathPrefix: "/v1/", status: 500, body: API_ERROR }],
  },
  permission_error: {
    description: "Every API call answers 403 (a restricted key missing a permission)",
    rules: [{ pathPrefix: "/v1/", status: 403, body: PERMISSION_ERROR }],
  },
  connection_drop: {
    description: "Every API call drops the connection (an ambiguous, unknown-outcome attempt)",
    rules: [{ pathPrefix: "/v1/", drop: true }],
  },
  idempotency_in_flight: {
    description:
      "API calls take 500 ms, so a concurrent retry with the same Idempotency-Key gets 409 idempotency_key_in_use",
    rules: [
      { pathPrefix: "/v1/", method: "POST", effect: "processing_delay", params: { ms: 500 } },
    ],
  },
  search_lag: {
    description:
      "Search (customers, payment intents, products) lags the index: objects created in the last 60 s are missing",
    rules: SEARCH_OPERATIONS.map((operationId) => ({
      operationId,
      effect: "search_lag",
      params: { lagSeconds: 60 },
    })),
  },
  webhook_duplicate: {
    description: "The next webhook event is delivered twice (same event id)",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two webhook events arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next webhook event is never delivered (it is still in GET /v1/events)",
    webhook: { mode: "drop" },
  },
}

export type StripeRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  /** Seeds every random choice the runtime makes (fault rates). */
  seed?: number | string
  /** Require `x-mockingbird-admin-key` on `/__admin/*`. */
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Called in-process with every event the mock records. */
  onWebhook?: StripeAPIOptions["onWebhook"]
  /** Accounts and the keys that act as them (also `PUT /__admin/accounts`). */
  accounts?: readonly AccountConfig[]
  /** Webhook endpoints every namespace delivers to (`--webhook-url`); tag with `tags.account`. */
  webhooks?: {
    endpoints?: WebhookEndpoint[]
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
  /** Recorded catalog for accounts configured with `corpus: true` (default: the bundled one). */
  corpus?: Corpus
  /** Public base URL of hosted pages when the mock sits behind a proxy. */
  publicUrl?: string
  /** Webhook version for accounts without an `apiVersion`. */
  webhookApiVersion?: string
  lifecycle?: StripeAPIOptions["lifecycle"]
  /**
   * Run the clock-driven lifecycle (renewals, expiries) on this real-time interval (ms), so
   * webhooks fire without a request arriving. The served mock uses 1000 ms; in-process runtimes
   * default to off (every request and every clock change still runs it).
   */
  tickMs?: number
}

export type StripeRuntime = ServiceRuntime<StripeAPI> & {
  readonly webhooks: WebhookHub
  readonly accounts: AccountDirectory
  /** Run every namespace's lifecycle now. */
  tick(): void
  /** Stop the background ticker, if one runs. */
  stop(): void
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Find the account (in a namespace) that holds an object. */
const locate = (
  api: StripeAPI,
  has: (scope: ReturnType<StripeAPI["scopeFor"]>) => boolean,
  base?: string,
) => {
  for (const account of api.accountIds()) {
    const scope = api.scopeFor(account, base)
    if (has(scope)) return scope
  }
  return undefined
}

const guard = (run: () => Response): Response => {
  try {
    return run()
  } catch (error) {
    if (error instanceof StripeError) return adminError(400, error.init.message)
    throw error
  }
}

/**
 * The Stripe mock with Mockingbird's full service contract: `/health`, `/__admin/*`, namespaces
 * by header, by `/ns/<name>` path prefix, or by API key (`PUT /__admin/credentials`), accounts
 * by key (`PUT /__admin/accounts`), clock control that drives renewals and expiries, fault
 * presets, and signed webhooks (`Stripe-Signature`) fanned out to every matching endpoint.
 */
export const createRuntime = (options: StripeRuntimeOptions = {}): StripeRuntime => {
  const accounts = new AccountDirectory(options.accounts ?? [])
  const hub = createWebhookHub({
    signer: signers.timestamped("Stripe-Signature"),
    ...(options.webhooks?.retryDelaysMs ? { retryDelaysMs: options.webhooks.retryDelaysMs } : {}),
    ...(options.webhooks?.fetch ? { fetch: options.webhooks.fetch } : {}),
    endpoints: options.webhooks?.endpoints ?? [],
  })
  let runtimeRef: ServiceRuntime<StripeAPI> | undefined

  /** Endpoints of a namespace: admin-configured, account-configured, and API-created. */
  const derivedEndpoints = (namespace: string): WebhookEndpoint[] => {
    const fromAccounts = accounts.list().flatMap((account) =>
      Object.entries(account.webhookSecrets ?? {}).map(([url, secret], index) => ({
        id: `we_${account.id}_${index}`,
        url,
        secret,
        events: ["*"],
        tags: { account: account.id },
      })),
    )
    const api = runtimeRef?.namespaces().includes(namespace)
      ? runtimeRef.instance(namespace)
      : undefined
    const fromApi = (api?.apiWebhookEndpoints() ?? []).map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      secret: endpoint.secret,
      events: endpoint.events,
      tags: { account: endpoint.account },
    }))
    const fromAdmin =
      api?.adminWebhookEndpoints.list({ order: "oldest" }).map((row) => row.value) ?? []
    return [...fromAdmin, ...fromAccounts, ...fromApi]
  }
  const syncEndpoints = (namespace: string) => {
    hub.setEndpoints(namespace, derivedEndpoints(namespace))
  }
  const syncAll = () => {
    const names = new Set([...(runtimeRef?.namespaces() ?? []), "default"])
    for (const name of names) syncEndpoints(name)
  }
  accounts.onChange(syncAll)

  /** The hub as the runtime sees it: admin endpoint changes merge with the derived ones. */
  const stripeHub: WebhookHub = {
    ...hub,
    setEndpoints: (namespace, endpoints) => {
      const api = runtimeRef?.instance(namespace)
      if (!api) return []
      for (const row of api.adminWebhookEndpoints.list()) api.adminWebhookEndpoints.delete(row.id)
      for (const [index, endpoint] of endpoints.entries()) {
        api.adminWebhookEndpoints.insert(
          endpoint.id ?? `we_${namespace}_${index}`,
          endpoint.tags?.account === undefined
            ? endpoint
            : {
                ...endpoint,
                tags: { ...endpoint.tags, account: accounts.resolve(endpoint.tags.account) },
              },
        )
      }
      syncEndpoints(namespace)
      return hub
        .endpoints(namespace)
        .filter((endpoint) => api.adminWebhookEndpoints.has(endpoint.id ?? ""))
    },
    clear: (namespace) => {
      for (const name of namespace === undefined ? (runtimeRef?.namespaces() ?? []) : [namespace]) {
        const api = runtimeRef?.instance(name)
        if (!api) continue
        for (const row of api.adminWebhookEndpoints.list()) api.adminWebhookEndpoints.delete(row.id)
      }
      hub.clear(namespace)
      if (namespace === undefined) syncAll()
      else syncEndpoints(namespace)
    },
  }

  const baseClock = options.clock ?? createClock()
  const tickAll = () => {
    if (!runtimeRef) return
    for (const name of runtimeRef.namespaces()) runtimeRef.instance(name).tick(true)
  }
  /** Moving the mock clock runs renewals and expiries at once, so their webhooks fire. */
  const clock: Clock = {
    ...baseClock,
    set: (epochMs) => {
      baseClock.set(epochMs)
      tickAll()
    },
    advance: (deltaMs) => {
      baseClock.advance(deltaMs)
      tickAll()
    },
    reset: () => {
      baseClock.reset()
      tickAll()
    },
  }

  const corpus = options.corpus ?? ACME_CORPUS

  const admin = (runtime: ServiceRuntime<StripeAPI>): AdminRoutes => ({
    "GET /accounts": () =>
      json(200, {
        accounts: accounts.list().map((account) => ({
          ...account,
          keys: account.keys.map((key) => `${key.slice(0, 8)}…${key.slice(-2)}`),
          webhookSecrets: Object.fromEntries(
            Object.keys(account.webhookSecrets ?? {}).map((url) => [url, "(set)"]),
          ),
        })),
      }),
    "PUT /accounts": ({ body }) => {
      const parsed = validateAccounts(body)
      if (typeof parsed === "string") return adminError(400, parsed)
      accounts.configure(parsed)
      return json(200, { accounts: parsed.map((account) => account.id) })
    },
    "PUT /webhook-endpoints": ({ body, namespace }) => {
      const list = Array.isArray(body) ? body : isRecord(body) ? body.endpoints : undefined
      if (!Array.isArray(list))
        return adminError(400, "expected [{account?, url, secret, enabledEvents?}]")
      const parsed: WebhookEndpoint[] = []
      for (const [index, each] of list.entries()) {
        if (!isRecord(each) || typeof each.url !== "string")
          return adminError(400, "each endpoint needs a url")
        try {
          new URL(each.url)
        } catch {
          return adminError(400, `not a URL: ${each.url}`)
        }
        const events = each.enabledEvents ?? each.enabled_events ?? each.events
        const account =
          typeof each.account === "string" ? accounts.resolve(each.account) : undefined
        parsed.push({
          id: typeof each.id === "string" ? each.id : `we_admin_${namespace}_${index}`,
          url: each.url,
          ...(typeof each.secret === "string" ? { secret: each.secret } : {}),
          ...(Array.isArray(events) ? { events: events.map(String) } : {}),
          ...(account === undefined ? {} : { tags: { account } }),
        })
      }
      stripeHub.setEndpoints(namespace, parsed)
      return json(200, {
        endpoints: parsed.map((endpoint) => ({
          ...endpoint,
          secret: endpoint.secret ? "(set)" : null,
        })),
      })
    },
    "PUT /refunds/:id": ({ params, body, namespace }) => {
      if (!isRecord(body) || typeof body.status !== "string")
        return adminError(400, 'expected {"status": "failed", "failure_reason"?: "…"}')
      const api = runtime.instance(namespace)
      const id = params.id as string
      const scope = locate(api, (candidate) => candidate.account.refunds.has(id))
      if (!scope) return adminError(404, `no refund ${id}`)
      return guard(() => {
        const refund = scope.account.refunds.get(id)
        if (!refund) return adminError(404, `no refund ${id}`)
        const moved = moveRefund(
          scope,
          refund,
          body.status as string,
          typeof body.failure_reason === "string" ? body.failure_reason : null,
        )
        return json(200, renderRefund(moved))
      })
    },
    "POST /disputes": ({ body, namespace }) => {
      if (
        !isRecord(body) ||
        (typeof body.payment_intent !== "string" && typeof body.charge !== "string")
      )
        return adminError(400, 'expected {"payment_intent": "pi_…"} or {"charge": "ch_…"}')
      const api = runtime.instance(namespace)
      const intentId = typeof body.payment_intent === "string" ? body.payment_intent : undefined
      const scope = locate(api, (candidate) =>
        intentId !== undefined
          ? candidate.account.paymentIntents.has(intentId)
          : candidate.account.charges.has(body.charge as string),
      )
      if (!scope) return adminError(404, `no ${intentId ?? body.charge}`)
      const chargeId =
        intentId !== undefined
          ? scope.account.paymentIntents.get(intentId)?.latest_charge
          : (body.charge as string)
      const charge = chargeId ? scope.account.charges.get(chargeId) : undefined
      if (charge?.status !== "succeeded")
        return adminError(400, "the payment has no successful charge to dispute")
      const dispute = openDispute(
        scope,
        charge,
        typeof body.reason === "string" ? body.reason : "general",
        typeof body.amount === "number" ? body.amount : charge.amount,
        typeof body.status === "string" ? body.status : "needs_response",
      )
      return json(201, renderDispute(dispute))
    },
    "POST /checkout/sessions/:id/complete": ({ params, body, namespace, url }) => {
      const api = runtime.instance(namespace)
      const id = params.id as string
      const scope = locate(
        api,
        (candidate) => candidate.account.checkoutSessions.has(id),
        url.origin,
      )
      if (!scope) return adminError(404, `no checkout session ${id}`)
      return guard(() => {
        const session = scope.account.checkoutSessions.get(id)
        if (!session) return adminError(404, `no checkout session ${id}`)
        const card =
          isRecord(body) && typeof body.card === "string" ? body.card : "4242424242424242"
        const result = completeSession(scope, session, card)
        if (!result.ok)
          return json(402, {
            error: { type: "card_error", code: result.code, message: result.message },
          })
        return json(200, renderCheckoutSession(result.session))
      })
    },
    "POST /checkout/sessions/:id/expire": ({ params, namespace }) => {
      const api = runtime.instance(namespace)
      const id = params.id as string
      const scope = locate(api, (candidate) => candidate.account.checkoutSessions.has(id))
      const session = scope?.account.checkoutSessions.get(id)
      if (!scope || !session) return adminError(404, `no checkout session ${id}`)
      if (session.status !== "open") return adminError(400, `session is ${session.status}`)
      const expired = { ...session, status: "expired" as const }
      scope.account.checkoutSessions.update(id, expired)
      scope.emit("checkout.session.expired", renderCheckoutSession(expired))
      return json(200, renderCheckoutSession(expired))
    },
    "POST /checkout/sessions/:id/async_payment_succeeded": ({ params, namespace }) => {
      const api = runtime.instance(namespace)
      const id = params.id as string
      const scope = locate(api, (candidate) => candidate.account.checkoutSessions.has(id))
      const session = scope?.account.checkoutSessions.get(id)
      if (!scope || !session) return adminError(404, `no checkout session ${id}`)
      const paid = { ...session, status: "complete" as const, payment_status: "paid" as const }
      scope.account.checkoutSessions.update(id, paid)
      scope.emit("checkout.session.async_payment_succeeded", renderCheckoutSession(paid))
      return json(200, renderCheckoutSession(paid))
    },
    "POST /setup_intents/:id/succeed": ({ params, body, namespace }) => {
      const api = runtime.instance(namespace)
      const id = params.id as string
      const scope = locate(api, (candidate) => candidate.account.setupIntents.has(id))
      const intent = scope?.account.setupIntents.get(id)
      if (!scope || !intent) return adminError(404, `no setup intent ${id}`)
      return guard(() => {
        const card =
          isRecord(body) && typeof body.card === "string" ? body.card : "4242424242424242"
        const method = paymentMethodFromCard(scope, card)
        return json(200, confirmSetup(scope, intent, method, true))
      })
    },
    "GET /charges/:id": ({ params, namespace }) => {
      const api = runtime.instance(namespace)
      const id = params.id as string
      const scope = locate(api, (candidate) => candidate.account.charges.has(id))
      const charge = scope?.account.charges.get(id)
      return charge ? json(200, renderCharge(charge)) : adminError(404, `no charge ${id}`)
    },
    "POST /tick": ({ namespace }) => {
      runtime.instance(namespace).tick(true)
      return json(200, { status: "ok" })
    },
  })

  const runtime = createServiceRuntime<StripeAPI>({
    name: STRIPE_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    clock,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: STRIPE_PRESETS,
    webhooks: stripeHub,
    describe: () => ({
      corpus: corpus.version,
      accounts: accounts.list().map((account) => account.id),
      webhooks: hub.endpoints("default").length > 0 ? "on" : "off",
    }),
    create: ({ sqlite, namespace, publicNamespace, clock: instanceClock }) =>
      new StripeAPI({
        sqlite,
        namespace,
        now: instanceClock.now,
        accounts,
        corpus,
        publicNamespace,
        ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
        ...(options.webhookApiVersion ? { webhookApiVersion: options.webhookApiVersion } : {}),
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
        pendingWebhooks: (account, type) =>
          hub
            .endpoints(publicNamespace)
            .filter(
              (endpoint) =>
                (endpoint.tags?.account === undefined || endpoint.tags.account === account) &&
                (endpoint.events === undefined ||
                  endpoint.events.includes("*") ||
                  endpoint.events.includes(type)),
            ).length,
        onEndpointsChanged: () => syncEndpoints(publicNamespace),
        onWebhook: (event) => {
          options.onWebhook?.(event)
          hub.publish({
            namespace: publicNamespace,
            type: event.type,
            body: event.body,
            id: event.id,
            tags: { account: event.account },
          })
        },
      }),
    admin,
  })
  runtimeRef = runtime
  syncAll()
  let timer: ReturnType<typeof setInterval> | undefined
  if (options.tickMs !== undefined && options.tickMs > 0) {
    timer = setInterval(tickAll, options.tickMs)
    ;(timer as { unref?: () => void }).unref?.()
  }
  return Object.assign(runtime, {
    webhooks: stripeHub,
    accounts,
    tick: tickAll,
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
    },
  })
}
