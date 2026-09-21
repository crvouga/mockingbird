import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type FullUserSummary,
  MakorCpgState,
  type ReviewRecord,
  type ScriptContent,
  type Settings,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  BiomarkerAnalysis,
  BloodworkRecord,
  CarePlanRecord,
  FullUserSummary,
  LabFinding,
  OrderRecord,
  Pricing,
  ReviewRecord,
  ReviewStatus,
  ScriptContent,
  Settings,
  SubscriptionRecord,
  SummaryContent,
  SummaryRecord,
} from "./state.js"
export { DEFAULT_SETTINGS } from "./state.js"

export const MAKOR_CPG_NAMESPACE = "makor-cpg"

/**
 * The exact "no care plan" message. Our backend treats a 404 carrying it as an expected
 * absence (warn, not error): `MAKOR_EXPECTED_ABSENCES` in makor-ai-client.service.ts.
 */
export const NO_CARE_PLAN_MESSAGE = "No active or approved care plan found for this user"

export type MakorCpgAPIOptions = APIOptions & {
  /** Initial per-namespace settings (accepted API keys, review processing time). */
  settings?: Partial<Settings>
}

/** The credential a request carries: the `x-api-key` header. */
export const apiKeyCredential = (request: Request): string | undefined =>
  request.headers.get("x-api-key")?.trim() || undefined

const error = (status: number, name: string, message: string) =>
  jsonRes(status, { error: name, message, statusCode: status })
const notFound = (message: string) => error(404, "Not Found", message)
const badRequest = (message: string) => error(400, "Bad Request", message)

const describeIssues = (issues: { path: string; message: string }[]) =>
  issues.map((issue) => `${issue.path || "body"}: ${issue.message}`).join("; ")

const emptyAnalysis = (testDate: string) => ({
  test_date: testDate,
  total_out_of_range: 0,
  total_optimal: 0,
  by_severity: {
    alarm_high: [],
    alarm_low: [],
    out_of_standard_high: [],
    out_of_standard_low: [],
    out_of_optimal_high: [],
    out_of_optimal_low: [],
  },
})

/**
 * The script a review carries when no fixture is set: deterministic, and built from nothing
 * the caller sent (no intake or chart text is echoed back).
 */
export const defaultScriptContent = (labTestId: string): ScriptContent => ({
  overview: {
    summary: `Mock async review script for lab test ${labTestId}.`,
    patterns: ["No clinically significant patterns (mock)."],
  },
  labFindings: {
    thyroid: [
      {
        marker: "TSH",
        value: "1.8 mIU/L",
        status: "optimal",
        interpretation: "Within the optimal range (mock).",
      },
    ],
    stressAdrenal: [],
    metabolicBloodSugar: [
      {
        marker: "HbA1c",
        value: "5.2 %",
        status: "optimal",
        interpretation: "Within the optimal range (mock).",
      },
    ],
    inflammationImmune: [],
    nutrientStatus: [
      {
        marker: "Vitamin D",
        value: "28 ng/mL",
        status: "low",
        interpretation: "Below the optimal range (mock).",
      },
    ],
  },
  symptomsVsLabChanges: [],
  nutritionRecommendations: [
    {
      recommendation: "Add a daily serving of fatty fish.",
      rationale: "Supports vitamin D status (mock).",
      priority: "medium",
    },
  ],
  fiberGuidance: {
    included: true,
    categories: [
      {
        category: "Legumes",
        options: "Lentils, chickpeas, black beans",
        howToAdd: "Half a cup with lunch.",
      },
    ],
  },
  supplementRecommendations: [
    {
      supplement: "Vitamin D3",
      purpose: "Raise vitamin D toward optimal",
      relevance: "Vitamin D below optimal (mock).",
      timing: "Morning, with food",
    },
  ],
  lifestyleRecommendations: [{ area: "Sleep", recommendation: "Keep a consistent schedule." }],
  reflectionQuestions: ["How has your energy been over the last month?"],
})

