import { DEFAULT_TOKEN, createRuntime as openai } from "@crvouga/mockingbird-service-openai"
import { createRuntime as resend } from "@crvouga/mockingbird-service-resend"
import { createRuntime as s3 } from "@crvouga/mockingbird-service-s3"
import { createRuntime as slack } from "@crvouga/mockingbird-service-slack"
import { createRuntime as stripe } from "@crvouga/mockingbird-service-stripe"
import { createRuntime as twilio } from "@crvouga/mockingbird-service-twilio"

/** One emulator per vendor. Each is a Fetch handler with its own state, in this process. */
const hosts: Record<string, { fetch(request: Request): Promise<Response> }> = {
  "api.stripe.com": stripe(),
  "api.twilio.com": twilio(),
  "api.openai.com": openai({
    // What the model says is the test's to decide.
    scripts: [{ kind: "chat", message: { role: "assistant", content: "One starter kit, paid." } }],
  }),
  "slack.com": slack(),
  "api.resend.com": resend(),
  "s3.us-east-1.amazonaws.com": s3({ buckets: ["receipts"] }),
}

/** A `fetch` that never leaves the process: the vendor's hostname picks the emulator. */
export const fetch = (url: string, init?: RequestInit): Promise<Response> => {
  const emulator = hosts[new URL(url).host]
  if (!emulator) throw new Error(`no emulator for ${url}`)
  return emulator.fetch(new Request(url, init))
}

/** Credentials the emulators accept. No vendor issued them. */
export const keys = {
  stripe: "sk_test_mockingbird",
  twilio: { accountSid: "AC00000000000000000000000000000000", authToken: "fixture-token" },
  openai: DEFAULT_TOKEN,
  slack: "xoxb-fixture",
  resend: "re_fixture",
}
