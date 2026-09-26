/**
 * Ports of our Resend consumers, driven by the acceptance tests:
 *
 * - `SendEmailsService.sendEmail` + `sendFamilyAdultInvitationEmail`
 *   (`B/global-services/services/send-emails/send-emails.service.ts`) and the families caller
 *   that turns a failed invitation email into a typed 502 (`B/families/families.service.ts`);
 * - the EMR `EmailService.sendTeamMemberInvitation` (`E/services/email-service.ts`), which never
 *   checks `result.error`;
 * - the notification dispatcher's `EmailChannel.send` (`packages/notification-dispatcher/src/
 *   channels/email.ts`): `Idempotency-Key`, category tags, List-Unsubscribe headers;
 * - the inbound path: `verifyResendWebhookSignature` (`B/messaging/resend-inbound-webhook-
 *   signature.ts`), the controller's 404/403/400 decisions, `parseResendInboundEmailEvent`
 *   (`B/care-chat/inbound-email/resend-inbound-email.event.ts`, zod replaced by the same checks
 *   by hand), `ResendInboundEmailClient.hydrate` and the attachment download with its size cap.
 *
 * The SDK is passed in (not imported) because `resend@4.8.0` reads `RESEND_BASE_URL` once at
 * module load: tests set it, then `await import("resend")`.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import type { Resend as ResendClass } from "resend"

type ResendConstructor = typeof ResendClass
type SendPayload = Parameters<ResendClass["emails"]["send"]>[0]

// ---------------------------------------------------------------------------------------------
// Backend SendEmailsService

export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmailDeliveryError"
  }
}

const DEFAULT_FROM_ADDRESS = "Acme Platform <no-reply@acme.example>"

/**
 * What `FamilyAdultInvitationEmail` renders to (React Email's `Button` is an `<a>` with inline
 * styles; the SDK renders `react` to HTML client-side, so the API only ever sees HTML).
 */
export const familyAdultInvitationHtml = (props: {
  inviterName: string
  invitationUrl: string
  expiresInDays: number
}) =>
  `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html dir="ltr" lang="en"><head><meta content="text/html; charset=UTF-8" http-equiv="Content-Type"/></head><body style="background-color:#f4f6f8;font-family:Arial, sans-serif;margin:0"><div style="display:none">${props.inviterName} invited you to join their Acme family</div><table align="center" width="100%" style="background-color:#ffffff;border-radius:18px;margin:40px auto;max-width:560px;padding:40px"><tbody><tr><td><p style="color:#181a1c;font-size:28px;font-weight:600;margin-top:0">Join your Acme family</p><p style="color:#4b5563;font-size:16px;line-height:24px">${props.inviterName} invited you to create a Acme account and join their household.</p><a href="${props.invitationUrl.replace(/&/g, "&amp;")}" style="background-color:#99d4ff;border-radius:999px;color:#181a1c;display:block;font-weight:600;margin:28px 0;padding:14px 24px;text-align:center;text-decoration:none" target="_blank"><span>Create account and review invitation</span></a><p style="color:#6b7280;font-size:13px;line-height:20px">This invitation expires in ${props.expiresInDays} days. If you were not expecting it, you can ignore this email.</p></td></tr></tbody></table></body></html>`

export class SendEmailsService {
  constructor(
    private readonly Resend: ResendConstructor,
    private readonly config: { RESEND_API_KEY?: string; SYSTEM_APP_DEPLOYMENT_URL?: string },
  ) {}

  private async sendEmail(resend: ResendClass, payload: SendPayload) {
    const result = await resend.emails.send(payload)
    if (result.error) throw new EmailDeliveryError(result.error.message)
    return result
  }

  async sendFamilyAdultInvitationEmail({
    toEmail,
    inviterName,
    token,
    expiresInDays,
  }: {
    toEmail: string
    inviterName: string
    token: string
    expiresInDays: number
  }) {
    const resendKey = this.config.RESEND_API_KEY
    const appDeploymentUrl = this.config.SYSTEM_APP_DEPLOYMENT_URL
    if (!resendKey) throw new Error("RESEND_API_KEY is not configured.")
    if (!appDeploymentUrl) throw new Error("SYSTEM_APP_DEPLOYMENT_URL is not configured.")
    const invitationUrl = new URL("/family/invitations/claim", appDeploymentUrl)
    invitationUrl.searchParams.set("token", token)
    const resend = new this.Resend(resendKey)
    try {
      await this.sendEmail(resend, {
        from: DEFAULT_FROM_ADDRESS,
        to: [toEmail],
        subject: `${inviterName} invited you to join their Acme family`,
        html: familyAdultInvitationHtml({
          inviterName,
          invitationUrl: invitationUrl.toString(),
          expiresInDays,
        }),
      })
      return { success: true as const, invitationUrl: invitationUrl.toString() }
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : "An unexpected error occurred",
      }
    }
  }
}

