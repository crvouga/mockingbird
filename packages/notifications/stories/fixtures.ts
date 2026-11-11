/**
 * Deterministic notifications for the Storybook catalog. Every time is relative to `NOW`
 * (Mon Nov 9 2026, 9:41 AM in Los Angeles), and every image is an inline SVG, so a screenshot
 * is the same on every run.
 */

import type {
  ChatContent,
  EmailAttachment,
  Notification,
  PushPlatform,
  ServiceKind,
  SourceStatus,
} from "../src/model.js"
import type { AppOptions } from "../src/ui/app.js"

export const NOW = Date.parse("2026-11-09T17:41:00.000Z")
export const PHONE = "+12025550123"
export const MAILBOX = "ada@example.com"
export const IOS_TOKEN = "ios-7f3a9c2e1b5d"
export const ANDROID_TOKEN = "android-c41e09ab77f2"

const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
let seq = 0
const nextId = (prefix: string) => `${prefix}${(++seq).toString(36).padStart(6, "0")}`

/** A small illustration as a data URI: two-tone gradient with a label. */
export const art = (label: string, from: string, to: string, w = 600, h = 300): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.78}" cy="${h * 0.3}" r="${h * 0.18}" fill="#fff" fill-opacity=".35"/><path d="M0 ${h * 0.8} L${w * 0.3} ${h * 0.45} L${w * 0.55} ${h * 0.72} L${w * 0.75} ${h * 0.55} L${w} ${h * 0.85} V${h} H0Z" fill="#000" fill-opacity=".22"/><text x="${w * 0.06}" y="${h * 0.22}" font-family="Helvetica,Arial" font-weight="700" font-size="${h * 0.11}" fill="#fff">${label}</text></svg>`,
  )}`

type SmsInput = {
  to?: string
  from: string
  fromName?: string | null
  body: string
  code?: string | null
  media?: string[]
  minutesAgo?: number
  service?: ServiceKind
  status?: string | null
  namespace?: string
  /** `whatsapp` for a message sent to a `whatsapp:` address. */
  via?: "whatsapp"
}

export const sms = (o: SmsInput): Notification => {
  const service = o.service ?? "twilio"
  const providerId = nextId(service === "twilio" ? "SM" : "msg")
  const to = o.to ?? PHONE
  return {
    id: `${service}:${o.namespace ?? "default"}:${providerId}`,
    providerId,
    channel: "sms",
    source: service,
    service,
    namespace: o.namespace ?? "default",
    to,
    from: { name: o.fromName ?? null, address: o.from },
    createdAt: at(o.minutesAgo ?? 0),
    preview: o.body.replace(/\s+/g, " ").slice(0, 240),
    status: o.status ?? "queued",
    sms: {
      body: o.body,
      code: o.code ?? null,
      media: o.media ?? [],
      ...(o.via ? { via: o.via } : {}),
    },
    email: null,
    push: null,
    raw: { sid: providerId, to, from: o.from, body: o.body },
  }
}

type EmailInput = {
  to?: string
  from: string
  fromName?: string | null
  subject: string
  html?: string | null
  text?: string | null
  cc?: string[]
  bcc?: string[]
  replyTo?: string[]
  attachments?: EmailAttachment[]
  minutesAgo?: number
  service?: ServiceKind
  status?: string | null
}

const strip = (html: string) =>
  html
    .replace(/<(style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

export const email = (o: EmailInput): Notification => {
  const service = o.service ?? "resend"
  const providerId = nextId("em_")
  const to = (o.to ?? MAILBOX).toLowerCase()
  const body = o.text ?? (o.html ? strip(o.html) : "")
  return {
    id: `${service}:default:${providerId}#${to}`,
    providerId,
    channel: "email",
    source: service,
    service,
    namespace: "default",
    to,
    from: { name: o.fromName ?? null, address: o.from },
    createdAt: at(o.minutesAgo ?? 0),
    preview: body.slice(0, 240),
    status: o.status ?? "delivered",
    sms: null,
    email: {
      subject: o.subject,
      html: o.html ?? null,
      text: o.text ?? null,
      cc: o.cc ?? [],
      bcc: o.bcc ?? [],
      replyTo: o.replyTo ?? [],
      attachments: o.attachments ?? [],
      headers: {},
    },
    push: null,
    raw: { id: providerId, from: o.from, to: [to], subject: o.subject },
  }
}

type PushInput = {
  token?: string
  platform?: PushPlatform
  app?: string
  title?: string | null
  body?: string | null
  imageUrl?: string | null
  data?: Record<string, string>
  badge?: number | null
  sound?: string | null
  minutesAgo?: number
  status?: string | null
}

