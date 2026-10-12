# @crvouga/mockingbird-service-oauth

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A stateful OAuth 2.0 / OpenID Connect identity sandbox. Google, Apple, Microsoft and GitHub wire profiles share a vendor-neutral account chooser, signup and consent UI. Generic OIDC works with other configurable identity clients. Uses real RS256 signatures, discovery, JWKS, authorization codes, S256 PKCE, refresh tokens and revocation.

## Install

```sh
npm install @crvouga/mockingbird-service-oauth
```

## Usage

```ts
import * as oauth from "oauth4webapi"
import { createRuntime } from "@crvouga/mockingbird-service-oauth"

// Test setup: the identity provider, its test accounts and your registered client.
const identity = createRuntime({
  provider: "google", // "apple", "microsoft", "github" or "oidc"
  accounts: [
    { id: "ada", email: "ada@example.test", name: "Ada Lovelace" },
    { id: "grace", email: "grace@example.test", name: "Grace Hopper" },
  ],
  clients: [{
    id: "my-app",
    name: "My application",
    secret: "local-test-client-secret",
    redirectUris: ["http://localhost:3000/auth/callback"],
  }],
})

// Application code: the OIDC client it already uses (here oauth4webapi). Only its fetch
// changes: requests reach the emulator in this process instead of the real issuer.
const issuer = new URL("https://identity.test")
const options = {
  [oauth.customFetch]: (url: string, init: RequestInit) => identity.fetch(new Request(url, init)),
}
const as = await oauth.processDiscoveryResponse(
  issuer,
  await oauth.discoveryRequest(issuer, options),
)
console.log(as.authorization_endpoint, as.token_endpoint, as.jwks_uri)

// The same interface can be mounted in Bun, Deno, a worker or an HTTP adapter.
// Browser execution needs a secure context for Web Crypto.
const fetchHandler = (request: Request) => identity.fetch(request)
void fetchHandler
```

Serve from Node (also works in Bun):

```ts
import * as oauth from "oauth4webapi"
import { createServer } from "@crvouga/mockingbird-service-oauth/server"

const server = await createServer({ port: 8810, provider: "apple" })
// Register clients and seed accounts through /__admin, or pass them to createServer.

// Application code: its OIDC client, with the issuer set to server.url.
const issuer = new URL(server.url)
const as = await oauth.processDiscoveryResponse(
  issuer,
  // oauth4webapi requires HTTPS unless allowInsecureRequests is set; loopback needs it.
  await oauth.discoveryRequest(issuer, { [oauth.allowInsecureRequests]: true }),
)
console.log(as.authorization_endpoint) // http://127.0.0.1:8810/auth/authorize
await server.close()
```

```sh
npx mockingbird-oauth serve --provider google --port 8810
```

### Point an app at the emulator

Override the authorization, token, userinfo and JWKS endpoints in your application's OAuth provider configuration. Set its expected issuer to the emulator's public base URL. Discovery is at `/.well-known/openid-configuration` for OIDC profiles; GitHub uses explicit OAuth endpoints and does not issue ID tokens. Register the **exact** callback URL (including scheme, port, path and query); wildcard callbacks are not accepted. No outgoing requests to a vendor occur.

| Profile | Authorization | Token | JWKS | Userinfo |
| --- | --- | --- | --- | --- |
| `google` | `/o/oauth2/v2/auth` | `/token` | `/oauth2/v3/certs` | `/v1/userinfo` |
| `apple` | `/auth/authorize` | `/auth/token` | `/auth/keys` | None, as with Apple |
| `microsoft` | `/oauth2/v2.0/authorize` | `/oauth2/v2.0/token` | `/discovery/v2.0/keys` | `/oidc/userinfo` |
| `github` | `/login/oauth/authorize` | `/login/oauth/access_token` | Not an OIDC provider | `/user`, `/user/emails` |
| `oidc` | `/authorize` | `/token` | `/jwks` | `/userinfo` |

`/authorize`, `/token`, `/jwks`, `/revoke` are common aliases. Google also accepts `/o/oauth2/auth` and `/oauth2/v3/userinfo`; Apple revocation is `/auth/revoke`. Token and revocation requests use `application/x-www-form-urlencoded`. Token client authentication supports Basic, body credentials, and public clients. Public clients must use S256 PKCE; confidential clients can opt in with `requirePkce: true`. Google emulator client secrets are fixture strings configured on the client. Apple clients can use either a fixture string or `apple: { teamId, keyId, publicKey }`, where `publicKey` is an EC P-256 public JWK. In JWT mode the emulator verifies the ES256 signature, key ID, team, subject, Apple audience, issue/expiry times and maximum lifetime. The application can keep generating its usual Apple client-secret JWTs with the corresponding test private key.

