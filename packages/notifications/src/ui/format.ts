/**
 * Formatting for the harness UI: names, numbers, colors and times, each the way the device or
 * app it imitates would show it. Pure functions; times take the clock (`now`) as an argument so a
 * fixed clock (Storybook) never moves.
 */
import type { Channel, Notification } from "../model.js"

/** Sent to a `whatsapp:` address: drawn as a WhatsApp chat instead of a text thread. */
export const isWhatsApp = (n: Notification | undefined): boolean => n?.sms?.via === "whatsapp"

export const formatPhone = (value: string): string => {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value)
  if (us) return `+1 (${us[1]}) ${us[2]}-${us[3]}`
  return value
}

export const isPhone = (value: string): boolean => /^\+?\d[\d\s()-]{5,}$/.test(value)

/** A sender address without its `whatsapp:` channel prefix. */
export const bareAddress = (address: string): string => address.replace(/^whatsapp:/i, "")

export const displaySender = (n: Notification): string => {
  const address = bareAddress(n.from.address)
  return n.from.name ?? (isPhone(address) ? formatPhone(address) : address)
}

export const initials = (value: string): string => {
  const words = value
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return "?"
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase()
}

/** Avatar colors, as a webmail client picks them per sender. Part of the device skins. */
export const AVATAR = [
  "#1a73e8",
  "#e8710a",
  "#188038",
  "#d93025",
  "#9334e6",
  "#12b5cb",
  "#e52592",
  "#f9ab00",
  "#5f6368",
  "#a142f4",
]
/** App icon colors on the phones. */
export const APP = [
  "#ff9500",
  "#34c759",
  "#5856d6",
  "#ff2d55",
  "#007aff",
  "#af52de",
  "#ff3b30",
  "#30b0c7",
]
const hash = (value: string) => [...value].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
export const colorFor = (value: string, palette: string[] = AVATAR): string =>
  palette[hash(value) % palette.length] ?? "#5f6368"

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
export const clock = (d: Date): string =>
  d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
/** The status bar's clock: "9:41", no AM/PM. */
export const shortClock = (d: Date): string => clock(d).replace(/\s?[AP]M$/i, "")

/** Messages list: "9:41 AM", "Yesterday", "Tuesday", "11/2/26". */
export const iosListTime = (iso: string, now: number): string => {
  const d = new Date(iso)
  const today = new Date(now)
  if (sameDay(d, today)) return clock(d)
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (sameDay(d, y)) return "Yesterday"
  if (today.getTime() - d.getTime() < 6 * 864e5)
    return d.toLocaleDateString([], { weekday: "long" })
  return d.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" })
}

/** Conversation stamp: "Today" and "9:41 AM", or "Mon, Nov 9" and "at 9:41 AM". */
export const iosStamp = (iso: string, now: number): { day: string; time: string } => {
  const d = new Date(iso)
  if (sameDay(d, new Date(now))) return { day: "Today", time: clock(d) }
  return {
    day: d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
    time: `at ${clock(d)}`,
  }
}

export const ago = (iso: string, now: number): string => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const androidAgo = (iso: string, now: number): string => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Timeline: "9:41:00 AM" today, "Nov 8, 1:41 PM" before. */
export const timelineTime = (iso: string, now: number): string => {
  const d = new Date(iso)
  if (sameDay(d, new Date(now))) return d.toLocaleTimeString()
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  })
}

/** Mail list: "9:41 AM" today, "Nov 9" this year, "11/9/25" before. */
export const mailDate = (iso: string, now: number): string => {
  const d = new Date(iso)
  const today = new Date(now)
  if (sameDay(d, today)) return clock(d)
  if (d.getFullYear() === today.getFullYear())
    return d.toLocaleDateString([], { month: "short", day: "numeric" })
  return d.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" })
}

export const mailLongDate = (iso: string, now: number): string => {
  const d = new Date(iso)
  const full = d.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  const since = ago(iso, now)
  return `${full} (${since === "now" ? "0 minutes ago" : since})`
}

/** Chat day divider: "Today", "Yesterday", "Monday, November 9". */
export const chatDay = (iso: string, now: number): string => {
  const d = new Date(iso)
  const today = new Date(now)
  if (sameDay(d, today)) return "Today"
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (sameDay(d, y)) return "Yesterday"
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
}

/** `#alerts` as it is; an incoming webhook by the end of its path. */
export const chatLabel = (to: string): string =>
  to.startsWith("/services/") ? `Webhook …${to.slice(-6)}` : to

export const SERVICE_LABEL: Record<string, string> = {
  twilio: "Twilio",
  resend: "Resend",
  fcm: "FCM",
  ses: "SES",
  sns: "SNS",
  customerio: "Customer.io",
  mailosaur: "Mailosaur",
  slack: "Slack",
  cognito: "Cognito",
}

export const serviceLabel = (service: string): string => SERVICE_LABEL[service] ?? service

export const CHANNEL_LABEL: Record<Channel, string> = {
  sms: "SMS",
  push: "Push",
  email: "Email",
  chat: "Chat",
}

/** The one-time code iOS would offer above the keyboard: Verify's, or a 4–8 digit run in a code-like text. */
export const otpOf = (n: Notification): string | null =>
  n.sms?.code ??
  (/\b(code|otp|passcode|pin|verif)/i.test(n.sms?.body ?? "")
    ? (/\b(\d{4,8})\b/.exec(n.sms?.body ?? "")?.[1] ?? null)
    : null)

/** A push token, shortened for a picker: "ios-7f3a9c…2e1b5d · ios". */
export const tokenLabel = (token: string, platform?: string): string => {
  const short = token.length > 22 ? `${token.slice(0, 10)}…${token.slice(-8)}` : token
  return `${short}${platform && platform !== "unknown" ? ` · ${platform}` : ""}`
}

/** What a notification's status means, for its status chip. */
export const statusKind = (
  status: string | null,
): "ok" | "warning" | "error" | "info" | "neutral" => {
  const s = (status ?? "").toLowerCase()
  if (!s) return "neutral"
  if (/fail|error|undeliver|bounce|reject|complain/.test(s)) return "error"
  if (/deliver|sent|success|read|ok/.test(s)) return "ok"
  if (/queue|accept|pending|sending|schedul/.test(s)) return "info"
  return "neutral"
}

/** The attributes every element showing one notification carries (see the README's e2e section). */
export const notificationAttrs = (
  n: Notification,
  unread: boolean,
): Record<`data-${string}`, string> => ({
  "data-notification-id": n.id,
  "data-channel": n.channel,
  "data-service": n.service,
  "data-source": n.source,
  "data-to": n.to,
  "data-from": n.from.address,
  "data-status": n.status ?? "",
  "data-created-at": n.createdAt,
  "data-unread": String(unread),
  ...(isWhatsApp(n) ? { "data-via": "whatsapp" } : {}),
})
