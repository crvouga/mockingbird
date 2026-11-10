import { createRuntime } from "@crvouga/mockingbird-service-resend"
import type { OutboundEmail } from "../../app/ports/notifier.js"
import type { MockAdmin } from "../admin.js"

const API_KEY = "re_cove_demo"
const FROM = "Cove Lab testing <care@cove.example>"
const BASE_URL = "https://api.resend.com"

/**
 * Emails through Mockingbird's in-process Resend emulator with the call the
 * Resend SDK makes: `POST /emails`, JSON, Bearer API key.
 */
export const createResendMockEmail = () => {
  const runtime = createRuntime()

  const sendEmail = async (message: OutboundEmail): Promise<void> => {
    const response = await runtime.fetch(
      new Request(`${BASE_URL}/emails`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: FROM,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      }),
    )
    if (!response.ok) throw new Error(`Resend rejected the email (${response.status})`)
  }

  const admin: MockAdmin = { id: "resend", label: "Resend", fetch: (r) => runtime.fetch(r) }
  return { sendEmail, runtime, admin }
}
