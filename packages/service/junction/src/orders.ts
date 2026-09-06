import {
  HttpError,
  jsonResponse,
  type OperationContext,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import type { JunctionState } from "./state.js"
import {
  deterministicUuid,
  LAB_TEST_CATALOG,
  labTestById,
  MOCK_TEAM_ID,
  type OrderRecord,
  type OrderTransactionEmbed,
} from "./state.js"

function notFound(message: string): never {
  throw new HttpError(404, { detail: message })
}

const queryInt = (context: OperationContext, name: string, fallback: number): number => {
  const raw = context.query[name]
  if (raw === undefined) return fallback
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw))
    throw new HttpError(422, { detail: `${name} must be an integer` })
  return Number(raw)
}

const transactionEmbed = (order: OrderRecord): OrderTransactionEmbed => order.order_transaction

const orderSummary = (order: OrderRecord) => ({
  id: order.id,
  origin: null,
  parent_id: null,
  last_status: "ordered",
  last_status_created_at: order.created_at,
  updated_at: order.updated_at,
  created_at: order.created_at,
})

const biomarker = (order: OrderRecord, created_at: string) =>
  order.lab_test.markers.map((marker) => ({
    name: marker.name,
    slug: marker.slug,
    result: marker.result,
    type: "numeric",
    unit: marker.unit,
    timestamp: created_at,
    reference_range: marker.reference_range,
    interpretation: "normal",
    performing_laboratory: "Mockingbird Central Lab",
    source_sample_id: null,
  }))

