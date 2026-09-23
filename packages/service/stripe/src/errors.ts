import { HttpError } from "@crvouga/mockingbird-service"

export type StripeErrorType =
  | "invalid_request_error"
  | "card_error"
  | "idempotency_error"
  | "api_error"

export type StripeErrorInit = {
  status: number
  message: string
  code?: string
  param?: string
  type?: StripeErrorType
  decline_code?: string
  payment_intent?: unknown
  payment_method?: string
  charge?: string
  setup_intent?: unknown
}

/** Codes that Stripe documents; these carry a `doc_url`. */
const docUrl = (code: string) => `https://stripe.com/docs/error-codes/${code.replace(/_/g, "-")}`

/** Stripe serialises error bodies with keys in alphabetical order. */
export const stripeErrorBody = (init: StripeErrorInit, requestLogUrl: string) => {
  const error: Record<string, unknown> = {}
  if (init.charge !== undefined) error.charge = init.charge
  if (init.code !== undefined) {
    error.code = init.code
    error.doc_url = docUrl(init.code)
  }
  if (init.decline_code !== undefined) error.decline_code = init.decline_code
  error.message = init.message
  if (init.param !== undefined) error.param = init.param
  if (init.payment_intent !== undefined) error.payment_intent = init.payment_intent
  if (init.payment_method !== undefined) error.payment_method = init.payment_method
  error.request_log_url = requestLogUrl
  if (init.setup_intent !== undefined) error.setup_intent = init.setup_intent
  error.type = init.type ?? "invalid_request_error"
  return { error }
}

export class StripeError extends HttpError {
  constructor(readonly init: StripeErrorInit) {
    super(init.status, undefined)
    this.name = "StripeError"
  }
}

export const invalidRequest = (message: string, param?: string, code?: string) =>
  new StripeError({
    status: 400,
    message,
    ...(param === undefined ? {} : { param }),
    ...(code === undefined ? {} : { code }),
  })

export const resourceMissing = (kind: string, id: string, param: string, status = 404) =>
  new StripeError({ status, code: "resource_missing", message: `No such ${kind}: '${id}'`, param })

export const parameterUnknown = (param: string) =>
  new StripeError({
    status: 400,
    code: "parameter_unknown",
    message: `Received unknown parameter: ${param}`,
    param,
  })

export const parameterMissing = (param: string) =>
  new StripeError({
    status: 400,
    code: "parameter_missing",
    message: `Missing required param: ${param}.`,
    param,
  })

export const cardError = (init: Omit<StripeErrorInit, "type" | "status"> & { status?: number }) =>
  new StripeError({ status: init.status ?? 402, type: "card_error", ...init })

export const parameterInvalidInteger = (param: string, raw: string) =>
  new StripeError({
    status: 400,
    code: "parameter_invalid_integer",
    message: `Invalid integer: ${raw}`,
    param,
  })

export const parameterInvalidEmpty = (param: string) =>
  new StripeError({
    status: 400,
    code: "parameter_invalid_empty",
    message: `You passed an empty string for '${param}'. We assume empty values are an attempt to unset a parameter; however '${param}' cannot be unset. You should remove '${param}' from your request or supply a non-empty value.`,
    param,
  })

/** Stripe lists alternatives as "a, b, or c" (or "a or b"). */
export const humanList = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : items.length === 2
      ? `${items[0]} or ${items[1]}`
      : `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`
