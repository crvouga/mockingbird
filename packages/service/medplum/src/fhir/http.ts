/**
 * FHIR REST over HTTP, as packages/server/src/fhir/routes.ts, response.ts and binary.ts do it:
 * the request goes through the vendored `FhirRouter` (the same router the server uses) with
 * the server's extra operations, and the result is sent with the server's headers.
 */
import {
  allOk,
  badRequest,
  created,
  getStatus,
  isCreated,
  isOk,
  isResource,
  normalizeOperationOutcome,
  notFound,
  OperationOutcomeError,
  stringify,
  validateResource,
} from "@medplum/core"
import type { Binary, OperationOutcome, Resource } from "@medplum/fhirtypes"
import { FHIR_JSON, type ParsedBody, type RequestIds, respond, sendOutcome } from "../http.js"
import { type FhirRequest, FhirRouter, type HttpMethod } from "../vendor/fhir-router/index.js"
import { capabilityStatement } from "./metadata.js"
import { patientEverything } from "./operations.js"
import type { MockRepository } from "./repo.js"
import { presignedUrl, RewriteMode, rewriteAttachments } from "./rewrite.js"

export type BinaryStorage = {
  write(binary: Binary, bytes: Uint8Array): void
  read(binary: Binary): Uint8Array | undefined
}

export type FhirHttpContext = {
  repo: MockRepository
  ids: RequestIds
  binaries: BinaryStorage
  /** The full URL path after `/fhir/R4`, with its query string. */
  url: string
  request: Request
  body: ParsedBody
  bytes: Uint8Array
}

let router: FhirRouter | undefined

const fhirRouter = (): FhirRouter => {
  if (router) return router
  const r = new FhirRouter({ introspectionEnabled: true })
  r.add("POST", "/:resourceType/$validate", async (req) => {
    validateResource(req.body as Resource)
    return [allOk]
  })
  r.add("POST", "/:resourceType/:id/$expunge", async (req, repo) => {
    const { resourceType, id } = req.params as { resourceType: string; id: string }
    await (repo as MockRepository).expungeResource(resourceType, id)
    return [allOk]
  })
  r.add("GET", "/Patient/:id/$everything", patientEverything)
  r.add("POST", "/Patient/:id/$everything", patientEverything)
  router = r
  return r
}

const headersRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

const bodyValue = (body: ParsedBody): unknown => {
  switch (body.kind) {
    case "json":
    case "form":
      return body.value
    case "text":
      return body.value
    default:
      return undefined
  }
}

/** `sendResponseHeaders`: ETag, Last-Modified and (for creates) Location. */
const resourceHeaders = (
  repo: MockRepository,
  outcome: OperationOutcome,
  body: Resource,
): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (body.meta?.versionId) headers.etag = `W/"${body.meta.versionId}"`
  if (body.meta?.lastUpdated)
    headers["last-modified"] = new Date(body.meta.lastUpdated).toUTCString()
  if (isCreated(outcome) && body.id) headers.location = repo.fullUrl(body.resourceType, body.id)
  return headers
}

/** `res.json(data)` under the FHIR interceptor: `Prefer: return=minimal` sends no body. */
const sendResource = (
  context: FhirHttpContext,
  outcome: OperationOutcome,
  body: Resource,
  contentType = FHIR_JSON,
): Response => {
  const headers = resourceHeaders(context.repo, outcome, body)
  const status = getStatus(outcome)
  if (context.request.headers.get("prefer") === "return=minimal")
    return respond(status, "", contentType, headers)
  const pretty = new URL(context.request.url).searchParams.get("_pretty") === "true"
  return respond(status, stringify(body, pretty), contentType, headers)
}

const sendBinary = (
  context: FhirHttpContext,
  outcome: OperationOutcome,
  binary: Binary,
): Response => {
  const headers = resourceHeaders(context.repo, outcome, binary)
  let bytes: Uint8Array | undefined
  if (binary.data) {
    const decoded = atob(binary.data)
    bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0))
  } else {
    bytes = context.binaries.read(binary)
  }
  if (!bytes) return sendOutcome(notFound, context.ids)
  return respond(getStatus(outcome), bytes, binary.contentType, headers)
}

