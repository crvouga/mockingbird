import type {
  OpenAPIDocument,
  Operation,
  ParameterObject,
  ResponseObject,
  SchemaObject,
} from "@crvouga/mockingbird-openapi"
import { listOperations, resolveSchema, walkSchema } from "@crvouga/mockingbird-openapi"
import {
  type OperationMetadata,
  operationMetadata,
  parameterMetadata,
  schemaMetadata,
} from "@crvouga/mockingbird-openapi-metadata"

export type RequestBodyPlan = { mediaType: string; schema: SchemaObject; required: boolean }

/** Everything the generator needs to know about one operation, precomputed once per document. */
export type OperationPlan = {
  operation: Operation
  metadata: OperationMetadata
  /** Resource types that must exist before the operation can be generated. */
  requires: string[]
  /** Resource types whose identities appear in a success response. */
  produces: string[]
  body: RequestBodyPlan | undefined
}

const PREFERRED_MEDIA_TYPES = ["application/x-www-form-urlencoded", "application/json"]

const pickBody = (operation: Operation): RequestBodyPlan | undefined => {
  const body = operation.requestBody
  if (!body) return undefined
  const entries = Object.entries(body.content)
  const preferred =
    PREFERRED_MEDIA_TYPES.map((type) => entries.find(([mediaType]) => mediaType === type)).find(
      Boolean,
    ) ?? entries[0]
  if (!preferred) return undefined
  const [mediaType, media] = preferred
  return { mediaType, schema: media.schema ?? {}, required: body.required ?? false }
}

const successResponses = (operation: Operation): ResponseObject[] =>
  Object.entries(operation.responses)
    .filter(([status]) => /^2/.test(status))
    .map(([, response]) => response)

const identityTypes = (document: OpenAPIDocument, schema: SchemaObject): string[] => {
  const types = new Set<string>()
  walkSchema(document, schema, (node) => {
    const meta = schemaMetadata(node)
    if (meta.resource) types.add(meta.resource.type)
  })
  return [...types].sort()
}

/** Resource types referenced (via `x-mockingbird-resource-ref`) from locations that are required. */
const requiredRefs = (
  document: OpenAPIDocument,
  parameters: ParameterObject[],
  body: RequestBodyPlan | undefined,
) => {
  const types = new Set<string>()
  for (const parameter of parameters) {
    if (!(parameter.required || parameter.in === "path")) continue
    const meta = parameterMetadata(document, parameter)
    if (meta.resourceRef) types.add(meta.resourceRef.type)
  }
  if (body?.required) {
    const root = resolveSchema(document, body.schema)
    for (const name of root.required ?? []) {
      const property = root.properties?.[name]
      if (!property) continue
      const meta = schemaMetadata(resolveSchema(document, property))
      if (meta.resourceRef) types.add(meta.resourceRef.type)
    }
  }
  return [...types].sort()
}

export type PlanOptions = {
  /** Include operations flagged `parity.safe: false`. Default `false`. */
  includeUnsafe?: boolean
  /** Restrict to these operation ids. */
  only?: readonly string[]
  /**
   * Include these supported operation ids even when `parity.enabled` is false.
   * Used by seedParity so Geviti QA surfaces can be exercised after observation seeding.
   */
  forceInclude?: readonly string[]
}

/** Plans for every operation the differential runner may generate. */
export const planOperations = (
  document: OpenAPIDocument,
  options: PlanOptions = {},
): OperationPlan[] => {
  const only = options.only ? new Set(options.only) : undefined
  const forceInclude = options.forceInclude ? new Set(options.forceInclude) : undefined
  const plans: OperationPlan[] = []
  for (const operation of listOperations(document)) {
    if (only && !only.has(operation.operationId)) continue
    const metadata = operationMetadata(operation.operation)
    if (!metadata.supported) continue
    const forced = forceInclude?.has(operation.operationId) === true
    if (!metadata.parity.enabled && !forced) continue
    if (!metadata.parity.safe && !options.includeUnsafe && !forced) continue
    const body = pickBody(operation)
    const produces = new Set<string>()
    for (const response of successResponses(operation)) {
      for (const media of Object.values(response.content ?? {})) {
        if (media.schema)
          for (const type of identityTypes(document, media.schema)) produces.add(type)
      }
    }
    plans.push({
      operation,
      metadata,
      requires: requiredRefs(document, operation.parameters, body),
      produces: [...produces].sort(),
      body,
    })
  }
  return plans
}