export const orderHandlers = (state: JunctionState) => ({
  get_paginated_lab_tests_for_team_v3_lab_test_get: async () =>
    jsonResponse(200, { data: LAB_TEST_CATALOG, next_cursor: null }),

  get_lab_test_for_team_v3_lab_tests__lab_test_id__get: async (context: OperationContext) => {
    const id = context.params.lab_test_id ?? ""
    const test = labTestById(id)
    if (!test) notFound("Lab test not found")
    return jsonResponse(200, test)
  },

  create_order_v3_order_post: async (context: OperationContext) => {
    if (
      context.body.kind !== "json" ||
      typeof context.body.value !== "object" ||
      context.body.value === null
    ) {
      throw new HttpError(422, { detail: "expected a JSON object body" })
    }
    const body = context.body.value as Record<string, unknown>
    const userId = body.user_id
    if (typeof userId !== "string") {
      throw new HttpError(422, { detail: "user_id must be a string" })
    }
    if (!state.users.has(userId)) notFound("User not found")
    const details = body.patient_details
    if (
      !details ||
      typeof details !== "object" ||
      Array.isArray(details) ||
      typeof (details as Record<string, unknown>).dob !== "string" ||
      typeof (details as Record<string, unknown>).gender !== "string"
    ) {
      throw new HttpError(422, { detail: "patient_details needs string dob and gender" })
    }
    const address = body.patient_address
    if (!address || typeof address !== "object" || Array.isArray(address)) {
      throw new HttpError(422, { detail: "patient_address must be an object" })
    }
    for (const key of ["first_line", "city", "state", "zip", "country"]) {
      if (typeof (address as Record<string, unknown>)[key] !== "string")
        throw new HttpError(422, { detail: `patient_address.${key} must be a string` })
    }
    const orderSet = body.order_set
    if (!orderSet || typeof orderSet !== "object" || Array.isArray(orderSet))
      throw new HttpError(422, { detail: "order_set must be an object" })
    const labTestIds = (orderSet as Record<string, unknown>).lab_test_ids
    if (!Array.isArray(labTestIds) || labTestIds.length === 0)
      throw new HttpError(422, { detail: "order_set.lab_test_ids must be a non-empty array" })
    const labTests = labTestIds.map((id) => (typeof id === "string" ? labTestById(id) : undefined))
    if (labTests.some((test) => test === undefined)) notFound("Lab test not found")
    const labTest = labTests[0] as NonNullable<(typeof labTests)[number]>

    const nowIso = state.isoNow(context.now)
    const orderId = state.nextOrderId()
    const transactionId = state.transactionIdFor(orderId)
    const event = {
      id: 1,
      created_at: nowIso,
      status: "received.testkit.ordered",
      status_detail: null,
    }
    const order: OrderRecord = {
      id: orderId,
      user_id: userId,
      team_id: MOCK_TEAM_ID,
      patient_details: details as Record<string, unknown>,
      patient_address: address as Record<string, unknown>,
      lab_test: labTest,
      details: {
        type: "testkit",
        data: {
          id: state.testkitIdFor(orderId),
          shipment: {
            id: deterministicUuid(`junction:shipment:${orderId}`),
            outbound_tracking_number: null,
            outbound_tracking_url: null,
            inbound_tracking_number: null,
            inbound_tracking_url: null,
            outbound_courier: "MockingbirdCourier",
            inbound_courier: "MockingbirdCourier",
            notes: null,
          },
          created_at: nowIso,
          updated_at: nowIso,
        },
      },
      sample_id: `smp_${opaqueToken(`junction:sample:${orderId}`, 16)}`,
      notes: null,
      clinical_notes: typeof body.clinical_notes === "string" ? body.clinical_notes : null,
      passthrough: typeof body.passthrough === "string" ? body.passthrough : null,
      created_at: nowIso,
      updated_at: nowIso,
      events: [event],
      status: null,
      last_event: event,
      health_insurance_id: null,
      requisition_form_url: `https://mockingbird.example/requisitions/${opaqueToken(`junction:requisition:${orderId}`, 24)}`,
      shipping_details: null,
      has_abn: false,
      order_transaction: {
        id: transactionId,
        status: "active",
        orders: [{ id: orderId, created_at: nowIso, updated_at: nowIso }],
      },
    }
    state.orders.insert(orderId, order)
    state.orderByTransaction.insert(transactionId, { order_id: orderId })
    return jsonResponse(200, { order, status: "SUCCESS", message: "Order submitted" })
  },

  get_order_v3_order__order_id__get: async (context: OperationContext) => {
    const id = context.params.order_id ?? ""
    const order = state.orders.get(id)
    if (!order) notFound("Order not found")
    return jsonResponse(200, order)
  },

  get_orders_v3_orders_get: async (context: OperationContext) => {
    const page = queryInt(context, "page", 1)
    const size = queryInt(context, "size", 50)
    if (page < 1 || size < 1 || size > 100)
      throw new HttpError(422, { detail: "page must be >= 1 and size must be 1..100" })
    const userId = context.query.user_id
    if (userId !== undefined && typeof userId !== "string")
      throw new HttpError(422, { detail: "user_id must be a string" })
    let all = state.orders.list({ order: "oldest" })
    if (userId !== undefined) all = all.filter((entry) => entry.value.user_id === userId)
    const pageItems = all.slice((page - 1) * size, page * size)
    return jsonResponse(200, {
      orders: pageItems.map((entry) => entry.value),
      total: all.length,
      page,
      size,
    })
  },

  get_order_transaction_v3_order_transaction__transaction_id__get: async (
    context: OperationContext,
  ) => {
    const id = context.params.transaction_id ?? ""
    const binding = state.orderByTransaction.get(id)
    const order = binding ? state.orders.get(binding.order_id) : undefined
    if (!order) notFound("Order transaction not found")
    return jsonResponse(200, {
      id,
      team_id: MOCK_TEAM_ID,
      status: order.order_transaction.status,
      orders: [orderSummary(order)],
    })
  },

  get_order_transaction_result_v3_order_transaction__transaction_id__result_get: async (
    context: OperationContext,
  ) => {
    const id = context.params.transaction_id ?? ""
    const binding = state.orderByTransaction.get(id)
    const order = binding ? state.orders.get(binding.order_id) : undefined
    if (!order) notFound("Order transaction not found")
    const user = order.user_id ? state.users.get(order.user_id) : undefined
    return jsonResponse(200, {
      metadata: {
        age: "41",
        dob: "1983-06-23",
        patient: user?.client_user_id ?? order.user_id,
        date_reported: "2024-11-02",
        specimen_number: opaqueToken(`junction:specimen:${order.id}`, 24),
        status: "final",
        laboratory: "Mockingbird Central Lab",
        provider: null,
        interpretation: null,
        patient_id: null,
        account_id: null,
        date_collected: null,
        date_received: null,
        "clia_#": null,
      },
      results: biomarker(order, order.created_at),
      missing_results: null,
      sample_information: null,
      order_transaction: transactionEmbed(order),
    })
  },
})
