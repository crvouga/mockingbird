import type { ExploreRng, ExploreState, LogicalCommand } from "@crvouga/mockingbird-commands"
import {
  availabilityAddressForZip,
  GEVITI_QA_ORDER_ADDRESSES,
  GEVITI_QA_PATIENT,
  GEVITI_QA_PHLEBOTOMY_ZIPS,
  GEVITI_QA_PSC_LAB_IDS,
  GEVITI_QA_ROUTING_ZIPS,
  GEVITI_QA_SCHEDULING_ZIPS,
} from "./qa-corpus.js"
import { CANCELLATION_REASONS, PSC_CANCELLATION_REASONS } from "./scheduling.js"

const GEO_AREA = "get_area_info_v3_order_area_info_get"
const GEO_PSC = "get_psc_info_v3_order_psc_info_get"
const AVAIL_PHLEB =
  "get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post"
const AVAIL_PSC = "get_psc_appointment_availability_v3_order_psc_appointment_availability_post"

/** Stable address fields so availability observation-cache keys match prefetch (85004). */
export const GEVITI_QA_AVAILABILITY_ADDRESS = {
  first_line: "1 N Central Ave",
  second_line: null as string | null,
  city: "Phoenix",
  state: "AZ",
  unit: null as string | null,
} as const

/** Far-future start date so slots are always generated relative to frozen test clocks. */
export const GEVITI_QA_AVAILABILITY_START_DATE = "2099-06-15"

const pickZip = (rng: ExploreRng, zips: readonly string[]) =>
  zips[rng.nextInt(Math.max(0, zips.length - 1))] ?? zips[0] ?? "85004"

const pickLabId = (rng: ExploreRng, labs: readonly number[]) =>
  labs[rng.nextInt(Math.max(0, labs.length - 1))] ?? labs[0] ?? 4

const availabilityBody = (zip: string) => availabilityAddressForZip(zip)

/**
 * Pin geo / availability params onto the Geviti QA ZIP + lab corpus so observation-cache
 * hits stay sealed during seedParity compare walks.
 */
