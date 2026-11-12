/**
 * A Stripe emulator in the browser, and the API calls the stories make to put it in the state a
 * page shows: catalog, customers, subscriptions, Checkout and portal sessions.
 */
import { createRuntime } from "@crvouga/mockingbird-service-stripe"

/** The origin the emulator believes it is served from. */
export const ORIGIN = "https://stripe.mock"
export const SECRET_KEY = "sk_test_storybook"
export const PUBLISHABLE_KEY = "pk_test_storybook"

type Params = Record<string, unknown>
type StripeObject = { id: string; url?: string; client_secret?: string } & Record<string, unknown>

/** Stripe's form encoding: nested objects and arrays as `a[b][0]=c`. */
function encode(value: unknown, prefix: string, out: URLSearchParams): URLSearchParams {
  if (value === undefined || value === null) return out
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) encode(item, `${prefix}[${index}]`, out)
  } else if (typeof value === "object")
    for (const [key, item] of Object.entries(value))
      encode(item, prefix ? `${prefix}[${key}]` : key, out)
  else out.append(prefix, String(value))
  return out
}

export function stripe() {
  const emulator = createRuntime()
  const call = async (method: string, path: string, params: Params = {}): Promise<StripeObject> => {
    const response = await emulator.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${SECRET_KEY}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        ...(method === "GET" ? {} : { body: encode(params, "", new URLSearchParams()) }),
      }),
    )
    const body = (await response.json()) as StripeObject & { error?: { message: string } }
    if (body.error) throw new Error(`${method} ${path}: ${body.error.message}`)
    return body
  }
  const post = (path: string, params?: Params) => call("POST", path, params)

  return {
    emulator,
    post,
    /** A product with a monthly price, as the merchant sells it. */
    async plan(name = "Unlimited", amount = 700, extra: Params = {}) {
      const product = await post("/v1/products", {
        name,
        description: "Get unlimited access to Gamezilla servers.",
        ...extra,
      })
      return post("/v1/prices", {
        product: product.id,
        currency: "usd",
        unit_amount: amount,
        recurring: { interval: "month" },
        lookup_key: name.toLowerCase().replace(/\W+/g, "_"),
      })
    },
    async oneTime(name: string, amount: number) {
      const product = await post("/v1/products", { name })
      return post("/v1/prices", { product: product.id, currency: "usd", unit_amount: amount })
    },
    customer: (params: Params = {}) =>
      post("/v1/customers", { email: "alice@gmail.com", name: "Alice Liddell", ...params }),
    /** A customer paying for `price` with the Visa test card. */
    async subscriber(price: string, params: Params = {}) {
      const customer = await post("/v1/customers", {
        email: "alice@gmail.com",
        name: "Alice Liddell",
      })
      const card = await post("/v1/payment_methods/pm_card_visa/attach", { customer: customer.id })
      await post(`/v1/customers/${customer.id}`, {
        invoice_settings: { default_payment_method: card.id },
      })
      const subscription = await post("/v1/subscriptions", {
        customer: customer.id,
        items: [{ price }],
        ...params,
      })
      return { customer, subscription }
    },
    checkout: (params: Params) =>
      post("/v1/checkout/sessions", {
        success_url: "https://merchant.example/success",
        cancel_url: "https://merchant.example/cancel",
        ...params,
      }),
    portal: (customer: string, params: Params = {}) =>
      post("/v1/billing_portal/sessions", {
        customer,
        return_url: "https://merchant.example/account",
        ...params,
      }),
  }
}
