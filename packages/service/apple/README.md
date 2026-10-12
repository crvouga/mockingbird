# @crvouga/mockingbird-service-apple

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

OAuth authorize, token exchange, JWKS. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-apple
```

## Usage

```ts
import * as oidc from "openid-client"
import { createServer } from "@crvouga/mockingbird-service-apple/server"

const server = await createServer({ seed: 1 })
const redirect_uri = "http://localhost:3000/callback"

// The OpenID Connect client your application already uses. Only the issuer changes: the
// emulator instead of https://appleid.apple.com (allowInsecureRequests permits plain http).
const apple = await oidc.discovery(new URL(server.url), "com.example.web", "mock-client-secret", undefined, {
  execute: [oidc.allowInsecureRequests],
})
const signIn = oidc.buildAuthorizationUrl(apple, { redirect_uri, scope: "openid email name" })

// Test setup: stand in for the user choosing an account on the emulator's sign-in page.
const chosen = await fetch(`${server.url}/auth/authorize/callback`, {
  method: "POST",
  redirect: "manual",
  body: new URLSearchParams({ ...Object.fromEntries(signIn.searchParams), email: "testuser@icloud.com" }),
})

const tokens = await oidc.authorizationCodeGrant(apple, new URL(chosen.headers.get("location") ?? ""))
console.log(tokens.claims()?.email) // testuser@icloud.com

await server.close()
```

## API

- `AppleAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `APPLE_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
