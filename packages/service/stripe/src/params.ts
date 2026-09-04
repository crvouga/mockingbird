import type { FormValue } from "@crvouga/mockingbird-http-codec"
import type { SchemaObject } from "@crvouga/mockingbird-openapi"
import { type FormIssue, type OperationContext, parseForm } from "@crvouga/mockingbird-service"
import {
  humanList,
  invalidRequest,
  parameterInvalidEmpty,
  parameterInvalidInteger,
  parameterMissing,
  parameterUnknown,
  StripeError,
} from "./errors.js"
import { document } from "./generated/openapi.js"

/** Stripe words enum alternatives in its own order, not the spec's alphabetical one. */
const ENUM_ORDER: Record<string, string[]> = {
  tax_exempt: ["none", "reverse", "exempt"],
  interval: ["month", "year", "week", "day"],
  usage_type: ["metered", "licensed"],
  tax_behavior: ["inclusive", "exclusive", "unspecified"],
  type: ["one_time", "recurring"],
}

/** Fields whose length error uses the terse "Invalid string length" wording. */
const TERSE_LENGTH_FIELDS = new Set(["phone", "unit_label"])

const leafName = (path: string) => {
  const match = /\[([^\]]+)\]$/.exec(path)
  return match?.[1] ?? path
}

const truncate = (value: string) => {
  const chars = [...value]
  return chars.length <= 8 ? value : `${chars.slice(0, 4).join("")}...${chars.slice(-4).join("")}`
}

const orderedAlternatives = (path: string, allowed: string[]) => {
  const preferred = ENUM_ORDER[leafName(path)]
  if (!preferred) return allowed
  const known = preferred.filter((item) => allowed.includes(item))
  return [...known, ...allowed.filter((item) => !known.includes(item))]
}

export const issueToError = (issue: FormIssue): StripeError => {
  switch (issue.kind) {
    case "unknown":
      return parameterUnknown(issue.path)
    case "missing":
      return parameterMissing(issue.path)
    case "empty":
      return parameterInvalidEmpty(issue.path)
    case "invalid-integer":
      return parameterInvalidInteger(issue.path, issue.raw)
    case "invalid-number":
      return invalidRequest(`Invalid decimal: ${issue.raw}`, issue.path)
    case "invalid-boolean":
      return invalidRequest(`Invalid boolean: ${issue.raw}`, issue.path)
    case "invalid-object":
      return invalidRequest("Invalid object", issue.path)
    case "invalid-array":
      return invalidRequest("Invalid array", issue.path)
    case "invalid-enum": {
      const leaf = leafName(issue.path)
      if (leaf === "currency")
        return invalidRequest(
          `Invalid currency: ${issue.raw}. Stripe currently supports these currencies: ${SUPPORTED_CURRENCIES.join(", ")}`,
          issue.path,
        )
      if (/^preferred_locales\[\d+\]$/.test(issue.path))
        return invalidRequest(
          "Not a valid language, try using an IETF language tag, such as 'en-US'. For more information, check https://tools.ietf.org/html/rfc5646",
          issue.path,
        )
      return invalidRequest(
        `Invalid ${issue.path}: must be one of ${humanList(orderedAlternatives(issue.path, issue.allowed))}`,
        issue.path,
      )
    }
    case "too-long": {
      const leaf = leafName(issue.path)
      if (leaf === "statement_descriptor")
        return invalidRequest(
          `The statement descriptor must be at most ${issue.limit} characters. ${issue.raw} is ${[...issue.raw].length} characters long.`,
          issue.path,
        )
      if (/^images\[\d+\]$/.test(issue.path))
        return invalidRequest(
          `Invalid URL: URL must be ${issue.limit} characters or less.`,
          issue.path,
        )
      if (TERSE_LENGTH_FIELDS.has(leaf))
        return invalidRequest(
          `Invalid string length: ${issue.raw} must be at most ${issue.limit} characters`,
          issue.path,
        )
      return invalidRequest(
        `Invalid string: ${truncate(issue.raw)}; must be at most ${issue.limit} characters`,
        issue.path,
      )
    }
    case "too-many-items":
      return invalidRequest(
        `Array ${issue.path} exceeded maximum ${issue.limit} allowed elements.`,
        issue.path,
      )
    case "below-minimum":
      return new StripeError({
        status: 400,
        code: "parameter_invalid_integer",
        message: `This value must be greater than or equal to ${issue.limit}.`,
        param: issue.path,
      })
    case "above-maximum":
      return new StripeError({
        status: 400,
        code: "parameter_invalid_integer",
        message: `This value must be less than or equal to ${issue.limit}.`,
        param: issue.path,
      })
  }
}

