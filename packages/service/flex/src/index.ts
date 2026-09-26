import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  IdempotencyStore,
  jsonRes,
  type OperationContext,
  requestFingerprint,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  cardPage,
  classifyCard,
  closedPage,
  html,
  nextActionPage,
  notFoundPage,
  substituteSessionId,
} from "./hosted.js"
import {
  type CustomerRecord,
  FlexState,
  type LineItemRecord,
  NEXT_ACTION_TYPES,
  type NextAction,
  type NextActionType,
  type PaymentIntentRecord,
  type PaymentMethodRecord,
  type ProductRecord,
  type Recurring,
  type SessionMode,
  type SessionRecord,
  type Settings,
  type SubscriptionData,
  type SubscriptionRecord,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { CorpusRow } from "./corpus/products.js"
export { CORPUS_ROWS } from "./corpus/products.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { CardOutcome } from "./hosted.js"
export { CARDS, classifyCard, substituteSessionId } from "./hosted.js"
export type {
  CustomerRecord,
  Eligibility,
  LineItemRecord,
  NextAction,
  NextActionType,
  PaymentIntentRecord,
  PaymentIntentStatus,
  PaymentMethodRecord,
  ProductRecord,
  Recurring,
  RefundRecord,
  SessionMode,
  SessionRecord,
  SessionStatus,
  Settings,
  SetupIntentRecord,
  SubscriptionData,
  SubscriptionRecord,
  SubscriptionStatus,
} from "./state.js"
export {
  corpusProduct,
  DEFAULT_SETTINGS,
  ELIGIBILITIES,
  NEXT_ACTION_TYPES,
  PAYMENT_INTENT_STATUSES,
  SUBSCRIPTION_STATUSES,
} from "./state.js"

export const FLEX_NAMESPACE = "flex"

/** Every webhook event type the mock sends (our receiver reconciles on each). */
export const FLEX_EVENT_TYPES = [
  "product.updated",
  "checkout.session.completed",
  "checkout_session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.refunded",
  "checkout.session.expired",
  "checkout_session.expired",
  "payment_intent.succeeded",
  "customer.subscription.created",
  "refund.created",
  "refund.updated",
  "charge.refunded",
  "charge.refund.updated",
] as const
export type FlexEventType = (typeof FLEX_EVENT_TYPES)[number]

/** The event inside the `{event: {...}}` webhook envelope. */
export type FlexEvent = {
  event_id: string
  event_type: string
  object: Record<string, unknown>
  /** Unix seconds (mock clock). */
  event_dt: number
  test_mode: boolean
  created_at: string
}

export type FlexAPIOptions = APIOptions & {
  /** Products every namespace starts with. Default: the recorded corpus. */
  products?: readonly ProductRecord[]
  /** Initial per-namespace settings. */
  settings?: Partial<Settings>
  /** The public namespace name, so hosted-page URLs carry `/ns/<name>` (the browser has no headers). */
  publicNamespace?: string
  /** Called for every webhook event; the runtime signs and delivers it. */
  onEvent?: (event: FlexEvent) => void
}

/** `fsk_test_…` is a test-mode secret key, `fsk_…` a live one; anything else is not a Flex key. */
export const keyMode = (key: string | undefined): "test" | "live" | undefined => {
  if (!key) return undefined
  if (/^fsk_test_[A-Za-z0-9_-]+$/.test(key)) return "test"
  if (/^fsk_(?!test_)[A-Za-z0-9_-]+$/.test(key)) return "live"
  return undefined
}

const HOSTED = new Set(["HostedCheckoutPage", "SubmitHostedCheckout", "CancelHostedCheckout"])

const error = (status: number, type: string, message: string, extra: Record<string, string> = {}) =>
  jsonRes(status, { error: { type, message, ...extra } })

const invalid = (message: string, param?: string) =>
  error(400, "invalid_request_error", message, param ? { param } : {})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const envelope = (context: OperationContext, name: string): Record<string, unknown> => {
  const body = context.body.kind === "json" ? context.body.value : undefined
  const inner = isRecord(body) ? body[name] : undefined
  return isRecord(inner) ? inner : {}
}

const flag = (value: unknown) => value === "true"

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })

type SessionView = { expandCustomer: boolean; expandPaymentIntent: boolean }

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

/**
 * The end of a billing period that starts at `startMs`: `interval_count` intervals later.
 * Month and year steps keep the day of month, clamped to the target month's length
 * (Jan 31 + 1 month = Feb 28/29), the way card-network billing anchors do.
 */
export const periodEnd = (startMs: number, recurring: Recurring): number => {
  const count = recurring.interval_count ?? 1
  const start = new Date(startMs)
  if (recurring.interval === "day") return startMs + count * 86_400_000
  if (recurring.interval === "week") return startMs + count * 7 * 86_400_000
  const months = recurring.interval === "month" ? count : count * 12
  const total = start.getUTCMonth() + months
  const year = start.getUTCFullYear() + Math.floor(total / 12)
  const month = total % 12
  const day = Math.min(start.getUTCDate(), daysInMonth(year, month))
  return Date.UTC(
    year,
    month,
    day,
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  )
}

