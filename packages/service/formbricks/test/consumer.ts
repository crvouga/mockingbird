/**
 * A typical consumer app's Formbricks integration, written against upstream Formbricks' documented
 * API (https://formbricks.com/docs), which the acceptance tests drive against the mock:
 *
 * - `SurveyClient`, the browser side: the environment state's surveys (cached), `submitAnswers`
 *   with retries on 429, and the widget loader;
 * - `SurveyBackend`, the server side: `clientSurveys`, `submitResponse` (a 4xx becomes 422, anything
 *   else 502, a success without an id 502 "receipt missing"), `latestAnswers` over the management
 *   API, and `surveyElements` (the v1 `questions` derived from blocks);
 * - `cli`, management reads with 404 → `null`;
 * - `WebhookReceiver`, which checks a `?token=` and records every `responseFinished` by the
 *   survey's `accountId` hidden field.
 */
import { timingSafeEqual } from "node:crypto"

export type Fetch = (request: Request) => Promise<Response>

type Survey = { id: string; [key: string]: unknown }

type EnvironmentResponse = {
  data?: { surveys?: Survey[]; data?: { surveys?: Survey[] } }
}

/** The hidden field the consumer app identifies its users by. */
export const ACCOUNT_FIELD = "accountId"

// ------------------------------------------------------------------ browser side

export const GENERIC_SUBMIT_FALLBACK_MESSAGE = "Unable to submit form. Please try again."

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

/** Throw an `ApiResponseError` carrying Formbricks' `{code, message, details}` for a non-2xx. */
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
  const serverMessage = record ? readString(record.message) : readString(payload)
  const fallback = `${operation} failed (${response.status})`
  const message = serverMessage ?? options?.fallbackMessage ?? fallback
  throw new ApiResponseError(message, response.status, code, payload)
}

export class SurveyClient {
  private cached: Survey[] | undefined

  constructor(
    private readonly appUrl: string,
    private readonly workspaceId: string,
    private readonly send: Fetch,
    private readonly sleep: (ms: number) => Promise<void> = async () => {},
  ) {}

  private base(): string {
    return this.appUrl.replace(/\/$/, "")
  }

  /** The environment state's surveys (cached per client, as the SDK caches until `expiresAt`). */
  async surveys(): Promise<Survey[]> {
    if (this.cached) return this.cached
    const response = await this.send(
      new Request(`${this.base()}/api/v1/client/${this.workspaceId}/environment`),
    )
    if (!response.ok) throw new Error(`Failed to fetch Formbricks environment: ${response.status}`)
    const json = (await response.json()) as EnvironmentResponse
    this.cached = json.data?.data?.surveys ?? json.data?.surveys ?? []
    return this.cached
  }

  async survey(surveyId: string): Promise<Survey> {
    const survey = (await this.surveys()).find((s) => s.id === surveyId)
    if (!survey) throw new Error(`Survey not found: ${surveyId}`)
    return survey
  }

  /** Submit a finished response (answers keyed by element id), retrying 429 up to 3 attempts. */
  async submitAnswers(params: {
    surveyId: string
    answers: Record<string, unknown>
    accountId?: string
  }): Promise<{ id: string; attempts: number }> {
    const url = `${this.base()}/api/v2/client/${this.workspaceId}/responses`
    const data = params.accountId
      ? { ...params.answers, [ACCOUNT_FIELD]: params.accountId }
      : params.answers
    const body = { surveyId: params.surveyId, finished: true, data }
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
    const raw = (await response.json()) as { data?: { id?: string } }
    const id = raw?.data?.id ?? ""
    if (!id) throw new Error("Formbricks response has no id")
    return { id, attempts }
  }

  /** Load the widget script and check it defines `window.formbricks`. */
  async loadWidget(): Promise<boolean> {
    const response = await this.send(new Request(`${this.base()}/js/formbricks.umd.cjs`))
    if (!response.ok) return false
    const window: { formbricks?: { setup?: () => Promise<void> } } = {}
    new Function("window", await response.text())(window)
    await window.formbricks?.setup?.()
    return typeof window.formbricks?.setup === "function"
  }
}

// ------------------------------------------------------------------ server side

/** The error the consumer backend answers with for a rejected submission. */
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
    this.name = "FormSubmissionRejected"
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

export class SurveyBackend {
  constructor(
    private readonly appUrl: string,
    private readonly apiKey: string,
    private readonly workspaceId: string,
    private readonly send: Fetch,
  ) {}

  async clientSurveys(): Promise<Survey[]> {
    const response = await this.send(
      new Request(`${this.appUrl}/api/v1/client/${this.workspaceId}/environment`),
    )
    if (!response.ok) {
      throw new Error(`Formbricks environment fetch returned ${response.status.toString()}`)
    }
    const json = (await response.json()) as EnvironmentResponse
    return json.data?.data?.surveys ?? json.data?.surveys ?? []
  }

