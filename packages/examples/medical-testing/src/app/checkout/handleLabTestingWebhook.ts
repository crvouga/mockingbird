import { findOrderByLabOrderId, updateOrderStatus } from "../db/ordersRepo.js"
import type { Db } from "../ports/db.js"
import type { LabTestingClient } from "../ports/labTestingClient.js"

/** A lab-testing provider webhook reporting the order moved forward (e.g. results are ready). */
export const handleLabTestingWebhook = async (
  db: Db,
  labTesting: LabTestingClient,
  payload: string,
): Promise<void> => {
  const event = labTesting.parseWebhookEvent(payload)
  if (event.type !== "order.status_updated") return

  const order = await findOrderByLabOrderId(db, event.labOrderId)
  if (!order) return

  await updateOrderStatus(db, order.id, event.status, event.interpretation)
}
