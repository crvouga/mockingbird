# @crvouga/mockingbird-service-workos

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP WorkOS AuthKit emulator: authorization redirects, single-use codes, signed JWT sessions,
rotating refresh tokens, user metadata and pagination. Synthetic fixtures only.

## Install

```sh
bun add -d @crvouga/mockingbird-service-workos
```

## Usage

```ts
import { WorkOS } from "@workos-inc/node"
import { createServer } from "@crvouga/mockingbird-service-workos/server"

const server = await createServer()
const url = new URL(server.url)

// The app's own WorkOS client. Only its API host changes.
const workos = new WorkOS("mock_workos_key", {
  clientId: "client_mock",
  apiHostname: url.hostname,
  port: Number(url.port),
  https: false,
})
const authorizationUrl = workos.userManagement.getAuthorizationUrl({
  provider: "authkit",
  clientId: "client_mock",
  redirectUri: "http://localhost:3000/callback",
})

// The test stands in for the browser: the emulator signs in the seeded user and redirects with a code.
const redirect = await fetch(authorizationUrl, { redirect: "manual" })
const code = new URL(redirect.headers.get("location") ?? "").searchParams.get("code") ?? ""

const { user } = await workos.userManagement.authenticateWithCode({ code })
const { data: users } = await workos.userManagement.listUsers({ email: user.email })
console.log(users[0]?.id === user.id) // true
await server.close()
```

For AuthKit, set `WORKOS_API_HOSTNAME`/`WORKOS_API_PORT` from `server.url` and
`WORKOS_API_HTTPS=false`, with `WORKOS_API_KEY=mock_workos_key` and `WORKOS_CLIENT_ID=client_mock`.
Register your callback in the clients seed and use a local `WORKOS_COOKIE_PASSWORD`.

`createRuntime().fetch(Request)` supports in-process adapters. Raw user mirrors should use
the server URL in place of `https://api.workos.com`. The default registered callback is
`http://localhost:3000/callback`; authorization immediately chooses the client's seeded user.
The exact `@workos-inc/node@9.3.1` and `@workos-inc/authkit-nextjs@4.1.0` SDKs are tested
over HTTP, including PKCE, JWT signature validation and expired-session refresh.

### Routes

- `GET /user_management/authorize`: registered callback, code, state, optional organization/PKCE.
- `POST /user_management/authenticate`: client secret with authorization_code or refresh_token.
- `GET /user_management/users`: bearer API key, limit/after and email filtering.
- `GET /sso/jwks/{clientId}`: public ephemeral RS256 verification key used by AuthKit.

### State and controls

Seed `users`, `clients` and `memberships` with runtime options. Options `accessTtlMs`,
`refreshTtlMs` and `codeTtlMs` control expiry. The emulator clock controls issued timestamps.
The standard `/__admin/state` collections expose users, clients, memberships, codes, sessions
and refreshTokens. Edit `sessions.revoked`, expiry fields or used flags for failure scenarios.
Private signing keys are ephemeral and never journaled; resetting state invalidates refresh
tokens, but offline JWT verification has no revocation lookup, just like the SDK.

Standard `/__admin` reset, Timeline snapshots/branches, clock, faults and request journal
are available. Journals store metadata, not client secrets or token request bodies.
Header (`x-mockingbird-namespace`), path (`/__admin/ns/<name>/…`) and bearer credential
namespaces isolate durable state. AuthKit applications should use one dedicated server per
test namespace so the SDK's JWKS URL and issuer remain consistent. Configure `adminPrefix`
to relocate the reserved tree. Presets: `auth_failure`, `rate_limited`, `server_error`,
`connection_drop`; generic faults also support deterministic latency.

### Verification

`bun test` covers acceptance, independent OpenAPI walks, deliberate divergence and both
pinned SDKs. `WORKOS_API_KEY=… bun run parity` runs a safe list-users shape probe; it performs
no account mutations and prints no user data. Missing credentials exit 2.
Oracle references: [authentication](https://workos.com/docs/reference/authkit/authentication),
[users](https://workos.com/docs/reference/authkit/user), and the pinned official SDK sources.

## Deliberately not modelled

Enterprise SAML, directory synchronization, passwords, MFA, hosted AuthKit pages, logout,
user mutations and webhooks. Authorization is a synthetic auto-login rather than a hosted UI.
No third-party identities, network federation, exact production refresh-grace policies or
distributed signing-key persistence. Error envelopes model common documented failures;
vendor-specific diagnostic strings and undocumented claims are not guaranteed.

## API

Root runtime exports: `WorkOSAPI`, `WORKOS_NAMESPACE`, `DEFAULT_USERS`, `DEFAULT_CLIENTS`,
`createRuntime`, `WORKOS_PRESETS`, `document`, `operationIds`, `supportedOperationIds`.
Types include `WorkOSUser`, `WorkOSClient`, `Membership`, `WorkOSAPIOptions`,
`WorkOSRuntimeOptions`, `WorkOSRuntime`, `OperationId`, `SupportedOperationId`.
The `/server` entry exports `createServer`, `serveTarget`, `DEFAULT_PORT`.
