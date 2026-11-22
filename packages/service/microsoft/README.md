# @crvouga/mockingbird-service-microsoft

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

OAuth authorize, token exchange, userinfo, OIDC discovery, Graph /me, logout, token revocation. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-microsoft
```

## Usage

```ts
import { AuthenticationHandler, Client, type Context } from "@microsoft/microsoft-graph-client"
import { createRuntime } from "@crvouga/mockingbird-service-microsoft"

// The Microsoft Graph SDK your application already uses. Only the last middleware changes:
// requests reach the emulator in this process instead of graph.microsoft.com.
const emulator = createRuntime({ seed: 1 })
const graph = Client.initWithMiddleware({
  middleware: [
    new AuthenticationHandler({ getAccessToken: async () => "mock_access_token" }),
    {
      execute: async (context: Context) => {
        context.response = await emulator.fetch(new Request(context.request, context.options))
      },
    },
  ],
})

const me = await graph.api("/me").get()
console.log(me.displayName, me.mail) // Test User testuser@outlook.com
```

For sign-in, serve the emulator (`createServer` from `/server`) and give your OpenID Connect
client the issuer `<server.url>/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0` (the default tenant).

## API

- `MicrosoftAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `MICROSOFT_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
