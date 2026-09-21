# mockingbird

A catalog of **stateful test doubles** for third-party HTTP APIs and SQL databases.

Each mock speaks the provider's real surface (`fetch(Request) → Response`), keeps state in **SQLite**, and is driven by a vendored OpenAPI contract. Drop one into a test process instead of hitting the network, or serve it over Node / Bun when you need a local origin.

Pass an optional `sqlite` client that matches Mockingbird's owned `SqliteClient` port, or omit it to get a fresh [`@crvouga/mockingbird-service-sqlite`](https://www.npmjs.com/package/@crvouga/mockingbird-service-sqlite) database. Migrations run on boot.

## Using Mockingbird in your project

Only the mock services are on npm, one self-contained package each (ESM, TypeScript types
included): `@crvouga/mockingbird-service-<name>` for every entry in the [Catalog](#catalog). The
helper packages they are built from are private to this repo and bundled into each service. Every
service's README doubles as the **integration guide for coding agents** and ships inside the npm
tarball (`node_modules/<package>/README.md`); [`llms.txt`](llms.txt) is a generated index of them.

```bash
npm install -D @crvouga/mockingbird-service-stripe
```

### Serving a mock: one contract for every HTTP service

Every HTTP service ships a CLI and a Node server as well as the
in-process `fetch`, and all answer the same control surface, so a stack learns it once:

```bash
npx mockingbird-junction serve --port 8787          # one service
npx mockingbird-junction serve --config mockingbird.json   # every service in the config
```

| Surface | What it gives you |
| --- | --- |
| `mockingbird-<service> serve` · `createServer()` (`./server`) · `createRuntime()` | A listening server, from the CLI or Node, or the same thing as one runtime-neutral `fetch` |
| `GET /health` | Unauthenticated readiness probe, outside the vendor's auth gate |
| `/__admin/*` (`x-mockingbird-admin-key` optional) | Reset, snapshot/restore, clock control, fault injection, metrics with unmatched-route counts; service-specific routes on top (e.g. Junction order transitions) |
| `x-mockingbird-namespace` | Per-request isolation: parallel workers share one process without sharing data |
| `--seed`, clock control | Seeded randomness and an injectable clock, so a run replays exactly |
| `--log json` | One structured line per request: operation id, status, duration, namespace, fault |

`mockingbird.json` names services by their package suffix and takes each one's `serve` flags;
any installed service's CLI can serve all of them:

```json
{
  "services": {
    "junction": { "port": 8787, "options": { "corpus": "./test/junction-corpus.json" } },
    "stripe": { "port": 12111 }
  }
}
```

[Junction's README](packages/service/junction/README.md#the-service-contract) documents the contract
in full, including its corpus (`corpus pull`, `corpus diff`) and `verify` against the real vendor.
Medplum proxies a real Medplum server and the database engines are not HTTP APIs, so they are
outside this contract.

## Requirements

- **Node.js ≥ 22** or **Bun ≥ 1.2** (ESM only).
- npm is required for the package-integrity gates (`bunx publint`, `bunx attw`); Bun runs the rest.

Install with `bun install` (uses [workspaces](https://bun.sh/docs/install/workspaces) + [Turborepo](https://turbo.build/repo/docs/overview)). A git hook lints commit messages on the spot — see [Development](#development--quality-gates).

## Testing

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
Credentials load from env or the shared self-hosted Vault (`vault run --config prd`) — see [docs/SECRETS.md](docs/SECRETS.md).

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
| [`@crvouga/mockingbird-service-stripe`](packages/service/stripe) | [Stripe](https://docs.stripe.com/api) | [API reference](https://docs.stripe.com/api) · [test keys](https://docs.stripe.com/keys) · [SUPPORT.md](packages/service/stripe/SUPPORT.md) · [QA coverage](packages/service/stripe/docs/qa-coverage.md) | Implemented (customers, payment methods, payment intents, setup intents, charges, refunds, disputes, checkout sessions, invoices, subscriptions, coupons, promotion codes, events + webhook delivery) |
| [`@crvouga/mockingbird-service-junction`](packages/service/junction) | [Junction (Vital)](https://docs.junction.com/) | [API overview](https://docs.junction.com/api-details/junction-api) · [create user](https://docs.junction.com/api-reference/user/create-user) · [get user](https://docs.junction.com/api-reference/user/get-user) · [delete user](https://docs.junction.com/api-reference/user/delete-user) · [lab tests](https://docs.junction.com/api-reference/lab-tests) · [orders](https://docs.junction.com/api-reference/order-v3) · [SUPPORT.md](packages/service/junction/SUPPORT.md) · [QA coverage](packages/service/junction/docs/qa-coverage.md) · [package README](packages/service/junction/README.md) | Implemented (user CRUD + helpers, lab-testing) |
| [`@crvouga/mockingbird-service-genebygene`](packages/service/genebygene) | [GeneByGene](https://api.genebygene.com/swagger/index.html) | [Developer guide (PDF)](https://api.genebygene.com/assets/GxG%20API%20Services%20Developer%20Guide%202022.pdf) · [Swagger UI](https://api.genebygene.com/swagger/index.html) · [SUPPORT.md](packages/service/genebygene/SUPPORT.md) · [package README](packages/service/genebygene/README.md) | Implemented (token, products, orders) |
| [`@crvouga/mockingbird-service-medplum`](packages/service/medplum) | [Medplum](https://www.medplum.com/docs/api) | [Self-hosting: install from scratch](https://www.medplum.com/docs/self-hosting/install-from-scratch) · [package README](packages/service/medplum/README.md) | Implemented (self-hosted real server: FHIR CRUD + auth, embedded Postgres/Redis) |
| [`@crvouga/mockingbird-service-postgres`](packages/service/postgres) | PostgreSQL 18 SQL dialect | [Compatibility](packages/service/postgres/COMPATIBILITY.md) · [package README](packages/service/postgres/README.md) | Pure TypeScript, synchronous, in-memory engine with differential PostgreSQL parity suites |
| [`@crvouga/mockingbird-service-sqlite`](packages/service/sqlite) | SQLite 3 SQL dialect | [Compatibility](packages/service/sqlite/COMPATIBILITY.md) · [package README](packages/service/sqlite/README.md) | Pure TypeScript, synchronous, in-memory engine and Mockingbird's default service storage |
| [`@crvouga/mockingbird-service-aha`](packages/service/aha) | AHA at-home phlebotomy partner API: HMAC-signed create-order and cancel, raw or wrapped envelopes, idempotency keys, and the order-status webhooks (Scheduled, Check Out, …) our bloodwork handler consumes. | [README](packages/service/aha/README.md) · [SUPPORT.md](packages/service/aha/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-aws-speech`](packages/service/aws-speech) | AWS Polly (SynthesizeSpeech, StartSpeechSynthesisStream) and Transcribe (streaming over h2c, batch jobs), with exact event-stream framing and scripted transcripts. | [README](packages/service/aws-speech/README.md) · [SUPPORT.md](packages/service/aws-speech/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-bedrock`](packages/service/bedrock) | AWS Bedrock Runtime (Converse, ConverseStream, InvokeModel incl. Titan embeddings, Nova Sonic bidirectional streams over h2c) and AgentCore InvokeHarness, with exact event-stream framing. | [README](packages/service/bedrock/README.md) · [SUPPORT.md](packages/service/bedrock/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-caretalk`](packages/service/caretalk) | CareTalk's external API: client-login tokens, GetForm definitions, SavePatientForm rounds, patient search/insert, states, free slots and appointments. | [README](packages/service/caretalk/README.md) · [SUPPORT.md](packages/service/caretalk/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-customerio`](packages/service/customerio) | Customer.io: Segment-compatible CDP (identify/track/batch, SDK drop-in), App API transactional email/SMS/inbox sends with an outbox, message catalog, link-click tracking, and signed reporting webhooks. | [README](packages/service/customerio/README.md) · [SUPPORT.md](packages/service/customerio/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-daily`](packages/service/daily) | Daily.co REST API: rooms, presence, eject, meeting tokens (minted and self-signed HS256, verified and decodable), and transcription/recording webhooks with transcripts written to S3. | [README](packages/service/daily/README.md) · [SUPPORT.md](packages/service/daily/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-easypost`](packages/service/easypost) | EasyPost trackers API: create/re-use trackers, EasyPost's test tracking codes, admin status transitions and EasyPost's error envelope. | [README](packages/service/easypost/README.md) · [SUPPORT.md](packages/service/easypost/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-edamam`](packages/service/edamam) | Edamam APIs our apps call: food-database parser, nutrients and image analysis, nutrition analysis, recipe search v2, meal-planner select and shopping lists, over a built-in food and recipe corpus. | [README](packages/service/edamam/README.md) · [SUPPORT.md](packages/service/edamam/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-firstpromoter`](packages/service/firstpromoter) | FirstPromoter v2 API: promoters (adopt-before-create by cust_id), signup tracking by tid / promoter_id / ref token, iframe login, archive, and Basic-auth lead_becomes_referral webhooks. | [README](packages/service/firstpromoter/README.md) · [SUPPORT.md](packages/service/firstpromoter/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-flex`](packages/service/flex) | Flex HSA/FSA payments API: products (recorded catalog corpus), checkout sessions in payment, off-session and setup modes, customers, setup intents, refunds, the hosted checkout page, and Svix-signed webhooks. | [README](packages/service/flex/README.md) · [SUPPORT.md](packages/service/flex/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-formbricks`](packages/service/formbricks) | Formbricks (Geviti fork): client environment state seeded from our production survey clone, response creation with the fork's validation errors, the v1 management API, the widget script, and responseFinished webhooks. | [README](packages/service/formbricks/README.md) · [SUPPORT.md](packages/service/formbricks/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-fullscript`](packages/service/fullscript) | Fullscript lab-ordering API: per-practitioner OAuth, clinic, session grants, forward-only lab orders with results, lab-order events, expiring result PDFs, and Fullscript-Signature webhooks. | [README](packages/service/fullscript/README.md) · [SUPPORT.md](packages/service/fullscript/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-google-calendar`](packages/service/google-calendar) | Google Calendar v3 API and Google OAuth our EMR calls: events list/insert/update/delete/watch, channels.stop, calendarList/calendars, token exchange/refresh/revoke and userinfo, with signed-by-header push notifications. | [README](packages/service/google-calendar/README.md) · [SUPPORT.md](packages/service/google-calendar/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-google-maps`](packages/service/google-maps) | Mock of Google Places Autocomplete / Details / Find Place, the Geocoding API and a Maps JavaScript (places) shim, over a QA address corpus, with Google's status codes and fault presets. | [README](packages/service/google-maps/README.md) · [SUPPORT.md](packages/service/google-maps/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-healthie`](packages/service/healthie) | Healthie GraphQL API (legacy surface): signIn, users, currentUser, updateUser/updateClient (incl. multipart avatar), locations, documents and folders with served downloads, form answers, offerings, billing items, and the IP-allowlisted status webhooks. | [README](packages/service/healthie/README.md) · [SUPPORT.md](packages/service/healthie/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-intercom`](packages/service/intercom) | Intercom REST API 2.11: contacts (search, create with 409 on duplicates, update, get), conversations (create with Idempotency-Key, reply as JSON or multipart, close/open, get, cursor search), admins, and X-Hub-Signature-signed admin reply/close/open webhooks. | [README](packages/service/intercom/README.md) · [SUPPORT.md](packages/service/intercom/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-klaviyo`](packages/service/klaviyo) | Klaviyo events API: JSON:API event create (Ordered Product, Placed Order), event reads, unique_id dedupe, JSON:API errors and an outbox. | [README](packages/service/klaviyo/README.md) · [SUPPORT.md](packages/service/klaviyo/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-llamacloud`](packages/service/llamacloud) | LlamaCloud platform API: project and pipeline lookup, pipeline documents, and deterministic (scripted or term-overlap) retrieval, verified against the official llama_cloud_services SDK. | [README](packages/service/llamacloud/README.md) · [SUPPORT.md](packages/service/llamacloud/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-mailosaur`](packages/service/mailosaur) | Mailosaur email/SMS testing API (messages search, get, delete, long-poll) with an HTTP ingest so other mocks can drop mail in (Mockingbird service contract). | [README](packages/service/mailosaur/README.md) · [SUPPORT.md](packages/service/mailosaur/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-makor-cpg`](packages/service/makor-cpg) | legacy Makor AI (CPG) API: care plans, plus-user, bloodwork webhook, subscriptions, Wholescripts orders, AI patient summaries and async-review scripts (processing → complete on the mock clock), with permissive CORS for browser-direct calls. | [README](packages/service/makor-cpg/README.md) · [SUPPORT.md](packages/service/makor-cpg/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-odx`](packages/service/odx) | (retired) Optimal DX partner API: patients, partner links, HL7 and structured lab imports, Functional Health Reports (JSON/PDF), webhook registrations, and signed PatientTest webhooks. | [README](packages/service/odx/README.md) · [SUPPORT.md](packages/service/odx/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-otel`](packages/service/otel) | an OTLP/HTTP collector (JSON and protobuf traces and logs) and the OpenObserve search API over the same store. | [README](packages/service/otel/README.md) · [SUPPORT.md](packages/service/otel/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-payload-cms`](packages/service/payload-cms) | Payload CMS collection REST API: paginated finds with a where-query subset, find by id, a seeded marketing collection and admin-editable documents. | [README](packages/service/payload-cms/README.md) · [SUPPORT.md](packages/service/payload-cms/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-persona`](packages/service/persona) | Persona identity-verification API: inquiry create, list (reusable lookup), get, a hosted flow page, admin lifecycle transitions, and Persona-Signature webhooks. | [README](packages/service/persona/README.md) · [SUPPORT.md](packages/service/persona/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-pharmetika`](packages/service/pharmetika) | Pharmetika compounding-pharmacy provider portal: clinics, patients, medication-order validate / EPCS prepare / submit / lookup, the v7 cancel, the medication-template catalog, and status webhooks. | [README](packages/service/pharmetika/README.md) · [SUPPORT.md](packages/service/pharmetika/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-plane`](packages/service/plane) | Plane REST API v1: cursor-paginated work items, comments, links, states and labels, with Plane's rate limit and error shapes. | [README](packages/service/plane/README.md) · [SUPPORT.md](packages/service/plane/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-portal-agent`](packages/service/portal-agent) | our eRx portal agent (LifeFile/VPI browser runner): the fulfilment job endpoint with strict response rules, a job store, fault presets, and x-internal-key callbacks. | [README](packages/service/portal-agent/README.md) · [SUPPORT.md](packages/service/portal-agent/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-posthog`](packages/service/posthog) | PostHog: /flags v2 and legacy /decide evaluation with per-test flag, variant and payload control, remote config, gzip/base64 capture (/batch/, /e/, /i/v0/e/), recordings intake, and the feature-flag management and HogQL API slice. | [README](packages/service/posthog/README.md) · [SUPPORT.md](packages/service/posthog/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-prism`](packages/service/prism) | Prism Labs body-scan API: subjects, scans, presigned capture upload, processing stages to READY, and deterministic body-composition, measurement, health-report and asset results. | [README](packages/service/prism/README.md) · [SUPPORT.md](packages/service/prism/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-resend`](packages/service/resend) | Resend email API (send with idempotency, received emails, attachments) with an outbox and Svix-signed inbound webhooks (Mockingbird service contract). | [README](packages/service/resend/README.md) · [SUPPORT.md](packages/service/resend/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-rxvortex`](packages/service/rxvortex) | RxVortex (Strive) pharmacy API: OAuth token, order submit, status, cancel, recovery by sender order id, preset catalog, and signed status webhooks. | [README](packages/service/rxvortex/README.md) · [SUPPORT.md](packages/service/rxvortex/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-slack`](packages/service/slack) | Slack incoming webhooks and the Web API (chat.postMessage and friends) with an outbox of every alert the app sent. | [README](packages/service/slack/README.md) · [SUPPORT.md](packages/service/slack/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-twilio`](packages/service/twilio) | Twilio Verify, Lookup v2, Messaging and Recordings on one port, with signed inbound SMS and voice webhooks (Mockingbird service contract). | [README](packages/service/twilio/README.md) · [SUPPORT.md](packages/service/twilio/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-vpi`](packages/service/vpi) | VPI compounding pharmacy API: JWT authentication, products, clinic, patients, providers, saveNewPrescription drafts and the three paged prescription status lists. | [README](packages/service/vpi/README.md) · [SUPPORT.md](packages/service/vpi/SUPPORT.md) | Implemented |
| [`@crvouga/mockingbird-service-wholescripts`](packages/service/wholescripts) | Wholescripts supplement fulfilment API: product and private-label catalogs, order submit, status polling and cancel, with admin status transitions. | [README](packages/service/wholescripts/README.md) · [SUPPORT.md](packages/service/wholescripts/SUPPORT.md) | Implemented |

To add a vendor mock, follow [docs/AUTHORING_A_SERVICE.md](docs/AUTHORING_A_SERVICE.md) (reference: [`service-rxvortex`](packages/service/rxvortex)). [docs/CATALOG_COVERAGE.md](docs/CATALOG_COVERAGE.md) maps the vendor catalog to these packages, with each one's evidence and findings.

State lives in SQLite under a per-service namespace. Several services can share one client; `reset()` only clears that service's records and sequences.

Exception: [`@crvouga/mockingbird-service-medplum`](packages/service/medplum) self-hosts the real Medplum server as a child process (one-time cached clone + build) with embedded Postgres and Redis on ephemeral ports — it does not use the SQLite layer.

### Live parity

| Command | Sandbox | Credential |
| --- | --- | --- |
| `bun run parity:stripe` | `https://api.stripe.com` (test mode) | `MOCKINGBIRD_STRIPE_SECRET_KEY` (`sk_test_*`) or Vault `secret/personal/prd` |
| `bun run parity:junction` | `https://api.sandbox.us.junction.com` | `MOCKINGBIRD_JUNCTION_API_KEY` (`sk_us_*` / `sk_eu_*`) or Vault `secret/personal/prd` |
| `bun run parity:genebygene` | staging auth + API | `MOCKINGBIRD_GENEBYGENE_CLIENT_ID` / `_CLIENT_SECRET` or Vault `secret/personal/prd` |
| `bun run parity:twilio` | `https://lookups.twilio.com` (free Lookup v2 only) | Vault `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` |
| `bun run parity:service -- <name…> \| --all` | each service's sandbox | `MOCKINGBIRD_<NAME>_*` in env or Vault; reports `parity`, `diverged`, or `no credentials` per service |
| `bun run verify:junction` | Junction sandbox | `mockingbird-junction verify`: corpus drift plus a stateful scenario; also runs daily in the [Verify workflow](.github/workflows/verify.yml) |

## Packages

**Naming (hard rule):** every package is `@crvouga/mockingbird-<kebab-case>`; the short names below drop that prefix. `bun run check:boundaries` fails CI on any other name.

**Publishing (hard rule):** only mock services (`service-<name>`) are published. Every other package is `"private": true`; a service that uses them builds with [`scripts/bundle-service.ts`](scripts/bundle-service.ts), which inlines them (JavaScript and `.d.ts`) so the tarball needs nothing unpublished. `bun run check:boundaries` fails CI on a public non-service package.

| Layer | Packages | Published |
| --- | --- | --- |
| Services | `service-stripe`, `service-junction`, `service-genebygene`, `service-medplum`, `service-postgres`, `service-sqlite`, and every vendor mock in the [Catalog](#catalog) | yes |
| Core | `core` (`FetchAPI`), `service` (Hono dispatch keyed by `operationId`) | bundled |
| Storage | `sqlite` (`SqliteClient` port, migrate runner, default `@crvouga/mockingbird-service-sqlite`) | bundled |
| Contract | `openapi`, `openapi-metadata`, `openapi-arbitrary`, `openapi-codegen` | bundled / build tool |
| Parity | `commands`, `model`, `canonicalize`, `parity` (runner) | bundled / tests |
| Adapters | `adapter-node`, `adapter-bun` | tests only |
| Auth | `openbao` (sandbox credentials for live parity) | tests only |

## Development & quality gates

Every merge-blocking check is a single command you can run locally. `bun run check` runs the whole turbo graph; `bun run check:full` replicates CI end-to-end (install + commitlint + check) without the network-only release job.

CI is one turbo graph: the `Check` job runs `bun run check` with `node_modules` in the GitHub Actions cache and task outputs in the shared self-hosted **Turborepo remote cache** (`https://turborepo.chrisvouga.dev`), so a PR only rebuilds and retests the packages it changed, and the release job replays build/pack results instead of rebuilding. Local runs share the same cache: root turbo scripts run under `vault run` ([`scripts/vault-run.ts`](scripts/vault-run.ts)), which injects `TURBO_*` from Vault. CI gets them through Vault GitHub OIDC — no stored token. Setup: [docs/SECRETS.md](docs/SECRETS.md).

```bash
bun install            # workspaces + generates dist
bun run check          # every gate below, in parallel, cached by turbo
bun run check:full     # mirrors .github/workflows/ci.yml (local CI replica)
```

| Gate | Command | What it enforces |
| --- | --- | --- |
| Format | `bun run check:format` | [Biome](https://biomejs.dev) formatting |
| Lint | `bun run lint` | Biome lint (types, style, complexity) |
| Typecheck | `bun run typecheck` | `tsc` for every package |
| Boundaries | `bun run check:boundaries` | Intra-workspace dep graph: internal deps resolve, no cycles, no self-deps, every module import is declared in `package.json`, only mock services are published, and no published package depends on an unpublished one at runtime |
| Package integrity | `bun run pack:check` | `dist` + `exports` + `files`, tarball contents, [publint](https://publint.dev), [arethetypeswrong](https://arethetypeswrong.github.io) (ESM-only consumer resolution) |
| Portability | `bun run portability` | Built `dist` matches the package's `mockingbird.runtime` (portable / node / bun) — no Node/Bun-only API usage where it isn't allowed |
| Generate & OpenAPI | `bun run generate` / `bun run openapi:check` | Regenerate and verify provider contracts |
| Test | `bun run test` | Contract, integration, unit, fuzz, and property suites (`FC_NUM_RUNS=40` in CI) |
| Consumer docs | `bun run pack:check` | Every public package ships a README with `## Install`, `## Usage` (a TypeScript example) and `## API` listing every runtime export |
| Consumer smoke | `bun run release:smoke` | Packs every public package like the release, `npm install`s the tarballs into a clean project, imports every entry point under Node, and typechecks them plus every README TypeScript example |
| llms.txt | `bun run check:llms` | [`llms.txt`](llms.txt) lists every published mock service (`bun run llms:sync` regenerates) |
| Agent commands | `bun run check:agents` | Every `.agents/commands/*.md` is symlinked into each agent harness (`bun run agents:sync` repairs) |

### Git hooks (Husky)

[`commit-msg`](.husky/commit-msg) runs [commitlint](https://commitlint.js.org) via `bunx` for **every commit**, so Conventional Commits are enforced before they reach a PR. Disable hooks per-repo with `HUSKY=0` in `package.json` scripts, or bypass a single commit with `git commit --no-verify` (not recommended).

Keep the committed hook file in `.husky/commit-msg` — the generated `.husky/_` shims are gitignored and are produced by the `prepare` script (`husky`) on install.

### Trunk & PR workflow

`main` is the only long-lived branch. Every change lands through a PR that targets `main`, and
only merge commits are allowed (squash and rebase are disabled). Head branches are deleted on
merge, and the aggregate `Required` job (Commitlint + Check + the trunk policy) is the required
status check, with no bypass actors. PRs use the minimal template in
`.github/pull_request_template.md`. The gate is codified in `scripts/pr-merge.ts`:

```bash
bun run pr:merge repo                            # verify merge settings / auto-delete / auto-merge
bun run pr:merge repo --apply
bun run pr:merge ruleset                         # verify the `Protect main` ruleset
bun run pr:merge ruleset --apply
```

### Agent commands

Agent commands are written once in [`.agents/commands/`](.agents/commands) and symlinked into every
harness — `.claude/commands`, `.cursor/commands`, `.opencode/command`, `.windsurf/workflows`,
`.github/prompts` (Copilot), and `.agents/skills/<name>/SKILL.md` (Codex / Agent Skills). Edit the
canonical file; `bun run agents:sync` creates missing links and `bun run check:agents` (part of
`bun run check`) fails CI on drift.

`/pr-merge` takes the current branch all the way to a merged PR: commit, push, merge `origin/main`,
resolve conflicts, open the PR, fix every failing check (CI and third-party checks such as
GitGuardian), then merge automatically once everything is green.

### Package publishing

Published services use `publishConfig.access = "public"` and `publishConfig.provenance = true` (npm Trusted Publishing / OIDC). `bun run pack:check` is the pre-publish gate that confirms each package actually packs, resolves types for an ESM-only consumer, and ships `dist`.

## Releasing

Releases are fully automated on every green push to `main` ([`scripts/release/`](scripts/release/lib.ts), job `Release` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). There is nothing to run by hand:

- **Which packages:** every published service with a releasable Conventional Commit since its last `<name>@<version>` git tag — in its own directory or in any private helper it bundles — every service that has never been released, and every service that depends at runtime on one of those (workspace deps are pinned exactly).
- **Which version:** `feat!` / `BREAKING CHANGE` → major, `feat` → minor, `fix` / `perf` / `revert` / `refactor` / `build` / `docs` → patch, dependency-only → patch. `test` / `ci` / `chore` / `style` never release a package on their own. First releases start at `0.1.0`.
- **How:** build → `pack:check` → `portability` → consumer smoke → `bun pm pack` → `npm publish --provenance` via npm Trusted Publishing (OIDC) → push the `<name>@<version>` tag → GitHub Release with that package's notes.

Versions live in tags, so `package.json` keeps `0.0.0-development` and nothing is committed back to `main` (same model as semantic-release). Every step is idempotent — re-running a failed release job finishes it.

OIDC cannot create a package that does not exist on npm yet. With the optional `NPM_TOKEN` Actions secret set, the release job creates new packages with it and attaches their Trusted Publisher automatically (`npm trust github`); without it, seed them once with `bun run release:seed`. The seed reconciles npm with `origin/main` (logs in to npm if needed, builds a clean `origin/main` in a temporary worktree, publishes every missing service, attaches Trusted Publishers, pushes tags and GitHub Releases, and deprecates every package no longer published). See [docs/SECRETS.md](docs/SECRETS.md).

```bash
bun run release:plan                   # what the next push to main would release
bun run release:publish -- --dry-run   # plan + pack every tarball, no side effects
bun run release:seed                   # reconcile npm with origin/main using your npm login
bun run secrets:doctor                 # npm / Trusted Publishing / NPM_TOKEN status
```

Every release (and the seed) deprecates npm packages this repo no longer publishes: the former helper packages (`@crvouga/mockingbird`, `-core`, `-service`, `-sqlite`, `-openapi*`, `-http-codec`, `-commands`, `-model`, `-canonicalize`, `-parity`, `-adapter-*`, `-openbao`), now bundled into the services, and the archived `@crvouga/postgres-mem` / `@crvouga/sqlite-mem`, which continue here as `@crvouga/mockingbird-service-postgres` / `-sqlite`. Deprecating needs account auth (`NPM_TOKEN` or the seed); OIDC alone only logs what it would deprecate.

Local replica of the whole CI (minus the main-only release job): `bun run check:full`.

MIT.
