import type { Notifier } from "../../app/ports/notifier.js"
import { createFcmMockPush } from "./fcmMockPush.js"
import { createResendMockEmail } from "./resendMockEmail.js"
import { createTwilioMockSms } from "./twilioMockSms.js"

/**
 * Implements `Notifier` with one emulator per channel: Resend for email,
 * Twilio for SMS, FCM for push. `runtimes` are the emulators themselves, so
 * the notification harness reads exactly what the app sent.
 */
export const createMockNotifier = () => {
  const email = createResendMockEmail()
  const sms = createTwilioMockSms()
  const push = createFcmMockPush()
  const client: Notifier = {
    sendEmail: email.sendEmail,
    sendSms: sms.sendSms,
    sendPush: push.sendPush,
  }
  return {
    client,
    runtimes: { twilio: sms.runtime, resend: email.runtime, fcm: push.runtime },
    admins: [sms.admin, email.admin, push.admin],
  }
}
