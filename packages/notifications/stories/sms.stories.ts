import type { Meta, StoryObj } from "@storybook/html-vite"
import type { AppOptions } from "../src/ui/app.js"
import { art, base, PHONE, sms, smsInbox, whatsappInbox } from "./fixtures.js"
import { mount } from "./mount.js"

/** The Messages app: thread list and conversation, for every kind of SMS sender. */
const meta: Meta<AppOptions> = {
  title: "Devices/SMS",
  tags: ["vp-phone"],
  render: (args) => mount(args),
}
export default meta
type Story = StoryObj<AppOptions>

const only = (
  items: ReturnType<typeof smsInbox>,
  extra: AppOptions["initial"] = {},
  rest: AppOptions = {},
) => base(items, { initial: { only: "sms", ...extra }, ...rest })

export const NoMessagesYet: Story = { args: only([]) }

export const ThreadListUnread: Story = { args: only(smsInbox()) }

const inbox = smsInbox()
export const ThreadListAllRead: Story = { args: only(inbox, {}, { seen: inbox.map((n) => n.id) }) }

export const ThreadListOneSender: Story = {
  args: only([
    sms({
      from: "+18885550100",
      body: "Acme: Your order #1042 has been confirmed.",
      minutesAgo: 5,
    }),
  ]),
}

export const ThreadListDates: Story = {
  args: only([
    sms({ from: "+15550000001", body: "Sent today", minutesAgo: 30 }),
    sms({ from: "+15550000002", body: "Sent yesterday", minutesAgo: 60 * 24 }),
    sms({ from: "+15550000003", body: "Sent three days ago", minutesAgo: 60 * 24 * 3 }),
    sms({ from: "+15550000004", body: "Sent last month", minutesAgo: 60 * 24 * 35 }),
    sms({ from: "+15550000005", body: "Sent last year", minutesAgo: 60 * 24 * 400 }),
  ]),
}

export const ThreadListScrolls: Story = {
  args: only(
    Array.from({ length: 14 }, (_, i) =>
      sms({
        from: `+1415555${String(100 + i).padStart(4, "0")}`,
        body: `Reminder ${i + 1}: your appointment is coming up. Reply C to confirm or R to reschedule.`,
        minutesAgo: i * 37,
      }),
    ),
  ),
}

const verify = sms({
  from: "Verify",
  fromName: "Verify",
  body: "Your verification code is: 401942",
  code: "401942",
})
export const VerifyCodeWithSuggestion: Story = {
  args: only([verify], { sms: { to: PHONE, thread: "Verify" } }),
}

const oldCode = sms({
  from: "Verify",
  fromName: "Verify",
  body: "Your verification code is: 118830",
  code: "118830",
  minutesAgo: 45,
})
export const ExpiredCodeNoSuggestion: Story = {
  args: only([oldCode], { sms: { to: PHONE, thread: "Verify" } }),
}

const order = [
  sms({
    from: "+18885550100",
    body: "Acme: Your order #1042 has been confirmed. Track it at https://acme.example/t/1042",
    minutesAgo: 180,
  }),
  sms({ from: "+18885550100", body: "Acme: Your order #1042 is packed.", minutesAgo: 179.5 }),
  sms({
    from: "+18885550100",
    body: "Acme: Your order #1042 shipped! Arriving Tuesday.",
    minutesAgo: 60,
  }),
  sms({
    from: "+18885550100",
    body: "Acme: Out for delivery today between 2 and 6 PM.",
    minutesAgo: 2,
  }),
]
export const ConversationGroupedAndTimestamps: Story = {
  args: only(order, { sms: { to: PHONE, thread: "+18885550100" } }),
}

export const ConversationNumberCodeWithoutCodeWording: Story = {
  args: only([sms({ from: "+18885550100", body: "Acme: Your order #1042 has been confirmed." })], {
    sms: { to: PHONE, thread: "+18885550100" },
  }),
}

export const ConversationOtpInPlainText: Story = {
  args: only(
    [
      sms({
        from: "+18005550199",
        body: "Your Acme sign-in code is 482913. It expires in 10 minutes. Don't share it.",
        service: "sns",
      }),
    ],
    { sms: { to: PHONE, thread: "+18005550199" } },
  ),
}

