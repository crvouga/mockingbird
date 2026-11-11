/**
 * One reader per emulator. Each turns that emulator's admin outbox (or stored state) into
 * notifications as the recipient would see them. Readers only GET admin routes, so they never
 * change emulator state.
 */
import { addressList, decodeRawMessage, parseMime } from "./mime.js"
import type {
  Address,
  Channel,
  ChatContent,
  EmailContent,
  Notification,
  PushContent,
  PushPlatform,
  ServiceKind,
  SmsContent,
} from "./model.js"

/** GET an admin path (relative to the emulator's admin prefix) in the reader's namespace. */
export type AdminRead = (path: string) => Promise<unknown>

export type ReadContext = { source: string; namespace: string; read: AdminRead }

export type Reader = (context: ReadContext) => Promise<Notification[]>

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const row = (value: unknown): Row => (isRow(value) ? value : {})
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : null
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(str).filter((v): v is string => v !== null && v !== "")
    : typeof value === "string" && value !== ""
      ? [value]
      : []
const list = (value: unknown, key: string): Row[] => {
  const items = isRow(value) ? value[key] : value
  return Array.isArray(items) ? items.filter(isRow) : []
}
const iso = (value: unknown): string => {
  if (typeof value === "number") return new Date(value < 1e11 ? value * 1000 : value).toISOString()
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString()
  return new Date(0).toISOString()
}

/** `"Acme" <a@acme.test>` → `{ name: "Acme", address: "a@acme.test" }`. */
export const parseAddress = (value: string): Address => {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value)
  if (match) return { name: match[1]?.trim() || null, address: (match[2] ?? "").trim() }
  return { name: null, address: value.trim() }
}

const bare = (value: string): string => parseAddress(value).address.toLowerCase()

const stripHtml = (html: string): string =>
  html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()

const preview = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 240)

type Base = {
  context: ReadContext
  service: ServiceKind
  providerId: string
  to: string
  from: Address
  createdAt: string
  status?: string | null
  raw: unknown
}

