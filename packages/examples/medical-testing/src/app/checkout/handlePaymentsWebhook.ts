import { listLabTests } from "../db/labTestsRepo.js"
import {
  appendOrderEvent,
  findOrderByCheckoutSessionId,
  listOrderItems,
  markOrderFulfilled,
  type OrderRow,
} from "../db/ordersRepo.js"
import { findUserById } from "../db/usersRepo.js"
import {
  notifyPaymentFailed,
  notifyPaymentReceived,
} from "../notifications/patientNotifications.js"
import { alertOrderPaid, alertPaymentFailed } from "../notifications/staffAlerts.js"
import type { Db } from "../ports/db.js"
import type { LabTestingClient } from "../ports/labTestingClient.js"
import type { Notifier } from "../ports/notifier.js"
import type { PaymentsClient } from "../ports/paymentsClient.js"

/**
 * The contact number on a lab order when the patient has not verified one of
 * their own in Account. A fictional number: the lab requires the field.
 */
export const LAB_CONTACT_FALLBACK_PHONE = "+14155550199"

/**
 * A payments webhook. On a confirmed payment: place the real (mocked) lab
 * order, then tell the patient and the fulfilment team. On a declined card:
 * record it, email the patient a way back and alert billing. This is the
 * realistic pattern for any hosted-checkout integration: the browser redirect
 * back to `successUrl` and the webhook arrive independently and in no
 * guaranteed order.
 */
export const handlePaymentsWebhook = async (
  db: Db,
  payments: PaymentsClient,
  labTesting: LabTestingClient,
  notifier: Notifier,
  payload: string,
  signatureHeader: string | null,
): Promise<void> => {
  const event = await payments.constructWebhookEvent(payload, signatureHeader)
  if (event.type === "unhandled") return

  const order = await findOrderByCheckoutSessionId(db, event.checkoutSessionId)
  if (!order) return
  if (event.type === "payment.failed") return paymentFailed(db, notifier, order, event.reason)
  if (order.lab_order_id) return // already fulfilled — webhooks can be delivered more than once

  const items = await listOrderItems(db, order.id)
  const labTests = await listLabTests(db)
  const testsById = new Map(labTests.map((test) => [test.id, test]))
  const catalogTestIds = items
    .map((item) => testsById.get(item.lab_test_id)?.catalog_test_id)
    .filter((id): id is string => Boolean(id))
  const patient = await findUserById(db, order.user_id)

  const { labOrderId } = await labTesting.createOrder({
    patientUserId: event.metadata.userId ?? order.user_id,
    patient: {
      firstName: event.metadata.patientFirstName ?? "Patient",
      lastName: event.metadata.patientLastName ?? "Patient",
      email: event.metadata.patientEmail ?? "patient@example.test",
      phone: patient?.phone ?? LAB_CONTACT_FALLBACK_PHONE,
    },
    catalogTestIds,
  })

  await markOrderFulfilled(db, order.id, labOrderId)
  await Promise.all([
    notifyPaymentReceived(db, notifier, order),
    alertOrderPaid(db, notifier, order),
  ])
}

const paymentFailed = async (
  db: Db,
  notifier: Notifier,
  order: OrderRow,
  reason: string,
): Promise<void> => {
  // A late or repeated failure for an order that has since been paid changes nothing.
  if (order.status !== "pending_payment") return
  await appendOrderEvent(db, order.id, "payment_failed", reason, "Payments")
  await Promise.all([
    notifyPaymentFailed(db, notifier, order, reason),
    alertPaymentFailed(db, notifier, order, reason),
  ])
}