/** `sendFhirResponse`: raw content for a Binary read without a FHIR Accept header. */
const sendFhirResponse = async (
  context: FhirHttpContext,
  outcome: OperationOutcome,
  body: Resource,
  contentType?: string,
): Promise<Response> => {
  if (
    body.resourceType === "Binary" &&
    context.request.method === "GET" &&
    !context.request.headers.get("accept")?.startsWith("application/fhir+json")
  ) {
    return sendBinary(context, outcome, body as Binary)
  }
  return sendResource(
    context,
    outcome,
    await rewriteAttachments(RewriteMode.PRESIGNED_URL, context.repo, body),
    contentType ?? FHIR_JSON,
  )
}

/** `/fhir/R4/Binary` (binary.ts): raw uploads become Binary resources with stored content. */
const handleBinary = async (
  context: FhirHttpContext,
  id: string | undefined,
): Promise<Response> => {
  const { request, repo } = context
  if (request.method === "GET" && id) {
    const binary = await repo.readResource<Binary>("Binary", id)
    return sendFhirResponse(context, allOk, binary)
  }
  const create = request.method === "POST"
  const contentType = request.headers.get("content-type") ?? undefined
  if (request.headers.get("content-encoding")) {
    return sendOutcome(badRequest("Unsupported content encoding"), context.ids)
  }
  if (contentType === "application/fhir+json") {
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(context.bytes))
    } catch {
      parsed = undefined
    }
    if (isResource(parsed, "Binary") && (!id || parsed.id === id)) {
      const binary = await (create ? repo.createResource(parsed) : repo.updateResource(parsed))
      return sendResource(context, create ? created : allOk, binary)
    }
  }
  const securityContext = request.headers.get("x-security-context")
  const resource: Binary = {
    resourceType: "Binary",
    ...(id ? { id } : {}),
    contentType: contentType ?? "application/octet-stream",
    ...(securityContext ? { securityContext: { reference: securityContext } } : {}),
  }
  const binary = await (id ? repo.updateResource(resource) : repo.createResource(resource))
  repo.services.writeBinary(binary, context.bytes)
  binary.url = await presignedUrl(repo, binary)
  return sendFhirResponse(context, create ? created : allOk, binary)
}

/** Route one authenticated `/fhir/R4/...` request. */
export const handleFhir = async (context: FhirHttpContext): Promise<Response> => {
  const { request, repo } = context
  const path = context.url.split("?")[0] ?? ""
  const binaryMatch = /^\/Binary(?:\/([^/?]+))?\/?$/.exec(path)
  if (
    binaryMatch &&
    ["GET", "POST", "PUT"].includes(request.method) &&
    !(request.method === "GET" && !binaryMatch[1])
  ) {
    try {
      return await handleBinary(
        context,
        binaryMatch[1] ? decodeURIComponent(binaryMatch[1]) : undefined,
      )
    } catch (error) {
      return sendOutcome(normalizeOperationOutcome(error), context.ids)
    }
  }
  if (request.method === "GET" && (path === "/metadata" || path === "/metadata/")) {
    return respond(
      200,
      JSON.stringify(capabilityStatement(repo.services.baseUrl)),
      "application/json; charset=utf-8",
    )
  }
  if (request.method === "GET" && (path === "/$versions" || path === "/%24versions")) {
    return respond(
      200,
      JSON.stringify({ versions: ["4.0"], default: "4.0" }),
      "application/json; charset=utf-8",
    )
  }
  const fhirRequest: FhirRequest = {
    method: request.method as HttpMethod,
    url: context.url,
    pathname: "",
    params: {},
    query: Object.create(null),
    body: bodyValue(context.body) ?? {},
    headers: headersRecord(request.headers),
    config: {
      transactions: Boolean(repo.currentProject()?.features?.includes("transaction-bundles")),
    },
  }
  const result = await fhirRouter().handleRequest(fhirRequest, repo)
  if (result.length === 1) {
    if (!isOk(result[0])) return sendOutcome(result[0], context.ids)
    return sendOutcome(result[0], context.ids)
  }
  const [outcome, body, options] = result
  if (!body) return sendOutcome(outcome, context.ids)
  return sendFhirResponse(context, outcome, body, options?.contentType)
}

export const outcomeOf = (error: unknown): OperationOutcome =>
  error instanceof OperationOutcomeError ? error.outcome : normalizeOperationOutcome(error)