/** The families service's typed failure: Nest's `HttpException` shape (`status`, `response`). */
export class FamiliesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly response: { code: string; message: string },
  ) {
    super(response.message)
  }
}

/**
 * `inviteAdult` → `notifyAdultEmailInvitee`: a failed email becomes `'failed'`, which the
 * service surfaces as 502 `ADULT_INVITATION_EMAIL_FAILED` (families.email-invitations spec).
 */
export const inviteAdult = async (
  emails: SendEmailsService,
  invite: { inviteeEmail: string; guardianName: string; token: string },
) => {
  let delivery: "sent" | "failed"
  try {
    const result = await emails.sendFamilyAdultInvitationEmail({
      toEmail: invite.inviteeEmail,
      inviterName: invite.guardianName,
      token: invite.token,
      expiresInDays: 7,
    })
    if (!result.success) {
      throw new Error(result.message ?? "Adult invitation email was not accepted")
    }
    delivery = "sent"
  } catch {
    delivery = "failed"
  }
  if (delivery === "failed") {
    throw new FamiliesHttpError(502, {
      code: "ADULT_INVITATION_EMAIL_FAILED",
      message: "The invitation was created but its email could not be sent",
    })
  }
  return { delivery }
}

// ---------------------------------------------------------------------------------------------
// EMR EmailService

export class EmrEmailService {
  private readonly resend: ResendClass

  constructor(
    Resend: ResendConstructor,
    private readonly config: { apiKey: string; fromEmail: string; appUrl: string },
  ) {
    this.resend = new Resend(config.apiKey)
  }

  async sendTeamMemberInvitation(data: {
    inviteKey: { id: string; key: string; userType: string; expiresAt: string; role: string }
    inviterName: string
    organizationName: string
    recipientEmail: string
    firstName?: string
  }): Promise<void> {
    const { inviteKey, inviterName, organizationName, recipientEmail } = data
    const role = inviteKey.role
    const urlParams = new URLSearchParams({
      invite: inviteKey.key,
      type: role.toLowerCase() === "health coach" ? "coach" : role.toLowerCase(),
      email: recipientEmail,
    })
    if (data.firstName) urlParams.set("firstName", data.firstName)
    const signUpUrl = `${this.config.appUrl}/sign-up?${urlParams.toString()}`
    const expirationDate = new Date(inviteKey.expiresAt).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })
    try {
      // The EMR never reads `result.error` (a failed send is invisible without an outbox).
      await this.resend.emails.send({
        from: this.config.fromEmail,
        to: [recipientEmail],
        subject: `Invitation to join ${organizationName} as ${role}`,
        html: `<!DOCTYPE html><html lang="en"><head><title>Welcome to ${organizationName}</title><style>.cta-button{display:inline-block}</style></head><body><div class="container"><div class="header"><div class="logo">Acme EMR</div><h1 class="title">You're Invited!</h1></div><div class="content"><p>Hello ${recipientEmail},</p><p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong> as a team member in our Electronic Medical Records system.</p><div style="text-align: center;"><a href="${signUpUrl}" class="cta-button">Accept Invitation & Sign Up</a></div><div class="expiration"><strong>⏰ Important:</strong> This invitation expires on <strong>${expirationDate}</strong>.</div><p style="word-break: break-all; color: #2563eb;">${signUpUrl}</p><p>Your invitation code (for reference): <span class="invite-code">${inviteKey.key}</span></p></div></div></body></html>`,
        text: `\nHello ${recipientEmail},\n\n${inviterName} has invited you to join ${organizationName} as a team member in our Electronic Medical Records system.\n\nTo accept this invitation and set up your account, please visit:\n${signUpUrl}\n\nIMPORTANT: This invitation expires on ${expirationDate}.\n`,
        tags: [
          { name: "category", value: "team-invitation" },
          { name: "user_type", value: inviteKey.userType },
          { name: "invite_key_id", value: inviteKey.id },
        ],
      })
    } catch (error) {
      throw new Error(
        `Failed to send invitation email: ${error instanceof Error ? error.message : "Unknown error"}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Notification dispatcher EmailChannel

const IDEMPOTENCY_KEY_MAX_LENGTH = 256

export type EmailNotificationJob = {
  to: string
  subject: string
  html?: string
  text?: string
  replyTo?: string
  tags?: string[]
  correlationId?: string
  dedupeKey: string
  unsubscribeUrl?: string
}

export const toIdempotencyKey = (job: EmailNotificationJob): string =>
  (job.correlationId ?? job.dedupeKey).replace(/:/g, "_").slice(0, IDEMPOTENCY_KEY_MAX_LENGTH)

export class EmailChannel {
  private readonly client: ResendClass

  constructor(
    Resend: ResendConstructor,
    private readonly creds: { apiKey: string; fromEmail: string },
  ) {
    this.client = new Resend(creds.apiKey)
  }

  async send(job: EmailNotificationJob) {
    const payload = {
      from: this.creds.fromEmail,
      to: job.to,
      subject: job.subject,
      html: job.html,
      text: job.text,
      replyTo: job.replyTo,
      tags: job.tags?.map((tag) => ({ name: "category", value: tag })),
      ...(job.unsubscribeUrl
        ? {
            headers: {
              "List-Unsubscribe": `<${job.unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }
        : {}),
    }
    const result = await this.client.emails.send(payload as SendPayload, {
      idempotencyKey: toIdempotencyKey(job),
    })
    if (result.error) throw new Error(`Resend API error: ${result.error.message}`)
    return result.data?.id
  }
}

