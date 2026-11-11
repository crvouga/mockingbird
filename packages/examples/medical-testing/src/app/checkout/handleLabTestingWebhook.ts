import { listLabTests } from "../db/labTestsRepo.js"
import {
  appendOrderEvent,
  findOrderByLabOrderId,
  listOrderItems,
  updateOrderStatus,
} from "../db/ordersRepo.js"
import {
  notifyKitShipped,
  notifyResultsReady,
  notifySampleProcessing,
} from "../notifications/patientNotifications.js"
import { alertResultsAwaitingReview } from "../notifications/staffAlerts.js"
import { sampleResults } from "../orders/sampleResults.js"
import type { Db } from "../ports/db.js"
import { LAB_ORDER_STATUSES, type LabTestingClient } from "../ports/labTestingClient.js"
import type { Notifier } from "../ports/notifier.js"

/** How far along an order is. Webhooks can arrive late or twice; an order only moves forward. */
const progress = (status: string): number =>
  (LAB_ORDER_STATUSES as readonly string[]).indexOf(status)

/** A lab-testing provider webhook reporting the order moved forward (e.g. results are ready). */
export const handleLabTestingWebhook = async (
  db: Db,
  labTesting: LabTestingClient,
  notifier: Notifier,
  payload: string,
): Promise<void> => {
  const event = labTesting.parseWebhookEvent(payload)
  if (event.type !== "order.status_updated") return

  const order = await findOrderByLabOrderId(db, event.labOrderId)
  if (!order || order.status === "cancelled" || progress(event.status) <= progress(order.status))
    return

  let interpretation = event.interpretation
  if (event.status === "results_ready") {
    const tests = new Map((await listLabTests(db)).map((test) => [test.id, test.name]))
    const items = await listOrderItems(db, order.id)
    const results = sampleResults(
      items.map((item) => tests.get(item.lab_test_id) ?? "Unknown test"),
    )
    interpretation = results.some((panel) =>
      panel.markers.some((marker) => marker.flag !== "normal"),
    )
      ? "out_of_range"
      : "normal"
    await db.query("UPDATE orders SET results_json = $2 WHERE id = $1", [
      order.id,
      JSON.stringify(results),
    ])
  }
  await updateOrderStatus(db, order.id, event.status, interpretation)
  const tracking = event.tracking ?? null
  await appendOrderEvent(
    db,
    order.id,
    event.status,
    event.status === "results_ready"
      ? "Report available. Awaiting clinical review."
      : event.status === "processing"
        ? "Sample received. Laboratory processing started."
        : `Collection kit shipped.${tracking ? ` ${tracking.carrier} tracking ${tracking.number}.` : ""}`,
    "Laboratory",
  )
  if (event.status === "results_ready")
    await Promise.all([
      notifyResultsReady(db, notifier, order),
      alertResultsAwaitingReview(db, notifier, order, interpretation),
    ])
  else if (event.status === "processing") await notifySampleProcessing(db, notifier, order)
  else await notifyKitShipped(db, notifier, order, tracking)
}
