/**
 * Our EMR backend's Fullscript integration, pointed at a base URL:
 *
 * - `test/upstream/` holds copies of `fullscript-api-client.ts`, `fullscript-webhook-signature.ts`
 *   and `fullscript-event-model.ts`, changed only at the seams (the Fastify logger type; zod 4
 *   imported from `zod/v4`).
 * - Below are ports of the pieces that depend on Fastify, Postgres or S3: the webhook
 *   controller (`routers/v1/fullscript/webhook-controller.ts`: empty-body challenge, signature
 *   check, challenge acknowledgement), the event processor's state handling
 *   (`fullscript-event-processor.ts`: `order.placed` claims, monotonic `lab_order.updated`,
 *   results-bearing dispatch, idempotency by event id) over an in-memory repository, the
 *   poller's missed-event recovery (`fullscript-polling-reconciler.ts`), and the result PDF
 *   download guard (`fullscript-result-storage.ts` `downloadVendorPdf`, with the host allowlist).
 */
import { createHash } from "node:crypto"
import { FullscriptApiClient } from "./upstream/fullscript-api-client.js"
import {
  type FullscriptLabOrderState,
  isResultsBearingFullscriptState,
  normalizeFullscriptLabOrderState,
  parseFullscriptEventPayload,
  selectMonotonicFullscriptLabOrderState,
} from "./upstream/fullscript-event-model.js"
import { verifyFullscriptWebhookSignature } from "./upstream/fullscript-webhook-signature.js"

export { FullscriptApiClient, FullscriptApiError } from "./upstream/fullscript-api-client.js"
export { FULLSCRIPT_LAB_ORDER_STATES } from "./upstream/fullscript-event-model.js"

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const createClient = (options: {
  apiUrl: string
  fetch: Fetch
  clientId?: string
  clientSecret?: string
  redirectUri?: string
}) => {
  const logs: Record<string, unknown>[] = []
  const logger = {
    info: (fields: unknown) => logs.push({ level: "info", ...(fields as object) }),
    warn: (fields: unknown) => logs.push({ level: "warn", ...(fields as object) }),
  }
  const client = new FullscriptApiClient({
    apiUrl: options.apiUrl,
    clientId: options.clientId ?? "emr-client",
    clientSecret: options.clientSecret ?? "emr-secret",
    redirectUri: options.redirectUri ?? "https://emr.example.com/v1/fullscript/oauth/callback",
    logger,
    fetchImplementation: options.fetch as typeof fetch,
  })
  return { client, logs }
}

/** The EMR's Fullscript tables, in memory: what the event processor reads and writes. */
export class FakeEmr {
  readonly processedEvents = new Map<string, string | null>()
  /** Lab orders the EMR tracks, by Fullscript order id. */
  readonly orders = new Map<
    string,
    { clinicId: string; state: string; treatmentPlanIds: string[] }
  >()
  /** Treatment plans the EMR created (so `order.placed` can be matched). */
  readonly treatmentPlans = new Set<string>()
  readonly resultsDispatches: { clinicId: string; orderId: string }[] = []

  hasEvent(id: string) {
    return this.processedEvents.has(id)
  }

  /** `FullscriptEventProcessor.process`. */
  process(payload: unknown): "processed" | "duplicate" {
    const event = parseFullscriptEventPayload(payload)
    if (!event) throw new FullscriptInvalidEventError()
    if (this.processedEvents.has(event.id)) return "duplicate"
    let dispatch: { clinicId: string; orderId: string } | null = null
    let outcome: string | null = null
    if (event.type === "order.placed") {
      const data = event.data as {
        id?: string
        treatment_plan_ids?: string[]
        treatment_plan_id?: string
        line_items?: { type?: string; lab_type?: string }[]
      }
      const labs = (data.line_items ?? []).filter(
        (i) => (i.type ?? i.lab_type) === "labs" || (i.type ?? i.lab_type) === "lab",
      )
      if (!event.clinic_id || !data.id) outcome = "invalid_payload"
      else if (labs.length > 0) {
        const plans = [
          ...new Set([
            ...(data.treatment_plan_ids ?? []),
            ...(data.treatment_plan_id ? [data.treatment_plan_id] : []),
          ]),
        ]
        if (!plans.some((p) => this.treatmentPlans.has(p))) outcome = "unmatched_order"
        else if (!this.orders.has(data.id)) {
          this.orders.set(data.id, {
            clinicId: event.clinic_id,
            state: "purchased",
            treatmentPlanIds: plans,
          })
        }
      }
    } else if (event.type === "lab_order.updated") {
      const raw = event.data as Record<string, unknown>
      const labOrder = (
        typeof raw.lab_order === "object" && raw.lab_order ? raw.lab_order : raw
      ) as Record<string, unknown>
      const orderId = typeof labOrder.id === "string" ? labOrder.id : null
      const rawState = typeof labOrder.state === "string" ? labOrder.state : labOrder.status
      const state = normalizeFullscriptLabOrderState(rawState)
      if (!orderId || !rawState || !event.clinic_id) outcome = "invalid_payload"
      else if (!state) outcome = "unsupported_state"
      else {
        const tracked = this.orders.get(orderId)
        if (!tracked || tracked.clinicId !== event.clinic_id) outcome = "unmatched_order"
        else {
          tracked.state = selectMonotonicFullscriptLabOrderState(tracked.state, state)
          if (isResultsBearingFullscriptState(state))
            dispatch = { clinicId: event.clinic_id, orderId }
        }
      }
    }
    this.processedEvents.set(event.id, outcome)
    if (dispatch) this.resultsDispatches.push(dispatch)
    return "processed"
  }

