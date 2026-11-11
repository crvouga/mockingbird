import { createRuntime } from "@crvouga/mockingbird-service-twilio"
import type { OutboundSms } from "../../app/ports/notifier.js"
import type { MockAdmin } from "../admin.js"

/** Twilio's fixture test account and a Twilio "magic" sender number. */
const ACCOUNT_SID = "AC00000000000000000000000000000000"
const AUTH_TOKEN = "cove-demo-auth-token"
const FROM = "+15005550006"
const BASE_URL = "https://api.twilio.com"

/**
 * Texts through Mockingbird's in-process Twilio emulator with the same call
 * a production integration makes: `POST /2010-04-01/Accounts/{sid}/Messages.json`,
 * form-encoded, with HTTP Basic auth. The emulator routes by the request's
 * `api.twilio.com` host, so the URL is the real one.
 */
export const createTwilioMockSms = () => {
  const runtime = createRuntime()

  const sendSms = async (message: OutboundSms): Promise<void> => {
    const response = await runtime.fetch(
      new Request(`${BASE_URL}/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: message.to, From: FROM, Body: message.body }),
      }),
    )
    if (!response.ok) throw new Error(`Twilio rejected the SMS (${response.status})`)
  }

  const admin: MockAdmin = { id: "twilio", label: "Twilio", fetch: (r) => runtime.fetch(r) }
  return { sendSms, runtime, admin }
}
