import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** The synchronous statuses the job endpoint can answer with. */
export type JobStatus = "accepted" | "submitted" | "draft_ready" | "needs_review" | "error"

/** The statuses the callback can carry (the controller refuses `accepted`). */
export type CallbackStatus = Exclude<JobStatus, "accepted">

/** Our fulfilment statuses a `submitted` callback may carry (`fulfillmentStatus`). */
export type CallbackFulfillmentStatus =
  | "submitted"
  | "processing"
  | "shipped"
  | "delivered"
  | "error"
  | "cancelled"

/** The body the job endpoint answers with (every field but `status` optional). */
export type JobResponseBody = {
  status: JobStatus
  agentJobId?: string
  portalOrderId?: string
  portalDraftOrderId?: string
  confirmationNumber?: string
  message?: string
  screenshotArtifactId?: string
  submittedAt?: string
  needsReviewReason?: string
  errorCode?: string
  errorDetail?: string
}

/**
 * One job as the agent tracks it. Metadata only: the request carries portal credentials
 * (a secret) and patient/prescriber details (PHI), none of which is ever stored.
 */
export type JobRecord = {
  agentJobId: string
  idempotencyKey: string
  /** Deterministic hash of the whole request body, for idempotent replays. */
  fingerprint: string
  paymentId: string
  prescriptionOrderItemId: string | null
  pharmacyId: string
  allowSubmit: boolean
  stageForProviderSignature: boolean
  status: JobStatus
  /** The synchronous answer, replayed for the same idempotency key. */
  response: JobResponseBody
  httpStatus: number
  portalOrderId: string | null
  portalDraftOrderId: string | null
  confirmationNumber: string | null
  /** Callbacks fired for this job (`POST /__admin/jobs/:id/complete`). */
  callbacks: number
  created_at: string
  updated_at: string
}

/** A synchronous outcome to answer every new job with, instead of `accepted`. */
export type RespondWith = {
  status: CallbackStatus
  message?: string
  needsReviewReason?: string
  errorCode?: string
  errorDetail?: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Accepted bearer keys (`ERX_PORTAL_AGENT_API_KEY`); empty accepts any non-empty key. */
  apiKeys: string[]
  /** Answer new jobs synchronously with this outcome; `null` answers `accepted`. */
  respondWith: RespondWith | null
}

export const DEFAULT_SETTINGS: Settings = { apiKeys: [], respondWith: null }

export class PortalAgentState {
  readonly jobs: Collection<JobRecord>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { settings: Partial<Settings> },
  ) {
    this.jobs = new Collection(sqlite, namespace, "jobs")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "portal-agent")
    this.ensureSeeded()
  }

  /** Re-apply the settings after a reset. */
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

  byIdempotencyKey(key: string): JobRecord | undefined {
    return this.jobs.list({ where: (job) => job.idempotencyKey === key }).at(0)?.value
  }

  nextId(prefix: string): string {
    return this.ids.next(prefix, 16)
  }
}
