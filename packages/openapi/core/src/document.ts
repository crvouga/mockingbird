import { deref, isReference, resolveRef } from "./refs.js"
import {
  HTTP_METHODS,
  type HttpMethod,
  type OpenAPIDocument,
  type Operation,
  type ParameterObject,
  type PathItemObject,
  type RequestBodyObject,
  type ResponseObject,
} from "./types.js"

export class OpenAPIDocumentError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid OpenAPI document:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`)
    this.name = "OpenAPIDocumentError"
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Accept an already-parsed JSON/YAML value and return it typed as an {@link OpenAPIDocument}.
 * Performs the structural checks Mockingbird relies on (see {@link validateOpenAPIDocument}) and
 * throws {@link OpenAPIDocumentError} listing every problem.
 */
export const parseOpenAPIDocument = (value: unknown): OpenAPIDocument => {
  const issues: string[] = []
  if (!isRecord(value)) throw new OpenAPIDocumentError(["document must be an object"])
  if (typeof value.openapi !== "string" || !/^3\.[01]\./.test(value.openapi)) {
    issues.push(
      `openapi must be a 3.0.x or 3.1.x version string, got ${JSON.stringify(value.openapi)}`,
    )
  }
  if (
    !isRecord(value.info) ||
    typeof value.info.title !== "string" ||
    typeof value.info.version !== "string"
  ) {
    issues.push("info.title and info.version are required strings")
  }
  if (!isRecord(value.paths)) issues.push("paths must be an object")
  if (issues.length > 0) throw new OpenAPIDocumentError(issues)
  const document = value as unknown as OpenAPIDocument
  const problems = validateOpenAPIDocument(document)
  if (problems.length > 0) throw new OpenAPIDocumentError(problems)
  return document
}

const walkRefs = (
  document: OpenAPIDocument,
  node: unknown,
  at: string,
  issues: string[],
  seen: Set<unknown>,
) => {
  if (typeof node !== "object" || node === null || seen.has(node)) return
  seen.add(node)
  if (isReference(node)) {
    try {
      resolveRef(document, node.$ref)
    } catch {
      issues.push(`${at}: unresolvable $ref ${node.$ref}`)
    }
  }
  for (const [key, child] of Object.entries(node))
    walkRefs(document, child, `${at}/${key}`, issues, seen)
}

const templateParams = (path: string) =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string)

/**
 * Mockingbird's document rules:
 * - every operation has a unique `operationId`
 * - every `$ref` resolves
 * - every `{param}` in a path template has a matching required path parameter
 * - every path parameter appears in the template
 */
export const validateOpenAPIDocument = (document: OpenAPIDocument): string[] => {
  const issues: string[] = []
  walkRefs(document, document, "#", issues, new Set())
  if (issues.length > 0) return issues
  const seenIds = new Map<string, string>()
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isRecord(item)) {
      issues.push(`paths.${path}: must be an object`)
      continue
    }
    const inTemplate = new Set(templateParams(path))
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (operation === undefined) continue
      const label = `${method.toUpperCase()} ${path}`
      if (typeof operation.operationId !== "string" || operation.operationId.length === 0) {
        issues.push(`${label}: operationId is required`)
        continue
      }
      const previous = seenIds.get(operation.operationId)
      if (previous !== undefined)
        issues.push(`${label}: duplicate operationId ${operation.operationId} (also ${previous})`)
      seenIds.set(operation.operationId, label)
      if (!isRecord(operation.responses) || Object.keys(operation.responses).length === 0) {
        issues.push(`${label}: responses must declare at least one status`)
      }
      const parameters = mergeParameters(document, item, operation.parameters)
      const declared = new Set(parameters.filter((p) => p.in === "path").map((p) => p.name))
      for (const name of inTemplate) {
        if (!declared.has(name)) issues.push(`${label}: path parameter {${name}} is not declared`)
      }
      for (const parameter of parameters) {
        if (parameter.in === "path") {
          if (!inTemplate.has(parameter.name))
            issues.push(`${label}: path parameter ${parameter.name} is not in the template`)
          if (parameter.required !== true)
            issues.push(`${label}: path parameter ${parameter.name} must be required`)
        }
      }
    }
  }
  return issues
}

const mergeParameters = (
  document: OpenAPIDocument,
  item: PathItemObject,
  own: PathItemObject["parameters"],
): ParameterObject[] => {
  const merged = new Map<string, ParameterObject>()
  for (const raw of item.parameters ?? []) {
    const parameter = deref<ParameterObject>(document, raw)
    merged.set(`${parameter.in}:${parameter.name}`, parameter)
  }
  for (const raw of own ?? []) {
    const parameter = deref<ParameterObject>(document, raw)
    merged.set(`${parameter.in}:${parameter.name}`, parameter)
  }
  return [...merged.values()]
}

/** Enumerate every operation in the document in path, then method order. */
export const listOperations = (document: OpenAPIDocument): Operation[] => {
  const operations: Operation[] = []
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (operation?.operationId === undefined) continue
      const responses: Record<string, ResponseObject> = {}
      for (const [status, response] of Object.entries(operation.responses)) {
        responses[status] = deref<ResponseObject>(document, response)
      }
      operations.push({
        operationId: operation.operationId,
        method,
        path,
        operation,
        parameters: mergeParameters(document, item, operation.parameters),
        requestBody:
          operation.requestBody === undefined
            ? undefined
            : deref<RequestBodyObject>(document, operation.requestBody),
        responses,
      })
    }
  }
  return operations
}

/** Find one operation by id. */
export const findOperation = (
  document: OpenAPIDocument,
  operationId: string,
): Operation | undefined =>
  listOperations(document).find((operation) => operation.operationId === operationId)

/** Parameter names inside a path template, in order. */
export const pathTemplateParameters = templateParams

/** Substitute `{name}` placeholders. Values are percent-encoded as path segments. */
export const expandPathTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined) throw new RangeError(`missing path parameter ${name}`)
    return encodeURIComponent(value)
  })

/** The response object matching an HTTP status: exact match, then `2XX`-style range, then `default`. */
export const responseForStatus = (
  responses: Record<string, ResponseObject>,
  status: number,
): ResponseObject | undefined =>
  responses[String(status)] ?? responses[`${Math.floor(status / 100)}XX`] ?? responses.default

export type { HttpMethod }
