# @crvouga/mockingbird-service-lifefile

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Work-in-progress LifeFile pharmacy order gateway for synthetic integration tests. This is a
**best guess, not oracle-verified**. It models order submission, idempotency, configurable shipping
refusals, cancellation and Basic-auth Data Push without contacting a pharmacy.

## Install

```sh
bun add -d @crvouga/mockingbird-service-lifefile
```

## Usage

Point your application's LifeFile base URL at the local server. Keep real pharmacy credentials
and patient data out of tests.

```ts
import { createServer } from "@crvouga/mockingbird-service-lifefile/server"

const server = await createServer()
try {
  const response = await fetch(`${server.url}/order`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa("test:test")}`,
      "content-type": "application/json",
      "X-Vendor-ID": "1",
      "X-Location-ID": "1",
      "X-API-Network-ID": "1",
    },
    body: JSON.stringify({
      message: { id: 1 },
      order: { general: { referenceId: "synthetic-order" }, shipping: { state: "AZ" } },
    }),
  })
  if (!response.ok) throw new Error(`Order refused: ${response.status}`)
  const result = await response.json()
  if (result.type !== "success" || !result.data?.orderId) {
    throw new Error(result.message ?? "Order rejected")
  }
  console.log(result.data.orderId)
} finally {
  await server.close()
}
```

## Evidence and chosen contract

The public [Revelation Pharma integration example](https://github.com/RevelationPharma/lifefile-example)
provides primary integration source for the LifeFile order API: Basic authentication, the three
integer `X-*` headers, order creation, status updates and a Data Push receiver. It is a pharmacy's
integration example, not a complete vendor specification. The reporting consumer's client and
response schema supplied the `{type, message, data}` envelope, `data.orderId`, numeric `message.id`,
`order.general.referenceId` and `order.shipping.state` fields.

No live vendor responses were observed. Idempotency, rejection status/envelope details, duplicate
cancellation handling, shipping restrictions and push timing are deterministic emulator choices.
They are **best guesses, not oracle-verified**. Shipping restrictions are configured fixtures;
the default refusal list is empty and asserts no global vendor shipping policy.

`POST /order` returns an order id in `data.orderId`; repeating a `message.id` reuses its id.
Authentication and header/body validation failures do not create orders. The emulator stores
order metadata rather than patient, prescriber or prescription bodies.

`PUT /order/{id}/status` requires an explicitly configured `cancelStatus`. Without it the emulator
returns an explicit unsupported error (HTTP 501), with no state change. This is an emulator
limitation, not an observed LifeFile error. With it, the configured status is the cancellation
fixture contract; unknown orders and other requested statuses fail deterministically.

## Deliberately not modelled

Real prescription processing, pharmacy fulfilment, clinical validation, payments, inventory,
account-specific shipping policy, production credentials and comprehensive vendor schemas.
There is no official JavaScript SDK pinned by the report; acceptance uses a fetch-based consumer.
Do not use this emulator as evidence that a real pharmacy accepted or cancelled an order.

## Settings and test controls

`createRuntime({settings, webhooks})` and `createServer({settings, webhooks})` accept:

| Setting | Default | Behavior |
| --- | --- | --- |
| `accounts` | `[]` | With no fixtures, accept any nonempty Basic username/password. Otherwise require an exact configured `{username,password}` pair. |
| `refusedShippingStates` | `[]` | Reject matching `order.shipping.state` values with an error envelope and no order creation. |
| `cancelStatus` | `null` | Configure the exact status string used by cancellation requests; otherwise status updates return 501. |
| `pushFormat` | `"consumer"` | Provisional object `{orderId, referenceId?, status}`; `"vendor"` selects an array with `orderId`, `referenceId`, `rxStatus`, `rxStatusDateTime` based on the public pharmacy demo. Neither is oracle-verified. |
| `pushBeforeResponse` | `false` | Flush Data Push deliveries before completing the order response when enabled. |

Configure `webhooks: {url, username, password, fetch?}` for the receiver. The optional `fetch`
lets tests supply a local receiver. Production credentials are unnecessary. Orders start at
`Received`; configured cancellation transitions to `Cancelled`. Automatic push delivery and the
state transitions are emulator fixture behavior. Duplicate order submission reuses the id without
creating another order or sending a second push.

The standard admin prefix is `/__admin` (override with `adminPrefix`). Service controls are:

| Route | Behavior |
| --- | --- |
| `GET /orders` | Metadata-only order journal. |
| `GET /settings` | Current settings, with account passwords omitted. |
| `PUT /settings` | Update validated settings for the selected namespace. |
| `POST /orders/:id/push` | Change status and enqueue a push; body `{status, duplicate?, badCredentials?}`. |

These routes are relative to the admin prefix. Standard controls include `/requests`, `/state`,
`/faults`, `/webhooks/events` and `/webhooks/flush`. The webhook journal records delivery metadata
and payloads contain only the modeled order metadata. Request logs do not retain order bodies.

Fault presets are `reject` (business error envelope), `server_error` (500), `malformed` (invalid
JSON), `duplicate_push` and `bad_push_credentials`; standard `timeout` is also available. Apply
one through `POST /__admin/faults` with `{"preset":"reject"}`. For a particular reference, use
`{"operationId":"CreateOrder","requestBody":{"order.general.referenceId":"synthetic-order"},"effect":"reject"}`.
The same matcher scopes 500/malformed/timeout rules. Faults that refuse creation leave no order
or push behind. Duplicate and invalid-auth push controls deliberately exercise receiver handling.

Namespaces select isolated fixtures/state by `x-mockingbird-namespace`, by the standard
`/__admin/ns/<name>/` prefix, or by Basic username after mapping it through
`PUT /__admin/credentials`. Snapshots, reset and Timeline history use the shared runtime.

## API

The package root exports `LifeFileAPI`, `createRuntime`, `LIFEFILE_NAMESPACE`, `basicUsername`,
`LIFEFILE_PRESETS`, `document`, `operationIds` and `supportedOperationIds`. `basicUsername(request)`
extracts the credential namespace carrier. `LifeFileAPI` supplies `fetch`, `reset` and `transition`;
`createRuntime` adds the standard admin controls and the `webhooks` hub.

Public types are `LifeFileAPIOptions`, `PushOptions`, `OrderRecord`, `Settings`, `OperationId`,
`SupportedOperationId`, `LifeFileRuntime` and `LifeFileRuntimeOptions`.

The `./server` entry exports `createServer`, `serveTarget` and `DEFAULT_PORT` (8819), plus types
`LifeFileServer` and `LifeFileServerOptions`. `createServer` listens on an ephemeral local port by
default and returns `{url, close, runtime, ...}`. The `mockingbird-lifefile serve` CLI uses the
fixed default port. `serveTarget` supports fleet hosting and the shared admin controls.

## Live parity

`bun run parity:service -- lifefile` reports missing sandbox credentials by name. Required keys
are `LIFEFILE_API_URL`, `LIFEFILE_USERNAME`, `LIFEFILE_PASSWORD`, `LIFEFILE_VENDOR_ID`,
`LIFEFILE_LOCATION_ID` and `LIFEFILE_API_NETWORK_ID`, stored only in GitHub Actions secrets or
`.env.local`. None were available for this implementation. Every modeled operation can affect
a real pharmacy queue; the parity script refuses mutation without `--include-unsafe` and an
isolated sandbox. No live parity claim is made.
