export type LabPatient = { firstName: string; lastName: string; email: string }

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
  status: "processing" | "results_ready"
  interpretation: string | null
}
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
