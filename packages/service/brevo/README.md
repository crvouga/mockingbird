# @crvouga/mockingbird-service-brevo

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Brevo v3 contact lifecycle, based on the official contact reference. No messages are sent.

## Install

```sh
bun add @crvouga/mockingbird-service-brevo
```

## Usage

```ts
import { BrevoClient } from "@getbrevo/brevo"
import { createRuntime } from "@crvouga/mockingbird-service-brevo"

// The Brevo SDK your application already uses. Only its fetch changes: requests reach the
// emulator in this process instead of api.brevo.com.
const emulator = createRuntime()
const brevo = new BrevoClient({
  apiKey: "mock_brevo_key",
  fetch: ((url: RequestInfo | URL, init?: RequestInit) =>
    emulator.fetch(new Request(url, init))) as typeof fetch,
})

const created = await brevo.contacts.createContact({
  email: "synthetic@example.invalid",
  ext_id: "mock-contact",
  listIds: [1],
  updateEnabled: false,
})
console.log(created) // { id: 1 }
```

Run `mockingbird-brevo serve --port 12124` for a separate application process and set the
SDK's `baseUrl` to `http://localhost:12124/v3` (`@getbrevo/brevo`; a raw HTTP client replaces
its `https://api.brevo.com` origin). The consumer must make that base URL injectable (the
vendor does not define a standard environment variable).
Use the synthetic `api-key: mock_brevo_key`, or configure `apiKeys` in `createRuntime`.

### Routes

- `POST /v3/contacts`: creates a contact with a numeric id (201). Duplicate email or
  external id with `updateEnabled: false` returns 400 `duplicate_parameter` without mutation.
  `updateEnabled: true` updates the existing contact (204).
- `PUT /v3/contacts/{identifier}?identifierType=ext_id`: updates attributes, including
  `attributes.EMAIL`, without changing the contact's numeric id or existing list memberships
  (204). `listIds` adds memberships; `unlinkListIds` removes them.
- `DELETE /v3/contacts/{encoded-email}?identifierType=email_id`: deletes that contact (204).
- `GET /v3/contacts/{identifier}`: reads the contact. Explicit `identifierType` supports
  `email_id`, `contact_id`, and `ext_id`; the default recognizes an email or numeric id.

Missing contacts return 404 `document_not_found`. Invalid identifiers, malformed bodies,
invalid emails and conflicting updates return 400; missing or invalid API keys return 401.
Errors use `{code, message}`. There are no webhooks for this surface.

### Controls and verification

Pass synthetic `contacts` to seed the emulator; reset restores those fixtures. Shared admin
routes include `/__admin/state/contacts` for inspection/seeding, `/__admin/reset`, Timeline
checkpoints, `/__admin/clock`, `/__admin/requests` and `/__admin/faults`. Requests are journaled
as metadata, never contact bodies or API keys. Set `adminPrefix` to relocate this tree.

Namespace carriers are `x-mockingbird-namespace`, `/__admin/ns/{namespace}`, or API keys
mapped through `PUT /__admin/credentials`. Each namespace has independent contacts and ids.
Fault presets: `unauthorized`, `rate_limited` (429 with Retry-After), `server_error` (503),
and `connection_drop`. Generic fault rules also support deterministic latency.

Acceptance tests exercise the raw-fetch requests from issue #280, namespace/reset behavior,
faults and served HTTP. Property tests cover every operation and detect deliberate divergence.
`bun scripts/parity.ts` needs `BREVO_API_KEY` and safely compares the missing-contact envelope;
it does not create, update or delete real contacts. Live write parity has not been verified.

### Deliberately not modelled

Email/SMS sending, campaigns, lists management, bulk import/export, SMS/WhatsApp identifiers,
forceMerge, attribute-definition catalogs, contact statistics and account-level quotas.
Only email and external-id creation are supported. No real customer fixtures or outbound events.

## API

- `BrevoAPI`: in-process FetchAPI with `fetch`, `reset`, `contacts` and `counters` collections.
- `BREVO_NAMESPACE`: service name (`brevo`).
- `createRuntime`: shared admin, namespace, clock, fault and journal surface; accepts `apiKeys`
  and `contacts` in addition to shared runtime options.
- `BREVO_PRESETS`: named fault presets.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI contract metadata.
- `createServer`, `serveTarget`, `DEFAULT_PORT` from `./server`: Node HTTP server and CLI
  target (default port 12124).

Public types include `Contact`, `BrevoAPIOptions`, `OperationId` and `SupportedOperationId`.
