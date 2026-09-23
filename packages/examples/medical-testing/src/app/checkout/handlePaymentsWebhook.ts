import { listLabTests } from "../db/labTestsRepo.js"
import {
  findOrderByCheckoutSessionId,
  listOrderItems,
  markOrderFulfilled,
} from "../db/ordersRepo.js"
import type { Db } from "../ports/db.js"
import type { LabTestingClient } from "../ports/labTestingClient.js"
import type { PaymentsClient } from "../ports/paymentsClient.js"

/**
 * A payments webhook confirming payment — verify it, then place the real
 * (mocked) lab order. This is the realistic pattern for any hosted-checkout
 * integration: the browser redirect back to `successUrl` and the webhook
 * confirming payment arrive independently and in no guaranteed order.
 */
export const handlePaymentsWebhook = async (
  db: Db,
  payments: PaymentsClient,
  labTesting: LabTestingClient,
  payload: string,
  signatureHeader: string | null,
): Promise<void> => {
  const event = await payments.constructWebhookEvent(payload, signatureHeader)
  if (event.type !== "checkout.completed") return

  const order = await findOrderByCheckoutSessionId(db, event.checkoutSessionId)
  if (!order) return
  if (order.lab_order_id) return // already fulfilled — webhooks can be delivered more than once

  const items = await listOrderItems(db, order.id)
  const labTests = await listLabTests(db)
  const testsById = new Map(labTests.map((test) => [test.id, test]))
  const catalogTestIds = items
    .map((item) => testsById.get(item.lab_test_id)?.catalog_test_id)
    .filter((id): id is string => Boolean(id))

  const { labOrderId } = await labTesting.createOrder({
    patientUserId: event.metadata.userId ?? order.user_id,
    patient: {
      firstName: event.metadata.patientFirstName ?? "Cove",
      lastName: event.metadata.patientLastName ?? "Patient",
      email: event.metadata.patientEmail ?? "patient@example.test",
    },
    catalogTestIds,
  })

  await markOrderFulfilled(db, order.id, labOrderId)
}
