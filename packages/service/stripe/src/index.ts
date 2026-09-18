import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  jsonResponse,
  type OperationHandler,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { chargeHandlers } from "./charges.js"
import { checkoutSessionHandlers } from "./checkout-sessions.js"
import { STRIPE_NAMESPACE } from "./constants.js"
import { couponHandlers } from "./coupons.js"
import { customerHandlers } from "./customers.js"
import { disputeHandlers } from "./disputes.js"
import { StripeError, stripeErrorBody } from "./errors.js"
import { eventHandlers } from "./events.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import type { Services, StripeWebhookEvent, WebhookPublisher } from "./internal.js"
import { invoiceItemHandlers } from "./invoice-items.js"
import { invoiceHandlers } from "./invoices.js"
import { paymentIntentHandlers } from "./payment-intents.js"
import { paymentMethodHandlers } from "./payment-methods.js"
import { priceHandlers } from "./prices.js"
import { productHandlers } from "./products.js"
import { promotionCodeHandlers } from "./promotion-codes.js"
import { refundHandlers } from "./refunds.js"
import { setupIntentHandlers } from "./setup-intents.js"
import { StripeState } from "./state.js"
import { subscriptionScheduleHandlers } from "./subscription-schedules.js"
import { subscriptionHandlers } from "./subscriptions.js"
import { STRIPE_API_VERSION } from "./version.js"

export { accountOf, accountOfKey } from "./account.js"
export { STRIPE_NAMESPACE } from "./constants.js"
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

const MISSING_API_KEY =
  "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY'). See https://stripe.com/docs/api#authentication for details, or we can help at https://support.stripe.com/."
const INVALID_API_KEY = "Invalid API Key provided: This key is not valid."
const INVALID_IDEMPOTENCY_KEY = "Idempotency Key must be a non-empty string."

export type StripeAPIOptions = APIOptions & {
  /** Called with every event the mock records, so a server can deliver it. */
  onWebhook?: WebhookPublisher
}

type CachedResponse = {
  fingerprint: string
  status: number
  headers: [string, string][]
  body: ArrayBuffer
}

const responseWithHeaders = (response: Response, requestId: string) => {
  const headers = new Headers(response.headers)
  headers.set("request-id", requestId)
  headers.set("stripe-version", STRIPE_API_VERSION)
  return new Response(response.body, { status: response.status, headers })
}

const unrecognizedUrl = (request: Request) => {
  const url = new URL(request.url)
  return `Unrecognized request URL (${request.method}: ${url.pathname}). If you are trying to list objects, remove the trailing slash. If you are trying to retrieve an object, make sure you passed a valid (non-empty) identifier in your code. Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`
}

const isTestKey = (key: string | undefined): key is string =>
  key !== undefined && /^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(key)

/**
 * Stateful mock of the Stripe API. State lives in SQLite, partitioned per test API key so two keys
 * behave like two accounts. Pass `sqlite` to share a client across services; omit it to get a
 * fresh `@crvouga/sqlite-mem` database.
 */
export class StripeAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  private readonly service: Service
  private readonly state: StripeState
  private readonly idempotency = new Map<string, CachedResponse>()

  constructor(options: StripeAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const state = new StripeState(sqlite, STRIPE_NAMESPACE)
    this.state = state
    const services: Services = { state, publish: options.onWebhook }
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
    } as Record<SupportedOperationId, OperationHandler>
    const errorResponse = async (init: ConstructorParameters<typeof StripeError>[0]) =>
      jsonResponse(init.status, stripeErrorBody(init, await state.requestLogUrl()))
    this.service = createService({
      document,
      handlers: defineOperations<SupportedOperationId>(handlers),
      sqlite,
      namespace: STRIPE_NAMESPACE,
      now: options.now,
      notFound: (request) => errorResponse({ status: 404, message: unrecognizedUrl(request) }),
      onError: (error) => {
        if (error instanceof StripeError) return errorResponse(error.init)
        throw error
      },
      before: (context) => {
        const authorization = context.request.headers.get("authorization")
        if (!authorization) return errorResponse({ status: 401, message: MISSING_API_KEY })
        const match = /^Bearer\s+(\S+)$/.exec(authorization)
        const key = match?.[1]
        if (!isTestKey(key))
          return errorResponse({ status: 401, message: INVALID_API_KEY, code: "invalid_api_key" })
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  async fetch(request: Request): Promise<Response> {
    const idempotencyKey = request.method === "POST" ? request.headers.get("idempotency-key") : null
    if (idempotencyKey !== null && (idempotencyKey.length === 0 || idempotencyKey.length > 255)) {
      const response = await jsonResponse(
        400,
        stripeErrorBody(
          { status: 400, message: INVALID_IDEMPOTENCY_KEY },
          await this.state.requestLogUrl(),
        ),
      )
      return responseWithHeaders(response, await this.state.ids.next("req_"))
    }
    const body =
      request.method === "POST" ? await request.clone().arrayBuffer() : new ArrayBuffer(0)
    const url = new URL(request.url)
    const fingerprint = `${request.method} ${url.pathname}?${url.search} ${new TextDecoder().decode(body)}`
    const cacheKey =
      idempotencyKey === null ? null : `${request.headers.get("authorization")}\n${idempotencyKey}`
    if (cacheKey !== null) {
      const cached = this.idempotency.get(cacheKey)
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          const response = await jsonResponse(
            400,
            stripeErrorBody(
              {
                status: 400,
                message:
                  "Keys for idempotent requests must have the same parameters as the original request.",
              },
              await this.state.requestLogUrl(),
            ),
          )
          return responseWithHeaders(response, await this.state.ids.next("req_"))
        }
        return new Response(cached.body.slice(0), {
          status: cached.status,
          headers: cached.headers,
        })
      }
    }
    const response = await this.service.fetch(request)
    const requestId = await this.state.ids.next("req_")
    const decorated = responseWithHeaders(response, requestId)
    if (cacheKey !== null && decorated.status < 500) {
      this.idempotency.set(cacheKey, {
        fingerprint,
        status: decorated.status,
        headers: [...decorated.headers.entries()],
        body: await decorated.clone().arrayBuffer(),
      })
    }
    return decorated
  }

  /**
   * Adopt another instance's state, so a lockstep walk can start from the state a warmup phase
   * produced elsewhere (see `seedParity`'s `seedMock`).
   */
  importStateFrom(source: StripeAPI): void {
    this.state.importFrom(source.state)
  }

  /**
   * Events this instance recorded, oldest first. `account` narrows to one API key's partition
   * (`accountOfKey("sk_test_…")`); omit it for every partition the instance has seen.
   */
  webhookEvents(account?: string): StripeWebhookEvent[] {
    return this.state.accounts(account).flatMap((scope) =>
      scope.events.list({ order: "oldest" }).map((entry) => ({
        type: entry.value.type,
        account: entry.value.account,
        body: entry.value.body,
      })),
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
    this.idempotency.clear()
    await this.service.reset()
  }
}
