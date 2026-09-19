# @crvouga/mockingbird-canonicalize

Strict, provider-neutral canonicalization of HTTP exchanges for differential comparison. It rewrites resource ids to symbolic tokens (`resource:customer:1`), collapses fields the spec marks volatile (`volatile:timestamp:integer`), keeps only declared parity headers, and reports a strict structural diff. You only need this directly if you are building your own differential runner — [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) uses it for you.

## Install

```bash
npm install -D @crvouga/mockingbird-canonicalize
```

ESM only, Node >= 22 or Bun >= 1.2. Exchanges carry bodies decoded by `readBody` from [`@crvouga/mockingbird-http-codec`](https://www.npmjs.com/package/@crvouga/mockingbird-http-codec).

## Usage

```ts
import {
  canonicalizeExchange,
  discoverIdentities,
  type Exchange,
  formatDifference,
  structuralDiff,
} from "@crvouga/mockingbird-canonicalize"
import { ResourceTable, type Side } from "@crvouga/mockingbird-model"
import { parseOpenAPIDocument, type SchemaObject } from "@crvouga/mockingbird-openapi"

const document = parseOpenAPIDocument({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} })
const schema: SchemaObject = {
  type: "object",
  properties: {
    id: { type: "string", "x-mockingbird-resource": { type: "customer", identity: true } },
    created: { type: "integer", "x-mockingbird-volatile": { kind: "timestamp" } },
    url: { type: "string" },
    balance: { type: "integer" },
  },
}

const real: Exchange = {
  status: 200,
  headers: { "content-type": "application/json", "request-id": "req_abc" },
  body: { kind: "json", value: { id: "cus_R1", created: 1700000001, url: "/v1/customers/cus_R1", balance: 0 } },
}
const mock: Exchange = {
  status: 200,
  headers: { "content-type": "application/json", "request-id": "req_xyz" },
  body: { kind: "json", value: { id: "cus_m1", created: 1700000999, url: "/v1/customers/cus_m1", balance: 1 } },
}

// Pair the new identities from both responses into one symbolic resource.
const table = new ResourceTable()
discoverIdentities(document, schema, real.body.kind === "json" ? real.body.value : undefined,
  mock.body.kind === "json" ? mock.body.value : undefined, table)

const options = (side: Side) => ({ document, schema, parityHeaders: ["content-type"], side, table })
const differences = structuralDiff(
  canonicalizeExchange(real, options("real")),
  canonicalizeExchange(mock, options("mock")),
)
for (const difference of differences) console.log(formatDifference(difference))
// $.body.value.balance: real=0 mock=1
```

## API

| Export | Signature | Description |
| --- | --- | --- |
| `canonicalizeExchange` | `(exchange: Exchange, options: CanonicalizeOptions) => CanonicalExchange` | Keep status, keep only `parityHeaders` (ids inside them replaced), canonicalize the body. JSON/form bodies go through `canonicalizeValue`; text and invalid bodies get id replacement; byte bodies compare by presence only. |
| `canonicalizeValue` | `(value, options: CanonicalizeOptions) => unknown` | 1. identity locations -> `resource:<type>:<handle>` (or `unknown:<type>:<id>` if unbound); 2. volatile locations -> `volatile:<kind>:<json type>`; 3. every other occurrence of a known id (in strings and object keys) -> its token. Nothing else changes: omitted vs `null`, ordering and number vs string all survive. |
| `discoverIdentities` | `(document, schema \| undefined, real, mock, table) => DiscoveredIdentity[]` | Pair identity locations of two responses to the same command and `register` each pair where both sides carry a not-yet-bound string id. Other combinations are left alone so they show up as differences. |
| `replaceKnownIds` | `(text, table, side) => string` | Replace every bound id of `side` inside a string with its token (longest id first). |
| `volatileToken` | `(kind, value) => string` | `volatile:<kind>:<json type>`; for `opaque`, just `volatile:opaque` (so `null` vs present also match). |
| `unknownToken` | `(type, id) => string` | `unknown:<type>:<id>`. |
| `structuralDiff` | `(left, right, path?, out?) => Difference[]` | Strict diff: object key order ignored, array order significant, `undefined` properties count as omitted, primitives compared with `Object.is`. |
| `formatDifference` | `(difference, labels = ["real", "mock"]) => string` | One line such as `$.body.value.balance: real=0 mock=1`. |
| `formatPath` | `(path: JsonPath) => string` | `$`, `$.a[0].b`. |

`CanonicalizeOptions`: `document`, `schema` (response schema for this status/media type; without one every value is compared strictly), `parityHeaders` (lower-cased header names that take part — see `x-mockingbird-parity-header` / `parityHeaders()` in `@crvouga/mockingbird-openapi-metadata`), `side` (`"real" | "mock"`), `table` (`ResourceTable`).

Exported types: `Exchange` (`{ status; headers (lower-cased); body: DecodedBody }`), `CanonicalExchange`, `CanonicalBody` (`empty | json | form | text | bytes | invalid`), `CanonicalizeOptions`, `DiscoveredIdentity` (`{ path; type; real; mock }`), `Difference` (`type | value | length | missing-left | missing-right`, each with a `path`).

## Related

- [`@crvouga/mockingbird-model`](https://www.npmjs.com/package/@crvouga/mockingbird-model) — `ResourceTable`.
- [`@crvouga/mockingbird-openapi-metadata`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi-metadata) — the `x-mockingbird-resource` / `x-mockingbird-volatile` annotations this reads.
- [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) — the runner.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [`@crvouga/mockingbird`](https://github.com/crvouga/mockingbird/tree/main/packages/facade#readme).
