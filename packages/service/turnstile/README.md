# @crvouga/mockingbird-service-turnstile

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Cloudflare Turnstile server-side Siteverify emulator. It never solves or issues real challenges.

## Install

```sh
bun add @crvouga/mockingbird-service-turnstile
```

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-turnstile/server"

// Test setup: a local Siteverify, and a token like the one the widget hands the browser.
const server = await createServer()
const { token } = await server.runtime.instance().issue({
  hostname: "app.example.test", action: "signup",
}).json()

// Application code: the Siteverify call it makes to Cloudflare, sent to the emulator's URL.
const siteverifyUrl = `${server.url}/turnstile/v0/siteverify`
const result = await fetch(siteverifyUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret: "mock_secret", response: token }),
})
console.log(await result.json()) // success, challenge_ts, hostname, action, cdata

await server.close()
```

Run `mockingbird-turnstile serve --port 12126`, then override the consumer's Siteverify URL
with `http://localhost:12126/turnstile/v0/siteverify`. Keep the real Cloudflare origin in
production. There is no universal consumer environment variable for this override.
Send synthetic `secret: mock_secret`; configure additional sites with `sites`.

### Contract

`POST /turnstile/v0/siteverify` accepts JSON or URL-encoded form fields `secret`, `response`,
optional `remoteip` and UUID `idempotency_key`. Valid tokens return HTTP 200 and
`success: true` with metadata. Rejection is HTTP 200 with `success: false` and
`error-codes`, not a transport exception. Missing/invalid secrets, missing/invalid tokens,
malformed bodies and expired/used tokens retain their documented error codes.

Tokens expire at five minutes on the emulator clock and are consumed once. Matching idempotency
key retries replay the original response; other retries return `timeout-or-duplicate`.
Wrong secrets do not consume a valid token. Applications must independently check the returned
hostname/action. Remote IP is accepted, not used for actual bot detection.

### Controls

- `POST /__admin/issue`: issue a synthetic token; accepts `siteKey` (default `mock_site`),
  `hostname`, `action`, `cdata`. Defaults are for local testing only.
- Constructor `tokens` and shared `/__admin/state/tokens`: seed token expiry/use state.
- `GET /__admin/attempts`: metadata-only verification attempts, without secret/token bodies.
- Shared clock, Timeline, reset, state, faults and request journal are available. Reset restores
  constructor sites/tokens; namespaces are isolated by header or `/__admin/ns/{namespace}`.
  Body secrets do not select namespaces. `adminPrefix` relocates the control tree.

Presets: `internal_error` (HTTP 200 verification rejection), `rate_limited` (scripted 429),
`server_error` (503), `connection_drop`. Generic fault rules add deterministic latency.
Transport presets are test controls, not claims about normal Siteverify status codes.
No webhooks.

Tests use raw fetch (the requested client), JSON/form success, expiry boundary/replay,
idempotency, malformed input, namespace/reset isolation, redacted journals and served HTTP
timeouts/fail-closed behavior. Property tests validate Siteverify and detect divergence.
`bun scripts/parity.ts` needs `TURNSTILE_TEST_SECRET` set to one of Cloudflare's documented
public dummy keys; production keys are refused. It compares success/error envelopes in JSON
and form modes, not production token issuance or private metadata.

### Deliberately not modelled

Browser widget/script, bot detection, real challenges/tokens, multipart encoding, production
token signing, IP reputation, hostname policy administration and enterprise metadata.
Idempotency cache retention and conflicting/in-flight key policies are deterministic local
stand-ins; only identical retry behavior is covered by the public contract evidence.

## API

- `TurnstileAPI`: FetchAPI with `fetch`, `reset`, `issue`, and site/token/attempt collections.
- `createRuntime`: shared emulator contract plus token issuance/attempt inspection.
- `TURNSTILE_NAMESPACE`: service name.
- `TURNSTILE_PRESETS`: named failure controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `serveTarget`, `DEFAULT_PORT` from `./server`: Node HTTP/CLI serving,
  default port 12126.

Public types include `Site`, `Token`, `TurnstileAPIOptions`, `OperationId` and `SupportedOperationId`.
