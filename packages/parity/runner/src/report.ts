import type { CanonicalExchange, Difference, Exchange } from "@crvouga/mockingbird-canonicalize"
import { formatDifference } from "@crvouga/mockingbird-canonicalize"
import type { ConcreteRequest, LogicalCommand } from "@crvouga/mockingbird-commands"
import { describeCommand } from "@crvouga/mockingbird-commands"

export type Redactor = (text: string) => string

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "x-vital-api-key",
])

/** Drop credential-bearing headers and run the redactor over everything else. */
export const redactHeaders = (
  headers: Record<string, string>,
  redact: Redactor,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? "<redacted>" : redact(value)
  }
  return out
}

export const redactValue = (value: unknown, redact: Redactor): unknown => {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact))
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, redact)
    return out
  }
  return value
}

export type CommandContext = {
  provider: string
  operationId: string
  method: string
  path: string
  command: LogicalCommand
  history: readonly string[]
}

export type MismatchDetails = CommandContext & {
  kind: "mismatch"
  real: { request: ConcreteRequest; response: Exchange; canonical: CanonicalExchange }
  mock: { request: ConcreteRequest; response: Exchange; canonical: CanonicalExchange }
  differences: Difference[]
}

export type TransportDetails = CommandContext & {
  kind: "real-transport" | "mock-transport"
  request: ConcreteRequest
  cause: unknown
}

export type ConformanceDetails = CommandContext & {
  kind: "mock-conformance"
  request: ConcreteRequest
  response: Exchange
  problems: string[]
}

export type FailureDetails = MismatchDetails | TransportDetails | ConformanceDetails

const block = (title: string, value: unknown) =>
  `${title}:\n${indent(JSON.stringify(value, null, 2) ?? "undefined")}`
const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")

const describeRequest = (request: ConcreteRequest, redact: Redactor) => ({
  method: request.method.toUpperCase(),
  path: redact(request.path),
  query: request.query.map(([k, v]) => [k, redact(v)]),
  headers: redactHeaders(request.headers, redact),
  body: request.body
    ? { contentType: request.body.contentType, body: redact(request.body.body) }
    : undefined,
})

const describeResponse = (response: Exchange, redact: Redactor) => ({
  status: response.status,
  headers: redactHeaders(response.headers, redact),
  body: redactValue(response.body, redact),
})

export const formatFailure = (details: FailureDetails, redact: Redactor): string => {
  const lines: string[] = [
    `[${details.provider}] ${details.kind} in ${details.operationId} (${details.method.toUpperCase()} ${details.path})`,
    `command: ${redact(describeCommand(details.command))}`,
    `history (${details.history.length}):`,
    ...details.history.map((entry, i) => `  ${i + 1}. ${redact(entry)}`),
  ]
  switch (details.kind) {
    case "mismatch":
      lines.push(
        "differences:",
        ...details.differences.map((d) => `  ${redact(formatDifference(d))}`),
        block("real request", describeRequest(details.real.request, redact)),
        block("mock request", describeRequest(details.mock.request, redact)),
        block("real response", describeResponse(details.real.response, redact)),
        block("mock response", describeResponse(details.mock.response, redact)),
        block("canonical real", redactValue(details.real.canonical, redact)),
        block("canonical mock", redactValue(details.mock.canonical, redact)),
      )
      break
    case "real-transport":
    case "mock-transport":
      lines.push(
        block("request", describeRequest(details.request, redact)),
        `cause: ${redact(details.cause instanceof Error ? `${details.cause.name}: ${details.cause.message}` : String(details.cause))}`,
      )
      break
    case "mock-conformance":
      lines.push(
        "problems:",
        ...details.problems.map((p) => `  ${redact(p)}`),
        block("request", describeRequest(details.request, redact)),
        block("response", describeResponse(details.response, redact)),
      )
      break
  }
  return lines.join("\n")
}

/** Thrown by the runner the moment a command diverges. fast-check shrinks around it. */
export class ParityError extends Error {
  constructor(
    readonly details: FailureDetails,
    redact: Redactor,
  ) {
    super(formatFailure(details, redact))
    this.name = "ParityError"
  }
}
