import { jsonResponse, type OperationContext } from "@crvouga/mockingbird-service"
import { StripeError, stripeErrorBody } from "./errors.js"
import type { StripeState } from "./state.js"

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

const fingerprint = (context: OperationContext) =>
  stable({
    method: context.request.method,
    path: context.url.pathname,
    query: context.query,
    body: context.body.kind === "empty" ? null : context.body,
  })

/**
 * Stripe stores the first response for an Idempotency-Key. A retry with the same parameters
 * replays it; a retry with different parameters is an idempotency error. The official SDKs
 * send this header on every POST.
 */
export const withIdempotency = (
  state: StripeState,
  handler: (context: OperationContext) => Promise<Response> | Response,
) => {
  return async (context: OperationContext) => {
    if (context.request.method !== "POST") return handler(context)
    const key = context.request.headers.get("idempotency-key")
    if (key === null || key === "") return handler(context)
    if (key.length > 255)
      throw new StripeError({
        status: 400,
        type: "idempotency_error",
        message: "Idempotency keys can be up to 255 characters long.",
      })
    const print = fingerprint(context)
    const existing = await state.idempotency.get(key)
    if (existing) {
      if (existing.fingerprint !== print)
        throw new StripeError({
          status: 400,
          type: "idempotency_error",
          message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
        })
      return jsonResponse(existing.status, existing.body, { "idempotent-replayed": "true" })
    }
    try {
      const response = await handler(context)
      const body = await response.clone().json()
      await state.idempotency.insert(key, { fingerprint: print, status: response.status, body })
      return response
    } catch (error) {
      if (!(error instanceof StripeError)) throw error
      const body = stripeErrorBody(error.init, await state.requestLogUrl())
      await state.idempotency.insert(key, { fingerprint: print, status: error.init.status, body })
      return jsonResponse(error.init.status, body)
    }
  }
}
