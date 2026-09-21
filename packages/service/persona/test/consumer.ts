/**
 * A port of our EMR's Persona client (`E/services/persona/persona.service.ts` + `types.ts`)
 * and of its webhook receiver (`E/routers/v1/identity-verification/controller.ts`
 * handlePersonaWebhook): the same requests and headers, the same error-message composition,
 * the same fail-open reuse lookup, the same signature parsing and verification. The zod
 * schemas are ported as hand checks with the same required fields. The acceptance tests drive
 * the mock only through this port.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

export type Fetch = (request: Request) => Promise<Response>

export type PersonaConfig = {
  PERSONA_API_URL: string
  PERSONA_API_KEY: string
  PERSONA_WEB_INQUIRY_URL: string
  PERSONA_MOBILE_INQUIRY_URL: string
  PERSONA_IDENTITY_INQUIRY_TEMPLATE_ID: string
  PERSONA_PHONE_INQUIRY_TEMPLATE_ID: string
  PERSONA_WEBHOOK_SECRET: string
}

export type InquiryCreationOptions = {
  referenceId: string
  redirectUri: string
  verificationType: "identity" | "phone" | "email"
  prefillFields?: Record<string, string>
  platform?: "web" | "mobile"
}

const REUSABLE_INQUIRY_STATUSES = ["created", "pending"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** zod's `.parse` failing: the consumer surfaces it as a thrown error. */
export class SchemaError extends Error {}

/** `PersonaErrorSchema`: `{errors: [{title, detail, status}]}`, all strings. */
const parsePersonaError = (value: unknown) => {
  if (!isRecord(value) || !Array.isArray(value.errors)) return undefined
  const ok = value.errors.every(
    (e) =>
      isRecord(e) &&
      typeof e.title === "string" &&
      typeof e.detail === "string" &&
      typeof e.status === "string",
  )
  return ok ? (value.errors as { title: string; detail: string; status: string }[]) : undefined
}

/** `{data: {id, type, attributes: {status, reference-id}}}` (PersonaInquiryResponseSchema). */
const parseInquiryResponse = (value: unknown) => {
  const data = isRecord(value) ? value.data : undefined
  const attributes = isRecord(data) ? data.attributes : undefined
  if (
    !isRecord(data) ||
    typeof data.id !== "string" ||
    typeof data.type !== "string" ||
    !isRecord(attributes) ||
    typeof attributes.status !== "string" ||
    typeof attributes["reference-id"] !== "string"
  ) {
    throw new SchemaError("Invalid Persona inquiry response")
  }
  return { id: data.id, status: attributes.status, referenceId: attributes["reference-id"] }
}

/** PersonaInquiryListResponseSchema. */
const parseInquiryList = (value: unknown) => {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new SchemaError("Invalid Persona inquiry list response")
  }
  return value.data.map((item) => parseInquiryResponse({ data: item }))
}

export class PersonaConsumer {
  private readonly hostedFlowBaseUrl: string

  constructor(
    private readonly config: PersonaConfig,
    private readonly fetchImpl: Fetch,
    platform: "web" | "mobile" = "web",
  ) {
    this.hostedFlowBaseUrl =
      platform === "web" ? config.PERSONA_WEB_INQUIRY_URL : config.PERSONA_MOBILE_INQUIRY_URL
  }

