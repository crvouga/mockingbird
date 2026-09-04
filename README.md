# mockingbird

A catalog of **stateful mock servers** for popular third-party HTTP APIs.

Each mock speaks the provider's real surface (`fetch(Request) → Response`), keeps state in a pluggable key-value store, and is driven by a vendored OpenAPI contract. Drop one into a test process instead of hitting the network, or serve it over Node / Bun when you need a local origin.

## Testing

**Example-based tests are banned.** No hardcoded request/response pairs, no fixture walks, no `it("creates a customer")`. Every test in this repo is a `*.property.test.ts` suite.

Validation is **property-based testing (PBT)** with [fast-check](https://fast-check.dev/): random stateful walks of API commands generated from the OpenAPI spec (valid bodies, single-constraint invalid bodies, missing ids). A property must hold for every walk. Failures shrink to a minimal reproduction.

Two properties, same generator:

1. **Self-parity** (CI, no credentials) — two independent mock instances agree after every command, and every mock response conforms to the spec.
2. **Live parity** (`bun run parity`, sandbox keys required) — the same walk against the real sandbox API and a fresh mock. Responses are canonicalized (volatile ids, timestamps, tokens) then compared.

```ts
import { MemoryKV } from "@crvouga/mockingbird-kv-memory"
import { parity } from "@crvouga/mockingbird-parity"
import { document, StripeAPI } from "@crvouga/mockingbird-service-stripe"

const now = () => 1_700_000_000_000
const create = () => new StripeAPI({ kv: new MemoryKV(), now })
const reference = create()

await parity({
  provider: "stripe",
  spec: document,
  real: {
    baseUrl: "https://mock.stripe.local",
    allowedHosts: ["mock.stripe.local"],
    headers: () => ({ authorization: "Bearer sk_test_mockingbird" }),
    fetch: (request) => reference.fetch(request),
  },
  mock: { create },
})
```

Lower layers use the same style: kv adapters run random get/set/delete/list walks against a `Map` model (`keyValueStoreProperties`).

Replay a failing walk with the seed printed in the error:

```bash
FC_SEED=12345 bun test
FC_SEED=12345 FC_NUM_RUNS=100 bun test
MOCKINGBIRD_TRACE=1 bun run parity:stripe
```

`bun test` is the property suite. `bun run parity` (and `parity:stripe` / `parity:junction` / `parity:genebygene`) is live differential against each provider's sandbox.

```
OpenAPI spec
  → command generator (valid + invalid + missing refs)
  → random stateful walk
       ├─ mock A  ─┐
       └─ mock B  ─┴─ self-parity (CI)
       ├─ real sandbox ─┐
       └─ mock          ┴─ live parity (credentials)
  → canonicalize (strip ids / timestamps / tokens)
  → structural diff; shrink on failure
```

## Catalog

| Package | Provider | Status |
| --- | --- | --- |
| [`@crvouga/mockingbird-service-stripe`](packages/service/stripe) | Stripe (customers, products, prices) | Implemented; 14 operations, all parity-enabled — see [`SUPPORT.md`](packages/service/stripe/SUPPORT.md) |
| [`@crvouga/mockingbird-service-junction`](packages/service/junction) | Junction (Vital) | Scaffolded |
| [`@crvouga/mockingbird-service-genebygene`](packages/service/genebygene) | GeneByGene | Scaffolded |

The umbrella package is [`@crvouga/mockingbird`](packages/facade). Granular `@crvouga/mockingbird-*` packages are the source of truth.

State lives in the supplied `KeyValueStore` (`MemoryKV`, file, or `localStorage`). Several services can share one store; `reset()` only clears that service's namespace.

## Packages

| Layer | Packages |
| --- | --- |
| Core | `core` (`FetchAPI`), `service` (Hono dispatch keyed by `operationId`) |
| Storage | `kv`, `kv-memory`, `kv-file`, `kv-local-storage`, `kv-properties` |
| Contract | `openapi`, `openapi-metadata`, `openapi-arbitrary`, `openapi-codegen` |
| Parity | `commands`, `model`, `canonicalize`, `parity` (runner) |
| Services | `service-stripe`, `service-junction`, `service-genebygene` |
| Adapters | `adapter-node`, `adapter-bun` |
| Auth | `openbao` (sandbox credentials for live parity) |

Requires Node.js ≥ 22 or Bun ≥ 1.2. ESM only. MIT.
