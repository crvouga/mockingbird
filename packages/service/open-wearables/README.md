# @crvouga/mockingbird-service-open-wearables

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Work-in-progress emulator of the public Open Wearables API. Users, provider settings,
connections and asynchronous sync tasks run locally, including inside a browser worker.
This does **not** implement the deployment-specific application API described in issue #780.
Unsupported routes answer an explicit `501` with `detail.code: mockingbird_unsupported`.

## Install

```sh
bun add @crvouga/mockingbird-service-open-wearables
```

## Usage

Point the application's base URL at the server and use the configured API key. The
initial fixture key is `open_wearables_test`; set `settings.apiKeys` for other test keys.
There is no official JavaScript SDK required by this consumer.

```ts
import { createServer } from "@crvouga/mockingbird-service-open-wearables/server"

const server = await createServer()
try {
  const response = await fetch(`${server.url}/api/v1/oauth/providers?cloud_only=true`, {
    headers: { "X-Open-Wearables-API-Key": "open_wearables_test" },
  })
  const providers = await response.json()
  console.log(providers)
} finally {
  await server.close()
}
```

For workers, import `createRuntime` from the package root and inject its Fetch handler
into the application's HTTP client. Configure namespaces through `x-mockingbird-namespace`,
`/__admin/ns/<name>/…`, or a credential mapping in `PUT /__admin/credentials`.

## Supported contract and evidence

This is a **best guess, not oracle-verified**. The source reviewed is upstream revision
[`dbcdc6995ee70145d0138f6e587ce15511b6b482`](https://github.com/the-momentum/open-wearables/tree/dbcdc6995ee70145d0138f6e587ce15511b6b482/backend/app/api/routes/v1):
`users.py`, `oauth.py`, `connections.py`, `sdk_sync.py`, and `sync_data.py`.
No live server was available; the self-parity test compares two emulator instances,
not the real vendor. Run `bun run parity:service -- open-wearables` in the repository
with `OPEN_WEARABLES_BASE_URL` and `OPEN_WEARABLES_API_KEY` for a read-only provider probe.
The fixed fixture provider list may differ from the server's installed/enabled providers.

- `GET /api/v1/oauth/providers`: seven fixture providers, filtered by `cloud_only=true`
  and `enabled_only=true`; Apple is not a cloud provider. Icons are null.
- `POST /api/v1/users`: creates `{id, external_user_id, email, created_at}` from a nonempty
  `external_user_id`; duplicate external IDs reject with 409. This conservative fixture
  contract is not the deployment's idempotent `/sdk/users` upsert.
- `GET /api/v1/users/{user_id}` and `GET …/connections`: reads users and seeded connections;
  an unknown user gets 404. Connections expose identity, status and timestamps, without
  vendor capability enrichment or actual OAuth tokens.
- `DELETE /api/v1/users/{user_id}/connections/{provider}`: revokes a connection, returning
  204; a missing connection is 404. Unknown provider path values return a FastAPI-style 422.
- `POST /api/v1/providers/{provider}/users/{user_id}/sync?data_type=all`: queues a task
  for an active connection. This fixture requires an active connection and returns 409
  otherwise. Only asynchronous default/all-data requests are modelled; additional
  parameters return explicit 501 without creating a task. No vendor is contacted.

All `/api/v1` routes require a key from `settings.apiKeys`, including unsupported routes.
Missing/unknown keys get 401. This deliberately uniform fixture authentication is not a
claim about upstream's mixed OAuth/developer/SDK authentication dependencies.

## Browser pairing

`GET /api/v1/oauth/{provider}/authorize?user_id=<id>&redirect_uri=<url>` returns
`{authorization_url, state}`. Open the returned URL to consent; no connection exists until
"Allow connection" is submitted. Cancellation does not connect. Approved consent redirects
with 303 to the supplied HTTP(S) callback or shows a completion page. A state is single-use
and expires after ten emulator-clock minutes; expired/replayed states return 409, unknown
states 404. No external provider or credential is contacted.

`GET /users/{user_id}/pair?redirect_url=<url>` lists enabled cloud providers. Its provider
links (`/users/{user_id}/pair/{provider}`) open the same consent flow. The upstream frontend
has a user pairing page, but this provider shortcut and `/mockingbird/oauth/{state}` are
**emulator-only helpers**, not claims about vendor callback wire behavior. These public
preview pages deliberately require no API key. Browser links carry the namespace prefix;
state, expiry and connections stay in that namespace. Use isolated preview hosts, not real
accounts. HTML escapes provider names and URLs and refuses non-HTTP(S) callbacks.

Storybook includes pairing, consent, completion, cancellation and no-provider states. A real
Chromium test follows the served page through consent and verifies persisted connection
state. This is evidence for the stand-in, not live provider OAuth parity.

## Test controls

- `POST /__admin/users/{user_id}/connections {provider, status?}` creates or updates a
  connection. Status is `active`, `revoked` or `expired`.
- `PUT /__admin/providers/{provider} {is_enabled}` toggles a provider.
- `POST /__admin/tasks/{task_id}/complete` completes a task and stamps `last_synced_at`.
- `GET /__admin/settings` and `PUT /__admin/settings` configure `apiKeys` and
  `autoCompleteAfterMs` (null disables automatic completion). Advancing the emulator
  clock completes due tasks. Completion is idempotent.
- Standard state, snapshots, reset, faults, request journal and admin UI are available.
  Standard fault presets include `unavailable`, `rate_limited` and `timeout`.

Users, providers, connections, consent states, tasks, settings and ID sequences all use shared runtime
state. Reset restores the initial settings/provider list. No wearable samples are stored.

## Deliberately not modelled

The following issue #780 surfaces return explicit 501 with no user, connection, task or
upload mutation: `POST /api/v1/sdk/users`, provider `/register` and `/deregister`, custom
`/sync/{task_id}/receipt`, and `/sdk/users/{user_id}/sync/apple/healthion`. These are not
verified equivalents of public routes in the inspected upstream revision; we do not
emulate a company's deployment-specific internal API. The public disconnection path is
`DELETE /api/v1/users/{user_id}/connections/{provider}` instead.

The named deployment extensions in issue #780 remain unsupported. Upstream's public SDK
upload is `/api/v1/sdk/users/{user_id}/sync`; it is not the deployment-specific
`/sync/apple/healthion` schema, and this emulator does not fabricate a translation.

Health data reading, SDK sample uploads, vendor webhooks, token refresh, developer
accounts/dashboard, backend Celery/Redis behavior, real wearable providers and real
OAuth credentials are out of scope. No outbound requests or webhooks are produced.

## API

Root exports: `WearablesAPI`, `createRuntime`, `WEARABLES_NAMESPACE`, `apiKeyCredential`,
`document`, `supportedOperationIds`. `WearablesAPI` accepts an injected SQLite client,
clock and settings; `createRuntime` adds namespaces and the standard admin contract.

`/server` exports: `createServer`, `serveTarget`, `DEFAULT_PORT` (8928). The CLI is
`mockingbird-open-wearables serve`. Server transports are Node-only; the root is portable.
