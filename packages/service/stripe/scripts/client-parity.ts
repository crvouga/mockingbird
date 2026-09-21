/**
 * Drop-in smoke proof: drive the mock through the same stripe-node client path a consumer app uses, and
 * verify a delivered webhook with the SDK's own signature check.
 *
 *   bun run mock:server   # optional: run the HTTP server yourself
 *   bun run client-parity # serves the mock in-process and asserts the flows below
 */

import { createHmac } from "node:crypto"
import { serve } from "@crvouga/mockingbird-adapter-bun"
import Stripe from "stripe"
import { accountOfKey } from "../src/account.js"
import { StripeAPI } from "../src/index.js"

const MSO_KEY = "sk_test_mockingbirdmso"
const PC_KEY = "sk_test_mockingbirdpc"
const API_VERSION = "2024-06-20" as const
const WEBHOOK_SECRET = "whsec_local_test"

type Delivered = { body: string; signature: string }

const checks: string[] = []
const check = (label: string, condition: boolean) => {
  if (!condition) throw new Error(`FAILED: ${label}`)
  checks.push(label)
}

const delivered: Delivered[] = []
const receiver = Bun.serve({
  fetch: async (request) => {
    if (new URL(request.url).pathname !== "/webhooks") return new Response("", { status: 404 })
    const signature = request.headers.get("stripe-signature") ?? ""
    delivered.push({ body: await request.text(), signature })
    return Response.json({ received: true })
  },
  hostname: "127.0.0.1",
  port: 0,
})

const mock = new StripeAPI({
  onWebhook: (event) => {
    if (event.account !== accountOfKey(MSO_KEY)) return
    const timestamp = Math.floor(Date.now() / 1000)
    const body = event.body
    const signature = `t=${timestamp},v1=${createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex")}`
    void fetch(`http://127.0.0.1:${receiver.port}/webhooks`, {
      body,
      headers: { "content-type": "application/json", "stripe-signature": signature },
      method: "POST",
    })
  },
})

const server = serve(mock, { port: 0 })
const client = (key: string) =>
  new Stripe(key, {
    apiVersion: API_VERSION,
    host: "127.0.0.1",
    port: server.port,
    protocol: "http",
  })

const mso = client(MSO_KEY)
const pc = client(PC_KEY)

// --- customers, payment methods, and a stored-card charge -------------------------------------
const customer = await mso.customers.create({
  email: "qa+e2e@test.example.com",
  metadata: { source: "e2e-test" },
  name: "Ada Lovelace",
})
check("customer created", customer.id.startsWith("cus_"))

const attached = await mso.paymentMethods.attach("pm_card_visa", { customer: customer.id })
check("test payment method attached", attached.card?.last4 === "4242")
await mso.customers.update(customer.id, {
  invoice_settings: { default_payment_method: attached.id },
})

const intent = await mso.paymentIntents.create({
  amount: 15000,
  confirm: true,
  currency: "usd",
  customer: customer.id,
  metadata: { intent: "e2e-test", userId: "1001" },
  off_session: true,
  payment_method: attached.id,
})
check("payment intent succeeded", intent.status === "succeeded")
check(
  "client secret carries the intent id",
  intent.client_secret?.startsWith(`${intent.id}_secret_`) === true,
)

const fetched = await mso.paymentIntents.retrieve(intent.id, { expand: ["latest_charge"] })
check("latest_charge expands to a charge", typeof fetched.latest_charge === "object")

let declineCode: string | undefined
try {
  await mso.paymentIntents.create({
    amount: 1000,
    confirm: true,
    currency: "usd",
    customer: customer.id,
    off_session: true,
    payment_method: "pm_card_authenticationRequired",
  })
} catch (error) {
  if (error instanceof Stripe.errors.StripeError) declineCode = error.code ?? undefined
}
check(
  "declining test card raises authentication_required",
  declineCode === "authentication_required",
)

