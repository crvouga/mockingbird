/**
 * A port of our Formbricks consumers:
 *
 * - member app `M/lib/dynamic-form/dynamic-form-service/formbricks.ts` (environment surveys,
 *   `submitAnswers` with its 429 retries) with `assertOk` from `M/lib/http/helpers.ts`, and the
 *   widget loader `formbricks-sdk-loader.ts`;
 * - backend `B/erx/services/erx-forms.service.ts` (`getClientSurveys`, `submitResponse`,
 *   `getResponses`) and `B/onboarding-tasks/formbricks-intake.service.ts` (survey metadata);
 * - `tooling/formbricks-cli/lib/formbricks-client.ts` (management reads, 404 → null);
 * - the webhook receiver `B/onboarding-tasks/onboarding-tasks.controller.ts` with
 *   `FormbricksSignatureGuard` (only `?token=` is checked).
 *
 * Same URLs, headers, bodies, status branches and field fallbacks.
 */
import { timingSafeEqual } from "node:crypto"

export type Fetch = (request: Request) => Promise<Response>

type Survey = { id: string; [key: string]: unknown }

type EnvironmentResponse = {
  data?: { surveys?: Survey[]; data?: { surveys?: Survey[] } }
}

// ------------------------------------------------------------------ member app

export const GENERIC_SUBMIT_FALLBACK_MESSAGE = "Unable to submit form. Please try again."

/** `ApiResponseError` / `createApiResponseError` / `assertOk` (member-app http helpers). */
export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly payload: unknown,
  ) {
    super(message)
    this.name = "ApiResponseError"
  }
}

const readString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : null

export const assertOk = async (
  response: Response,
  operation: string,
  options?: { fallbackMessage?: string },
) => {
  if (response.ok) return
  const body = await response.text().catch(() => "")
  let payload: unknown = body
  if (body.length > 0) {
    try {
      payload = JSON.parse(body)
    } catch {
      payload = body
    }
  }
  const record =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null
  const code = record ? readString(record.code) : null
  const serverMessage = record
    ? (readString(record.message) ?? readString(record.error) ?? readString(record.errorMessage))
    : readString(payload)
  const message = serverMessage ?? `${operation} failed (${response.status})`
  if (options?.fallbackMessage && message === `${operation} failed (${response.status})`) {
    throw new ApiResponseError(options.fallbackMessage, response.status, code, payload)
  }
  throw new ApiResponseError(message, response.status, code, payload)
}

export class MemberAppFormbricks {
  private readonly cache = new Map<string, Survey[]>()

  constructor(
    private readonly appUrl: string,
    private readonly environmentId: string,
    private readonly send: Fetch,
    private readonly sleep: (ms: number) => Promise<void> = async () => {},
  ) {}

  /** `loadFormbricksEnvironmentSurveys` (a 5-minute cache in the app; per instance here). */
  async surveys(): Promise<Survey[]> {
    const base = this.appUrl.replace(/\/$/, "")
    const cached = this.cache.get(this.environmentId)
    if (cached) return cached
    const response = await this.send(
      new Request(`${base}/api/v1/client/${this.environmentId}/environment`),
    )
    if (!response.ok) throw new Error(`Failed to fetch Formbricks environment: ${response.status}`)
    const json = (await response.json()) as EnvironmentResponse
    const surveys = json.data?.surveys ?? json.data?.data?.surveys ?? []
    this.cache.set(this.environmentId, surveys)
    return surveys
  }

  /** `fetchFormbricksSurvey`. */
  async survey(surveyId: string): Promise<Survey> {
    const survey = (await this.surveys()).find((s) => s.id === surveyId)
    if (!survey) throw new Error(`Survey not found: ${surveyId}`)
    return survey
  }

  /** `DynamicFormServiceFormbricks.submitAnswers`. */
  async submitAnswers(params: {
    formId: string
    answers: { questionId: string; value: unknown }[]
    gevitiUserId?: string
    cognitoSub?: string
    userId?: string
  }): Promise<{ id: string; attempts: number }> {
    const url = `${this.appUrl.replace(/\/$/, "")}/api/v2/client/${this.environmentId}/responses`
    const rawData = params.answers.reduce<Record<string, unknown>>(
      // biome-ignore lint/performance/noAccumulatingSpread: verbatim port of buildResponsesMap
      (acc, { questionId, value }) => ({ ...acc, [questionId]: value }),
      {},
    )
    const safeGevitiUserId =
      typeof params.gevitiUserId === "string" && /^\d+$/.test(params.gevitiUserId)
        ? params.gevitiUserId
        : undefined
    const data = safeGevitiUserId ? { ...rawData, __gevitiUserId: safeGevitiUserId } : rawData
    const meta: Record<string, unknown> = {}
    if (safeGevitiUserId) meta.gevitiUserId = safeGevitiUserId
    if (params.cognitoSub) meta.cognitoSub = params.cognitoSub
    const body: Record<string, unknown> = {
      surveyId: params.formId,
      finished: true,
      data,
      ...(params.userId && { userId: params.userId }),
      ...(Object.keys(meta).length > 0 && { meta }),
    }
    let response: Response | null = null
    let attempts = 0
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      attempts = attempt
      response = await this.send(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
      if (response.status !== 429 || attempt === 3) break
      await this.sleep(250 * 2 ** (attempt - 1))
    }
    if (!response) throw new Error(GENERIC_SUBMIT_FALLBACK_MESSAGE)
    await assertOk(response, "Submit form", { fallbackMessage: GENERIC_SUBMIT_FALLBACK_MESSAGE })
    const raw = (await response.json()) as { data?: { id?: string }; id?: string }
    const id = raw?.data?.id ?? raw?.id ?? ""
    if (!id) throw new Error("PostAnswerResponseSchema: id is required")
    return { id, attempts }
  }