export const ConversationAlphanumericSender: Story = {
  args: only(
    [
      sms({
        from: "ACMEBANK",
        fromName: "ACMEBANK",
        body: "AcmeBank: A charge of $142.00 at ACME OUTDOOR was approved on card ending 4242. Reply STOP to opt out.",
        service: "sns",
      }),
    ],
    { sms: { to: PHONE, thread: "ACMEBANK" } },
  ),
}

export const ConversationShortCode: Story = {
  args: only(
    [
      sms({
        from: "22395",
        body: "Flash sale: 20% off rain jackets until midnight. Reply STOP to end.",
        service: "customerio",
      }),
    ],
    { sms: { to: PHONE, thread: "22395" } },
  ),
}

export const ConversationSnsTopic: Story = {
  args: only(
    [
      sms({
        from: "order-alerts",
        fromName: "order-alerts",
        body: "Order 1042 has shipped.",
        service: "sns",
      }),
    ],
    { sms: { to: PHONE, thread: "order-alerts" } },
  ),
}

export const ConversationEmojiAndUnicode: Story = {
  args: only(
    [
      sms({
        from: "+16505550142",
        body: "Your table for 2 is ready 🍽️ — merci, Zoë! 予約ありがとうございます。 ✅",
      }),
    ],
    { sms: { to: PHONE, thread: "+16505550142" } },
  ),
}

export const ConversationLongMessage: Story = {
  args: only(
    [
      sms({
        from: "+18885550100",
        body: `Acme terms update. ${"We updated how we handle your data, returns and shipping times for remote addresses. ".repeat(14)}Read more at https://acme.example/terms`,
      }),
    ],
    { sms: { to: PHONE, thread: "+18885550100" } },
  ),
}

export const ConversationPictureMessage: Story = {
  args: only(
    [
      sms({
        from: "+18885550100",
        body: "Your package was delivered to the front porch.",
        media: [art("Delivered", "#22c55e", "#15803d", 480, 360)],
      }),
    ],
    { sms: { to: PHONE, thread: "+18885550100" } },
  ),
}

export const ConversationManyMessagesScrolledToNewest: Story = {
  args: only(
    Array.from({ length: 16 }, (_, i) =>
      sms({
        from: "+18885550100",
        body: `Status update ${i + 1}: ${i % 3 === 0 ? "Your driver is on the way and will arrive soon." : "Still on schedule."}`,
        minutesAgo: (16 - i) * 20,
      }),
    ),
    { sms: { to: PHONE, thread: "+18885550100" } },
  ),
}

export const BackButtonUnreadBadge: Story = {
  args: only(smsInbox(), { sms: { to: PHONE, thread: "ACMEBANK" } }),
}

export const SeveralPhonesInPicker: Story = {
  args: only(
    [
      ...smsInbox(),
      sms({
        to: "+12025550177",
        from: "+18005550199",
        body: "Your Acme sign-in code is 482913.",
        minutesAgo: 1,
        service: "sns",
      }),
      sms({
        to: "+447700900123",
        from: "ACME",
        fromName: "ACME",
        body: "Your UK order shipped.",
        minutesAgo: 9,
      }),
    ],
    { sms: { to: "+447700900123" } },
  ),
}

// Swipe actions and the long-press menu
const senders = [...new Set(inbox.map((n) => n.from.address))]
export const ThreadListPinnedAndMuted: Story = {
  args: only(inbox, {
    local: {
      pinned: [`${PHONE}|${senders.at(-1)}`],
      muted: [`${PHONE}|${senders[0]}`],
    },
  }),
}
export const ConversationLongPressTapbackMenu: Story = {
  args: only(order, { sms: { to: PHONE, thread: "+18885550100", menu: order[2]?.id ?? null } }),
}
export const ConversationWithTapback: Story = {
  args: only(order, {
    sms: { to: PHONE, thread: "+18885550100" },
    local: { tapbacks: { [order[2]?.id ?? ""]: "heart", [order[3]?.id ?? ""]: "like" } },
  }),
}

// WhatsApp through Twilio: the same phone, drawn as a WhatsApp chat.
export const WhatsAppInThreadList: Story = { args: only([...smsInbox(), ...whatsappInbox()]) }
export const WhatsAppConversation: Story = {
  args: only(whatsappInbox(), { sms: { to: PHONE, thread: "whatsapp:+14155238886" } }),
}
export const WhatsAppVerificationCode: Story = {
  args: only(whatsappInbox(), { sms: { to: PHONE, thread: "whatsapp:Verify" } }),
}