  stateOf(orderId: string): FullscriptLabOrderState | null {
    return normalizeFullscriptLabOrderState(this.orders.get(orderId)?.state)
  }
}

export class FullscriptInvalidEventError extends Error {}

/** `FullscriptWebhookController.handleWebhook`, framework-free. */
export const handleWebhook = (options: {
  rawBody: Uint8Array
  signatureHeader: string | null
  secret: string
  challengeKey: string
  emr: FakeEmr
  now?: Date
}): { status: number; body: Record<string, unknown> } => {
  if (options.rawBody.byteLength === 0) {
    if (!options.challengeKey) {
      return {
        status: 503,
        body: { error: "Service Unavailable", code: "fullscript_challenge_key_unprovisioned" },
      }
    }
    return { status: 200, body: { challenge: options.challengeKey } }
  }
  if (
    !verifyFullscriptWebhookSignature({
      rawBody: Buffer.from(options.rawBody),
      signatureHeader: options.signatureHeader ?? undefined,
      secret: options.secret,
      ...(options.now ? { now: options.now } : {}),
    })
  ) {
    return { status: 401, body: { error: "Unauthorized", message: "Invalid webhook signature" } }
  }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(options.rawBody))
  } catch {
    return { status: 200, body: { challenge: options.challengeKey } }
  }
  try {
    options.emr.process(payload)
    return { status: 200, body: { challenge: options.challengeKey } }
  } catch (error) {
    if (error instanceof FullscriptInvalidEventError) {
      return { status: 200, body: { challenge: options.challengeKey } }
    }
    return { status: 500, body: { error: "Internal Server Error" } }
  }
}

/** The poller's `recoverClinicEvents`: page events, fetch and process the unseen ones. */
export const recoverClinicEvents = async (
  client: FullscriptApiClient,
  accessToken: string,
  clinicId: string,
  emr: FakeEmr,
) => {
  let page = 1
  for (let pageCount = 0; pageCount < 20; pageCount += 1) {
    const eventPage = await client.listLabOrderEvents(accessToken, page)
    for (const event of eventPage.events) {
      if (event.clinicId && event.clinicId !== clinicId) continue
      if (emr.hasEvent(event.id)) continue
      emr.process(await client.getEvent(accessToken, event.id))
    }
    if (!eventPage.nextPage) return
    page = eventPage.nextPage
  }
}

export class FullscriptPdfValidationError extends Error {
  constructor(reason: string) {
    super(`Fullscript result PDF rejected: ${reason}`)
  }
}

/** `resolveAllowedHostSuffixes`: the env allowlist, else fullscript.com / .io plus the API host. */
export const allowedHostSuffixes = (env: Record<string, string | undefined>) => {
  const configured = env.FULLSCRIPT_RESULTS_PDF_HOST_ALLOWLIST?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  if (configured && configured.length > 0) return configured
  const suffixes = new Set(["fullscript.com", "fullscript.io"])
  try {
    if (env.FULLSCRIPT_API_URL) suffixes.add(new URL(env.FULLSCRIPT_API_URL).hostname.toLowerCase())
  } catch {
    // ignored, as upstream
  }
  return [...suffixes]
}

/** `FullscriptResultStorage.downloadVendorPdf`. */
export const downloadVendorPdf = async (
  pdfUrl: string,
  fetchImpl: Fetch,
  env: Record<string, string | undefined>,
  maxPdfBytes = 25 * 1024 * 1024,
) => {
  let parsed: URL
  try {
    parsed = new URL(pdfUrl)
  } catch {
    throw new FullscriptPdfValidationError("malformed URL")
  }
  if (parsed.protocol !== "https:") throw new FullscriptPdfValidationError("non-https URL")
  const host = parsed.hostname.toLowerCase()
  if (!allowedHostSuffixes(env).some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new FullscriptPdfValidationError("host not allowlisted")
  }
  let response: Response
  try {
    response = await fetchImpl(pdfUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new FullscriptPdfValidationError("download failed")
  }
  if (response.status >= 300 && response.status < 400)
    throw new FullscriptPdfValidationError("redirect not allowed")
  if (!response.ok)
    throw new FullscriptPdfValidationError(`unexpected status ${String(response.status)}`)
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/pdf")) {
    throw new FullscriptPdfValidationError("content-type was not application/pdf")
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new FullscriptPdfValidationError("empty body")
  if (bytes.byteLength > maxPdfBytes) throw new FullscriptPdfValidationError("exceeded byte limit")
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new FullscriptPdfValidationError("missing PDF magic bytes")
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
  }
}
