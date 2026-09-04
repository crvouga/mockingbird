# mockingbird

A catalog of **stateful mock servers** for popular third-party HTTP APIs.

Each mock speaks the provider's real surface (`fetch(Request) → Response`), keeps state in **SQLite**, and is driven by a vendored OpenAPI contract. Drop one into a test process instead of hitting the network, or serve it over Node / Bun when you need a local origin.

Pass an optional `sqlite` client that matches Mockingbird's owned `SqliteClient` port, or omit it to get a fresh [`@crvouga/sqlite-mem`](https://www.npmjs.com/package/@crvouga/sqlite-mem) database. Migrations run on boot.

## Testing

**Example-based tests are banned.** No hardcoded request/response pairs, no fixture walks, no `it("creates a customer")`. Every test in this repo is a `*.property.test.ts` suite.

Validation is **property-based testing (PBT)** with [fast-check](https://fast-check.dev/): random stateful walks of API commands generated from the OpenAPI spec (valid bodies, single-constraint invalid bodies, missing ids). A property must hold for every walk. Failures shrink to a minimal reproduction.

Two properties, same generator:

1. **Self-parity** (CI, no credentials) — two independent mock instances agree after every command, and every mock response conforms to the spec.
2. **Live parity** (`bun run parity`, sandbox keys required) — the same walk against the real sandbox / test API and a fresh mock. Responses are canonicalized (volatile ids, timestamps, tokens) then compared.

```ts
import { parity } from "@crvouga/mockingbird-parity"
import { document, StripeAPI } from "@crvouga/mockingbird-service-stripe"

const now = () => 1_700_000_000_000
const create = () => new StripeAPI({ now })
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

Replay a failing walk with the seed printed in the error:

```bash
FC_SEED=12345 bun test
FC_SEED=12345 FC_NUM_RUNS=100 bun test
MOCKINGBIRD_TRACE=1 bun run parity:stripe
```

`bun test` is the property suite. `bun run parity` (and `parity:stripe` / `parity:junction` / `parity:genebygene`) is live differential against each provider's sandbox. Credentials load from env or the self-hosted Vault — see [docs/SECRETS.md](docs/SECRETS.md).

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

| Package | Provider | Docs | Status |
| --- | --- | --- | --- |
| [`@crvouga/mockingbird-service-stripe`](packages/service/stripe) | [Stripe](https://docs.stripe.com/api) | [API reference](https://docs.stripe.com/api) · [test keys](https://docs.stripe.com/keys) · [SUPPORT.md](packages/service/stripe/SUPPORT.md) | Implemented (customers, products, prices) |
| [`@crvouga/mockingbird-service-junction`](packages/service/junction) | [Junction (Vital)](https://docs.junction.com/) | [API overview](https://docs.junction.com/api-details/junction-api) · [create user](https://docs.junction.com/api-reference/user/create-user) · [get user](https://docs.junction.com/api-reference/user/get-user) · [delete user](https://docs.junction.com/api-reference/user/delete-user) · [SUPPORT.md](packages/service/junction/SUPPORT.md) · [package README](packages/service/junction/README.md) | Implemented (user CRUD) |
| [`@crvouga/mockingbird-service-genebygene`](packages/service/genebygene) | [GeneByGene](https://api.genebygene.com/swagger/index.html) | [Developer guide (PDF)](https://api.genebygene.com/assets/GxG%20API%20Services%20Developer%20Guide%202022.pdf) · [Swagger UI](https://api.genebygene.com/swagger/index.html) · [SUPPORT.md](packages/service/genebygene/SUPPORT.md) · [package README](packages/service/genebygene/README.md) | Implemented (token, products, orders) |

The umbrella package is [`@crvouga/mockingbird`](packages/facade). Granular `@crvouga/mockingbird-*` packages are the source of truth.

State lives in SQLite under a per-service namespace. Several services can share one client; `reset()` only clears that service's records and sequences.

### Live parity

| Command | Sandbox | Credential |
| --- | --- | --- |
| `bun run parity:stripe` | `https://api.stripe.com` (test mode) | `MOCKINGBIRD_STRIPE_SECRET_KEY` (`sk_test_*`) or Vault `mockingbird/stripe` |
| `bun run parity:junction` | `https://api.sandbox.us.junction.com` | `MOCKINGBIRD_JUNCTION_API_KEY` (`sk_us_*` / `sk_eu_*`) or Vault `mockingbird/junction` |
| `bun run parity:genebygene` | staging auth + API | `MOCKINGBIRD_GENEBYGENE_CLIENT_ID` / `_CLIENT_SECRET` or Vault `mockingbird/genebygene` |

## Packages

| Layer | Packages |
| --- | --- |
| Core | `core` (`FetchAPI`), `service` (Hono dispatch keyed by `operationId`) |
| Storage | `sqlite` (`SqliteClient` port, migrate runner, default `@crvouga/sqlite-mem`) |
| Contract | `openapi`, `openapi-metadata`, `openapi-arbitrary`, `openapi-codegen` |
| Parity | `commands`, `model`, `canonicalize`, `parity` (runner) |
| Services | `service-stripe`, `service-junction`, `service-genebygene` |
| Adapters | `adapter-node`, `adapter-bun` |
| Auth | `openbao` (sandbox credentials for live parity) |

## Releasing

Publishes use **npm Trusted Publishing (OIDC)** on push to `main` (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Conventional Commits are enforced on PRs. Maintainer secrets and Vault paths: [docs/SECRETS.md](docs/SECRETS.md).

```bash
bun run secrets:doctor
bun run npm:seed -- --yes          # one-time umbrella seed if missing on npm
bun run release:preflight
bun run release:publish -- --dry-run
```

Requires Node.js ≥ 22 or Bun ≥ 1.2. ESM only. MIT.
