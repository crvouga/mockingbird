/** The kinds of device a notification lands on. */
export type Channel = "sms" | "email" | "push" | "chat"

/** Every channel, in the order the devices are laid out. */
export const CHANNELS: readonly Channel[] = ["sms", "push", "email", "chat"]

/** Emulators the harness knows how to read. */
export type ServiceKind =
  | "twilio"
  | "resend"
  | "fcm"
  | "ses"
  | "sns"
  | "customerio"
  | "mailosaur"
  | "slack"
  | "cognito"

export const SERVICE_KINDS: readonly ServiceKind[] = [
  "twilio",
  "resend",
  "fcm",
  "ses",
  "sns",
  "customerio",
  "mailosaur",
  "slack",
  "cognito",
]

export const SERVICE_LABELS: Record<ServiceKind, string> = {
  twilio: "Twilio",
  resend: "Resend",
  fcm: "Firebase Cloud Messaging",
  ses: "Amazon SES",
  sns: "Amazon SNS",
  customerio: "Customer.io",
  mailosaur: "Mailosaur",
  slack: "Slack",
  cognito: "Amazon Cognito",
}

export type Address = { name: string | null; address: string }

export type SmsContent = {
  body: string
  /** One-time code the sender included (Twilio Verify, Cognito), when known. */
  code: string | null
  media: string[]
  /** `whatsapp` when the message went to a `whatsapp:` address; plain text messages omit it. */
  via?: "sms" | "whatsapp"
}

export type EmailAttachment = { filename: string; contentType: string | null; size: number | null }

export type EmailContent = {
  subject: string
  html: string | null
  text: string | null
  cc: string[]
  bcc: string[]
  replyTo: string[]
  attachments: EmailAttachment[]
  headers: Record<string, string>
}

export type PushPlatform = "android" | "ios" | "web" | "unknown"

export type PushContent = {
  title: string | null
  body: string | null
  imageUrl: string | null
  /** The app the notification belongs to (the FCM project, for example). */
  app: string
  platform: PushPlatform
  data: Record<string, string>
  badge: number | null
  sound: string | null
}

export type ChatReaction = { name: string; count: number }

/** A message posted into a team chat channel (Slack). */
export type ChatContent = {
  /** The message text, in the provider's own markup (Slack mrkdwn). */
  text: string
  /** Workspace the message was posted in. */
  workspace: string | null
  /** How it arrived: `chat.postMessage`, `chat.postEphemeral` or `incoming-webhook`. */
  method: string
  /** Block Kit blocks, exactly as sent. */
  blocks: unknown[]
  /** Legacy attachments, exactly as sent. */
  attachments: unknown[]
  /** Parent message timestamp when this is a threaded reply. */
  threadTs: string | null
  /** Shown to one member only. */
  ephemeral: boolean
  edited: boolean
  reactions: ChatReaction[]
  /** Display names of the users and channels the message mentions by id (`U…` → `ada`). */
  names?: Record<string, string>
}

/** One message as a recipient would receive it, normalized across emulators. */
export type Notification = {
  /** Stable across polls: `<service entry>:<namespace>:<provider id>`. */
  id: string
  /** The provider's own id (Twilio SID, Resend id, FCM message name, …). */
  providerId: string
  channel: Channel
  /** The fleet entry name (`twilio`, or an alias such as `push`). */
  source: string
  service: ServiceKind
  namespace: string
  /** Phone number, email address, push registration token, or chat channel (`#alerts`). */
  to: string
  from: Address
  /** ISO-8601, on the emulator's clock. */
  createdAt: string
  /** Short plain-text preview. */
  preview: string
  /** Provider delivery state when it reports one (`queued`, `delivered`, `suppressed`, …). */
  status: string | null
  sms: SmsContent | null
  email: EmailContent | null
  push: PushContent | null
  /** Set on `chat` notifications; absent or null on every other channel. */
  chat?: ChatContent | null
  /** The record exactly as the emulator reported it. */
  raw: unknown
}

export type NotificationFilter = {
  channel?: Channel | undefined
  service?: ServiceKind | undefined
  source?: string | undefined
  namespace?: string | undefined
  /** Exact recipient (case-insensitive for email). */
  to?: string | undefined
  /** Case-insensitive text search across sender, subject, title and body. */
  contains?: string | undefined
  /** Only notifications created at or after this instant (ISO-8601 or epoch ms). */
  since?: string | number | undefined
}

export type SourceStatus = {
  name: string
  service: ServiceKind | null
  url: string
  ok: boolean
  error: string | null
  count: number
  lastSyncAt: string | null
}

const toMs = (value: string | number): number =>
  typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : Date.parse(value)

const searchable = (n: Notification): string =>
  [
    n.to,
    n.from.address,
    n.from.name ?? "",
    n.preview,
    n.sms?.body ?? "",
    n.email?.subject ?? "",
    n.email?.text ?? "",
    n.push?.title ?? "",
    n.push?.body ?? "",
    n.chat?.text ?? "",
  ]
    .join("\n")
    .toLowerCase()

export const matches = (n: Notification, filter: NotificationFilter): boolean => {
  if (filter.channel && n.channel !== filter.channel) return false
  if (filter.service && n.service !== filter.service) return false
  if (filter.source && n.source !== filter.source) return false
  if (filter.namespace && n.namespace !== filter.namespace) return false
  if (filter.to && n.to.toLowerCase() !== filter.to.toLowerCase()) return false
  if (filter.contains && !searchable(n).includes(filter.contains.toLowerCase())) return false
  if (filter.since !== undefined && Date.parse(n.createdAt) < toMs(filter.since)) return false
  return true
}

/** Parse `?channel=&service=&to=…` into a filter. Unknown values are rejected. */
export const filterFromSearch = (params: URLSearchParams): NotificationFilter => {
  const filter: NotificationFilter = {}
  const channel = params.get("channel")
  if (channel) {
    if (!(CHANNELS as readonly string[]).includes(channel))
      throw new Error(`channel: expected sms, email, push or chat, got ${JSON.stringify(channel)}`)
    filter.channel = channel as Channel
  }
  const service = params.get("service")
  if (service) {
    if (!(SERVICE_KINDS as readonly string[]).includes(service))
      throw new Error(`service: expected one of ${SERVICE_KINDS.join(", ")}`)
    filter.service = service as ServiceKind
  }
  for (const key of ["source", "namespace", "to", "contains"] as const) {
    const value = params.get(key)
    if (value) filter[key] = value
  }
  const since = params.get("since")
  if (since) {
    if (Number.isNaN(toMs(since))) throw new Error("since: expected ISO-8601 or epoch milliseconds")
    filter.since = since
  }
  return filter
}

export const filterToSearch = (filter: NotificationFilter): URLSearchParams => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filter))
    if (value !== undefined && value !== "") params.set(key, String(value))
  return params
}
