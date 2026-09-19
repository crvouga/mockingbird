# @crvouga/mockingbird-openapi-arbitrary

> **Internal package — not published to npm.** Mockingbird publishes only its mock services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

Turns OpenAPI / JSON Schema nodes into [fast-check](https://fast-check.dev/) arbitraries: boundary-weighted values that satisfy a schema, and values that violate exactly one of its constraints (with a description of the violation). Use it for property tests of request/response handling driven by a spec; you do not need it directly for parity testing — [`@crvouga/mockingbird-commands`](https://www.npmjs.com/package/@crvouga/mockingbird-commands) and [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) use it for you.

## Install

```bash
npm install -D @crvouga/mockingbird-openapi-arbitrary fast-check
```

`fast-check` 4.x is a dependency (pinned `4.9.0`); install the same major yourself to run properties or pass custom arbitraries to `override`. ESM only, Node >= 22 or Bun >= 1.2.

## Usage

```ts
import { parseOpenAPIDocument, type SchemaObject, validateValue } from "@crvouga/mockingbird-openapi"
import { invalidSchemaArbitrary, schemaArbitrary } from "@crvouga/mockingbird-openapi-arbitrary"
import fc from "fast-check"

const document = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "shop", version: "1" },
  paths: {},
})

const customer: SchemaObject = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 10 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 130 },
  },
}

// Every generated value satisfies the schema.
fc.assert(
  fc.property(schemaArbitrary(customer, { document }), (value) => {
    return validateValue(document, customer, value).length === 0
  }),
)

// Every generated value breaks exactly one constraint, and says which.
for (const { value, mutation } of fc.sample(invalidSchemaArbitrary(customer, { document }), 3)) {
  console.log(mutation.violation, mutation.valuePath, JSON.stringify(value))
}

// Pin or drop individual nodes.
const pinned = schemaArbitrary(customer, {
  document,
  override: (_schema, path) =>
    path.join("/") === "properties/email" ? fc.constant("a@example.com") : undefined,
})
console.log(fc.sample(pinned, 2))
```

## API

| Export | Signature | Description |
| --- | --- | --- |
| `schemaArbitrary` | `(schema: SchemaObject, options: SchemaArbitraryOptions) => fc.Arbitrary<unknown>` | Values that satisfy `schema`. Boundaries (min/max, just inside them, empty, min/max length and items) are weighted heavily; `examples`/`default` are mixed in lightly. Handles `$ref`, `const`, `enum`, `allOf` (merged), `oneOf`/`anyOf`, nullable types and self-referential schemas (depth-limited). |
| `invalidSchemaArbitrary` | `(schema, options: SchemaArbitraryOptions & { skip? }) => fc.Arbitrary<InvalidValue>` | Values that violate exactly one declared constraint, each verified invalid with `validateValue`. |
| `mutationSites` | `(document, schema, options?: { mode?, skip? }) => Array<Mutation & { schema: SchemaObject }>` | Every place a value for `schema` could break one constraint. Use it to check a schema is mutable before calling `invalidSchemaArbitrary`. |

`SchemaArbitraryOptions`:

| Field | Default | Description |
| --- | --- | --- |
| `document` | required | The `OpenAPIDocument` used to resolve `$ref`s. |
| `mode` | `"request"` | `"request"` skips `readOnly` properties, `"response"` skips `writeOnly`. |
| `override` | none | `(schema, path: SchemaPath) => Override`, called on each resolved node. Return an arbitrary to replace generation, `"omit"` to drop an optional property, or `undefined` to fall through. `path` is schema-relative, e.g. `["properties", "address", "properties", "city"]`. |
| `optionalProbability` | `0.5` | Chance an optional property is present. |
| `maxDepth` | `6` | Recursion guard for self-referential schemas. |

`skip` (on `invalidSchemaArbitrary` / `mutationSites`): `(schema, path) => boolean`; return `true` to never mutate that node or its children.

Exported types: `SchemaArbitraryOptions`, `Override` (`fc.Arbitrary<unknown> | "omit" | undefined`), `SchemaPath` (`string[]`), `InvalidValue` (`{ value; mutation }`), `Mutation` (`{ valuePath: (string | number)[]; violation; detail }`), `Violation` (`"wrong-type" | "string-too-long" | "string-too-short" | "number-too-large" | "number-too-small" | "not-in-enum" | "missing-required" | "unexpected-property" | "array-too-long" | "array-too-short" | "bad-format"`).

Gotcha: when `mutationSites` finds nothing to break (an unconstrained schema such as `{}`), `invalidSchemaArbitrary` returns an arbitrary that filters out every value — `fc.sample` on it never returns. Guard with `mutationSites(document, schema).length > 0` first.

## Related

- [`@crvouga/mockingbird-openapi`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi) — schema resolution and `validateValue`.
- [`@crvouga/mockingbird-commands`](https://www.npmjs.com/package/@crvouga/mockingbird-commands) — builds whole API commands from these arbitraries.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
