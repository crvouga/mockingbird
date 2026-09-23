# Testing and parity

How every mock is proven to behave like its vendor: differential contracts, property-based walks, and live parity against real sandboxes.

Validation combines differential contracts, focused unit and integration tests, fuzzing, and
**property-based testing (PBT)** with [fast-check](https://fast-check.dev/). Stateful API walks are
generated from OpenAPI specs, while the database engines compare SQL behavior with real SQLite and
PostgreSQL oracles. Property failures shrink to a minimal reproduction.

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

# Junction parity accepts explicit walk parameters
bun parity -- --runs 10 --steps 10
MOCKINGBIRD_TRACE=1 bun run parity:stripe
```

`bun test` runs each package's appropriate test suite. `bun run parity` (and `parity:stripe` /
`parity:junction` / `parity:genebygene`) is live differential against each provider's sandbox.
Credentials load from env or the shared self-hosted Vault (`vault run --config prd`) — see [docs/SECRETS.md](SECRETS.md).

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

## Live parity

| Command | Sandbox | Credential |
| --- | --- | --- |
| `bun run parity:stripe` | `https://api.stripe.com` (test mode) | `MOCKINGBIRD_STRIPE_SECRET_KEY` (`sk_test_*`) or Vault `secret/personal/prd` |
| `bun run parity:junction` | `https://api.sandbox.us.junction.com` | `MOCKINGBIRD_JUNCTION_API_KEY` (`sk_us_*` / `sk_eu_*`) or Vault `secret/personal/prd` |
| `bun run parity:genebygene` | staging auth + API | `MOCKINGBIRD_GENEBYGENE_CLIENT_ID` / `_CLIENT_SECRET` or Vault `secret/personal/prd` |
| `bun run parity:twilio` | `https://lookups.twilio.com` (free Lookup v2 only) | Vault `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` |
| `cd packages/service/oauth && bun run parity` | Google, Apple, Microsoft discovery/JWKS plus GitHub REST auth error | None; public, read-only metadata |
| `bun run parity:service -- <name…> \| --all` | each service's sandbox | `MOCKINGBIRD_<NAME>_*` in env or Vault; reports `parity`, `diverged`, or `no credentials` per service |
| `bun run verify:junction` | Junction sandbox | `mockingbird-junction verify`: corpus drift plus a stateful scenario; also runs daily in the [Verify workflow](../.github/workflows/verify.yml) |