  /** `loadFormbricksWidgetScript` + the SDK's global: does the script define `formbricks`? */
  async loadWidget(): Promise<boolean> {
    const response = await this.send(
      new Request(`${this.appUrl.replace(/\/$/, "")}/js/formbricks.umd.cjs`),
    )
    if (!response.ok) return false
    const window: { formbricks?: { setup?: () => Promise<void> } } = {}
    new Function("window", await response.text())(window)
    await window.formbricks?.setup?.()
    return typeof window.formbricks?.setup === "function"
  }
}

// ------------------------------------------------------------------ backend eRx + intake

/** The HttpException our backend throws for a rejected submission. */
export class FormSubmissionRejected extends Error {
  constructor(
    readonly statusCode: 422 | 502,
    readonly body: {
      code: "FORM_SUBMISSION_REJECTED" | "FORM_SUBMISSION_RECEIPT_MISSING"
      message: string
      formbricksStatus?: number
      details?: unknown
    },
  ) {
    super(body.message)
    this.name = "HttpException"
  }
}

const parseResponseData = (raw: Record<string, unknown> | string | null) => {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return raw
}

export class BackendFormbricks {
  constructor(
    private readonly appUrl: string,
    private readonly apiKey: string,
    private readonly environmentId: string,
    private readonly send: Fetch,
  ) {}

  /** `getClientSurveys`. */
  async clientSurveys(): Promise<Survey[]> {
    const response = await this.send(
      new Request(`${this.appUrl}/api/v1/client/${this.environmentId}/environment`),
    )
    if (!response.ok) {
      throw new Error(`Formbricks client environment fetch returned ${response.status.toString()}`)
    }
    const json = (await response.json()) as EnvironmentResponse
    return json.data?.surveys ?? json.data?.data?.surveys ?? []
  }