const base = (input: Base, channel: Channel) => ({
  id: `${input.context.source}:${input.context.namespace}:${input.providerId}${
    channel === "email" ? `#${input.to.toLowerCase()}` : ""
  }`,
  providerId: input.providerId,
  channel,
  source: input.context.source,
  service: input.service,
  namespace: input.context.namespace,
  to: input.to,
  from: input.from,
  createdAt: input.createdAt,
  status: input.status ?? null,
  raw: input.raw,
})

const smsNotification = (
  input: Base,
  sms: Partial<SmsContent> & { body: string },
): Notification => ({
  ...base(input, "sms"),
  preview: preview(sms.body),
  sms: {
    body: sms.body,
    code: sms.code ?? null,
    media: sms.media ?? [],
    ...(sms.via === "whatsapp" ? { via: sms.via } : {}),
  },
  email: null,
  push: null,
  chat: null,
})

/** One notification per mailbox: every `to`, `cc` and `bcc` recipient gets its own copy. */
const emailNotifications = (
  input: Omit<Base, "to">,
  recipients: string[],
  email: Partial<EmailContent> & { subject: string },
): Notification[] => {
  const content: EmailContent = {
    subject: email.subject,
    html: email.html ?? null,
    text: email.text ?? null,
    cc: email.cc ?? [],
    bcc: email.bcc ?? [],
    replyTo: email.replyTo ?? [],
    attachments: email.attachments ?? [],
    headers: email.headers ?? {},
  }
  const body = content.text ?? (content.html ? stripHtml(content.html) : "")
  const seen = new Set<string>()
  return recipients.flatMap((recipient) => {
    const to = bare(recipient)
    if (!to || seen.has(to)) return []
    seen.add(to)
    return [
      {
        ...base({ ...input, to }, "email"),
        preview: preview(body),
        sms: null,
        email: content,
        push: null,
        chat: null,
      },
    ]
  })
}

const pushNotification = (input: Base, push: PushContent): Notification => ({
  ...base(input, "push"),
  preview: preview([push.title, push.body].filter(Boolean).join(" — ")),
  sms: null,
  email: null,
  push,
  chat: null,
})

const chatNotification = (input: Base, chat: ChatContent, summary: string): Notification => ({
  ...base(input, "chat"),
  preview: preview(summary),
  sms: null,
  email: null,
  push: null,
  chat,
})

const WHATSAPP = /^whatsapp:/i

const twilio: Reader = async (context) => {
  const messages = list(await context.read("/outbox"), "messages")
  return messages.flatMap((m): Notification[] => {
    const providerId = str(m.id) ?? str(m.sid) ?? ""
    const body = str(m.body) ?? ""
    const recipient = str(m.to) ?? ""
    const verify = m.kind === "verify"
    // WhatsApp rides Twilio's messaging API with `whatsapp:` channel addresses (and Verify's
    // `whatsapp` channel). The recipient is still a phone, so `to` drops the prefix; the sender
    // keeps it, which is what separates the WhatsApp chat from the same number's text thread.
    const whatsapp =
      m.channel === "whatsapp" || WHATSAPP.test(recipient) || WHATSAPP.test(str(m.from) ?? "")
    const to = recipient.replace(WHATSAPP, "")
    const origin = str(m.from) ?? str(m.messagingServiceSid) ?? (verify ? "Verify" : "Twilio")
    const sender = whatsapp ? `whatsapp:${origin.replace(WHATSAPP, "")}` : origin
    const common = {
      context,
      service: "twilio" as const,
      providerId,
      from: { name: verify && !m.from ? "Verify" : null, address: sender },
      createdAt: iso(m.createdAt),
      status: str(m.status),
      raw: m,
    }
    if (m.channel === "email")
      return emailNotifications(common, [to], {
        subject: "Your verification code",
        text: body,
      })
    return [
      smsNotification(
        { ...common, to },
        {
          body,
          code: str(m.code),
          media: strings(m.mediaUrls),
          ...(whatsapp ? { via: "whatsapp" as const } : {}),
        },
      ),
    ]
  })
}

const resend: Reader = async (context) =>
  list(await context.read("/outbox"), "messages").flatMap((m) => {
    const cc = strings(m.cc)
    const bcc = strings(m.bcc)
    return emailNotifications(
      {
        context,
        service: "resend",
        providerId: str(m.id) ?? "",
        from: parseAddress(str(m.from) ?? ""),
        createdAt: iso(m.createdAt),
        status: m.scheduledAt ? "scheduled" : "delivered",
        raw: m,
      },
      [...strings(m.to), ...cc, ...bcc],
      {
        subject: str(m.subject) ?? "",
        html: str(m.html),
        text: str(m.text),
        cc,
        bcc,
        replyTo: strings(m.replyTo),
        headers: Object.fromEntries(Object.entries(row(m.headers)).map(([k, v]) => [k, String(v)])),
        attachments: list(m.attachments, "").map((a) => ({
          filename: str(a.filename) ?? "attachment",
          contentType: str(a.contentType),
          size: typeof a.size === "number" ? a.size : null,
        })),
      },
    )
  })

const platformOf = (value: unknown): PushPlatform =>
  value === "android" || value === "ios" || value === "web" ? value : "unknown"

const fcm: Reader = async (context) =>
  list(await context.read("/outbox"), "messages").map((m) => {
    const wire = row(m.wire)
    const notification = row(m.notification ?? wire.notification)
    const android = row(row(m.android ?? wire.android).notification)
    const aps = row(row(row(m.apns ?? wire.apns).payload).aps)
    const alert = isRow(aps.alert) ? aps.alert : { body: aps.alert }
    const webpush = row(row(wire.webpush).notification)
    const platform = platformOf(m.platform)
    const pick = (key: "title" | "body") =>
      (platform === "android" ? str(android[key]) : null) ??
      (platform === "ios" ? str(alert[key]) : null) ??
      (platform === "web" ? str(webpush[key]) : null) ??
      str(notification[key])
    const image =
      (platform === "android" ? str(android.image) : null) ??
      str(row(row(m.apns ?? wire.apns).fcm_options).image) ??
      str(notification.image)
    const project = str(m.project) ?? "app"
    return pushNotification(
      {
        context,
        service: "fcm",
        providerId: str(m.id) ?? str(m.name) ?? "",
        to: str(m.token) ?? "",
        from: { name: project, address: str(m.name) ?? project },
        createdAt: iso(m.acceptedAt),
        status: str(m.state),
        raw: m,
      },
      {
        title: pick("title"),
        body: pick("body"),
        imageUrl: image,
        app: project,
        platform,
        data: Object.fromEntries(
          Object.entries(row(m.data ?? wire.data)).map(([k, v]) => [k, String(v)]),
        ),
        badge: typeof aps.badge === "number" ? aps.badge : null,
        sound: str(aps.sound) ?? str(android.sound),
      },
    )
  })

/** Every record of a shared-runtime state collection, following `next` cursors. */
const stateRecords = async (read: AdminRead, collection: string): Promise<Row[]> => {
  const out: Row[] = []
  let after: unknown = null
  for (let page = 0; page < 100; page++) {
    const query = after === null ? "" : `&after=${encodeURIComponent(String(after))}`
    const result = row(await read(`/state/${collection}?limit=200&order=oldest${query}`))
    for (const record of list(result, "records")) out.push(record)
    if (result.next === null || result.next === undefined) break
    after = result.next
  }
  return out
}

const ses: Reader = async (context) =>
  (await stateRecords(context.read, "ses_messages")).flatMap((record) => {
    const v = row(record.value)
    const destination = row(v.Destination)
    const common = {
      context,
      service: "ses" as const,
      providerId: str(v.MessageId) ?? str(record.id) ?? "",
      createdAt: iso(v.Timestamp),
      status: "delivered",
      raw: v,
    }
    const raw = row(v.RawMessage)
    if (raw.Data !== undefined) {
      const mime = parseMime(decodeRawMessage(str(raw.Data) ?? ""))
      const recipients = strings(v.Destinations)
      return emailNotifications(
        { ...common, from: parseAddress(str(v.Source) ?? mime.from ?? "") },
        recipients.length ? recipients : [...mime.to, ...mime.cc],
        {
          subject: mime.subject,
          html: mime.html,
          text: mime.text,
          cc: mime.cc,
          attachments: mime.attachments,
          headers: mime.headers,
          replyTo: addressList(mime.headers["reply-to"]),
        },
      )
    }
    const message = row(v.Message)
    const body = row(message.Body)
    const cc = strings(destination.CcAddresses)
    const bcc = strings(destination.BccAddresses)
    return emailNotifications(
      { ...common, from: parseAddress(str(v.Source) ?? "") },
      [...strings(destination.ToAddresses), ...cc, ...bcc],
      {
        subject: str(row(message.Subject).Data) ?? "",
        html: str(row(body.Html).Data),
        text: str(row(body.Text).Data),
        cc,
        bcc,
        replyTo: strings(v.ReplyToAddresses),
      },
    )
  })

/** SNS `MessageStructure: "json"` carries one body per protocol, with `default` as fallback. */
const snsBody = (v: Row, protocol: string): string => {
  const message = str(v.Message) ?? ""
  if (v.MessageStructure !== "json") return message
  try {
    const parsed = row(JSON.parse(message))
    return str(parsed[protocol]) ?? str(parsed.default) ?? message
  } catch {
    return message
  }
}

const sns: Reader = async (context) => {
  const [messages, subscriptions] = await Promise.all([
    stateRecords(context.read, "sns_messages"),
    stateRecords(context.read, "sns_subscriptions"),
  ])
  return messages.flatMap((record): Notification[] => {
    const v = row(record.value)
    const providerId = str(v.MessageId) ?? str(record.id) ?? ""
    const common = { context, service: "sns" as const, createdAt: iso(v.Timestamp), raw: v }
    const phone = str(v.PhoneNumber)
    if (phone)
      return [
        smsNotification(
          {
            ...common,
            providerId,
            to: phone,
            from: { name: null, address: "SNS" },
            status: "delivered",
          },
          { body: snsBody(v, "sms") },
        ),
      ]
    const topicArn = str(v.TopicArn) ?? ""
    const topicName = topicArn.split(":").at(-1) ?? "SNS"
    return subscriptions.flatMap((sub): Notification[] => {
      const s = row(sub.value)
      if (s.TopicArn !== topicArn) return []
      const endpoint = str(s.Endpoint) ?? ""
      const subId = `${providerId}@${str(s.SubscriptionArn) ?? endpoint}`
      if (s.Protocol === "sms")
        return [
          smsNotification(
            {
              ...common,
              providerId: subId,
              to: endpoint,
              from: { name: topicName, address: topicName },
              status: "delivered",
            },
            { body: snsBody(v, "sms") },
          ),
        ]
      if (s.Protocol === "email" || s.Protocol === "email-json") {
        const text =
          s.Protocol === "email-json"
            ? JSON.stringify(
                {
                  Type: "Notification",
                  MessageId: providerId,
                  TopicArn: topicArn,
                  Subject: v.Subject ?? null,
                  Message: snsBody(v, "email-json"),
                },
                null,
                2,
              )
            : `${snsBody(v, "email")}\n\n--\nIf you wish to stop receiving notifications from this topic, please unsubscribe.\n\nPlease do not reply directly to this email. If you have any questions or comments regarding this email, please contact us at https://aws.amazon.com/support`
        return emailNotifications(
          {
            ...common,
            providerId: subId,
            from: { name: "AWS Notifications", address: "no-reply@sns.amazonaws.com" },
            status: "delivered",
          },
          [endpoint],
          { subject: str(v.Subject) ?? "AWS Notification Message", text },
        )
      }
      return []
    })
  })
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Customer.io renders the template server side; the emulator keeps its id and data. */
const templatePreview = (m: Row): string => {
  const data = Object.entries(row(m.messageData))
  const rows = data
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px;color:#6b7280;font:13px system-ui">${escapeHtml(k)}</td><td style="padding:6px 12px;font:13px ui-monospace,monospace">${escapeHtml(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`,
    )
    .join("")
  const links = strings(m.links)
    .map(
      (href) =>
        `<p style="font:13px system-ui"><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></p>`,
    )
    .join("")
  return `<div style="font:14px system-ui;color:#111827;padding:8px"><p style="margin:0 0 4px;color:#6b7280;font-size:12px">Customer.io transactional message <b>${escapeHtml(str(m.transactionalMessageId) ?? "")}</b></p><p style="margin:0 0 12px;color:#6b7280;font-size:12px">The template body is rendered by Customer.io; these are the <code>message_data</code> values it was sent with.</p>${rows ? `<table style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px">${rows}</table>` : "<p><i>No message_data.</i></p>"}${links}</div>`
}