export const push = (o: PushInput): Notification => {
  const providerId = nextId("0:")
  const app = o.app ?? "acme-shop"
  const title = o.title === undefined ? "Order confirmed" : o.title
  const body = o.body === undefined ? "Your trail running shoes are being packed." : o.body
  return {
    id: `fcm:default:${providerId}`,
    providerId,
    channel: "push",
    source: "fcm",
    service: "fcm",
    namespace: "default",
    to: o.token ?? IOS_TOKEN,
    from: { name: app, address: `projects/${app}/messages/${providerId}` },
    createdAt: at(o.minutesAgo ?? 0),
    preview: [title, body].filter(Boolean).join(" — "),
    status: o.status ?? "delivered",
    sms: null,
    email: null,
    push: {
      title,
      body,
      imageUrl: o.imageUrl ?? null,
      app,
      platform: o.platform ?? "ios",
      data: o.data ?? {},
      badge: o.badge ?? null,
      sound: o.sound ?? null,
    },
    raw: { name: `projects/${app}/messages/${providerId}`, token: o.token ?? IOS_TOKEN },
  }
}

// ── Reusable sets ────────────────────────────────────────────────────────────

export const ORDER_HTML = `<div style="max-width:560px;margin:0 auto;font-family:Helvetica,Arial,sans-serif;color:#1f2937">
  <div style="padding:20px 0;border-bottom:1px solid #e5e7eb"><b style="font-size:20px;color:#4f46e5">acme</b></div>
  <h1 style="font-size:22px;margin:24px 0 8px">Thanks for your order, Ada!</h1>
  <p style="color:#4b5563;line-height:1.6">We're getting order <b>#1042</b> ready. You'll get another email when it ships.</p>
  <img src="${art("Trail runner 4", "#6366f1", "#ec4899", 560, 220)}" alt="" style="width:100%;border-radius:12px;margin:8px 0 16px">
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">Trail running shoes × 1</td><td style="text-align:right;border-bottom:1px solid #f3f4f6">$118.00</td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6">Merino socks × 2</td><td style="text-align:right;border-bottom:1px solid #f3f4f6">$24.00</td></tr>
    <tr><td style="padding:10px 0"><b>Total</b></td><td style="text-align:right"><b>$142.00</b></td></tr></table>
  <p style="margin:24px 0"><a href="https://acme.example/orders/1042" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">View your order</a></p>
  <p style="color:#9ca3af;font-size:12px">Acme Outdoor Co. · 1 Example Way · Springfield</p></div>`

export const RESET_HTML = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;color:#111827">
  <h2 style="margin:0 0 12px">Reset your password</h2>
  <p style="line-height:1.6;color:#374151">Someone asked to reset the password for <b>ada@example.com</b>. If that was you, use the button below. The link expires in 30 minutes.</p>
  <p><a href="https://acme.example/reset?token=9f2c" style="background:#111827;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
  <p style="font-size:12px;color:#6b7280">If you didn't ask for this, you can ignore this email.</p></div>`

/** A busy phone: many senders, read and unread, today through two weeks ago. */
export const smsInbox = (): Notification[] => [
  sms({
    from: "Verify",
    fromName: "Verify",
    body: "Your verification code is: 401942",
    code: "401942",
    minutesAgo: 0,
  }),
  sms({
    from: "+18885550100",
    body: "Acme: Your order #1042 shipped! Arriving Tuesday. Track: https://acme.example/t/1042",
    minutesAgo: 3,
  }),
  sms({ from: "+18885550100", body: "Acme: Your order #1042 has been confirmed.", minutesAgo: 48 }),
  sms({
    from: "ACMEBANK",
    fromName: "ACMEBANK",
    body: "AcmeBank: A charge of $142.00 at ACME OUTDOOR was approved on card ending 4242. Reply STOP to opt out.",
    minutesAgo: 95,
    service: "sns",
  }),
  sms({
    from: "22395",
    body: "Flash sale: 20% off rain jackets until midnight. Reply STOP to end.",
    minutesAgo: 60 * 20,
    service: "customerio",
  }),
  sms({
    from: "order-alerts",
    fromName: "order-alerts",
    body: "Order 1042 has shipped.",
    minutesAgo: 60 * 26,
    service: "sns",
  }),
  sms({
    from: "+14155550188",
    body: "Your Dr. Lee appointment is tomorrow at 3:30 PM. Reply C to confirm.",
    minutesAgo: 60 * 72,
    service: "mailosaur",
    status: "received",
  }),
  sms({
    from: "+16505550142",
    body: "Your table for 2 is ready. Please check in at the host stand 🍽️",
    minutesAgo: 60 * 24 * 14,
  }),
]

