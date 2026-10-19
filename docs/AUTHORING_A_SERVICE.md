# Authoring a Mockingbird service

How to add a vendor emulator to this repo. The reference implementation is
[`packages/service/rxvortex`](../packages/service/rxvortex): copy its layout and patterns.

## Layout

```
packages/service/<name>/
  package.json            # @crvouga/mockingbird-service-<name>, bin mockingbird-<name>
  tsconfig.json           # includes src, test, *.test.ts
  tsconfig.build.json
  openapi.yaml            # the vendor contract, with x-mockingbird annotations
  SUPPORT.md              # generated (bun run generate)
  DISCOVERY.md            # generated installed-package index for agents and tooling
  README.md               # the consumer/agent integration guide (see "Docs")
  src/
    generated/openapi.ts  # generated (bun run generate)
    index.ts              # <Name>API class (FetchAPI) + public exports
    runtime.ts            # createRuntime: presets, admin routes, webhooks, credential carrier
    server.ts             # createServer, serveTarget, DEFAULT_PORT (Node only)
    cli.ts                # mockingbird-<name> serve
    state.ts, …           # Collections, lifecycle, fixtures
  test/consumer.ts        # port of OUR consumer's client logic (the acceptance oracle)
  scripts/parity.ts       # live parity against the real sandbox (exits 2 without credentials)
  <name>.property.test.ts   # self-parity + divergence detection
  <name>.acceptance.test.ts # catalog acceptance criteria, through test/consumer.ts
  <name>.sdk.test.ts        # the vendor's official SDK pointed at the emulator (when one exists)
```

## The service contract (what `@crvouga/mockingbird-service` gives you)

`createRuntime({ name, document, create, … })` wraps your API class in the standard contract:

Every Mockingbird HTTP extension lives under one reserved prefix, default `/__admin`.
Set `adminPrefix` on any emulator's `createRuntime` / `createServer`, or use
`serve --admin-prefix /_control/emulator` (`MOCKINGBIRD_ADMIN_PREFIX`). It moves health,
admin APIs, UI, signed emulator downloads, and namespace base URLs together. Prefixes
are absolute non-root paths of literal letters, digits, underscores and hyphens,
without a trailing slash. The runtime rejects declared vendor routes that overlap
the chosen literal tree; choose another prefix to resolve a collision. Vendor catch-all
roots (such as S3 `/{bucket}/{key}`) dispatch after the reserved internal tree: the
prefix is never a vendor resource name. Change the prefix if a test needs that name.
All other paths belong to the vendor. `/health` and `/ns/<name>` have no compatibility aliases.

Service admin routes are relative (`GET /settings`), never mounted separately.
Signed transport stand-ins may declare `x-mockingbird-internal: true` on an OpenAPI
path under `/__admin/blobs/`; the runtime relocates it with the prefix while retaining
its signature authentication, faults, logging and vendor response shape. Never put
Mockingbird-specific paths into the vendor contract without that annotation.