For example, an Auth.js-style OIDC provider can use `type: "oidc"`, `issuer: "http://localhost:8810"`, `clientId`, `clientSecret`, and `checks: ["pkce", "state"]`. For existing Google/Apple presets, override **all** remote endpoints and issuer validation; changing the authorization URL alone is insufficient. In-process HTTP clients can route requests to `identity.fetch`. Browser navigation must reach a served emulator or a service worker that routes those requests.

The issuer defaults to the incoming origin (and `/__admin/ns/<name>` when used). Set `issuer` to the public URL behind a reverse proxy; it may include a mount path. Avoid a fixed issuer shared across namespaces: use the namespace URL and its own discovery/JWKS so each namespace remains an independent issuer.

### Multiple providers on one listener

`createMultiRuntime({ mounts })` and `createMultiServer({ mounts })` mount independent providers at exact paths on one origin. Discovery, endpoint URLs, token issuers, signing keys, clients, grants, sessions, faults, journals, and namespace state remain isolated per mount.

```ts
import * as oauth from "oauth4webapi"
import { createMultiServer } from "@crvouga/mockingbird-service-oauth/server"

const accounts = [{ id: "ada", name: "Ada Lovelace", email: "ada@example.test" }]
const clients = [
  { id: "app", name: "Example app", redirectUris: ["http://localhost:3000/callback"] },
]
const server = await createMultiServer({
  mounts: [
    { path: "/google", provider: "google", clients, accounts },
    { path: "/apple", provider: "apple", clients, accounts },
    { path: "/oauth2", provider: "microsoft", clients, accounts },
  ],
})

// Application code: each mount is its own issuer for the app's OIDC client.
const google = new URL(`${server.url}/google`)
const as = await oauth.processDiscoveryResponse(
  google,
  await oauth.discoveryRequest(google, { [oauth.allowInsecureRequests]: true }),
)
console.log(as.token_endpoint) // http://127.0.0.1:<port>/google/token
await server.close()
```

Use `/__admin/ns/<name>/<mount>/…` for URL-selected namespaces. `GET /__admin/health` reports every mount; `POST /__admin/reset?all=1` resets them atomically. Other aggregate admin requests select a runtime with `?mount=/google`, while mount-scoped controls are also available at `/google/__admin/*`. Duplicate or unsafe mount paths, duplicate explicit issuers, and duplicate client/key IDs within a mount fail before the listener starts.

For the CLI, put the same `mounts` array in a JSON file and run `npx mockingbird-oauth serve --mounts oauth-mounts.json --port 8810`.

### Accounts and signup

The chooser displays seeded, enabled test accounts. Choosing an account opens explicit consent (Google skips it when that account already granted every requested scope to the client; `prompt=consent` or a new scope asks again); creating an account validates the email/name, rejects duplicate email addresses, persists the identity and opens the same consent flow. This is intentionally passwordless test identity selection; never use real passwords or personal data.

```sh
curl http://localhost:8810/__admin/clients -H 'content-type: application/json' \
  -d '{"id":"app","name":"Example app","secret":"fixture-secret","redirectUris":["http://localhost:3000/callback"]}'
curl http://localhost:8810/__admin/accounts -H 'content-type: application/json' \
  -d '{"id":"ada","email":"ada@example.test","name":"Ada Lovelace"}'
curl http://localhost:8810/__admin/accounts
```

Set `adminKey` (CLI `--admin-key`) to require `x-mockingbird-admin-key`. Programmatically, `runtime.instance().seedAccount(account)` inserts or updates a stable subject; `registerClient(client)` inserts or updates a client. Accounts support `emailVerified`, `picture`, `givenName`, `familyName`, `locale`, `hostedDomain`, `privateEmail`, `relayEmail`, `omitEmail`, `omitName` and `disabled`. Apple fixtures also accept `realUserStatus` (`0`, `1`, or `2`) and `transferSub` for risk and app-transfer claim tests. Microsoft fixtures accept `preferredUsername`, `tenantId`, `objectId`; GitHub fixtures accept `github: { id, login, publicEmail, emails }`. An email-list entry contains `email`, `primary`, `verified` and `visibility` (`public`, `private` or `null`).

