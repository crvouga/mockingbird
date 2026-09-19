# @crvouga/mockingbird

Stateful, contract-checked mocks of third-party HTTP APIs (Stripe, Junction/Vital, GeneByGene,
Medplum) and in-memory SQL engines (PostgreSQL, SQLite) for your test process. Each HTTP mock is a
plain Fetch handler — `mock.fetch(request) → Promise<Response>` — that speaks the provider's real
surface, keeps state, and is verified against the real sandbox by differential property tests.

This package is the umbrella: it re-exports every mock plus the `mockingbird` CLI. It is also the
**integration guide for coding agents** — read this file, then the README of each provider package
you use (`node_modules/@crvouga/mockingbird-service-<provider>/README.md`).

## Install

```bash
npm install -D @crvouga/mockingbird
# or only what you need, e.g.
npm install -D @crvouga/mockingbird-service-stripe
```

Requirements: Node.js >= 22 or Bun >= 1.2, ESM only (`import`, not `require`). TypeScript types
ship with every package.

## Usage

### Scaffold with the CLI

```bash
npx mockingbird init --providers stripe,junction --dry-run   # preview
npx mockingbird init --providers stripe,junction             # writes tests/mocks/mockingbird.ts
npx mockingbird init --providers stripe --json               # machine-readable plan
```

`init` writes `tests/mocks/mockingbird.ts` (a `createMockProviders()` factory) and prints the
install command for your package manager; it does not install anything itself. Providers:
`stripe`, `junction`, `genebygene`, `medplum`.

### In-process (preferred)

Pass the mock's `fetch` wherever your code accepts one. No network, no ports, fully isolated.

```ts
import { createDefaultSqlite, JunctionAPI, StripeAPI } from "@crvouga/mockingbird"

const sqlite = createDefaultSqlite() // one in-memory DB; each service keeps its own namespace
const stripe = new StripeAPI({ sqlite, now: () => Date.UTC(2025, 0, 1) })
const junction = new JunctionAPI({ sqlite })

const created = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test_mockingbird",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ email: "qa@example.com" }),
  }),
)
const customer = (await created.json()) as { id: string }

await stripe.reset() // clears only Stripe's records; Junction's survive
```

- **Any host works.** The mock routes on method + path, so keep your production base URL.
- **Auth is enforced like the real API.** Send the provider's header (Stripe
  `authorization: Bearer sk_test_…`, Junction `x-vital-api-key`, GeneByGene a bearer token from
  its `/connect/token` endpoint) or you get the provider's own `401`.
- **State persists per instance** until `reset()`. Use a fresh instance (or `reset()`) per test.
- **Deterministic time:** pass `now` to freeze `created`-style timestamps.

### Route a whole app's `fetch`

When the code under test calls `fetch` directly, route by hostname and fall through to the
network for everything else:

```ts
import { GeneByGeneAPI, JunctionAPI, StripeAPI } from "@crvouga/mockingbird"
import type { FetchAPI } from "@crvouga/mockingbird"

const mocks: Record<string, FetchAPI> = {
  "api.stripe.com": new StripeAPI(),
  "api.sandbox.us.junction.com": new JunctionAPI(),
  "api.genebygene.com": new GeneByGeneAPI(),
}

const realFetch = globalThis.fetch
export const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init)
  const mock = mocks[new URL(request.url).hostname]
  return mock ? mock.fetch(request) : realFetch(request)
}
// Inject mockFetch into your HTTP client, or assign it to globalThis.fetch in test setup.
```

### Over HTTP

When something needs a real URL (an official SDK without a custom-fetch hook, another process, a
browser), serve the mock with an adapter:

