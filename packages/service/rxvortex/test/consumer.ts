/**
 * A port of our backend's RxVortex adapter (`rxvortex-auth.service.ts`,
 * `rxvortex-fulfillment.adapter.ts`, the pharmacy webhook receiver): the same requests, the
 * same field fallbacks, the same status interpretation. The acceptance tests drive the mock
 * through it, so "the mock works" means "our consumer's own logic reaches the right outcome".
 */
export type FulfillmentStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "shipped"
  | "delivered"
  | "error"
  | "cancelled"

export type Fetch = (request: Request) => Promise<Response>

const safeJson = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export const mapStatus = (rawStatus: string): FulfillmentStatus => {
  const s = rawStatus.toLowerCase().trim().replace(/\s+/g, " ")
  if (s.includes("deliver")) return "delivered"
  if (s.includes("cancel") || s === "outdate") return "cancelled"
  if (s.includes("error") || s.includes("fail") || s.includes("reject")) return "error"
  if (
    s.startsWith("fulfillment complete") ||
    s === "completed orders" ||
    s === "shipping" ||
    s === "in transit" ||
    s === "rx reshipment" ||
    s.includes("pickup") ||
    s.includes("pick up") ||
    s.includes("will call")
  )
    return "shipped"
  if (
    s.includes("fill") ||
    s.includes("compound") ||
    [
      "ready for pv1",
      "pv1 complete",
      "assembly complete",
      "final verification complete",
      "complete processing",
      "on hold",
      "on order",
      "out of stock",
      "rx replacement",
      "rx typed",
      "sterile pending compounding",
      "non-sterile pending compounding",
    ].includes(s)
  )
    return "processing"
  return "submitted"
}

const RANK: Record<FulfillmentStatus, number> = {
  pending: 0,
  submitted: 1,
  processing: 2,
  shipped: 3,
  delivered: 4,
  error: 5,
  cancelled: 5,
}

export const resolveBestStatus = (fields: {
  rxStatus: string | null
  orderStatus: string | null
  shippingStatus: string | null
  deliveredDate: string | null
  trackingNumber: string | null | undefined
}): FulfillmentStatus => {
  if (fields.deliveredDate) return "delivered"
  let best: FulfillmentStatus = "submitted"
  for (const raw of [fields.rxStatus, fields.orderStatus, fields.shippingStatus]) {
    if (!raw) continue
    const mapped = mapStatus(raw)
    if (RANK[mapped] > RANK[best]) best = mapped
  }
  return fields.trackingNumber && (best === "submitted" || best === "processing") ? "shipped" : best
}

export const extractErrorMessage = (body: Record<string, unknown> | null, status: number) => {
  if (!body) return `RxVortex API failed: ${status}`
  const errors = body.errors
  if (Array.isArray(errors) && errors.length > 0) {
    return `RxVortex API failed: ${status} (${errors.length} validation errors)`
  }
  if (errors && typeof errors === "object") {
    return `RxVortex API failed: ${status} invalid fields=${Object.keys(errors).join(",")}`
  }
  return `RxVortex API failed: ${status}`
}

const readString = (body: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = body[key]
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return null
}

/** The backend's RxVortex client, over any `fetch` (in-process mock or HTTP). */
export class RxVortexConsumer {
  private token: string | null = null

