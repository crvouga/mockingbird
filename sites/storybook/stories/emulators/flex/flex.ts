/**
 * A Flex emulator in the browser, and the API calls the stories make to put a hosted checkout in
 * the state a page shows: products, sessions in each mode, and the admin's next actions.
 */
import { createRuntime } from "@crvouga/mockingbird-service-flex"

/** The origin the emulator believes it is served from. */
export const ORIGIN = "https://api.withflex.com"
export const SECRET_KEY = "fsk_test_storybook"

type Json = Record<string, unknown>
export type Session = { checkout_session_id: string; redirect_url: string } & Json

export function flex() {
  const emulator = createRuntime()
  const send = async (path: string, method: string, body?: unknown): Promise<Json> => {
    const response = await emulator.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const json = (await response.json()) as Json
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`)
    return json
  }
  /** `/__admin/<path>`: the emulator's control plane. */
  const admin = (path: string, body: unknown = {}, method = "POST") =>
    send(`/__admin${path}`, method, body)

  /** A product; `letter` makes it one that needs a letter of medical necessity. */
  const product = async (name: string, letter = false): Promise<string> => {
    const created = (await send("/v1/products", "POST", { product: { name } })).product as Json
    const id = String(created.product_id)
    if (letter)
      await admin(`/products/${id}`, { hsa_fsa_eligibility: "letter_of_medical_necessity" }, "PUT")
    return id
  }

  const checkout = async (input: Json): Promise<Session> =>
    (
      await send("/v1/checkout/sessions", "POST", {
        checkout_session: {
          success_url: "https://clinic.example/paid?session={CHECKOUT_SESSION_ID}",
          cancel_url: "https://clinic.example/cart",
          ...input,
        },
      })
    ).checkout_session as Session

  return {
    emulator,
    admin,
    product,
    checkout,
    /** A one-time payment for a lab panel and a supplement. */
    async payment(letter = false): Promise<Session> {
      const panel = await product("Comprehensive metabolic panel", letter)
      const vitamin = await product("Vitamin D3 + K2")
      return checkout({
        mode: "payment",
        line_items: [
          { price_data: { product: panel, unit_amount: 8900 }, quantity: 1 },
          { price_data: { product: vitamin, unit_amount: 2450 }, quantity: 2 },
        ],
      })
    },
    /** A membership billed every `count` months. */
    async subscription(count = 1): Promise<Session> {
      const membership = await product("Wellness membership")
      return checkout({
        mode: "subscription",
        line_items: [
          {
            price_data: {
              product: membership,
              unit_amount: 19900,
              recurring: { interval: "month", interval_count: count },
            },
            quantity: 1,
          },
        ],
      })
    },
    /** Setup mode: save an HSA/FSA card for a customer, nothing charged. */
    async setup(): Promise<Session> {
      const customer = (
        await send("/v1/customers", "POST", {
          customer: {
            first_name: "Ada",
            last_name: "Lovelace",
            email: "ada@example.com",
            phone: "6025550142",
          },
        })
      ).customer as Json
      return checkout({ mode: "setup", customer: customer.customer_id, line_items: [] })
    },
  }
}