const customerio: Reader = async (context) =>
  list(await context.read("/outbox"), "messages").flatMap((m): Notification[] => {
    const identifiers = row(m.identifiers)
    const to = str(m.to) ?? str(identifiers.email) ?? str(identifiers.id) ?? ""
    const state = str(m.state)
    const common = {
      context,
      service: "customerio" as const,
      providerId: str(m.id) ?? "",
      createdAt: iso(m.createdAt),
      status: state,
      raw: m,
    }
    const templateId = str(m.transactionalMessageId) ?? "message"
    if (m.channel === "sms") {
      const data = row(m.messageData)
      const body =
        str(data.body) ??
        str(data.message) ??
        str(data.text) ??
        `[${templateId}] ${Object.entries(data)
          .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(", ")}`.trim()
      return [
        smsNotification(
          { ...common, to, from: { name: null, address: str(m.from) ?? "Customer.io" } },
          { body },
        ),
      ]
    }
    if (m.channel === "email")
      return emailNotifications(
        { ...common, from: parseAddress(str(m.from) ?? "Customer.io <no-reply@customer.io>") },
        [to],
        {
          subject: str(m.subject) ?? `Transactional message ${templateId}`,
          html: templatePreview(m),
          attachments: strings(m.attachments).map((filename) => ({
            filename,
            contentType: null,
            size: null,
          })),
        },
      )
    return []
  })

