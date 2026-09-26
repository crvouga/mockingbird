import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  jsonResponse,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { customerHandlers } from "./customers.js"
import {
  idempotencyKeyReused,
  StripeError,
  type StripeErrorInit,
  stripeErrorBody,
} from "./errors.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { priceHandlers } from "./prices.js"
import { productHandlers } from "./products.js"
import { StripeState } from "./state.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export const STRIPE_NAMESPACE = "stripe"

const MISSING_API_KEY =
  "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY'). See https://stripe.com/docs/api#authentication for details, or we can help at https://support.stripe.com/."

const unrecognizedUrl = (request: Request) => {
  const url = new URL(request.url)
  return `Unrecognized request URL (${request.method}: ${url.pathname}). If you are trying to list objects, remove the trailing slash. If you are trying to retrieve an object, make sure you passed a valid (non-empty) identifier in your code. Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`
}

/**
 * Stateful mock of the Stripe API. State lives in SQLite under the `stripe`
 * namespace. Pass `sqlite` to share a client across services; omit it to get a
 * fresh `@crvouga/sqlite-mem` database.
 */
export class StripeAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  private readonly service: Service
  private readonly state: StripeState
  private readonly errorResponse: (init: StripeErrorInit) => Promise<Response>

  constructor(options: APIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const state = new StripeState(sqlite, STRIPE_NAMESPACE)
    this.state = state
    const handlers = defineOperations<SupportedOperationId>({
      ...customerHandlers(state),
      ...productHandlers(state),
      ...priceHandlers(state),
    })
    const errorResponse = async (init: StripeErrorInit) =>
      jsonResponse(init.status, stripeErrorBody(init, await state.requestLogUrl()))
    this.errorResponse = errorResponse
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace: STRIPE_NAMESPACE,
      now: options.now,
      // Stripe authenticates before routing: an unknown URL without a key is still a 401.
      notFound: (request) =>
        request.headers.has("authorization")
          ? errorResponse({ status: 404, message: unrecognizedUrl(request) })
          : errorResponse({ status: 401, message: MISSING_API_KEY }),
      onError: (error) => {
        if (error instanceof StripeError) return errorResponse(error.init)
        throw error
      },
      before: (context) =>
        context.request.headers.has("authorization")
          ? undefined
          : errorResponse({ status: 401, message: MISSING_API_KEY }),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  /**
   * Stripe's idempotency layer for POST requests: the first response for an `Idempotency-Key`
   * is stored and replayed (with `Idempotent-Replayed: true`) for identical retries; reusing
   * the key with a different request is refused with an `idempotency_error`.
   */
  async fetch(request: Request): Promise<Response> {
    const key = request.headers.get("idempotency-key")
    if (request.method !== "POST" || key === null || key === "") return this.service.fetch(request)
    const url = new URL(request.url)
    const fingerprint = `${url.pathname}${url.search}\n${await request.clone().text()}`
    const stored = this.state.idempotency.get(key)
    if (stored) {
      if (stored.fingerprint !== fingerprint)
        return this.errorResponse(idempotencyKeyReused(key).init)
      const headers = new Headers({ "idempotent-replayed": "true" })
      if (stored.contentType !== null) headers.set("content-type", stored.contentType)
      return new Response(stored.body, { status: stored.status, headers })
    }
    const response = await this.service.fetch(request)
    // Unauthenticated requests never reach Stripe's idempotency layer.
    if (response.status !== 401) {
      this.state.idempotency.insert(key, {
        fingerprint,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.clone().text(),
      })
    }
    return response
  }

  /** Forget every customer, product and price. */
  reset(): Promise<void> {
    return this.service.reset()
  }
}
