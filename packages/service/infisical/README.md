# @crvouga/mockingbird-service-infisical

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A **wip** portable Infisical emulator for Universal Auth and the raw-secret surface used by
`@infisical/sdk` **3.0.91**. Organizations, project environments, folders, permissions, tokens,
secrets and historical versions share the standard SQLite state, clock, namespaces and Timeline.
Use synthetic fixtures only.

## Install

```sh
bun add @crvouga/mockingbird-service-infisical
```

## Usage

```ts
import { InfisicalSDK } from "@infisical/sdk"
import { createServer } from "@crvouga/mockingbird-service-infisical/server"

const emulator = await createServer()

// The application's client. Only siteUrl changes.
const sdk = new InfisicalSDK({ siteUrl: emulator.url })
sdk.auth().accessToken("fixture-service-token")
const result = await sdk.secrets().listSecrets({
  projectId: "fixture-project",
  environment: "dev",
  secretPath: "/app",
})
console.log(result.secrets.map((secret) => ({ key: secret.secretKey, version: secret.version })))

await emulator.close()
```

The examples need `@infisical/sdk@3.0.91`. The SDK is an optional consumer dependency; the
emulator's runtime does not depend on it. A machine identity logs in with Universal Auth, and a
`/__admin/ns/<name>` prefix on `siteUrl` gives a suite its own namespace:

```ts
import { InfisicalSDK } from "@infisical/sdk"
import { createServer } from "@crvouga/mockingbird-service-infisical/server"

const emulator = await createServer({ adminKey: "fixture-infisical-admin" })

const sdk = new InfisicalSDK({ siteUrl: `${emulator.url}/__admin/ns/test-suite` })
await sdk.auth().universalAuth.login({
  clientId: "fixture-machine",
  clientSecret: "fixture-client-secret",
})
const result = await sdk.secrets().listSecrets({
  projectId: "fixture-project",
  environment: "dev",
  secretPath: "/app",
})
console.log(result.secrets.map((secret) => ({ key: secret.secretKey, version: secret.version })))

await emulator.close()
```

Point the consumer's `INFISICAL_SITE_URL` (or its SDK `siteUrl` configuration) at the served URL.
The SDK maps `projectId` to the v3 wire field `workspaceId`. The default tree has one `dev`
environment, `/`, `/app` and `/sibling` folders. The default machine permits `/app` and descendants;
its synthetic client secret is `fixture-client-secret`. A legacy `fixture-service-token` permits
all three folders through `sdk.auth().accessToken("fixture-service-token")` or Bearer auth.

For different fixtures pass `trees: ProjectTree[]` to `createRuntime`, `createServer` or `InfisicalAPI`.
A tree names an organization, project and environments; each folder contains `{ key, value,
comment?, tags?, metadata?, version? }` secrets and optional `{ environment, path }` imports.
Machines specify `{ id, clientSecret, grants, ttl?, maxTTL? }`; service tokens specify
`{ id, token, grants, expiresAt? }`. Grants are `{ projectId, environment, path, recursive?,
actions? }`, with `read`, `create` and `edit` actions. Paths match complete segments: `/app` never
matches `/application`. Omitted actions permit all three. These fixture permissions model exact
paths and recursive subtrees; vendor CASL/glob policies are outside this slice.

## Vendor routes and behavior

| Method | Route | Behavior |
| --- | --- | --- |
| POST | `/api/v1/auth/universal-auth/login` | Client ID/secret login; Bearer token, `expiresIn`, `accessTokenMaxTTL` |
| POST | `/api/v1/auth/token/renew` | Renew a live machine token within its original maximum lifetime |
| GET | `/api/v3/secrets/raw` | List by project, environment and folder; optional recursive reads, tag filters, imports and value hiding |
| GET | `/api/v3/secrets/raw/{secretName}` | Current or numbered historical version; optional imports/reference expansion |
| POST | `/api/v3/secrets/raw/{secretName}` | Create a shared secret at version one |
| PATCH | `/api/v3/secrets/raw/{secretName}` | Update or rename; increment version and preserve earlier values, comments, tags and metadata |

Lists return `{ secrets, imports }`, ordered by secret key ascending; the v3 router used by the 3.x SDK has **no pagination
metadata or limit/offset parameters**. Duplicate creation returns vendor `400 BadRequestError`,
rather than an invented conflict status. Secret values are trimmed while retaining a final
newline, following the raw-route transform. Shared machine/service access is supported;
personal secret writes are rejected. Token expiry uses the injected emulator clock. Missing/invalid
tokens, denied permissions, missing locations/secrets, schema validation and throttling return
vendor-shaped error envelopes. Location-not-found messages are deliberately generic to avoid
exposing fixture structure. Machine tokens are opaque emulator credentials rather than signed JWTs.
Legacy service tokens with one exact scope override the caller's project/environment/path,
following the v3 router; recursive service scopes retain explicit caller locations.

Reference expansion supports `${KEY}` and `${environment.folder.KEY}` references within the
same project. Cycles and missing references remain literal in this bounded slice; references to an existing
secret denied by the token return vendor 403 rather than revealing its value. Imports expose only
source secrets the token can read. Imported secret fallback and SDK `listSecretsWithImports`
work for seeded sources; import management uses the admin tree control.

## Admin controls and privacy

Every admin data read/write requires `x-mockingbird-admin-key`. The default is the explicitly
synthetic `fixture-infisical-admin`; provide your own `adminKey` when sharing a server. An empty
key is rejected. Standard health, state, Timeline, reset, metrics, requests, faults and namespace
routes live under `/__admin`; `adminPrefix` relocates the complete reserved tree.

