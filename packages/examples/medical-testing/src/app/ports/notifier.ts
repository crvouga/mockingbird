/**
 * Outbound messages, shaped after real providers: a transactional email API
 * (Resend, Postmark, SES), a messaging API (Twilio Messages, for SMS and
 * WhatsApp), a push API (FCM HTTP v1) and a team chat API (Slack
 * `chat.postMessage`). Each call resolves once the provider accepted the
 * message and rejects when it refused it.
 */
export type OutboundEmail = { to: string; subject: string; html: string; text: string }
export type OutboundSms = {
  /** E.164, for example `+14155550100`. */
  to: string
  body: string
  /** `whatsapp` delivers to the same number over WhatsApp. Default `sms`. */
  channel?: "sms" | "whatsapp"
}
export type OutboundPush = {
  /** A registration token the patient's device got from the push provider. */
  deviceToken: string
  title: string
  body: string
  /** What the mobile app needs to open the right screen. */
  data?: Record<string, string>
}
export type OutboundChat = {
  /** A staff channel, for example `#lab-orders`. */
  channel: string
  /** The plain-text fallback, shown in notifications and by clients that cannot draw blocks. */
  text: string
  /** Rich layout blocks (Slack Block Kit), passed through as is. */
  blocks?: unknown[]
}

export interface Notifier {
  sendEmail(message: OutboundEmail): Promise<void>
  sendSms(message: OutboundSms): Promise<void>
  sendPush(message: OutboundPush): Promise<void>
  sendChat(message: OutboundChat): Promise<void>
}
