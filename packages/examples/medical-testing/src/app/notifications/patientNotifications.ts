import { listLabTests } from "../db/labTestsRepo.js"
import { listOrderItems, type OrderRow } from "../db/ordersRepo.js"
import { findUserById } from "../db/usersRepo.js"
import type { Db } from "../ports/db.js"
import type { Notifier } from "../ports/notifier.js"
import {
  type Audience,
  audienceFor,
  deliver,
  firstName,
  guarded,
  toDevices,
  toEmail,
  toText,
} from "./audience.js"
import { BRAND, email, money, orderRef } from "./emailLayout.js"

export { orderRef }

/**
 * Order updates for the patient who placed the order. Each respects the
 * channels they left on in Account: email, text (SMS or WhatsApp to their
 * verified number) and push.
 */
const patientFor = async (db: Db, order: OrderRow): Promise<Audience | null> => {
  const user = await findUserById(db, order.user_id)
  return user ? audienceFor(db, user) : null
}

/** What the mobile app needs to open the order: every push carries it. */
const pushData = (order: OrderRow, type: string): Record<string, string> => ({
  type,
  orderId: order.id,
  orderRef: orderRef(order.id),
  deepLink: `cove://orders/${order.id}`,
})

const lineItems = async (db: Db, order: OrderRow) => {
  const tests = new Map((await listLabTests(db)).map((test) => [test.id, test.name]))
  const rows = await listOrderItems(db, order.id)
  return {
    items: rows.map((item): [string, string] => [
      tests.get(item.lab_test_id) ?? "Lab test",
      money(item.price_cents),
    ]),
    total: money(rows.reduce((sum, item) => sum + item.price_cents, 0)),
  }
}

/** After the payments webhook placed the lab order: confirmation with an itemized receipt, a text and a push. */
export const notifyPaymentReceived = (db: Db, notifier: Notifier, order: OrderRow) =>
  guarded("payment received", async () => {
    const to = await patientFor(db, order)
    if (!to) return
    const { items, total } = await lineItems(db, order)
    const ref = orderRef(order.id)
    await deliver("payment received", [
      toEmail(
        notifier,
        to,
        email(`Your ${BRAND} receipt for order ${ref}`, {
          preheader: `Order ${ref} is confirmed. Total paid ${total}.`,
          heading: `Thanks, ${firstName(to.user)}. Your order is confirmed.`,
          intro: [
            `We received your payment for order ${ref}. Your collection kit ships next, and we will let you know at every step.`,
          ],
          table: { rows: items, total: ["Total paid", total] },
          facts: [
            ["Order", ref],
            ["Paid", new Date().toUTCString().slice(5, 16)],
            ["Payment", "Card (demonstration)"],
          ],
          cta: { label: `View order in ${BRAND}` },
          outro: ["Demonstration payment. No real card was charged."],
          reason: "orders",
        }),
      ),
      toText(
        notifier,
        to,
        `${BRAND}: payment received for order ${ref} (${total}). Your collection kit ships next. Reply STOP to opt out.`,
      ),
      ...toDevices(notifier, to, {
        title: "Order confirmed",
        body: `We received your payment for order ${ref} (${total}).`,
        data: pushData(order, "order.confirmed"),
      }),
    ])
  })

/** The card was declined on the hosted checkout page: an email with the way back. */
export const notifyPaymentFailed = (db: Db, notifier: Notifier, order: OrderRow, reason: string) =>
  guarded("payment failed", async () => {
    const to = await patientFor(db, order)
    if (!to) return
    const { items, total } = await lineItems(db, order)
    const ref = orderRef(order.id)
    await deliver("payment failed", [
      toEmail(
        notifier,
        to,
        email(`Your payment for order ${ref} did not go through`, {
          preheader: `${reason} Nothing was charged.`,
          heading: "We could not take your payment",
          intro: [
            `Hi ${firstName(to.user)}, your card issuer declined the payment for order ${ref}: ${reason}`,
            "Nothing was charged and your order is saved. Try again with the same card or a different one.",
          ],
          table: { rows: items, total: ["Amount due", total] },
          cta: { label: "Retry payment" },
          outro: ["Demonstration payment. No real card was charged."],
          reason: "orders",
        }),
      ),
    ])
  })