| Method | Admin path | Behavior |
| --- | --- | --- |
| GET / POST | `/project-tree` | Export metadata / atomically seed or update a tree; reseeding an existing secret creates a new version |
| GET | `/secrets` | Secret metadata only; no values, comments or arbitrary metadata fields |
| POST | `/secrets/rotate` | `{ projectId, environment, secretPath?, secretName, secretValue }`; version bump, metadata response |
| GET | `/tokens` | IDs, issue/expiry times, scopes and revocation state; no credentials |
| POST | `/tokens/{id}/expire` | Expire at the current clock time |
| POST | `/tokens/{id}/revoke` | Revoke one token |
| POST | `/machines/{id}/revoke` | Revoke the machine's existing tokens; later logins can issue new ones |
| POST | `/permissions/deny` | Deny `{ projectId, environment, path, recursive? }` |

Secret values, comments, metadata, client secrets and token credentials are sealed with
AES-256-GCM **before** entering any Collection. Standard state reads and Timeline snapshots
contain encrypted bytes; service-specific admin reads expose metadata only. Request journals,
metrics, logs and errors never contain secret values or credential bodies. Plaintext is returned
only by authorized vendor secret operations. This is a test emulator: callers holding the runtime
object can access its programmatic API and should be trusted.

The encryption key is private to the runtime and is shared across its namespaces. Sealed rows
are bound to the public namespace, record kind and version, so Timeline branches decrypt their
inherited fixtures without permitting cross-namespace ciphertext reuse. Use
`createVaultKey()` and pass the same `vaultKey` when reopening a persistent SQLite database;
keep that key outside serialized state. Authentication failure/tampering does not reveal sealed
contents. Constructor fixtures are sealed synchronously so the initial Timeline checkpoint and
reset include the whole tree.

Namespaces use `x-mockingbird-namespace`, `/__admin/ns/<name>/…`, or credential mappings set with
`PUT /__admin/credentials`. Machine tokens issued in one namespace cannot authorize another.
Presets: `rate_limited` (429, Retry-After 1), `missing_version` (404 lookup), `server_error` (500)
and `network_reset` (connection drop before a write). Pass `count: 1` for a one-shot fault.
There are no outbound webhooks in this surface.

## Oracle evidence

The contract follows the official [v3 raw-secret router](https://github.com/Infisical/infisical/blob/70e06365043ae3b6f49ef6c95a8b9997b20f4a34/backend/src/server/routes/v3/deprecated-secret-router.ts),
[raw response schema](https://github.com/Infisical/infisical/blob/70e06365043ae3b6f49ef6c95a8b9997b20f4a34/backend/src/server/routes/sanitizedSchemas.ts),
[secret behavior](https://github.com/Infisical/infisical/blob/70e06365043ae3b6f49ef6c95a8b9997b20f4a34/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts),
[list ordering](https://github.com/Infisical/infisical/blob/70e06365043ae3b6f49ef6c95a8b9997b20f4a34/backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts),
[Universal Auth router](https://github.com/Infisical/infisical/blob/70e06365043ae3b6f49ef6c95a8b9997b20f4a34/backend/src/server/routes/v1/identity-universal-auth-router.ts),
and [error handler](https://github.com/Infisical/infisical/blob/70e06365043ae3b6f49ef6c95a8b9997b20f4a34/backend/src/server/plugins/error-handler.ts).
SDK tests execute the actual [published 3.0.91 package](https://www.npmjs.com/package/@infisical/sdk/v/3.0.91).
These are source/SDK checks, not a claim that live sandbox parity passed.

`bun run parity:service -- infisical` requires `INFISICAL_API_URL`, `INFISICAL_TOKEN`,
`INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT` and `INFISICAL_SECRET_PATH`. The cold runner
checks read-only list behavior against an accessible empty test folder. It never creates or
updates live secrets. Missing credentials or a nonempty/inaccessible folder exit 2.

## API

Main entry runtime exports: `InfisicalAPI`, `createRuntime`, `createVaultKey`, `DEFAULT_TREE`,
`DEFAULT_ADMIN_KEY`, `INFISICAL_NAMESPACE`, `INFISICAL_PRESETS`, `normalizePath`, `object`,
`document` and `supportedOperationIds`. `object` safely narrows an unknown plain-object value.
`InfisicalAPI` implements `fetch`, `reset`, `seedTree`, `ensureSeeded`, `wire`, `metadata` and
exposes its Collections through `state` plus `sqlite` and `app`. `createRuntime` adds the shared
MockSurface and admin controls. Public types include `InfisicalAPIOptions`, `InfisicalRuntime`,
`InfisicalRuntimeOptions`, `ProjectTree`, `Grant`, `SecretFixture`, `SecretRecord` and `Token`.
The `/server` entry exports `createServer`, `DEFAULT_PORT` (8811) and `serveTarget`, plus
`InfisicalServer`, `InfisicalServerOptions`. CLI: `mockingbird-infisical serve --port 8811`.

## Deliberately not modelled

Full Infisical product administration, vendor v4 APIs, user/personal secret ownership, approval
policies, dynamic/cloud secrets, external auth methods, signed JWT verification, token use limits,
periodic token modes, IP allowlists, cross-project references, nested import graphs/replication,
full glob/CASL authorization, secret reminders, full audit-log reporting, vendor ETags and webhooks
are outside this wip slice. No live secrets are required to install or test it.
