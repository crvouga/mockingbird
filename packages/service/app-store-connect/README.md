# @crvouga/mockingbird-service-app-store-connect

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP App Store Connect emulator for JSON:API apps, users, user invitations, beta groups and
beta testers. ES256 signatures are actually verified; no real Apple account or emails.

## Install

```sh
bun add -d @crvouga/mockingbird-service-app-store-connect
```

## Usage

```ts
import { SignJWT } from "jose"
import { createServer } from "@crvouga/mockingbird-service-app-store-connect/server"

// Test setup: a throwaway ES256 key pair. The emulator only gets the public half.
// Never use a real Apple private key here.
const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
)
const server = await createServer({
  keys: [{ id: "mock-key", issuer: "mock-issuer", role: "ADMIN",
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey) }],
})

// Apple publishes no JavaScript SDK, so the application signs its team JWT and calls the API
// over HTTP. Only the origin changes: server.url instead of api.appstoreconnect.apple.com.
const token = await new SignJWT({})
  .setProtectedHeader({ alg: "ES256", kid: "mock-key", typ: "JWT" })
  .setIssuer("mock-issuer")
  .setAudience("appstoreconnect-v1")
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(pair.privateKey)
const apps = await fetch(`${server.url}/v1/apps`, { headers: { authorization: `Bearer ${token}` } })
const { data } = (await apps.json()) as { data: { attributes: { name: string } }[] }
console.log(data[0]?.attributes.name) // Synthetic App

await server.close()
```

`createRuntime().fetch(Request)` supports in-process clients. The CLI starts without trusted
keys; seed public verification keys through `/__admin/state/keys`, or use server options.
There is no static bypass bearer token. Private signing material is never needed by the emulator;
options containing a private JWK are rejected. Generate test signing keys at test startup.

### Authentication

Team JWTs require ES256, `typ: JWT`, registered `kid`, matching issuer and `appstoreconnect-v1`
audience, valid `iat`/`exp`, signature verification and a lifetime at most 20 minutes.
The emulator clock determines expiry. `enabled: false` revokes a seeded key. Optional scope
claims restrict GET paths/query parameters; limit/cursor/sort are ignored for matching as
documented by Apple. Invalid authentication returns JSON:API 401 before mutation.

The scoped write-role policy follows Apple's team/TestFlight guides: ADMIN/ACCOUNT_HOLDER
may write all supported surfaces; APP_MANAGER may manage beta groups/testers and create
user invitations. Other seeded roles are denied writes with 403. Read authorization and
app-specific role restrictions are simplified; see limitations below.

### Routes

- GET `/v1/apps`, `/v1/users`, `/v1/userInvitations`, `/v1/betaGroups`, `/v1/betaTesters`.
- POST `/v1/userInvitations`, `/v1/betaGroups`, `/v1/betaTesters`.
- GET `/v1/betaGroups/{id}/betaTesters`.
- POST/DELETE `/v1/betaGroups/{id}/relationships/betaTesters`.
- POST `/v1/users/{id}/relationships/visibleApps`.
- DELETE `/v1/users/{id}` and `/v1/userInvitations/{id}`.

Lists support limit/cursor, sparse `fields[type]`, name/email filters and the requested
app filter for groups/testers. `links.next` remains on the configured local origin and keeps
the public namespace. Relationship writes validate every target before changing anything;
removing a tester membership does not delete the tester, group or application user.
Duplicate tester/invitation emails return a 409 JSON:API error and can also be fault-injected.

### Controls

Seed `resources` as JSON:API records and `keys` as public verification keys. Seeded group/tester
and user/visibleApp relationships initialize the durable edge collections. `/__admin/state`
exposes `resources`, `keys`, `memberships`, `visibleApps` for synthetic fixtures.
Standard reset, Timeline snapshots/branches, clock, request journal and faults are available.
Requests use header, `/__admin/ns/<name>/…` path or mapped bearer credential namespaces;
`adminPrefix` relocates the reserved tree. Journals hold no JWTs or request bodies.
Presets: `unauthorized`, `forbidden`, `duplicate`, `rate_limited`, `server_error`,
`connection_drop`; generic faults also support deterministic latency. No webhooks are emitted.

### Verification

`bun test` verifies all four reported behaviors through raw fetch, actual signatures using
independently generated jose ES256 keys, JWT rejection/revocation, scoped writes, seeded edges,
served HTTP, namespace/reset/fault controls, OpenAPI random walks and deliberate divergence.
The consumer is a port of the issue's reported surface, not unavailable private app code.
No official SDK was requested. No live account credentials or writes were used.
`APP_STORE_CONNECT_TOKEN=… bun run parity` safely probes a single app-list response shape;
missing credentials exit 2. It is not a full vendor random-walk parity claim.

Contract sources: Apple's [official OpenAPI download](https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip),
[JWT guide](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests),
[team guide](https://developer.apple.com/help/app-store-connect/manage-your-team/add-and-edit-users/),
and [external testers guide](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers).
Request schemas are retained from the published OpenAPI; response fields are a scoped subset.

## Deliberately not modelled

Binary uploads, App Store release, real invitation emails, builds, device installation,
TestFlight review prerequisites and user acceptance of invitations. Individual-key JWTs and
long-lived tokens for unrelated Apple APIs are outside this team-key surface. Fine-grained
read permissions, per-app key access, advanced role assignment restrictions, relationship
expansion/include and production duplicate diagnostic variants are not guaranteed.
Admin fixture edits can construct states the live API would forbid; seed coherent records.

## API

Root runtime exports: `AppStoreConnectAPI`, `APP_STORE_CONNECT_NAMESPACE`, `DEFAULT_RESOURCES`,
`createRuntime`, `APP_STORE_CONNECT_PRESETS`, `document`, `operationIds`, `supportedOperationIds`.
Types: `ApiKey`, `ResourceType`, `Linkage`, `Resource`, `AppStoreConnectAPIOptions`,
`AppStoreConnectRuntimeOptions`, `AppStoreConnectRuntime`, `OperationId`, `SupportedOperationId`.
The `/server` entry exports `createServer`, `serveTarget`, `DEFAULT_PORT`.
