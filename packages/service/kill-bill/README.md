# @crvouga/mockingbird-service-kill-bill

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful Kill Bill REST emulator for billing integration tests. It models tenant-scoped accounts, payment methods, subscriptions, bundles, invoices, payments, credits, refunds, retries, catalogs, audit metadata, a test clock, account overdue state, and secret-protected lifecycle webhooks.

## Install

```bash
npm install -D @crvouga/mockingbird-service-kill-bill
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

```ts
import { AccountApi, Configuration, apiKey } from "killbill"
import { createServer } from "@crvouga/mockingbird-service-kill-bill/server"

const emulator = await createServer()

// The Kill Bill client your application already uses. Only its basePath changes.
const config = new Configuration({
  basePath: emulator.url,
  username: "admin",
  password: "password",
  apiKey: apiKey("bob", "lazar"),
})
const accounts = new AccountApi(config)
await accounts.createAccount({ name: "Synthetic Customer", externalKey: "customer-1", currency: "USD" }, "example")
const { data: account } = await accounts.getAccountByKey("customer-1")
console.log(account.accountId, account.currency) // acc-… USD

await emulator.close()
```

The default credentials are Basic auth `admin:password` plus tenant headers `X-Killbill-ApiKey: bob` and `X-Killbill-ApiSecret: lazar`. Mutations also require `X-Killbill-CreatedBy`; optional reason and comment headers are recorded in the audit journal.

`POST /1.0/kb/tenants` creates another tenant with Basic auth and `X-Killbill-CreatedBy` only. Accounts created with that tenant's api key stay hidden from other tenants. `POST /1.0/kb/tenants/registerNotificationCallback?cb=` stores one push-notification URL for the tenant; invoice and payment events are POSTed there as Kill Bill notification JSON. The in-process `onEvent` hook still receives those events.

`GET /1.0/kb/accounts/pagination` and `GET /1.0/kb/invoices/pagination` enumerate the authenticated
tenant's existing billing records as bare arrays. `offset` defaults to 0 and `limit` to 100;
positive limits use creation order, and negative limits reverse it. Invoice updates retain their
original position. Responses carry `X-Killbill-Pagination-CurrentOffset`, `TotalNbRecords` and
`MaxNbRecords`. `NextOffset` and `NextPageUri` are present only when another page exists. Next-page
URLs retain the selected namespace and configured admin prefix; continue sending Basic auth and
tenant headers. Empty/exhausted pages return `[]`. A zero limit also returns `[]`, as the real SQL
pagination does; clients should stop on an empty page. Account balances default to null; use
`accountWithBalance=true` or `accountWithBalanceAndCBA=true` for the live invoice balance/CBA.
These reads use the same collections as invoice creation, payment and voiding, and participate in
the standard namespace, clock, reset, snapshot and fault controls.

The oracle is Kill Bill's [account resource](https://github.com/killbill/killbill/blob/a21c14d61ab93b902ddba2a1c5ecfbc7aca76e07/jaxrs/src/main/java/org/killbill/billing/jaxrs/resources/AccountResource.java),
[invoice resource](https://github.com/killbill/killbill/blob/a21c14d61ab93b902ddba2a1c5ecfbc7aca76e07/jaxrs/src/main/java/org/killbill/billing/jaxrs/resources/InvoiceResource.java),
[pagination response](https://github.com/killbill/killbill/blob/a21c14d61ab93b902ddba2a1c5ecfbc7aca76e07/jaxrs/src/main/java/org/killbill/billing/jaxrs/resources/JaxRsResourceBase.java),
and [ordering implementation](https://github.com/killbill/killbill/blob/a21c14d61ab93b902ddba2a1c5ecfbc7aca76e07/util/src/main/java/org/killbill/billing/util/entity/dao/DefaultPaginationSqlDaoHelper.java).
Counts are exact for the emulator's finite collections; the vendor's large-dataset count heuristic,
audit projections and search endpoints are unmodelled. Invalid pagination uses the emulator's existing
error envelope; exact live error text remains unverified. Live parity requires an isolated tenant
and is not enabled by the current runner.

## Controls

- `POST /__admin/payments/decline-next` and `/pending-next` select the next payment outcome.
- `POST /__admin/payments/:id/retry` succeeds the latest failed or pending transaction.
- `POST /__admin/catalog/plans` seeds a plan.
- `GET /__admin/billing` inspects billing state and audit entries. `GET /__admin/state` is the shared collection view.
- `GET /1.0/kb/test/clock` returns Kill Bill's clock JSON (`currentUtcTime`, `localDate`, `timeZone`). `PUT /1.0/kb/test/clock?requestedDate=...` advances recurring billing.
- `PUT /1.0/kb/subscriptions/:id/undoChangePlan` cancels a pending plan change. With no pending change it returns 400 and Kill Bill error code 1071.
- `GET /1.0/kb/test/queues?timeoutSec=` returns 200 when no due notification or bus event is outstanding, and 412 after that many seconds when work remains. The default timeout is 5 seconds. A notification counts only when its `effectiveDate` is at or before the clock; rows in `kb_bus_events` always count. Both collections are visible through `GET /__admin/state`.
- Fault presets cover plugin failure, rate limiting, network loss, and webhook duplicate/reorder/drop delivery.

## API

- `KillBillAPI`, `KillBillAPIOptions`, `KillBillEvent`: REST handler and event contract.
- Account, subscription, bundle, invoice, payment, transaction, and catalog state types.
- `createRuntime`, `KillBillRuntime`, `KillBillRuntimeOptions`: full runtime and webhook hub.
- `KILL_BILL_NAMESPACE`, `KILL_BILL_PRESETS`: namespace and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `KillBillServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`.

## Fidelity boundary

The emulator targets deterministic adapter and lifecycle tests. It does not run Kill Bill plugins, tax engines, databases, notification workers, or production entitlement and dunning algorithms. Invoice payments with `externalPayment=true` are the exception: they are stored on the built-in `__EXTERNAL_PAYMENT__` method and are not sent to a gateway. `GET /1.0/kb/invoices/{invoiceId}/payments` returns those payments with `targetInvoiceId`. `GET /1.0/kb/invoicePayments/{paymentId}` returns that payment plus `targetInvoiceId`. `POST /1.0/kb/invoicePayments/{paymentId}/refunds` adds a `REFUND` on the same payment (Kill Bill 0.24.10). `externalPayment=true` on that refund records a separate credit payment instead, and leaves the original `refundedAmount` unchanged. `GET /1.0/kb/test/queues` only reports whether due notifications and bus events are still outstanding. A future-dated notification, including an end-of-term plan change whose effective date is still ahead of the clock, does not count. `GET /1.0/kb/accounts/{accountId}/overdue` uses a fixed Kill Bill 0.24.10 config: the synthetic clear state `__KILLBILL__CLEAR__OVERDUE_STATE__`, and state `OD1` once the earliest unpaid invoice (positive balance, not void) is at least one day old (`timeSinceEarliestUnpaidInvoiceEqualsOrExceeds`). Uploading a replacement overdue config is not modelled. A subscription `priceOverrides` entry whose `phaseName` is `{planName}-evergreen` (or whose `phaseType` is `EVERGREEN` when the name is omitted) replaces the catalog amount on the recurring invoice item, and `GET /1.0/kb/subscriptions/{id}` returns the overrides that were sent. Other catalog phases are not modelled.
