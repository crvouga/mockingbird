import type { Meta, StoryObj } from "@storybook/html-vite"
import type { Notification } from "../src/model.js"
import type { AppOptions } from "../src/ui/app.js"
import { base, email, MAILBOX, mailbox, ORDER_HTML, RESET_HTML } from "./fixtures.js"
import { mount } from "./mount.js"

/** The webmail client: inbox list, reading pane, and every body and header shape. */
const meta: Meta<AppOptions> = {
  title: "Devices/Email",
  tags: ["vp-mail"],
  render: (args) => mount(args),
}
export default meta
type Story = StoryObj<AppOptions>

const inbox = (
  items: Notification[],
  open: string | null = null,
  rest: AppOptions = {},
): AppOptions => {
  const { initial, ...others } = rest
  return base(items, {
    ...others,
    initial: { only: "email", email: { to: MAILBOX, open }, ...initial },
  })
}

export const NoEmailYet: Story = { args: inbox([]) }

const box = mailbox()
export const InboxUnread: Story = { args: inbox(box) }
export const InboxMixedReadUnread: Story = {
  args: inbox(box, null, { seen: box.filter((_, i) => i % 2).map((n) => n.id) }),
}
export const InboxAllRead: Story = { args: inbox(box, null, { seen: box.map((n) => n.id) }) }
export const InboxSingle: Story = {
  args: inbox([
    email({
      from: "orders@acme.example",
      fromName: "Acme",
      subject: "Your Acme order #1042 is confirmed",
      html: ORDER_HTML,
    }),
  ]),
}
export const InboxScrolls: Story = {
  args: inbox(
    Array.from({ length: 30 }, (_, i) =>
      email({
        from: `digest${i}@news.example`,
        fromName: `Newsletter ${i + 1}`,
        subject: `Issue #${120 - i}: what we shipped this week`,
        text: "Highlights, fixes and a few things we are still working on.",
        minutesAgo: i * 300,
      }),
    ),
  ),
}

const order = email({
  from: "orders@acme.example",
  fromName: "Acme",
  subject: "Your Acme order #1042 is confirmed",
  html: ORDER_HTML,
})
export const OpenHtmlEmail: Story = { args: inbox([order], order.id) }

const reset = email({
  from: "security@acme.example",
  fromName: "Acme Security",
  subject: "Reset your password",
  html: RESET_HTML,
  service: "mailosaur",
})
export const OpenPasswordReset: Story = { args: inbox([reset], reset.id) }

const receipt = email({
  from: "billing@shop.example",
  fromName: "Shop Billing",
  subject: "Your receipt #1042",
  text: "Thanks, Ada. Total: $42.00\n\nView it online: https://shop.example/r/1042\n\nShop Billing\n1 Example Way",
  service: "ses",
})
export const OpenPlainTextWithLinks: Story = { args: inbox([receipt], receipt.id) }

const report = email({
  from: "reports@shop.example",
  fromName: "Reports",
  subject: "Weekly report ✅",
  html: "<p>Here is this week's report. The CSV has every order; the PDF is the summary.</p>",
  attachments: [
    { filename: "report.csv", contentType: "text/csv", size: 8_204 },
    { filename: "summary.pdf", contentType: "application/pdf", size: 182_000 },
    { filename: "chart.png", contentType: "image/png", size: 64_100 },
  ],
  service: "ses",
})
export const OpenWithAttachments: Story = { args: inbox([report], report.id) }

const headers = email({
  from: "billing@shop.example",
  fromName: "Shop Billing",
  subject: "Invoice INV-2026-118",
  text: "Your invoice is attached.",
  cc: ["accounts@example.com", "boss@example.com"],
  bcc: ["archive@example.com"],
  replyTo: ["support@shop.example"],
  service: "ses",
})
export const OpenHeaderDetailsExpanded: Story = {
  args: inbox([headers], headers.id, { initial: { mailDetailsOpen: true } }),
}

const ccCopy = email({
  to: "boss@example.com",
  from: "billing@shop.example",
  fromName: "Shop Billing",
  subject: "Invoice INV-2026-118",
  text: "Your invoice is attached.",
  cc: ["boss@example.com"],
  service: "ses",
})
export const OpenAsCcRecipient: Story = {
  args: base([ccCopy], {
    initial: { only: "email", email: { to: "boss@example.com", open: ccCopy.id } },
  }),
}

const sns = email({
  from: "no-reply@sns.amazonaws.com",
  fromName: "AWS Notifications",
  subject: "Order 1042 shipped",
  text: "Order 1042 has shipped.\n\n--\nIf you wish to stop receiving notifications from this topic, please unsubscribe.\n\nPlease do not reply directly to this email.",
  service: "sns",
})
export const OpenSnsTopicEmail: Story = { args: inbox([sns], sns.id) }

const cio = mailbox().find((n) => n.service === "customerio") as Notification
export const OpenCustomerIoTemplate: Story = { args: inbox([cio], cio.id) }

const noSubject = email({ from: "hr@acme.example", subject: "", text: "Sent without a subject." })
export const OpenNoSubject: Story = { args: inbox([noSubject], noSubject.id) }

const longSubject = email({
  from: "newsletter@trail.example",
  fromName: "Trail Weekly — the newsletter for people who run far and get lost on purpose",
  subject:
    "10 routes for your first ultramarathon, plus the gear we tested this fall in three very wet weekends and one surprisingly dry one",
  text: "Long subject and sender.",
})
export const LongSubjectAndSender: Story = { args: inbox([longSubject, ...mailbox()]) }
export const OpenLongSubject: Story = { args: inbox([longSubject], longSubject.id) }

export const NarrowWindowCollapsedNav: Story = {
  args: inbox(mailbox()),
  tags: ["vp-laptop-narrow"],
}
export const NarrowWindowOpen: Story = {
  args: inbox([order], order.id),
  tags: ["vp-laptop-narrow"],
}
export const PhoneWidthInbox: Story = { args: inbox(mailbox()), tags: ["vp-mobile"] }
export const PhoneWidthOpen: Story = { args: inbox([order], order.id), tags: ["vp-mobile"] }
export const SeveralMailboxesInPicker: Story = {
  args: inbox([
    ...mailbox(),
    email({
      to: "lin@example.com",
      from: "team@acme.example",
      subject: "Welcome, Lin",
      text: "Hi Lin",
      minutesAgo: 0,
    }),
    email({
      to: "ops@example.com",
      from: "no-reply@sns.amazonaws.com",
      subject: "Alarm",
      text: "CPU high",
      minutesAgo: 4,
      service: "sns",
    }),
  ]),
}
