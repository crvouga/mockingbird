import { listLabTests } from "../db/labTestsRepo.js"
import { listOrderItems, type OrderRow } from "../db/ordersRepo.js"
import { findUserById, type UserRow } from "../db/usersRepo.js"
import type { Db } from "../ports/db.js"
import type { Notifier, OutboundEmail } from "../ports/notifier.js"

/**
 * The one phone number on file for every patient. There is no intake form in
 * this example, so lab orders and text messages share this fictional number.
 */
export const PATIENT_PHONE = "+14155550100"

const BRAND = "Cove"
const BRAND_COLOR = "#5b4fe0"

/**
 * The registration token of the patient's (fictional) phone: `ios-…` for Apple
 * sign-ins, `android-…` for Google ones. A real app gets this from the push
 * SDK on the device and stores it per user.
 */
export const deviceTokenFor = (user: Pick<UserRow, "id" | "provider">): string =>
  `${user.provider === "apple" ? "ios" : "android"}-${user.id.replaceAll("-", "").slice(0, 12)}`

/** A short, human order reference: `#1A2B3C4D`. */
export const orderRef = (orderId: string): string =>
  `#${orderId.replaceAll("-", "").slice(0, 8).toUpperCase()}`

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const firstName = (user: UserRow): string => user.name?.split(" ")[0] || "there"