### Test hooks on the interaction pages

The chooser, signup, consent, redirect handoff, `form_post` and error pages carry stable `data-testid` hooks, so a UI
suite (Playwright's `getByTestId`, a driver that selects only by test id) can drive them without CSS
classes or visible copy. The ids are part of the documented surface and do not change between versions.
Each page has exactly one root (the page's card), and every interactive element has its own id.

| Page | Element | `data-testid` |
| --- | --- | --- |
| chooser | page root | `oauth-mock-chooser` |
| chooser | one wrapper per account (shared id, with `data-account-id` and `data-email`) | `oauth-mock-account` |
| chooser | each account's button, unique per account | `oauth-mock-account-<account id>` |
| chooser | "Create a new account" | `oauth-mock-create-account` |
| chooser | "Choose an available account" error (`role="alert"`) | `oauth-mock-chooser-error` |
| chooser, signup, consent | cancel / deny button | `oauth-mock-deny` |
| signup | page root | `oauth-mock-signup` |
| signup | full name / email inputs | `oauth-mock-signup-name`, `oauth-mock-signup-email` |
| signup | submit button | `oauth-mock-signup-submit` |
| signup | validation or duplicate-email error (`role="alert"`) | `oauth-mock-signup-error` |
| consent | page root | `oauth-mock-consent` |
| consent | Allow button | `oauth-mock-allow` |
| consent (Apple, default `emailMode: "choose"`) | Share / Hide My Email radios | `oauth-mock-share-email`, `oauth-mock-hide-email` |
| redirect handoff | page root | `oauth-mock-redirect` |
| redirect handoff | no-JavaScript Continue link | `oauth-mock-redirect-continue` |
| `form_post` | page root (the hand-off page) | `oauth-mock-form-post` |
| `form_post` | no-JavaScript Continue button inside the `#callback` form | `oauth-mock-form-post-continue` |
| expired or unknown sign-in | page root | `oauth-mock-error` |

`<account id>` is HTML-escaped. A driver that runs no page scripts finishes Sign in with Apple by
tapping `oauth-mock-form-post-continue`; with scripts, the page submits the form itself.

### Fidelity and lifecycle

- Authorization-code flow with exact redirect matching, including explicitly registered private-use URI schemes for native apps, state and nonce; duplicate parameters rejected. Invalid clients/callbacks never redirect. Public native clients require S256 PKCE.
- Real RSA-2048 / RS256 ID tokens and independent public JWKS; correct issuer, audience, expiry, auth time and scope-filtered claims. Keys remain stable until explicitly rotated.
- Codes expire after 5 minutes and are consumed atomically, including concurrent PKCE redemption. Access/ID tokens last 1 hour. Generic OIDC refresh tokens default to 30 days; Microsoft defaults to 90 days. Apple/Google refresh tokens have no fixed deadline by default; Google inactivity, testing mode and issuance limits still apply. GitHub OAuth app access tokens have no fixed deadline in the emulator. The injected emulator clock controls expiry.
- Google `access_type=offline` issues refresh tokens on first consent or `prompt=consent`; generic/Microsoft `offline_access` and Apple issue refresh tokens. Refresh cannot expand scopes. Revocation invalidates related access and refresh tokens; unknown tokens succeed idempotently. Refresh tokens are reusable by default; Microsoft returns a replacement without invalidating the old token. Opt-in strict rotation detects reuse and revokes the token family.
- `prompt=none` returns `login_required` or `consent_required`; `login`, `consent`, `select_account`, `login_hint` and `max_age` are supported. HttpOnly, SameSite=Lax browser sessions last 24 hours. Cancel returns `access_denied` with state.
- Apple supports `code id_token`, `c_hash`, `form_post` with an automatic POST and a no-JavaScript Continue button, string `email_verified` / `is_private_email`, no userinfo endpoint, and first-consent-only `user` data. `name` / `email` scopes require `form_post`.
- Semantic server-rendered HTML needs no frontend framework, hydration, external fonts, images or network assets. Native forms, labelled fields, visible focus rings, a skip link, error announcements, responsive layout, reduced-motion preference and automatic system light/dark colors are included.

### Reproducible provider edge cases

Behavioral randomness is **off by default**. Configure exact scenarios or probabilities; these are test frequencies you choose, not estimates of vendor incidence. OAuth credentials, authorization codes and signing keys use cryptographic randomness unless you opt in to [seeded credentials](#seeded-credentials).

```ts
import { createRuntime } from "@crvouga/mockingbird-service-oauth"

const identity = createRuntime({
  provider: "apple",
  seed: "signup-regression-42",
  behavior: {
    probabilities: {
      hideEmail: 0.5,
      omitEmail: 0.1,
      omitName: 0.1,
      denyConsent: 0.05,
      tokenUnavailable: 0.1,
    },
  },
})

// Force one case instead. Configuration replaces the old behavior and restarts its sequence.
identity.instance().configureBehavior({ preset: "apple_private_relay" })
console.log(identity.instance().behavior.events) // outcomes only; no tokens or account details
```

Identity/consent decisions are sampled once per authorization and kept with the grant, including refresh. Token failures are sampled per token attempt: a transient 503 preserves the code for retry and includes `Retry-After`. The seed, configuration and same ordered requests reproduce the outcomes. The decision cursor, recent 100 events, identities, consent and token state participate in namespace snapshots; reset returns to constructor configuration. Signup subjects remain random: seed stable account IDs for identical relay addresses across runs.

| Provider | Modeled behavior and controls |
| --- | --- |
| Apple | First consent offers keyboard-accessible Share/Hide My Email radio buttons. Hidden email becomes a stable `@privaterelay.appleid.com` alias in **both** callback `user` and ID tokens, including refresh. It never merely flips the privacy flag. `account.relayEmail` sets an explicit alias. The choice persists until consent revocation. `apple.emailMode: "hide" / "share"` fixes the initial choice; `"choose"` lets the user choose. |
| Apple | `user` is returned once; later ID tokens still include email when the email scope was granted. An `openid`-only grant does not leak email or privacy claims. `apple.omitUser` simulates an already-authorized app. `apple.booleanClaims` selects string or boolean verification/privacy claims, including string `"false"`. Subjects and relay addresses are grouped by `client.subjectGroup`, then Apple team ID, then client ID; grouped apps share first-use disclosure state. `realUserStatus` and `transferSub` fixtures cover Apple risk and app-transfer claims. |
| Google | Refresh tokens normally appear only on first consent or explicit consent. `google.refreshToken` selects `first-consent`, `always`, or `never`. `include_granted_scopes=true` combines prior grants; `consent.deniedScopes` models partial consent. Userinfo scope URL aliases are accepted. Hosted-domain claims remain distinct from an email suffix. |
| Google | `google.testing=true` expires refresh tokens in seven days **only when non-basic scopes are requested**. `google.maxRefreshTokens` defaults to 100 per account/client and evicts the oldest refresh token. Six calendar months without use expires a refresh token. `tokens.refreshError: "invalid_rapt"` returns the reauthentication error subtype; `invalid_grant` revokes the family. |
| Microsoft | Client-scoped subject plus `oid`, `tid` and mutable `preferred_username`; fixtures can omit email even when requested. Refresh returns a replacement while retaining the old token. Use `microsoft_spa_expiry` for a 24-hour refresh window. Supply real-shaped tenant/object fixture IDs when the app validates UUIDs. |
| GitHub | OAuth app endpoints, JSON or form token responses, no ID token, and a nullable `/user.email` even with email scope. `/user/emails` returns primary/secondary and verified/unverified addresses and requires `user:email` or `user`. Resource responses expose `X-OAuth-Scopes` and `X-Accepted-OAuth-Scopes`. An unverified primary account fails token exchange with `unverified_user_email`. Incorrect credentials/code/redirect produce GitHub error names. |
| Any | Missing/unverified email, missing names, denied consent, partial scopes, configurable token/code expiry, transient token failures, revoked grants, strict refresh rotation/reuse detection, and signing-key rotation. Non-Apple account email changes retain the subject. Additional scopes can be accepted via `additionalScopes`; associated resource APIs are not implied. |

The complete typed controls are `OAuthBehavior`. `probabilities` accepts `hideEmail`, `omitEmail`, `omitName`, `unverifiedEmail`, `denyConsent`, `tokenUnavailable`, and `invalidGrant`, each in `[0,1]`. Static `claims` flags force omissions or unverified email. `consent.error` supports `access_denied`, `interaction_required`, or `temporarily_unavailable`. `tokens` accepts positive integer `accessTtlSeconds`, `codeTtlSeconds`, `refreshTtlSeconds`, `refreshRotation: "reuse" | "rotate"`, `refreshError`, and two ID-token faults for testing a relying party's verification: `idTokenClockSkewSeconds` (an integer, forward or backward) sets `iat = now + skew`, `exp = iat + accessTtlSeconds` and offsets `auth_time` by the same skew, and `idTokenSigningKey: "unpublished"` signs ID tokens with a key whose `kid` no JWKS response ever contains, even after `rotateSigningKey`. Both apply to authorization-code, refresh-grant and `code id_token` ID tokens and compose with each other. These controls are local testing overrides, not claims that all providers implement every variation.

`OAUTH_SCENARIOS` supplies: `apple_private_relay`, `apple_share_email`, `apple_returning_user`, `apple_boolean_claims`, `microsoft_missing_email`, `microsoft_spa_expiry`, `github_unverified_email`, `missing_email`, `missing_name`, `unverified_email`, `google_no_refresh_token`, `google_reauthentication`, `revoked_refresh_token`, `rotating_refresh_tokens`, `short_lived_tokens`, `consent_denied`, `intermittent_token_failure`, `id_token_clock_ahead` (+600 s), `id_token_stale` (-7200 s, expired an hour ago), `id_token_unknown_key`. Explicit fields override the chosen preset's fields. Unknown keys and invalid values fail validation.

```sh
npx mockingbird-oauth serve --provider apple --seed regression-42 --scenario apple_private_relay
curl http://localhost:8810/__admin/scenarios
curl -X PUT http://localhost:8810/__admin/behavior -H 'content-type: application/json' \
  -d '{"preset":"apple_private_relay","probabilities":{"omitName":0.25}}'
curl http://localhost:8810/__admin/behavior
curl -X POST http://localhost:8810/__admin/consents/revoke -H 'content-type: application/json' \
  -d '{"clientId":"app","accountId":"ada"}'
curl 'http://localhost:8810/__admin/grants?clientId=app&accountId=ada'
curl 'http://localhost:8810/__admin/grants?clientId=app'
curl -X POST http://localhost:8810/__admin/accounts/delete -H 'content-type: application/json' \
  -d '{"accountId":"ada"}'
curl -X POST http://localhost:8810/__admin/relay-forwarding -H 'content-type: application/json' \
  -d '{"accountId":"ada","forwarding":false}'
curl -X POST http://localhost:8810/__admin/keys/rotate -H 'content-type: application/json' \
  -d '{"retainPrevious":true}'
```

`GET /__admin/grants?clientId=<id>&accountId=<id>` (or `&email=<address>`) reads what that client sees for the account, without running a sign-in: `{ subject, granted, scopes, emailChoice, email, isPrivateEmail, userDisclosed }`. `subject` is the id token `sub` the client gets, or would get on a first authorization (it survives a consent revocation). `granted` says whether a consent exists, so whether the consent card is shown next time. `scopes` are the granted scopes, including Google `include_granted_scopes` merges. `emailChoice` is Apple's `"share"` or `"hide"`, and `null` before the first authorization, after a revocation, and on every other profile. `email` is the address the client receives: the relay for Hide My Email, the real address otherwise. `userDisclosed` is whether Apple's first-use `user` payload was already sent. Without `accountId` or `email` it returns `{ "grants": [...] }`, one row (with `accountId`) per account that currently has a grant with the client. An unknown client or account is `404`. Programmatically, `await runtime.instance().grant(clientId, accountId)` returns the same view, or `null`, and `grants(clientId)` the list. The view is read-only and follows namespaces.

These routes use the shared admin-key and namespace controls. `revokeConsent(clientId, accountId)` removes that client's grants and resets first-use disclosure; it does not disable the account. It is async because it can deliver a [server-to-server notification](#sign-in-with-apple-server-to-server-notifications). `rotateSigningKey(true)` retains up to four previous public keys so existing tokens still verify; `false` withdraws them to test stale JWKS caches. Keys themselves are not included in snapshots, so restoring state does not undo a key rotation.

### Sign in with Apple server-to-server notifications

Register an Apple client with `apple.notificationUrl` (an HTTP(S) URL; requires the JWT `apple` client form) and the emulator behaves like Apple's [server-to-server notification endpoint](https://developer.apple.com/documentation/signinwithapplerestapi/processing-changes-for-sign-in-with-apple-accounts): it POSTs `{"payload": "<JWS>"}` as JSON. The JWS is signed by the current signing key (verify it against the JWKS) with `iss` = the issuer, `aud` = the client id, `iat` from the emulator clock and a random `jti`. `events` is a JSON string of `{ type, sub, event_time }`, where `sub` is the client's identity for the account and `event_time` is milliseconds from the emulator clock.

| Trigger | Event `type` | Sent to |
| --- | --- | --- |
| `revokeConsent(clientId, accountId)` / `POST /__admin/consents/revoke` | `consent-revoked` | that client, when it held the consent |
| `deleteAccount(accountId)` / `POST /__admin/accounts/delete {"accountId"}` | `account-delete` | every client holding a consent; then the account, its grants, sessions and pending sign-ins are removed |
| `setRelayForwarding(accountId, forwarding)` / `POST /__admin/relay-forwarding {"accountId","forwarding"}` | `email-disabled` / `email-enabled`, with `email` (the relay address) and `is_private_email: "true"` | every client holding a consent whose identity is a private relay address |

Delivery is awaited by the call that caused it, through `webhooks.fetch` (`createRuntime({ webhooks: { fetch } })`, default global `fetch`), so an in-process suite can route it through its own network model. The admin routes and methods return one `{ clientId, type, delivered, status?, error? }` per notification; a non-2xx response or a thrown error is reported there and never fails the call, and Apple's retries are not modelled. Without an `issuer` option, direct method calls need an `issuer` argument (admin routes derive it from the request). Unknown accounts return 404 from the admin routes and reject from the methods.

### Seeded credentials

For deterministic simulation tests, opt in so every opaque value the provider mints comes from the seed instead of `crypto`, and the same seed with the same requests replays byte-for-byte. It is **off by default**: without it, codes, tokens, transaction ids, nonces, `kid` and signing keys stay cryptographically random.

```ts
import { createRuntime } from "@crvouga/mockingbird-service-oauth"

const runtime = createRuntime({
  seed: "s1",
  deterministicCredentials: true,
  clients: [{ id: "app", name: "App", redirectUris: ["https://app.test/callback"], secret: "fixture-secret" }],
  accounts: [{ id: "ada", name: "Ada Lovelace", email: "ada@example.test" }],
})
```

- Seeded: authorization codes, access and refresh tokens, `transaction` ids, session ids, grant families, Apple notification `jti`s, CSP nonces (on every page and the `form_post` response), and the RS256 signing key with its `kid`, including the never-published key behind `tokens.idTokenSigningKey: "unpublished"`. Values are guessable; use only in tests. Pin the clock (`clock`) as well when you compare ID tokens, whose `iat` / `exp` come from it.
- Signing keys are a pure function of the seed and the rotation index, so JWKS, the ID-token header and (RS256 being deterministic) the signature replay too. Deriving a 2048-bit RSA key costs roughly half a second to a couple of seconds once per seed per process; it is cached afterwards.
- The draw counter is part of the namespace state: it is snapshotted with it, and `reset` restarts both the counter and the key sequence, so a reset replays the run. The seed is not mixed with the namespace, so two namespaces or mounts with one seed mint the same values.
- `createRuntime({ randomBytes: (length) => bytes })` replaces `crypto.getRandomValues` for every minted value instead (it wins over the seeded source), and `signingKeys: [{ privateJwk, publicJwk, kid }, ...]` supplies RS256 keys used in order: the first is current and each `POST /__admin/keys/rotate` takes the next. When the list runs out, rotation falls back to the seeded or random source. The `nonce` option still takes precedence for the `form_post` response.

### Shared service controls

The runtime supplies `/__admin/health`, `/__admin/reset`, snapshots, emulator clock, request journal, metrics, fault injection and namespace isolation. Use `x-mockingbird-namespace` for in-process tests or `/__admin/ns/<name>/…` for complete browser flows. Header-selected namespaces alone cannot persist across ordinary browser navigation. State, grants, sessions and consent live in the shared SQLite abstraction; there are no filesystem or Node imports in the main entry.

`OAUTH_PRESETS` includes `token_unavailable` and `access_denied`. Fault rules can also target a provider-specific path, e.g. `POST /__admin/faults` with `{"pathPrefix":"/auth/token","status":503,"body":{"error":"temporarily_unavailable"}}`. The only outbound requests are the Apple notifications above. Journals contain request metadata, never passwords or request bodies.

## API

- `createRuntime(options?)`: shared service runtime; `fetch`, `instance`, `reset`, `snapshot`, `restore`, clock, faults and journals.
- `createMultiRuntime({ mounts })`: exact-path dispatcher for isolated provider runtimes on one origin, with aggregate health and admin controls.
- `OAuthAPI`: standalone handler with `fetch`, `reset`, `seedAccount`, `registerClient`, `accounts`, `clients`, `provider`, `configureBehavior`, `behavior`, `revokeConsent`, `rotateSigningKey`, `grant`, `grants`.
- `OAUTH_PRESETS`: named transport fault presets.
- `OAUTH_SCENARIOS`: named provider-behavior scenarios.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer(options?)` from `./server`: Node HTTP adapter, returning `url`, `close` and `runtime`.
- `createMultiServer({ mounts })` from `./server`: Node HTTP adapter for a multi-provider runtime.
- `DEFAULT_PORT`, `serveTarget` from `./server`: CLI defaults and multi-service launcher integration.
- Types: `Account`, `Client`, `GrantView`, `Provider`, `OAuthAPIOptions`, `OAuthRuntimeOptions`, `OAuthRuntime`, `OAuthServerOptions`, `OAuthMount`, `OAuthMultiRuntimeOptions`, `OAuthMultiRuntime`, `OAuthMultiServerOptions`, `OAuthBehavior`, `BehaviorInput`, `OAuthScenario`, `EdgeCase`, `BehaviorEvent`.

## Verification

`bun test` covers protocol security, every published behavior scenario, all provider profiles,
independent JOSE verification, an unmodified `oauth4webapi` client, the complete in-process app,
and randomized self-parity across provider, privacy, omission, and verification combinations.
`bun run parity` safely checks current public discovery and JWKS contracts against Google, Apple,
and Microsoft, plus GitHub's unauthenticated REST error shape. It needs no credentials and makes
no grants or account changes. Interactive vendor flows cannot be run unattended without owned
provider applications, so the focused contract tests use the official behavior documented in the
references below.

## Deliberately not modelled

This is a ready-to-use local/test identity provider, **not a production authentication server or a claim that every proprietary provider feature is implemented**. Its ready tier covers the documented OAuth/OIDC login, identity, consent, token, provider-edge-case, and UI surface. Applications should still run a small final check against each real provider before release.

Vendor-hosted Google Identity Services/One Tap, native Apple AuthenticationServices, passkeys, MFA, CAPTCHA, password recovery, email delivery/relay forwarding (only Apple's notification of a forwarding change is sent), app-transfer migration, vendor risk engines, tokeninfo/introspection, logout, GitHub Apps installation/device flows, and Microsoft Graph/tenant administration are not implemented. Other configurable OIDC providers can use the generic profile, but their proprietary scopes and claims are not emulated. Scopes are limited to each profile plus explicitly configured additional scopes. Microsoft uses the configured emulator issuer, not real Entra tenant routing. GitHub is the OAuth app login surface, not the full REST API.

No implicit flow, dynamic client registration, wildcard redirect matching, persistent signing-key storage (keys are held in memory; supply them through `signingKeys` or derive them from a seed), or distributed-session coordination is provided. Private-use redirect schemes work only when their complete URI is explicitly registered; executable/local schemes such as `javascript:`, `data:` and `file:` are rejected. Sign-in and consent pages extend CSP `form-action` with the transaction's redirect origin (or custom scheme). Browser navigation responses use a provider-owned handoff document so the callback can relay through another origin without inheriting the consent form's policy; direct programmatic interaction requests retain their HTTP redirect response. The `form_post` hand-off page sends no `form-action` at all: browsers apply that directive to every redirect after the submit, and the callback that receives the POST may redirect to an application origin the provider never sees, so no allow-list can cover it. The rest of that page's policy (`default-src 'none'`, nonce-only scripts and styles, `base-uri 'none'`, `frame-ancestors 'none'`) is unchanged. Discovery, JWKS, token, userinfo and revoke answer `OPTIONS` preflights and reflect the request `Origin`, so browser (SPA + PKCE) clients can redeem codes directly; the interaction pages send no CORS headers. Snapshot restore is for the same runtime/instance; signing keys are not serialized. The default backing store is in-memory and state disappears when the process exits. A secure browser context and Web Crypto, Fetch and standard Web APIs are required; Node 22+, Bun and modern browsers provide them.

References: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Apple authorization request](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.), and [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html).

Provider references for the edge cases: [Apple first-use profile data](https://developer.apple.com/documentation/signinwithapple/configuring-your-webpage-for-sign-in-with-apple), [Apple token response](https://developer.apple.com/documentation/signinwithapplerestapi/tokenresponse), [Google consent and refresh](https://developers.google.com/identity/protocols/oauth2/web-server), [Google expiry and limits](https://developers.google.com/identity/protocols/oauth2#expiration), [Microsoft claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference), [Microsoft refresh behavior](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens), [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [GitHub token errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors).

## Interactive application example

The [OAuth service page](https://mockingbird.chrisvouga.dev/services/oauth#example-google-login)
includes complete in-process Google-style, Apple-style, Microsoft-style, and GitHub-style login
profiles.
Launch the example app, select a seeded account or create one, approve consent, and return to
a signed-in app. Apple mode exercises real `form_post`, first-use name disclosure, Share My
Email, and stable Hide My Email relay addresses. Switch scenarios to exercise missing identity
fields, declined consent, boolean/string claims, returning Apple users, a GitHub account whose
public email is null, or a failing token endpoint. Reset creates fresh, isolated app and provider
state.

The service-owned source lives in `examples/google-login/`: a real Hono app uses
`oauth4webapi` to discover OIDC providers, generate PKCE/state/nonce, exchange the code, verify
JWT signatures against JWKS, fetch identity data, and establish a session. GitHub mode uses its
explicit OAuth endpoints, numeric account ID, and `/user/emails` fallback. Popup mode keeps the host app visible while a separate sign-in window renders the emulator's
actual HTML response. Redirect mode replaces the preview with the provider document and
returns to the app on callback. The popup closes on callback and the app updates with the result. Browsers that
block new windows use a separate modal dialog with its own provider document. Closing the
popup or pressing Escape returns focus to the app without completing sign-in. Native forms use an
in-memory Fetch dispatcher. The request trace exposes the protocol without showing credentials.
Both the app and its cookie/redirect transport run without DOM APIs; only the mounting
component needs a browser. No authentication request leaves the process.

For an entirely browser-hosted Fetch dispatcher, configure
`cookieHeaders: { request: "x-example-cookie", response: "x-example-set-cookie" }`.
Browser Fetch strips the standard `Cookie` and `Set-Cookie` headers from synthetic objects;
this explicit local mapping lets an in-process cookie jar preserve sessions. The example
uses it for both Hono and the provider. Leave it unset for normal HTTP serving, which uses
standard cookie headers. This mapping is a transport detail, not a browser cookie-policy emulator.


### Presentation and account selection

The provider UI is neutral and labelled **OAuth Emulator**, with no vendor or product branding.
Its **System / Light / Dark** controls work on standalone HTML pages; the selection persists
across pages in that browser session. The in-process example bridges the same controls into
the pasted pages. System mode follows the operating system, independently of the
docs site's selected theme.

The example toolbar configures **Popup / Redirect**, appearance, and **Always choose / Reuse
last account**. Changing these settings does not clear accounts or existing consent. Only
**Reset example** (or switching a failure scenario) creates a fresh app and provider.
Initial values can also be passed to the component:

```js
import { mount } from "./examples/google-login/index.js"
const dispose = await mount(host, {
  flow: "redirect", // default: "popup"
  theme: "system", // also "light" or "dark"
  reuseLastAccount: false, // default: always show the chooser
})
```

Popup versus redirect is an application presentation choice; both use the same authorization
endpoint and callback validation. The demo uses `prompt=select_account` to force the chooser.
For any integrating app, session reuse can also be disabled on the emulator itself:

```ts
import { OAuthAPI } from "@crvouga/mockingbird-service-oauth"

const api = new OAuthAPI({
  behavior: { session: { reuseLastAccount: false } },
})
```

The provider default is `true` to emulate normal social login. `false` prevents automatic
account selection and makes `prompt=none` return `login_required`. `prompt=select_account`
always forces interactive choice, regardless of this setting. The same configuration can be
changed with the behavior admin endpoint and is included in snapshots.
