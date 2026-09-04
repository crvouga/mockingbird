import type {
  HeaderObject,
  OpenAPIDocument,
  OperationObject,
  ParameterObject,
  ResponseObject,
  SchemaObject,
} from "@crvouga/mockingbird-openapi"
import { deref, resolveSchema } from "@crvouga/mockingbird-openapi"
import {
  EXTENSION_KEYS,
  type OperationExtension,
  type OperationMetadata,
  SCOPE_VALUES,
  type SchemaMetadata,
  VOLATILE_KINDS,
} from "./types.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const extensionOf = (holder: object, key: string): unknown =>
  (holder as Record<string, unknown>)[key]

/** Read `x-mockingbird` from an operation, applying defaults. */
export const operationMetadata = (operation: OperationObject): OperationMetadata => {
  const raw = extensionOf(operation, EXTENSION_KEYS.operation)
  const ext: OperationExtension = isRecord(raw) ? (raw as OperationExtension) : {}
  const supported = ext.supported ?? true
  const parity = ext.parity ?? {}
  return {
    supported,
    reason: typeof ext.reason === "string" ? ext.reason : undefined,
    parity: {
      enabled: supported && (parity.enabled ?? true),
      safe: parity.safe ?? true,
      reason: typeof parity.reason === "string" ? parity.reason : undefined,
    },
  }
}

const readResource = (raw: unknown): SchemaMetadata["resource"] => {
  if (!isRecord(raw) || typeof raw.type !== "string" || raw.identity !== true) return undefined
  return { type: raw.type, identity: true }
}

const readResourceRef = (raw: unknown): SchemaMetadata["resourceRef"] => {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined
  return { type: raw.type, ...(typeof raw.missing === "string" ? { missing: raw.missing } : {}) }
}

const readVolatile = (raw: unknown): SchemaMetadata["volatile"] => {
  if (!isRecord(raw) || typeof raw.kind !== "string") return undefined
  const kind = VOLATILE_KINDS.find((k) => k === raw.kind)
  return kind === undefined ? undefined : { kind }
}

const readScope = (raw: unknown): SchemaMetadata["scope"] => {
  if (!isRecord(raw) || typeof raw.value !== "string") return undefined
  const value = SCOPE_VALUES.find((v) => v === raw.value)
  return value === undefined ? undefined : { value }
}

const readUnsupported = (raw: unknown): SchemaMetadata["unsupported"] => {
  if (raw === true) return { reason: undefined }
  if (isRecord(raw)) return { reason: typeof raw.reason === "string" ? raw.reason : undefined }
  return undefined
}

/**
 * Read Mockingbird's schema-level extensions from a (resolved) schema or parameter.
 * Extensions on a `$ref` wrapper win over the target's, matching {@link resolveSchema}.
 */
export const schemaMetadata = (holder: SchemaObject | ParameterObject): SchemaMetadata => ({
  resource: readResource(extensionOf(holder, EXTENSION_KEYS.resource)),
  resourceRef: readResourceRef(extensionOf(holder, EXTENSION_KEYS.resourceRef)),
  volatile: readVolatile(extensionOf(holder, EXTENSION_KEYS.volatile)),
  scope: readScope(extensionOf(holder, EXTENSION_KEYS.scope)),
  unsupported: readUnsupported(extensionOf(holder, EXTENSION_KEYS.unsupported)),
})

/** Metadata of a parameter: extensions on the parameter itself win over its schema's. */
export const parameterMetadata = (
  document: OpenAPIDocument,
  parameter: ParameterObject,
): SchemaMetadata => {
  const own = schemaMetadata(parameter)
  const fromSchema = parameter.schema
    ? schemaMetadata(resolveSchema(document, parameter.schema))
    : undefined
  return {
    resource: own.resource ?? fromSchema?.resource,
    resourceRef: own.resourceRef ?? fromSchema?.resourceRef,
    volatile: own.volatile ?? fromSchema?.volatile,
    scope: own.scope ?? fromSchema?.scope,
    unsupported: own.unsupported ?? fromSchema?.unsupported,
  }
}

/** Lower-cased names of response headers flagged with `x-mockingbird-parity-header: true`. */
export const parityHeaders = (document: OpenAPIDocument, response: ResponseObject): string[] => {
  const names: string[] = []
  for (const [name, raw] of Object.entries(response.headers ?? {})) {
    const header = deref<HeaderObject>(document, raw)
    if (extensionOf(header, EXTENSION_KEYS.parityHeader) === true) names.push(name.toLowerCase())
  }
  return names.sort()
}