  /**
   * Submit on a user's behalf: a 4xx becomes 422 `FORM_SUBMISSION_REJECTED` carrying Formbricks'
   * `details`; anything else 502. With a receipt requested, a success without an id is 502
   * `FORM_SUBMISSION_RECEIPT_MISSING`.
   */
  async submitResponse(
    surveyId: string,
    accountId: string,
    data: Record<string, unknown>,
    options: { receipt?: boolean } = {},
  ): Promise<{ responseId: string } | undefined> {
    const response = await this.send(
      new Request(`${this.appUrl}/api/v2/client/${this.workspaceId}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surveyId,
          finished: true,
          data: { ...data, [ACCOUNT_FIELD]: accountId },
        }),
        signal: AbortSignal.timeout(30_000),
      }),
    )
    if (!response.ok) {
      const parsed = (await response.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined
      const message = typeof parsed?.message === "string" ? parsed.message : undefined
      const client = response.status >= 400 && response.status < 500
      throw new FormSubmissionRejected(client ? 422 : 502, {
        code: "FORM_SUBMISSION_REJECTED",
        message: message
          ? `Form submission was rejected: ${message}`
          : "Form submission was rejected by the form service.",
        formbricksStatus: response.status,
        ...(parsed?.details !== undefined ? { details: parsed.details } : {}),
      })
    }
    if (!options.receipt) return undefined
    const body = (await response.json().catch(() => null)) as { data?: { id?: string } } | null
    const responseId = body?.data?.id ?? ""
    if (!responseId) {
      throw new FormSubmissionRejected(502, {
        code: "FORM_SUBMISSION_RECEIPT_MISSING",
        message:
          "The form may have been submitted, but its receipt could not be verified. Do not submit it again.",
      })
    }
    return { responseId }
  }

  /** A user's latest answers to a survey (by the `accountId` hidden field), `[]` on any failure. */
  async latestAnswers(surveyId: string, accountId: string) {
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
    const mine = (body.data ?? []).filter(
      (record) => parseResponseData(record.data)[ACCOUNT_FIELD] === accountId,
    )
    if (mine.length === 0) return []
    const latest = mine.reduce((a, b) =>
      new Date(a.createdAt).getTime() >= new Date(b.createdAt).getTime() ? a : b,
    )
    const { [ACCOUNT_FIELD]: _skip, ...answers } = parseResponseData(latest.data)
    return Object.entries(answers).map(([elementId, value]) => ({
      elementId,
      answers: value !== null && value !== undefined ? [String(value)] : [],
    }))
  }

  /** A survey's elements as the v1 `questions` list (`{id, type, required}`), `null` on 404. */
  async surveyElements(surveyId: string) {
    const response = await this.send(
      new Request(`${this.appUrl}/api/v1/management/surveys/${surveyId}`, {
        headers: { "x-api-key": this.apiKey },
      }),
    )
    if (!response.ok) return null
    const body = (await response.json()) as {
      data?: { questions?: { id: string; type: string; required?: boolean }[] }
    }
    return (body.data?.questions ?? []).map(({ id, type, required }) => ({
      id,
      type,
      required: required ?? false,
    }))
  }
}

// ------------------------------------------------------------------ management CLI

export const cli = (appUrl: string, apiKey: string, send: Fetch) => {
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
      (await getJson<{ data?: Survey[] }>(`${appUrl}/api/v1/management/surveys`)).data ?? [],
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
  }
}

/** Checks `?token=`, then records every finished response by its `accountId` hidden field. */
export class WebhookReceiver {
  readonly completed: { accountId: string; surveyId?: string; responseId?: string }[] = []

  constructor(private readonly secret: string | undefined) {}

  async receive(request: Request): Promise<{ status: number; body: unknown }> {
    if (!this.secret) return { status: 403, body: "Forbidden" }
    const token = new URL(request.url).searchParams.get("token")
    if (!token) return { status: 403, body: "Forbidden" }
    const a = Buffer.from(token, "utf8")
    const b = Buffer.from(this.secret, "utf8")
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: 403, body: "Forbidden" }
    const payload = (await request.json()) as WebhookPayload
    if (payload.event !== "responseFinished" || !payload.data.finished) {
      return { status: 200, body: { ok: true } }
    }
    const accountId = payload.data.data?.[ACCOUNT_FIELD]
    if (typeof accountId !== "string") return { status: 200, body: { ok: true } }
    this.completed.push({
      accountId,
      ...(payload.data.surveyId ? { surveyId: payload.data.surveyId } : {}),
      ...(payload.data.id ? { responseId: payload.data.id } : {}),
    })
    return { status: 200, body: { ok: true } }
  }
}
