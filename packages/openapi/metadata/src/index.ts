export type { Annotation, JsonPath } from "./annotate.js"
export { annotateValue, pathKey } from "./annotate.js"
export { operationMetadata, parameterMetadata, parityHeaders, schemaMetadata } from "./read.js"
export type {
  OperationExtension,
  OperationMetadata,
  ResourceIdentityExtension,
  ResourceRefExtension,
  SchemaMetadata,
  ScopeExtension,
  ScopeValue,
  UnsupportedExtension,
  VolatileExtension,
  VolatileKind,
} from "./types.js"
export { EXTENSION_KEYS, SCOPE_VALUES, VOLATILE_KINDS } from "./types.js"
export { resourceTypes, validateMetadata } from "./validate.js"