/** One branded layout for every email: header, body paragraphs, an optional table, a footer. */
const emailLayout = (input: {
  heading: string
  intro: string[]
  table?: { rows: [string, string][]; total?: [string, string] }
  cta?: string
  outro?: string[]
}): string => {
  const paragraphs = (lines: string[]) =>
    lines
      .map(
        (line) =>
          `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f1f24">${escapeHtml(line)}</p>`,
      )
      .join("")
  const table = input.table
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 20px">${input.table.rows
        .map(
          ([label, value]) =>
            `<tr><td style="padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;color:#1f1f24">${escapeHtml(label)}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #ececf0;font-size:14px;color:#1f1f24;white-space:nowrap">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}${
        input.table.total
          ? `<tr><td style="padding:12px 0 0;font-size:15px;font-weight:700;color:#1f1f24">${escapeHtml(input.table.total[0])}</td><td align="right" style="padding:12px 0 0;font-size:15px;font-weight:700;color:#1f1f24">${escapeHtml(input.table.total[1])}</td></tr>`
          : ""
      }</table>`
    : ""
  const cta = input.cta
    ? `<p style="margin:4px 0 22px"><span style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;border-radius:8px;padding:11px 18px;font-size:14px;font-weight:600">${escapeHtml(input.cta)}</span></p>`
    : ""
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7e7ec"><tr><td style="background:${BRAND_COLOR};padding:18px 28px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.2px">${BRAND} <span style="font-weight:400;opacity:.85">Lab testing</span></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#111114">${escapeHtml(input.heading)}</h1>${paragraphs(input.intro)}${table}${cta}${paragraphs(input.outro ?? [])}</td></tr><tr><td style="padding:16px 28px;background:#fafafc;border-top:1px solid #ececf0;font-size:12px;line-height:1.5;color:#6b6b76">You are receiving this because order updates are on in your ${BRAND} account settings. Fictional demonstration data, not for clinical use.</td></tr></table></td></tr></table></body></html>`
}

const emailText = (lines: (string | undefined)[]): string =>
  `${lines.filter((line) => line !== undefined).join("\n")}\n\n— ${BRAND} Lab testing\nYou are receiving this because order updates are on in your account settings.\nFictional demonstration data, not for clinical use.\n`

type Recipient = { user: UserRow; email: string | null; phone: string; deviceToken: string }

/** The patient behind an order, or null when they turned order updates off. */
const recipientFor = async (db: Db, order: OrderRow): Promise<Recipient | null> => {
  const user = await findUserById(db, order.user_id)
  if (!user?.notifications) return null
  return { user, email: user.email, phone: PATIENT_PHONE, deviceToken: deviceTokenFor(user) }
}

/**
 * Sends every message and never throws: a provider outage must not fail the
 * payment or lab webhook that triggered it (the provider would retry the
 * webhook and the app would act twice).
 */
const deliver = async (label: string, sends: (Promise<void> | null)[]): Promise<void> => {
  const results = await Promise.allSettled(sends.filter(Boolean))
  for (const result of results)
    if (result.status === "rejected")
      console.warn(
        `[notifications] ${label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      )
}

const guarded = async (label: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run()
  } catch (error) {
    console.warn(
      `[notifications] ${label}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const email = (notifier: Notifier, to: string | null, message: Omit<OutboundEmail, "to">) =>
  to ? notifier.sendEmail({ to, ...message }) : null

/** After the payments webhook placed the lab order: an itemized receipt by email, plus a text. */
export const notifyPaymentReceived = (db: Db, notifier: Notifier, order: OrderRow) =>
  guarded("payment received", async () => {
    const to = await recipientFor(db, order)
    if (!to) return
    const tests = new Map((await listLabTests(db)).map((test) => [test.id, test.name]))
    const rows = await listOrderItems(db, order.id)
    const items = rows.map((item): [string, string] => [
      tests.get(item.lab_test_id) ?? "Lab test",
      money(item.price_cents),
    ])
    const total = money(rows.reduce((sum, item) => sum + item.price_cents, 0))
    const ref = orderRef(order.id)
    await deliver("payment received", [
      email(notifier, to.email, {
        subject: `Your ${BRAND} receipt for order ${ref}`,
        html: emailLayout({
          heading: `Thanks, ${firstName(to.user)}. Your payment went through.`,
          intro: [
            `We received your payment for order ${ref}. Your collection kit is on its way, and we will text you when the lab receives your sample.`,
          ],
          table: { rows: items, total: ["Total paid", total] },
          cta: "View order in Cove",
          outro: ["Demonstration payment. No real card was charged."],
        }),
        text: emailText([
          `Thanks, ${firstName(to.user)}. Your payment went through.`,
          "",
          `Order ${ref}`,
          ...items.map(([name, price]) => `  ${name}  ${price}`),
          `  Total paid  ${total}`,
          "",
          "Your collection kit is on its way. We will text you when the lab receives your sample.",
          "Demonstration payment. No real card was charged.",
        ]),
      }),
      notifier.sendSms({
        to: to.phone,
        body: `${BRAND}: payment received for order ${ref} (${total}). Your collection kit is on its way. Reply STOP to opt out.`,
      }),
    ])
  })

/** The lab received the sample: a push to the patient's phone. */
export const notifySampleProcessing = (db: Db, notifier: Notifier, order: OrderRow) =>
  guarded("sample processing", async () => {
    const to = await recipientFor(db, order)
    if (!to) return
    await deliver("sample processing", [
      notifier.sendPush({
        deviceToken: to.deviceToken,
        title: "Sample received",
        body: `The lab started processing your sample for order ${orderRef(order.id)}.`,
        data: { orderId: order.id, status: "processing" },
      }),
    ])
  })

/** Results are in: email, text and push. */
export const notifyResultsReady = (db: Db, notifier: Notifier, order: OrderRow) =>
  guarded("results ready", async () => {
    const to = await recipientFor(db, order)
    if (!to) return
    const ref = orderRef(order.id)
    await deliver("results ready", [
      email(notifier, to.email, {
        subject: `Your results are ready (order ${ref})`,
        html: emailLayout({
          heading: "Your lab results are ready",
          intro: [
            `Hi ${firstName(to.user)}, the report for order ${ref} is now in your ${BRAND} workspace.`,
            "A clinician will review it and add a note. You can open the report and download it at any time.",
          ],
          cta: "Open your report",
          outro: ["For your privacy, results are never sent by email. Sign in to view them."],
        }),
        text: emailText([
          `Hi ${firstName(to.user)}, the report for order ${ref} is now in your ${BRAND} workspace.`,
          "A clinician will review it and add a note. Sign in to view and download it.",
          "For your privacy, results are never sent by email.",
        ]),
      }),
      notifier.sendSms({
        to: to.phone,
        body: `${BRAND}: your lab results for order ${ref} are ready. Sign in to view your report.`,
      }),
      notifier.sendPush({
        deviceToken: to.deviceToken,
        title: "Your results are ready",
        body: `The report for order ${ref} is ready to view.`,
        data: { orderId: order.id, status: "results_ready" },
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
    const to = await recipientFor(db, order)
    if (!to) return
    const ref = orderRef(order.id)
    await deliver("review recorded", [
      email(notifier, to.email, {
        subject: `A clinician reviewed your results (order ${ref})`,
        html: emailLayout({
          heading: "Your results have been reviewed",
          intro: [
            `Hi ${firstName(to.user)}, ${reviewer} reviewed the report for order ${ref} and left you a note.`,
            "Sign in to read the note alongside your results.",
          ],
          cta: "Read the clinician's note",
        }),
        text: emailText([
          `Hi ${firstName(to.user)}, ${reviewer} reviewed the report for order ${ref} and left you a note.`,
          "Sign in to read the note alongside your results.",
        ]),
      }),
      notifier.sendPush({
        deviceToken: to.deviceToken,
        title: "Clinician note added",
        body: `${reviewer} reviewed your results for order ${ref}.`,
        data: { orderId: order.id, status: "reviewed" },
      }),
    ])
  })