const mailosaurAddress = (value: unknown): string => {
  const a = row(value)
  return str(a.email) ?? str(a.phone) ?? str(a.phoneNumber) ?? ""
}

const mailosaur: Reader = async (context) =>
  list(await context.read("/outbox"), "messages").flatMap((entry): Notification[] => {
    const m = row(entry.message)
    const from = row(list(m.from, "")[0])
    const recipients = list(m.to, "").map(mailosaurAddress).filter(Boolean)
    const common = {
      context,
      service: "mailosaur" as const,
      providerId: str(entry.id) ?? str(m.id) ?? "",
      createdAt: iso(m.received ?? entry.createdAt),
      status: "received",
      raw: entry,
    }
    const html = str(row(m.html).body)
    const text = str(row(m.text).body)
    if (m.type === "SMS")
      return recipients.map((to) =>
        smsNotification(
          {
            ...common,
            to,
            from: { name: str(from.name) || null, address: mailosaurAddress(from) },
          },
          { body: text ?? (html ? stripHtml(html) : "") },
        ),
      )
    return emailNotifications(
      { ...common, from: { name: str(from.name) || null, address: mailosaurAddress(from) } },
      [...recipients, ...list(m.cc, "").map(mailosaurAddress)],
      {
        subject: str(m.subject) ?? "",
        html,
        text,
        cc: list(m.cc, "").map(mailosaurAddress),
        attachments: list(m.attachments, "").map((a) => ({
          filename: str(a.fileName) ?? str(a.filename) ?? "attachment",
          contentType: str(a.contentType),
          size: typeof a.length === "number" ? a.length : null,
        })),
      },
    )
  })

