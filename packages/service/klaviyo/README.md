# @crvouga/mockingbird-service-klaviyo

Stateful mock of the **Klaviyo** events API for test suites: the JSON:API create-event endpoint
our backend posts `Ordered Product` and `Placed Order` to after checkout, the event reads, and an
outbox a suite asserts on. Errors come back in Klaviyo's JSON:API `errors[]` shape, so the text
our client throws (and logs) is the text the real API would produce.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/klaviyo/SUPPORT.md)
- The contract (`openapi.yaml`) is trimmed from Klaviyo's published API (revision `2024-02-15`,
  the one our backend pins) to what our consumer sends.

## Install

```bash
npm install -D @crvouga/mockingbird-service-klaviyo
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-klaviyo serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Point `KLAVIYO_URL` (Joi-required, fully overridable) at the mock's event endpoint; any
`KLAVIYO_API_KEY` works.

```bash
npx mockingbird-klaviyo serve --port 8811
# KLAVIYO_URL=http://127.0.0.1:8811/api/events/
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-klaviyo"

const klaviyo = createRuntime()
// …the app posts POST /api/events/ with Authorization: Klaviyo-API-Key <key>, revision: 2024-02-15…
const response = await klaviyo.fetch(
  new Request("http://klaviyo.test/__admin/outbox?to=ada@example.com&metric=Placed%20Order"),
)
const { messages } = (await response.json()) as { messages: { metric: string; value: number }[] }
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /api/events/` | JSON:API `{data: {type: "event", attributes: {properties, time?, value?, value_currency?, unique_id?, metric: {data: {type: "metric", attributes: {name}}}, profile: {data: {type: "profile", id?, attributes: {email?, phone_number?, external_id?}}}}}}` → **202, no body**. The profile is matched by id, email, phone or external id (else created); the metric is created on first use. A repeat of metric + profile + `unique_id` is accepted but not stored twice (a BullMQ retry does not double revenue). Invalid input is 400 `{errors: [{id, status, code: "invalid", title, detail, source: {pointer}}]}`; a phone number that is not E.164 is rejected with Klaviyo's wording. |
| `GET /api/events/` | `{data: [event], links: {self, next: null, prev: null}}`, oldest first. Each event carries `attributes.{timestamp, event_properties (properties + $value + $event_id), datetime, uuid}` and `relationships.{profile, metric}`. |
| `GET /api/events/{id}/` | One event, or 404 `not_found`. |

Every call needs `Authorization: Klaviyo-API-Key <key>` (else 401 `not_authenticated`) and a
`revision: YYYY-MM-DD` header (else 400). Paths answer with or without the trailing slash.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/outbox?to=&since=&metric=&unique_id=` | Accepted events of the calling namespace, oldest first (`to` matches the profile's email, phone or id). `GET /__admin/outbox/:id` for one. |
| `GET /__admin/profiles` | Profiles created or matched by events. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`throttled` (429 + `Retry-After: 1`), `invalid_api_key` (401), `server_error` (500),
`service_unavailable` (503), `connection_drop` (the socket closes; nothing is stored).

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix in `KLAVIYO_URL`, or by private key:
`PUT /__admin/credentials {"credentials": {"<KLAVIYO_API_KEY>": "<namespace>"}}`.

### Deliberately not modelled

- Flows, lists, segments and campaigns: an event never triggers an email (use the outbox).
- Profile-id validation: Klaviyo profile ids are Klaviyo-generated; our backend sends the user
  token as `profile.data.id`, which the mock adopts as the profile id rather than rejecting.
  Whether the real API accepts an unknown id is unverified (no sandbox credentials).
- Pagination (`page[cursor]`), `filter`, `fields[…]` and `include` on reads.
- Rate limits, except through the `throttled` preset.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `KlaviyoAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `events()`, `state`. Options: `sqlite`, `now`, `namespace`, `baseUrl`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, outbox). Options: `baseUrl`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `KLAVIYO_PRESETS` | object | Every named fault preset. |
| `KLAVIYO_NAMESPACE` | string | The service name, `"klaviyo"`. |
| `KLAVIYO_REVISION` | string | The API revision our backend sends, `"2024-02-15"`. |
| `klaviyoApiKey` | function | The key in `Authorization: Klaviyo-API-Key <key>` (how credentials map to namespaces). |
| `klaviyoError` | function | Build a JSON:API `{errors: [...]}` body. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8811. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
