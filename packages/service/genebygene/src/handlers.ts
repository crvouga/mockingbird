import {
  HttpError,
  jsonResponse,
  type OperationContext,
  opaqueToken,
} from "@crvouga/mockingbird-service"
import type { GeneByGeneState } from "./state.js"

const requireBearer = (context: OperationContext) => {
  const auth = context.request.headers.get("authorization")
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, { error: "unauthorized", message: "Bearer token required" })
  }
}

const jsonBody = (context: OperationContext): Record<string, unknown> => {
  if (
    context.body.kind !== "json" ||
    typeof context.body.value !== "object" ||
    context.body.value === null
  ) {
    throw new HttpError(400, { message: "expected a JSON object body" })
  }
  return context.body.value as Record<string, unknown>
}

const formBody = (context: OperationContext): Record<string, string> => {
  if (context.body.kind === "form") {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(context.body.value)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  }
  if (
    context.body.kind === "json" &&
    typeof context.body.value === "object" &&
    context.body.value
  ) {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(context.body.value as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  }
  throw new HttpError(400, { error: "invalid_request", error_description: "expected form body" })
}

export const geneByGeneHandlers = (state: GeneByGeneState) => ({
  PostConnectToken: async (context: OperationContext) => {
    const body = formBody(context)
    if (body.grant_type !== "client_credentials") {
      throw new HttpError(400, {
        error: "unsupported_grant_type",
        error_description: "grant_type must be client_credentials",
      })
    }
    if (!body.client_id || !body.client_secret) {
      throw new HttpError(400, {
        error: "invalid_client",
        error_description: "client_id and client_secret are required",
      })
    }
    const token = opaqueToken(`gbg:${body.client_id}:${body.client_secret}`, 32)
    return jsonResponse(200, {
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
    })
  },

  GetProducts: async (context: OperationContext) => {
    requireBearer(context)
    state.ensureSeedProducts()
    const products = state.products.list({ order: "oldest" }).map((row) => row.value)
    return jsonResponse(200, products)
  },

  PostOrders: async (context: OperationContext) => {
    requireBearer(context)
    const body = jsonBody(context)
    const productId = body.productId
    const quantity = body.quantity
    if (typeof productId !== "string")
      throw new HttpError(400, { message: "productId is required" })
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
      throw new HttpError(400, { message: "quantity must be a positive integer" })
    }
    if (!state.products.has(productId)) {
      throw new HttpError(400, { message: `unknown productId ${productId}` })
    }
    const orderId = state.nextOrderId()
    const order = {
      orderId,
      status: "Pending" as const,
      quantity,
      productId,
      createdAt: state.isoNow(context.now),
    }
    state.orders.insert(orderId, order)
    return jsonResponse(200, order)
  },

  GetOrder: async (context: OperationContext) => {
    requireBearer(context)
    const id = context.params.orderId ?? ""
    const order = state.orders.get(id)
    if (!order) throw new HttpError(404, { message: "order not found" })
    return jsonResponse(200, order)
  },
})