/** Slack mrkdwn as the plain text a notification preview shows. */
const mrkdwnText = (text: string, names: Map<string, string>): string =>
  text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => {
      return `@${label || names.get(id) || id}`
    })
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => {
      return `#${label || names.get(id) || id}`
    })
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<([^|>]+)\|([^>]*)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** The readable text inside Block Kit blocks or attachments, in document order. */
const blockText = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) for (const item of value) blockText(item, out)
  if (!isRow(value)) return out
  for (const key of ["pretext", "title", "text", "alt_text", "footer"]) {
    const text = value[key]
    if (typeof text === "string" && text.trim() !== "") out.push(text)
    else blockText(text, out)
  }
  for (const field of list(value.fields, "")) {
    const pair = [str(field.title), str(field.value)].filter(Boolean).join(": ")
    if (pair) out.push(pair)
    else blockText(field, out)
  }
  blockText(value.elements, out)
  blockText(value.blocks, out)
  return out
}

/** A read that may fail (an older emulator without the route) without failing the outbox. */
const optional = (read: AdminRead, path: string): Promise<unknown> => read(path).catch(() => null)

const slack: Reader = async (context) => {
  const [outbox, channelList, userList, settings] = await Promise.all([
    context.read("/outbox"),
    optional(context.read, "/channels"),
    optional(context.read, "/users"),
    optional(context.read, "/settings"),
  ])
  const team = row(settings)
  const names = new Map<string, string>()
  const people = new Map<string, Row>()
  for (const channel of list(channelList, "channels"))
    if (str(channel.id) && str(channel.name))
      names.set(str(channel.id) ?? "", str(channel.name) ?? "")
  for (const user of list(userList, "users")) {
    const id = str(user.id) ?? ""
    people.set(id, user)
    names.set(id, str(user.name) ?? id)
  }
  const bot = str(team.botUserId)
  return list(outbox, "messages").map((m): Notification => {
    const webhook = str(m.webhook)
    const channel = str(m.channel) ?? webhook ?? ""
    const name = strings(m.to).find((entry) => entry.startsWith("#")) ?? names.get(channel)
    const ephemeral = m.ephemeral === true
    // An ephemeral message records the member it was shown to as `user`; the bot still wrote it.
    const author = webhook ? null : ephemeral ? bot : (str(m.user) ?? bot)
    const person = row(author ? people.get(author) : null)
    const text = str(m.text) ?? ""
    const blocks = Array.isArray(m.blocks) ? m.blocks : []
    const attachments = Array.isArray(m.attachments) ? m.attachments : []
    const summary = text || [...blockText(blocks), ...blockText(attachments)].join(" ")
    // Only the ids this message mentions, so a client can draw `<@U…>` as a name.
    const body = JSON.stringify([text, blocks, attachments])
    const mentioned = Object.fromEntries([...names].filter(([id]) => id && body.includes(id)))
    return chatNotification(
      {
        context,
        service: "slack",
        providerId: str(m.id) ?? `${channel}:${str(m.ts) ?? ""}`,
        to: webhook ?? (name ? `#${name.replace(/^#/, "")}` : channel),
        from: webhook
          ? { name: "Incoming Webhook", address: "incoming-webhook" }
          : {
              name: str(person.real_name) ?? str(person.name) ?? null,
              address: author ?? "bot",
            },
        createdAt: iso(m.createdAt),
        status: ephemeral ? "ephemeral" : null,
        raw: m,
      },
      {
        text,
        workspace: str(team.teamName) ?? str(m.workspace),
        method: str(m.method) ?? (webhook ? "incoming-webhook" : "chat.postMessage"),
        blocks,
        attachments,
        threadTs: str(m.thread_ts),
        ephemeral,
        edited: isRow(m.edited),
        reactions: list(m.reactions, "").map((reaction) => ({
          name: str(reaction.name) ?? "",
          count: typeof reaction.count === "number" ? reaction.count : 1,
        })),
        names: mentioned,
      },
      mrkdwnText(summary, names),
    )
  })
}

export const READERS: Record<ServiceKind, Reader> = {
  twilio,
  resend,
  fcm,
  ses,
  sns,
  customerio,
  mailosaur,
  slack,
}
