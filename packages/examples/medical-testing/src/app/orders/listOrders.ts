import { listLabTests } from "../db/labTestsRepo.js"
import { listOrderItems, listOrdersByUser } from "../db/ordersRepo.js"
import type { Db } from "../ports/db.js"

export type OrderSummary = {
  id: string
  status: string
  createdAt: string
  items: { testName: string; priceCents: number }[]
  labOrderId: string | null
  interpretation: string | null
}

/** Reads the order timeline straight from our own persisted state — every status change
 * arrived earlier via a webhook (see checkout/handle*Webhook.ts), so there's nothing
 * left to fetch live from a provider here. */
export const listOrders = async (db: Db, userId: string): Promise<OrderSummary[]> => {
  const labTests = await listLabTests(db)
  const testsById = new Map(labTests.map((test) => [test.id, test]))
  const orders = await listOrdersByUser(db, userId)

  return Promise.all(
    orders.map(async (order) => {
      const items = await listOrderItems(db, order.id)
      return {
        id: order.id,
        status: order.status,
        createdAt: order.created_at,
        items: items.map((item) => ({
          testName: testsById.get(item.lab_test_id)?.name ?? "Unknown test",
          priceCents: item.price_cents,
        })),
        labOrderId: order.lab_order_id,
        interpretation: order.interpretation,
      }
    }),
  )
}
