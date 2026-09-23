import { JunctionAPI } from "@crvouga/mockingbird-service-junction"
import type {
  CreateLabOrderInput,
  LabCatalogEntry,
  LabTestingClient,
  LabTestingEvent,
} from "../../app/ports/labTestingClient.js"

const BASE_URL = "https://api.sandbox.tryvital.io"
const API_KEY = "sk_us_mockingbird"

/** How long a freshly placed order takes to reach "results ready" in this demo. */
const RESULTS_READY_DELAY_MS = 4_000

type JunctionOrderResponse = { order: { id: string } }
type JunctionCatalogResponse = { data: { id: string; method: string }[] }

/**
 * Implements `LabTestingClient` against Mockingbird's in-process Junction
 * (Vital-shaped) mock. `dispatch` delivers this adapter's own webhooks back
 * into the app's `/api/webhooks/lab-testing` route — the same in-process,
 * no-socket call pattern used everywhere else in this app.
 */
export const createJunctionMockLabTesting = (params: {
  dispatch: (request: Request) => Promise<Response>
  webhookUrl: string
}): LabTestingClient => {
  const junction = new JunctionAPI({ identity: "adopt-users" })

  const request = (method: string, path: string, body?: unknown): Promise<Response> =>
    junction.fetch(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers: { "x-vital-api-key": API_KEY, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

  const listCatalog = async (): Promise<LabCatalogEntry[]> => {
    const response = await request("GET", "/v3/lab_test")
    const catalog = (await response.json()) as JunctionCatalogResponse
    return catalog.data
      .filter((test) => test.method === "testkit")
      .map((test) => ({ catalogTestId: test.id }))
  }

  const createOrder = async (input: CreateLabOrderInput): Promise<{ labOrderId: string }> => {
    const response = await request("POST", "/v3/order", {
      user_id: input.patientUserId,
      patient_details: {
        first_name: input.patient.firstName,
        last_name: input.patient.lastName,
        dob: "1990-01-01",
        gender: "unknown",
        phone_number: "+14155550100",
        email: input.patient.email,
      },
      patient_address: {
        first_line: "1 N Central Ave",
        city: "Phoenix",
        state: "AZ",
        zip: "85004",
        country: "US",
      },
      order_set: { lab_test_ids: input.catalogTestIds },
    })
    if (!response.ok) throw new Error(`Lab order creation failed (${response.status})`)
    const created = (await response.json()) as JunctionOrderResponse
    scheduleAutomaticProgress(created.order.id)
    return { labOrderId: created.order.id }
  }

  /**
   * Real lab turnaround takes days; the demo fast-forwards it on its own so
   * a visitor sees the full order lifecycle without any manual control.
   */
  const scheduleAutomaticProgress = (labOrderId: string): void => {
    setTimeout(() => {
      void (async () => {
        const updated = junction.transitionOrder(labOrderId, "completed.completed", {
          now: () => Date.now(),
          flags: { interpretation: "normal" },
        })
        if (!updated) return
        const event: LabTestingEvent = {
          type: "order.status_updated",
          labOrderId,
          status: "results_ready",
          interpretation: updated.interpretation ?? "normal",
        }
        await params.dispatch(
          new Request(params.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(event),
          }),
        )
      })()
    }, RESULTS_READY_DELAY_MS)
  }

  const parseWebhookEvent = (payload: string): LabTestingEvent => {
    try {
      const parsed = JSON.parse(payload) as LabTestingEvent
      if (parsed.type === "order.status_updated") return parsed
    } catch {
      // fall through
    }
    return { type: "unhandled" }
  }

  return { listCatalog, createOrder, parseWebhookEvent }
}
