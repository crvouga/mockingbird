import { expect, test } from "bun:test"
import { createCheckout } from "./checkout.ts"
import * as emulators from "./emulators.ts"

// Before: createCheckout({ fetch, keys: sandboxKeys }), and every call below
// crossed the network to a live sandbox. After: the same app and the same
// tests, with a fetch that reaches emulators in this process.
const checkout = createCheckout(emulators)

test("charges the card", async () => {
  const payment = await checkout.charge(2900)
  expect(payment.status).toBe("succeeded")
})

test("texts the receipt", async () => {
  const message = await checkout.text("+12025550123", "Your order is paid.")
  expect(message.sid).toStartWith("SM")
})

test("summarizes the order", async () => {
  expect(await checkout.summarize("order 1")).toBe("One starter kit, paid.")
})

test("posts to #orders", async () => {
  const posted = await checkout.announce("Order 1 is paid.")
  expect(posted.ok).toBe(true)
})

test("emails the invoice", async () => {
  const email = await checkout.invoice("ada@example.com")
  expect(email.id).toBeString()
})

test("stores the PDF", async () => {
  expect(await checkout.store("order-1.pdf", "%PDF-1.7")).toBe("%PDF-1.7")
})