/** A busy mailbox across every email emulator. */
export const mailbox = (): Notification[] => [
  email({
    from: "orders@acme.example",
    fromName: "Acme",
    subject: "Your Acme order #1042 is confirmed",
    html: ORDER_HTML,
    minutesAgo: 1,
  }),
  email({
    from: "security@acme.example",
    fromName: "Acme Security",
    subject: "Reset your password",
    html: RESET_HTML,
    minutesAgo: 12,
    service: "mailosaur",
    status: "received",
  }),
  email({
    from: "billing@shop.example",
    fromName: "Shop Billing",
    subject: "Your receipt #1042",
    text: "Thanks, Ada. Total: $42.00\n\nView it online: https://shop.example/r/1042",
    cc: ["accounts@example.com"],
    minutesAgo: 40,
    service: "ses",
  }),
  email({
    from: "reports@shop.example",
    fromName: "Reports",
    subject: "Weekly report ✅",
    html: "<p>HTML ✅ report</p>",
    text: "Plain report",
    attachments: [
      { filename: "report.csv", contentType: "text/csv", size: 8_204 },
      { filename: "summary.pdf", contentType: "application/pdf", size: 182_000 },
    ],
    minutesAgo: 70,
    service: "ses",
  }),
  email({
    from: "no-reply@sns.amazonaws.com",
    fromName: "AWS Notifications",
    subject: "Order 1042 shipped",
    text: "Order 1042 has shipped.\n\n--\nIf you wish to stop receiving notifications from this topic, please unsubscribe.",
    minutesAgo: 60 * 5,
    service: "sns",
  }),
  email({
    from: "team@acme.example",
    fromName: "Acme Team",
    subject: "Welcome to Acme, Ada",
    html: `<div style="font:14px system-ui;color:#111827;padding:8px"><p style="margin:0 0 4px;color:#6b7280;font-size:12px">Customer.io transactional message <b>welcome</b></p><table style="border-collapse:collapse;border:1px solid #e5e7eb"><tr><td style="padding:6px 12px;color:#6b7280">first_name</td><td style="padding:6px 12px;font-family:monospace">Ada</td></tr><tr><td style="padding:6px 12px;color:#6b7280">plan</td><td style="padding:6px 12px;font-family:monospace">Trail Club</td></tr></table></div>`,
    minutesAgo: 60 * 26,
    service: "customerio",
    status: "pending",
  }),
  email({
    from: "Verify",
    subject: "Your verification code",
    text: "Your verification code is: 731044",
    minutesAgo: 60 * 24 * 3,
    service: "twilio",
  }),
  email({
    from: "newsletter@trail.example",
    fromName: "Trail Weekly",
    subject: "10 routes for your first ultramarathon, plus gear we tested this fall",
    html: "<p>This week: ten routes, three jackets, one very wet weekend.</p>",
    minutesAgo: 60 * 24 * 40,
  }),
  email({
    from: "hr@acme.example",
    subject: "",
    text: "(sent without a subject)",
    minutesAgo: 60 * 24 * 400,
  }),
]

type ChatInput = Partial<Omit<ChatContent, "text">> & {
  to?: string
  text?: string
  fromName?: string | null
  from?: string
  minutesAgo?: number
  namespace?: string
}

export const CHAT_CHANNEL = "#alerts"

export const chat = (o: ChatInput): Notification => {
  const providerId = nextId("C0ALERTS:")
  const to = o.to ?? CHAT_CHANNEL
  const webhook = to.startsWith("/services/")
  const text = o.text ?? ""
  return {
    id: `slack:${o.namespace ?? "default"}:${providerId}`,
    providerId,
    channel: "chat",
    source: "slack",
    service: "slack",
    namespace: o.namespace ?? "default",
    to,
    from: webhook
      ? { name: "Incoming Webhook", address: "incoming-webhook" }
      : { name: o.fromName ?? "Acme Bot", address: o.from ?? "U0ACMEBOT" },
    createdAt: at(o.minutesAgo ?? 0),
    preview: text.replace(/\s+/g, " ").slice(0, 240),
    status: o.ephemeral ? "ephemeral" : null,
    sms: null,
    email: null,
    push: null,
    chat: {
      text,
      workspace: o.workspace ?? "Acme",
      method: o.method ?? (webhook ? "incoming-webhook" : "chat.postMessage"),
      blocks: o.blocks ?? [],
      attachments: o.attachments ?? [],
      threadTs: o.threadTs ?? null,
      ephemeral: o.ephemeral ?? false,
      edited: o.edited ?? false,
      reactions: o.reactions ?? [],
      names: o.names ?? { U0LIN: "lin", C0GENERAL: "general" },
    },
    raw: { channel: to, text, blocks: o.blocks ?? [], attachments: o.attachments ?? [] },
  }
}

