/** Lab-results surface: raw results, metadata, and deterministic PDF artifacts. */
import {
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import { applySimulateTransition, requireOrder } from "./scheduling.js"
import type { JunctionState, OrderRecord } from "./state.js"

const RESULT_TYPES = ["numeric", "range", "comment", "coded_value"] as const
type ResultType = (typeof RESULT_TYPES)[number]

const INTERPRETATIONS = ["normal", "abnormal", "critical", "unknown"] as const
type Interpretation = (typeof INTERPRETATIONS)[number]

/** Statuses from which results exist (sample has been drawn and reported). */
const RESULT_READY_STATUSES = ["sample_with_lab", "completed"]

const resultsReady = (order: OrderRecord): boolean =>
  RESULT_READY_STATUSES.some((prefix) => order.status.startsWith(prefix)) ||
  order.last_event.status.endsWith("draw_completed")

const parseInterpretation = (value: unknown): Interpretation =>
  INTERPRETATIONS.includes(value as Interpretation) ? (value as Interpretation) : "normal"

const pickResultType = (value: unknown, index: number): ResultType => {
  if (Array.isArray(value) && value.length > 0) {
    const entry = value[index % value.length]
    if (typeof entry === "string" && RESULT_TYPES.includes(entry as ResultType))
      return entry as ResultType
  }
  return "numeric"
}

const numericValueFor = (slug: string): number => {
  let hash = 0
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) % 1000
  return Math.round((40 + (hash % 160)) * 10) / 10
}

type BiomarkerLine = {
  name: string
  slug: string
  result: string
  type: ResultType
  value: number | null
  unit: string | null
  timestamp: string
  reference_range: string | null
  interpretation: Interpretation
  performing_laboratory: string
  source_sample_id: string | null
  notes: string | null
  string_value: string | null
  coded_value: string | null
  low_value: number | null
  high_value: number | null
  provider_id: string | null
}

const biomarkerLines = (order: OrderRecord, flags: SimulationFlagsState): BiomarkerLine[] => {
  const collected = order.last_event.created_at
  return (order.lab_test.markers ?? []).map((marker, index) => {
    const type = pickResultType(flags.resultTypes, index)
    const base: BiomarkerLine = {
      name: marker.name,
      slug: marker.slug,
      result: marker.slug,
      type,
      value: null,
      unit: marker.unit,
      timestamp: collected,
      reference_range: null,
      interpretation: flags.interpretation,
      performing_laboratory: "Mockingbird Central Lab",
      source_sample_id: order.sample_id,
      notes: null,
      string_value: null,
      coded_value: null,
      low_value: null,
      high_value: null,
      provider_id: marker.provider_id,
    }
    if (type === "numeric") {
      base.value = numericValueFor(marker.slug)
      base.result = String(base.value)
      base.reference_range = "0-200"
      base.low_value = 0
      base.high_value = 200
    } else if (type === "range") {
      base.low_value = 0
      base.high_value = 200
      base.value = numericValueFor(marker.slug)
      base.reference_range = "0-200"
      base.result = `${base.low_value}-${base.high_value}`
    } else if (type === "comment") {
      base.string_value = "No abnormal findings reported."
      base.result = base.string_value
    } else {
      base.coded_value = flags.interpretation === "normal" ? "N" : "A"
      base.result = base.coded_value
    }
    return base
  })
}

export type SimulationFlagsState = {
  interpretation: Interpretation
  resultTypes: readonly string[] | null
  hasMissingResults: boolean
}

const flagsOf = (order: OrderRecord): SimulationFlagsState => {
  const raw = order.result_types
  const resultTypes =
    Array.isArray(raw) && raw.length > 0
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : null
  return {
    interpretation: parseInterpretation(order.interpretation),
    resultTypes,
    hasMissingResults: order.has_missing_results === true,
  }
}

const metadataOf = (order: OrderRecord, userClient: string) => ({
  age: "41",
  dob: "1983-06-23",
  patient: userClient,
  date_reported: order.last_event.created_at.slice(0, 10),
  specimen_number: opaqueToken(`junction:specimen:${order.id}`, 24),
  status: "final",
  laboratory: "Mockingbird Central Lab",
  provider: null,
  interpretation: order.interpretation,
  patient_id: null,
  account_id: null,
  date_collected: order.last_event.created_at.slice(0, 10),
  date_received: order.last_event.created_at.slice(0, 10),
  "clia_#": null,
})

/** Minimal single-page PDF with a deterministic title; valid enough for byte-shape checks. */
const deterministicPdf = (title: string): Uint8Array => {
  const text = `BT /F1 14 Tf 72 720 Td (${title}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((entry, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${entry}\nendobj\n`
  })
  const xrefStart = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

function orderNotFound(message: string): never {
  throw new HttpError(404, { detail: message })
}

export const resultsHandlers = (state: JunctionState) => ({
  get_result_raw_v3_order__order_id__result_get: async (context: OperationContext) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context, "Order not found")
    const user = state.users.get(order.user_id)
    if (!resultsReady(order)) {
      return jsonRes(200, {
        metadata: metadataOf(order, user?.client_user_id ?? order.user_id),
        results: [],
        missing_results: null,
        sample_information: null,
        order_transaction: order.order_transaction,
      })
    }
    const flags = flagsOf(order)
    const results = biomarkerLines(order, flags)
    const missing = flags.hasMissingResults
      ? [
          {
            name: (order.lab_test.markers ?? [])[0]?.name ?? "Unknown marker",
            slug: (order.lab_test.markers ?? [])[0]?.slug ?? "unknown-marker",
            inferred_failure_type: "quantity_not_sufficient_failure",
            note: "Specimen quantity was not sufficient to run this marker.",
            loinc: null,
            loinc_slug: null,
            provider_id: (order.lab_test.markers ?? [])[0]?.provider_id ?? null,
            source_markers: null,
          },
        ]
      : null
    return jsonRes(200, {
      metadata: metadataOf(order, user?.client_user_id ?? order.user_id),
      results,
      missing_results: missing,
      sample_information: {
        [order.id]: {
          sample_id: order.sample_id ?? opaqueToken(`junction:sample:${order.id}`, 16),
          control_number: null,
          date_collected: order.last_event.created_at.slice(0, 10),
          date_received: order.last_event.created_at.slice(0, 10),
          date_reported: order.last_event.created_at.slice(0, 10),
          performing_laboratories: null,
          clinical_information: null,
        },
      },
      order_transaction: order.order_transaction,
    })
  },

  get_result_metadata_v3_order__order_id__result_metadata_get: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context, "Order not found")
    const user = state.users.get(order.user_id)
    return jsonRes(200, metadataOf(order, user?.client_user_id ?? order.user_id))
  },

  get_result_pdf_v3_order__order_id__result_pdf_get: async (context: OperationContext) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context, "Order not found")
    if (!resultsReady(order)) orderNotFound("Results are not available yet")
    const bytes = deterministicPdf(`Lab results ${order.id}`)
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })
  },

  get_order_requisition_pdf_v3_order__order_id__requisition_pdf_get: async (
    context: OperationContext,
  ) => {
    const orderId = context.params.order_id ?? ""
    const order = requireOrder(state, orderId, context, "This order doesn't exist")
    const bytes = deterministicPdf(`Requisition ${order.id}`)
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })
  },
})

export { applySimulateTransition }
