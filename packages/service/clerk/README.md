# @crvouga/mockingbird-service-clerk

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

OIDC discovery, JWKS, OAuth authorize/token/userinfo, users, email addresses, organizations, memberships, invitations, sessions. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-clerk
```

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-clerk/server"

const server = await createServer({ seed: 1 })

// The app's Backend API calls, with the emulator's URL in place of https://api.clerk.com.
const headers = { authorization: "Bearer sk_test_fixture", "content-type": "application/json" }
const created = await fetch(`${server.url}/v1/users`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email_address: ["ada@example.com"], first_name: "Ada" }),
})
const user = (await created.json()) as { id: string; first_name: string }
const listed = await fetch(`${server.url}/v1/users?email_address=ada@example.com`, { headers })
const { data } = (await listed.json()) as { data: { id: string }[] }
console.log(data[0]?.id === user.id) // true
await server.close()
```

The example uses plain `fetch` because `@clerk/backend` only parses a response whose
`content-type` is exactly `application/json`, and the emulator answers
`application/json; charset=UTF-8`. With `createClerkClient({ secretKey, apiUrl: server.url })` the
requests succeed but resources come back as unparsed JSON strings.

## API

- `ClerkAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `CLERK_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
