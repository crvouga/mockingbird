import type { OpenAPIDocument, SchemaObject } from "@crvouga/mockingbird-openapi"
import {
  listOperations,
  resolveSchema,
  schemaTypes,
  walkSchema,
} from "@crvouga/mockingbird-openapi"
import { operationMetadata, parameterMetadata, schemaMetadata } from "./read.js"
import { EXTENSION_KEYS } from "./types.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Semantic checks for Mockingbird extensions:
 * - malformed extension objects
 * - identities and references must be strings
 * - `supported: false` / `parity.enabled: false` need a reason
 * - every referenced resource type is produced by some identity in the document
 */
export const validateMetadata = (document: OpenAPIDocument): string[] => {
  const issues: string[] = []
  const producedTypes = new Set<string>()
  const referencedTypes = new Map<string, string>()

  const inspectSchema = (schema: SchemaObject, at: string) => {
    const raw = schema as Record<string, unknown>
    for (const key of [
      EXTENSION_KEYS.resource,
      EXTENSION_KEYS.resourceRef,
      EXTENSION_KEYS.volatile,
      EXTENSION_KEYS.scope,
    ]) {
      if (key in raw && !isRecord(raw[key])) issues.push(`${at}: ${key} must be an object`)
    }
    const meta = schemaMetadata(schema)
    if (isRecord(raw[EXTENSION_KEYS.resource]) && !meta.resource)
      issues.push(`${at}: ${EXTENSION_KEYS.resource} needs { type, identity: true }`)
    if (isRecord(raw[EXTENSION_KEYS.resourceRef]) && !meta.resourceRef)
      issues.push(`${at}: ${EXTENSION_KEYS.resourceRef} needs { type }`)
    if (isRecord(raw[EXTENSION_KEYS.volatile]) && !meta.volatile)
      issues.push(`${at}: ${EXTENSION_KEYS.volatile} has an unknown kind`)
    if (isRecord(raw[EXTENSION_KEYS.scope]) && !meta.scope)
      issues.push(`${at}: ${EXTENSION_KEYS.scope} has an unknown value`)
    const types = schemaTypes(resolveSchema(document, schema)).filter((t) => t !== "null")
    if (meta.resource) {
      producedTypes.add(meta.resource.type)
      if (types.length > 0 && !types.includes("string"))
        issues.push(`${at}: resource identities must be strings`)
    }
    if (meta.resourceRef) {
      referencedTypes.set(meta.resourceRef.type, at)
      if (types.length > 0 && !types.includes("string"))
        issues.push(`${at}: resource references must be strings`)
    }
  }

  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    walkSchema(document, schema, (node, path) =>
      inspectSchema(node, `components.schemas.${name}/${path.join("/")}`),
    )
  }

  for (const operation of listOperations(document)) {
    const label = `${operation.method.toUpperCase()} ${operation.path}`
    const raw = operation.operation[EXTENSION_KEYS.operation]
    if (raw !== undefined && !isRecord(raw))
      issues.push(`${label}: ${EXTENSION_KEYS.operation} must be an object`)
    const meta = operationMetadata(operation.operation)
    if (!meta.supported && meta.reason === undefined)
      issues.push(`${label}: unsupported operations need a reason`)
    if (meta.supported && !meta.parity.enabled && meta.parity.reason === undefined) {
      issues.push(`${label}: parity-disabled operations need parity.reason`)
    }
    for (const parameter of operation.parameters) {
      const pm = parameterMetadata(document, parameter)
      if (pm.resourceRef)
        referencedTypes.set(pm.resourceRef.type, `${label} parameter ${parameter.name}`)
      if (parameter.schema) {
        walkSchema(document, parameter.schema, (node, path) =>
          inspectSchema(node, `${label} parameter ${parameter.name}/${path.join("/")}`),
        )
      }
    }
    for (const [mediaType, media] of Object.entries(operation.requestBody?.content ?? {})) {
      if (media.schema)
        walkSchema(document, media.schema, (node, path) =>
          inspectSchema(node, `${label} body ${mediaType}/${path.join("/")}`),
        )
    }
    for (const [status, response] of Object.entries(operation.responses)) {
      for (const [mediaType, media] of Object.entries(response.content ?? {})) {
        if (media.schema)
          walkSchema(document, media.schema, (node, path) =>
            inspectSchema(node, `${label} ${status} ${mediaType}/${path.join("/")}`),
          )
      }
    }
  }

  for (const [type, at] of referencedTypes) {
    if (!producedTypes.has(type))
      issues.push(
        `${at}: references resource type ${JSON.stringify(type)} but no identity produces it`,
      )
  }
  return issues
}

/** Every resource type produced by an identity somewhere in the document. */
export const resourceTypes = (document: OpenAPIDocument): string[] => {
  const types = new Set<string>()
  const inspect = (schema: SchemaObject) => {
    const meta = schemaMetadata(schema)
    if (meta.resource) types.add(meta.resource.type)
  }
  for (const schema of Object.values(document.components?.schemas ?? {}))
    walkSchema(document, schema, inspect)
  for (const operation of listOperations(document)) {
    for (const response of Object.values(operation.responses)) {
      for (const media of Object.values(response.content ?? {}))
        if (media.schema) walkSchema(document, media.schema, inspect)
    }
  }
  return [...types].sort()
}
