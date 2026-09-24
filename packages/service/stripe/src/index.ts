import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  faultEffect,
  IdempotencyStore,
  jsonResponse,
  type OperationHandler,
  type Service,
  type WebhookEndpoint,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { accountOfKey } from "./account.js"
import { type AccountConfig, AccountDirectory, DEFAULT_WEBHOOK_API_VERSION } from "./accounts.js"
import { DEFAULT_LIFECYCLE, type LifecycleSettings, runLifecycle } from "./billing.js"
import { browserHandlers } from "./browser.js"
import { chargeHandlers } from "./charges.js"
import { checkoutSessionHandlers } from "./checkout-sessions.js"
import { STRIPE_NAMESPACE } from "./constants.js"
import { requestInfo, setRequestInfo } from "./context.js"
import { type Corpus, seedCorpus } from "./corpus.js"
import { couponHandlers } from "./coupons.js"
import { customerHandlers } from "./customers.js"
import { disputeHandlers } from "./disputes.js"
import {
  invalidRequest,
  parameterInvalidEmpty,
  resourceMissing,
  StripeError,
  type StripeErrorInit,
  stripeErrorBody,
} from "./errors.js"
import { eventHandlers } from "./events.js"
import { expandPathsOf, expandResponse, responseShape, validateExpand } from "./expand.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type Services,
  type StripeWebhookEvent,
  systemScope,
  type WebhookPublisher,
} from "./internal.js"
import { invoiceItemHandlers } from "./invoice-items.js"
import { invoiceHandlers } from "./invoices.js"
import { ledgerHandlers } from "./ledger.js"
import { paymentIntentHandlers } from "./payment-intents.js"
import { paymentMethodHandlers } from "./payment-methods.js"
import { priceHandlers } from "./prices.js"
import { productHandlers } from "./products.js"
import { promotionCodeHandlers } from "./promotion-codes.js"
import { refundHandlers } from "./refunds.js"
import { setupIntentHandlers } from "./setup-intents.js"
import { shapeForEra } from "./shape.js"
import { StripeState } from "./state.js"
import { subscriptionScheduleHandlers } from "./subscription-schedules.js"
import { subscriptionHandlers } from "./subscriptions.js"
import { testClockHandlers } from "./test-clocks.js"
import { eraOf, isApiVersion, STRIPE_API_VERSION } from "./version.js"
import { webhookEndpointHandlers } from "./webhook-endpoints.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export { accountOf, accountOfKey } from "./account.js"
export type { AccountConfig } from "./accounts.js"
export { AccountDirectory, DEFAULT_WEBHOOK_API_VERSION } from "./accounts.js"
export type { LifecycleSettings } from "./billing.js"
export { STRIPE_NAMESPACE } from "./constants.js"
export type { Corpus } from "./corpus.js"
export { ACME_CORPUS } from "./corpus-data.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { StripeWebhookEvent, WebhookPublisher } from "./internal.js"
export {
  QA_AMOUNTS,
  QA_COUPON_CODES,
  QA_CUSTOMER,
  QA_METADATA,
  QA_SEARCH_QUERIES,
  QA_SURFACE_OPS,
  QA_TEST_CARD_TOKENS,
  QA_TEST_PAYMENT_METHODS,
} from "./qa-corpus.js"
export { reshapeQaCommand } from "./reshape-qa.js"
export { TEST_CARD_NUMBERS, TEST_PAYMENT_METHOD_IDS, TEST_TOKENS } from "./test-tokens.js"
export {
  ACACIA_API_VERSION,
  type ApiEra,
  LEGACY_API_VERSION,
  STRIPE_API_VERSION,
} from "./version.js"

const MISSING_API_KEY =
  "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY'). See https://stripe.com/docs/api#authentication for details, or we can help at https://support.stripe.com/."
const INVALID_API_KEY = "Invalid API Key provided: This key is not valid."
const URI_TOO_LARGE =
  "<html>\r\n<head><title>414 Request-URI Too Large</title></head>\r\n<body>\r\n<center><h1>414 Request-URI Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n"

