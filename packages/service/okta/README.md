# @crvouga/mockingbird-service-okta

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

OIDC discovery, JWKS, OAuth authorize/token/userinfo/introspect/revoke/logout, users, groups, apps, authorization servers. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-okta
```

## Usage

```ts
import okta from "@okta/okta-sdk-nodejs"
import { createServer } from "@crvouga/mockingbird-service-okta/server"

const server = await createServer({ seed: 1 })

// The app's own Okta client. Only its org URL changes.
const client = new okta.Client({ orgUrl: server.url, token: "fixture-api-token" })
const user = await client.userApi.createUser({
  body: { profile: { firstName: "Ada", lastName: "Fixture", email: "ada@example.com", login: "ada@example.com" } },
})
const found = await client.userApi.getUser({ userId: user.id ?? "" })
console.log(found.status, found.profile?.login) // "ACTIVE", "ada@example.com"
await server.close()
```

## API

- `OktaAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `OKTA_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
