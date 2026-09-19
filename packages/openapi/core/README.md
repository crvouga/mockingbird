# @crvouga/mockingbird-openapi

Dependency-free OpenAPI 3.0/3.1 toolkit used across Mockingbird: structural document validation, local `$ref` resolution, operation discovery, path templating, schema traversal, and JSON Schema instance validation. Use it directly when you need to inspect or validate an OpenAPI document or check a value against one of its schemas; if you only want parity testing, [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) uses it for you.

## Install

```bash
npm install @crvouga/mockingbird-openapi
```

ESM only, Node >= 22 or Bun >= 1.2. No runtime dependencies. Documents must be already-parsed objects (parse YAML yourself).

## Usage

```ts
import {
  expandPathTemplate,
  findOperation,
  listOperations,
  parseOpenAPIDocument,
  responseForStatus,
  validateValue,
} from "@crvouga/mockingbird-openapi"

// Throws OpenAPIDocumentError listing every problem (bad $ref, duplicate operationId, ...).
const document = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "notes", version: "1" },
  paths: {
    "/notes/{note}": {
      get: {
        operationId: "getNote",
        parameters: [{ name: "note", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/note" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      note: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, text: { type: "string", maxLength: 5 } },
      },
    },
  },
})

for (const op of listOperations(document)) console.log(op.method, op.path, op.operationId)

const getNote = findOperation(document, "getNote")
if (getNote) {
  console.log(expandPathTemplate(getNote.path, { note: "a/b" })) // "/notes/a%2Fb"
  const schema = responseForStatus(getNote.responses, 200)?.content?.["application/json"]?.schema
  if (schema) console.log(validateValue(document, schema, { text: "too long" }))
  // [{ path: [], message: "missing required property id" },
  //  { path: ["text"], message: "length 8 > maxLength 5" }]
}
```

## API

Documents and operations:

| Export | Signature | Description |
| --- | --- | --- |
| `parseOpenAPIDocument` | `(value: unknown) => OpenAPIDocument` | Checks `openapi` is 3.0.x/3.1.x, `info.title`/`info.version`, `paths`, then runs `validateOpenAPIDocument`. Throws `OpenAPIDocumentError`. |
| `validateOpenAPIDocument` | `(document) => string[]` | Mockingbird's rules: every `$ref` resolves, every operation has a unique `operationId` and at least one response, path template params and declared path params match and are `required`. Empty array when valid. |
| `OpenAPIDocumentError` | `class extends Error { issues: string[] }` | Thrown by `parseOpenAPIDocument`. |
| `listOperations` | `(document) => Operation[]` | Every operation in path, then method order. Parameters are merged (operation wins over path item) and `$ref`s in parameters, request body and responses are resolved. Operations without `operationId` are skipped. |
| `findOperation` | `(document, operationId) => Operation \| undefined` | Look up one operation. |
| `HTTP_METHODS` | `readonly ["get","put","post","delete","options","head","patch","trace"]` | Methods scanned on each path item. |
| `pathTemplateParameters` | `(path: string) => string[]` | Names inside `{...}` in order. |
| `expandPathTemplate` | `(template, values: Record<string,string>) => string` | Substitutes placeholders with `encodeURIComponent`; throws `RangeError` on a missing value. |
| `responseForStatus` | `(responses, status: number) => ResponseObject \| undefined` | Exact status, then `2XX`-style range, then `default`. |

References:

| Export | Signature | Description |
| --- | --- | --- |
| `resolveRef` | `(document, ref: string) => unknown` | Resolve a local JSON pointer (`#/...`). Only local refs are supported; throws `OpenAPIReferenceError`. |
| `deref` | `<T>(document, value: T \| ReferenceObject) => T` | Follow `$ref` chains to a concrete object (cycle-guarded; sibling keys ignored). |
| `isReference` | `(value) => value is ReferenceObject` | True for `{ $ref: string }`. |
| `componentNameOf` | `(ref: string) => string \| undefined` | `"#/components/schemas/customer"` -> `"customer"`. |
| `OpenAPIReferenceError` | `class extends Error { ref: string }` | Unresolvable or cyclic reference. |

Schemas:

| Export | Signature | Description |
| --- | --- | --- |
| `resolveSchema` | `(document, schema) => SchemaObject` | Resolve `$ref` (sibling keywords override the target) and normalise 3.0 `nullable: true` into a type array with `"null"`. |
| `schemaTypes` | `(schema) => SchemaType[]` | Declared `type`s, or types inferred from keywords (`properties` -> object, `minLength` -> string, ...). Empty when unconstrained. |
| `jsonTypeOf` | `(value) => SchemaType \| "undefined"` | JSON type of a runtime value (integers report `"integer"`). |
| `walkSchema` | `(document, schema, visit: SchemaVisitor, path?) => void` | Depth-first walk over properties, items, unions, `not`, etc. Each resolved node is visited once per call. |
| `validateValue` | `(document, schema, value, path?) => ValidationError[]` | Validate a value; empty array when valid. |
| `isValid` | `(document, schema, value) => boolean` | `validateValue(...).length === 0`. |

`validateValue` supports `type`, `enum`, `const`, string length (counted in code points), `pattern` (skipped if the regex is not valid with the `u` flag), `format` (`uuid`, `date`, `date-time`, `email`, `uri`, `ipv4`; unknown formats pass), numeric bounds and `multipleOf`, array bounds/`uniqueItems`/`items`/`prefixItems`, `required`, `min/maxProperties`, `additionalProperties`, `propertyNames`, `allOf`, `anyOf`, `oneOf` and `not`. A `null` value passes `enum` when `type` includes `"null"`.

Exported types: `OpenAPIDocument`, `Operation` (`{ operationId, method, path, operation, parameters, requestBody, responses }`), `OperationObject`, `PathItemObject`, `ParameterObject`, `ParameterLocation`, `RequestBodyObject`, `ResponseObject`, `ResponsesObject`, `MediaTypeObject`, `HeaderObject`, `SchemaObject`, `SchemaType`, `ReferenceObject`, `ComponentsObject`, `SecuritySchemeObject`, `SecurityRequirementObject`, `ServerObject`, `InfoObject`, `HttpMethod`, `JsonValue`, `JsonPrimitive`, `SchemaVisitor` (`(schema, path: string[]) => void`), `ValidationError` (`{ path: (string | number)[]; message: string }`). All objects accept `x-*` extension keys.

## Related

- [`@crvouga/mockingbird-openapi-metadata`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi-metadata) — reads Mockingbird's `x-mockingbird-*` extensions.
- [`@crvouga/mockingbird-openapi-arbitrary`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi-arbitrary) — fast-check arbitraries from schemas.
- [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) — differential parity runner.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [`@crvouga/mockingbird`](https://github.com/crvouga/mockingbird/tree/main/packages/facade#readme).
