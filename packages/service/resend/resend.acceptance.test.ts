/**
 * S9.6 acceptance (plus the inbound path of S9.4 and the S5 forwarding hand-off), driven through
 * the ports of our consumers in `test/consumer.ts` with the real `resend@4.8.0` SDK against the
 * served mock (test/stack.ts).
 */
import { describe, expect, test } from "bun:test"
import { SearchCriteria } from "mailosaur/models"
import {
  downloadWithinLimit,
  EmailChannel,
  EmailDeliveryError,
  EmrEmailService,
  FamiliesHttpError,
  inviteAdult,
  ResendInboundEmailClient,
  receiveInboundWebhook,
  SendEmailsService,
} from "./test/consumer.js"
import { admin, isolatedKey, mailosaurClient, sharedStack } from "./test/stack.js"

const MEMBER_APP = "http://127.0.0.1:8081"
const EMR_APP = "http://127.0.0.1:3001"
const WEBHOOK_SECRET = `whsec_${Buffer.from("care-chat-inbound-secret-32bytes").toString("base64")}`

type Outboxed = {
  id: string
  to: string[]
  subject: string
  tags: { name: string; value: string }[]
  headers: Record<string, string>
}

const outbox = async (namespace: string, query = "") =>
  ((await (await admin(`/outbox${query}`, namespace)).json()) as { messages: Outboxed[] }).messages

const links = async (namespace: string, id: string) =>
  ((await (await admin(`/outbox/${id}/links`, namespace)).json()) as { links: string[] }).links