/** The collection kit left the warehouse: email, text and push, with tracking. */
export const notifyKitShipped = (
  db: Db,
  notifier: Notifier,
  order: OrderRow,
  tracking: { carrier: string; number: string } | null,
) =>
  guarded("kit shipped", async () => {
    const to = await patientFor(db, order)
    if (!to) return
    const ref = orderRef(order.id)
    const tracked = tracking ? ` ${tracking.carrier} tracking ${tracking.number}.` : ""
    await deliver("kit shipped", [
      toEmail(
        notifier,
        to,
        email(`Your collection kit is on its way (order ${ref})`, {
          preheader: "It usually arrives in 2 to 3 business days.",
          heading: "Your collection kit has shipped",
          intro: [
            `Hi ${firstName(to.user)}, the kit for order ${ref} left our warehouse and usually arrives in 2 to 3 business days.`,
            "Everything you need is in the box: collection instructions and a prepaid return mailer.",
          ],
          facts: tracking
            ? [
                ["Carrier", tracking.carrier],
                ["Tracking number", tracking.number],
              ]
            : [],
          cta: { label: "Track your kit" },
          reason: "orders",
        }),
      ),
      toText(notifier, to, `${BRAND}: your collection kit for order ${ref} has shipped.${tracked}`),
      ...toDevices(notifier, to, {
        title: "Your kit has shipped",
        body: `The collection kit for order ${ref} is on its way.`,
        data: pushData(order, "order.shipped"),
      }),
    ])
  })

/** The lab received the sample: a text and a push. */
export const notifySampleProcessing = (db: Db, notifier: Notifier, order: OrderRow) =>
  guarded("sample processing", async () => {
    const to = await patientFor(db, order)
    if (!to) return
    const ref = orderRef(order.id)
    await deliver("sample processing", [
      toText(
        notifier,
        to,
        `${BRAND}: the lab received your sample for order ${ref}. Results usually take 1 to 2 days.`,
      ),
      ...toDevices(notifier, to, {
        title: "Sample received",
        body: `The lab started processing your sample for order ${ref}.`,
        data: pushData(order, "order.processing"),
      }),
    ])
  })

/** Results are in: email, text and push. None of them carries a result. */
export const notifyResultsReady = (db: Db, notifier: Notifier, order: OrderRow) =>
  guarded("results ready", async () => {
    const to = await patientFor(db, order)
    if (!to) return
    const ref = orderRef(order.id)
    await deliver("results ready", [
      toEmail(
        notifier,
        to,
        email(`Your results are ready (order ${ref})`, {
          preheader: "Sign in to view your report.",
          heading: "Your lab results are ready",
          intro: [
            `Hi ${firstName(to.user)}, the report for order ${ref} is now in your ${BRAND} workspace.`,
            "A clinician will review it and add a note. You can open the report and download it at any time.",
          ],
          cta: { label: "Open your report" },
          outro: ["For your privacy, results are never sent by email. Sign in to view them."],
          reason: "orders",
        }),
      ),
      toText(
        notifier,
        to,
        `${BRAND}: your lab results for order ${ref} are ready. Sign in to view your report.`,
      ),
      ...toDevices(notifier, to, {
        title: "Your results are ready",
        body: `The report for order ${ref} is ready to view.`,
        data: pushData(order, "order.results_ready"),
      }),
    ])
  })

/** A clinician recorded a review: email and push to the patient. */
export const notifyReviewRecorded = (
  db: Db,
  notifier: Notifier,
  order: OrderRow,
  reviewer: string,
) =>
  guarded("review recorded", async () => {
    const to = await patientFor(db, order)
    if (!to) return
    const ref = orderRef(order.id)
    await deliver("review recorded", [
      toEmail(
        notifier,
        to,
        email(`A clinician reviewed your results (order ${ref})`, {
          preheader: `${reviewer} left you a note.`,
          heading: "Your results have been reviewed",
          intro: [
            `Hi ${firstName(to.user)}, ${reviewer} reviewed the report for order ${ref} and left you a note.`,
            "Sign in to read the note alongside your results.",
          ],
          cta: { label: "Read the clinician's note" },
          reason: "orders",
        }),
      ),
      ...toDevices(notifier, to, {
        title: "Clinician note added",
        body: `${reviewer} reviewed your results for order ${ref}.`,
        data: pushData(order, "order.reviewed"),
      }),
    ])
  })
