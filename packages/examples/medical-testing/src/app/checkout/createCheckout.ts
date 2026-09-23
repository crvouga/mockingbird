import { findLabTestsByIds } from "../db/labTestsRepo.js"
import { insertOrder, insertOrderItem } from "../db/ordersRepo.js"
import type { Db } from "../ports/db.js"
import type { PaymentsClient } from "../ports/paymentsClient.js"

export type CheckoutCustomer = { userId: string; name: string | null; email: string | null }

/** The app's own internal, fictitious URLs a hosted checkout page redirects back to. */
export const APP_ORIGIN = "https://cove.internal"
export const CHECKOUT_SUCCESS_URL = `${APP_ORIGIN}/checkout/success`
export const CHECKOUT_CANCEL_URL = `${APP_ORIGIN}/checkout/cancel`

export class NoTestsSelectedError extends Error {}

export const createCheckout = async (
  db: Db,
  payments: PaymentsClient,
  customer: CheckoutCustomer,
  testIds: string[],
): Promise<{ orderId: string; checkoutSessionId: string; hostedPageUrl: string }> => {
  const tests = await findLabTestsByIds(db, testIds)
  if (tests.length === 0) throw new NoTestsSelectedError("Select at least one test")

  const [firstName, ...rest] = (customer.name ?? "Cove Patient").split(" ")

  const session = await payments.createCheckoutSession({
    successUrl: CHECKOUT_SUCCESS_URL,
    cancelUrl: CHECKOUT_CANCEL_URL,
    metadata: {
      userId: customer.userId,
      patientFirstName: firstName ?? "Cove",
      patientLastName: rest.join(" ") || "Patient",
      patientEmail: customer.email ?? "patient@example.test",
    },
    lineItems: tests.map((test) => ({
      name: test.name,
      unitAmountCents: test.price_cents,
      quantity: 1,
    })),
  })

  const orderId = crypto.randomUUID()
  await insertOrder(db, {
    id: orderId,
    userId: customer.userId,
    status: "pending_payment",
    checkoutSessionId: session.id,
  })
  for (const test of tests) {
    await insertOrderItem(db, {
      id: crypto.randomUUID(),
      orderId,
      labTestId: test.id,
      priceCents: test.price_cents,
    })
  }

  return { orderId, checkoutSessionId: session.id, hostedPageUrl: session.hostedPageUrl }
}
