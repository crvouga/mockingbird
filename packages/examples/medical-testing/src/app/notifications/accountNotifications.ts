import type { UserRow } from "../db/usersRepo.js"
import type { TestNotification } from "../model.js"
import type { Db } from "../ports/db.js"
import type { Notifier } from "../ports/notifier.js"
import { audienceFor, deliver, firstName, guarded, toDevices, toEmail, toText } from "./audience.js"
import { BRAND, email } from "./emailLayout.js"
import { STAFF_CHANNELS } from "./staffAlerts.js"

/**
 * The passwordless sign-in email: a six-digit code and a one-click link that
 * do the same thing. Not guarded, unlike order updates: if the provider
 * refuses this email the member cannot sign in, so the request must fail.
 */
export const sendSignInCode = (
  notifier: Notifier,
  input: { email: string; code: string; link: string; expiresInMinutes: number },
): Promise<void> =>
  notifier.sendEmail({
    to: input.email,
    ...email(`${input.code} is your ${BRAND} sign-in code`, {
      preheader: `It expires in ${input.expiresInMinutes} minutes.`,
      heading: `Sign in to ${BRAND}`,
      intro: ["Enter this code on the sign-in screen to continue:"],
      code: input.code,
      cta: { label: `Sign in to ${BRAND}`, url: input.link },
      outro: [
        `The code and the button both expire in ${input.expiresInMinutes} minutes and work once.`,
        `If you did not ask to sign in, you can ignore this email. ${BRAND} will never ask you to share this code.`,
      ],
      reason: "security",
    }),
  })

/** A first sign-in created the account. */
export const notifyWelcome = (notifier: Notifier, user: UserRow) =>
  guarded("welcome", async () => {
    if (!user.email) return
    await notifier.sendEmail({
      to: user.email,
      ...email(`Welcome to ${BRAND}, ${firstName(user)}`, {
        preheader: "Your testing workspace is ready.",
        heading: `Welcome to ${BRAND}, ${firstName(user)}`,
        intro: [
          "Your testing workspace is ready. Here is how it works:",
          "1. Choose individual tests or panels, with clear, itemized pricing.",
          "2. We ship a collection kit and keep you posted by email, text and push.",
          "3. Read your results next to their reference ranges, with a clinician's note.",
        ],
        cta: { label: "Browse the test catalog" },
        outro: [
          "Add a phone number in Account to get order updates by SMS or WhatsApp, and choose which channels you want there.",
        ],
        reason: "account",
      }),
    })
  })

const METHODS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  code: "an emailed code",
  link: "an emailed link",
}

/** A security alert on every later sign-in. It ignores preferences, like every security message. */
export const notifyNewSignIn = (notifier: Notifier, user: UserRow, method: string) =>
  guarded("new sign-in", async () => {
    if (!user.email) return
    const when = `${new Date().toUTCString().slice(5, 22)} UTC`
    await notifier.sendEmail({
      to: user.email,
      ...email(`New sign-in to your ${BRAND} account`, {
        preheader: `Signed in with ${METHODS[method] ?? method}.`,
        heading: "New sign-in to your account",
        intro: [
          `Hi ${firstName(user)}, your ${BRAND} account was just signed in to. If this was you, there is nothing to do.`,
        ],
        facts: [
          ["Signed in with", METHODS[method] ?? method],
          ["When", when],
          ["Account", user.email],
        ],
        outro: [
          "If this was not you, sign out of every session from Account and contact your care team.",
        ],
        reason: "security",
      }),
    })
  })

/** A phone number was verified and now receives texts. */
export const notifyPhoneVerified = (notifier: Notifier, user: UserRow) =>
  guarded("phone verified", async () => {
    if (!user.phone) return
    await notifier.sendSms({
      to: user.phone,
      channel: user.phone_channel,
      body: `${BRAND}: this number is verified. Order updates will arrive here. Reply STOP to opt out.`,
    })
  })

export type TestTarget = { channel: "email" | "sms" | "push" | "chat"; to: string }
export class TestNotificationUnavailable extends Error {}

/**
 * "Send a test" in Account: one sample message on the chosen channel, sent
 * whatever the member's preferences (they asked for it). Returns where it
 * went, so the client can point at it.
 */
export const sendTestNotification = async (
  db: Db,
  notifier: Notifier,
  user: UserRow,
  kind: TestNotification,
): Promise<TestTarget> => {
  const to = await audienceFor(db, user, { everything: true })
  if (kind === "email") {
    if (!to.email) throw new TestNotificationUnavailable("Your account has no email address.")
    await toEmail(
      notifier,
      to,
      email(`A test email from ${BRAND}`, {
        heading: "Email is working",
        intro: [
          `Hi ${firstName(user)}, this is the test email you asked for from Account settings.`,
          "Order confirmations, receipts and result notices arrive at this address.",
        ],
        cta: { label: "Open notification settings" },
        reason: "account",
      }),
    )
    return { channel: "email", to: to.email }
  }
  if (kind === "text") {
    if (!to.text)
      throw new TestNotificationUnavailable("Verify a phone number first to receive texts.")
    await toText(
      notifier,
      to,
      `${BRAND}: this is the test message you asked for. Texts are working.`,
    )
    return { channel: "sms", to: to.text.to }
  }
  if (kind === "push") {
    await deliver(
      "test push",
      toDevices(notifier, to, {
        title: "Push is working",
        body: `This is the test notification you asked for, ${firstName(user)}.`,
        data: { type: "test", deepLink: "cove://account/notifications" },
      }),
    )
    return { channel: "push", to: to.devices[0] ?? "" }
  }
  await notifier.sendChat({
    channel: STAFF_CHANNELS.orders,
    text: `:wave: ${user.name ?? "A team member"} sent a test alert from Account settings. Staff alerts are working.`,
  })
  return { channel: "chat", to: STAFF_CHANNELS.orders }
}