/**
 * Stateful mock of the Flex HSA/FSA payments API.
 *
 * Payment sessions open unpaid and settle only through the hosted page (`/pay/:id`), admin
 * transitions, or synchronously for off-session charges; every settlement emits the webhook
 * events Flex would. Products come from the recorded catalog corpus.
 */
export class FlexAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: FlexState
  private readonly service: Service
  private readonly idempotency: IdempotencyStore
  private readonly now: () => number
  private readonly publicNamespace: string
  private readonly onEvent: ((event: FlexEvent) => void) | undefined

  constructor(options: FlexAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? FLEX_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.publicNamespace = options.publicNamespace ?? "default"
    this.onEvent = options.onEvent
    this.state = new FlexState(sqlite, namespace, {
      ...(options.products ? { products: options.products } : {}),
      settings: options.settings ?? {},
    })
    this.idempotency = new IdempotencyStore(sqlite, namespace)
    const handlers = defineOperations<SupportedOperationId>({
      ListProducts: (context) => this.listProducts(context),
      CreateProduct: (context) => this.createProduct(context),
      GetProduct: (context) => this.getProduct(context),
      UpdateProduct: (context) => this.updateProduct(context),
      ListCheckoutSessions: (context) => this.listSessions(context),
      CreateCheckoutSession: (context) =>
        this.idempotent(context, () => this.createSession(context)),
      GetCheckoutSession: (context) => this.getSession(context),
      RefundCheckoutSession: (context) => this.idempotent(context, () => this.refund(context)),
      CreateCustomer: (context) => this.idempotent(context, () => this.createCustomer(context)),
      GetSetupIntent: (context) => this.getSetupIntent(context),
      GetSubscription: (context) => this.getSubscription(context),
      HostedCheckoutPage: (context) => this.hostedPage(context),
      SubmitHostedCheckout: (context) => this.submitHosted(context),
      CancelHostedCheckout: (context) => this.cancelHosted(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => error(404, "invalid_request_error", "Unrecognized request URL."),
      onError: (thrown) => {
        if (thrown instanceof HttpError) return thrown.toResponse()
        throw thrown
      },
      before: (context) => {
        this.tick()
        if (HOSTED.has(context.operation.operationId)) return undefined
        const key = bearerToken(context.request)
        if (!key) {
          return error(401, "authentication_error", "No API key provided.")
        }
        if (!keyMode(key)) {
          return error(401, "authentication_error", "Invalid API key provided.")
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private testMode(context: OperationContext): boolean {
    return keyMode(bearerToken(context.request)) !== "live"
  }

  private async idempotent(
    context: OperationContext,
    handler: () => Promise<Response> | Response,
  ): Promise<Response> {
    const key = context.request.headers.get("idempotency-key")
    if (!key) return handler()
    const body = context.body.kind === "json" ? context.body.value : null
    return this.idempotency.run(
      key,
      requestFingerprint(context.request.method, context.url.pathname, body),
      {
        mismatch: () =>
          error(
            400,
            "idempotency_error",
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          ),
        conflict: () =>
          error(
            409,
            "idempotency_error",
            "There is currently another in-progress request using this Idempotency-Key.",
          ),
      },
      handler,
    )
  }

  private validate(context: OperationContext): Response | undefined {
    const issues = bodyIssues(context)
    const first = issues[0]
    if (!first) return undefined
    const missing = /^missing required property (.+)$/.exec(first.message)
    const param = missing ? [first.path, missing[1]].filter(Boolean).join(".") : first.path
    return invalid(
      missing
        ? `Missing required param: ${param}.`
        : `Invalid ${param || "body"}: ${first.message}`,
      param || undefined,
    )
  }

  // --- products ---------------------------------------------------------------------------

  private listProducts(context: OperationContext): Response {
    const limit = Number(context.query.limit ?? 10)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return invalid("limit must be an integer between 1 and 100.", "limit")
    }
    const all = this.state.products.list()
    const after =
      typeof context.query.starting_after === "string" ? context.query.starting_after : undefined
    let start = 0
    if (after !== undefined) {
      const index = all.findIndex((p) => p.product_id === after)
      if (index < 0) return invalid(`No such product: '${after}'`, "starting_after")
      start = index + 1
    }
    const page = all.slice(start, start + limit)
    return jsonRes(200, { products: page, has_more: start + limit < all.length })
  }

  private createProduct(context: OperationContext): Response {
    const problem = this.validate(context)
    if (problem) return problem
    const input = envelope(context, "product")
    const product: ProductRecord = {
      product_id: this.state.nextId("fprod_"),
      name: String(input.name),
      description: typeof input.description === "string" ? input.description : null,
      url: typeof input.url === "string" ? input.url : null,
      client_reference_id:
        typeof input.client_reference_id === "string" ? input.client_reference_id : null,
      hsa_fsa_eligibility: null,
      visit_type: null,
      active: true,
      test_mode: this.testMode(context),
      metadata: isRecord(input.metadata) ? (input.metadata as Record<string, string>) : null,
      created_at: this.iso(),
    }
    this.state.products.put(product)
    return annotateResponse(jsonRes(200, { product }), { ids: { productId: product.product_id } })
  }

  private getProduct(context: OperationContext): Response {
    const product = this.state.products.get(context.params.productId ?? "")
    if (!product)
      return error(404, "invalid_request_error", `No such product: '${context.params.productId}'`)
    return annotateResponse(jsonRes(200, { product }), { ids: { productId: product.product_id } })
  }

  private updateProduct(context: OperationContext): Response {
    const product = this.state.products.get(context.params.productId ?? "")
    if (!product)
      return error(404, "invalid_request_error", `No such product: '${context.params.productId}'`)
    const problem = this.validate(context)
    if (problem) return problem
    const input = envelope(context, "product")
    const next: ProductRecord = {
      ...product,
      ...(typeof input.active === "boolean" ? { active: input.active } : {}),
      ...(typeof input.name === "string" ? { name: input.name } : {}),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(typeof input.url === "string" ? { url: input.url } : {}),
      ...(isRecord(input.metadata) ? { metadata: input.metadata as Record<string, string> } : {}),
    }
    this.putProduct(next)
    return annotateResponse(jsonRes(200, { product: next }), {
      ids: { productId: next.product_id },
    })
  }

  /** Store a product change and emit `product.updated`. */
  putProduct(product: ProductRecord): ProductRecord {
    this.state.products.put(product)
    this.emit("product.updated", { ...product }, product.test_mode)
    return product
  }

  // --- sessions ---------------------------------------------------------------------------

  private pageBase(context: OperationContext): string {
    const configured = this.state.current().publicUrl
    if (configured) return configured.replace(/\/$/, "")
    const prefix =
      this.publicNamespace === "default" ? "" : `/ns/${encodeURIComponent(this.publicNamespace)}`
    return `${context.url.origin}${prefix}`
  }

  private async createSession(context: OperationContext): Promise<Response> {
    const problem = this.validate(context)
    if (problem) return problem
    const input = envelope(context, "checkout_session")
    const mode = (input.mode ?? "payment") as SessionMode
    const lines = (input.line_items ?? []) as {
      price_data: { product: string; unit_amount: number; recurring?: Recurring }
      quantity: number
    }[]
    const customerId = typeof input.customer === "string" ? input.customer : null
    const paymentMethodId = typeof input.payment_method === "string" ? input.payment_method : null
    if (mode === "setup" && (!customerId || lines.length > 0)) {
      return invalid("Setup mode requires a customer and no line items.", "mode")
    }
    if (mode !== "setup" && lines.length === 0) {
      return invalid("At least one line item is required.", "line_items")
    }
    if (mode === "subscription" && !lines.some((line) => line.price_data.recurring)) {
      return invalid(
        "Subscription mode requires at least one line item with a recurring price.",
        "line_items",
      )
    }
    if (mode === "off_session" && (!customerId || !paymentMethodId)) {
      return invalid("Off-session mode requires a customer and a payment method.", "mode")
    }
    if (customerId && !this.state.customers.has(customerId)) {
      return invalid(`No such customer: '${customerId}'`, "customer")
    }
    let method: PaymentMethodRecord | undefined
    if (paymentMethodId) {
      method = this.state.paymentMethods.get(paymentMethodId)
      if (!method || (customerId && method.customer !== customerId)) {
        return invalid(`No such payment_method: '${paymentMethodId}'`, "payment_method")
      }
    }
    const products: ProductRecord[] = []
    for (const [index, line] of lines.entries()) {
      const product = this.state.products.get(line.price_data.product)
      if (!product) {
        return invalid(
          `No such product: '${line.price_data.product}'`,
          `line_items.${index}.price_data.product`,
        )
      }
      if (!product.active) {
        return invalid(
          `Product '${product.product_id}' is inactive.`,
          `line_items.${index}.price_data.product`,
        )
      }
      products.push(product)
    }
    const items: LineItemRecord[] = lines.map((line) => ({
      price_data: {
        product: line.price_data.product,
        unit_amount: line.price_data.unit_amount,
        recurring: line.price_data.recurring
          ? {
              interval: line.price_data.recurring.interval,
              interval_count: line.price_data.recurring.interval_count ?? 1,
            }
          : null,
      },
      quantity: line.quantity,
      amount_total: line.price_data.unit_amount * line.quantity,
    }))
    const make = () => this.newSession(context, input, mode, items, products, customerId)
    const session = make()
    const ids = { sessionId: session.checkout_session_id }
    if (faultEffect(context.request, "duplicate_sessions_for_client_reference") !== undefined) {
      const twin = make()
      return annotateResponse(error(500, "api_error", "An unexpected error occurred."), {
        ids: { ...ids, duplicateSessionId: twin.checkout_session_id },
      })
    }
    if (mode === "off_session" && method) this.chargeOffSession(session, method)
    if (faultEffect(context.request, "created_but_500") !== undefined) {
      return annotateResponse(error(500, "api_error", "An unexpected error occurred."), { ids })
    }
    const timeout = faultEffect(context.request, "timeout")
    if (timeout !== undefined) {
      const delayMs = typeof timeout.delayMs === "number" ? timeout.delayMs : 16_000
      await sleep(delayMs, context.request.signal)
    }
    // An off-session charge already ran: the create response carries the expanded payment
    // intent (and customer), so the outcome is readable without a second request.
    const charged = mode === "off_session"
    return this.sessionResponse(
      context,
      session.checkout_session_id,
      charged ? { expandCustomer: true, expandPaymentIntent: true } : undefined,
    )
  }

  private newSession(
    context: OperationContext,
    input: Record<string, unknown>,
    mode: SessionMode,
    items: LineItemRecord[],
    products: ProductRecord[],
    customerId: string | null,
  ): SessionRecord {
    const id = this.state.nextId("fcs_")
    const ttl = this.state.current().sessionTtlSeconds
    const testMode = this.testMode(context)
    let setupIntent: string | null = null
    if (mode === "setup") {
      setupIntent = this.state.nextId("fseti_")
      this.state.setupIntents.insert(setupIntent, {
        setup_intent_id: setupIntent,
        status: "requires_payment_method",
        customer: customerId,
        payment_method: null,
        created_at: this.iso(),
      })
    }
    const session: SessionRecord = {
      checkout_session_id: id,
      client_reference_id:
        typeof input.client_reference_id === "string" ? input.client_reference_id : null,
      amount_total: items.reduce((sum, item) => sum + item.amount_total, 0),
      amount_received: null,
      amount_refunded: 0,
      customer: customerId,
      payment_intent: null,
      setup_intent: setupIntent,
      subscription: null,
      subscription_data:
        mode === "subscription"
          ? isRecord(input.subscription_data)
            ? (input.subscription_data as SubscriptionData)
            : {}
          : null,
      mode,
      status: "open",
      url: `${this.pageBase(context)}/pay/${encodeURIComponent(id)}`,
      success_url: String(input.success_url),
      cancel_url: typeof input.cancel_url === "string" ? input.cancel_url : null,
      next_action: null,
      visit_type:
        products.map((p) => p.visit_type).find((v) => v && v !== "notApplicable") ??
        products[0]?.visit_type ??
        null,
      metadata: isRecord(input.metadata) ? (input.metadata as Record<string, string>) : null,
      line_items: items,
      allow_promotion_codes: input.allow_promotion_codes === true,
      capture_method: typeof input.capture_method === "string" ? input.capture_method : "automatic",
      setup_future_use: typeof input.setup_future_use === "string" ? input.setup_future_use : null,
      test_mode: testMode,
      created_at: this.iso(),
      expires_at: new Date(this.now() + ttl * 1000).toISOString(),
      expiresAtMs: this.now() + ttl * 1000,
    }
    this.state.sessions.insert(id, session)
    return session
  }

  /** Off-session charges settle before the create response, per `offSessionOutcome`. */
  private chargeOffSession(session: SessionRecord, method: PaymentMethodRecord): void {
    const outcome = this.state.current().offSessionOutcome
    if (outcome === "succeeded") {
      this.settle(session.checkout_session_id, { paymentMethod: method.payment_method_id })
      return
    }
    this.setPaymentIntent(session.checkout_session_id, {
      status: outcome === "declined" ? "requires_payment_method" : "requires_action",
      payment_method: method.payment_method_id,
    })
    if (outcome === "declined")
      this.emitSession("checkout.session.async_payment_failed", session.checkout_session_id)
  }

  private view(context: OperationContext): SessionView {
    return {
      expandCustomer: flag(context.query.expand_customer),
      expandPaymentIntent: flag(context.query.expand_payment_intent),
    }
  }

  /** The wire shape of a session, with expansions and the response-shaping faults applied. */
  present(session: SessionRecord, view: SessionView, request?: Request): Record<string, unknown> {
    const { expiresAtMs: _expires, url, ...rest } = session
    const customer = session.customer
      ? view.expandCustomer
        ? (this.state.customers.get(session.customer) ?? session.customer)
        : session.customer
      : null
    const intent = session.payment_intent
      ? view.expandPaymentIntent
        ? (this.state.paymentIntents.get(session.payment_intent) ?? session.payment_intent)
        : session.payment_intent
      : null
    const out: Record<string, unknown> = {
      ...rest,
      customer,
      payment_intent: intent,
      redirect_url: url,
      url,
    }
    if (request && faultEffect(request, "amount_mismatch") !== undefined) {
      out.amount_total = session.amount_total + 100
    }
    if (request && faultEffect(request, "invalid_shape") !== undefined) {
      delete out.redirect_url
      delete out.url
    }
    return out
  }

  private sessionResponse(context: OperationContext, id: string, view?: SessionView): Response {
    const session = this.state.sessions.get(id)
    if (!session) return error(404, "invalid_request_error", `No such checkout session: '${id}'`)
    return annotateResponse(
      jsonRes(200, {
        checkout_session: this.present(session, view ?? this.view(context), context.request),
      }),
      { ids: { sessionId: id } },
    )
  }

  private getSession(context: OperationContext): Response {
    return this.sessionResponse(context, context.params.sessionId ?? "")
  }

  private listSessions(context: OperationContext): Response {
    const limit = Number(context.query.limit ?? 10)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return invalid("limit must be an integer between 1 and 100.", "limit")
    }
    const reference =
      typeof context.query.client_reference_id === "string"
        ? context.query.client_reference_id
        : undefined
    const all = this.state.sessions
      .list({ where: (s) => reference === undefined || s.client_reference_id === reference })
      .map((row) => row.value)
    const after =
      typeof context.query.starting_after === "string" ? context.query.starting_after : undefined
    let start = 0
    if (after !== undefined) {
      const index = all.findIndex((s) => s.checkout_session_id === after)
      if (index < 0) return invalid(`No such checkout session: '${after}'`, "starting_after")
      start = index + 1
    }
    const view = this.view(context)
    return jsonRes(200, {
      checkout_sessions: all
        .slice(start, start + limit)
        .map((s) => this.present(s, view, context.request)),
      has_more: start + limit < all.length,
    })
  }

  private refund(context: OperationContext): Response {
    const id = context.params.sessionId ?? ""
    const session = this.state.sessions.get(id)
    if (!session) return error(404, "invalid_request_error", `No such checkout session: '${id}'`)
    const problem = this.validate(context)
    if (problem) return problem
    const input = envelope(context, "checkout_session")
    if (session.mode === "setup") return invalid("A setup session has no payment to refund.")
    const received = session.amount_received ?? 0
    if ((session.status !== "complete" && session.status !== "paid") || received <= 0) {
      return invalid(`Checkout session '${id}' has not been paid.`)
    }
    const remaining = received - session.amount_refunded
    const amount = typeof input.amount === "number" ? input.amount : remaining
    if (remaining <= 0) return invalid(`Checkout session '${id}' has already been refunded.`)
    if (amount > remaining) {
      return invalid(
        `Refund amount (${amount}) is greater than the unrefunded amount (${remaining}).`,
        "amount",
      )
    }
    this.applyRefund(id, amount)
    return this.sessionResponse(context, id)
  }

  /** Refund part or all of a paid session, emitting the refund events. */
  applyRefund(id: string, amount: number): SessionRecord | undefined {
    const session = this.state.sessions.get(id)
    if (!session) return undefined
    const next = { ...session, amount_refunded: session.amount_refunded + amount }
    this.state.sessions.update(id, next)
    const refund = {
      refund_id: this.state.nextId("fre_"),
      checkout_session: id,
      payment_intent: session.payment_intent,
      amount,
      status: "succeeded" as const,
      created_at: this.iso(),
    }
    this.state.refunds.insert(refund.refund_id, refund)
    const charge = {
      charge_id: `fch_${refund.refund_id.slice(4)}`,
      checkout_session_id: id,
      payment_intent: session.payment_intent,
      amount: session.amount_received,
      amount_refunded: next.amount_refunded,
      refunded: next.amount_refunded >= (session.amount_received ?? 0),
    }
    this.emit("refund.created", { ...refund, status: "pending" }, session.test_mode)
    this.emit("charge.refunded", charge, session.test_mode)
    this.emitSession("checkout.session.refunded", id)
    this.emit("refund.updated", refund, session.test_mode)
    this.emit("charge.refund.updated", { ...refund, charge: charge.charge_id }, session.test_mode)
    return this.state.sessions.get(id)
  }

  // --- customers and setup intents ---------------------------------------------------------

  private createCustomer(context: OperationContext): Response {
    const problem = this.validate(context)
    if (problem) return problem
    const input = envelope(context, "customer")
    const customer = this.newCustomer(
      {
        first_name: String(input.first_name),
        last_name: String(input.last_name),
        email: String(input.email),
        phone: String(input.phone),
      },
      this.testMode(context),
    )
    return annotateResponse(jsonRes(200, { customer }), {
      ids: { customerId: customer.customer_id },
    })
  }

  private newCustomer(
    fields: Pick<CustomerRecord, "first_name" | "last_name" | "email" | "phone">,
    testMode: boolean,
  ): CustomerRecord {
    const customer: CustomerRecord = {
      customer_id: this.state.nextId("fcus_"),
      ...fields,
      test_mode: testMode,
      created_at: this.iso(),
    }
    this.state.customers.insert(customer.customer_id, customer)
    return customer
  }

  private getSetupIntent(context: OperationContext): Response {
    const id = context.params.setupIntentId ?? ""
    const intent = this.state.setupIntents.get(id)
    if (!intent) return error(404, "invalid_request_error", `No such setup intent: '${id}'`)
    const expand = String(context.query.expand ?? "").split(",")
    const customer =
      intent.customer && expand.includes("customer")
        ? (this.state.customers.get(intent.customer) ?? intent.customer)
        : intent.customer
    const method =
      intent.payment_method && expand.includes("payment_method")
        ? (this.state.paymentMethods.get(intent.payment_method) ?? intent.payment_method)
        : intent.payment_method
    return annotateResponse(
      jsonRes(200, { setup_intent: { ...intent, customer, payment_method: method } }),
      { ids: { setupIntentId: id } },
    )
  }

  private getSubscription(context: OperationContext): Response {
    const id = context.params.subscriptionId ?? ""
    const subscription = this.state.subscriptions.get(id)
    if (!subscription) return error(404, "invalid_request_error", `No such subscription: '${id}'`)
    return annotateResponse(jsonRes(200, { subscription }), { ids: { subscriptionId: id } })
  }

  /**
   * Start the subscription a paid subscription-mode session buys: active, billed from now
   * for one period of its first recurring line item, charged to the card just used.
   */
  private startSubscription(session: SessionRecord, paymentMethod: string): SubscriptionRecord {
    const recurring = session.line_items.flatMap((item) =>
      item.price_data.recurring
        ? [
            {
              price_data: { ...item.price_data, recurring: item.price_data.recurring },
              quantity: item.quantity,
            },
          ]
        : [],
    )
    const first = recurring[0]?.price_data.recurring ?? { interval: "month" as const }
    const data = session.subscription_data ?? {}
    const subscription: SubscriptionRecord = {
      subscription_id: this.state.nextId("fsub_"),
      status: "active",
      items: recurring,
      customer: session.customer,
      default_payment_method: paymentMethod,
      cancel_at_period_end: data.cancel_at_period_end === true,
      current_period_start: this.iso(),
      current_period_end: new Date(periodEnd(this.now(), first)).toISOString(),
      canceled_at: null,
      metadata: data.metadata ?? null,
      test_mode: session.test_mode,
      created_at: this.iso(),
    }
    this.state.subscriptions.insert(subscription.subscription_id, subscription)
    this.emit("customer.subscription.created", { ...subscription }, session.test_mode)
    return subscription
  }

  /** The subscriptions paid subscription-mode sessions created in this namespace. */
  subscriptions(): SubscriptionRecord[] {
    return this.state.subscriptions.list().map((row) => row.value)
  }

  // --- lifecycle (hosted page, admin, off-session) ----------------------------------------

  private paymentIntentFor(session: SessionRecord): PaymentIntentRecord {
    const existing = session.payment_intent
      ? this.state.paymentIntents.get(session.payment_intent)
      : undefined
    if (existing) return existing
    const intent: PaymentIntentRecord = {
      payment_intent_id: this.state.nextId("fpi_"),
      amount: session.amount_total,
      amount_received: null,
      customer: session.customer,
      payment_method: null,
      status: "requires_payment_method",
      created_at: this.iso(),
    }
    this.state.paymentIntents.insert(intent.payment_intent_id, intent)
    this.state.sessions.update(session.checkout_session_id, {
      ...session,
      payment_intent: intent.payment_intent_id,
    })
    return intent
  }

  /** Create or update the session's payment intent (`PUT /__admin/sessions/:id/payment-intent`). */
  setPaymentIntent(
    id: string,
    patch: Partial<
      Pick<PaymentIntentRecord, "status" | "amount_received" | "payment_method" | "customer">
    >,
  ): PaymentIntentRecord | undefined {
    const session = this.state.sessions.get(id)
    if (!session) return undefined
    const intent = { ...this.paymentIntentFor(session), ...patch }
    this.state.paymentIntents.update(intent.payment_intent_id, intent)
    if (patch.status === "succeeded") {
      this.emit(
        "payment_intent.succeeded",
        { ...intent, checkout_session_id: id },
        session.test_mode,
      )
    }
    return intent
  }

  private newPaymentMethod(customer: string | null, hsa: boolean): PaymentMethodRecord {
    const method: PaymentMethodRecord = {
      payment_method_id: this.state.nextId("fpm_"),
      type: "card",
      hsa_fsa: hsa,
      customer,
    }
    this.state.paymentMethods.insert(method.payment_method_id, method)
    return method
  }

  /**
   * Complete a session: the payment intent succeeds (or, in setup mode, the setup intent
   * saves a card), `amount_received` is set and the completion events go out.
   */
  settle(
    id: string,
    options: { paymentMethod?: string; hsa?: boolean; customer?: CustomerRecord } = {},
  ): SessionRecord | undefined {
    let session = this.state.sessions.get(id)
    if (session?.status !== "open") return session
    if (!session.customer && options.customer) {
      session = { ...session, customer: options.customer.customer_id }
      this.state.sessions.update(id, session)
    }
    const method =
      (options.paymentMethod ? this.state.paymentMethods.get(options.paymentMethod) : undefined) ??
      this.newPaymentMethod(session.customer, options.hsa ?? true)
    if (session.mode === "setup") {
      const intent = session.setup_intent
        ? this.state.setupIntents.get(session.setup_intent)
        : undefined
      if (intent) {
        this.state.setupIntents.update(intent.setup_intent_id, {
          ...intent,
          status: "succeeded",
          customer: intent.customer ?? session.customer,
          payment_method: method.payment_method_id,
        })
      }
      this.state.sessions.update(id, {
        ...session,
        status: "complete",
        amount_received: 0,
        next_action: null,
      })
      this.emitSession(this.completedType(), id)
      return this.state.sessions.get(id)
    }
    const before = this.paymentIntentFor(session)
    const wasProcessing = before.status === "processing"
    session = this.state.sessions.get(id) as SessionRecord
    // A subscription starts as the first period is paid: `customer.subscription.created`
    // goes out before `payment_intent.succeeded` and `checkout.session.completed`.
    const subscription =
      session.mode === "subscription"
        ? this.startSubscription(session, method.payment_method_id)
        : undefined
    this.state.sessions.update(id, {
      ...session,
      status: "complete",
      amount_received: session.amount_total,
      next_action: null,
      ...(subscription ? { subscription: subscription.subscription_id } : {}),
    })
    this.setPaymentIntent(id, {
      status: "succeeded",
      amount_received: session.amount_total,
      payment_method: method.payment_method_id,
      customer: session.customer,
    })
    this.emitSession(
      wasProcessing ? "checkout.session.async_payment_succeeded" : this.completedType(),
      id,
    )
    return this.state.sessions.get(id)
  }

  /** Decline: the payment intent falls back to requires_payment_method. */
  decline(id: string): SessionRecord | undefined {
    const session = this.state.sessions.get(id)
    if (!session) return undefined
    if (session.mode === "setup") {
      const intent = session.setup_intent
        ? this.state.setupIntents.get(session.setup_intent)
        : undefined
      if (intent)
        this.state.setupIntents.update(intent.setup_intent_id, {
          ...intent,
          status: "requires_payment_method",
        })
    } else {
      this.setPaymentIntent(id, { status: "requires_payment_method", amount_received: null })
    }
    this.emitSession("checkout.session.async_payment_failed", id)
    return this.state.sessions.get(id)
  }

  expire(id: string): SessionRecord | undefined {
    const session = this.state.sessions.get(id)
    if (!session) return undefined
    this.state.sessions.update(id, { ...session, status: "expired" })
    this.emitSession(
      this.state.current().eventNaming === "underscored"
        ? "checkout_session.expired"
        : "checkout.session.expired",
      id,
    )
    return this.state.sessions.get(id)
  }

  /** Put a next action on the session (its URL is the hosted page's step for it). */
  requireAction(
    id: string,
    type: NextActionType = "collect_letter_of_medical_necessity",
  ): SessionRecord | undefined {
    const session = this.state.sessions.get(id)
    if (!session) return undefined
    const next: NextAction =
      type === "payment_failed"
        ? { type, payment_failed: { message: "The payment could not be completed." } }
        : { type, [type]: { url: `${session.url}?step=${type}` } }
    this.state.sessions.update(id, { ...session, next_action: next })
    return this.state.sessions.get(id)
  }

  private completedType(): string {
    return this.state.current().eventNaming === "underscored"
      ? "checkout_session.completed"
      : "checkout.session.completed"
  }

  /** Expire open sessions whose `expires_at` has passed on the mock clock. */
  tick(): number {
    let expired = 0
    for (const { value: session } of this.state.sessions.list({
      where: (s) => s.status === "open" && s.expiresAtMs <= this.now(),
    })) {
      this.expire(session.checkout_session_id)
      expired++
    }
    return expired
  }

  sessions(): SessionRecord[] {
    return this.state.sessions.list().map((row) => row.value)
  }

  // --- webhooks ---------------------------------------------------------------------------

  /** Emit any event type for a session or product (`POST /__admin/events`). */
  emitFor(type: string, target: { sessionId?: string; productId?: string }): FlexEvent | undefined {
    if (target.productId) {
      const product = this.state.products.get(target.productId)
      return product ? this.emit(type, { ...product }, product.test_mode) : undefined
    }
    if (target.sessionId) return this.emitSession(type, target.sessionId)
    return undefined
  }

  private emitSession(type: string, id: string): FlexEvent | undefined {
    const session = this.state.sessions.get(id)
    if (!session) return undefined
    return this.emit(
      type,
      this.present(session, { expandCustomer: false, expandPaymentIntent: false }),
      session.test_mode,
    )
  }

  private emit(type: string, object: Record<string, unknown>, testMode: boolean): FlexEvent {
    const event: FlexEvent = {
      event_id: this.state.nextId("fevt_"),
      event_type: type,
      object,
      event_dt: Math.floor(this.now() / 1000),
      test_mode: testMode,
      created_at: this.iso(),
    }
    this.onEvent?.(event)
    return event
  }

  // --- hosted page ------------------------------------------------------------------------

  private pageInput(session: SessionRecord, errorMessage?: string) {
    const productNames = session.line_items.map(
      (item) => this.state.products.get(item.price_data.product)?.name ?? item.price_data.product,
    )
    return { session, productNames, ...(errorMessage ? { error: errorMessage } : {}) }
  }

  private render(session: SessionRecord, status = 200, errorMessage?: string): Response {
    if (session.status !== "open") return html(409, closedPage(session))
    const input = this.pageInput(session, errorMessage)
    const body = session.next_action
      ? nextActionPage(input, session.next_action.type)
      : cardPage(input)
    return annotateResponse(html(status, body), { ids: { sessionId: session.checkout_session_id } })
  }

  private hostedPage(context: OperationContext): Response {
    const session = this.state.sessions.get(context.params.sessionId ?? "")
    if (!session) return html(404, notFoundPage())
    return this.render(session)
  }

  private redirect(url: string, session: SessionRecord): Response {
    return annotateResponse(
      new Response(null, {
        status: 302,
        headers: { location: substituteSessionId(url, session.checkout_session_id) },
      }),
      { ids: { sessionId: session.checkout_session_id } },
    )
  }

  private submitHosted(context: OperationContext): Response {
    const id = context.params.sessionId ?? ""
    const session = this.state.sessions.get(id)
    if (!session) return html(404, notFoundPage())
    if (session.status !== "open") return html(409, closedPage(session))
    const form: Record<string, string> = {}
    if (context.body.kind === "form" || context.body.kind === "json") {
      for (const [key, value] of Object.entries(context.body.value as Record<string, unknown>)) {
        if (typeof value === "string") form[key] = value
      }
    }
    if (form.step === "lmn") {
      if (session.next_action?.type !== "collect_letter_of_medical_necessity")
        return this.render(session)
      const saved = session.payment_intent
        ? this.state.paymentIntents.get(session.payment_intent)?.payment_method
        : null
      const settled = this.settle(id, saved ? { paymentMethod: saved } : {})
      return this.redirect(session.success_url, settled ?? session)
    }
    const card = classifyCard(form)
    if (card.kind === "invalid") return this.render(session, 400, card.message)
    if (card.kind === "decline") {
      const declined = this.decline(id) ?? session
      return this.render(declined, 402, "Your card was declined.")
    }
    let customer: CustomerRecord | undefined
    if (!session.customer && form.email) {
      customer = this.newCustomer(
        {
          first_name: form.firstName || null,
          last_name: form.lastName || null,
          email: form.email,
          phone: form.phone || null,
        },
        session.test_mode,
      )
    }
    const customerId = session.customer ?? customer?.customer_id ?? null
    const method = this.newPaymentMethod(customerId, card.hsa)
    const needsLetter =
      session.mode !== "setup" &&
      !card.hsa &&
      this.state.current().lmnOnRegularCard &&
      session.next_action === null &&
      session.line_items.some(
        (item) =>
          this.state.products.get(item.price_data.product)?.hsa_fsa_eligibility ===
          "letter_of_medical_necessity",
      )
    if (needsLetter) {
      if (customer) this.state.sessions.update(id, { ...session, customer: customer.customer_id })
      this.setPaymentIntent(id, {
        status: "requires_action",
        payment_method: method.payment_method_id,
        customer: customerId,
      })
      const waiting = this.requireAction(id, "collect_letter_of_medical_necessity") ?? session
      const next = waiting.next_action?.collect_letter_of_medical_necessity as { url: string }
      return this.redirect(next.url, waiting)
    }
    const settled = this.settle(id, {
      paymentMethod: method.payment_method_id,
      ...(customer ? { customer } : {}),
    })
    return this.redirect(session.success_url, settled ?? session)
  }

  private cancelHosted(context: OperationContext): Response {
    const session = this.state.sessions.get(context.params.sessionId ?? "")
    if (!session?.cancel_url) return html(404, notFoundPage())
    return this.redirect(session.cancel_url, session)
  }
}

/** Whether a string is one of the next-action types. */
export const isNextActionType = (value: unknown): value is NextActionType =>
  typeof value === "string" && (NEXT_ACTION_TYPES as readonly string[]).includes(value)

export type { FlexRuntime, FlexRuntimeOptions } from "./runtime.js"
export { createRuntime, FLEX_PRESETS } from "./runtime.js"
