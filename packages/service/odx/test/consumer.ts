/**
 * A port of our backend's ODX client (`B/global-services/services/optimal-dx/optimal.dx.service.ts`)
 * and webhook receiver (`B/odx/guards/odx-signature.guard.ts` + `B/odx/odx.controller.ts`
 * `manageWebhookResponse` + `dto/odx-webhook-data.dto.ts`): the same URLs, headers
 * (`ApiKey`, `Accept: *\/*`), bodies (the literal `false` on the partner link), error
 * extraction (`Message ?? message`, 204 and empty-success throws, `ignore404`), and the
 * guard's key lookup via `GET /v1/webhooks` plus its uppercase-hex HMAC compared with
 * `crypto.timingSafeEqual` (which throws on a length mismatch). The acceptance tests drive the
 * mock only through this port.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

export type Fetch = (request: Request) => Promise<Response>

/** Nest's BadRequestException, reduced to its status and message. */
export class BadRequestException extends Error {
  readonly status = 400
}

type OdxErrors = { message?: string; Message?: string }

export type OdxPatientReq = {
  firstName: string
  lastName: string
  nickname?: string
  dateOfBirth: string | null
  gender: string
  email: string
  userId: string
  workspaceId: number
}

export type OdxHl7Request = {
  labProfileId: number
  labId: number
  testDate: string
  unitType: string
  userId: string
  externalReference: string
  externalMessageControlId?: string
  externalPatientTestId: string
  menstrualPhase: string
  isFasting: boolean
  hl7: string
}

export type OdxPatientData = {
  patientTestId: number
  unitType: string
  practiceId: string
  patientId: number
  outputType: string
  theme: string
  themeId: number
  recipientId: string
  cultureCode: string
  reports: string[]
  addMarginForBinding: boolean
  userId: string
}

// biome-ignore lint/suspicious/noExplicitAny: vendor payloads are untyped at this boundary, as in the consumer.
type Any = any

export class OptimalDxConsumer {
  constructor(
    private readonly odxUrl: string,
    private readonly odxApiKey: string,
    private readonly practiceId: string,
    private readonly send: Fetch,
    private readonly deploymentUrl = "http://backend.local",
  ) {}

  private fetch(url: string, init: RequestInit = {}) {
    // Node's fetch (undici) normalizes `Put` to `PUT` per the Fetch spec; Bun's Request turns
    // an unknown-cased method into GET, so the port normalizes like the runtime our app runs on.
    const method = init.method?.toUpperCase()
    return this.send(new Request(url, { ...init, ...(method ? { method } : {}) }))
  }

  getOdxLabs() {
    return this.getRequestResponse<Any[]>(`${this.odxUrl}/v1/partner/labs`)
  }

  getOdxLabsBiomarkers(labId: string) {
    return this.getRequestResponse<Any[]>(`${this.odxUrl}/v1/elements/${labId}`)
  }

  async createOdxPatient(patient: OdxPatientReq) {
    try {
      const url = `${this.odxUrl}/v1/practice/${this.practiceId}/patient`
      return await this.postRequestResponse<Any>(url, JSON.stringify(patient))
    } catch {
      return undefined
    }
  }

  updateOdxPatient(patientId: number, patient: OdxPatientReq) {
    const url = `${this.odxUrl}/v1/practice/${this.practiceId}/patient/${patientId}`
    return this.postRequestResponse<Any>(url, JSON.stringify(patient), "PUT")
  }

  async updateOdxPatientAddExternalId(patientId: number, localUserId: number) {
    try {
      const url = `${this.odxUrl}/v1/practice/${this.practiceId}/patient/${patientId}/partner/${localUserId}`
      return await this.postRequestWithOutBody(url)
    } catch {
      return undefined
    }
  }

  regLabResultsInOdx(patientId: string, results: Record<string, unknown>) {
    const url = `${this.odxUrl}/v1/practice/${this.practiceId}/patient/${patientId}/testresults`
    return this.postRequestResponse<Any>(url, JSON.stringify(results))
  }

  generateFunctionalHealthReport(data: OdxPatientData) {
    return this.postRequestResponse<Any>(
      `${this.odxUrl}/v1/reports/FunctionalHealthReport`,
      JSON.stringify(data),
    )
  }

  generateFunctionalHealthReportPdf(data: OdxPatientData) {
    return this.postRequestPdfResponse(
      `${this.odxUrl}/v1/reports/FunctionalHealthReport`,
      JSON.stringify(data),
    )
  }

  async manageWebhooks() {
    const currentUrl = `${this.deploymentUrl}/odx/webhook`
    const urls = await this.getRegisteredWebhooks()
    let urlFound = false
    if (urls) {
      for (const urlData of urls) {
        if (urlData.webhookUrl === currentUrl) {
          urlFound = true
          break
        }
        await this.updateWebhook(urlData.partnerWebhookId, urlData.webhookUrl)
      }
    }
    if (!urlFound) await this.registerWebhook(currentUrl)
    return { success: true }
  }

