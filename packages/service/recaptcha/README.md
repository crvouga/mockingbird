# @crvouga/mockingbird-service-recaptcha

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A WIP reCAPTCHA v3 emulator: browser `grecaptcha.ready`/`execute`, deterministic single-use tokens,
and form-encoded Siteverify. The contract follows Google's [verification](https://developers.google.com/recaptcha/docs/verify)
and [v3](https://developers.google.com/recaptcha/docs/v3) references. It does not contact Google.

## Install

```sh
bun add @crvouga/mockingbird-service-recaptcha
```

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-recaptcha/server"

// Test setup: a local reCAPTCHA, and a token like the one grecaptcha.execute hands the browser.
const server = await createServer()
const issued = await fetch(`${server.url}/__admin/issue`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ siteKey: "mock_site", action: "login", hostname: "app.example" }),
})
const { token } = await issued.json()

// Application code: the Siteverify call it makes to Google, sent to the emulator's URL.
const siteverifyUrl = `${server.url}/recaptcha/api/siteverify`
const verified = await fetch(siteverifyUrl, {
  method: "POST",
  body: new URLSearchParams({ secret: "mock_secret", response: token }),
})
const { success, score, action } = await verified.json()

await server.close()
```

`mockingbird-recaptcha serve` runs the same server standalone; `createRuntime` from the main
entry is the in-process form.
Override the browser script URL to `/recaptcha/api.js?render=mock_site` and the server
verification URL to `/recaptcha/api/siteverify` on the local origin. The browser shim
uses a local `/__admin/issue` request to obtain tokens; an admin-key-protected runtime
requires tokens to be provisioned by the test harness. No admin key is embedded in script.

Tokens bind a site key, hostname, action, score, and issue time. Verification consumes
them once and expires them after two minutes. A low score is still a successful vendor
verification: the application checks its score threshold, expected action, and hostname.

`PUT /__admin/settings` accepts `sites`, `score`, per-action `scores`, response `action`/
`hostname` overrides, `executeError`, `expired`, `replayed`, and `errorCodes`.
`GET /__admin/attempts` returns only time/result/error metadata, without tokens or secrets.
Shared admin routes provide clock control, reset, Timeline history, namespaces, and faults.
Namespace selection uses `x-mockingbird-namespace` or `/__admin/ns/<name>/…`.
Custom `adminPrefix` relocates issuance and the shim's local target together.

Presets: `human`, `bot`, `threshold_boundary`, `expired`, `replayed`, `script_failure`,
`rate_limited`, and `server_error`. Pass `count: 1` for a one-shot failure. Generic faults
also support deterministic latency and connection drops. No webhook or pagination exists
in this vendor surface.

## API

The main entry exports `RecaptchaAPI`, `RecaptchaState`, `createRuntime`,
`RECAPTCHA_NAMESPACE`, `RECAPTCHA_PRESETS`, `DEFAULT_SETTINGS`, `document`,
`operationIds`, and `supportedOperationIds`, plus public types.
The `/server` entry exports `createServer`, `serveTarget`, and `DEFAULT_PORT`.

## Deliberately not modelled

- Google's risk model, device fingerprinting, interactive v2 challenges, or Enterprise API.
- The private Geviti client's implementation: acceptance uses the documented Google flow.
- Live successful challenges. The cold parity command probes only missing-response rejection
  and exits 2 without `RECAPTCHA_SECRET_KEY`; never use production credentials in fixtures.