  constructor(
    private readonly apiUrl: string,
    private readonly credentials: { clientId: string; clientSecret: string },
    private readonly fetch: Fetch,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.token) return this.token
    const response = await this.fetch(
      new Request(`${this.apiUrl}/api/v1/generate-access-token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
        }),
      }),
    )
    if (!response.ok)
      throw new Error(`RxVortex auth failed: ${response.status} ${await response.text()}`)
    const payload = (await response.json()) as Record<string, unknown>
    const token =
      (typeof payload.access_token === "string" && payload.access_token) ||
      (typeof payload.token === "string" && payload.token) ||
      null
    if (!token) throw new Error("RxVortex auth response missing access_token")
    this.token = token
    return token
  }

  async submit(
    paymentId: string,
    payload: Record<string, unknown>,
  ): Promise<{ success: boolean; pharmacyOrderId?: string; error?: string }> {
    const token = await this.getAccessToken()
    const response = await this.fetch(
      new Request(`${this.apiUrl}/api/v1/orders`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      }),
    )
    const body = safeJson(await response.text())
    if (!response.ok) {
      const error = extractErrorMessage(body, response.status)
      const recovered = await this.recover(paymentId)
      if (recovered) return { success: true, pharmacyOrderId: recovered }
      return { success: false, error }
    }
    const id = body?.order_tracking_id ?? body?.orderTrackingId
    if (!id || typeof id !== "string") {
      return { success: false, error: "Response missing order_tracking_id" }
    }
    return { success: true, pharmacyOrderId: id }
  }

  async recover(paymentId: string): Promise<string | null> {
    const token = await this.getAccessToken()
    const response = await this.fetch(
      new Request(`${this.apiUrl}/api/v1/orders/${encodeURIComponent(paymentId)}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      }),
    )
    if (!response.ok) return null
    const body = safeJson(await response.text())
    if (!body) return null
    const id =
      (body.tracking_id as string | undefined) ??
      (body.orderReferenceID as string | undefined) ??
      (body.order_tracking_id as string | undefined)
    return typeof id === "string" && id.trim().length > 0 ? id : null
  }

  async status(pharmacyOrderId: string) {
    const token = await this.getAccessToken()
    const response = await this.fetch(
      new Request(`${this.apiUrl}/api/v1/orders/${encodeURIComponent(pharmacyOrderId)}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      }),
    )
    if (!response.ok) return null
    const body = safeJson(await response.text())
    if (!body) return null
    return {
      fulfillmentStatus: resolveBestStatus({
        rxStatus: readString(body, ["rxstatus"]),
        orderStatus: readString(body, ["orderstatus"]),
        shippingStatus: readString(body, ["shipping_status"]),
        deliveredDate: readString(body, ["delivered_date"]),
        trackingNumber: readString(body, ["trackingnumber"]),
      }),
      trackingNumber: readString(body, ["trackingnumber"]),
      trackingCarrier: readString(body, ["shippingservice"]),
      canCancel: typeof body.cancellable === "boolean" ? body.cancellable : null,
    }
  }

  async cancel(pharmacyOrderId: string): Promise<{ success: boolean; error?: string }> {
    const token = await this.getAccessToken()
    const response = await this.fetch(
      new Request(`${this.apiUrl}/api/v1/orders/${encodeURIComponent(pharmacyOrderId)}`, {
        method: "DELETE",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      }),
    )
    const body = safeJson(await response.text())
    if (!response.ok) return { success: false, error: extractErrorMessage(body, response.status) }
    return { success: true }
  }
}

/**
 * The pharmacy webhook receiver: plain-equality secret check, object or array body,
 * id fallbacks, silently dropping unknown order ids.
 */
export const receiveWebhook = (
  secret: string,
  headers: Headers,
  body: unknown,
  known: (orderId: string) => boolean,
):
  | { accepted: false; reason: string }
  | { accepted: true; orderId: string; status: FulfillmentStatus; tracking: string | null }
  | { accepted: true; dropped: true } => {
  if (headers.get("x-rxvortex-webhook-secret") !== secret) {
    return { accepted: false, reason: "bad secret" }
  }
  const entry = (Array.isArray(body) ? body[0] : body) as Record<string, unknown>
  const orderId =
    (entry.orderReferenceID as string) ??
    (entry.order_tracking_id as string) ??
    (entry.tracking_id as string)
  if (!orderId || !known(orderId)) return { accepted: true, dropped: true }
  const tracking =
    (entry.trackingnumber as string | null) ?? (entry.shipmenttrackingurl as string | null) ?? null
  return {
    accepted: true,
    orderId,
    tracking,
    status: resolveBestStatus({
      rxStatus: (entry.rxstatus as string) || null,
      orderStatus: (entry.orderstatus as string) || null,
      shippingStatus: (entry.shipping_status as string) || null,
      deliveredDate: (entry.delivered_date as string) || null,
      trackingNumber: tracking,
    }),
  }
}

/** A submit payload the way `buildPayload` shapes one. */
export const samplePayload = (paymentId: string, presetId: string) => ({
  patient: {
    sender_patient_id: "user-42",
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "1985-02-14",
    gender: "female",
    email: "ada@example.com",
    phone: "602-555-0142",
    address: {
      line1: "1 Main St",
      line2: "",
      city: "Phoenix",
      state: "AZ",
      postal_code: "85004",
      country: "US",
    },
  },
  prescriber: {
    first_name: "Grace",
    last_name: "Hopper",
    npi: "1234567893",
    dea_number: "",
    license_number: "MD-1",
    license_state: "AZ",
    phone: "602-555-0100",
  },
  order: { bill_to: "practice", ship_to: "patient", sender_order_id: paymentId },
  medication_requests: [
    {
      type: "new",
      preset_catalog_id: presetId,
      sender_med_request_id: paymentId,
      medication_name: "Testosterone Cypionate",
      medication_strength: "200 mg/mL",
      medication_form: "Injectable",
      quantity: 10,
      quantity_units: "mL",
      days_supply_duration: 30,
      refills: 0,
      instructions: "Inject 0.5 mL weekly",
      authored_on_datetime: "2026-09-20T12:00:00.000Z",
      schedule_code: "3",
    },
  ],
  clinical: {
    allergies: { has_known_allergies: false, entries: [] },
    diseases: { has_known_diseases: false, entries: [] },
    medications: { has_known_medications: false, entries: [] },
  },
  shipment: {
    recipient_first_name: "Ada",
    recipient_last_name: "Lovelace",
    recipient_email: "ada@example.com",
    recipient_phone: "602-555-0142",
    address: {
      line1: "1 Main St",
      line2: "",
      city: "Phoenix",
      state: "AZ",
      postal_code: "85004",
      country: "US",
    },
  },
})
