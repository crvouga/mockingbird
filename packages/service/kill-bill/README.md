# @crvouga/mockingbird-service-kill-bill

Stateful Kill Bill REST mock for billing integration tests. It models tenant-scoped accounts, payment methods, subscriptions, bundles, invoices, payments, credits, refunds, retries, catalogs, audit metadata, a test clock, and secret-protected lifecycle webhooks.

## Install

```bash
npm install -D @crvouga/mockingbird-service-kill-bill
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-kill-bill/server"

const mock = await createServer()
process.env.KILL_BILL_URL = mock.url
```

The default credentials are Basic auth `admin:password` plus tenant headers `X-Killbill-ApiKey: bob` and `X-Killbill-ApiSecret: lazar`. Mutations also require `X-Killbill-CreatedBy`; optional reason and comment headers are recorded in the audit journal.

## Controls

- `POST /__admin/payments/decline-next` and `/pending-next` select the next payment outcome.
- `POST /__admin/payments/:id/retry` succeeds the latest failed or pending transaction.
- `POST /__admin/catalog/plans` seeds a plan.
- `GET /__admin/state` inspects billing state and audit entries.
- `PUT /1.0/kb/test/clock?requestedDate=...` advances recurring billing.
- Fault presets cover plugin failure, rate limiting, network loss, and webhook duplicate/reorder/drop delivery.

## API

- `KillBillAPI`, `KillBillAPIOptions`, `KillBillEvent`: portable REST handler and event contract.
- Account, subscription, bundle, invoice, payment, transaction, and catalog state types.
- `createRuntime`, `KillBillRuntime`, `KillBillRuntimeOptions`: full runtime and webhook hub.
- `KILL_BILL_NAMESPACE`, `KILL_BILL_PRESETS`: namespace and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `KillBillServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`.

## Fidelity boundary

The mock targets deterministic adapter and lifecycle tests. It does not run Kill Bill plugins, tax engines, databases, queues, or production entitlement and dunning algorithms.
