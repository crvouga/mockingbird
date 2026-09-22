/**
 * A port of our backend's Mailosaur client (`B/dev-tools/lib/mailosaur-client.ts`), the
 * `mailosaur.confirmation-code` dev-tools command that wraps it
 * (`B/dev-tools/commands/mailosaur-devtools/command.ts`) and the QA helper that calls it
 * (`Q/world/http/mailosaur-confirmation-code.ts`): the same SDK calls, the same code-extraction
 * fallbacks (`html.codes` → `text.codes` → text regex → flattened-HTML regex), the same input
 * validation. The only change is G-M1: the SDK is constructed with a base URL (the mock's
 * HTTPS listener) instead of the default `https://mailosaur.com/`.
 */
import MailosaurNode from "mailosaur"
import { SearchCriteria, SearchOptions } from "mailosaur/models"

const TIMEOUT_EXTRA_LONG = 120_000
const MAX_EMAIL_LOCAL_PART = 64

const VERIFICATION_CODE_LINE_REGEX = /verification\s+code[^\d]{0,80}(\d{6})\b/i
const SIX_DIGIT_WORD_BOUNDARY_REGEX = /\b(\d{6})\b/

const stripHtmlToText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const firstCodeFromMailosaurContent = (codes: { value?: string }[] | undefined) => {
  for (const code of codes ?? []) {
    const v = code.value?.trim()
    if (v && /^\d{6}$/.test(v)) return v
  }
  return undefined
}

const extractSixDigitCodeFromPlainText = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim()
  const lineMatch = VERIFICATION_CODE_LINE_REGEX.exec(normalized)
  if (lineMatch?.[1]) return lineMatch[1]
  const boundaryMatch = SIX_DIGIT_WORD_BOUNDARY_REGEX.exec(normalized)
  if (boundaryMatch?.[1]) return boundaryMatch[1]
  return undefined
}

/** Which branch of the extraction produced the code (the consumer logs this at debug level). */
export type CodeSource = "sdk-codes" | "text-body" | "html-body"

export type MailosaurClientConfig = {
  apiKey: string
  serverId: string
  emailHost: string
  /** G-M1: `MAILOSAUR_BASE_URL`, e.g. `https://127.0.0.1:8794/` (the SDK appends `api/...`). */
  baseUrl?: string
}

export class MailosaurClient {
  readonly sdk: InstanceType<typeof MailosaurNode>
  private readonly serverId: string
  private readonly emailHost: string
  /** The extraction branch of the last `getConfirmationCode` (the consumer's debug log). */
  lastSource: CodeSource | undefined

  constructor(config: MailosaurClientConfig) {
    this.sdk = new MailosaurNode(config.apiKey.trim(), config.baseUrl)
    this.serverId = config.serverId.trim()
    this.emailHost = config.emailHost.trim()
  }

  emailAddressWithLocalPart(localPart: string) {
    const local = localPart.trim()
    if (local.length === 0 || local.length > MAX_EMAIL_LOCAL_PART) {
      throw new Error("emailAddressWithLocalPart: invalid local part")
    }
    return `${local}@${this.emailHost}`
  }

  async getConfirmationCode({
    sentTo,
    timeoutMs,
    receivedAfter,
  }: {
    sentTo: string
    timeoutMs?: number
    receivedAfter?: Date
  }) {
    const to = sentTo.trim()
    const message = await this.sdk.messages.get(
      this.serverId,
      new SearchCriteria({ sentTo: to }),
      new SearchOptions({
        timeout: timeoutMs ?? TIMEOUT_EXTRA_LONG,
        ...(receivedAfter ? { receivedAfter } : {}),
      }),
    )
    const fromSdk =
      firstCodeFromMailosaurContent(message.html?.codes) ??
      firstCodeFromMailosaurContent(message.text?.codes)
    if (fromSdk) {
      this.lastSource = "sdk-codes"
      return fromSdk
    }
    const textBody = message.text?.body?.trim() ?? ""
    if (textBody.length > 0) {
      const fromText = extractSixDigitCodeFromPlainText(textBody)
      if (fromText) {
        this.lastSource = "text-body"
        return fromText
      }
    }
    const htmlBody = message.html?.body?.trim() ?? ""
    if (htmlBody.length > 0) {
      const fromHtml = extractSixDigitCodeFromPlainText(stripHtmlToText(htmlBody))
      if (fromHtml) {
        this.lastSource = "html-body"
        return fromHtml
      }
    }
    throw new Error("Could not extract a 6-digit confirmation code from the Mailosaur message")
  }

  async deleteMessage(messageId: string) {
    await this.sdk.messages.del(messageId.trim())
  }

  async deleteAllMessages() {
    await this.sdk.messages.deleteAll(this.serverId)
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** `mailosaur.confirmation-code`: the dev-tools command's parameter handling, then the client. */
export const confirmationCodeCommand = async (
  client: MailosaurClient,
  params: Record<string, unknown>,
): Promise<{ ok: true; code: string }> => {
  const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : ""
  if (!email || !EMAIL_REGEX.test(email)) {
    throw new Error("Missing or invalid email in request body")
  }
  let receivedAfter: Date | undefined
  if (typeof params.receivedAfter === "string" && params.receivedAfter.trim()) {
    const parsed = new Date(params.receivedAfter.trim())
    if (Number.isNaN(parsed.getTime())) throw new Error("Invalid receivedAfter ISO date")
    receivedAfter = parsed
  }
  let timeoutMs: number | undefined
  if (params.timeoutMs != null) {
    const n =
      typeof params.timeoutMs === "number"
        ? params.timeoutMs
        : Number.parseInt(String(params.timeoutMs), 10)
    if (!Number.isInteger(n) || n < 1000 || n > 120_000) {
      throw new Error("timeoutMs must be an integer between 1000 and 120000")
    }
    timeoutMs = n
  }
  const code = await client.getConfirmationCode({
    sentTo: email,
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(receivedAfter !== undefined && { receivedAfter }),
  })
  return { ok: true, code }
}

/** `waitForMailosaurConfirmationCode` from the QA world, over an in-process dev-tools call. */
export const waitForMailosaurConfirmationCode = async (args: {
  client: MailosaurClient
  email: string
  receivedAfter: Date
  timeoutMs?: number
}): Promise<string> => {
  const email = args.email.trim().toLowerCase()
  if (email.length === 0)
    throw new Error("waitForMailosaurConfirmationCode: email must be non-empty")
  const res = await confirmationCodeCommand(args.client, {
    email,
    receivedAfter: args.receivedAfter.toISOString(),
    timeoutMs: args.timeoutMs ?? 120_000,
  })
  if (typeof res.code !== "string" || !/^\d{6}$/.test(res.code)) {
    throw new Error(
      `mailosaur.confirmation-code returned invalid code shape: ${JSON.stringify(res)}`,
    )
  }
  return res.code
}

/**
 * The signup confirmation email: Cognito's default verification template
 * ("Your verification code is {####}."), which the QA signup flow reads. The pool's template is
 * not in the consumer repo (it lives in the AWS account), so this is Cognito's documented default.
 */
export const cognitoVerificationEmail = (code: string) => ({
  from: "no-reply@verificationemail.com",
  subject: "Your verification code",
  html: `<html><body><p>Your verification code is ${code}. </p></body></html>`,
  text: `Your verification code is ${code}. `,
})
