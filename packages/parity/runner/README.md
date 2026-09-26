# @crvouga/mockingbird-parity

> **Internal package — not published to npm.** Mockingbird publishes only its mock services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

Differential property-based test runner. From an OpenAPI spec it generates random stateful API walks with [fast-check](https://fast-check.dev/), runs every command against a "real" side and a fresh mock, canonicalizes both responses (ids, timestamps and tokens), and fails with a shrunk, replayable reproduction on the first divergence. Use it to prove a mock behaves like the real API (**live parity**, needs sandbox credentials) or like an independent instance of itself while conforming to the spec (**self-parity**, runs in CI with no network). This is the entry point of the parity packages; you rarely need the lower-level ones directly.

## Install

```bash
npm install -D @crvouga/mockingbird-parity
```

`fast-check` 4.x ships as a dependency. You also need a mock to test: anything with `fetch(request: Request): Promise<Response>` — for example a Mockingbird service such as `@crvouga/mockingbird-service-stripe` (`StripeAPI` + its `document` spec). ESM only, Node >= 22 or Bun >= 1.2; works inside `bun test`, Vitest or a plain script.

## Usage

Self-parity with a tiny inline spec and mock (swap in `document` and `new StripeAPI()` from a Mockingbird service to test a real one):

```ts
import { parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { parity } from "@crvouga/mockingbird-parity"

// The contract, annotated with x-mockingbird-* extensions (see @crvouga/mockingbird-openapi-metadata).
const note = {
  type: "object",
  required: ["id", "text", "created"],
  properties: {
    id: { type: "string", "x-mockingbird-resource": { type: "note", identity: true } },
    text: { type: "string" },
    created: { type: "integer", "x-mockingbird-volatile": { kind: "timestamp" } },
  },
}
const json = (schema: object) => ({ description: "response", content: { "application/json": { schema } } })
const spec = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "notes", version: "1" },
  paths: {
    "/notes": {
      post: {
        operationId: "createNote",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                additionalProperties: false,
                properties: { text: { type: "string", maxLength: 20 } },
              },
            },
          },
        },
        responses: { "200": json(note), "400": json({ type: "object" }) },
      },
    },
    "/notes/{note}": {
      get: {
        operationId: "getNote",
        parameters: [
          {
            name: "note",
            in: "path",
            required: true,
            schema: { type: "string" },
            "x-mockingbird-resource-ref": { type: "note" },
          },
        ],
        responses: { "200": json(note), "404": json({ type: "object" }) },
      },
    },
  },
})

// The mock under test.
class NotesAPI {
  private notes = new Map<string, { id: string; text: string; created: number }>()
  reset() {
    this.notes.clear()
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/notes") {
      const body: unknown = await request.json().catch(() => null)
      const keys = typeof body === "object" && body !== null ? Object.keys(body) : []
      const text = (body as { text?: unknown } | null)?.text
      if (typeof text !== "string" || [...text].length > 20 || keys.length !== 1)
        return Response.json({ error: "invalid" }, { status: 400 })
      const created = { id: `note_${this.notes.size + 1}`, text, created: Date.now() }
      this.notes.set(created.id, created)
      return Response.json(created)
    }
    const match = /^\/notes\/([^/]+)$/.exec(url.pathname)
    const found = match ? this.notes.get(decodeURIComponent(match[1] ?? "")) : undefined
    return request.method === "GET" && found
      ? Response.json(found)
      : Response.json({ error: "not found" }, { status: 404 })
  }
}

// "real" is a long-lived reference instance; the mock side gets a fresh instance per walk.
const reference = new NotesAPI()
const report = await parity({
  provider: "notes",
  spec,
  real: {
    baseUrl: "https://mock.notes.local",
    allowedHosts: ["mock.notes.local"],
    fetch: (request) => reference.fetch(request),
  },
  mock: { create: () => new NotesAPI() },
  cleanup: async () => reference.reset(), // walks must be independent
  env: process.env, // honour FC_SEED / FC_NUM_RUNS / MOCKINGBIRD_MAX_COMMANDS / MOCKINGBIRD_TRACE
  latencyToleranceMs: 1_000, // both sides are in-process: don't fail on scheduler noise
  sleep: async () => {}, // skip the clock-skew gap between walks (~3 s each) when nothing is remote
  log: () => {},
})
console.log(report.walks, report.exercised) // 25 { createNote: ..., getNote: ... }
```

For **live parity**, point `real` at the provider's sandbox and let the runner use global `fetch`:

```text
real: {
  baseUrl: "https://api.stripe.com",
  allowedHosts: ["api.stripe.com"],               // anything else is refused before sending
  headers: () => ({ authorization: `Bearer ${key}` }),
  minIntervalMs: 40,                              // rate-limit spacing
},
mock: { create: () => new StripeAPI(), headers: () => ({ authorization: "Bearer sk_test_x" }) },
redact: createRedactor(credentials.secrets),      // from @crvouga/mockingbird-credentials
cleanup: async ({ table, real }) => { /* delete table.all() real ids via real.fetch */ },
```

Replay a failure with the seed printed in the error: `FC_SEED=12345 bun test` (requires `env: process.env`).

## How a walk runs

1. `planOperations` picks operations that are `supported`, `parity.enabled` and (unless `includeUnsafe`) `parity.safe`, filtered by `only` / extended by `forceInclude`.
2. fast-check generates up to `maxCommands` commands per walk (`numRuns` walks). References are symbolic (`note #1`) and resolved to each side's own ids; ~15% of bodies are invalid by one constraint.
3. For each command: send to real, then to mock. Unless `validateMock: false`, the mock's status must be declared and its body must validate against the response schema. New ids at `x-mockingbird-resource` locations are paired. Both exchanges are canonicalized and structurally diffed (status, declared parity headers, body).
4. After each walk: optional webhook comparison, then `cleanup`. On failure fast-check shrinks the walk (unless `shrink: false`) and the runner throws.

## Failures

`parity` throws a `ParityError` whose message starts with `✗ <provider> parity FAILED (seed N, FC_SEED=N to replay)`, followed by fast-check's minimal counterexample and the formatted failure (command, history, differences). `error.details.kind` is one of:

| kind | Meaning |
| --- | --- |
| `mismatch` | Canonical real and mock exchanges differ; `details.differences` lists them. |
| `mock-conformance` | Mock returned an undeclared status or a body that violates the spec; `details.problems`. |
| `real-transport` / `mock-transport` | A side's `fetch` threw; `details.cause`. |
| `latency` | The mock was not faster than the real side by `latencyToleranceMs` (`mockMs >= realMs + latencyToleranceMs`). |
| `webhook-mismatch` | Collected webhook events differ (only with `webhooks`). |

Other errors (host not allowed, no parity-enabled operations, bad env integers) are thrown as plain `Error` / `RangeError`.

## `ParityOptions`

| Option | Default | Description |
| --- | --- | --- |
| `provider` | required | Label used in logs, errors and the default mock URL. |
| `spec` | required | `OpenAPIDocument` (e.g. from `parseOpenAPIDocument`). |
| `real` | required | `RealTarget`: `baseUrl`; `allowedHosts` (host incl. port must be listed, and the URL must be `https:` unless the host ends in `.local` or is `localhost` / `127.0.0.1`); `headers?` (sync or async, added to every request); `fetch?` (default global `fetch`); `minIntervalMs?` (default 0). |
| `mock` | required | `MockTarget`: `create()` returns a fresh `FetchAPI` per walk (sync or async); `baseUrl?` (default `https://mock.<provider>.local`); `headers?`. |
| `numRuns` | `FC_NUM_RUNS` or `DEFAULT_PROPERTY_RUNS` (25) | Walks. |
| `maxCommands` | `MOCKINGBIRD_MAX_COMMANDS` or `DEFAULT_PARITY_STEPS` (30) | Max commands per walk. |
| `seed` | `FC_SEED` or `Date.now()`-based | fast-check seed. |
| `env` | `{}` | Where the env vars above and `MOCKINGBIRD_TRACE=1\|true` (per-request trace) are read. **`process.env` is not read unless you pass it.** Explicit options win over env. |
| `runId` | derived from seed | Value for `x-mockingbird-scope: run-id`. |
| `includeUnsafe` | `false` | Also generate `parity.safe: false` operations. |
| `only` | all | Restrict to these operationIds. |
| `forceInclude` | none | Include these operationIds even if `parity.enabled: false` or unsafe. |
| `cleanup` | none | `WalkCleanup`: `({ table, real: { fetch, baseUrl }, scope, webhookEvents? }) => Promise<void>` after every walk; `real.fetch` adds `real.headers`. Use it to delete real resources or reset a reference mock. |
| `validateMock` | `true` | Validate mock responses against the spec. |
| `redact` | identity | `(text) => string` applied to failure reports and traces. |
| `clockSkewSeconds` | `2` | Subtracted from the walk start for `walk-start-unix`; walks are also spaced by this + 1s (via `sleep`). |
| `log` | `console.log` | Progress lines. Pass `() => {}` to silence. |
| `now`, `sleep` | `Date.now`, `setTimeout` | Injected clock/sleep (tests). |
| `invalidProbability` | `0.15` | Chance a generated body is invalid. |
| `missingProbability` | `0.08` | Chance a reference is a nonexistent id. |
| `shrink` | `true` | Shrink failing walks (costs extra real requests). |
| `weights` | none | Relative weight per operationId (unlisted = 1). |
| `coverageBias` | `1` (off) | Multiplier for operations not yet exercised. |
| `deletedRefProbability` | `0.15` | Chance a reference may target a resource marked deleted. |
| `deletionTypes` | `{}` | operationId -> resource types to mark deleted after it runs. |
| `timeLimitMs` | none | Stop starting new walks after this long; finished walks still count. |
| `webhooks` | none | `beforeWalk(scope)` snapshots the receiver, `collectMock(mock, scope)` returns expected events, and `collectReal(scope, mockEvents)` waits for delivery. `compare(real, mock, table)` can normalize provider IDs and timing; without it events are compared by exact JSON and order. Webhook comparison runs only after the API walk succeeds. |
| `latencyToleranceMs` | `0` | Mock may be at most this much slower than real. **Set it (e.g. `1000`) for self-parity**, where both sides are in-process. |

Returns `ParityReport`: `{ provider, seed, walks, operations, exercised: Record<operationId, count>, planned: string[] }`.

## `seedParity`

`seedParity(options: SeedParityOptions)` is seed-then-walk parity for APIs whose state cannot be created from scratch on the mock: per walk it runs `warmupCommands` (default 15) against the real side only, records GET (and area/psc/availability) responses in an observation cache keyed by `observationCacheKey`, calls your `seedMock({ mock, real, table, getCache, history })` to import that state into the fresh mock, then compares `compareCommands` (default `maxCommands`) commands in lockstep. Extra options on top of `ParityOptions`: `explore` (`"dynamic"` default, re-weights each step with `weightFn`, default `defaultDynamicWeight` from `@crvouga/mockingbird-commands`; or `"static"` fast-check commands), `weightFn`, `reshapeCommand(command, state, rng)`, `prefetchObservations({ real, table, getCache, history })`, and the required `seedMock`. The `real` target passed to `seedMock` / `prefetchObservations` is a `Target` whose `fetch` does **not** add auth headers — call `await real.headers()` yourself. In `dynamic` mode the property input is a salt, so failures replay by seed but the walk itself is not shrunk.

## API

| Export | Signature | Description |
| --- | --- | --- |
| `parity` | `(options: ParityOptions) => Promise<ParityReport>` | Run differential walks; throws `ParityError` on divergence. |
| `seedParity` | `(options: SeedParityOptions) => Promise<ParityReport>` | Warm up real, seed mock, then compare (see above). |
| `ParityError` | `class extends Error { details: FailureDetails }` | The failure; `details.kind` as in the table above. |
| `formatReport` | `(report: ParityReport) => string` | The `✓ <provider> parity passed: ...` summary line. |
| `formatFailure` | `(details: FailureDetails, redact: Redactor) => string` | Multi-line failure text used as the `ParityError` message. |
| `redactHeaders` | `(headers, redact) => Record<string, string>` | Replace `authorization`, `x-api-key`, `api-key`, `cookie`, `set-cookie`, `x-vital-api-key` with `<redacted>` and run `redact` over the rest. |
| `redactValue` | `(value, redact) => unknown` | Deep-apply `redact` to strings; bytes become `<N bytes>`. |
| `executeCommand` | `(context: ExecutionContext, command: LogicalCommand) => Promise<StepOutcome>` | One lockstep real+mock step (the building block of `parity`). |
| `executeWarmupCommand` | `(context, command) => Promise<WarmupOutcome>` | One real-only step that registers identities as identical on both sides (used by `seedParity`). |
| `observationCacheKey` | `(request: ConcreteRequest, body?) => string` | `"<METHOD> <path>?<sorted query>"` plus `" <JSON body>"` when given; the key format of `getCache`. |
| `requestBodyForCacheKey` | `(request: ConcreteRequest) => unknown` | Parsed JSON body (or raw text) for `observationCacheKey`. |
| `DEFAULT_PROPERTY_RUNS` | `25` | Default walks per property. |
| `DEFAULT_PARITY_STEPS` | `30` | Default commands per walk. |

Exported types: `ParityOptions`, `ParityReport`, `RealTarget`, `MockTarget`, `WalkCleanup`, `SeedParityOptions`, `SeedCacheEntry` (`{ status, headers, body }`), `ExecutionContext`, `Target` (`{ baseUrl, fetch, headers }`), `FetchLike`, `StepOutcome`, `WarmupOutcome`, `Redactor`, `FailureDetails`, `CommandContext`, `MismatchDetails`, `ConformanceDetails`, `TransportDetails`, `WebhookDetails`.

## Related

- [`@crvouga/mockingbird-openapi-metadata`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi-metadata) — the `x-mockingbird-*` annotations your spec needs.
- [`@crvouga/mockingbird-credentials`](https://github.com/crvouga/mockingbird/tree/main/packages/auth/credentials) — load sandbox credentials and build `redact`.
- Lower level: [`@crvouga/mockingbird-commands`](https://www.npmjs.com/package/@crvouga/mockingbird-commands), [`@crvouga/mockingbird-canonicalize`](https://www.npmjs.com/package/@crvouga/mockingbird-canonicalize), [`@crvouga/mockingbird-model`](https://www.npmjs.com/package/@crvouga/mockingbird-model), [`@crvouga/mockingbird-openapi`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi).

Part of [mockingbird](https://github.com/crvouga/mockingbird).
