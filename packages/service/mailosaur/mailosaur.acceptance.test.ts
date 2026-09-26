/**
 * S5.3 acceptance, driven through the port of our consumer (`test/consumer.ts`): the backend's
 * `MailosaurClient` on the unmodified `mailosaur@11.1.0` SDK, the `mailosaur.confirmation-code`
 * dev-tools command and the QA world's `waitForMailosaurConfirmationCode`.
 *
 * The SDK reaches the mock through the mock's CONNECT proxy (`HTTPS_PROXY` while the client is
 * constructed) with its default base URL: the SDK drops a base URL's port, so a G-M1
 * `MAILOSAUR_BASE_URL` alone only works if the mock listens on 443.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import tls from "node:tls"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createServer, type MailosaurServer } from "./src/server.js"
import {
  cognitoVerificationEmail,
  confirmationCodeCommand,
  MailosaurClient,
  waitForMailosaurConfirmationCode,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const SERVER_ID = "qa7x2k9m"
const EMAIL_HOST = `${SERVER_ID}.mailosaur.net`

let server: MailosaurServer
const trust = tls as unknown as {
  getCACertificates(kind: "default"): string[]
  setDefaultCACertificates(certs: string[]): void
}
let previousCa: string[] = []

const client = (apiKey = "qa-api-key") => {
  process.env.HTTPS_PROXY = server.proxyUrl
  try {
    return new MailosaurClient({ apiKey, serverId: SERVER_ID, emailHost: EMAIL_HOST })
  } finally {
    // Bun caches a proxy it has seen until the variable is set to "" (a bare delete keeps it).
    process.env.HTTPS_PROXY = ""
    delete process.env.HTTPS_PROXY
  }
}

/** What Cognito (or the Resend mock's `--forward-to-inbox`) does: POST the mail to the ingest route. */
const deliver = async (body: Record<string, unknown>, namespace = "default") => {
  const response = await fetch(`${server.url}/__admin/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; received: string }
}

beforeAll(async () => {
  server = await createServer({ tls: true })
  previousCa = trust.getCACertificates("default")
  trust.setDefaultCACertificates([...previousCa, server.cert as string])
})

afterAll(async () => {
  trust.setDefaultCACertificates(previousCa)
  await server.close()
})

describe("S5.3 acceptance: our consumer's logic against the mock", () => {
  test("messages.get returns within 50 ms of a message arriving", async () => {
    await server.runtime.reset("*")
    const mailosaur = client()
    // The same search + getById round trips for mail already there: transport and scheduler
    // cost the mock does not control. Mail landing just after a poll left also waits out that
    // in-flight empty search (at most one more round trip), so the 50 ms bound is what the mock
    // itself adds on top.
    const early = mailosaur.emailAddressWithLocalPart("member-app-early")
    server.runtime.instance().ingest({ to: early, ...cognitoVerificationEmail("104729") })
    const started = performance.now()
    await waitForMailosaurConfirmationCode({
      client: mailosaur,
      email: early,
      receivedAfter: new Date(0),
      timeoutMs: 10_000,
    })
    const baseline = performance.now() - started
    const email = mailosaur.emailAddressWithLocalPart("member-app-late")
    const receivedAfter = new Date()
    const pending = waitForMailosaurConfirmationCode({
      client: mailosaur,
      email,
      receivedAfter,
      timeoutMs: 10_000,
    }).then((code) => ({ code, at: performance.now() }))
    await Bun.sleep(400)
    const arrived = performance.now()
    server.runtime.instance().ingest({ to: email, ...cognitoVerificationEmail("604218") })
    const { code, at } = await pending
    expect(code).toBe("604218")
    expect(at - arrived).toBeLessThan(2 * baseline + 50)
  })

  test("code extraction matches Mailosaur's codes[] for the Cognito verification template", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 999_999 }).map((n) => String(n).padStart(6, "0")),
        fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
        async (code, local) => {
          await server.runtime.reset("*")
          const mailosaur = client()
          const email = mailosaur.emailAddressWithLocalPart(local)
          const message = server.runtime
            .instance()
            .ingest({ to: email, ...cognitoVerificationEmail(code) })
          // What Mailosaur itself reports for this template...
          expect(message.html.codes).toEqual([{ value: code }])
          expect(message.text.codes).toEqual([{ value: code }])
          // ...and what our consumer makes of it: the SDK's parsed codes win, no regex fallback.
          const got = await mailosaur.getConfirmationCode({ sentTo: email, timeoutMs: 2_000 })
          expect(got).toBe(code)
          expect(mailosaur.lastSource).toBe("sdk-codes")
        },
      ),
      { ...params, numRuns: params.numRuns ?? 15 },
    )
  }, 60_000)

  test("html.codes win over text.codes, and non-6-digit codes are skipped", async () => {
    await server.runtime.reset("*")
    const mailosaur = client()
    const email = mailosaur.emailAddressWithLocalPart("precedence")
    const message = server.runtime.instance().ingest({
      to: email,
      subject: "Your verification code",
      html: "<p>Order 4412 — your verification code is <strong>135790</strong></p>",
      text: "Your verification code is 246802",
    })
    expect(message.html.codes.map((c) => c.value)).toEqual(["4412", "135790"])
    expect(await mailosaur.getConfirmationCode({ sentTo: email, timeoutMs: 2_000 })).toBe("135790")
  })

  test("the signup flow passes end to end with no request to mailosaur.com", async () => {
    await server.runtime.reset("*")
    const mailosaur = client()
    const email = mailosaur.emailAddressWithLocalPart("member-app-mb2xk1q3a9f0")
    // A stale code from an earlier attempt must not be returned (receivedAfter).
    await deliver({ to: email, ...cognitoVerificationEmail("111111") })
    server.runtime.clock.advance(2_000)
    const receivedAfter = new Date(server.runtime.clock.now() - 1_000)
    await deliver({ to: email, ...cognitoVerificationEmail("222222") })
    const code = await waitForMailosaurConfirmationCode({
      client: mailosaur,
      email: email.toUpperCase(),
      receivedAfter,
    })
    expect(code).toBe("222222")
    // Every SDK call (default base URL https://mailosaur.com/) landed in the mock.
    const journal = (await (await fetch(`${server.url}/__admin/requests`)).json()) as {
      requests: { operationId?: string }[]
    }
    expect(journal.requests.map((r) => r.operationId)).toEqual(
      expect.arrayContaining(["SearchMessages", "GetMessage"]),
    )
    await mailosaur.deleteAllMessages()
    expect(server.runtime.instance().messages()).toEqual([])
    server.runtime.clock.reset()
  })

  test("nothing arriving surfaces the SDK's timeout through the dev-tools command", async () => {
    await server.runtime.reset("*")
    const mailosaur = client()
    const started = performance.now()
    await expect(
      confirmationCodeCommand(mailosaur, {
        email: mailosaur.emailAddressWithLocalPart("never"),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ errorType: "search_timeout" })
    expect(performance.now() - started).toBeLessThan(3_000)
    await expect(confirmationCodeCommand(mailosaur, { email: "not-an-email" })).rejects.toThrow(
      "Missing or invalid email in request body",
    )
    await expect(
      confirmationCodeCommand(mailosaur, { email: "a@b.co", timeoutMs: 500 }),
    ).rejects.toThrow("timeoutMs must be an integer between 1000 and 120000")
  })

  test("a message without any 6-digit code is the consumer's extraction error", async () => {
    await server.runtime.reset("*")
    const mailosaur = client()
    const email = mailosaur.emailAddressWithLocalPart("nocode")
    await deliver({ to: email, subject: "Welcome", html: "<p>Welcome aboard</p>", text: "Welcome" })
    await expect(
      mailosaur.getConfirmationCode({ sentTo: email, timeoutMs: 2_000 }),
    ).rejects.toThrow("Could not extract a 6-digit confirmation code from the Mailosaur message")
  })

  test("deleteMessage removes one message; the next wait no longer sees it", async () => {
    await server.runtime.reset("*")
    const mailosaur = client()
    const email = mailosaur.emailAddressWithLocalPart("delete-one")
    const { id } = await deliver({ to: email, ...cognitoVerificationEmail("909090") })
    await mailosaur.deleteMessage(id)
    await expect(
      mailosaur.getConfirmationCode({ sentTo: email, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ errorType: "search_timeout" })
  })

  test("parallel CI workers with their own API keys never read each other's codes", async () => {
    await server.runtime.reset("*")
    await fetch(`${server.url}/__admin/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentials: { "key-shard-1": "shard-1", "key-shard-2": "shard-2" } }),
    })
    const one = client("key-shard-1")
    const two = client("key-shard-2")
    const email = one.emailAddressWithLocalPart("run-42-api-1-w0-shared")
    await deliver({ to: email, ...cognitoVerificationEmail("121212") }, "shard-1")
    await deliver({ to: email, ...cognitoVerificationEmail("343434") }, "shard-2")
    expect(await one.getConfirmationCode({ sentTo: email, timeoutMs: 2_000 })).toBe("121212")
    expect(await two.getConfirmationCode({ sentTo: email, timeoutMs: 2_000 })).toBe("343434")
  })
})