  registerWebhook(webhookUrl: string) {
    const body = { entityEvents: { PatientTest: ["Created", "Updated", "Deleted"] }, webhookUrl }
    return this.postRequestResponse<Any>(`${this.odxUrl}/v1/webhook`, JSON.stringify(body))
  }

  updateWebhook(partnerWebhookId: number, webhookUrl: string) {
    const body = { entityEvents: { PatientTest: ["Created", "Updated", "Deleted"] }, webhookUrl }
    // Verbatim: the method is passed as 'Put' (fetch upper-cases it).
    return this.postRequestResponse<Any>(
      `${this.odxUrl}/v1/webhook/${partnerWebhookId}`,
      JSON.stringify(body),
      "Put",
    )
  }

  async getRegisteredWebhooks(): Promise<
    { partnerWebhookId: number; signingKey: string; webhookUrl: string }[] | null
  > {
    try {
      return await this.getRequestResponse<Any[]>(`${this.odxUrl}/v1/webhooks`)
    } catch {
      return []
    }
  }

  async getAllOdxPatients() {
    try {
      return await this.getRequestResponse<Any[]>(
        `${this.odxUrl}/v1/practice/${this.practiceId}/patients`,
      )
    } catch (error) {
      throw new BadRequestException(String(error))
    }
  }

  searchForPatient(email: string, firstName: string, lastName: string, dateOfBirth: string) {
    const url = `${this.odxUrl}/v1/practice/${this.practiceId}/patients`
    const searchParams = new URLSearchParams()
    if (email) searchParams.set("email", email)
    if (firstName) searchParams.set("firstName", firstName)
    if (lastName) searchParams.set("lastName", lastName)
    if (dateOfBirth) searchParams.set("dateOfBirth", dateOfBirth)
    return this.getRequestResponse<Any[]>(`${url}?${searchParams.toString()}`, true)
  }

  async getAllPatientTests(patientId: number) {
    try {
      return await this.getRequestResponse<Any[]>(
        `${this.odxUrl}/v1/practice/${this.practiceId}/patient/${patientId}/tests`,
      )
    } catch {
      return []
    }
  }

  postHL7File(patientId: number, data: OdxHl7Request) {
    if (patientId <= 0) throw new Error("Invalid patientId: must be a positive number")
    const url = `${this.odxUrl}/v1/practice/${this.practiceId}/patient/${patientId}/test`
    return this.postRequestResponse<Any>(url, JSON.stringify(data))
  }

  updateHL7File(patientId: number, patientTestId: number, data: OdxHl7Request) {
    if (patientId <= 0) throw new Error("Invalid patientId: must be a positive number")
    if (patientTestId <= 0) throw new Error("Invalid patientTestId: must be a positive number")
    const url = `${this.odxUrl}/v1/practice/${this.practiceId}/patient/${patientId}/test/${patientTestId}`
    return this.postRequestResponse<Any>(url, JSON.stringify(data), "PUT")
  }

  async getRequestResponse<T>(url: string, ignore404 = false): Promise<T | null> {
    try {
      const response = await this.fetch(url, { headers: { ApiKey: this.odxApiKey, Accept: "*/*" } })
      if (!response.ok) {
        if (response.status === 404 && ignore404) return null
        const errorMessages = (await response.json()) as OdxErrors
        throw new Error(errorMessages.Message ?? errorMessages.message)
      }
      return (await response.json()) as T
    } catch (error) {
      throw new BadRequestException((error as Error).message)
    }
  }

  async postRequestWithOutBody(url: string) {
    try {
      const response = await this.fetch(url, {
        method: "POST",
        headers: { ApiKey: this.odxApiKey, Accept: "*/*", "Content-Type": "application/json" },
        body: "false",
      })
      if (!response.ok) {
        const errorMessages = (await response.json()) as OdxErrors
        throw new Error(errorMessages.message)
      }
      return { msg: "Data Updated Successfully" }
    } catch (error) {
      throw new BadRequestException((error as Error).message)
    }
  }

  async postRequestResponse<T>(url: string, requestBody: string, method?: string): Promise<T> {
    try {
      const response = await this.fetch(url, {
        method: method ? method : "POST",
        headers: { ApiKey: this.odxApiKey, Accept: "*/*", "Content-Type": "application/json" },
        body: requestBody,
      })
      const rawText = await response.text()
      if (response.status === 204) {
        throw new Error("204 No Content response from Optimal DX - unexpected empty response")
      }
      if (!response.ok) {
        let message = rawText || "Empty error response from Optimal DX"
        if (rawText) {
          try {
            const errorMessages = JSON.parse(rawText) as OdxErrors
            message = errorMessages.Message ?? errorMessages.message ?? message
          } catch {
            message = rawText
          }
        }
        throw new Error(message)
      }
      if (!rawText) throw new Error("Empty success response received")
      try {
        return JSON.parse(rawText) as T
      } catch {
        throw new Error(rawText)
      }
    } catch (error) {
      throw new Error((error as Error).message)
    }
  }