// --- business-account isolation ----------------------------------------------------------------
const pcCustomer = await pc.customers.create({ email: "pc+e2e@test.example.com" })
const pcIntent = await pc.paymentIntents.create({
  amount: 2000,
  currency: "usd",
  customer: pcCustomer.id,
})
let missingOnMso = false
try {
  await mso.paymentIntents.retrieve(pcIntent.id)
} catch (error) {
  missingOnMso = error instanceof Stripe.errors.StripeError && error.code === "resource_missing"
}
check("PC objects are resource_missing on the MSO account", missingOnMso)

// --- search, refunds, ledger -------------------------------------------------------------------
const found = await mso.customers.search({ query: "metadata['source']:'e2e-test'" })
check(
  "customer search by metadata",
  found.data.some((entry) => entry.id === customer.id),
)

const refund = await mso.refunds.create({
  payment_intent: intent.id,
  metadata: { operationId: "qa-1" },
})
check("refund succeeded", refund.status === "succeeded")
check("refund metadata round-trips", refund.metadata.operationId === "qa-1")

const credit = await mso.customers.createBalanceTransaction(customer.id, {
  amount: -1500,
  currency: "usd",
  metadata: { paymentIntentId: intent.id, source: "credit-application" },
})
check("balance transaction recorded", credit.ending_balance === -1500)
const ledger = await mso.customers.listBalanceTransactions(customer.id, { limit: 100 })
check(
  "balance ledger keeps metadata",
  ledger.data.some((entry) => entry.metadata.paymentIntentId === intent.id),
)

// --- catalog, subscriptions, invoices ----------------------------------------------------------
const product = await mso.products.create({ name: "Membership" })
const price = await mso.prices.create({
  currency: "usd",
  product: product.id,
  recurring: { interval: "month" },
  unit_amount: 17999,
})
check("recurring price created", price.recurring?.interval === "month")

const subscription = await mso.subscriptions.create({
  customer: customer.id,
  items: [{ price: price.id }],
  metadata: { intent: "e2e-test" },
  payment_behavior: "error_if_incomplete",
})
check("subscription active", subscription.status === "active")
check("subscription item carries its price", subscription.items.data[0]?.price.id === price.id)
check("subscription exposes a period end", typeof subscription.current_period_end === "number")

const invoices = await mso.invoices.list({ customer: customer.id })
check("subscription created an invoice", invoices.data.length > 0)

// The subscription charged its default payment method at creation, as Stripe does.
const paid = await mso.invoices.retrieve(invoices.data[0]?.id ?? "")
check("invoice paid", paid.status === "paid")
const paidOnly = await mso.invoices.list({ customer: customer.id, status: "paid" })
check(
  "paid invoice is listed as paid",
  paidOnly.data.some((entry) => entry.id === paid.id),
)

const eventTypes = mock.webhookEvents(accountOfKey(MSO_KEY)).map((event) => event.type)
check("payment intent webhook emitted", eventTypes.includes("payment_intent.succeeded"))
check("invoice webhook emitted", eventTypes.includes("invoice.paid"))
check("subscription webhook emitted", eventTypes.includes("customer.subscription.created"))

// --- webhook signature verification, using the SDK verifier a consumer app uses -------------------------
const envelope = delivered.find((entry) => entry.body.includes('"payment_intent.succeeded"'))
if (envelope === undefined) throw new Error("FAILED: webhook delivered")
// Bun runs stripe-node's ESM build against SubtleCrypto, so verification is the async form — the
// signature bytes and secret handling are identical to what stripe-node's Node build calls synchronously.
const verified = await Stripe.webhooks.constructEventAsync(
  envelope.body,
  envelope.signature,
  WEBHOOK_SECRET,
)
check("webhook payload verifies with the SDK", verified.data.object.id === intent.id)

await Bun.sleep(50)
await server.stop(true)
receiver.stop(true)

console.log(`stripe client-parity: ${checks.length} checks passed`)
for (const label of checks) console.log(`  ok  ${label}`)
