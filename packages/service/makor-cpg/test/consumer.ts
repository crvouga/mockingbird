/**
 * Ports of our two legacy-Makor ("CPG") consumers, driven by the acceptance tests so "the mock
 * works" means "our consumers' own logic reaches the right outcome":
 *
 * 1. `MakorAiClientService` — `apps/backend/src/modules/global-services/services/makor-ai/
 *    makor-ai-client.service.ts`: `makeApiRequest` (x-api-key, JSON headers, the error-body
 *    extraction, the `MAKOR_EXPECTED_ABSENCES` warn-vs-error decision, schema validation of
 *    2xx bodies) and every method's status interpretation (200 for reads, **202** for the
 *    bloodwork webhook). The zod schemas of makor-ai.types.ts are hand-ported below.
 * 2. The EMR frontend — `cpg-api.ts` (axios: non-2xx throws with `response.status/data`,
 *    timeouts are `ECONNABORTED`), `user-summary.service.ts`,
 *    `async-review-script.service.ts` and the `handleGenerate` flow of `ai-review-notes.tsx`.
 */
export type Fetch = (request: Request) => Promise<Response>

// ─── makor-ai.types.ts schemas (hand-ported zod) ──────────────────────────────────────────

type Check = (value: unknown) => boolean
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const str: Check = (v) => typeof v === "string"
const num: Check = (v) => typeof v === "number"
const bool: Check = (v) => typeof v === "boolean"
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v)
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v)
const any: Check = () => true
const object =
  (shape: Record<string, Check>): Check =>
  (v) =>
    isObj(v) && Object.entries(shape).every(([key, check]) => check(v[key]))
const array =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check)
const union =
  (...checks: Check[]): Check =>
  (v) =>
    checks.some((check) => check(v))

export const CarePlanStatusSchema = object({
  carePlanId: str,
  status: str,
  pricing: object({
    subtotal_cents: num,
    shipping_cents: num,
    tax_cents: num,
    total_cost_cents_before_discount: num,
    total_cost_cents: num,
    discount_percent: nullable(num),
    discount_type: nullable(str),
  }),
  state: str,
})

const SubscriptionStatusDataSchema = object({
  id: str,
  user_id: str,
  stripe_customer_id: nullable(str),
  stripe_subscription_id: nullable(str),
  stripe_checkout_session_id: nullable(str),
  checkout_url: nullable(str),
  cp_id: nullable(str),
  price_cents: nullable(num),
  subtotal_price: any,
  tax_cents: nullable(num),
  shipping_cents: nullable(num),
  discount_percent: nullable(num),
  coupon_id: nullable(str),
  interval_days: nullable(num),
  idempotency_key: nullable(str),
  subscription_intent_id: nullable(str),
  stripe_latest_invoice_id: nullable(str),
  status_reason: nullable(str),
  status: str,
  last_fulfilled_invoice_id: nullable(str),
  next_renewal_date: nullable(str),
  last_invoice_paid_at: nullable(str),
  created_at: nullable(str),
  updated_at: nullable(str),
})

export const SubscriptionStatusSchema = object({
  success: bool,
  data: union(
    SubscriptionStatusDataSchema,
    object({ hasActiveSubscription: bool, message: optional(str) }),
  ),
})

export const CancelSubscriptionResponseSchema = object({
  success: bool,
  data: union(
    object({ subscription_id: str, status: str, message: optional(str) }),
    object({ success: bool, message: optional(str), alreadyCancelled: optional(bool) }),
  ),
})

export const PlusUserUpdateResponseSchema = object({ success: bool, message: optional(str) })

export const OrderHistoryResponseSchema = object({
  data: array(
    object({
      id: num,
      carePlanId: str,
      invoiceId: str,
      wholeScriptsOrderId: str,
      submitSuccess: bool,
      orderDate: str,
      status: str,
      tracking: array(object({ number: str, link: str, carrier: str })),
      shipMethod: str,
      supplements: array(object({ sku: str, quantity: num, itemTime: str, name: str })),
      billingCycle: num,
      needsPolling: bool,
      lastPolled: str,
      pricingSnapshot: object({ context: isObj, pricing: isObj }),
      createdAt: str,
      updatedAt: str,
      activeCarePlan: bool,
    }),
  ),
  page: num,
  count: num,
  total: num,
  totalPages: num,
})

const ErrorResponseSchema = object({
  error: str,
  message: optional(str),
  statusCode: optional(num),
})

export const BloodworkResultsReceivedResponseSchema = object({ message: str })

// ─── Backend: MakorAiClientService ─────────────────────────────────────────────────────────

const MAKOR_EXPECTED_ABSENCES: ReadonlySet<string> = new Set([
  "no active or approved care plan found for this user",
])

export type ApiResponse<T> = { data: T | null; status: number; message?: string }

