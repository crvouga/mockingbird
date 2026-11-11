export type LabPatient = { firstName: string; lastName: string; email: string; phone: string }

export type CreateLabOrderInput = {
  patientUserId: string
  patient: LabPatient
  /** Provider-side catalog ids, from `listCatalog()`. */
  catalogTestIds: string[]
}

export type LabCatalogEntry = { catalogTestId: string }

export type LabOrderStatusUpdatedEvent = {
  type: "order.status_updated"
  labOrderId: string
  status: LabOrderStatus
  interpretation: string | null
  /** Set when the collection kit shipped. */
  tracking?: { carrier: string; number: string } | null
}
/** In the order a kit moves: out to the patient, back to the lab, reported. */
export const LAB_ORDER_STATUSES = ["shipped", "processing", "results_ready"] as const
export type LabOrderStatus = (typeof LAB_ORDER_STATUSES)[number]
export type LabTestingEvent = LabOrderStatusUpdatedEvent | { type: "unhandled" }

/**
 * A lab-testing provider's order + webhook surface, shaped after real
 * diagnostics APIs (Vital/Junction and similar): list what can be ordered,
 * place an order for a patient, and later receive webhooks as the order
 * moves through collection and processing.
 */
export interface LabTestingClient {
  listCatalog(): Promise<LabCatalogEntry[]>
  createOrder(input: CreateLabOrderInput): Promise<{ labOrderId: string }>
  parseWebhookEvent(payload: string): LabTestingEvent
}