const INVALID_IDEMPOTENCY_KEY = "Idempotency Key must be a non-empty string."
const PUBLISHABLE_KEY_FORBIDDEN =
  "This API call cannot be made with a publishable API key. Please use a secret API key. You can find a list of your API keys at https://dashboard.stripe.com/account/apikeys."

export type StripeAPIOptions = APIOptions & {
  /** Called with every event the mock records, so a server can deliver it. */
  onWebhook?: WebhookPublisher
  /** Which keys act as which account (shared across namespaces by the runtime). */
  accounts?: AccountDirectory | readonly AccountConfig[]
  /** The public namespace this instance serves, so hosted-page URLs route back to it. */
  publicNamespace?: string
  /** Public base URL for hosted pages (default: the origin the caller used). */
  publicUrl?: string
  /** Webhook version for accounts without an `apiVersion` (default `2024-06-20`). */
  webhookApiVersion?: string
  /** Endpoints an event would be delivered to (`pending_webhooks`); default none. */
  pendingWebhooks?: (account: string, type: string) => number
  /** Recorded catalog seeded into accounts configured with `corpus: true`. */
  corpus?: Corpus
  /** Called when webhook endpoints are created, changed or deleted through the API. */
  onEndpointsChanged?: () => void
  lifecycle?: Partial<LifecycleSettings>
}

const PUBLISHABLE_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/v1\/payment_intents\/([^/]+)\/confirm$/ },
  { method: "GET", pattern: /^\/v1\/payment_intents\/([^/]+)$/ },
  { method: "POST", pattern: /^\/v1\/setup_intents\/([^/]+)\/confirm$/ },
  { method: "GET", pattern: /^\/v1\/setup_intents\/([^/]+)$/ },
  { method: "POST", pattern: /^\/v1\/payment_methods$/ },
]

/** Browser surfaces the mock serves without an API key. */
const BROWSER_PATH = /^\/(?:c\/pay\/[^/]+|v3|c\/3ds\/[^/]+\/authenticate)\/?$/

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, stripe-version, idempotency-key, stripe-account, x-stripe-client-user-agent",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "request-id, stripe-version",
}

const bearer = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization")
  if (!authorization) return undefined
  const match = /^Bearer\s+(\S+)$/.exec(authorization)
  return match?.[1] ?? ""
}

const isSecretTestKey = (key: string) => /^(?:sk|rk)_test_[A-Za-z0-9_]+$/.test(key)
const isPublishableTestKey = (key: string) => /^pk_test_[A-Za-z0-9_]+$/.test(key)