export const reshapeGevitiQaGeoCommand = (
  command: LogicalCommand,
  _state: ExploreState,
  rng: ExploreRng,
  options?: {
    zips?: readonly string[]
    schedulingZips?: readonly string[]
    phlebotomyZips?: readonly string[]
    labIds?: readonly number[]
  },
): LogicalCommand => {
  const zips = options?.zips ?? GEVITI_QA_ROUTING_ZIPS
  const schedulingZips = options?.schedulingZips ?? GEVITI_QA_SCHEDULING_ZIPS
  const phlebotomyZips = options?.phlebotomyZips ?? GEVITI_QA_PHLEBOTOMY_ZIPS
  const labIds = options?.labIds ?? GEVITI_QA_PSC_LAB_IDS
  const id = command.operationId

  if (id === "create_order_v3_order_post") {
    const address =
      GEVITI_QA_ORDER_ADDRESSES[rng.nextInt(GEVITI_QA_ORDER_ADDRESSES.length - 1)] ??
      GEVITI_QA_ORDER_ADDRESSES[0]
    const raw =
      typeof command.body === "object" && command.body !== null && !Array.isArray(command.body)
        ? (command.body as Record<string, unknown>)
        : {}
    const rawOrderSet =
      typeof raw.order_set === "object" && raw.order_set !== null && !Array.isArray(raw.order_set)
        ? (raw.order_set as Record<string, unknown>)
        : {}
    const rawIds = Array.isArray(rawOrderSet.lab_test_ids) ? rawOrderSet.lab_test_ids : []
    const labTestId =
      rawIds.find(
        (entry) =>
          (typeof entry === "string" && entry.length > 0) ||
          (typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).$mockingbird === "ref"),
      ) ??
      (typeof raw.lab_test_id === "string" ||
      (typeof raw.lab_test_id === "object" &&
        raw.lab_test_id !== null &&
        !Array.isArray(raw.lab_test_id) &&
        (raw.lab_test_id as Record<string, unknown>).$mockingbird === "ref")
        ? raw.lab_test_id
        : undefined)
    // Geviti QA and Vital default collection_method to the panel's native method.
    // Random mismatches force sandbox auto_generated lab_tests whose UUIDs Vital
    // allocates opaquely; keep a low rate so we still exercise that path after seed.
    const methods = ["at_home_phlebotomy", "walk_in_test"] as const
    const forceMismatch = rng.next() < 0.12
    const body: Record<string, unknown> = {
      user_id: raw.user_id,
      patient_details: { ...GEVITI_QA_PATIENT },
      patient_address: {
        receiver_name: "Ada Lovelace",
        first_line: address?.first_line,
        city: address?.city,
        state: address?.state,
        zip: address?.zip,
        country: address?.country,
        phone_number: GEVITI_QA_PATIENT.phone_number,
      },
      order_set: labTestId === undefined ? { lab_test_ids: [] } : { lab_test_ids: [labTestId] },
      clinical_notes: null,
      passthrough: null,
      aoe_answers: null,
      lab_account_id: null,
    }
    if (forceMismatch) {
      body.collection_method = methods[rng.nextInt(methods.length - 1)] ?? "at_home_phlebotomy"
    }
    return {
      ...command,
      body,
      mediaType: command.mediaType ?? "application/json",
      invalid: undefined,
    }
  }
  if (id === "get_teams_users_v2_user_get") {
    // Team user lists are newest-first with same-second ties; across seed + lockstep
    // creates the 2nd+ slots are still racy. Geviti QA only needs membership/total —
    // pin limit=1 so we compare the newest user + totals without slot races.
    const raw =
      typeof command.parameters === "object" && command.parameters !== null
        ? (command.parameters as Record<string, unknown>)
        : {}
    const offsetRaw = raw.offset
    const offset =
      typeof offsetRaw === "string" && /^-?\d+$/.test(offsetRaw) ? Number(offsetRaw) : 0
    return {
      ...command,
      parameters: {
        offset: String(Math.max(0, offset)),
        limit: "1",
      },
      invalid: undefined,
    }
  }
  if (id === GEO_AREA) {
    return {
      ...command,
      parameters: { zip_code: pickZip(rng, zips) },
    }
  }
  if (id === GEO_PSC) {
    return {
      ...command,
      parameters: {
        zip_code: pickZip(rng, zips),
        lab_id: String(pickLabId(rng, labIds)),
      },
    }
  }
  if (id === AVAIL_PHLEB) {
    const zip = pickZip(rng, phlebotomyZips)
    return {
      ...command,
      parameters: {
        start_date: GEVITI_QA_AVAILABILITY_START_DATE,
      },
      body: availabilityBody(zip),
      mediaType: command.mediaType ?? "application/json",
      invalid: undefined,
    }
  }
  if (id === AVAIL_PSC) {
    const zip = pickZip(rng, schedulingZips)
    return {
      ...command,
      parameters: {
        lab: "quest",
        start_date: GEVITI_QA_AVAILABILITY_START_DATE,
      },
      body: availabilityBody(zip),
      mediaType: command.mediaType ?? "application/json",
      invalid: undefined,
    }
  }
  if (id === "simulate_order_v3_order__order_id__test_post") {
    const statuses = [
      "received.at_home_phlebotomy.ordered",
      "collecting_sample.at_home_phlebotomy.appointment_scheduled",
      "sample_with_lab.at_home_phlebotomy.partial_results",
      "completed.at_home_phlebotomy.completed",
      "received.walk_in_test.ordered",
      "collecting_sample.walk_in_test.appointment_scheduled",
      "completed.walk_in_test.completed",
    ] as const
    return {
      ...command,
      parameters: {
        order_id: command.parameters?.order_id,
        final_status: statuses[rng.nextInt(statuses.length - 1)] ?? statuses[0],
      },
      body: {},
      mediaType: "application/json",
      invalid: undefined,
    }
  }
  if (id === "cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch") {
    const reason = CANCELLATION_REASONS.find((entry) => entry.name !== "Other") ?? CANCELLATION_REASONS[0]
    return {
      ...command,
      body: {
        cancellation_reason_id: reason?.id ?? "5c0257ef-6fea-4a22-b20a-3ddab573d5c9",
        notes: null,
      },
      mediaType: command.mediaType ?? "application/json",
      invalid: undefined,
    }
  }
  if (id === "cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch") {
    const reason = PSC_CANCELLATION_REASONS[0]
    return {
      ...command,
      body: {
        cancellationReasonId: reason?.id ?? "5c0257ef-6fea-4a22-b20a-3ddab573d5c9",
        note: null,
      },
      mediaType: command.mediaType ?? "application/json",
      invalid: undefined,
    }
  }
  return command
}
