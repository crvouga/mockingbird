/**
 * Patient notifications, shaped after real providers: a transactional email
 * API (Resend, Postmark, SES), an SMS API (Twilio Messages) and a push API
 * (FCM HTTP v1). Each call resolves once the provider accepted the message
 * and rejects when it refused it.
 */
export type OutboundEmail = { to: string; subject: string; html: string; text: string }
export type OutboundSms = { to: string; body: string }
export type OutboundPush = {
  /** A registration token the patient's device got from the push provider. */
  deviceToken: string
  title: string
  body: string
  data?: Record<string, string>
}

export interface Notifier {
  sendEmail(message: OutboundEmail): Promise<void>
  sendSms(message: OutboundSms): Promise<void>
  sendPush(message: OutboundPush): Promise<void>
}
