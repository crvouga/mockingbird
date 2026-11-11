import { listLabTests } from "../app/db/labTestsRepo.js"
import { appendOrderEvent, insertOrder, insertOrderItem } from "../app/db/ordersRepo.js"
import { upsertUserFromIdentity } from "../app/db/usersRepo.js"
import type { Role } from "../app/model.js"
import { sampleResults } from "../app/orders/sampleResults.js"
import type { Db } from "../app/ports/db.js"

/** Explicit fictional workspace fixtures, identical in browser and server mode. */
export const DEMO_ACCOUNTS = [
  {
    id: "ada",
    name: "Ada Lovelace",
    email: "ada@example.test",
    role: "patient",
    phone: "+14155550100",
  },
  {
    id: "clinician",
    name: "Morgan Chen",
    email: "clinician@example.test",
    role: "clinician",
    phone: "+14155550101",
  },
  {
    id: "admin",
    name: "Alex Morgan",
    email: "admin@example.test",
    role: "admin",
    phone: "+14155550102",
  },
] satisfies { id: string; name: string; email: string; role: Role; phone: string }[]

export const seedWorkspace = async (db: Db): Promise<void> => {
  for (const account of DEMO_ACCOUNTS) {
    const { user } = await upsertUserFromIdentity(db, {
      provider: "google",
      subject: account.id,
      name: account.name,
      email: account.email,
      picture: null,
    })
    // Seeded members already verified a (fictional, 555) number; new accounts start without one.
    await db.query("UPDATE users SET role = $2, phone = $3 WHERE id = $1", [
      user.id,
      account.role,
      account.phone,
    ])
    if (account.role !== "patient") continue
    const tests = await listLabTests(db)
    for (const [index, daysAgo] of [65, 5].entries()) {
      const selected = tests.filter((test) =>
        ["Basic Metabolic Panel", "Lipid Panel"].includes(test.name),
      )
      // Historical fixtures should not create unpaid sessions in the live payment mock.
      const orderId = crypto.randomUUID()
      await insertOrder(db, {
        id: orderId,
        userId: user.id,
        status: "pending_payment",
        checkoutSessionId: `demo-history-${orderId}`,
      })
      for (const test of selected)
        await insertOrderItem(db, {
          id: crypto.randomUUID(),
          orderId,
          labTestId: test.id,
          priceCents: test.price_cents,
        })
      const created = new Date(Date.now() - daysAgo * 86400000).toISOString()
      const results = sampleResults(selected.map((test) => test.name))
      if (index === 0)
        for (const panel of results)
          for (const marker of panel.markers) marker.value = marker.previous
      await db.query(
        "UPDATE orders SET status = $2, lab_order_id = $3, interpretation = $4, results_json = $5, created_at = $6 WHERE id = $1",
        [
          orderId,
          "results_ready",
          `demo-lab-${index}`,
          "out_of_range",
          JSON.stringify(results),
          created,
        ],
      )
      await db.query("UPDATE order_events SET created_at = $2 WHERE order_id = $1", [
        orderId,
        created,
      ])
      for (const [step, status, detail] of [
        [1, "fulfilled", "Payment confirmed. Collection kit requested."],
        [2, "shipped", "Collection kit shipped. USPS tracking 9400 1000 0000 0000 0000."],
        [3, "processing", "Sample received. Laboratory processing started."],
        [4, "results_ready", "Report available. Awaiting clinical review."],
      ] as const) {
        await appendOrderEvent(db, orderId, status, detail, "Laboratory")
        await db.query(
          "UPDATE order_events SET created_at = $3 WHERE order_id = $1 AND status = $2",
          [orderId, status, new Date(Date.parse(created) + step * 3600000).toISOString()],
        )
      }
      if (index === 0) {
        const reviewed = new Date(Date.parse(created) + 5 * 3600000).toISOString()
        const note =
          "Reviewed the demonstration report. Follow-up has been recorded in the care plan."
        await db.query(
          "UPDATE orders SET reviewed_at = $2, review_note = $3, reviewer = $4 WHERE id = $1",
          [orderId, reviewed, note, "Morgan Chen"],
        )
        await appendOrderEvent(db, orderId, "reviewed", note, "Morgan Chen")
        await db.query(
          "UPDATE order_events SET created_at = $3 WHERE order_id = $1 AND status = $2",
          [orderId, "reviewed", reviewed],
        )
      }
    }
  }
}
