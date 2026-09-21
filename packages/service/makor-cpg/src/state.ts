import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type Pricing = {
  subtotal_cents: number
  shipping_cents: number
  tax_cents: number
  total_cost_cents_before_discount: number
  total_cost_cents: number
  discount_percent: number | null
  discount_type: string | null
}

/** A user's current care plan (`GET /api/care-plans/current-care-plan-details/{userId}`). */
export type CarePlanRecord = {
  carePlanId: string
  /** `Approved` or `Active`. */
  status: string
  pricing: Pricing
  state: string
  /** Last value sent to `PATCH /api/care-plans/plus-user/{userId}`. */
  plusUser: boolean
}

/** The Stripe-backed blend subscription row (`SubscriptionStatusDataSchema`). */
export type SubscriptionRecord = Record<string, unknown> & {
  id: string
  user_id: string
  status: string
}

/** One Wholescripts order (`OrderItemSchema`), stored as given. */
export type OrderRecord = Record<string, unknown> & { id: number }

export type BiomarkerAnalysis = Record<string, unknown>

export type SummaryContent = {
  general_summary: string[]
  past_visits: string[]
  intake_summary?: string[]
}

export type FullUserSummary = {
  user_id: string
  summary: SummaryContent
  biomarker_analysis: BiomarkerAnalysis
}

export type SummaryRecord = {
  cpgUserId: string
  summary: FullUserSummary
  createdAt: string
}

export type LabFinding = {
  marker: string
  value: string
  previousValue?: string
  status: "optimal" | "low" | "high" | "trending_low" | "trending_high"
  interpretation: string
}

export type ScriptContent = {
  overview: { summary: string; patterns: string[] }
  labFindings: {
    thyroid: LabFinding[]
    stressAdrenal: LabFinding[]
    metabolicBloodSugar: LabFinding[]
    inflammationImmune: LabFinding[]
    nutrientStatus: LabFinding[]
  }
  symptomsVsLabChanges: { observation: string; labEvidence: string }[]
  nutritionRecommendations: {
    recommendation: string
    rationale: string
    priority: "high" | "medium" | "low"
  }[]
  fiberGuidance: {
    included: boolean
    categories: { category: string; options: string; howToAdd: string }[]
  }
  supplementRecommendations: {
    supplement: string
    purpose: string
    relevance: string
    timing: string | null
  }[]
  lifestyleRecommendations: { area: string; recommendation: string }[]
  reflectionQuestions: string[]
}

export type ReviewStatus = "processing" | "complete" | "failed"

/** One generated async-review script. Inputs (intake form, notes) are never stored. */
export type ReviewRecord = {
  id: number
  userId: string
  labTestId: string
  reviewType: "initial" | "comparative"
  status: ReviewStatus
  /** The content it will carry once complete. */
  pending: ScriptContent
  scriptContent: ScriptContent | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  /** Mock-clock ms when it becomes `complete`. */
  readyAtMs: number
}

/** An accepted bloodwork webhook: ids only. */
export type BloodworkRecord = { userId: string; labResultsId: string; receivedAt: string }

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these `x-api-key` values are accepted; empty means any non-empty key is. */
  apiKeys: string[]
  /** Mock-clock ms a generated review script stays `processing`. 0 = complete at once. */
  processingMs: number
}

export const DEFAULT_SETTINGS: Settings = { apiKeys: [], processingMs: 0 }

/** Fixture keys: a user id, or `*` for every user; review fixtures add a lab test id. */
const summaryKey = (userId: string) => `summary:${userId}`
const reviewKey = (userId: string, labTestId: string) => `review:${userId}:${labTestId}`

export class MakorCpgState {
  readonly carePlans: Collection<CarePlanRecord>
  readonly subscriptions: Collection<SubscriptionRecord>
  readonly orders: Collection<OrderRecord[]>
  readonly summaries: Collection<SummaryRecord>
  readonly reviews: Collection<ReviewRecord>
  readonly bloodwork: Collection<BloodworkRecord>
  readonly summaryFixtures: Collection<Omit<FullUserSummary, "user_id">>
  readonly reviewFixtures: Collection<ScriptContent>
  readonly settings: Collection<Settings>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { settings: Partial<Settings> },
  ) {
    this.carePlans = new Collection(sqlite, namespace, "care_plans")
    this.subscriptions = new Collection(sqlite, namespace, "subscriptions")
    this.orders = new Collection(sqlite, namespace, "wholescripts_orders")
    this.summaries = new Collection(sqlite, namespace, "summaries")
    this.reviews = new Collection(sqlite, namespace, "reviews")
    this.bloodwork = new Collection(sqlite, namespace, "bloodwork_webhooks")
    this.summaryFixtures = new Collection(sqlite, namespace, "summary_fixtures")
    this.reviewFixtures = new Collection(sqlite, namespace, "review_fixtures")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  setSummaryFixture(userId: string, fixture: Omit<FullUserSummary, "user_id">): void {
    this.summaryFixtures.insert(summaryKey(userId), fixture)
  }

  /** The user's own fixture, else the `*` fixture. */
  summaryFixture(userId: string): Omit<FullUserSummary, "user_id"> | undefined {
    return this.summaryFixtures.get(summaryKey(userId)) ?? this.summaryFixtures.get(summaryKey("*"))
  }

  setReviewFixture(userId: string, labTestId: string, content: ScriptContent): void {
    this.reviewFixtures.insert(reviewKey(userId, labTestId), content)
  }

  /** Most specific first: user + lab test, user, lab test, then `*`. */
  reviewFixture(userId: string, labTestId: string): ScriptContent | undefined {
    for (const key of [
      reviewKey(userId, labTestId),
      reviewKey(userId, "*"),
      reviewKey("*", labTestId),
      reviewKey("*", "*"),
    ]) {
      const found = this.reviewFixtures.get(key)
      if (found) return found
    }
    return undefined
  }

  /** The user's summaries, newest first. */
  summariesOf(userId: string): SummaryRecord[] {
    return this.summaries.list({ where: (s) => s.cpgUserId === userId }).map((row) => row.value)
  }

  addSummary(record: SummaryRecord): void {
    this.summaries.insert(`${record.cpgUserId}/${this.summaries.nextSequence()}`, record)
  }

  /** Reviews for one user (optionally one lab test), newest first. */
  reviewsOf(userId: string, labTestId?: string): ReviewRecord[] {
    return this.reviews
      .list({
        where: (r) => r.userId === userId && (labTestId === undefined || r.labTestId === labTestId),
      })
      .map((row) => row.value)
  }

  nextReviewId(): number {
    return this.reviews.count() + 1
  }
}