  /** `makeApiCall`: Bearer key, JSON, `Persona-Version: 2023-01-05`; errors composed from titles. */
  private async makeApiCall(endpoint: string, options: RequestInit): Promise<unknown> {
    const url = `${this.config.PERSONA_API_URL}${endpoint}`
    const response = await this.fetchImpl(
      new Request(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.config.PERSONA_API_KEY}`,
          "Content-Type": "application/json",
          "Persona-Version": "2023-01-05",
        },
      }),
    )
    if (!response.ok) {
      const errorData = (await response.json()) as unknown
      const validated = parsePersonaError(errorData)
      throw new Error(
        `Failed to call Persona API: ${response.status} ${response.statusText} - ${
          validated
            ? validated.map((e) => `${e.title}: ${e.detail}`).join(", ")
            : JSON.stringify(errorData)
        }`,
      )
    }
    return response.json()
  }

  async createInquiry(
    options: InquiryCreationOptions,
  ): Promise<{ inquiryUrl: string; referenceId: string; reused: boolean }> {
    const inquiryTemplateId =
      options.verificationType === "identity"
        ? this.config.PERSONA_IDENTITY_INQUIRY_TEMPLATE_ID
        : this.config.PERSONA_PHONE_INQUIRY_TEMPLATE_ID
    // Fail-open reuse: a lookup failure must never block verification.
    try {
      const reusable = await this.listReusableInquiry(options.referenceId, inquiryTemplateId)
      if (reusable) {
        return {
          inquiryUrl: this.getHostedFlowUrl(reusable.id, options.redirectUri),
          referenceId: options.referenceId,
          reused: true,
        }
      }
    } catch {
      // logged as a warning in the EMR; fall through to create
    }
    const payload = {
      data: {
        attributes: {
          "inquiry-template-id": inquiryTemplateId,
          "reference-id": options.referenceId,
          "redirect-uri": options.redirectUri,
          fields: options.prefillFields ?? {},
          platform: options.platform,
        },
        type: "inquiry" as const,
      },
    }
    const response = parseInquiryResponse(
      await this.makeApiCall("/inquiries", { method: "POST", body: JSON.stringify(payload) }),
    )
    return {
      inquiryUrl: this.getHostedFlowUrl(response.id, options.redirectUri),
      referenceId: response.referenceId,
      reused: false,
    }
  }

  async listReusableInquiry(
    referenceId: string,
    templateId: string,
  ): Promise<{ id: string } | null> {
    const params = new URLSearchParams()
    params.set("filter[reference-id]", referenceId)
    params.set("filter[inquiry-template-id]", templateId)
    params.set("filter[status]", REUSABLE_INQUIRY_STATUSES.join(","))
    params.set("page[size]", "1")
    const list = parseInquiryList(
      await this.makeApiCall(`/inquiries?${params.toString()}`, { method: "GET" }),
    )
    const existing = list[0]
    return existing ? { id: existing.id } : null
  }

  async getInquiry(
    inquiryId: string,
  ): Promise<{ id: string; referenceId: string; status: string }> {
    const response = parseInquiryResponse(
      await this.makeApiCall(`/inquiries/${inquiryId}`, { method: "GET" }),
    )
    return { id: response.id, referenceId: response.referenceId, status: response.status }
  }

  getHostedFlowUrl(inquiryId: string, redirectUri: string): string {
    return `${this.hostedFlowBaseUrl}?inquiry-id=${inquiryId}&redirect-uri=${encodeURIComponent(redirectUri)}`
  }
}

export type WebhookResult = {
  inquiryId: string
  status: string
  referenceId: string
  inquiryTemplateId: string
}

/** `handlePersonaWebhook` + `PersonaWebhookPayloadSchema`. */
export const handlePersonaWebhook = (payload: unknown): WebhookResult => {
  const inner = isRecord(payload) && isRecord(payload.data) ? payload.data.attributes : undefined
  const data = isRecord(inner) && isRecord(inner.payload) ? inner.payload.data : undefined
  const attributes = isRecord(data) ? data.attributes : undefined
  const relationships = isRecord(data) ? data.relationships : undefined
  const template =
    isRecord(relationships) && isRecord(relationships["inquiry-template"])
      ? relationships["inquiry-template"].data
      : undefined
  if (
    !isRecord(data) ||
    typeof data.id !== "string" ||
    !isRecord(attributes) ||
    typeof attributes.status !== "string" ||
    typeof attributes["reference-id"] !== "string" ||
    !isRecord(template) ||
    typeof template.type !== "string" ||
    typeof template.id !== "string"
  ) {
    throw new SchemaError("Invalid Persona webhook payload")
  }
  return {
    inquiryId: data.id,
    status: attributes.status,
    referenceId: attributes["reference-id"],
    inquiryTemplateId: template.id,
  }
}

/**
 * The receiver's outcome as HTTP: 400 for a missing/garbled header, 401 for a bad signature,
 * 500 when `timingSafeEqual` throws (a signature of a different length: an uncaught
 * RangeError in the EMR), 200 with the handled result otherwise.
 */
export const receivePersonaWebhook = (
  secret: string,
  headers: Headers,
  rawBody: string,
): { status: number; body: unknown } => {
  const signatureHeader = headers.get("persona-signature")
  if (!signatureHeader) return { status: 400, body: { error: "Missing Persona signature header" } }
  const t = signatureHeader.split(",")[0]?.split("=")[1]
  const signatures = signatureHeader
    .split(" ")
    .map((pair) => pair.split("v1=")[1])
    .filter((sig): sig is string => typeof sig === "string" && sig.length > 0)
  if (!t || signatures.length === 0) {
    return { status: 400, body: { error: "Invalid signature header format" } }
  }
  const hmac = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")
  let isVerified: boolean
  try {
    isVerified = signatures.some((signature) =>
      timingSafeEqual(Buffer.from(hmac), Buffer.from(signature)),
    )
  } catch (error) {
    // Uncaught in the EMR: Fastify answers 500.
    return { status: 500, body: { error: (error as Error).message } }
  }
  if (!isVerified) return { status: 401, body: { error: "Invalid signature" } }
  return { status: 200, body: handlePersonaWebhook(JSON.parse(rawBody)) }
}

/**
 * `IdentityVerificationBusiness.updateIdentityVerificationForPatient`'s decision: it only acts
 * on `completed`, per template (phone → profile flag, identity → isIdentityVerified).
 */
export const verificationEffect = (
  config: Pick<
    PersonaConfig,
    "PERSONA_PHONE_INQUIRY_TEMPLATE_ID" | "PERSONA_IDENTITY_INQUIRY_TEMPLATE_ID"
  >,
  result: WebhookResult,
): "phone-verified" | "identity-verified" | "none" => {
  if (result.status !== "completed") return "none"
  if (result.inquiryTemplateId === config.PERSONA_PHONE_INQUIRY_TEMPLATE_ID) return "phone-verified"
  if (result.inquiryTemplateId === config.PERSONA_IDENTITY_INQUIRY_TEMPLATE_ID) {
    return "identity-verified"
  }
  return "none"
}
