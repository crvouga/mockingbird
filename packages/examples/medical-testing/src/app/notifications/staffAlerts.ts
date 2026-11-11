import { listLabTests } from "../db/labTestsRepo.js"
import { listOrderItems, type OrderRow } from "../db/ordersRepo.js"
import { findUserById } from "../db/usersRepo.js"
import type { Db } from "../ports/db.js"
import type { Notifier } from "../ports/notifier.js"
import { guarded } from "./audience.js"
import { money, orderRef } from "./emailLayout.js"

/** The staff channels the app posts to. */
export const STAFF_CHANNELS = {
  orders: "#lab-orders",
  review: "#clinical-review",
  billing: "#billing-alerts",
} as const

const summary = async (db: Db, order: OrderRow) => {
  const tests = new Map((await listLabTests(db)).map((test) => [test.id, test.name]))
  const rows = await listOrderItems(db, order.id)
  const patient = await findUserById(db, order.user_id)
  return {
    ref: orderRef(order.id),
    patient: patient?.name ?? "A patient",
    tests: rows.map((item) => tests.get(item.lab_test_id) ?? "Lab test").join(", "),
    total: money(rows.reduce((sum, item) => sum + item.price_cents, 0)),
  }
}

const field = (label: string, value: string) => ({ type: "mrkdwn", text: `*${label}*\n${value}` })

/** A paid order entered fulfilment: one line in `#lab-orders`. */
export const alertOrderPaid = (db: Db, notifier: Notifier, order: OrderRow) =>
  guarded("staff alert: order paid", async () => {
    const { ref, patient, tests, total } = await summary(db, order)
    await notifier.sendChat({
      channel: STAFF_CHANNELS.orders,
      text: `:package: New paid order *${ref}* from ${patient}: ${tests} (${total}). Collection kit requested.`,
    })
  })

/** A report is waiting for a clinician: a Block Kit card in `#clinical-review`. */
export const alertResultsAwaitingReview = (
  db: Db,
  notifier: Notifier,
  order: OrderRow,
  interpretation: string | null,
) =>
  guarded("staff alert: results awaiting review", async () => {
    const { ref, patient, tests } = await summary(db, order)
    const flagged = interpretation === "out_of_range"
    await notifier.sendChat({
      channel: STAFF_CHANNELS.review,
      text: `Results for order ${ref} (${patient}) are awaiting clinical review.`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Results awaiting review", emoji: true },
        },
        {
          type: "section",
          fields: [
            field("Order", ref),
            field("Patient", patient),
            field("Panels", tests),
            field(
              "Lab summary",
              flagged ? ":warning: Out-of-range markers" : ":white_check_mark: Within range",
            ),
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "The patient has been told a report is ready. They see your note once you record a review.",
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "open_review",
              style: "primary",
              text: { type: "plain_text", text: "Open review queue", emoji: true },
              value: order.id,
            },
          ],
        },
      ],
    })
  })

/** A card was declined at checkout: one line in `#billing-alerts`. */
export const alertPaymentFailed = (db: Db, notifier: Notifier, order: OrderRow, reason: string) =>
  guarded("staff alert: payment failed", async () => {
    const { ref, patient, total } = await summary(db, order)
    await notifier.sendChat({
      channel: STAFF_CHANNELS.billing,
      text: `:credit_card: Payment of ${total} failed for order *${ref}* (${patient}). _${reason}_ The patient was emailed a retry link.`,
    })
  })