// ---------------------------------------------------------------------------------------------
// Inbound: signature, controller, event parsing, hydration, attachment download

const SIGNING_SECRET_PREFIX = "whsec_"
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

const decodeBase64 = (value: string) => {
  if (!value || value.length % 4 === 1 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value)) return null
  const unpadded = value.replace(/=+$/, "")
  const decoded = Buffer.from(value, "base64")
  if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    return null
  }
  return decoded
}

export const verifyResendWebhookSignature = (params: {
  secret: string
  rawBody: Buffer
  svixId: string | undefined
  svixTimestamp: string | undefined
  svixSignature: string | undefined
  nowMs?: number
}) => {
  if (
    !params.secret.startsWith(SIGNING_SECRET_PREFIX) ||
    !params.svixId ||
    !params.svixTimestamp ||
    !params.svixSignature ||
    !/^\d+$/.test(params.svixTimestamp)
  ) {
    return false
  }
  const timestampSeconds = Number(params.svixTimestamp)
  const currentSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000)
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(currentSeconds - timestampSeconds) > TIMESTAMP_TOLERANCE_SECONDS
  ) {
    return false
  }
  const secret = decodeBase64(params.secret.slice(SIGNING_SECRET_PREFIX.length))
  if (!secret) return false
  const expected = createHmac("sha256", secret)
    .update(`${params.svixId}.${params.svixTimestamp}.`)
    .update(params.rawBody)
    .digest()
  return params.svixSignature.split(/\s+/).some((versioned) => {
    const [version, encoded] = versioned.split(",", 2)
    if (version !== "v1" || !encoded) return false
    const signature = decodeBase64(encoded)
    return (
      signature !== null &&
      signature.length === expected.length &&
      timingSafeEqual(signature, expected)
    )
  })
}

export type InboundAttachment = {
  id: string
  filename: string
  content_type: string
  content_disposition?: string | null
  content_id?: string | null
  size?: number
  download_url?: string
}

export type InboundEmailEvent = {
  providerEmailId: string
  internetMessageId: string
  sender: string
  recipients: string[]
  subject: string | null
  text: string | null
  html: string | null
  attachments: InboundAttachment[]
  receivedAt: Date
}

class InvalidPayload extends Error {}