/** The list Stripe prints when a currency is unknown, in its (non-alphabetical) order. */
export const SUPPORTED_CURRENCIES =
  "usd, aed, afn, all, amd, ang, aoa, ars, aud, awg, azn, bam, bbd, bdt, bgn, bhd, bif, bmd, bnd, bob, brl, bsd, bwp, byn, bzd, cad, cdf, chf, clp, cny, cop, crc, cve, czk, djf, dkk, dop, dzd, egp, etb, eur, fjd, fkp, gbp, gel, gip, gmd, gnf, gtq, gyd, hkd, hnl, hrk, htg, huf, idr, ils, inr, isk, jmd, jod, jpy, kes, kgs, khr, kmf, krw, kwd, kyd, kzt, lak, lbp, lkr, lrd, lsl, mad, mdl, mga, mkd, mmk, mnt, mop, mur, mvr, mwk, mxn, myr, mzn, nad, ngn, nio, nok, npr, nzd, omr, pab, pen, pgk, php, pkr, pln, pyg, qar, ron, rsd, rub, rwf, sar, sbd, scr, sek, sgd, shp, sle, sos, srd, std, szl, thb, tjs, tnd, top, try, ttd, twd, tzs, uah, ugx, uyu, uzs, vnd, vuv, wst, xaf, xcd, xcg, xof, xpf, yer, zar, zmw, usdc, btn, ghs, eek, lvl, svc, vef, ltl, sll, mro".split(
    ", ",
  )

export type Params = Record<string, unknown>

/**
 * Per-operation validation order. Stripe validates parameters one at a time in its own
 * declaration order (unknown parameters always first), so when several are wrong the reported
 * one depends on this order. Keys not listed fall back to schema (alphabetical) order.
 */
export type ParamOptions = {
  order?: readonly string[]
  /** Semantic checks that run in the same per-parameter slot as schema issues for that key. */
  validate?: Record<string, (params: Params) => void>
  /** Checks Stripe defers until every parameter has been accepted. */
  after?: (params: Params) => void
}

const topLevelKey = (path: string) => {
  const bracket = path.indexOf("[")
  return bracket === -1 ? path : path.slice(0, bracket)
}

/** Parse a raw form object against a schema, throwing Stripe's first complaint. */
export const parseParams = (
  schema: SchemaObject,
  raw: FormValue | undefined,
  options: ParamOptions = {},
): Params => {
  const parsed = parseForm(document, schema, raw ?? {})
  const unknown = parsed.issues.find((issue) => issue.kind === "unknown")
  if (unknown) throw issueToError(unknown)
  const params = (parsed.value ?? {}) as Params
  const declared = Object.keys(schema.properties ?? {})
  const order = [
    ...(options.order ?? []),
    ...declared.filter((key) => !(options.order ?? []).includes(key)),
  ]
  for (const key of order) {
    const issue = parsed.issues.find((item) => topLevelKey(item.path) === key)
    if (issue) throw issueToError(issue)
    options.validate?.[key]?.(params)
  }
  const stray = parsed.issues[0]
  if (stray) throw issueToError(stray)
  options.after?.(params)
  return params
}

const formBodySchema = (context: OperationContext): SchemaObject => {
  const body = context.operation.requestBody
  const media = body?.content["application/x-www-form-urlencoded"]
  return media?.schema ?? { type: "object", properties: {} }
}

const querySchema = (context: OperationContext): SchemaObject => {
  const properties: Record<string, SchemaObject> = {}
  for (const parameter of context.operation.parameters) {
    if (parameter.in === "query" && parameter.schema) properties[parameter.name] = parameter.schema
  }
  return { type: "object", properties }
}

/** Body parameters for POST operations. Stripe treats a missing/empty body as no parameters. */
export const bodyParams = (context: OperationContext, options: ParamOptions = {}): Params => {
  const body = context.body
  const raw = body.kind === "form" ? (body.value as FormValue) : {}
  return parseParams(formBodySchema(context), raw, options)
}

export const queryParams = (context: OperationContext, options: ParamOptions = {}): Params =>
  parseParams(querySchema(context), context.query, options)

/** Stripe reads `""` as "unset" for optional scalars. */
export const unsetToNull = <T>(value: T | "" | undefined): T | null | undefined =>
  value === "" ? null : value

export const isSet = (value: unknown): value is string | number | boolean | object =>
  value !== undefined && value !== ""
