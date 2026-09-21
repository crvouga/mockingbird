import { HttpError } from "@crvouga/mockingbird-service"

export type StripeErrorType =
  | "invalid_request_error"
  | "card_error"
  | "api_error"
  | "authentication_error"
  | "idempotency_error"
  | "permission_error"

export type StripeErrorInit = {
  status: number
  message: string
  code?: string
  param?: string
  type?: StripeErrorType
  decline_code?: string
  /** Extra fields Stripe puts on some errors (`charge`, `payment_intent`, `advice_code`, …). */
  extra?: Record<string, unknown>
  /** Leave `doc_url` out even though a code is set (Stripe omits it on a few errors). */
  noDocUrl?: boolean
}

/** Codes that Stripe documents; these carry a `doc_url`. */
const docUrl = (code: string) => `https://stripe.com/docs/error-codes/${code.replace(/_/g, "-")}`

/** Stripe serialises error bodies with keys in alphabetical order. */
export const stripeErrorBody = (init: StripeErrorInit, requestLogUrl: string) => {
  const fields: Record<string, unknown> = { ...init.extra }
  if (init.code !== undefined) {
    fields.code = init.code
    if (init.noDocUrl !== true) fields.doc_url = docUrl(init.code)
  }
  if (init.decline_code !== undefined) fields.decline_code = init.decline_code
  fields.message = init.message
  if (init.param !== undefined) fields.param = init.param
  fields.request_log_url = requestLogUrl
  fields.type = init.type ?? "invalid_request_error"
  const error: Record<string, unknown> = {}
  for (const key of Object.keys(fields).sort()) error[key] = fields[key]
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

/** Declines answer 402 with `type: "card_error"`, exactly like a real declined charge. */
export const cardError = (
  message: string,
  code: string,
  declineCode: string,
  extra: Record<string, unknown> = {},
) =>
  new StripeError({
    status: 402,
    message,
    code,
    decline_code: declineCode,
    type: "card_error",
    extra,
  })

/** A plain message-only 400, as Stripe answers most state errors. */
export const stateError = (message: string, code?: string, param?: string) =>
  new StripeError({
    status: 400,
    message,
    ...(code === undefined ? {} : { code }),
    ...(param === undefined ? {} : { param }),
  })

/** Stripe adds a hint when the id carries surrounding whitespace or quotes. */
const idHint = (id: string) =>
  /^[\s'"]|[\s'"]$/.test(id)
    ? ". Make sure you use the exact id without extra whitespace or quotes"
    : ""

/** How Stripe quotes an id inside an error message (Ruby-style escapes, HTML-safe JSON). */
export const quoteId = (id: string) =>
  id.replace(/[\\'"<>&]/g, (char) =>
    char === "<" ? "\\u003C" : char === ">" ? "\\u003E" : char === "&" ? "\\u0026" : `\\${char}`,
  )

/** Stripe elides the middle of an id longer than 998 characters. */
const truncateId = (id: string) =>
  id.length > 998 ? `${id.slice(0, 490)}...(truncated)...${id.slice(-490)}` : id

export const resourceMissing = (kind: string, id: string, param: string, status = 404) =>
  new StripeError({
    status,
    code: "resource_missing",
    message: `No such ${kind}: '${quoteId(truncateId(id))}'${idHint(id)}`,
    param,
  })

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
