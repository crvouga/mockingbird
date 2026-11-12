import type { Meta, StoryObj } from "@storybook/html-vite"
import {
  listOrdersByUser,
  type OrderRow,
} from "../../../../../packages/examples/medical-testing/src/app/db/ordersRepo.js"
import {
  findUserByEmail,
  type UserRow,
} from "../../../../../packages/examples/medical-testing/src/app/db/usersRepo.js"
import {
  notifyNewSignIn,
  notifyWelcome,
  sendSignInCode,
  sendTestNotification,
} from "../../../../../packages/examples/medical-testing/src/app/notifications/accountNotifications.js"
import {
  notifyKitShipped,
  notifyPaymentFailed,
  notifyPaymentReceived,
  notifyResultsReady,
  notifyReviewRecorded,
} from "../../../../../packages/examples/medical-testing/src/app/notifications/patientNotifications.js"
import type { Db } from "../../../../../packages/examples/medical-testing/src/app/ports/db.js"
import type {
  Notifier,
  OutboundEmail,
} from "../../../../../packages/examples/medical-testing/src/app/ports/notifier.js"
import { buildDemo } from "../../../../../packages/examples/medical-testing/src/composition/build.js"
import { markup } from "../../../src/story.js"
import { PATIENT, phone } from "./cove.js"

/**
 * Every email the app sends, each drawn by the app's own sender on the seeded workspace (the demo
 * patient and her latest order) into the one branded layout (`emailLayout.ts`). The Workspace
 * story shows them arriving in the Notifications tab.
 */
export default {
  title: "Examples/Medical testing/Emails",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/examples/medical-testing/src/app/notifications/emailLayout.ts",
      "packages/examples/medical-testing/src/app/notifications/accountNotifications.ts",
      "packages/examples/medical-testing/src/app/notifications/patientNotifications.ts",
    ],
  },
} satisfies Meta

type Context = { db: Db; notifier: Notifier; user: UserRow; order: OrderRow }

/** The HTML of the one email `send` makes the app send. */
const email = (
  send: (context: Context) => Promise<unknown>,
  extra: Parameters<typeof markup>[1] = {},
): StoryObj =>
  markup(async () => {
    const demo = await buildDemo({ html: "", js: "" })
    demo.notifications.close()
    const sent: OutboundEmail[] = []
    const notifier: Notifier = {
      sendEmail: async (message) => {
        sent.push(message)
      },
      sendSms: async () => {},
      sendPush: async () => {},
      sendChat: async () => {},
    }
    const user = await findUserByEmail(demo.db, PATIENT)
    if (!user) throw new Error("the demo patient is missing")
    const [order] = await listOrdersByUser(demo.db, user.id)
    if (!order) throw new Error("the demo patient has no orders")
    await send({ db: demo.db, notifier, user, order })
    const [message] = sent
    if (!message) throw new Error("no email was sent")
    return message.html
  }, extra)

export const SignInCode: StoryObj = email(({ notifier }) =>
  sendSignInCode(notifier, {
    email: PATIENT,
    code: "482913",
    link: "http://localhost:4300/?sign-in=2f9c1d7e.storybook",
    expiresInMinutes: 10,
  }),
)

export const Welcome: StoryObj = email(({ notifier, user }) => notifyWelcome(notifier, user))

export const NewSignIn: StoryObj = email(({ notifier, user }) =>
  notifyNewSignIn(notifier, user, "google"),
)

export const TestEmail: StoryObj = email(({ db, notifier, user }) =>
  sendTestNotification(db, notifier, user, "email"),
)

export const Receipt: StoryObj = email(({ db, notifier, order }) =>
  notifyPaymentReceived(db, notifier, order),
)

export const PaymentFailed: StoryObj = email(({ db, notifier, order }) =>
  notifyPaymentFailed(db, notifier, order, "Your card was declined."),
)

export const KitShipped: StoryObj = email(({ db, notifier, order }) =>
  notifyKitShipped(db, notifier, order, { carrier: "USPS", number: "9400 1000 0000 0000 0000" }),
)

export const ResultsReady: StoryObj = email(({ db, notifier, order }) =>
  notifyResultsReady(db, notifier, order),
)

export const ReviewRecorded: StoryObj = email(({ db, notifier, order }) =>
  notifyReviewRecorded(db, notifier, order, "Morgan Chen"),
)

/** The receipt on a phone: the layout narrows to the screen. */
export const ReceiptOnAPhone: StoryObj = { ...Receipt, globals: phone }