export const ORDER_BLOCKS: unknown[] = [
  { type: "header", text: { type: "plain_text", text: "Order #1042 shipped" } },
  {
    type: "section",
    text: { type: "mrkdwn", text: "*Trail running shoes* left the warehouse :package:" },
    fields: [
      { type: "mrkdwn", text: "*Carrier*\nExample Post" },
      { type: "mrkdwn", text: "*Arrives*\nTuesday" },
    ],
  },
  { type: "divider" },
  {
    type: "actions",
    elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "View order" } },
      { type: "button", text: { type: "plain_text", text: "Snooze" } },
      { type: "button", style: "danger", text: { type: "plain_text", text: "Cancel" } },
    ],
  },
  { type: "context", elements: [{ type: "mrkdwn", text: "Sent by the fulfilment worker" }] },
]

/** A workspace after a busy morning: two channels and an incoming webhook. */
export const chatChannels = (): Notification[] => [
  chat({
    text: "Checkout error rate is above 2%",
    to: "/services/T000/B000/XXXX",
    attachments: [
      {
        color: "danger",
        title: "checkout-api",
        text: "5xx responses: *2.4%* over the last 5 minutes",
        fields: [
          { title: "Region", value: "us-east-1", short: true },
          { title: "Since", value: "9:36 AM", short: true },
        ],
        footer: "Example Monitoring",
      },
    ],
    minutesAgo: 1,
  }),
  chat({ text: "Order #1042 shipped", blocks: ORDER_BLOCKS, minutesAgo: 3 }),
  chat({
    text: "Deploy `web@4f2c1a9` finished in *3m 12s*. <https://acme.example/deploys/918|View the deploy>",
    to: "#general",
    reactions: [
      { name: "tada", count: 3 },
      { name: "rocket", count: 1 },
    ],
    minutesAgo: 9,
  }),
  chat({
    text: "<@U0LIN> the nightly export is ready in <#C0GENERAL>:\n• 1,284 orders\n• 3 refunds\n> Totals match the ledger.",
    minutesAgo: 34,
  }),
  chat({
    text: "```\nexport finished\nrows: 1284\n```",
    edited: true,
    minutesAgo: 35,
  }),
  chat({ text: "New signup: lin@example.com on the *Trail Club* plan", minutesAgo: 60 * 26 }),
]

/** WhatsApp messages sent through Twilio, next to ordinary texts. */
export const whatsappInbox = (): Notification[] => [
  sms({
    from: "whatsapp:+14155238886",
    body: "Hi Ada, your Acme order #1042 is out for delivery. Reply STOP to opt out.",
    via: "whatsapp",
    minutesAgo: 2,
  }),
  sms({
    from: "whatsapp:+14155238886",
    body: "Your Acme order #1042 has shipped.",
    via: "whatsapp",
    minutesAgo: 190,
  }),
  sms({
    from: "whatsapp:Verify",
    fromName: "Verify",
    body: "Your verification code is 739204",
    code: "739204",
    via: "whatsapp",
    minutesAgo: 4,
  }),
]

export const allSources = (counts: Partial<Record<ServiceKind, number>> = {}): SourceStatus[] =>
  (["twilio", "resend", "fcm", "ses", "sns", "customerio", "mailosaur", "slack"] as const).map(
    (name) => ({
      name,
      service: name,
      url: `http://127.0.0.1:${8790 + name.length}/__admin`,
      ok: true,
      error: null,
      count: counts[name] ?? 0,
      lastSyncAt: new Date(NOW).toISOString(),
    }),
  )

export const countSources = (items: Notification[]): SourceStatus[] => {
  const counts: Partial<Record<ServiceKind, number>> = {}
  for (const n of items) counts[n.service] = (counts[n.service] ?? 0) + 1
  return allSources(counts)
}

/** Everything at once: the harness after a realistic test run. */
export const everything = (): Notification[] => [
  ...smsInbox(),
  ...whatsappInbox(),
  ...chatChannels(),
  ...mailbox(),
  push({
    title: "Order confirmed",
    body: "Your trail running shoes are being packed. We'll let you know when they ship.",
    data: { orderId: "1042" },
    badge: 1,
    sound: "default",
    minutesAgo: 2,
  }),
  push({
    token: ANDROID_TOKEN,
    platform: "android",
    title: "Flash sale ends tonight",
    body: "Take 20% off rain jackets until midnight.",
    imageUrl: art("Rain jackets", "#0ea5e9", "#1e3a8a"),
    minutesAgo: 6,
  }),
]

export const base = (items: Notification[], extra: AppOptions = {}): AppOptions => ({
  live: false,
  now: NOW,
  items,
  sources: countSources(items),
  namespaces: ["default"],
  ...extra,
})