export type LogLine = { level: "log" | "warn" | "error"; message: string }

export class MakorAiClient {
  readonly logs: LogLine[] = []

  constructor(
    private readonly config: { url?: string; apiKey?: string },
    private readonly send: Fetch,
  ) {}

  private log(level: LogLine["level"], message: string) {
    this.logs.push({ level, message })
  }

  private async makeApiRequest<T>(
    endpoint: string,
    options: {
      schema: Check
      config?: { method?: string; body?: string; headers?: Record<string, string> }
      queryParams?: Record<string, string | number>
    },
  ): Promise<ApiResponse<T>> {
    if (!this.config.apiKey) {
      this.log("error", "Missing MAKOR_AI_API_KEY environment variable")
      throw new Error("Makor AI API key not configured")
    }
    if (!this.config.url) {
      this.log("error", "Missing MAKOR_AI_API_URL environment variable")
      throw new Error("Makor AI API URL not configured")
    }
    const method = options.config?.method ?? "GET"
    let url = `${this.config.url}${endpoint}`
    if (options.queryParams) {
      const searchParams = new URLSearchParams()
      for (const [key, value] of Object.entries(options.queryParams)) {
        searchParams.append(key, value.toString())
      }
      url += `?${searchParams.toString()}`
    }
    let response: Response
    try {
      response = await this.send(
        new Request(url, {
          method,
          headers: {
            "x-api-key": this.config.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(options.config?.headers ?? {}),
          },
          ...(options.config?.body !== undefined ? { body: options.config.body } : {}),
        }),
      )
    } catch {
      this.log("error", `Makor AI API request failed: ${endpoint}`)
      throw new Error("Failed to make request to Makor AI")
    }
    if (!response.ok) {
      let errorMessage = response.statusText
      try {
        const errorData: unknown = await response.json()
        if (ErrorResponseSchema(errorData)) {
          const parsed = errorData as { error: string; message?: string }
          errorMessage = parsed.message ?? parsed.error ?? response.statusText
        }
      } catch {
        // Not JSON: statusText is all there is.
      }
      const failure = `Makor AI API request failed: ${method} ${endpoint} -> ${response.status} ${response.statusText} (${errorMessage})`
      const expectedAbsence = MAKOR_EXPECTED_ABSENCES.has(
        errorMessage
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ")
          .replace(/[.!]+$/, ""),
      )
      if (response.status >= 500 || (response.status === 404 && !expectedAbsence)) {
        this.log("error", failure)
      } else {
        this.log("warn", failure)
      }
      return { data: null, status: response.status, message: errorMessage }
    }
    const rawData: unknown = await response.json()
    if (!options.schema(rawData)) {
      this.log("error", `Invalid response format from Makor AI API: ${endpoint}`)
      return {
        data: null,
        status: response.status,
        message: "Invalid response format from Makor AI API",
      }
    }
    return { data: rawData as T, status: response.status, message: response.statusText }
  }

  async getCurrentCarePlan(userId: string | number) {
    const response = await this.makeApiRequest<Record<string, unknown>>(
      `/api/care-plans/current-care-plan-details/${userId}`,
      { schema: CarePlanStatusSchema },
    )
    if (response.status !== 200) {
      this.log("warn", `Failed to get care plan for user ${userId}: ${response.message}`)
      return null
    }
    return response.data
  }

  async cancelSubscription(userId: string | number) {
    const response = await this.makeApiRequest<Record<string, unknown>>(
      `/api/subscription/cancel/${userId}`,
      { schema: CancelSubscriptionResponseSchema, config: { method: "POST" } },
    )
    if (response.status !== 200) return null
    return response.data
  }

  async getSubscriptionStatus(userId: string | number) {
    const response = await this.makeApiRequest<Record<string, unknown>>(
      `/api/subscription/status/${userId}`,
      { schema: SubscriptionStatusSchema },
    )
    if (response.status !== 200) return null
    return response.data
  }

  async updatePlusUser(userId: string | number, plusUser: boolean) {
    const response = await this.makeApiRequest<{ success: boolean; message?: string }>(
      `/api/care-plans/plus-user/${userId}`,
      {
        schema: PlusUserUpdateResponseSchema,
        config: { method: "PATCH", body: JSON.stringify({ plusUser }) },
      },
    )
    if (response.status !== 200) {
      this.log("warn", `Failed to update plus user for user ${userId}: ${response.message}`)
      return null
    }
    return response.data
  }

  async getOrderHistory(userId: string | number, params: { page?: number; count?: number } = {}) {
    const queryParams: Record<string, string | number> = {}
    if (params.page !== undefined) queryParams.page = params.page
    if (params.count !== undefined) queryParams.count = params.count
    const response = await this.makeApiRequest<Record<string, unknown>>(
      `/api/wholescripts-orders/user/${userId}`,
      { schema: OrderHistoryResponseSchema, queryParams },
    )
    if (response.status !== 200) return null
    return response.data
  }

