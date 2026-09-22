# Authoring a Mockingbird service

How to add a vendor mock to this repo. The reference implementation is
[`packages/service/rxvortex`](../packages/service/rxvortex): copy its layout and patterns.

## Layout

```
packages/service/<name>/
  package.json            # @crvouga/mockingbird-service-<name>, bin mockingbird-<name>
  tsconfig.json           # includes src, test, *.test.ts
  tsconfig.build.json
  openapi.yaml            # the vendor contract, with x-mockingbird annotations
  SUPPORT.md              # generated (bun run generate)
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
  <name>.sdk.test.ts        # the vendor's official SDK pointed at the mock (when one exists)
```

## The service contract (what `@crvouga/mockingbird-service` gives you)

`createRuntime({ name, document, create, … })` wraps your API class in the standard contract:

| Contract item | How |
| --- | --- |
| `GET /health`, `/__admin/*`, reset, snapshots, clock, metrics (with unmatched paths), journal (`GET /__admin/requests`), `x-mockingbird` response header | automatic |
| Namespaces by header | automatic (`x-mockingbird-namespace`) |
| Namespaces by path prefix | automatic: `/ns/<name>/…` is stripped and selects `<name>` |
| Namespaces by credential | pass `credential: (request) => string \| undefined` (`bearerToken`, `basicAuth(r)?.username`, `sigV4AccessKeyId`, or your own); suites map credentials with `PUT /__admin/credentials {"credentials": {"<cred>": "<ns>"}}` |
| Fault injection | automatic (`POST /__admin/faults {operationId?, method?, pathPrefix?, status?, body?, count?, rate?, latencyMs?, drop?, effect?}`) |
| Fault presets | pass `presets: Record<string, FaultPreset>`; `POST /__admin/faults {"preset": "name", "count"?: n}`, `GET /__admin/faults/presets` |
| Vendor misbehaviour a canned response can't express | a preset rule with `effect: "<name>"`; the handler checks `faultEffect(request, "<name>")` |
| Socket drop ("unknown outcome") | a rule with `drop: true` (in-process `fetch` rejects with `TypeError`; served mock destroys the socket) |
| Outbound webhooks | `createWebhookHub({ signer, endpoints, retryDelaysMs?, fetch? })` passed as `webhooks:`; adds `/__admin/webhooks`, `/webhooks/events`, `/webhooks/:id/replay`, `/webhooks/flush`, `/webhooks/faults`, `/webhook-endpoints`; presets can carry `webhook: {mode: duplicate\|reorder\|drop}`. Signers: `signers.svix()`, `signers.timestamped(header)`, `signers.twilio()`, `signers.header(name, fmt)`, `signers.custom(fn)`; primitives `hmac`, `signSvix`, `signTimestamped`, `signTwilio`. Timestamps are wall clock. |
| Outbox (comms vendors) | `OutboxStore` in your state + `outboxAdminRoutes(runtime, (api) => api.outbox, filter?)` → `GET /__admin/outbox?to=&since=`; `extractLinks(html)`, `extractCodes(text, len)` |
| Idempotency keys | `IdempotencyStore.run(key, requestFingerprint(method, path, body), {mismatch, conflict}, handler)` |
| Request-body validation against your contract | `bodyIssues(context)` → `[{path, message}]`; `issuesByField(issues)` for Laravel-style `errors` |
| Write an object into the stack's S3 (s3rver) | `putObject({endpoint, bucket}, key, body, contentType)` (SigV4) |

Handlers are keyed by `operationId` (`defineOperations<SupportedOperationId>({...})`). Use
`Collection` for records (so reset/snapshot cover them), `IdSequence` for deterministic ids, the
injected `now` for every timestamp (the mock clock), and `annotateResponse(res, {ids})` to put
touched resource ids in the journal.

**Journal and logging policy:** never store request bodies that contain prompts, message text,
PHI or card data. Record metadata only. The state you keep should also be the minimum the vendor
would echo back.

## The contract file (`openapi.yaml`)

- Use the vendor's published spec when there is one (trim to what our consumer calls); otherwise
  hand-author it from the consumer's wire shapes. Declare **every status the mock can return**
  per operation (self-parity validates every mock response against the spec).
- Request schemas are both the mock's validation rules and the parity generator's input: keep
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
   must agree after every command, with every mock response conforming to the spec. Assert that
   the walks exercised **every** parity-enabled operation. Add a "deliberately divergent instance
   is caught" test.
