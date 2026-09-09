import {
  type CanonicalizeOptions,
  canonicalizeExchange,
  discoverIdentities,
  type Exchange,
  structuralDiff,
} from "@crvouga/mockingbird-canonicalize"
import {
  type ConcreteRequest,
  concretize,
  type LogicalCommand,
  type OperationPlan,
  type Scope,
  toRequest,
} from "@crvouga/mockingbird-commands"
import { mediaTypeOf, readBody } from "@crvouga/mockingbird-http-codec"
import type { ResourceTable, Side } from "@crvouga/mockingbird-model"
import type { OpenAPIDocument, ResponseObject, SchemaObject } from "@crvouga/mockingbird-openapi"
import { responseForStatus, validateValue } from "@crvouga/mockingbird-openapi"
import { parityHeaders } from "@crvouga/mockingbird-openapi-metadata"
import { type FailureDetails, ParityError, type Redactor } from "./report.js"

export type FetchLike = (request: Request) => Promise<Response>

/** One side of the comparison: where to send requests and how. */
export type Target = {
  baseUrl: string
  fetch: FetchLike
  /** Extra headers (typically authentication) added to every request. */
  headers: () => Promise<Record<string, string>> | Record<string, string>
}

export type ExecutionContext = {
  provider: string
  document: OpenAPIDocument
  plans: ReadonlyMap<string, OperationPlan>
  table: ResourceTable
  scope: Scope
  real: Target
  mock: Target
  redact: Redactor
  history: string[]
  coverage?: Record<string, number>
  deletedRefProbability: number
  deletionTypes: Record<string, readonly string[]>
  /** Also validate the mock response body against the OpenAPI response schema. */
  validateMock: boolean
  /** Milliseconds of mock-side latency tolerated before a latency failure. */
  latencyToleranceMs: number
  step?: ((line: string) => void) | undefined
  trace?: ((line: string) => void) | undefined
}

export type StepOutcome = {
  operationId: string
  status: number
  discovered: number
  realMs: number
  mockMs: number
}

const toExchange = async (response: Response): Promise<Exchange> => {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })
  return { status: response.status, headers, body: await readBody(response) }
}

const responseSchema = (
  response: ResponseObject | undefined,
  contentType: string | undefined,
): SchemaObject | undefined => {
  if (!response?.content) return undefined
  const mediaType = mediaTypeOf(contentType)
  const exact = mediaType ? response.content[mediaType] : undefined
  const fallback = Object.values(response.content)[0]
  return (exact ?? fallback)?.schema
}

const send = async (
  target: Target,
  request: ConcreteRequest,
  failure: (cause: unknown) => FailureDetails,
  redact: Redactor,
): Promise<Exchange> => {
  try {
    const response = await target.fetch(toRequest(request, target.baseUrl, await target.headers()))
    return await toExchange(response)
  } catch (cause) {
    throw new ParityError(failure(cause), redact)
  }
}

/**
 * Run one logical command on both sides and compare. Throws {@link ParityError} on the first
 * difference; on success the resource table has been extended with any newly discovered ids.
 */
export const executeCommand = async (
  context: ExecutionContext,
  command: LogicalCommand,
): Promise<StepOutcome> => {
  const plan = context.plans.get(command.operationId)
  if (!plan) throw new RangeError(`no plan for operation ${command.operationId}`)
  const base = {
    provider: context.provider,
    operationId: command.operationId,
    method: plan.operation.method,
    path: plan.operation.path,
    command,
    history: [...context.history],
  }
  const realRequest = concretize(
    command,
    plan,
    context.table,
    "real",
    context.scope,
    context.deletedRefProbability,
  )
  const mockRequest = concretize(
    command,
    plan,
    context.table,
    "mock",
    context.scope,
    context.deletedRefProbability,
  )
  context.step?.(`${context.provider} ${command.operationId}`)

  const realStartedAt = performance.now()
  const realResponse = await send(
    context.real,
    realRequest,
    (cause) => ({ ...base, kind: "real-transport", request: realRequest, cause }),
    context.redact,
  )
  const realMs = performance.now() - realStartedAt
  const mockStartedAt = performance.now()
  const mockResponse = await send(
    context.mock,
    mockRequest,
    (cause) => ({ ...base, kind: "mock-transport", request: mockRequest, cause }),
    context.redact,
  )
  const mockMs = performance.now() - mockStartedAt
  const declared = responseForStatus(plan.operation.responses, realResponse.status)
  const schema = responseSchema(declared, realResponse.headers["content-type"])
  const headers = declared ? parityHeaders(context.document, declared) : []

  if (context.validateMock) {
    const problems: string[] = []
    const mockDeclared = responseForStatus(plan.operation.responses, mockResponse.status)
    if (!mockDeclared)
      problems.push(`status ${mockResponse.status} is not declared for ${command.operationId}`)
    const mockSchema = responseSchema(mockDeclared, mockResponse.headers["content-type"])
    if (mockSchema && (mockResponse.body.kind === "json" || mockResponse.body.kind === "form")) {
      for (const error of validateValue(context.document, mockSchema, mockResponse.body.value)) {
        problems.push(
          `$${error.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("")}: ${error.message}`,
        )
      }
    } else if (
      mockSchema &&
      mockResponse.body.kind !== "json" &&
      mockResponse.body.kind !== "form" &&
      mediaTypeOf(mockResponse.headers["content-type"]) !== "text/plain"
    ) {
      problems.push(`expected a structured body, got ${mockResponse.body.kind}`)
    }
    if (problems.length > 0) {
      throw new ParityError(
        {
          ...base,
          kind: "mock-conformance",
          request: mockRequest,
          response: mockResponse,
          problems,
        },
        context.redact,
      )
    }
  }

  let discovered = 0
  if (realResponse.body.kind === "json" && mockResponse.body.kind === "json") {
    discovered = discoverIdentities(
      context.document,
      schema,
      realResponse.body.value,
      mockResponse.body.value,
      context.table,
    ).length
  }

  const options = (side: Side): CanonicalizeOptions => ({
    document: context.document,
    schema,
    parityHeaders: headers,
    side,
    table: context.table,
  })
  const canonicalReal = canonicalizeExchange(realResponse, options("real"))
  const canonicalMock = canonicalizeExchange(mockResponse, options("mock"))
  const differences = structuralDiff(canonicalReal, canonicalMock)
  if (differences.length > 0) {
    throw new ParityError(
      {
        ...base,
        kind: "mismatch",
        real: { request: realRequest, response: realResponse, canonical: canonicalReal },
        mock: { request: mockRequest, response: mockResponse, canonical: canonicalMock },
        differences,
      },
      context.redact,
    )
  }
  if (mockMs >= realMs + context.latencyToleranceMs) {
    throw new ParityError({ ...base, kind: "latency", realMs, mockMs }, context.redact)
  }
  context.trace?.(
    `${context.provider} ${realRequest.method.toUpperCase()} ${context.redact(realRequest.path)} -> ${realResponse.status} (+${discovered})`,
  )
  return {
    operationId: command.operationId,
    status: realResponse.status,
    discovered,
    realMs,
    mockMs,
  }
}