  async postMakorAiBloodworkResultsReceived(userId: number, labResultId: string) {
    const response = await this.makeApiRequest<{ message: string }>(`/api/bloodwork/webhook`, {
      schema: BloodworkResultsReceivedResponseSchema,
      config: {
        method: "POST",
        body: JSON.stringify({ userId: String(userId), labResultsId: labResultId }),
      },
    })
    if (response.status !== 202) {
      this.log(
        "warn",
        `Failed to post bloodwork results received for user ${userId}: ${response.message}`,
      )
      return null
    }
    this.log("log", `Bloodwork results received for user ${userId}`)
    return { success: true, message: "Webhook received and processed successfully" }
  }
}

// ─── EMR frontend: cpg-api.ts (axios semantics) ───────────────────────────────────────────

/** What axios throws for a non-2xx answer or a timeout. */
export class AxiosLikeError extends Error {
  readonly isAxiosError = true
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly response: { status: number; data: unknown } | undefined,
  ) {
    super(message)
  }
}

const isAxiosError = (error: unknown): error is AxiosLikeError => error instanceof AxiosLikeError

export class CpgApi {
  readonly consoleErrors: string[] = []

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly send: Fetch,
    /** axios instance default. */
    private readonly defaultTimeoutMs = 20_000,
    /** Browser origin, so CORS is exercised the way the EMR's requests would be. */
    private readonly origin = "http://localhost:3001",
  ) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl.trim())
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    data?: unknown,
    customHeaders?: Record<string, string>,
    timeout?: number,
    suppressErrorStatuses: number[] = [],
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeout ?? this.defaultTimeoutMs)
    let response: Response
    try {
      response = await this.send(
        new Request(`${this.baseUrl}${endpoint}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            origin: this.origin,
            ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
            ...(customHeaders ?? {}),
          },
          ...(data !== undefined && method !== "GET" ? { body: JSON.stringify(data) } : {}),
          signal,
        }),
      )
    } catch (error) {
      const timedOut = signal.aborted
      const thrown = new AxiosLikeError(
        timedOut ? "timeout exceeded" : "Network Error",
        timedOut ? "ECONNABORTED" : "ERR_NETWORK",
        undefined,
      )
      this.consoleErrors.push(`CPG API ${method} request failed for ${endpoint}`)
      throw error instanceof AxiosLikeError ? error : thrown
    }
    // The browser enforces CORS: without an allow-origin header the call fails like a network error.
    if (!response.headers.get("access-control-allow-origin")) {
      throw new AxiosLikeError("Network Error", "ERR_NETWORK", undefined)
    }
    const text = await response.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new AxiosLikeError(
        `Request failed with status code ${response.status}`,
        "ERR_BAD_RESPONSE",
        { status: response.status, data: body },
      )
      if (!suppressErrorStatuses.includes(response.status)) {
        this.consoleErrors.push(`CPG API ${method} request failed for ${endpoint}`)
      }
      throw error
    }
    return body as T
  }
}

// ─── EMR frontend: user-summary.service.ts ────────────────────────────────────────────────

export type FullUserSummary = {
  user_id: string
  summary: { general_summary: string[]; past_visits: string[]; intake_summary?: string[] }
  biomarker_analysis: Record<string, unknown>
}

export type UserSummaryResponse = {
  cpgUserId: string
  summary: FullUserSummary
  isMostRecent: boolean
  createdAt: string
}

export const generateUserSummary = async (
  api: CpgApi,
  request: { user_id: string; [key: string]: unknown },
): Promise<FullUserSummary> => {
  if (!request.user_id?.trim()) throw new Error("User ID is required")
  if (!api.isConfigured()) throw new Error("AI summary service is not configured")
  return api.request<FullUserSummary>(
    "POST",
    "/api/v2/generate-user-summary",
    request,
    undefined,
    50_000,
  )
}

export const getLatestUserSummary = async (
  api: CpgApi,
  cpgUserId: string,
): Promise<UserSummaryResponse | null> => {
  if (!cpgUserId?.trim()) throw new Error("User ID is required")
  if (!api.isConfigured()) return null
  try {
    return await api.request<UserSummaryResponse>(
      "GET",
      `/api/v2/user-summary/${encodeURIComponent(cpgUserId)}`,
      undefined,
      undefined,
      undefined,
      [404],
    )
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 404) return null
    throw error
  }
}

// ─── EMR frontend: async-review-script.service.ts ─────────────────────────────────────────

const AI_GENERATION_TIMEOUT = 180_000

export class AsyncReviewScriptError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message)
    this.name = "AsyncReviewScriptError"
  }
}

export type ReviewScriptOptions = {
  intakeForm?: string
  chartingNotes?: { title?: string; content: string; created_at?: string; provider_name?: string }[]
  demographics?: { first_name?: string; last_name?: string; age?: number; state?: string }
}

export type AsyncReviewScript = {
  id: number
  labTestId: string
  reviewType: "initial" | "comparative"
  status: "processing" | "complete" | "failed"
  scriptContent: Record<string, unknown> | null
  errorMessage?: string | null
  isMostRecent?: boolean
  createdAt: string
  updatedAt: string
}

export type GenerateReviewResponse = {
  message: string
  reviewId: number
  status: "processing" | "complete" | "failed"
  reviewType: "initial" | "comparative"
  scriptContent: Record<string, unknown> | null
  errorMessage?: string
}

const validateParams = (userId: string, labTestId: string): void => {
  if (!userId?.trim()) {
    throw new AsyncReviewScriptError("Invalid userId: must be a non-empty string")
  }
  if (!labTestId?.trim()) {
    throw new AsyncReviewScriptError("Invalid labTestId: must be a non-empty string")
  }
}

const getErrorMessage = (error: unknown, defaultMessage: string): string => {
  if (isAxiosError(error)) {
    const data = error.response?.data as Record<string, unknown> | undefined
    if (data?.errorMessage) return String(data.errorMessage)
    if (data?.message) return String(data.message)
    if (data?.error) return String(data.error)
    if (error.code === "ECONNABORTED") return "Request timed out. Please try again."
    if (error.code === "ERR_NETWORK") return "Network error. Please check your connection."
  }
  return defaultMessage
}

export const getReviewByLabTest = async (
  api: CpgApi,
  userId: string,
  labTestId: string,
): Promise<AsyncReviewScript | null> => {
  validateParams(userId, labTestId)
  try {
    const response = await api.request<{ review: AsyncReviewScript }>(
      "GET",
      `/api/async-review-script/${encodeURIComponent(userId)}/${encodeURIComponent(labTestId)}`,
    )
    return response.review
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 404) return null
    throw new AsyncReviewScriptError(
      getErrorMessage(error, "Failed to fetch review script"),
      isAxiosError(error) ? error.response?.status : undefined,
    )
  }
}

export const generateReviewScript = async (
  api: CpgApi,
  userId: string,
  labTestId: string,
  options?: ReviewScriptOptions,
): Promise<GenerateReviewResponse> => {
  validateParams(userId, labTestId)
  try {
    return await api.request<GenerateReviewResponse>(
      "POST",
      "/api/async-review-script/generate",
      { userId, labTestId, ...options },
      undefined,
      AI_GENERATION_TIMEOUT,
    )
  } catch (error) {
    throw new AsyncReviewScriptError(
      getErrorMessage(error, "Failed to generate review script"),
      isAxiosError(error) ? error.response?.status : undefined,
    )
  }
}

export const regenerateReviewScript = async (
  api: CpgApi,
  userId: string,
  labTestId: string,
  options?: ReviewScriptOptions,
): Promise<GenerateReviewResponse> => {
  validateParams(userId, labTestId)
  try {
    return await api.request<GenerateReviewResponse>(
      "POST",
      `/api/async-review-script/regenerate/${encodeURIComponent(userId)}/${encodeURIComponent(labTestId)}`,
      options ?? {},
      undefined,
      AI_GENERATION_TIMEOUT,
    )
  } catch (error) {
    throw new AsyncReviewScriptError(
      getErrorMessage(error, "Failed to regenerate review script"),
      isAxiosError(error) ? error.response?.status : undefined,
    )
  }
}

/** `ai-review-notes.tsx` `handleGenerate` / `handleRegenerate`: what the panel ends up showing. */
export type PanelState = { error: string | null; script: AsyncReviewScript | null }

export const handleGenerate = async (
  api: CpgApi,
  userId: string,
  labResultId: string,
  mode: "generate" | "regenerate" = "generate",
): Promise<PanelState> => {
  try {
    const response =
      mode === "generate"
        ? await generateReviewScript(api, userId, labResultId)
        : await regenerateReviewScript(api, userId, labResultId)
    if (response.status === "failed") {
      return { error: response.errorMessage ?? "Review generation failed.", script: null }
    }
    if (response.status === "processing" && !response.scriptContent) {
      return {
        error: "Review generation is still processing. Please try again shortly.",
        script: null,
      }
    }
    const data = await getReviewByLabTest(api, userId, labResultId)
    if (data) return { error: null, script: data }
    return {
      error: null,
      script: {
        id: response.reviewId,
        labTestId: labResultId,
        reviewType: response.reviewType,
        status: response.status,
        scriptContent: response.scriptContent,
        createdAt: "",
        updatedAt: "",
      },
    }
  } catch (error) {
    return {
      error:
        error instanceof AsyncReviewScriptError ? error.message : `Failed to ${mode} review script`,
      script: null,
    }
  }
}