  /**
   * `ErxFormsService.submitResponse`: a 4xx becomes 422 `FORM_SUBMISSION_REJECTED` carrying
   * Formbricks' `details`; anything else 502. With a receipt requested, a success without an
   * id is 502 `FORM_SUBMISSION_RECEIPT_MISSING`.
   */
  async submitResponse(
    surveyId: string,
    userId: number,
    data: Record<string, unknown>,
    options: { userEmail?: string; receipt?: boolean } = {},
  ): Promise<{ responseId: string } | undefined> {
    const body = {
      surveyId,
      finished: true,
      data: { ...data, __gevitiUserId: String(userId) },
      meta: { gevitiUserId: String(userId) },
      ...(options.userEmail ? { userId: options.userEmail } : {}),
    }
    const response = await this.send(
      new Request(`${this.appUrl}/api/v2/client/${this.environmentId}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      }),
    )
    if (!response.ok) {
      const errBody = await response.text().catch(() => "")
      let parsed: unknown
      try {
        parsed = JSON.parse(errBody)
      } catch {
        parsed = undefined
      }
      const obj =
        parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
      const message = typeof obj?.message === "string" ? obj.message : undefined
      const details = obj?.details
      const client = response.status >= 400 && response.status < 500
      throw new FormSubmissionRejected(client ? 422 : 502, {
        code: "FORM_SUBMISSION_REJECTED",
        message: message
          ? `Form submission was rejected: ${message}`
          : "Form submission was rejected by the form service.",
        formbricksStatus: response.status,
        ...(details !== undefined ? { details } : {}),
      })
    }
    if (!options.receipt) return undefined
    const responseBody = (await response.json().catch(() => null)) as {
      data?: { id?: string }
      id?: string
    } | null
    const responseId = responseBody?.data?.id ?? responseBody?.id ?? ""
    if (!responseId) {
      throw new FormSubmissionRejected(502, {
        code: "FORM_SUBMISSION_RECEIPT_MISSING",
        message:
          "The form may have been submitted, but its receipt could not be verified. Do not submit it again.",
      })
    }
    return { responseId }
  }

  /** `getResponses`: the member's latest response, answers as `{linkId, answers[]}`. */
  async getResponses(surveyId: string, userId: number) {
    let response: Response
    try {
      response = await this.send(
        new Request(
          `${this.appUrl}/api/v1/management/responses?surveyId=${encodeURIComponent(surveyId)}`,
          { headers: { "x-api-key": this.apiKey }, signal: AbortSignal.timeout(30_000) },
        ),
      )
    } catch {
      return []
    }
    if (!response.ok) return []
    const body = (await response.json()) as {
      data?: { data: Record<string, unknown> | string | null; createdAt: string }[]
    }
    const userRecords = (body.data ?? []).filter(
      (record) => parseResponseData(record.data).__gevitiUserId === String(userId),
    )
    if (userRecords.length === 0) return []
    const latest = userRecords.reduce((a, b) =>
      new Date(a.createdAt).getTime() >= new Date(b.createdAt).getTime() ? a : b,
    )
    const { __gevitiUserId: _skip, ...answers } = parseResponseData(latest.data)
    return Object.entries(answers).map(([questionId, value]) => ({
      linkId: questionId,
      answers: value !== null && value !== undefined ? [String(value)] : [],
    }))
  }

  /** `FormbricksIntakeService`: the `metadata.intakeField` tags of a survey's questions. */
  async intakeFields(surveyId: string): Promise<Map<string, string> | null> {
    const response = await this.send(
      new Request(`${this.appUrl}/api/v1/management/surveys/${surveyId}`, {
        headers: { "x-api-key": this.apiKey },
      }),
    )
    if (!response.ok) return null
    const body = (await response.json()) as {
      data?: { questions?: { id: string; metadata?: Record<string, unknown> | null }[] }
    }
    const tagged = new Map<string, string>()
    const questions = Array.isArray(body.data?.questions) ? body.data.questions : []
    for (const q of questions) {
      const field = q.metadata?.intakeField
      if (typeof field === "string" && field) tagged.set(q.id, field)
    }
    return tagged
  }
}

// ------------------------------------------------------------------ tooling/formbricks-cli

export const cli = (appUrl: string, apiKey: string, environmentId: string, send: Fetch) => {
  const get = (url: string) => send(new Request(url, { headers: { "x-api-key": apiKey } }))
  const getJson = async <T>(url: string): Promise<T> => {
    const res = await get(url)
    if (!res.ok) throw new Error(`Formbricks GET ${url} failed: HTTP ${String(res.status)}`)
    return (await res.json()) as T
  }
  const item = async <T>(url: string): Promise<T | null> => {
    const res = await get(url)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Formbricks GET ${url} failed: HTTP ${String(res.status)}`)
    return ((await res.json()) as { data?: T }).data ?? null
  }
  return {
    listResponses: async (surveyId: string) =>
      (
        await getJson<{ data?: unknown[] }>(
          `${appUrl}/api/v1/management/responses?surveyId=${encodeURIComponent(surveyId)}`,
        )
      ).data ?? [],
    getResponse: (id: string) =>
      item<{ id: string }>(`${appUrl}/api/v1/management/responses/${encodeURIComponent(id)}`),
    getSurvey: (id: string) =>
      item<Survey>(`${appUrl}/api/v1/management/surveys/${encodeURIComponent(id)}`),
    listSurveys: async () =>
      (
        await getJson<{ data?: Survey[] }>(
          `${appUrl}/api/v1/management/surveys?environmentId=${encodeURIComponent(environmentId)}`,
        )
      ).data ?? [],
  }
}

// ------------------------------------------------------------------ webhook receiver

type WebhookPayload = {
  event: string
  data: {
    id?: string
    surveyId?: string
    finished?: boolean
    data?: Record<string, unknown>
    contact?: { id?: string; userId?: string } | null
  }
}

/** `FormbricksSignatureGuard` + `handleFormbricksWebhook`, with the task completion recorded. */
export class WebhookReceiver {
  readonly completed: { email: string; metadata: Record<string, unknown> | undefined }[] = []

  constructor(
    private readonly secret: string | undefined,
    private readonly appUrl: string,
    private readonly environmentId: string,
  ) {}

  async receive(request: Request): Promise<{ status: number; body: unknown }> {
    if (!this.secret) return { status: 403, body: "Forbidden" }
    const token = new URL(request.url).searchParams.get("token")
    if (!token) return { status: 403, body: "Forbidden" }
    const a = Buffer.from(token, "utf8")
    const b = Buffer.from(this.secret, "utf8")
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: 403, body: "Forbidden" }
    const payload = (await request.json()) as WebhookPayload
    if (payload.event === "testEndpoint") return { status: 200, body: { ok: true } }
    if (payload.event !== "responseFinished" || !payload.data.finished) {
      return { status: 200, body: { ok: true } }
    }
    const email = payload.data.contact?.userId
    if (!email) return { status: 200, body: { ok: true } }
    const responseId = payload.data.id
    const surveyId = payload.data.surveyId
    const metadata: Record<string, unknown> = {}
    if (surveyId && responseId) {
      metadata.formbricksResponseUrl = `${this.appUrl}/environments/${this.environmentId}/surveys/${surveyId}/responses?responseId=${responseId}`
    }
    if (surveyId) metadata.surveyId = surveyId
    if (responseId) metadata.responseId = responseId
    this.completed.push({
      email,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    })
    return { status: 200, body: { ok: true } }
  }
}
