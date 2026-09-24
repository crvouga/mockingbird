// Seam: the EMR backend uses zod 4 (`zod`); here zod 4 comes from zod@3.25's `zod/v4` entry.
import { z } from "zod/v4"

export const FULLSCRIPT_LAB_ORDER_STATES = [
  "not_purchased",
  "purchased",
  "schedule_appointment",
  "upcoming_appointment",
  "processing",
  "partial_results",
  "results_ready",
  "interpretation_shared",
  "results_amended",
] as const

export type FullscriptLabOrderState = (typeof FULLSCRIPT_LAB_ORDER_STATES)[number]

export const FULLSCRIPT_TERMINAL_LAB_ORDER_STATES = [
  "results_ready",
  "interpretation_shared",
  "results_amended",
] satisfies FullscriptLabOrderState[]

// States that carry a fetchable result set (a PDF may exist). `partial_results` is
// results-bearing but NOT terminal — it triggers ingest without flipping completion.
export const FULLSCRIPT_RESULTS_BEARING_LAB_ORDER_STATES = [
  "partial_results",
  "results_ready",
  "interpretation_shared",
  "results_amended",
] satisfies FullscriptLabOrderState[]

const RESULTS_BEARING_STATE_SET = new Set<FullscriptLabOrderState>(
  FULLSCRIPT_RESULTS_BEARING_LAB_ORDER_STATES,
)
const TERMINAL_STATE_SET = new Set<FullscriptLabOrderState>(FULLSCRIPT_TERMINAL_LAB_ORDER_STATES)

export type FullscriptCollectionType = "Test-Kit" | "At-Home-Phlebotomy"

export function isResultsBearingFullscriptState(state: FullscriptLabOrderState) {
  return RESULTS_BEARING_STATE_SET.has(state)
}

// Terminal states flip `isTestCompleted` true; `partial_results` leaves it false.
export function isCompletedFullscriptState(state: FullscriptLabOrderState) {
  return TERMINAL_STATE_SET.has(state)
}

// Fullscript collection descriptors must not use the consumer-app-specific Walk-In type.
// Defaults to Test-Kit (the fallback per the W0-A addendum §1) for unknown/absent values.
export function mapFullscriptCollectionType(
  value: string | null | undefined,
): FullscriptCollectionType {
  const normalized = value?.toLowerCase() ?? ""
  if (
    normalized.includes("phleb") ||
    normalized.includes("at_home") ||
    normalized.includes("at-home") ||
    normalized.includes("appointment") ||
    normalized.includes("draw") ||
    normalized.includes("blood")
  ) {
    return "At-Home-Phlebotomy"
  }
  return "Test-Kit"
}

const stateSchema = z.enum(FULLSCRIPT_LAB_ORDER_STATES)
const eventSchema = z
  .object({
    id: z.string().min(1).max(255),
    type: z.string().min(1).max(255),
    clinic_id: z.string().min(1).max(255).optional(),
    created_at: z.iso.datetime().optional(),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .loose()
const webhookEnvelopeSchema = z
  .object({
    event_payload: z
      .object({
        event: eventSchema,
      })
      .loose(),
  })
  .loose()
const eventResponseSchema = z
  .object({
    event: eventSchema,
  })
  .loose()

export type FullscriptEvent = z.infer<typeof eventSchema>

const STATE_RANKS = new Map<FullscriptLabOrderState, number>(
  FULLSCRIPT_LAB_ORDER_STATES.map((state, index) => [state, index]),
)

export function parseFullscriptEventPayload(payload: unknown) {
  const webhookEnvelope = webhookEnvelopeSchema.safeParse(payload)
  if (webhookEnvelope.success) {
    return webhookEnvelope.data.event_payload.event
  }

  const eventResponse = eventResponseSchema.safeParse(payload)
  if (eventResponse.success) {
    return eventResponse.data.event
  }

  const event = eventSchema.safeParse(payload)
  return event.success ? event.data : null
}

export function normalizeFullscriptLabOrderState(value: unknown): FullscriptLabOrderState | null {
  if (value === "results_received") {
    return "partial_results"
  }
  if (value === "all_results_received") {
    return "results_ready"
  }
  const parsed = stateSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function selectMonotonicFullscriptLabOrderState(
  currentState: string,
  proposedState: FullscriptLabOrderState,
) {
  const current = normalizeFullscriptLabOrderState(currentState)
  if (!current) {
    return proposedState
  }
  return getStateRank(proposedState) > getStateRank(current) ? proposedState : current
}

function getStateRank(state: FullscriptLabOrderState) {
  return STATE_RANKS.get(state) ?? -1
}
