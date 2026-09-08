import { encodeBody, encodeFormPairs } from "@crvouga/mockingbird-http-codec"
import {
  defaultMissingId,
  type Placeholder,
  pickRef,
  type ResourceTable,
  resolvePlaceholders,
  type Side,
} from "@crvouga/mockingbird-model"
import { expandPathTemplate, type HttpMethod } from "@crvouga/mockingbird-openapi"
import type { LogicalCommand } from "./command.js"
import type { OperationPlan } from "./plan.js"

/** Run-scoped values substituted for `x-mockingbird-scope` placeholders. */
export type Scope = {
  runId: string
  /** Seconds since epoch at the start of the current walk. */
  walkStartUnix: number
}

/** A fully resolved HTTP request, independent of any base URL or credentials. */
export type ConcreteRequest = {
  method: HttpMethod
  /** Path with parameters substituted, e.g. `/v1/customers/cus_123`. */
  path: string
  query: Array<[string, string]>
  headers: Record<string, string>
  body: { contentType: string; body: string } | undefined
}

export class UnresolvedReferenceError extends Error {
  constructor(
    readonly type: string,
    readonly side: Side,
  ) {
    super(`no ${type} resource is bound on the ${side} side`)
    this.name = "UnresolvedReferenceError"
  }
}

const scopeValue = (value: string, scope: Scope): unknown => {
  switch (value) {
    case "run-id":
      return scope.runId
    case "walk-start-unix":
      return scope.walkStartUnix
    case "walk-start-iso":
      return new Date(scope.walkStartUnix * 1000).toISOString()
    default:
      throw new RangeError(`unknown scope value ${value}`)
  }
}

/** Resolve every placeholder of a value for one side. */
export const resolveForSide = (
  value: unknown,
  table: ResourceTable,
  side: Side,
  scope: Scope,
  deletedRefProbability = 0,
): unknown =>
  resolvePlaceholders(value, (placeholder: Placeholder) => {
    switch (placeholder.$mockingbird) {
      case "ref": {
        const ref = pickRef(table, placeholder.type, placeholder.pick, deletedRefProbability)
        const id = ref === undefined ? undefined : table.idOf(ref, side)
        if (id === undefined) throw new UnresolvedReferenceError(placeholder.type, side)
        return id
      }
      case "missing":
        return placeholder.missing ?? defaultMissingId(placeholder.type)
      case "scope":
        return scopeValue(placeholder.value, scope)
    }
  })

const asString = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/** Build the HTTP request a command denotes on one side. */
export const concretize = (
  command: LogicalCommand,
  plan: OperationPlan,
  table: ResourceTable,
  side: Side,
  scope: Scope,
  deletedRefProbability = 0,
): ConcreteRequest => {
  const parameters = resolveForSide(
    command.parameters,
    table,
    side,
    scope,
    deletedRefProbability,
  ) as Record<string, unknown>
  const pathValues: Record<string, string> = {}
  const query: Array<[string, string]> = []
  const headers: Record<string, string> = {}
  for (const parameter of plan.operation.parameters) {
    const value = parameters[parameter.name]
    if (value === undefined) continue
    switch (parameter.in) {
      case "path":
        pathValues[parameter.name] = asString(value)
        break
      case "query":
        if (typeof value === "object" && value !== null) {
          query.push(...encodeFormPairs({ [parameter.name]: value }))
        } else query.push([parameter.name, asString(value)])
        break
      case "header":
        headers[parameter.name.toLowerCase()] = asString(value)
        break
      case "cookie":
        break
    }
  }
  const body =
    command.body === undefined || command.mediaType === undefined
      ? undefined
      : encodeBody(
          command.mediaType,
          resolveForSide(command.body, table, side, scope, deletedRefProbability),
        )
  return {
    method: plan.operation.method,
    path: expandPathTemplate(plan.operation.path, pathValues),
    query,
    headers,
    body,
  }
}

/** Turn a concrete request into a Fetch `Request` against `baseUrl`, adding `extraHeaders`. */
export const toRequest = (
  request: ConcreteRequest,
  baseUrl: string,
  extraHeaders: Record<string, string> = {},
): Request => {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${request.path}`
  url.search = ""
  for (const [key, value] of request.query) url.searchParams.append(key, value)
  const headers = new Headers({ ...request.headers, ...extraHeaders })
  const init: RequestInit = { method: request.method.toUpperCase(), headers }
  if (request.body) {
    headers.set("content-type", request.body.contentType)
    init.body = request.body.body
  }
  return new Request(url, init)
}
