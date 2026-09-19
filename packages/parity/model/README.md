# @crvouga/mockingbird-model

> **Internal package — not published to npm.** Mockingbird publishes only its mock services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

Provider-neutral symbolic resource model for differential testing. Generated commands never contain concrete ids: they say "customer #2", and each side of a comparison (`real` and `mock`) binds that handle to its own id in a `ResourceTable`; canonicalization then turns both ids back into `resource:customer:2`. You only need this directly if you are building your own differential runner or command executor — [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) uses it for you.

## Install

```bash
npm install -D @crvouga/mockingbird-model
```

No dependencies. ESM only, Node >= 22 or Bun >= 1.2.

## Usage

```ts
import {
  canonicalToken,
  missingPlaceholder,
  pickRef,
  refPlaceholder,
  ResourceTable,
  resolvePlaceholders,
} from "@crvouga/mockingbird-model"

const table = new ResourceTable()
// Both sides created "the same" customer, with different concrete ids.
const customer = table.register("customer", { real: "cus_Real123", mock: "cus_mock_1" })
console.log(canonicalToken(customer.type, customer.handle)) // "resource:customer:1"
console.log(table.lookup("real", "customer", "cus_Real123")?.handle) // 1

// A generated command body with symbolic references, resolved per side.
const body = { customer: refPlaceholder("customer", 7), other: missingPlaceholder("customer") }
for (const side of ["real", "mock"] as const) {
  console.log(
    side,
    resolvePlaceholders(body, (placeholder) => {
      if (placeholder.$mockingbird === "ref") {
        const ref = pickRef(table, placeholder.type, placeholder.pick)
        return ref === undefined ? undefined : table.idOf(ref, side)
      }
      return placeholder.$mockingbird === "missing" ? "cus_does_not_exist" : placeholder.value
    }),
  )
}
// real { customer: "cus_Real123", other: "cus_does_not_exist" }
// mock { customer: "cus_mock_1", other: "cus_does_not_exist" }
```

## API

| Export | Signature | Description |
| --- | --- | --- |
| `ResourceTable` | `class` | Bidirectional table between sequential symbolic handles and per-side ids. See methods below. |
| `SIDES` | `readonly ["real", "mock"]` | Both sides of a comparison. |
| `canonicalToken` | `(type, handle) => string` | `resource:<type>:<handle>`, identical on both sides. |
| `describeRef` | `(ref: SymbolicRef) => string` | `"customer #2"`. |
| `PLACEHOLDER_KEY` | `"$mockingbird"` | Marker key of placeholders embedded in generated values. |
| `refPlaceholder` | `(type, pick: number) => Placeholder` | "The `pick`-th existing resource of `type`" (modulo count at execution time). |
| `missingPlaceholder` | `(type, missing?: string) => Placeholder` | A well-formed id that exists on neither side. |
| `scopePlaceholder` | `(value: string) => Placeholder` | A run-scoped value (`run-id`, `walk-start-unix`, `walk-start-iso`). |
| `isPlaceholder` | `(value) => value is Placeholder` | Object with a string `$mockingbird` key. |
| `resolvePlaceholders` | `(value, resolve: (p: Placeholder) => unknown) => unknown` | Depth-first copy replacing every placeholder (safe for `__proto__` keys). |
| `collectPlaceholders` | `(value, out?) => Placeholder[]` | Every placeholder in pre-order. |
| `pickRef` | `(table, type, pick, deletedRefProbability = 0) => SymbolicRef \| undefined` | Resolve a `ref` pick against active handles, wrapping around; `undefined` if none exist. With a probability > 0, some picks (`pick % 100` below the threshold) also consider deleted resources. |
| `defaultMissingId` | `(type) => string` | `mockingbird_missing_<type>`, used when the spec gives no `missing` id. |

`ResourceTable` methods:

| Method | Description |
| --- | --- |
| `allocate(type)` | New resource with the next handle and no ids bound. |
| `bind(handle, side, id)` | Bind an id on one side; rebinding to a different id throws. Unknown handle throws `RangeError`. |
| `register(type, { real?, mock? })` | `allocate` + `bind` in one step. |
| `get(handle)` / `lookup(side, type, id)` / `idOf(ref, side)` | Look up by handle, by concrete id, or get the id of a ref on a side. |
| `markDeleted(handle)` | Mark deleted but keep it (for negative-reference coverage). |
| `handles(type, { includeDeleted? })` / `handlesAll(type)` | Handles in allocation order (active only by default). |
| `count(type)` / `countAll(type)` | Active / total resources of a type. |
| `all()` | Every resource in allocation order. |
| `knownIds(side)` | Every bound id on a side, longest first (safe for substring replacement). |

Exported types: `Side` (`"real" | "mock"`), `SymbolicRef` (`{ type; handle }`), `SymbolicResource` (`{ type; handle; ids: Partial<Record<Side, string>>; status: "active" | "deleted" }`), `Placeholder`.

## Related

- [`@crvouga/mockingbird-commands`](https://www.npmjs.com/package/@crvouga/mockingbird-commands) — generates commands containing these placeholders.
- [`@crvouga/mockingbird-canonicalize`](https://www.npmjs.com/package/@crvouga/mockingbird-canonicalize) — rewrites ids to canonical tokens using the table.
- [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) — the runner that ties them together.

Part of [mockingbird](https://github.com/crvouga/mockingbird).
