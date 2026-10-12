# @crvouga/mockingbird-service-google

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

OAuth authorize, token exchange, userinfo, RS256 OIDC discovery and JWKS, token revocation, Gmail messages/drafts/threads/labels/history/settings, Calendar discovery/lists/events/freebusy, Drive files/uploads. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-google
```

## Usage

```ts
import { OAuth2Client } from "google-auth-library"
import { createServer } from "@crvouga/mockingbird-service-google/server"

const google = await createServer()

// The application's OAuth client. Only its endpoints change.
const oauth = new OAuth2Client({
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3000/callback",
  endpoints: {
    oauth2AuthBaseUrl: `${google.url}/o/oauth2/v2/auth`,
    oauth2TokenUrl: `${google.url}/oauth2/token`,
  },
})
const authUrl = oauth.generateAuthUrl({ scope: ["openid", "email", "profile"] })

// Test control: the seeded user approves on the consent page, as a browser would.
const consent = await fetch(`${google.url}/o/oauth2/v2/auth/callback`, {
  method: "POST",
  redirect: "manual",
  body: new URLSearchParams({
    ...Object.fromEntries(new URL(authUrl).searchParams),
    email: "testuser@gmail.com",
  }),
})
const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? ""

// The application exchanges the code and reads the profile.
const { tokens } = await oauth.getToken(code)
oauth.setCredentials(tokens)
const me = await oauth.request<{ email: string }>({ url: `${google.url}/oauth2/v2/userinfo` })
console.log(me.data.email) // "testuser@gmail.com"

await google.close()
```

## API

- `GoogleAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `GOOGLE_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
