import type { UpstreamOptions } from "@crvouga/mockingbird-service"
import type { Notifier } from "../../app/ports/notifier.js"
import { createFcmMockPush } from "./fcmMockPush.js"
import { createResendMockEmail } from "./resendMockEmail.js"
import { createSlackMockChat } from "./slackMockChat.js"
import { createTwilioMockSms } from "./twilioMockSms.js"

/**
 * Implements `Notifier` with one emulator per channel: Resend for email,
 * Twilio for SMS and WhatsApp, FCM for push, Slack for staff chat. Twilio
 * also backs `phoneVerifier` (Twilio Verify). `runtimes` are the emulators
 * themselves, so the notification harness reads exactly what the app sent.
 * `upstream` gives a channel's emulator a transport to the vendor's sandbox,
 * which the System screen can switch it to.
 */
export const createMockNotifier = (
  upstream: (service: string) => UpstreamOptions | undefined = () => undefined,
) => {
  const email = createResendMockEmail(upstream("resend"))
  const sms = createTwilioMockSms(upstream("twilio"))
  const push = createFcmMockPush(upstream("fcm"))
  const chat = createSlackMockChat(upstream("slack"))
  const client: Notifier = {
    sendEmail: email.sendEmail,
    sendSms: sms.sendSms,
    sendPush: push.sendPush,
    sendChat: chat.sendChat,
  }
  return {
    client,
    phoneVerifier: sms.verifier,
    runtimes: {
      twilio: sms.runtime,
      resend: email.runtime,
      fcm: push.runtime,
      slack: chat.runtime,
    },
    admins: [sms.admin, email.admin, push.admin, chat.admin],
  }
}
