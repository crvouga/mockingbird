import { createRuntime } from "@crvouga/mockingbird-service-twilio"
import type { OutboundSms } from "../../app/ports/notifier.js"
import type {
  PhoneVerificationCheck,
  PhoneVerificationStart,
  PhoneVerifier,
} from "../../app/ports/phoneVerifier.js"
import type { MockAdmin } from "../admin.js"

/** Twilio's fixture test account, a Twilio "magic" sender number and the fixture Verify service. */
const ACCOUNT_SID = "AC00000000000000000000000000000000"
const AUTH_TOKEN = "cove-demo-auth-token"
const FROM = "+15005550006"
const VERIFY_SERVICE_SID = "VA00000000000000000000000000000000"
const MESSAGES_URL = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`
const VERIFY_URL = `https://verify.twilio.com/v2/Services/${VERIFY_SERVICE_SID}`

/**
 * Texts through Mockingbird's in-process Twilio emulator with the same calls
 * a production integration makes, form-encoded with HTTP Basic auth. The
 * emulator routes by the request's host, so the URLs are the real ones:
 *
 * - `api.twilio.com` `POST …/Messages.json` for SMS, and for WhatsApp when
 *   both numbers carry the `whatsapp:` prefix;
 * - `verify.twilio.com` `POST …/Verifications` and `…/VerificationCheck` for
 *   one-time codes. Twilio Verify generates, delivers, expires and
 *   rate-limits the code; the app never sees or stores it.
 */
export const createTwilioMockSms = () => {
  const runtime = createRuntime()

  const post = (url: string, form: Record<string, string>): Promise<Response> =>
    runtime.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form),
      }),
    )

  const sendSms = async (message: OutboundSms): Promise<void> => {
    const prefix = message.channel === "whatsapp" ? "whatsapp:" : ""
    const response = await post(MESSAGES_URL, {
      To: `${prefix}${message.to}`,
      From: `${prefix}${FROM}`,
      Body: message.body,
    })
    if (!response.ok) throw new Error(`Twilio rejected the message (${response.status})`)
  }

  const errorCode = async (response: Response): Promise<number | undefined> =>
    ((await response.json().catch(() => ({}))) as { code?: number }).code

  const verifier: PhoneVerifier = {
    start: async ({ to, channel }): Promise<PhoneVerificationStart> => {
      const response = await post(`${VERIFY_URL}/Verifications`, { To: to, Channel: channel })
      if (response.ok) return "sent"
      if (response.status === 429) return "too_many_requests"
      if (response.status === 400) return "invalid_number"
      throw new Error(`Twilio Verify rejected the request (${response.status})`)
    },
    check: async ({ to, code }): Promise<PhoneVerificationCheck> => {
      const response = await post(`${VERIFY_URL}/VerificationCheck`, { To: to, Code: code })
      if (response.ok)
        return ((await response.json()) as { status?: string }).status === "approved"
          ? "approved"
          : "incorrect"
      // Twilio deletes a verification once it is approved, expired or exhausted.
      if (response.status === 404) return "expired"
      if (response.status === 429 || (await errorCode(response)) === 60202)
        return "too_many_attempts"
      throw new Error(`Twilio Verify rejected the check (${response.status})`)
    },
  }

  const admin: MockAdmin = { id: "twilio", label: "Twilio", fetch: (r) => runtime.fetch(r) }
  return { sendSms, verifier, runtime, admin }
}
