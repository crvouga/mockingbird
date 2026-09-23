import { ResourceTable } from "@crvouga/mockingbird-model"
import { StripeAPI } from "../src/index.js"
import { compareStripeWebhooks, startStripeWebhookOracle } from "./webhook-oracle.js"

const key = process.env.MOCKINGBIRD_STRIPE_SECRET_KEY
if (!key?.startsWith("sk_test_"))
  throw new Error("webhook smoke requires MOCKINGBIRD_STRIPE_SECRET_KEY with a sk_test_ key")

const oracle = await startStripeWebhookOracle(key)
const mock = new StripeAPI()
let realCustomerId: string | undefined
try {
  const cursor = oracle.cursor()
  const body = new URLSearchParams({
    email: "webhook-parity@example.com",
    "metadata[parity]": "webhook-smoke",
  })
  const realResponse = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  })
  const realCustomer = (await realResponse.json()) as { id?: string }
  if (!realResponse.ok || !realCustomer.id)
    throw new Error(`real customer creation failed (${realResponse.status})`)
  realCustomerId = realCustomer.id

  const mockResponse = await mock.fetch(
    new Request("https://mock.stripe.local/v1/customers", {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_mockingbird",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }),
  )
  const mockCustomer = (await mockResponse.json()) as { id?: string }
  if (!mockResponse.ok || !mockCustomer.id)
    throw new Error(`mock customer creation failed (${mockResponse.status})`)

  const table = new ResourceTable()
  table.register("customer", { real: realCustomerId, mock: mockCustomer.id })
  const mockEvents = mock.webhookEvents().map((event) => JSON.parse(event.body) as unknown)
  const realEvents = await oracle.collect(cursor, mockEvents.length)
  const mismatch = compareStripeWebhooks(realEvents, mockEvents, table)
  if (mismatch) throw new Error(`Stripe CLI webhook parity: ${mismatch}`)
  if (realEvents.length === 0) throw new Error("Stripe CLI webhook parity: no events observed")
  console.log(`Stripe CLI webhook parity passed (${realEvents.length} customer event)`)
} finally {
  if (realCustomerId) {
    await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(realCustomerId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    })
  }
  await oracle.close()
}
