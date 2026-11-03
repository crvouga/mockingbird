# Emulate coverage audit

Mockingbird covers the 14 public providers in [Emulate](https://emulate.dev/) and
[vercel-labs/emulate](https://github.com/vercel-labs/emulate). The comparison target is the npm
package `emulate@0.12.1`, pinned in `packages/parity/package-oracle/package.json` and `bun.lock`.
Licensed handler sources are pinned to commit `c77cb73e7ab525c5260dd36c04c91a54a23e7e75`;
`packages/http/provider/port.json` records every source path and SHA-256 digest.

The competitor is an independent test oracle. Its npm package is a development dependency of
one private parity package. Public services expose vendor APIs through Mockingbird's existing
Fetch runtime, SQLite namespaces, Timeline, clock, faults and admin controls. They do not import
Emulate's runtime, CLI, server, adapters, persistence engine or npm package. Apache-2.0 source
ports retain their attribution and license in every service that distributes them.

## Provider coverage

| Provider | Covered workflows | Implementation |
| --- | --- | --- |
| Vercel | Projects, deployments, domains, environment variables, users, teams, uploads, bypass protection, Blob, OAuth | New native service |
| GitHub | Users/orgs, repositories, branches/refs, commits/trees/content, issues/labels/milestones, pulls/reviews/merges, checks/statuses/actions, hooks, Apps/installations/tokens, OAuth | Existing service expanded |
| Google | OAuth/OIDC, RS256 JWKS, PKCE, revocation, Gmail messages/drafts/threads/labels/history/settings, Calendar events/lists/freebusy/discovery, Drive files/uploads | New native service |
| Slack | Conversations/messages/history/threads, reactions, presence/profile, teams, OAuth/installations/webhooks, files/uploads, pins/bookmarks, views/triggers | Existing service expanded |
| Apple | OAuth authorization, token exchange/refresh/revoke, discovery and JWKS | New native service |
| Microsoft | Entra authorization/token/refresh/revoke/logout, OIDC discovery/userinfo, Graph /me | New native service |
| Okta | OIDC/PKCE/JWKS, token introspection/revocation, users/lifecycle, groups/membership, applications/policies | New native service |
| AWS | Combined S3 objects/buckets/multipart/presigned uploads, SQS, IAM, STS | New combined endpoint; existing standalone services retained |
| Resend | Email/batch/idempotency/retrieval/scheduling/cancel, domains/verification, keys, contacts and inbox | Existing service expanded |
| Stripe | Customers, products/prices, checkout, payment intents, charges, customer sessions | Existing broader service; native customer sessions added |
| MongoDB Atlas | Admin v2 projects/clusters/database users, Data API CRUD/aggregation | New native service |
| Clerk | OIDC, users/email addresses/phones, organizations/memberships/invitations, sessions/tokens | New native service |
| Linear | GraphQL teams/users/issues/states/comments/labels, OAuth/PKCE | New native service |
| Twilio | Accounts/keys, numbers/applications, messaging services, messages/media, Verify services/checks, calls, conversations/participants/messages | Existing service expanded; host and path routing retained |

The pinned inventory has **734 registrations**, including inspector pages and competitor assets.
`test/coverage.test.ts` requires a supported native operation for every vendor route, comparing
method and normalized parameter templates. Font/favicon routes and root inspector pages are
classified as tooling. Emulate's synthetic Stripe checkout URLs map to Mockingbird's existing
`GET/POST /c/pay/{session}` capability; their unknown-session redirect bug is not reproduced.
The vendor customer-session endpoint is implemented directly in native Stripe state.

The exact pinned inventory is `packages/parity/package-oracle/coverage.json`. Every added route
also appears in its service's canonical `openapi.yaml`, generated exports and `SUPPORT.md`.
Operation registration alone is not evidence that every real vendor behavior is implemented.

## Ideas adopted and integration work

* Broad, stateful vendor workflows rather than isolated canned responses: OAuth grants, PKCE,
  signing keys, webhook payloads/signatures, pagination, binary transfers and SDK requests.
* Synthetic fixture configuration and a clean reset. Providers accept synthetic fixtures (Stripe retains its existing corpus controls);
  reset reapplies them, and checkpoint/branch construction reads persisted state without
  reseeding the restored database. GitHub App fixture key preparation is asynchronous and
  uses portable WebCrypto, accepting PKCS1 and PKCS8 keys.
* A separate, pinned executable oracle. Tests send requests to an npm-installed loopback
  oracle and to native Fetch services, compare statuses and response shapes, and repeat
  stateful scenarios after reset.
* Native clock injection into route helpers, OAuth expiry, timestamps, idempotency pruning
  and webhook signatures. SQLite holds token/code caches, binary values, counters, webhook
  subscriptions and delivery records; request caches are reconstructed after restore.
* Shared records across existing and added APIs: GitHub repositories/ancestry/refs/pulls and
  issue numbering; Slack conversations/users/messages/files/views and the outbox; Resend
  batches and the native email outbox; Twilio canonical and prefixed messages. Added requests are sequenced; native Resend retains concurrent in-flight idempotency conflicts.
* The portable entry and explicit Node listener stay separate. The source ports replace
  Node crypto with WebCrypto/noble hashes and declare buffer/GraphQL/Jose dependencies.

## Additional tooling ideas adopted

A second pass compared the CLI, adapters, configuration and developer workflows rather than
only vendor handlers. The useful gaps were filled in the native runtime:

| Emulate idea | Mockingbird adoption |
| --- | --- |
| Embed selected providers beneath an application's own origin | Every shared HTTP runtime now has `mount(prefix)`, returning Fetch and Next.js method handlers. No additional framework package or service runtime is needed. |
| Correct URLs in embedded OAuth flows | Trusted request metadata preserves the mount path through native namespace dispatch. Discovery, issuer/JWKS URLs, local forms, redirects, cookie paths and pagination stay under the mount; absolute callback destinations are preserved. |
| Seed configuration usable from the CLI | Thirteen provider CLIs accept `--fixtures <json>` and `--base-url`. Fleet entries accept inline `fixtures` and `baseUrl`, with explicit flags taking precedence. Stripe retains its existing corpus workflow. |
| Prepare GitHub App keys without hand-writing PEM fixtures | The native GitHub package exports `prepareFixtures`. It returns generated private keys directly to test code, excludes supplied keys, and reuses prepared identity across reset. |
| Retain generated identities through persistence | Google, Apple, Microsoft, Okta and Clerk sign with namespace-backed RSA keys. Tests restore snapshots into separate processes and compare JWKS, preventing process-global signing state from invalidating restored tokens. Reset keeps the identity stable for clients with cached JWKS. |
| Install only the providers used by the app | Already supported through independently bundled native service packages. Mounting retains this property. |
| One command for multiple services | Already supported by fleets, with atomic readiness, rollback, shutdown, private connections and coordinated native controls. |
| Request/state inspection, reset and reusable snapshots | Already supported by native admin UI, journals, SQLite and Timeline. Mounted handlers preserve those controls and their admin key checks. |

The source CLI's file persistence and framework-specific runtime wrappers were unnecessary
because native services already own SQLite state and implement Web Fetch. Generic custom
internal-service scaffolding is outside the repository's public-vendor-only emulator contract.
Portless integration and a second configuration hot-reload supervisor would add external tools
or competing lifecycle ownership; they were not adopted. JSON fixtures use the existing fleet
format without introducing a YAML configuration dialect.

## Evidence and deliberate differences

Run from the checkout; no vendor secrets, accounts or paid inference are required:

```sh
bun run --cwd packages/parity/package-oracle parity
bun run --cwd packages/parity/package-oracle test:upstream
bun run check
```

The native suite checks all 14 catalogs, per-route response probes, stateful scenarios/reset,
namespace isolation, snapshot/cache restoration, branch/historical reads, controlled timestamps,
and mixed operations. The **88 native cases** include HTTP discovery for all five OIDC providers
at ephemeral listener ports and namespace paths. A complete Google OAuth exchange verifies its
token against the advertised JWKS and checks expiry against the frozen native clock.
The adapted licensed provider suite passes **635 cases**, with **75 expected
failures retained from upstream**. Those expected failures describe upstream's known omissions;
they are not independent proof of vendor parity. The suite uses Mockingbird's SQLite-backed
models and portable handlers; a test-only Node listener supports SDK cases.

Native Stripe has richer objects and error diagnostics than the competitor, and starts each
account empty. Native GitHub errors retain their string `status` field. Native Resend lists
retain `has_more`. Native Slack retains its existing seeded files, channels and users, and its
bot/enterprise identity.
Existing authentication, API versions, fault semantics, inbound integrations, Socket Mode and
richer payment workflows are retained. These differences are intentional: exact route-specific
actual/oracle contracts are pinned in `reviewed-differences.json`, and an unreviewed change fails
the suite. They are not hidden by ignoring arbitrary status or body differences.

The added routes explicitly disable live-vendor parity metadata until independent vendor
proof exists. Their generic OpenAPI response descriptions advertise package-oracle behavior;
they are not a complete vendor schema. Opaque provider-generated identifiers and signing keys
use cryptographic randomness. Snapshots preserve persisted identifiers and token values, but the
runtime seed does not make newly generated secrets identical across independent runs.
OIDC signing keys persist in each native SQLite namespace; cross-process snapshot restores
retain the advertised JWKS, and reset retains the signing identity. Webhook completion depends on
the receiver and can finish after a request; delivery state is stored in SQLite.

## Maintenance

An upstream bump requires reviewing the npm version/integrity, source commit/digests, complete
route inventory, source/test license changes, regression expectations and reviewed differences.
Run both suites and the standard repository checks before changing a coverage claim. Keep
synthetic fixtures free of real customer data. Continue live-vendor verification through the
existing parity runners when credentials and evidence are available.