2. **Acceptance** (`<name>.acceptance.test.ts`): every acceptance bullet in the catalog section,
   driven through `test/consumer.ts` — a faithful port of **our** consumer's client code from
   `~/geviti-monorepo` (read-only): the same requests, headers, field fallbacks, error extraction
   and status interpretation, and for webhooks the receiver's verification (signature scheme,
   tolerance) and field reads. Where the catalog and the consumer code disagree, follow the code
   and note the discrepancy in a test comment.
3. **SDK drop-in** (`<name>.sdk.test.ts`), when the consumer uses an official SDK: install the
   exact version our consumer pins and point it at the mock (base URL / endpoint override /
   custom fetch). Signature verification with the vendor's own verifier (`stripe.webhooks
   .constructEvent`, `svix`'s `Webhook.verify`, `twilio.validateRequest`) beats a re-implementation.
4. **Contract/runtime**: `/health`, namespace isolation (header, `/ns/` prefix, credential),
   presets (each one named in the catalog), webhook signing verified with an independent HMAC
   (`node:crypto`), journal holds no bodies.
5. **Served over HTTP**: start `createServer()`, hit it with plain `fetch`, receive a webhook on a
   `Bun.serve` sink.
6. **Live parity** (`scripts/parity.ts`, `"parity": "bun scripts/parity.ts"`): load
   `MOCKINGBIRD_<NAME>_*` credentials with `loadCredentials` (env or Vault `secret/personal/prd`);
   without them print which keys are missing and `process.exit(2)`. Run only safe operations by
   default. Never print secret values; never send real messages, charges or orders to real people.

Use `fcParameters(process.env)` so `FC_SEED` / `FC_NUM_RUNS` replay failures, and keep each test
file under ~60 s.

## Docs

`README.md` must start `# @crvouga/mockingbird-service-<name>` and contain `## Install`,
`## Usage` (with a ```ts example), and `## API` listing **every runtime export** of every entry
point (pack-check enforces this). Also document: how to point the app at it (env vars), routes,
webhooks, admin routes, presets, namespace carriers, and a **Deliberately not modelled** section.

The docs site (`sites/docs`, `bun docs`) is built from the package itself: the README is the
service page, the contract gives the operations list and coverage, and the built module runs in
the page's playground. It reads these fields from the `mockingbird` block of `package.json`, and
its build fails when they are missing or stale:

| Field | Required | Meaning |
| --- | --- | --- |
| `category` | yes | A slug from `sites/docs/src/lib/categories.ts`, e.g. `"payments"` |
| `displayName` | yes | The vendor's name as people write it, e.g. `"Customer.io"` |
| `status` | yes | Release tier: `"wip"` until the mock is complete and verified, then `"ready"`. The site badges, filters and counts services by it |
| `playground.headers` | no | Credentials in the format the mock accepts (e.g. `sk_test_…`), sent with every playground request. The build sends every sample request to a fresh mock and fails if none succeed with them |
| `playground.basicAuth` | no | `"user:pass"` for mocks that take HTTP Basic auth; the build sends it as `authorization: Basic <base64>`. Use it instead of a literal `Basic …` header, which secret scanners flag |
| `playground.operation` | no | The operation the playground opens on; it must succeed with its sample request |

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
example owns its mock instances, so repeated launches and different examples stay isolated.

The OAuth example is a complete reference: `app.ts` runs Hono plus `oauth4webapi` and the
actual OAuth mock through a local Fetch dispatcher; `transport.ts` handles virtual cookies
and redirects; `index.ts` keeps the app in its own sandboxed frame and opens a separate provider popup
(with a dialog fallback when popups are blocked). Provider HTML forms use the same transport;
the callback closes the provider surface and updates the app. Its application and transport modules run unchanged in
Bun or a browser. No network listeners, fetch monkey patches, service workers, or real
provider accounts are required. The small cookie jar models the example's two fixed HTTPS
origins; it is not a general browser cookie-policy implementation.

Browser Fetch also strips forbidden `Cookie`/`Set-Cookie` headers from synthetic objects.
The reference example therefore uses an explicit local header envelope for cookies and
origin, with no global Fetch patches. The OAuth mock's optional `cookieHeaders` setting
supports this envelope; normal HTTP mode continues to use standard headers.