```ts
import type { AddressInfo } from "node:net"
import { serve } from "@crvouga/mockingbird-adapter-node"
import { StripeAPI } from "@crvouga/mockingbird-service-stripe"

const server = await serve(new StripeAPI()) // node:http Server on an ephemeral port
const { port } = server.address() as AddressInfo
const baseUrl = `http://127.0.0.1:${port}` // point the SDK / app at this
// ... run tests ...
server.close()
```

On Bun use `serve` from `@crvouga/mockingbird-adapter-bun` (returns a `Bun.serve` server). Each
provider README shows how to point that provider's official SDK at the mock.

### Medplum is different

`MedplumAPI` runs the real Medplum server as a child process on embedded Postgres + Redis. Call
`await medplum.start()` before use and `await medplum.stop()` after; the first start clones and
builds Medplum (slow, cached afterwards). See `@crvouga/mockingbird-service-medplum`.

## Choosing a package

| You need | Install |
| --- | --- |
| Everything, one dependency | `@crvouga/mockingbird` |
| Stripe (customers, payment intents, subscriptions, invoices, webhooks, …) | `@crvouga/mockingbird-service-stripe` |
| Junction / Vital (users, lab tests, orders) | `@crvouga/mockingbird-service-junction` |
| GeneByGene (OAuth token, products, orders) | `@crvouga/mockingbird-service-genebygene` |
| Medplum (real FHIR server, self-hosted) | `@crvouga/mockingbird-service-medplum` |
| In-memory PostgreSQL / SQLite engine, pure TypeScript | `@crvouga/mockingbird-service-postgres` / `@crvouga/mockingbird-service-sqlite` |
| Serve any mock over HTTP | `@crvouga/mockingbird-adapter-node` / `@crvouga/mockingbird-adapter-bun` |
| Prove your own mock matches a real API (differential property tests) | `@crvouga/mockingbird-parity` |
| Build a new mock from an OpenAPI spec | `@crvouga/mockingbird-service`, `@crvouga/mockingbird-openapi` |

Granular packages are the source of truth; this package only re-exports them. Coverage per
provider (which operations are implemented) is in each package's `SUPPORT.md` on GitHub.

## For coding agents

Rules for integrating Mockingbird into a project:

1. Install as a **devDependency**. Never import mocks from production code paths.
2. Prefer in-process injection of `mock.fetch`; fall back to `serve()` only when a URL is required.
3. Create mocks in test setup, `reset()` (or recreate) between tests, and never share one instance
   across parallel test files.
4. Send the provider's real auth header and body encoding (Stripe is
   `application/x-www-form-urlencoded`; Junction and GeneByGene are JSON). A `401`/`400` from the
   mock usually means the request would fail against the real API too.
5. If an operation returns `404`/`501` unexpectedly, check that provider's `SUPPORT.md` — it may
   not be implemented yet. Do not work around it by stubbing responses by hand.
6. Every package ships types; rely on the TypeScript signatures (`dist/*.d.ts`) over guesses.

Paste this into your project's `AGENTS.md` / `CLAUDE.md` so future agents find these docs:

```md
## Third-party API mocks (Mockingbird)
Tests use Mockingbird mocks instead of real Stripe/Junction/GeneByGene/Medplum APIs.
Read node_modules/@crvouga/mockingbird/README.md first, then
node_modules/@crvouga/mockingbird-service-<provider>/README.md. Mock setup: tests/mocks/mockingbird.ts.
```

A machine-readable index of every package's docs: https://github.com/crvouga/mockingbird/blob/main/llms.txt

## API

Core contract

- `FetchAPI` (type) — `{ fetch(request: Request): Promise<Response> }`, implemented by every mock.
- `FetchHandler` (type) — `(request: Request) => Promise<Response>`.
- `toFetchHandler(api)` — `FetchAPI` → bare handler (for `Bun.serve`, workers, Deno).
- `fromFetchHandler(handler)` — bare handler → `FetchAPI`.
- `APIOptions` (type) — `{ sqlite?: SqliteClient; now?: () => number }`, accepted by the SQLite-backed mocks.

Storage (`@crvouga/mockingbird-sqlite`)

- `createDefaultSqlite()` — fresh in-memory SQLite client (pure TypeScript engine).
- `resolveSqlite(client?)` — the given client, or a new default one.
- `migrateCore(sqlite)` — create Mockingbird's core tables (mocks do this on boot).
- Types: `SqliteClient`, `SqliteStatement`, `SqliteValue`.

Stripe (`@crvouga/mockingbird-service-stripe`)

- `StripeAPI` — the mock (`new StripeAPI(options?)`, `fetch`, `reset`).
- `stripeDocument` — the vendored OpenAPI document.
- `QA_SURFACE_OPS`, `QA_TEST_CARD_TOKENS`, `QA_TEST_PAYMENT_METHODS`, `reshapeQaCommand` — QA-surface parity helpers.

Junction (`@crvouga/mockingbird-service-junction`)

- `JunctionAPI` — the mock; options add `onWebhook` / `webhook` (types `JunctionAPIOptions`, `JunctionWebhookEvent`, `JunctionWebhookOptions`, `WebhookPublisher`).
- `junctionDocument`, `junctionOperationIds`, `junctionSupportedOperationIds` — spec and operation coverage (types `JunctionOperationId`, `JunctionSupportedOperationId`).
- `JUNCTION_NAMESPACE` — SQLite namespace used by the mock.
- `AVAILABILITY_ADDRESS`, `AVAILABILITY_START_DATE`, `COVERAGE_ZIPS`, `PHLEBOTOMY_AVAILABILITY_ZIPS`, `PSC_AVAILABILITY_ZIPS`, `PSC_LAB_IDS` — fixture data the lab-testing endpoints recognise.
- `observationCacheKey`, `prefetchCoverageObservations`, `reshapeCoverageGeoCommand` — sealed-corpus / seed helpers (types `GetCacheEntry`, `SealedCorpus`, `SeedObservations`, `SeedReport`, `SeedSource`).

GeneByGene (`@crvouga/mockingbird-service-genebygene`)

- `GeneByGeneAPI` — the mock. `geneByGeneDocument` — its OpenAPI document.

Medplum (`@crvouga/mockingbird-service-medplum`)

- `MedplumAPI` — self-hosted real Medplum (`start`, `stop`, `reset`, `getBaseUrl`, `getAccessToken`); options type `MedplumAPIOptions`.
- `createMedplumAPI(options?)` — construct and start in one call.

PostgreSQL engine (`@crvouga/mockingbird-service-postgres`)

- `PostgresDatabase`, `PostgresStatement`, `PostgresSnapshot`, `PostgresError` — aliases of `Database`, `Statement`, `Snapshot`, `PostgresError`.
- Types: `PostgresBindValue`, `PostgresDatabaseOptions`, `PostgresErrorCategory`, `PostgresJsValue`, `PostgresQueryRow`, `PostgresRegisterFunctionOptions`, `PostgresResultSet`, `PostgresRunResult`.

SQLite engine (`@crvouga/mockingbird-service-sqlite`)

- `SqliteDatabase`, `SqliteDatabaseStatement`, `SqliteSnapshot`, `SqliteError` — aliases of `Database`, `Statement`, `Snapshot`, `SqliteError`.
- Types: `SqliteBindValue`, `SqliteDatabaseOptions`, `SqliteErrorCategory`, `SqliteQueryRow`, `SqliteQueryValue`, `SqliteDatabaseResultSet`, `SqliteDatabaseRunResult`.

CLI

- `mockingbird init [--providers <list>] [--dir <path>] [--package-manager bun|npm|pnpm|yarn] [--dry-run] [--json]`
- `mockingbird --help`, `mockingbird --version`

Part of [mockingbird](https://github.com/crvouga/mockingbird).
