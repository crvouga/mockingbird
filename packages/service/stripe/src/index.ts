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
import {
  PUBLISHABLE_KEY_MESSAGE,
  publishableAllowed,
  readApiKey,
  stripTransportParams,
} from "./auth.js"
import { billingHandlers, renderInvoice, renderSubscription } from "./billing.js"
import { checkoutHandlers } from "./checkout.js"
import { customerHandlers, renderCustomer } from "./customers.js"
import { elementHandlers } from "./elements.js"
import { StripeError, stripeErrorBody } from "./errors.js"
import { registerExpander } from "./expand.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { withIdempotency } from "./idempotency.js"
import {
  paymentHandlers,
  renderCharge,
  renderPaymentIntent,
  renderPaymentMethod,
} from "./payments.js"
import { platformHandlers } from "./platform.js"
import { priceHandlers, renderPrice } from "./prices.js"
import { productHandlers, renderProduct } from "./products.js"
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

let expandersReady = false
const ensureExpanders = () => {
  if (expandersReady) return
  expandersReady = true
  registerExpander("customer", async (state, id) => {
    const entry = await state.customers.get(id)
    return entry?.kind === "live" ? renderCustomer(entry.customer) : undefined
  })
  registerExpander("default_payment_method", async (state, id) => {
    const method = await state.paymentMethods.get(id)
    return method ? renderPaymentMethod(method) : undefined
  })
  registerExpander("payment_method", async (state, id) => {
    const method = await state.paymentMethods.get(id)
    return method ? renderPaymentMethod(method) : undefined
  })
  registerExpander("payment_intent", async (state, id) => {
    const intent = await state.paymentIntents.get(id)
    return intent ? renderPaymentIntent(state, intent) : undefined
  })
  registerExpander("latest_charge", async (state, id) => {
    const charge = await state.charges.get(id)
    return charge ? renderCharge(state, charge) : undefined
  })
  registerExpander("charge", async (state, id) => {
    const charge = await state.charges.get(id)
    return charge ? renderCharge(state, charge) : undefined
  })
  registerExpander("invoice", async (state, id) => {
    const invoice = await state.invoices.get(id)
    return invoice ? renderInvoice(invoice) : undefined
  })
  registerExpander("latest_invoice", async (state, id) => {
    const invoice = await state.invoices.get(id)
    return invoice ? renderInvoice(invoice) : undefined
  })
  registerExpander("subscription", async (state, id) => {
    const subscription = await state.subscriptions.get(id)
    return subscription ? renderSubscription(state, subscription) : undefined
  })
  registerExpander("price", async (state, id) => {
    const price = await state.prices.get(id)
    return price ? renderPrice(price) : undefined
  })
  registerExpander("product", async (state, id) => {
    const product = await state.products.get(id)
    return product ? renderProduct(product) : undefined
  })
  registerExpander("default_price", async (state, id) => {
    const price = await state.prices.get(id)
    return price ? renderPrice(price) : undefined
  })
}

const wrap = <Id extends string>(
  state: StripeState,
  handlers: Record<Id, OperationHandler>,
): Record<Id, OperationHandler> => {
  const wrapped = {} as Record<Id, OperationHandler>
  for (const id of Object.keys(handlers) as Id[]) {
    const handler = handlers[id]
    wrapped[id] = withIdempotency(state, handler)
  }
  return wrapped
}

/**
 * Stateful mock of the Stripe API. State lives in SQLite under the `stripe`
 * namespace. Pass `sqlite` to share a client across services; omit it to get a
 * fresh `@crvouga/sqlite-mem` database.
 *
 * Point the official Stripe SDKs at this server with a test key. Stripe.js can
 * use the same origin for Elements: payment intents, confirmation tokens, and
 * `/v1/elements/sessions`.
 */
export class StripeAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  private readonly service: Service

  constructor(options: APIOptions = {}) {
    ensureExpanders()
    const sqlite = bootSqlite(options.sqlite)
    const state = new StripeState(sqlite, STRIPE_NAMESPACE)
    const handlers = defineOperations<SupportedOperationId>(
      wrap(state, {
        ...customerHandlers(state),
        ...productHandlers(state),
        ...priceHandlers(state),
        ...paymentHandlers(state),
        ...billingHandlers(state),
        ...checkoutHandlers(state),
        ...platformHandlers(state),
        ...elementHandlers(state),
      }),
    )
    const errorResponse = async (init: ConstructorParameters<typeof StripeError>[0]) =>
      jsonResponse(init.status, stripeErrorBody(init, await state.requestLogUrl()))
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace: STRIPE_NAMESPACE,
      now: options.now,
      notFound: (request) => errorResponse({ status: 404, message: unrecognizedUrl(request) }),
      onError: (error) => {
        if (error instanceof StripeError) return errorResponse(error.init)
        throw error
      },
      before: (context) => {
        const key = readApiKey(context.request, context.query)
        stripTransportParams(context.query)
        if (!key) return errorResponse({ status: 401, message: MISSING_API_KEY })
        if (key.publishable && !publishableAllowed(context.request))
          return errorResponse({ status: 403, message: PUBLISHABLE_KEY_MESSAGE })
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  /** Forget every Stripe record in this namespace. */
  reset(): Promise<void> {
    return this.service.reset()
  }
}
