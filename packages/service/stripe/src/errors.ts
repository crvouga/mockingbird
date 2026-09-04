import { HttpError } from "@crvouga/mockingbird-service"

export type StripeErrorInit = {
  status: number
  message: string
  code?: string
  param?: string
}

/** Codes that Stripe documents; these carry a `doc_url`. */
const docUrl = (code: string) => `https://stripe.com/docs/error-codes/${code.replace(/_/g, "-")}`

/** Stripe serialises error bodies with keys in alphabetical order. */
export const stripeErrorBody = (init: StripeErrorInit, requestLogUrl: string) => {
  const error: Record<string, string> = {}
  if (init.code !== undefined) {
    error.code = init.code
    error.doc_url = docUrl(init.code)
  }
  error.message = init.message
  if (init.param !== undefined) error.param = init.param
  error.request_log_url = requestLogUrl
  error.type = "invalid_request_error"
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