| Contract item | How |
| --- | --- |
| `GET /__admin/health`, `/__admin/*`, reset, snapshots, Timeline checkpoints/branches, clock, latency, metrics (with unmatched paths), journal (`GET /__admin/requests`), `x-mockingbird` response header | automatic. The user-facing guide is [Admin controls](ADMIN_CONTROLS.md), with a page per control in `docs/admin-controls/`; `ADMIN_ROUTE_REFERENCE`, `CONTROL_HEADER_REFERENCE` and `ADMIN_CONTROL_PAGES` are the lists, and a test fails when a page misses a route or a header, or shows an example the runtime does not answer that way. |
| Boot controls (`adminControls`), control headers (`x-mockingbird-time`, `-fault`, `-delay`, …) | automatic once your `createRuntime` forwards `adminControls` beside `adminKey` and `seed`, and your `./server` forwards `common.adminControls`. `packages/service/conformance` boots every emulator with them and fails when one does not. |
| Generated ids that differ per boot (`--id-base`, `MOCKINGBIRD_ID_BASE`, a fleet `idBase`) | automatic: the CLI and fleet call `runtime.setIdBase` on the runtime your `serveTarget.create` returns, and `IdSequence` honors it. Ids you derive some other way, without an `IdSequence`, do not. |
| Boot settings (`--settings`, `MOCKINGBIRD_SETTINGS`, a fleet entry's `settings`) | opt in. If the service has a settings document, give `serveTarget` a `parseSettings(raw)` that validates and returns it (throwing a message that names the bad field), and forward `common.settings` to your runtime's `settings` option. Without `parseSettings` the flag is refused. |
| Determinism | read time only from the `clock` (`now: clock.now`) and randomness only from the `rng` in the instance context. Both are per namespace, restored by a snapshot and rewound by reset. In an admin route use `runtime.namespaceClock(namespace)`, never `runtime.clock`, which is the base clock every namespace follows. If your service keeps a schedule (renewals, expiries, session sweeps), pass `onClockChange: (namespace) => …` and run it there: it is called whenever a namespace's clock is moved by a control, so what came due is seen at once. Conformance boots each emulator twice from one seed and compares the state. Key material that must be random is the only exception; list the emulator in `CRYPTOGRAPHIC_BOOT_STATE` with the reason. |
| State introspection | automatic. `GET /__admin/state` lists every collection: ones you declare with `state:`, every `Collection` hanging off the instance, and every name already stored. `POST /__admin/state/:collection` with `{ id?, value }` creates a row; `PUT` replaces, `PATCH` shallow-merges an object, `DELETE` removes it. A successful write checkpoints `main`. The same view is `runtime.state(namespace?)`. |
| Admin UI | automatic at `GET /__admin/ui` (the HTML shell is not behind the admin key; `/__admin/ui/manifest` and the data routes are). Pass `adminUi.panels` to add a view (`id`, `title`, `html`, optional `script` called as `(root, api) => void`). Pass `adminUi.render({ service, defaultHtml })` to replace the document; call `defaultHtml()` to keep the shared shell. [`packages/service/plane`](../packages/service/plane) is the bespoke-panel example. |
| Namespaces by header | automatic (`x-mockingbird-namespace`) |
| Namespaces by path prefix | automatic: `/__admin/ns/<name>/…` is stripped and selects `<name>` |
| Namespaces by credential | pass `credential: (request) => string \| undefined` (`bearerToken`, `basicAuth(r)?.username`, `sigV4AccessKeyId`, or your own); suites map credentials with `PUT /__admin/credentials {"credentials": {"<cred>": "<ns>"}}` |
| Fault injection | automatic (`POST /__admin/faults`): match on `operationId`, `method`, `path`, `pathPrefix`, `pathPattern`, `requestHeaders`, `query`, `requestBody`; schedule with `after`, `every`, `count`, `rate`, `from`, `until`; act with `status`, `body`, `headers`, `delay`, `jitter`, `timeout`, `drop`, `truncate`, `effect` |
| Fault presets | every emulator has the standard ones (`rate_limited`, `unavailable`, `timeout`, …). Pass `presets: Record<string, FaultPreset>` to add your vendor's failure modes, and reuse a standard name to give it the vendor's own error body; `POST /__admin/faults {"preset": "name", "count"?: n}`, `GET /__admin/faults/presets` |
| Vendor misbehaviour a canned response can't express | a preset rule with `effect: "<name>"`; the handler checks `faultEffect(request, "<name>")` |
| Socket drop ("unknown outcome") | a rule with `drop: true`, or `timeout: "30s"` to hold the request first (in-process `fetch` rejects with `TypeError`; served emulator destroys the socket) |
| Outbound webhooks | `createWebhookHub({ signer, endpoints, retryDelaysMs?, fetch? })` passed as `webhooks:`; adds `/__admin/webhooks`, `/webhooks/events`, `/webhooks/:id/replay`, `/webhooks/flush`, `/webhooks/faults`, `/webhook-endpoints`; presets can carry `webhook: {mode: duplicate\|reorder\|drop}`. Signers: `signers.svix()`, `signers.timestamped(header)`, `signers.twilio()`, `signers.header(name, fmt)`, `signers.custom(fn)`; primitives `hmac`, `signSvix`, `signTimestamped`, `signTwilio`. Timestamps are wall clock. |
| Outbox (comms vendors) | `OutboxStore` in your state + `outboxAdminRoutes(runtime, (api) => api.outbox, filter?)` → `GET /__admin/outbox?to=&since=`; `extractLinks(html)`, `extractCodes(text, len)` |
| Idempotency keys | `IdempotencyStore.run(key, requestFingerprint(method, path, body), {mismatch, conflict}, handler)` |
| Request-body validation against your contract | `bodyIssues(context)` → `[{path, message, kind}]`; `issuesByField(issues)` for Laravel-style `errors`; `unsupportedMediaType(context)` for the vendor's `415` when a body's `content-type` is missing or not in the contract (never reported as "body required") |
| Rejections in the log and journal | automatic: an entry with status ≥ 400 that the emulator produced itself (not a fault) carries `request: {contentType, bodyBytes, transferEncoding}` (byte count from `content-length`, `null` for a streamed body) and the `issues` `bodyIssues` found, never the body |
| Write an object into the stack's S3 (s3rver) | `putObject({endpoint, bucket}, key, body, contentType)` (SigV4) |

Handlers are keyed by `operationId` (`defineOperations<SupportedOperationId>({...})`). Use
`createRuntime` returns a `MockSurface`. Extra methods (`tick`, a typed webhook hub, account
directories) stay on the value; removing a shared member fails the typecheck.
`packages/service/conformance` imports every HTTP emulator's `createRuntime` and checks it is
`(options?: MockCreateOptions) => MockSurface`, then probes `/__admin/health`, `/__admin`, `/__admin/ui`,
and `/__admin/state`, then the admin controls at boot, over `/__admin` and in request headers, and
that two boots from one seed hold the same state. A new emulator has to be added there. `defineMock` is the same check for a
runtime you build by hand. Service admin routes add keys beside the standard ones; a standard key
keeps the shared handler.

`Collection` for all durable or externally observable records (so reset and Timeline history cover
them), `IdSequence` for deterministic ids, the injected `now` for every timestamp (the emulator clock),
and `annotateResponse(res, {ids})` to put touched resource ids in the journal. `Timeline` is the
only permitted history/branch/checkpoint coordinator. Never add a provider-local snapshot map or
rollback manager; use `withNamespaceRollback` for asynchronous atomic work that cannot stay inside
a SQLite transaction. `bun run check:boundaries` rejects raw snapshot coordination in providers.

**Journal and logging policy:** never store request bodies that contain prompts, message text,
PHI or card data. Record metadata only. The state you keep should also be the minimum the vendor
would echo back.

## The contract file (`openapi.yaml`)

- Use the vendor's published spec when there is one (trim to what our consumer calls); otherwise
  hand-author it from the consumer's wire shapes. Declare **every status the emulator can return**
  per operation (self-parity validates every emulator response against the spec).
- Request schemas are both the emulator's validation rules and the parity generator's input: keep
  them as permissive as the real vendor (don't invent tight patterns our consumer would violate),
  but constrained enough that generated bodies are meaningful.
- Annotate: `x-mockingbird-resource {type, identity: true}` on ids the API returns,
  `x-mockingbird-resource-ref {type, missing}` on ids a request references,
  `x-mockingbird-volatile {kind: id|timestamp|token|url|opaque}` on nondeterministic fields,
  `x-mockingbird: {parity: {safe: false}}` on operations with real-world side effects (sends,
  charges), `x-mockingbird: {supported: false, reason}` for what you deliberately skip.
- Non-JSON surfaces (HTML pages, JS shims, event streams, binary audio) are still operations in
  the spec; give them a plain `text/html` / `application/octet-stream` response and, if random
  walks can't meaningfully exercise them, `parity: {enabled: false, reason}`.
- `bun run openapi:check` validates; `bun run generate` writes `src/generated/openapi.ts` and
  `SUPPORT.md`.

## Proof: the tests every service ships

1. **Self-parity** (`<name>.property.test.ts`): two independent instances run the same random
   OpenAPI-driven walks (`parity()` from `@crvouga/mockingbird-parity`, `includeUnsafe: true`) and
   must agree after every command, with every emulator response conforming to the spec. Assert that
   the walks exercised **every** parity-enabled operation. Add a "deliberately divergent instance
   is caught" test.
2. **Acceptance** (`<name>.acceptance.test.ts`): every behaviour the service request asks for,
   driven through `test/consumer.ts` — a faithful port of the consuming app's client code: the
   same requests, headers, field fallbacks, error extraction and status interpretation, and for
   webhooks the receiver's verification (signature scheme, tolerance) and field reads. Where the
   request and the consumer code disagree, follow the code and note the discrepancy in a test
   comment.
3. **SDK drop-in** (`<name>.sdk.test.ts`), when the consumer uses an official SDK: install the
   exact version our consumer pins and point it at the emulator (base URL / endpoint override /
   custom fetch). Signature verification with the vendor's own verifier (`stripe.webhooks
   .constructEvent`, `svix`'s `Webhook.verify`, `twilio.validateRequest`) beats a re-implementation.
4. **Contract/runtime**: `/__admin/health`, namespace isolation (header, `/__admin/ns/` prefix, credential),
   presets (each one named in the catalog), webhook signing verified with an independent HMAC
   (`node:crypto`), journal holds no bodies.
5. **Served over HTTP**: start `createServer()`, hit it with plain `fetch`, receive a webhook on a
   `Bun.serve` sink.
6. **Live parity** (`scripts/parity.ts`, `"parity": "bun scripts/parity.ts"`): load
   `<NAME>_*` credentials with `loadCredentials` (from the environment: `.env.local`, or the repo's
   `<NAME>_*` secrets in the Parity workflow);
   without them print which keys are missing and `process.exit(2)`. Run only safe operations by
   default. Never print secret values; never send real messages, charges or orders to real people.
   Declare `"parityTier": "cold"` in the package's `mockingbird` block (see
   [Parity tiers](TESTING.md#parity-tiers)); a new service starts cold.

Use `fcParameters(process.env)` so `FC_SEED` / `FC_NUM_RUNS` replay failures, and keep each test
file under ~60 s.

## Docs

`README.md` must start `# @crvouga/mockingbird-service-<name>`, then a blank line, then the
shared epigraph `EPIGRAPH` from `sites/docs/src/lib/content.ts` (pack-check prints the exact
line). It must also contain `## Install`, `## Usage` (with a ```ts example), and `## API`
listing **every runtime export** of every entry point. Also document: how to point the app at
it (env vars), routes, webhooks, admin routes, presets, namespace carriers, and a **Deliberately
not modelled** section.

Examples show the application's code, not the emulator's. Call the vendor through its official
SDK, the way the application already does, and keep Mockingbird to the setup lines that point
that SDK at the emulator: inject `(url, init) => emulator.fetch(new Request(url, init))` where the
SDK accepts a fetch implementation or HTTP client, otherwise pass `createServer().url` as its base
URL or endpoint. Where the vendor publishes no JS SDK, use plain `fetch` against `server.url`.
Never call `runtime.fetch(new Request(...))` as if it were application code. Admin routes, seeds
and presets have no SDK equivalent; group them as test setup, apart from the application's calls.
Run every example before committing it, and add any package it imports to `README_SDKS` in
`scripts/release/consumer-smoke.ts`, which type-checks every ```ts block in every README.

The docs site (`sites/docs`, `bun docs`) is built from the package itself: the README is the
service page, the contract gives the operations list and coverage, and the built module runs in
the page's playground. It reads these fields from the `mockingbird` block of `package.json`, and
its build fails when they are missing or stale:

Every published service also declares `mockingbird.discovery` in `package.json` and ships every
file it names. Run `bun run service:discovery` at the repository root after adding or renaming a
service. It generates `DISCOVERY.md`, records the behavior guide, exact capability evidence,
contract, public types, oracle command, runtime introspection surfaces, and reporting contract,
and adds those artifacts to the npm tarball. `bun run check:service-discovery` and `pack:check`
fail closed if the index is stale, references a missing file, or an artifact is not packed.

| Field | Required | Meaning |
| --- | --- | --- |
| `category` | yes | A slug from `sites/docs/src/lib/categories.ts`, e.g. `"payments"` |
| `displayName` | yes | The vendor's name as people write it, e.g. `"Customer.io"` |
| `vendor.website` | yes | The vendor's homepage, e.g. `"https://stripe.com"` |
| `vendor.docs` | no | The vendor API reference the emulator follows |
| `vendor.name` | no | The vendor's name when it differs from `displayName` (LlamaCloud is made by LlamaIndex) |
| `vendor.description` | no | One line about the vendor; overrides the description fetched from its homepage |
| `vendor.icon` / `vendor.logo` / `vendor.color` | no | Force a [Simple Icons](https://simpleicons.org) slug (`false` skips it), a logo URL, or a brand color, when the fetched ones are wrong |
| `parity` | yes | A short statement, at most 80 characters, of the vendor surface this emulator keeps in step, e.g. `"Payments, billing, and webhooks"`. The site, the README, `llms.txt` and `catalog.json` show it verbatim |
| `playground.headers` | no | Credentials in the format the emulator accepts (e.g. `sk_test_…`), sent with every playground request. The build sends every sample request to a fresh emulator and fails if none succeed with them |
| `playground.basicAuth` | no | `"user:pass"` for emulators that take HTTP Basic auth; the build sends it as `authorization: Basic <base64>`. Use it instead of a literal `Basic …` header, which secret scanners flag |
| `playground.operation` | no | The operation the playground opens on; it must succeed with its sample request |

After adding or editing `vendor`, run `bun run brands:sync`. It fetches the vendor's logo, brand
color and description into `sites/docs/src/data/brands.json` and `sites/docs/public/brands/`, which
the site reads; `bun run check:brands` fails while they are stale. `bun run brands:sync -- --all
--links` refreshes every vendor and checks that each website and docs link still answers.

The docs site publishes that record at `/brands.json`. Every admin shell fetches it when the page
opens (logo, website, vendor API reference, and the service's page on this site). The emulator bundles
do not contain it, so a docs deploy updates the chip in admins that are already published.

Also add the package to `sites/docs/package.json` `devDependencies` (`"workspace:*"`) so turbo
builds it before the site.

## Commands (run inside the package directory only)

```bash
bun run openapi:check && bun run generate
bunx tsc -p tsconfig.json --noEmit
bunx biome check --write .          # this package only — never at the repo root
bun run build && bun run pack:check && bun run portability
bun test
```

## Bespoke interactive examples

A service can attach any number of interactive examples to its docs page through
`mockingbird.examples` in its `package.json`. Keep the implementation in that service's
`examples/` directory:

```json
{
  "mockingbird": {
    "examples": [{
      "id": "google-login",
      "title": "Try a complete Google login",
      "description": "An app, its Hono server, and the OAuth provider run in one tab.",
      "entry": "examples/google-login/index.ts",
      "sources": ["examples/google-login/app.ts", "examples/google-login/index.ts"]
    }]
  }
}
```

IDs must be unique within the service and use kebab-case. Entry and source files must
exist inside `examples/`; the catalog rejects missing files and path escapes. Omitting
`sources` displays the entry file. Entries export `mount(host: HTMLElement)`, optionally
async, returning a cleanup function (or nothing). Keep module imports free of DOM side
effects; only `mount` should access the DOM. Release listeners and local state on cleanup.
Add `examples` to the service's typecheck includes and declare its dependencies normally.

The docs render a launch button, lazy-load the component, and display highlighted source
files. Example metadata also appears in `/catalog.json`. Use native accessible controls,
respect the docs theme, and scope styles to the component (Shadow DOM works well). The
example owns its emulator instances, so repeated launches and different examples stay isolated.

The OAuth example is a complete reference: `app.ts` runs Hono plus `oauth4webapi` and the
actual OAuth emulator through a local Fetch dispatcher; `transport.ts` handles virtual cookies
and redirects; `index.ts` pastes the app and provider HTML into the page and opens a separate provider window
(with a dialog fallback when popups are blocked). Provider HTML forms use the same transport;
the callback closes the provider surface and updates the app. Its application and transport modules run unchanged in
Bun or a browser. No network listeners, fetch monkey patches, service workers, or real
provider accounts are required. The small cookie jar models the example's two fixed HTTPS
origins; it is not a general browser cookie-policy implementation.

Browser Fetch also strips forbidden `Cookie`/`Set-Cookie` headers from synthetic objects.
The reference example therefore uses an explicit local header envelope for cookies and
origin, with no global Fetch patches. The OAuth emulator's optional `cookieHeaders` setting
supports this envelope; normal HTTP mode continues to use standard headers.