describe("S9.6 acceptance: our consumers' logic against the mock", () => {
  test("a family invite lands in the outbox and its invite link resolves to the member app's claim route", async () => {
    const { Resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("family-invite")
    const emails = new SendEmailsService(Resend, {
      RESEND_API_KEY: key,
      SYSTEM_APP_DEPLOYMENT_URL: MEMBER_APP,
    })
    const token = "fam_tok_9QxL2vB7"
    await inviteAdult(emails, {
      inviteeEmail: "invitee@example.com",
      guardianName: "Grace Hopper",
      token,
    })
    const [email] = await outbox(namespace, "?to=invitee@example.com")
    expect(email?.subject).toBe("Grace Hopper invited you to join their Geviti family")
    const [invite] = await links(namespace, email?.id as string)
    const url = new URL(invite as string)
    expect(url.origin).toBe(MEMBER_APP)
    expect(url.pathname).toBe("/family/invitations/claim")
    expect(url.searchParams.get("token")).toBe(token)
  })

  test("an EMR team invite carries a /sign-up?invite= link and its category tag", async () => {
    const { Resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("emr-invite")
    const emr = new EmrEmailService(Resend, {
      apiKey: key,
      fromEmail: "Geviti EMR <team@gogeviti.com>",
      appUrl: EMR_APP,
    })
    await emr.sendTeamMemberInvitation({
      inviteKey: {
        id: "ik_01",
        key: "INV-7F3K-22QP",
        userType: "Provider",
        expiresAt: "2026-10-01T00:00:00.000Z",
        role: "Provider",
      },
      inviterName: "Dr. Admin",
      organizationName: "Geviti Clinic",
      recipientEmail: "new.provider@example.com",
      firstName: "Nia",
    })
    const [email] = await outbox(namespace, "?tag=category:team-invitation")
    expect(email?.to).toEqual(["new.provider@example.com"])
    expect(email?.tags).toContainEqual({ name: "invite_key_id", value: "ik_01" })
    const [signUp] = await links(namespace, email?.id as string)
    const url = new URL(signUp as string)
    expect(`${url.origin}${url.pathname}`).toBe(`${EMR_APP}/sign-up`)
    expect(url.searchParams.get("invite")).toBe("INV-7F3K-22QP")
    expect(url.searchParams.get("type")).toBe("provider")
    expect(url.searchParams.get("email")).toBe("new.provider@example.com")
    expect(await outbox(namespace, "?tag=category:welcome")).toEqual([])
  })

  test("send_422: sendEmail throws EmailDeliveryError and the families spec sees a typed 502", async () => {
    const { Resend, resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("send-422")
    resend.runtime.applyPreset("send_422", namespace, { count: 2 })
    const emails = new SendEmailsService(Resend, {
      RESEND_API_KEY: key,
      SYSTEM_APP_DEPLOYMENT_URL: MEMBER_APP,
    })
    // The service swallows EmailDeliveryError into {success: false, message}...
    const direct = await emails.sendFamilyAdultInvitationEmail({
      toEmail: "x@example.com",
      inviterName: "G",
      token: "t",
      expiresInDays: 7,
    })
    expect(direct.success).toBe(false)
    expect(new EmailDeliveryError(direct.success ? "" : direct.message).name).toBe(
      "EmailDeliveryError",
    )
    // ...and the families caller turns it into the typed 502.
    const failure = await inviteAdult(emails, {
      inviteeEmail: "x@example.com",
      guardianName: "G",
      token: "t",
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(FamiliesHttpError)
    expect(failure).toMatchObject({
      status: 502,
      response: { code: "ADULT_INVITATION_EMAIL_FAILED" },
    })
    expect(await outbox(namespace)).toEqual([])
  })

  test("the EMR ignores result.error: a failed invite is visible only as a missing outbox entry", async () => {
    const { Resend, resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("emr-silent")
    resend.runtime.applyPreset("send_422", namespace, { count: 1 })
    const emr = new EmrEmailService(Resend, {
      apiKey: key,
      fromEmail: "team@gogeviti.com",
      appUrl: EMR_APP,
    })
    await emr.sendTeamMemberInvitation({
      inviteKey: { id: "i", key: "K", userType: "Admin", expiresAt: "2026-10-01", role: "Admin" },
      inviterName: "A",
      organizationName: "O",
      recipientEmail: "silent@example.com",
    })
    expect(await outbox(namespace)).toEqual([])
  })

  test("the dispatcher's Idempotency-Key replays: one outbox entry, the same resend id", async () => {
    const { Resend, resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("dispatcher")
    const channel = new EmailChannel(Resend, {
      apiKey: key,
      fromEmail: "Geviti <hello@gogeviti.com>",
    })
    const job = {
      to: "member@example.com",
      subject: "Your results are ready",
      html: '<p>See <a href="https://app.gogeviti.com/results">results</a></p>',
      tags: ["results-ready"],
      correlationId: "notif:results:user-17",
      dedupeKey: "results:user-17",
      unsubscribeUrl: "https://api.gogeviti.com/unsubscribe?t=abc",
    }
    const first = await channel.send(job)
    const retried = await channel.send(job)
    expect(retried).toBe(first as string)
    const entries = await outbox(namespace)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.tags).toEqual([{ name: "category", value: "results-ready" }])
    expect(entries[0]?.headers["List-Unsubscribe"]).toBe(
      "<https://api.gogeviti.com/unsubscribe?t=abc>",
    )
    const stored = resend.runtime.instance(namespace).sent()[0]
    expect(stored?.idempotencyKey).toBe("notif_results_user-17")
    resend.runtime.applyPreset("send_429", namespace, { count: 1 })
    await expect(channel.send({ ...job, correlationId: "other" })).rejects.toThrow(
      /^Resend API error: Too many requests/,
    )
  })

  test("--forward-to-inbox: the sent email is readable through the Mailosaur SDK and its 6-digit code extracted", async () => {
    const { Resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("forward")
    const sent = await new Resend(key).emails.send({
      from: "Geviti <no-reply@gogeviti.com>",
      to: "reset-user@qa7x2k9m.mailosaur.net",
      subject: "Your password reset code",
      html: "<p>Your verification code is <strong>731946</strong>. It expires in 10 minutes.</p>",
      text: "Your verification code is 731946. It expires in 10 minutes.",
    })
    expect(sent.error).toBeNull()
    const mailosaur = await mailosaurClient(key)
    const message = await mailosaur.messages.get(
      "qa7x2k9m",
      new SearchCriteria({ sentTo: "reset-user@qa7x2k9m.mailosaur.net" }),
      { timeout: 2_000 },
    )
    expect(message.subject).toBe("Your password reset code")
    expect(message.html?.codes?.map((c) => c.value)).toEqual(["731946"])
    // The consumer's rule: the first 6-digit code in html.codes, then text.codes.
    const code = [...(message.html?.codes ?? []), ...(message.text?.codes ?? [])]
      .map((c) => c.value?.trim())
      .find((v) => v !== undefined && /^\d{6}$/.test(v))
    expect(code).toBe("731946")
    expect((await admin("/forwarding", namespace).then((r) => r.json())) as object).toMatchObject({
      failed: 0,
    })
  })
})

describe("S9.4 inbound: the signed email.received webhook through our receiver", () => {
  const sink = () => {
    const deliveries: { headers: Headers; body: Buffer }[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        deliveries.push({
          headers: request.headers,
          body: Buffer.from(await request.arrayBuffer()),
        })
        return Response.json({ ok: true })
      },
    })
    return { deliveries, url: `http://127.0.0.1:${server.port}/messaging/inbound/email`, server }
  }

  const route = async (namespace: string, url: string) => {
    const { resend } = await sharedStack()
    await fetch(`${resend.url}/__admin/webhook-endpoints`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
      body: JSON.stringify({ endpoints: [{ url, secret: WEBHOOK_SECRET }] }),
    })
  }

  test("verify, parse, hydrate text/html and attachments, download within the cap", async () => {
    const { resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("inbound")
    const hook = sink()
    try {
      await route(namespace, hook.url)
      const pdf = Buffer.from("%PDF-1.4 lab results")
      const created = await admin("/inbound", namespace, {
        from: "Ada Lovelace <ada@example.com>",
        to: ["care+tok_8f2a@care.gogeviti.com"],
        subject: "  Re: your results  ",
        text: "Thanks, see attached.",
        html: "<p>Thanks, see attached.</p>",
        headers: { To: "info@gogeviti.com" },
        attachments: [
          {
            filename: "results.pdf",
            content: pdf.toString("base64"),
            contentType: "application/pdf",
          },
        ],
      })
      expect(created.status).toBe(201)
      await resend.runtime.webhooks.idle()
      const [delivery] = hook.deliveries
      const client = new ResendInboundEmailClient(key, resend.url)
      const outcome = await receiveInboundWebhook({
        secret: WEBHOOK_SECRET,
        headers: delivery?.headers as Headers,
        rawBody: delivery?.body as Buffer,
        client,
      })
      if (outcome.status !== 200) throw new Error(`receiver answered ${outcome.status}`)
      expect(outcome.event.sender).toBe("ada@example.com")
      expect(outcome.event.recipients).toEqual(["care+tok_8f2a@care.gogeviti.com"])
      expect(outcome.event.subject).toBe("Re: your results")
      // The webhook carries no body (as Resend's): hydration fetched it.
      expect(outcome.event.text).toBeNull()
      expect(outcome.hydrated.text).toBe("Thanks, see attached.")
      expect(outcome.hydrated.html).toBe("<p>Thanks, see attached.</p>")
      const [attachment] = outcome.hydrated.attachments
      expect(attachment).toMatchObject({
        filename: "results.pdf",
        content_type: "application/pdf",
        size: pdf.length,
      })
      const bytes = await downloadWithinLimit(attachment?.download_url as string, 10 * 1024 * 1024)
      expect(Buffer.from(bytes as Uint8Array).equals(pdf)).toBe(true)
      expect(await downloadWithinLimit(attachment?.download_url as string, 4)).toBeNull()
    } finally {
      hook.server.stop(true)
    }
  })

  test("inline mode skips hydration; a wrong secret is 403; no secret is 404", async () => {
    const { resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("inbound-inline")
    const hook = sink()
    try {
      await route(namespace, hook.url)
      await admin("/inbound", namespace, {
        from: "p@example.com",
        to: "care+t@care.gogeviti.com",
        subject: "Hi",
        text: "inline body",
        inline: true,
      })
      await resend.runtime.webhooks.idle()
      const [delivery] = hook.deliveries
      let hydrations = 0
      const client = new ResendInboundEmailClient(key, resend.url, (request) => {
        hydrations++
        return fetch(request)
      })
      const outcome = await receiveInboundWebhook({
        secret: WEBHOOK_SECRET,
        headers: delivery?.headers as Headers,
        rawBody: delivery?.body as Buffer,
        client,
      })
      expect(outcome.status).toBe(200)
      expect(outcome.status === 200 && outcome.hydrated.text).toBe("inline body")
      expect(hydrations).toBe(0)
      const wrong = await receiveInboundWebhook({
        secret: `whsec_${Buffer.from("some-other-secret").toString("base64")}`,
        headers: delivery?.headers as Headers,
        rawBody: delivery?.body as Buffer,
        client,
      })
      expect(wrong).toEqual({ status: 403, code: "CARE_CHAT_INBOUND_EMAIL_INVALID_SIGNATURE" })
      const off = await receiveInboundWebhook({
        secret: "",
        headers: delivery?.headers as Headers,
        rawBody: delivery?.body as Buffer,
        client,
      })
      expect(off.status).toBe(404)
    } finally {
      hook.server.stop(true)
    }
  })

  test("receiving_500: hydration fails the way our client reports it", async () => {
    const { resend } = await sharedStack()
    const { key, namespace } = await isolatedKey("inbound-500")
    const hook = sink()
    try {
      await route(namespace, hook.url)
      await admin("/inbound", namespace, { from: "p@example.com", to: "care+t@care.gogeviti.com" })
      await resend.runtime.webhooks.idle()
      resend.runtime.applyPreset("receiving_500", namespace, { count: 1 })
      const [delivery] = hook.deliveries
      await expect(
        receiveInboundWebhook({
          secret: WEBHOOK_SECRET,
          headers: delivery?.headers as Headers,
          rawBody: delivery?.body as Buffer,
          client: new ResendInboundEmailClient(key, resend.url),
        }),
      ).rejects.toThrow("Resend inbound content could not be retrieved")
    } finally {
      hook.server.stop(true)
    }
  })
})