/**
 * Stateful mock of the legacy Makor AI ("CPG") API.
 *
 * Care plans, subscriptions and Wholescripts orders exist only when a test seeds them (a 404
 * or "no subscription" is the normal answer otherwise). Summaries are generated synchronously;
 * review scripts are accepted at once and move `processing` → `complete` after
 * `processingMs` on the mock clock.
 */
export class MakorCpgAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: MakorCpgState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: MakorCpgAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? MAKOR_CPG_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new MakorCpgState(sqlite, namespace, { settings: options.settings ?? {} })
    const handlers = defineOperations<SupportedOperationId>({
      GetCurrentCarePlan: (context) => this.getCarePlan(context),
      UpdatePlusUser: (context) => this.updatePlusUser(context),
      BloodworkResultsReceived: (context) => this.bloodworkReceived(context),
      CancelSubscription: (context) => this.cancelSubscription(context),
      GetSubscriptionStatus: (context) => this.subscriptionStatus(context),
      GetWholescriptsOrders: (context) => this.wholescriptsOrders(context),
      GenerateUserSummary: (context) => this.generateSummary(context),
      GetUserSummary: (context) => this.getSummary(context),
      GetReviewScript: (context) => this.getReview(context),
      GenerateReviewScript: (context) => this.generateReview(context, "generate"),
      RegenerateReviewScript: (context) => this.generateReview(context, "regenerate"),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) => notFound(`Cannot ${request.method} ${new URL(request.url).pathname}`),
      onError: (thrown) => {
        if (thrown instanceof HttpError) return thrown.toResponse()
        throw thrown
      },
      before: (context) => {
        const key = apiKeyCredential(context.request)
        if (!key) return error(401, "Unauthorized", "Missing API key")
        const keys = this.state.current().apiKeys
        if (keys.length > 0 && !keys.includes(key)) {
          return error(401, "Unauthorized", "Invalid API key")
        }
        if (faultEffect(context.request, "route_missing") !== undefined) {
          return notFound(`Cannot ${context.request.method} ${context.url.pathname}`)
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString()
  }

  private body(context: OperationContext): Record<string, unknown> {
    return context.body.kind === "json" &&
      typeof context.body.value === "object" &&
      context.body.value !== null &&
      !Array.isArray(context.body.value)
      ? (context.body.value as Record<string, unknown>)
      : {}
  }

  private getCarePlan(context: OperationContext): Response {
    const userId = context.params.userId ?? ""
    const plan = this.state.carePlans.get(userId)
    if (!plan) return annotateResponse(notFound(NO_CARE_PLAN_MESSAGE), { ids: { userId } })
    const { plusUser: _plusUser, ...body } = plan
    if (faultEffect(context.request, "care_plan_invalid_shape") !== undefined) {
      const { pricing: _pricing, ...partial } = body
      return jsonRes(200, partial)
    }
    return annotateResponse(jsonRes(200, body), { ids: { userId, carePlanId: plan.carePlanId } })
  }

  private updatePlusUser(context: OperationContext): Response {
    const issues = bodyIssues(context)
    if (issues.length > 0) return badRequest(describeIssues(issues))
    const userId = context.params.userId ?? ""
    const plan = this.state.carePlans.get(userId)
    if (!plan) return notFound(NO_CARE_PLAN_MESSAGE)
    const plusUser = this.body(context).plusUser === true
    this.state.carePlans.update(userId, { ...plan, plusUser })
    return annotateResponse(
      jsonRes(200, {
        success: true,
        message: `Plus user ${plusUser ? "enabled" : "disabled"} for care plan ${plan.carePlanId}`,
      }),
      { ids: { userId, carePlanId: plan.carePlanId } },
    )
  }

  private bloodworkReceived(context: OperationContext): Response {
    const issues = bodyIssues(context)
    if (issues.length > 0) return badRequest(describeIssues(issues))
    const body = this.body(context)
    const record = {
      userId: String(body.userId),
      labResultsId: String(body.labResultsId),
      receivedAt: this.iso(),
    }
    this.state.bloodwork.insert(`bw_${this.state.bloodwork.nextSequence()}`, record)
    const ids = { userId: record.userId, labResultsId: record.labResultsId }
    if (faultEffect(context.request, "bloodwork_not_accepted") !== undefined) {
      return annotateResponse(jsonRes(200, { message: "Webhook processed" }), { ids })
    }
    return annotateResponse(jsonRes(202, { message: "Webhook received" }), { ids })
  }

  private subscriptionStatus(context: OperationContext): Response {
    const userId = context.params.userId ?? ""
    const subscription = this.state.subscriptions.get(userId)
    const active = subscription && !/cancel/i.test(subscription.status)
    return jsonRes(200, {
      success: true,
      data: active
        ? subscription
        : { hasActiveSubscription: false, message: "No active subscription found for this user" },
    })
  }

  private cancelSubscription(context: OperationContext): Response {
    const userId = context.params.userId ?? ""
    const subscription = this.state.subscriptions.get(userId)
    if (!subscription) {
      return jsonRes(200, {
        success: true,
        data: { success: false, message: "No subscription found for this user" },
      })
    }
    if (/cancel/i.test(subscription.status)) {
      return jsonRes(200, {
        success: true,
        data: { success: true, message: "Subscription already cancelled", alreadyCancelled: true },
      })
    }
    this.state.subscriptions.update(userId, {
      ...subscription,
      status: "canceled",
      status_reason: "cancelled_via_api",
      updated_at: this.iso(),
    })
    return annotateResponse(
      jsonRes(200, {
        success: true,
        data: {
          subscription_id: String(subscription.stripe_subscription_id ?? subscription.id),
          status: "canceled",
          message: "Subscription cancelled",
        },
      }),
      { ids: { userId, subscriptionId: subscription.id } },
    )
  }

  private wholescriptsOrders(context: OperationContext): Response {
    const page = context.query.page === undefined ? 1 : Number(context.query.page)
    const count = context.query.count === undefined ? 10 : Number(context.query.count)
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(count) || count < 1) {
      return badRequest("page and count must be positive integers")
    }
    const orders = this.state.orders.get(context.params.userId ?? "") ?? []
    return jsonRes(200, {
      data: orders.slice((page - 1) * count, page * count),
      page,
      count,
      total: orders.length,
      totalPages: Math.ceil(orders.length / count),
    })
  }

  private generateSummary(context: OperationContext): Response {
    const issues = bodyIssues(context)
    if (issues.length > 0) return badRequest(describeIssues(issues))
    const body = this.body(context)
    const userId = String(body.user_id).trim()
    if (faultEffect(context.request, "generation_failed") !== undefined) {
      return error(500, "Internal Server Error", "Failed to generate user summary")
    }
    const forms = Array.isArray(body.intake_forms) ? body.intake_forms.length : 0
    const notes = Array.isArray(body.free_text_entries) ? body.free_text_entries.length : 0
    const fixture = this.state.summaryFixture(userId)
    const summary: FullUserSummary = {
      user_id: userId,
      summary: fixture?.summary ?? {
        general_summary: [
          `Mock summary for user ${userId}: ${forms} intake form(s) and ${notes} visit note(s) reviewed.`,
        ],
        past_visits: notes > 0 ? [`${notes} visit note(s) on file.`] : [],
        intake_summary: forms > 0 ? [`${forms} intake form(s) on file.`] : [],
      },
      biomarker_analysis: fixture?.biomarker_analysis ?? emptyAnalysis(this.iso().slice(0, 10)),
    }
    this.state.addSummary({ cpgUserId: userId, summary, createdAt: this.iso() })
    return annotateResponse(jsonRes(200, summary), { ids: { userId } })
  }

  private getSummary(context: OperationContext): Response {
    const userId = context.params.cpgUserId ?? ""
    const latest = this.state.summariesOf(userId)[0]
    if (!latest) return notFound("No summary found for this user")
    return annotateResponse(
      jsonRes(200, {
        cpgUserId: latest.cpgUserId,
        summary: latest.summary,
        isMostRecent: true,
        createdAt: latest.createdAt,
      }),
      { ids: { userId } },
    )
  }

  /** Complete a processing review once its time has come on the mock clock. */
  private settle(review: ReviewRecord): ReviewRecord {
    if (review.status !== "processing" || this.now() < review.readyAtMs) return review
    const done: ReviewRecord = {
      ...review,
      status: "complete",
      scriptContent: review.pending,
      updatedAt: this.iso(review.readyAtMs),
    }
    this.state.reviews.update(String(review.id), done)
    return done
  }

  /** Complete every review that is due. Runs on reads and on `POST /__admin/tick`. */
  tick(): number {
    let settled = 0
    for (const { value } of this.state.reviews.list()) {
      if (this.settle(value) !== value) settled++
    }
    return settled
  }

  private reviewBody(review: ReviewRecord, isMostRecent: boolean) {
    return {
      id: review.id,
      labTestId: review.labTestId,
      reviewType: review.reviewType,
      status: review.status,
      scriptContent: review.scriptContent,
      errorMessage: review.errorMessage,
      metadata: {
        inputTokens: 0,
        outputTokens: 0,
        model: "mockingbird",
        partialParse: false,
        generatedAt: review.updatedAt,
      },
      isMostRecent,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    }
  }

  private getReview(context: OperationContext): Response {
    const userId = context.params.userId ?? ""
    const labTestId = context.params.labTestId ?? ""
    const latest = this.state.reviewsOf(userId, labTestId)[0]
    if (!latest) return notFound("No review script found for this lab test")
    return annotateResponse(jsonRes(200, { review: this.reviewBody(this.settle(latest), true) }), {
      ids: { userId, labTestId, reviewId: String(latest.id) },
    })
  }

  private generateReview(context: OperationContext, mode: "generate" | "regenerate"): Response {
    const issues = bodyIssues(context)
    if (issues.length > 0) return badRequest(describeIssues(issues))
    const body = this.body(context)
    const userId = mode === "generate" ? String(body.userId).trim() : (context.params.userId ?? "")
    const labTestId =
      mode === "generate" ? String(body.labTestId).trim() : (context.params.labTestId ?? "")
    if (!userId || !labTestId) return badRequest("userId and labTestId are required")
    const previous = this.state.reviewsOf(userId, labTestId)[0]
    if (mode === "regenerate" && !previous) {
      return notFound("No review script found for this lab test")
    }
    const reviewType =
      previous?.reviewType ??
      (this.state.reviewsOf(userId).some((r) => r.labTestId !== labTestId)
        ? "comparative"
        : "initial")
    const content = this.state.reviewFixture(userId, labTestId) ?? defaultScriptContent(labTestId)
    const failed = faultEffect(context.request, "generation_failed") !== undefined
    const processingMs = this.state.current().processingMs
    const now = this.now()
    const status = failed ? "failed" : processingMs > 0 ? "processing" : "complete"
    const review: ReviewRecord = {
      id: this.state.nextReviewId(),
      userId,
      labTestId,
      reviewType,
      status,
      pending: content,
      scriptContent: status === "complete" ? content : null,
      errorMessage: failed ? "Review generation failed: upstream model error (mock)" : null,
      createdAt: this.iso(now),
      updatedAt: this.iso(now),
      readyAtMs: now + processingMs,
    }
    this.state.reviews.insert(String(review.id), review)
    const ids = { userId, labTestId, reviewId: String(review.id) }
    if (failed) {
      return annotateResponse(
        jsonRes(500, {
          message: "Failed to generate review script",
          reviewId: review.id,
          status: "failed",
          reviewType,
          scriptContent: null,
          errorMessage: review.errorMessage,
        }),
        { ids },
      )
    }
    const verb = mode === "generate" ? "generated" : "regenerated"
    return annotateResponse(
      jsonRes(200, {
        message:
          status === "complete"
            ? `Review script ${verb} successfully`
            : `Review script generation started`,
        reviewId: review.id,
        status,
        reviewType,
        scriptContent: review.scriptContent,
      }),
      { ids },
    )
  }
}

export type { MakorCpgRuntime, MakorCpgRuntimeOptions } from "./runtime.js"
export { CORS_HEADERS, createRuntime, MAKOR_CPG_PRESETS, withCors } from "./runtime.js"