const unrecognizedUrl = (request: Request) => {
  const url = new URL(request.url)
  return `Unrecognized request URL (${request.method}: ${url.pathname}). If you are trying to list objects, remove the trailing slash. If you are trying to retrieve an object, make sure you passed a valid (non-empty) identifier in your code. Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stateful mock of the Stripe API. State lives in SQLite, partitioned per account: each
 * configured account (`accounts`) is one partition however many keys act as it, and any other
 * test key is an account of its own. Responses are rendered at the request's `Stripe-Version`
 * (`2024-06-20`, `2025-02-24.acacia` and the vendored latest are modelled).
 */
export class StripeAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly accounts: AccountDirectory
  readonly adminWebhookEndpoints: Collection<WebhookEndpoint>
  private readonly service: Service
  private readonly state: StripeState
  private readonly services: Services
  private readonly idempotency: IdempotencyStore
  private readonly now: () => number
  private readonly settings: LifecycleSettings
  private readonly corpus: Corpus | undefined
  private lastTick = Number.NEGATIVE_INFINITY

  constructor(options: StripeAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? STRIPE_NAMESPACE
    const state = new StripeState(sqlite, namespace)
    this.adminWebhookEndpoints = new Collection(sqlite, namespace, "runtime_webhook_endpoints")
    this.state = state
    this.now = options.now ?? (() => Date.now())
    this.settings = { ...DEFAULT_LIFECYCLE, ...options.lifecycle }
    this.corpus = options.corpus
    this.accounts =
      options.accounts instanceof AccountDirectory
        ? options.accounts
        : new AccountDirectory(options.accounts ?? [])
    const accounts = this.accounts
    const webhookVersion = options.webhookApiVersion ?? DEFAULT_WEBHOOK_API_VERSION
    const services: Services = {
      state,
      publish: options.onWebhook,
      accounts,
      deliveryVersion: (account) => accounts.config(account)?.apiVersion ?? webhookVersion,
      pendingWebhooks: options.pendingWebhooks ?? (() => 0),
      namespacePrefix:
        options.publicNamespace === undefined || options.publicNamespace === "default"
          ? ""
          : `/ns/${encodeURIComponent(options.publicNamespace)}`,
      publicUrl: options.publicUrl,
      ...(options.onEndpointsChanged ? { endpointsChanged: options.onEndpointsChanged } : {}),
    }
    this.services = services
    this.idempotency = new IdempotencyStore(sqlite, namespace, "stripe_idempotency")
    const handlers = {
      ...customerHandlers(services),
      ...paymentMethodHandlers(services),
      ...paymentIntentHandlers(services),
      ...setupIntentHandlers(services),
      ...chargeHandlers(services),
      ...refundHandlers(services),
      ...disputeHandlers(services),
      ...checkoutSessionHandlers(services),
      ...invoiceHandlers(services),
      ...invoiceItemHandlers(services),
      ...subscriptionHandlers(services),
      ...subscriptionScheduleHandlers(services),
      ...couponHandlers(services),
      ...promotionCodeHandlers(services),
      ...productHandlers(services),
      ...priceHandlers(services),
      ...eventHandlers(services),
      ...ledgerHandlers(services),
      ...testClockHandlers(services, this.settings),
      ...webhookEndpointHandlers(services),
      ...browserHandlers(services),
    } as Record<SupportedOperationId, OperationHandler>
    this.service = createService({
      document,
      handlers: defineOperations<SupportedOperationId>(handlers),
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) => this.errorResponse({ status: 404, message: unrecognizedUrl(request) }),
      onError: (error) => {
        if (error instanceof StripeError) return this.errorResponse(error.init)
        throw error
      },
      before: (context) => {
        if (BROWSER_PATH.test(context.url.pathname)) return undefined
        const shape = responseShape(document, context.operation)
        const raw =
          context.body.kind === "form" &&
          typeof context.body.value === "object" &&
          context.body.value !== null &&
          !Array.isArray(context.body.value)
            ? (context.body.value as Record<string, unknown>).expand
            : undefined
        // Stripe checks these before anything operation-specific (verified in test mode): an
        // empty `expand` on a retrieve, and a v2 `customer_account` this account cannot have.
        const customerAccount =
          typeof context.query.customer_account === "string"
            ? context.query.customer_account
            : undefined
        // …but naming both a customer and a customer_account is refused before either resolves.
        if (customerAccount !== undefined && context.query.customer !== undefined)
          return this.errorResponse(
            invalidRequest(
              "You may only specify one of these parameters: customer, customer_account.",
              "customer",
            ).init,
          )
        if (customerAccount !== undefined && customerAccount !== "")
          return this.errorResponse(
            resourceMissing("customer", customerAccount, "customer_account", 400).init,
          )
        const paths = [...expandPathsOf(context.query.expand), ...expandPathsOf(raw)]
        try {
          validateExpand(paths, shape)
        } catch (error) {
          if (error instanceof StripeError) return this.errorResponse(error.init)
          throw error
        }
        const info = requestInfo(context.request)
        setRequestInfo(context.request, {
          ...info,
          expand: paths,
          ...(context.query.expand === "" ? { expandEmpty: true } : {}),
        })
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  private errorResponse(init: StripeErrorInit): Response {
    return jsonResponse(init.status, stripeErrorBody(init, this.requestLogUrl()))
  }

  private requestLogUrl() {
    return `https://dashboard.stripe.com/acct_mockingbird/test/workbench/logs?object=${this.state.ids.next("req_")}`
  }

  private decorate(response: Response, version: string, cors: boolean): Response {
    const headers = new Headers(response.headers)
    headers.set("request-id", this.state.ids.next("req_"))
    headers.set("stripe-version", version)
    if (cors) for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)
    return new Response(response.body, { status: response.status, headers })
  }

  /** The account holding a PaymentIntent or SetupIntent, for publishable-key calls. */
  private accountHolding(id: string): string | undefined {
    for (const account of this.state.accounts()) {
      if (account.paymentIntents.has(id) || account.setupIntents.has(id)) return account.account
    }
    return undefined
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Stripe's edge (nginx) refuses a request line over 16 KiB before the API sees it.
    if (`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n`.length > 16_384)
      return new Response(URI_TOO_LARGE, { status: 414, headers: { "content-type": "text/html" } })
    const cors = request.headers.has("origin")
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    const origin = url.origin
    const headerVersion = request.headers.get("stripe-version")
    if (BROWSER_PATH.test(url.pathname)) {
      setRequestInfo(request, {
        account: "",
        version: STRIPE_API_VERSION,
        era: "basil",
        publishable: false,
        origin,
      })
      this.tick()
      return this.decorate(await this.service.fetch(request), STRIPE_API_VERSION, cors)
    }
    const key = bearer(request)
    const fail = (init: StripeErrorInit) =>
      this.decorate(this.errorResponse(init), headerVersion ?? STRIPE_API_VERSION, cors)
    if (key === undefined) return fail({ status: 401, message: MISSING_API_KEY })
    let account: string
    let publishable = false
    if (isSecretTestKey(key)) account = this.accounts.accountFor(key)
    else if (isPublishableTestKey(key)) {
      publishable = true
      const route = PUBLISHABLE_ROUTES.find(
        (candidate) => candidate.method === request.method && candidate.pattern.test(url.pathname),
      )
      if (!route)
        return fail({
          status: 401,
          message: PUBLISHABLE_KEY_FORBIDDEN,
          type: "invalid_request_error",
        })
      const intentId = route.pattern.exec(url.pathname)?.[1]
      const configured = this.accounts.configFor(key)
      account =
        configured?.id ??
        (intentId === undefined ? undefined : this.accountHolding(intentId)) ??
        accountOfKey(key)
    } else return fail({ status: 401, message: INVALID_API_KEY, code: "invalid_api_key" })
    if (headerVersion !== null && !isApiVersion(headerVersion))
      return fail({ status: 400, message: `Invalid Stripe API version: ${headerVersion}` })
    const version = headerVersion ?? this.accounts.config(account)?.apiVersion ?? STRIPE_API_VERSION
    const era = eraOf(version)
    setRequestInfo(request, { account, version, era, publishable, origin })
    const partition = this.state.for(account)
    const config = this.accounts.config(account)
    if (config?.corpus && this.corpus) seedCorpus(partition, this.corpus)
    this.tick()

    const idempotencyKey = request.method === "POST" ? request.headers.get("idempotency-key") : null
    if (idempotencyKey !== null && (idempotencyKey.length === 0 || idempotencyKey.length > 255))
      return fail({ status: 400, message: INVALID_IDEMPOTENCY_KEY })

    const handle = async (): Promise<Response> => {
      const delay = faultEffect(request, "processing_delay")
      if (delay !== undefined) await sleep(typeof delay.ms === "number" ? delay.ms : 250)
      const response = await this.service.fetch(request)
      return this.finish(request, response, partition, era)
    }
    let response: Response
    if (idempotencyKey === null) response = await handle()
    else {
      const body = await request.clone().text()
      const fingerprint = `${request.method} ${url.pathname}?${url.search} ${body}`
      response = await this.idempotency.run(
        `${account}\u0000${idempotencyKey}`,
        fingerprint,
        {
          mismatch: () =>
            this.errorResponse({
              status: 400,
              type: "idempotency_error",
              message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idempotencyKey}' if you meant to execute a different request.`,
            }),
          conflict: () =>
            this.errorResponse({
              status: 409,
              code: "idempotency_key_in_use",
              message: `There is currently another in-progress request using this Idempotent Key (that probably means you submitted twice, and the other request is still going through): ${idempotencyKey}. Please try again later.`,
            }),
        },
        handle,
      )
    }
    return this.decorate(response, version, cors)
  }

  /** Expand and version-shape a JSON response. */
  private async finish(
    request: Request,
    response: Response,
    partition: ReturnType<StripeState["for"]>,
    era: ReturnType<typeof eraOf>,
  ): Promise<Response> {
    const type = response.headers.get("content-type") ?? ""
    if (!type.includes("application/json")) return response
    if (response.status !== 200 && response.status !== 402) return response
    // Stripe resolves the objects a read names before it refuses an empty `expand`.
    if (response.status === 200 && requestInfo(request).expandEmpty)
      return this.errorResponse(parameterInvalidEmpty("expand").init)
    const body = (await response.json()) as unknown
    const paths = requestInfo(request).expand ?? []
    const expanded =
      response.status === 200 && paths.length > 0
        ? expandResponse(partition, Math.floor(this.now() / 1000), body, paths)
        : body
    return new Response(JSON.stringify(shapeForEra(expanded, era)), {
      status: response.status,
      headers: response.headers,
    })
  }

  /**
   * Move every clock-driven lifecycle forward to the mock clock's now: renewals, cancellations
   * at period end, incomplete expiry, `invoice.upcoming`, schedule phases and Checkout Session
   * expiry. Runs at most once per second of mock time unless `force`d (the runtime forces it
   * whenever the clock is set or advanced).
   */
  tick(force = false): void {
    const now = this.now()
    if (!force && now - this.lastTick < 1000) return
    this.lastTick = now
    for (const account of this.state.accounts()) {
      try {
        runLifecycle(systemScope(this.services, account, this.now), this.settings)
      } catch (error) {
        console.error(
          `stripe lifecycle tick failed for ${account.account}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /** Admin access to one account's state as a handler would see it (runtime admin routes). */
  scopeFor(account: string, base?: string) {
    return systemScope(this.services, this.state.for(account), this.now, base)
  }

  /** Enabled webhook endpoints created through `POST /v1/webhook_endpoints`, per account. */
  apiWebhookEndpoints(): Array<{
    id: string
    account: string
    url: string
    secret: string
    events: string[]
  }> {
    return this.state.accounts().flatMap((account) =>
      account.webhookEndpoints
        .list({ order: "oldest" })
        .filter((entry) => entry.value.status === "enabled")
        .map((entry) => ({
          id: entry.value.id,
          account: account.account,
          url: entry.value.url,
          secret: entry.value.secret,
          events: entry.value.enabled_events,
        })),
    )
  }

  /** Every account partition with state, for admin lookups by object id. */
  accountIds(): string[] {
    return this.state.accounts().map((account) => account.account)
  }

  /**
   * Adopt another instance's state, so a lockstep walk can start from the state a warmup phase
   * produced elsewhere (see `seedParity`'s `seedMock`).
   */
  importStateFrom(source: StripeAPI): void {
    this.state.importFrom(source.state)
  }

  /**
   * Events this instance recorded, oldest first, as delivered to webhooks. `account` narrows to
   * one partition (`accountOfKey("sk_test_…")` or a configured account id).
   */
  webhookEvents(account?: string): StripeWebhookEvent[] {
    return this.state.accounts(account).flatMap((scope) =>
      scope.events.list({ order: "oldest" }).map((entry) => {
        const version = this.services.deliveryVersion(entry.value.account)
        return {
          id: entry.value.id,
          type: entry.value.type,
          account: entry.value.account,
          body: JSON.stringify(shapeForEra(JSON.parse(entry.value.body), eraOf(version))),
        }
      }),
    )
  }

  webhookDeliveryAttempts(account?: string) {
    return this.state
      .accounts(account)
      .flatMap((scope) =>
        scope.webhookDeliveryAttempts.list({ order: "oldest" }).map((entry) => entry.value),
      )
  }

  async reset(): Promise<void> {
    this.lastTick = Number.NEGATIVE_INFINITY
    await this.service.reset()
  }
}

export type { StripeRuntime, StripeRuntimeOptions } from "./runtime.js"
export { createRuntime, STRIPE_PRESETS } from "./runtime.js"
