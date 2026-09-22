import {
  type AdminRoutes,
  type Clock,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { KILL_BILL_NAMESPACE, KillBillAPI } from "./index.js"
import type { CatalogPlan } from "./state.js"
export const KILL_BILL_PRESETS: Record<string, FaultPreset> = {
  unavailable: { description: "The next request loses its connection", rules: [{ drop: true }] },
  plugin_failure: {
    description: "Payment plugin answers an error",
    rules: [
      {
        pathPrefix: "/1.0/kb/payments",
        status: 502,
        body: {
          className: "PaymentPluginApiException",
          code: "PLUGIN_FAILURE",
          message: "Payment plugin failed",
        },
      },
    ],
  },
  rate_limited: {
    description: "Kill Bill answers 429",
    rules: [
      {
        status: 429,
        body: {
          className: "KillBillException",
          code: "RATE_LIMITED",
          message: "Too many requests",
        },
      },
    ],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two webhooks are reordered",
    webhook: { mode: "reorder" },
  },
  webhook_drop: { description: "The next webhook is dropped", webhook: { mode: "drop" } },
}
export type KillBillRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  username?: string
  password?: string
  tenantKey?: string
  tenantSecret?: string
  plans?: readonly CatalogPlan[]
  webhooks?: {
    endpoints?: WebhookEndpoint[]
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}
export type KillBillRuntime = ServiceRuntime<KillBillAPI> & { readonly webhooks: WebhookHub }
const problem = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const admin = (runtime: ServiceRuntime<KillBillAPI>): AdminRoutes => ({
  "GET /state": ({ namespace }) => {
    const state = runtime.instance(namespace).state
    return Response.json({
      accounts: state.accounts.list().map(({ value }) => value),
      subscriptions: state.subscriptions.list().map(({ value }) => value),
      invoices: state.invoices.list().map(({ value }) => value),
      payments: state.payments.list().map(({ value }) => value),
      audits: state.audits.list().map(({ value }) => value),
      settings: state.settings.get("settings"),
    })
  },
  "POST /payments/decline-next": ({ namespace }) => {
    const state = runtime.instance(namespace).state
    state.settings.insert("settings", {
      ...(state.settings.get("settings") ?? { pendingNext: false }),
      declineNext: true,
    })
    return Response.json({ declineNext: true })
  },
  "POST /payments/pending-next": ({ namespace }) => {
    const state = runtime.instance(namespace).state
    state.settings.insert("settings", {
      ...(state.settings.get("settings") ?? { declineNext: false }),
      pendingNext: true,
    })
    return Response.json({ pendingNext: true })
  },
  "POST /payments/:id/retry": ({ namespace, params }) => {
    const api = runtime.instance(namespace)
    const payment = api.state.payments.get(params.id as string)
    if (!payment) return problem(404, "payment not found")
    const failed = [...payment.transactions]
      .reverse()
      .find((transaction) => transaction.status !== "SUCCESS")
    if (!failed) return problem(409, "payment has no failed or pending transaction")
    const { gatewayErrorCode: _code, gatewayErrorMsg: _message, ...base } = failed
    const transaction = {
      ...base,
      transactionId: api.state.ids.next("txn-", 32),
      effectiveDate: new Date(api.now()).toISOString(),
      status: "SUCCESS" as const,
    }
    const next = {
      ...payment,
      purchasedAmount:
        failed.transactionType === "PURCHASE"
          ? Math.round((payment.purchasedAmount + failed.amount) * 100) / 100
          : payment.purchasedAmount,
      transactions: [...payment.transactions, transaction],
      paymentAttempts: [
        ...payment.paymentAttempts,
        {
          paymentAttemptId: api.state.ids.next("attempt-", 24),
          transactionId: transaction.transactionId,
          stateName: "SUCCESS",
        },
      ],
    }
    api.state.payments.insert(payment.paymentId, next)
    if (payment.invoiceId) {
      const invoice = api.state.invoices.get(payment.invoiceId)
      if (invoice)
        api.state.invoices.insert(invoice.invoiceId, {
          ...invoice,
          balance: Math.max(0, Math.round((invoice.balance - failed.amount) * 100) / 100),
        })
    }
    return Response.json(next)
  },
  "POST /catalog/plans": ({ namespace, body }) => {
    const input = body as CatalogPlan | null
    if (!input || typeof input.name !== "string" || typeof input.amount !== "number")
      return problem(400, "name and amount are required")
    runtime.instance(namespace).state.plans.insert(input.name, input)
    return Response.json(input, { status: 201 })
  },
})
export const createRuntime = (options: KillBillRuntimeOptions = {}): KillBillRuntime => {
  const hub = createWebhookHub({
    signer: signers.header("x-killbill-webhook-secret"),
    endpoints: options.webhooks?.endpoints ?? [],
    ...(options.webhooks?.retryDelaysMs ? { retryDelaysMs: options.webhooks.retryDelaysMs } : {}),
    ...(options.webhooks?.fetch ? { fetch: options.webhooks.fetch } : {}),
  })
  const runtime = serviceRuntime({
    name: KILL_BILL_NAMESPACE,
    document,
    presets: KILL_BILL_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new KillBillAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.username ? { username: options.username } : {}),
        ...(options.password ? { password: options.password } : {}),
        ...(options.tenantKey ? { tenantKey: options.tenantKey } : {}),
        ...(options.tenantSecret ? { tenantSecret: options.tenantSecret } : {}),
        ...(options.plans ? { plans: options.plans } : {}),
        onEvent: (event) => hub.publish({ namespace, type: event.eventType, body: event }),
      }),
    admin,
  })
  return Object.assign(runtime, { webhooks: hub })
}