const parseAddressHeader = (value: string) =>
  (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase()

/** `parseResendInboundEmailEvent`: the zod schema's checks, by hand. */
export const parseInboundEvent = (payload: unknown): InboundEmailEvent => {
  const fail = (why: string): never => {
    throw new InvalidPayload(why)
  }
  const root = payload as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> }
  if (root?.type !== "email.received") fail("type")
  const data = root.data ?? fail("data")
  const id = data.email_id
  if (typeof id !== "string" || id.length < 1 || id.length > 60 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    fail("email_id")
  }
  if (typeof data.from !== "string" || data.from.length < 1) fail("from")
  const to = data.to
  if (!Array.isArray(to) || to.length < 1 || to.length > 100) fail("to")
  const attachments = (data.attachments ?? []) as InboundAttachment[]
  for (const a of attachments) {
    if (!a.id || !a.filename || !a.content_type) fail("attachments")
    if (a.download_url !== undefined && !URL.canParse(a.download_url)) fail("download_url")
  }
  const receivedAt = new Date(
    String(data.created_at ?? root.created_at ?? new Date().toISOString()),
  )
  const messageId = typeof data.message_id === "string" ? data.message_id.trim() : ""
  return {
    providerEmailId: id as string,
    internetMessageId: messageId || (id as string),
    sender: parseAddressHeader(data.from as string),
    recipients: [...new Set((to as string[]).map(parseAddressHeader))],
    subject: typeof data.subject === "string" ? data.subject.trim() || null : null,
    text: (data.text as string | null | undefined) ?? null,
    html: (data.html as string | null | undefined) ?? null,
    attachments,
    receivedAt,
  }
}

/** `ResendInboundEmailClient` with G-R1's base URL instead of the hardcoded api.resend.com. */
export class ResendInboundEmailClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly send: (request: Request) => Promise<Response> = (r) => fetch(r),
  ) {}

  async hydrate(event: InboundEmailEvent) {
    const needsContent = event.text === null && event.html === null
    const needsAttachmentDetails = event.attachments.some(
      (attachment) => attachment.size === undefined || !attachment.download_url,
    )
    const [contentResult, attachmentResult] = await Promise.allSettled([
      needsContent ? this.fetchJson(`/emails/receiving/${event.providerEmailId}`) : null,
      needsAttachmentDetails && event.attachments.length > 0
        ? this.fetchJson(`/emails/receiving/${event.providerEmailId}/attachments`)
        : null,
    ])
    if (contentResult.status === "rejected") {
      throw new Error("Resend inbound content could not be retrieved")
    }
    if (attachmentResult.status === "rejected") {
      throw new Error("Resend inbound attachment metadata could not be retrieved")
    }
    const content = contentResult.value as { text?: string | null; html?: string | null } | null
    const listed = (attachmentResult.value as { data: InboundAttachment[] } | null)?.data
    return {
      text: event.text ?? content?.text ?? null,
      html: event.html ?? content?.html ?? null,
      attachments: listed ?? event.attachments,
    }
  }

  private async fetchJson(path: string): Promise<unknown> {
    const response = await this.send(
      new Request(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      }),
    )
    if (!response.ok) throw new Error(`Resend receiving API returned HTTP ${response.status}`)
    return response.json()
  }
}

/** `downloadWithinLimit`: `null` when the declared or streamed size exceeds `maxBytes`. */
export const downloadWithinLimit = async (
  url: string,
  maxBytes: number,
  send: (request: Request) => Promise<Response> = (r) => fetch(r),
) => {
  const response = await send(new Request(url, { signal: AbortSignal.timeout(15_000) }))
  if (!response.ok || !response.body) {
    throw new Error(`Attachment download returned HTTP ${response.status}`)
  }
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel()
    return null
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.length > maxBytes ? null : bytes
}

/**
 * `MessagingInboundEmailController.receive`: 404 without a configured secret, 403 on a bad
 * signature, 400 on an invalid payload, else hydrate and hand over.
 */
export const receiveInboundWebhook = async (args: {
  secret: string
  headers: Headers
  rawBody: Buffer
  client: ResendInboundEmailClient
}): Promise<
  | { status: 404 | 403 | 400; code: string }
  | {
      status: 200
      event: InboundEmailEvent
      hydrated: Awaited<ReturnType<ResendInboundEmailClient["hydrate"]>>
    }
> => {
  if (!args.secret) return { status: 404, code: "CARE_CHAT_INBOUND_EMAIL_UNAVAILABLE" }
  const verified = verifyResendWebhookSignature({
    secret: args.secret,
    rawBody: args.rawBody,
    svixId: args.headers.get("svix-id") ?? undefined,
    svixTimestamp: args.headers.get("svix-timestamp") ?? undefined,
    svixSignature: args.headers.get("svix-signature") ?? undefined,
  })
  if (!verified) return { status: 403, code: "CARE_CHAT_INBOUND_EMAIL_INVALID_SIGNATURE" }
  let event: InboundEmailEvent
  try {
    event = parseInboundEvent(JSON.parse(args.rawBody.toString("utf8")))
  } catch {
    return { status: 400, code: "CARE_CHAT_INBOUND_EMAIL_INVALID_PAYLOAD" }
  }
  return { status: 200, event, hydrated: await args.client.hydrate(event) }
}
