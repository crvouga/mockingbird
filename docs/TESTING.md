# Testing and parity

How every emulator is proven to behave like its vendor: differential contracts, property-based walks, and live parity against real sandboxes.

Validation combines differential contracts, focused unit and integration tests, fuzzing, and
**property-based testing (PBT)** with [fast-check](https://fast-check.dev/). Stateful API walks are
generated from OpenAPI specs, while the database engines compare SQL behavior with real SQLite and
PostgreSQL oracles. Property failures shrink to a minimal reproduction.

Two properties, same generator:

1. **Self-parity** (CI, no credentials) — two independent emulator instances agree after every command, and every emulator response conforms to the spec.
2. **Live parity** (`bun run parity`, sandbox keys required) — the same walk against the real sandbox / test API and a fresh emulator. Responses are canonicalized (volatile ids, timestamps, tokens) then compared.

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
    baseUrl: "https://emulator.stripe.local",
    allowedHosts: ["emulator.stripe.local"],
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
Credentials load from the environment (`.env.local`); without local keys, `bun run parity:remote -- <service>` runs it on GitHub with the repo's secrets — see [docs/SECRETS.md](SECRETS.md).

```
OpenAPI spec
  → command generator (valid + invalid + missing refs)
  → random stateful walk
       ├─ emulator A  ─┐
       └─ emulator B  ─┴─ self-parity (CI)
       ├─ real sandbox ─┐
       └─ emulator          ┴─ live parity (credentials)
  → canonicalize (strip ids / timestamps / tokens)
  → structural diff; shrink on failure
```

## Live parity

| Command | Sandbox | Credential |
| --- | --- | --- |
| `bun run parity:stripe` | `https://api.stripe.com` (test mode) | `STRIPE_SECRET_KEY` (`sk_test_*`) |
| `bun run parity:junction` | `https://api.sandbox.us.junction.com` | `JUNCTION_API_KEY` (`sk_us_*` / `sk_eu_*`) |
| `bun run parity:genebygene` | staging auth + API | `GENEBYGENE_CLIENT_ID` / `_CLIENT_SECRET` |
| `bun run parity:twilio` | `https://lookups.twilio.com` (free Lookup v2 only) | `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` |
| `cd packages/service/oauth && bun run parity` | Google, Apple, Microsoft discovery/JWKS plus GitHub REST auth error | None; public, read-only metadata |
| `bun run parity:service -- <name…> \| --all \| --tier=<tier>` | each service's sandbox | `<NAME>_*` in env; reports `parity`, `diverged`, or `no credentials` per service |
| `bun run parity:remote -- <name…> \| --all \| --tier=<tier>` | each service's sandbox, on GitHub Actions | the repo's `<NAME>_*` secrets; nothing local. Dispatches the [Parity workflow](../.github/workflows/parity.yml) on the pushed branch and streams its log |
| `bun run verify:junction` | Junction sandbox | `mockingbird-junction verify`: corpus drift plus a stateful scenario; also runs daily in the [Verify workflow](../.github/workflows/verify.yml) |

### Parity tiers

Live parity spends a vendor's rate limit, so each service declares how often it may run, in its
`package.json` (`scripts/parity-tiers.ts` is the only reader):

```json
"mockingbird": { "…": "…", "parityTier": "cold" }
```

| Tier | Runs | Where |
| --- | --- | --- |
| `hot` | after each merge to `main` that changes something in the service's dependency graph | [`ci.yml`](../.github/workflows/ci.yml) → [`parity.yml`](../.github/workflows/parity.yml) |
| `warm` | on a schedule (weekly, Mondays 06:17 UTC) | `schedule:` in `parity.yml` |
| `cold` | only when dispatched by hand | `bun run parity:remote -- <service>` |

A hot service runs only when its dependency graph changed: its own package, or any workspace
package it depends on, directly or transitively (Turborepo's graph, read by
`scripts/affected.ts`). Modifying emulator A never runs emulator B; modifying `core` runs every hot
service that depends on it. Edits that cannot change a result (`*.md`, tests) are ignored. Outside
the graph, `tsconfig.base.json` (a turbo global dependency), `scripts/bundle-service*.ts`,
`scripts/parity-service.ts` and a `bun.lock` change to an external package or to the root reach every
hot service; a `bun.lock` change to one workspace's own entry reaches that service; root config,
workflows and docs reach none. A service lists files it reads beyond its graph in
`mockingbird.parityInputs` (junction: `PARITY_FAILURE_SEED_REGISTRY.json`).

A service with no `parityTier` is cold, and every service starts there. **To promote one, change
that one value** (`cold` → `warm` → `hot`); no workflow names a service. A manual run takes any
service whatever its tier, or a whole tier: `bun run parity:remote -- --tier=warm`. Hot and warm
services need their `<SERVICE>_*` secrets mapped in `parity.yml`'s `env:` first (a service without
its keys reports `no credentials`, not a pass). `bun run parity:tiers` lists every service with its
tier; `bun run check:parity-tiers` rejects a value that is not one of the three.
