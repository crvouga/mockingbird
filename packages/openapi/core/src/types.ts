/**
 * The slice of OpenAPI 3.1 (and JSON Schema 2020-12) Mockingbird understands.
 * Unknown keys (including `x-*` extensions) are preserved on every object.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ReferenceObject = { $ref: string; description?: string; summary?: string }

export type SchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null"

export type SchemaObject = {
  $ref?: string
  type?: SchemaType | SchemaType[]
  title?: string
  description?: string
  format?: string
  enum?: JsonValue[]
  const?: JsonValue
  default?: JsonValue
  example?: JsonValue
  examples?: JsonValue[]
  nullable?: boolean
  deprecated?: boolean
  readOnly?: boolean
  writeOnly?: boolean
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  items?: SchemaObject
  prefixItems?: SchemaObject[]
  minProperties?: number
  maxProperties?: number
  required?: string[]
  properties?: Record<string, SchemaObject>
  additionalProperties?: boolean | SchemaObject
  propertyNames?: SchemaObject
  oneOf?: SchemaObject[]
  anyOf?: SchemaObject[]
  allOf?: SchemaObject[]
  not?: SchemaObject
  discriminator?: { propertyName: string; mapping?: Record<string, string> }
  [extension: `x-${string}`]: unknown
}

export type ParameterLocation = "path" | "query" | "header" | "cookie"

export type ParameterObject = {
  name: string
  in: ParameterLocation
  description?: string
  required?: boolean
  deprecated?: boolean
  style?: string
  explode?: boolean
  schema?: SchemaObject
  content?: Record<string, MediaTypeObject>
  example?: JsonValue
  [extension: `x-${string}`]: unknown
}

export type MediaTypeObject = {
  schema?: SchemaObject
  example?: JsonValue
  examples?: Record<string, unknown>
  encoding?: Record<string, unknown>
  [extension: `x-${string}`]: unknown
}

export type RequestBodyObject = {
  description?: string
  required?: boolean
  content: Record<string, MediaTypeObject>
  [extension: `x-${string}`]: unknown
}

export type HeaderObject = {
  description?: string
  required?: boolean
  schema?: SchemaObject
  [extension: `x-${string}`]: unknown
}

export type ResponseObject = {
  description: string
  headers?: Record<string, HeaderObject | ReferenceObject>
  content?: Record<string, MediaTypeObject>
  [extension: `x-${string}`]: unknown
}

export type ResponsesObject = Record<string, ResponseObject | ReferenceObject>

export type SecurityRequirementObject = Record<string, string[]>

export type OperationObject = {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  parameters?: Array<ParameterObject | ReferenceObject>
  requestBody?: RequestBodyObject | ReferenceObject
  responses: ResponsesObject
  security?: SecurityRequirementObject[]
  [extension: `x-${string}`]: unknown
}

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export type PathItemObject = {
  summary?: string
  description?: string
  parameters?: Array<ParameterObject | ReferenceObject>
  [extension: `x-${string}`]: unknown
} & Partial<Record<HttpMethod, OperationObject>>

export type SecuritySchemeObject = {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS"
  description?: string
  name?: string
  in?: ParameterLocation
  scheme?: string
  bearerFormat?: string
  flows?: Record<string, unknown>
  openIdConnectUrl?: string
  [extension: `x-${string}`]: unknown
}

export type ComponentsObject = {
  schemas?: Record<string, SchemaObject>
  responses?: Record<string, ResponseObject>
  parameters?: Record<string, ParameterObject>
  requestBodies?: Record<string, RequestBodyObject>
  headers?: Record<string, HeaderObject>
  securitySchemes?: Record<string, SecuritySchemeObject>
  [extension: `x-${string}`]: unknown
}

export type ServerObject = {
  url: string
  description?: string
  variables?: Record<string, unknown>
  [extension: `x-${string}`]: unknown
}

export type InfoObject = {
  title: string
  version: string
  description?: string
  [extension: `x-${string}`]: unknown
}

export type OpenAPIDocument = {
  openapi: string
  info: InfoObject
  servers?: ServerObject[]
  paths: Record<string, PathItemObject>
  components?: ComponentsObject
  security?: SecurityRequirementObject[]
  tags?: Array<{ name: string; description?: string }>
  [extension: `x-${string}`]: unknown
}

/** One concrete HTTP operation discovered in a document. */
export type Operation = {
  operationId: string
  method: HttpMethod
  /** OpenAPI path template, e.g. `/v1/customers/{customer}`. */
  path: string
  operation: OperationObject
  /** Path-level parameters merged with operation-level ones (operation wins), `$ref`s resolved. */
  parameters: ParameterObject[]
  requestBody: RequestBodyObject | undefined
  responses: Record<string, ResponseObject>
}
