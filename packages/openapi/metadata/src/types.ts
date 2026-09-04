/**
 * Mockingbird's OpenAPI extensions. They are deliberately generic: nothing here knows about any
 * particular provider. Provider specifics live in each provider's `openapi.yaml`.
 */

/** `x-mockingbird` on an operation. */
export type OperationExtension = {
  /** `false` marks an operation the mock explicitly does not implement. Default `true`. */
  supported?: boolean
  /** Human explanation, required when `supported: false` or `parity.enabled: false`. */
  reason?: string
  parity?: {
    /** Whether the differential runner generates this operation. Defaults to `supported`. */
    enabled?: boolean
    /** `false` for operations that must never hit a real account (destructive, billing…). Default `true`. */
    safe?: boolean
    reason?: string
  }
}

export type OperationMetadata = {
  supported: boolean
  reason: string | undefined
  parity: { enabled: boolean; safe: boolean; reason: string | undefined }
}

/** `x-mockingbird-resource`: this string value is the identity of a resource. */
export type ResourceIdentityExtension = { type: string; identity: true }

/** `x-mockingbird-resource-ref`: this value must reference an existing resource of `type`. */
export type ResourceRefExtension = {
  type: string
  /** A well-formed id that does not exist, used to exercise not-found behaviour. */
  missing?: string
}

export const VOLATILE_KINDS = ["id", "timestamp", "token", "url", "account", "opaque"] as const
export type VolatileKind = (typeof VOLATILE_KINDS)[number]

/** `x-mockingbird-volatile`: nondeterministic on the real side; compared by shape only. */
export type VolatileExtension = { kind: VolatileKind }

export const SCOPE_VALUES = ["run-id", "walk-start-unix", "walk-start-iso"] as const
export type ScopeValue = (typeof SCOPE_VALUES)[number]

/** `x-mockingbird-scope`: always generate this run-scoped value instead of a random one. */
export type ScopeExtension = { value: ScopeValue }

/** `x-mockingbird-unsupported`: the mock does not implement this parameter/property. */
export type UnsupportedExtension = true | { reason?: string }

export type SchemaMetadata = {
  resource: ResourceIdentityExtension | undefined
  resourceRef: ResourceRefExtension | undefined
  volatile: VolatileExtension | undefined
  scope: ScopeExtension | undefined
  unsupported: { reason: string | undefined } | undefined
}

export const EXTENSION_KEYS = {
  operation: "x-mockingbird",
  resource: "x-mockingbird-resource",
  resourceRef: "x-mockingbird-resource-ref",
  volatile: "x-mockingbird-volatile",
  scope: "x-mockingbird-scope",
  unsupported: "x-mockingbird-unsupported",
  parityHeader: "x-mockingbird-parity-header",
} as const
