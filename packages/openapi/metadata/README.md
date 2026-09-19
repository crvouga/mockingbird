# @crvouga/mockingbird-openapi-metadata

> **Internal package — not published to npm.** Mockingbird publishes only its mock services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

Types, readers and validation for Mockingbird's `x-mockingbird-*` OpenAPI extensions — the annotations that tell the parity runner which values are resource ids, which are nondeterministic, which operations are safe to call, and so on. Use it when you author a provider spec for [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) and want to lint it, or when building your own tooling on top of the annotations; the parity runner already reads them for you.

## Install

```bash
npm install @crvouga/mockingbird-openapi-metadata
```

Depends on [`@crvouga/mockingbird-openapi`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi). ESM only, Node >= 22 or Bun >= 1.2.

## Extensions

| Key | Where | Shape | Meaning |
| --- | --- | --- | --- |
| `x-mockingbird` | operation | `{ supported?, reason?, parity?: { enabled?, safe?, reason? } }` | `supported: false` = mock does not implement it (needs `reason`). `parity.enabled` (default = `supported`) = the runner may generate it (needs `parity.reason` when false). `parity.safe: false` = never call on a real account unless `includeUnsafe`. |
| `x-mockingbird-resource` | schema | `{ type, identity: true }` | This string is the identity of a resource of `type` (e.g. `customer.id`). Must be a string schema. |
| `x-mockingbird-resource-ref` | schema or parameter | `{ type, missing? }` | This value references an existing resource of `type`; `missing` is a well-formed id that does not exist, used to exercise not-found paths. Some identity must produce `type`. |
| `x-mockingbird-volatile` | schema | `{ kind }` | Nondeterministic on the real side; compared by JSON type only. `kind` is one of `VOLATILE_KINDS` (`opaque` also collapses null vs present). |
| `x-mockingbird-scope` | schema or parameter | `{ value }` | Always generate a run-scoped value: `run-id`, `walk-start-unix` or `walk-start-iso`. |
| `x-mockingbird-unsupported` | schema or parameter | `true \| { reason? }` | The mock does not implement this parameter/property; the generator omits it. |
| `x-mockingbird-parity-header` | response header | `true` | This header takes part in the parity comparison (all others are ignored). |

## Usage

```ts
import { parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import {
  annotateValue,
  operationMetadata,
  resourceTypes,
  validateMetadata,
} from "@crvouga/mockingbird-openapi-metadata"

const customer = {
  type: "object",
  properties: {
    id: { type: "string", "x-mockingbird-resource": { type: "customer", identity: true } },
    created: { type: "integer", "x-mockingbird-volatile": { kind: "timestamp" } },
  },
} as const

const document = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "shop", version: "1" },
  paths: {
    "/customers": {
      post: {
        operationId: "createCustomer",
        "x-mockingbird": { parity: { safe: false } },
        responses: { "200": { description: "ok", content: { "application/json": { schema: customer } } } },
      },
    },
  },
})

console.log(validateMetadata(document)) // [] when every extension is well formed
console.log(resourceTypes(document)) // ["customer"]
console.log(operationMetadata(document.paths["/customers"]?.post ?? { responses: {} }))
// { supported: true, reason: undefined, parity: { enabled: true, safe: false, reason: undefined } }

console.log(annotateValue(document, customer, { id: "cus_1", created: 1700000000 }))
// [{ kind: "identity", path: ["id"], type: "customer" },
//  { kind: "volatile", path: ["created"], volatile: "timestamp" }]
```

## API

| Export | Signature | Description |
| --- | --- | --- |
| `operationMetadata` | `(operation: OperationObject) => OperationMetadata` | Read `x-mockingbird` with defaults applied (`supported: true`, `parity.enabled: supported && enabled`, `parity.safe: true`). |
| `schemaMetadata` | `(holder: SchemaObject \| ParameterObject) => SchemaMetadata` | Read `resource`, `resourceRef`, `volatile`, `scope`, `unsupported` from one node. Malformed values read as `undefined`. |
| `parameterMetadata` | `(document, parameter) => SchemaMetadata` | Like `schemaMetadata`, but extensions on the parameter win over those on its (resolved) schema. |
| `parityHeaders` | `(document, response: ResponseObject) => string[]` | Lower-cased, sorted names of headers flagged `x-mockingbird-parity-header: true`. |
| `validateMetadata` | `(document) => string[]` | Semantic lint: malformed extension objects, identities/refs that are not strings, missing `reason`/`parity.reason`, and `resource-ref` types that no identity produces. Empty when valid. |
| `resourceTypes` | `(document) => string[]` | Sorted resource types produced by some identity in component schemas or responses. |
| `annotateValue` | `(document, schema, value, path?) => Annotation[]` | Walk a value guided by its schema and report every identity and volatile location. Picks the matching `oneOf`/`anyOf` branch; uncovered values yield nothing (and are compared strictly by the canonicalizer). |
| `pathKey` | `(path: JsonPath) => string` | Stable string key for a JSON path. |
| `EXTENSION_KEYS` | `{ operation, resource, resourceRef, volatile, scope, unsupported, parityHeader }` | The extension key strings listed above. |
| `VOLATILE_KINDS` | `readonly ["id","timestamp","token","url","account","opaque"]` | Allowed `x-mockingbird-volatile.kind` values. |
| `SCOPE_VALUES` | `readonly ["run-id","walk-start-unix","walk-start-iso"]` | Allowed `x-mockingbird-scope.value` values. |

Exported types: `OperationExtension`, `OperationMetadata`, `SchemaMetadata`, `ResourceIdentityExtension`, `ResourceRefExtension`, `VolatileExtension`, `VolatileKind`, `ScopeExtension`, `ScopeValue`, `UnsupportedExtension`, `Annotation` (`{ kind: "identity"; path; type } | { kind: "volatile"; path; volatile }`), `JsonPath` (`(string | number)[]`).

## Related

- [`@crvouga/mockingbird-openapi`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi) — document loading and schema validation.
- [`@crvouga/mockingbird-canonicalize`](https://www.npmjs.com/package/@crvouga/mockingbird-canonicalize) — consumes these annotations to canonicalize responses.
- [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) — differential parity runner.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