  async postRequestPdfResponse(url: string, requestBody: string) {
    try {
      const response = await this.fetch(url, {
        method: "POST",
        headers: { ApiKey: this.odxApiKey, Accept: "*/*", "Content-Type": "application/json" },
        body: requestBody,
      })
      if (!response.ok) throw new Error(await response.text())
      const buffer = new Uint8Array(await response.arrayBuffer())
      return {
        originalname: "report.pdf",
        mimetype: "application/pdf",
        size: buffer.length,
        buffer,
      }
    } catch (error) {
      throw new BadRequestException(String(error))
    }
  }
}

/** `OdxSignatureGuard.createHmacCSharpStyle`. */
export const createHmacCSharpStyle = (key: string, input: string): string =>
  createHmac("sha256", Buffer.from(key, "utf8"))
    .update(Buffer.from(input, "utf8"))
    .digest()
    .toString("hex")
    .toUpperCase()

/** `OdxSignatureGuard.verifyHmac`: throws `RangeError` when the lengths differ (the known bug). */
export const verifyHmac = (expectedHmac: string, receivedHmac: string): boolean =>
  timingSafeEqual(Buffer.from(expectedHmac, "utf8"), Buffer.from(receivedHmac, "utf8"))

/** `OdxSignatureGuard.canActivate`: fetch the signing key for our URL, then compare. */
export const canActivate = async (
  client: OptimalDxConsumer,
  currentUrl: string,
  headers: Headers,
  rawBody: string,
): Promise<boolean> => {
  const odxUrls = await client.getRegisteredWebhooks()
  const matchUrl = odxUrls?.find((url) => url.webhookUrl === currentUrl)
  const odxWebhookSecret = matchUrl?.signingKey
  if (!odxWebhookSecret) return false
  const signatureHeader = headers.get("optimaldx-signature")
  if (!signatureHeader) return false
  const expectedSignature = createHmacCSharpStyle(odxWebhookSecret, rawBody)
  if (!verifyHmac(expectedSignature, signatureHeader)) return false
  return true
}

/** What our zod DTO (`OdxWebhookDataSchema`) accepts, as a list of problems. */
export const webhookDtoIssues = (body: Any): string[] => {
  const issues: string[] = []
  if (typeof body?.entityType !== "string") issues.push("entityType")
  if (typeof body?.eventType !== "string") issues.push("eventType")
  const data = body?.data ?? {}
  for (const key of ["patientTestId", "patientId", "labProfileId", "labId"]) {
    if (typeof data[key] !== "number") issues.push(`data.${key}`)
  }
  for (const key of ["unitType", "userId", "practiceId", "menstrualPhase"]) {
    if (typeof data[key] !== "string") issues.push(`data.${key}`)
  }
  for (const key of ["externalReference", "externalMessageControlId", "externalPatientTestId"]) {
    if (data[key] !== null && typeof data[key] !== "string") issues.push(`data.${key}`)
  }
  if (typeof data.isFasting !== "boolean") issues.push("data.isFasting")
  for (const [i, r] of (Array.isArray(data.results) ? data.results : []).entries()) {
    for (const key of [
      "elementValue",
      "elementId",
      "optimalRangeLow",
      "optimalRangeHigh",
      "standardRangeLow",
      "standardRangeHigh",
    ]) {
      if (typeof r[key] !== "number") issues.push(`data.results.${i}.${key}`)
    }
    for (const key of ["comparison", "unit", "elementName"]) {
      if (typeof r[key] !== "string") issues.push(`data.results.${i}.${key}`)
    }
  }
  return issues
}

/**
 * `POST /odx/webhook` as Nest runs it: the guard (false → 403, a throw → 500), then the
 * controller, which always answers success (DTO issues are only logged).
 */
export const receiveWebhook = async (
  client: OptimalDxConsumer,
  currentUrl: string,
  headers: Headers,
  rawBody: string,
): Promise<{ status: number; body: Any; issues?: string[] }> => {
  let allowed: boolean
  try {
    allowed = await canActivate(client, currentUrl, headers, rawBody)
  } catch (error) {
    return {
      status: 500,
      body: { statusCode: 500, message: "Internal server error", error: String(error) },
    }
  }
  if (!allowed) return { status: 403, body: { statusCode: 403, message: "Forbidden resource" } }
  const body = JSON.parse(rawBody)
  return {
    status: 201,
    body: { success: true, message: "Webhook received and processed" },
    issues: webhookDtoIssues(body),
  }
}
