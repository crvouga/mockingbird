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

The emulator targets deterministic adapter and lifecycle tests. It does not run Kill Bill plugins, tax engines, databases, notification workers, or production entitlement and dunning algorithms. Invoice payments with `externalPayment=true` are the exception: they are stored on the built-in `__EXTERNAL_PAYMENT__` method and are not sent to a gateway. `GET /1.0/kb/invoices/{invoiceId}/payments` returns those payments with `targetInvoiceId`. `POST /1.0/kb/invoices/{invoiceId}/payments`, external or through a payment method, stops at the invoice balance as Kill Bill 0.24.10 does: with nothing owed it records no payment and answers 204 (a retry with the same `paymentExternalKey` included), and an amount above the balance is refused with `PaymentApiException` 7199. Automatic payment of a new invoice skips an account tagged `AUTO_PAY_OFF` (tag definition `00000000-0000-0000-0000-000000000001`) and otherwise pays only the balance still owed when it runs, so a payment a notification consumer records during `INVOICE_CREATION` is not charged again. `GET /1.0/kb/invoicePayments/{paymentId}` returns that payment plus `targetInvoiceId`. `POST /1.0/kb/invoicePayments/{paymentId}/refunds` adds a `REFUND` on the same payment (Kill Bill 0.24.10). `externalPayment=true` on that refund records a separate credit payment instead, and leaves the original `refundedAmount` unchanged. `GET /1.0/kb/test/queues` only reports whether due notifications and bus events are still outstanding. A future-dated notification, including an end-of-term plan change whose effective date is still ahead of the clock, does not count. `GET /1.0/kb/accounts/{accountId}/overdue` uses a fixed Kill Bill 0.24.10 config: the synthetic clear state `__KILLBILL__CLEAR__OVERDUE_STATE__`, and state `OD1` once the earliest unpaid invoice (positive balance, not void) is at least one day old (`timeSinceEarliestUnpaidInvoiceEqualsOrExceeds`). Uploading a replacement overdue config is not modelled. A subscription `priceOverrides` entry whose `phaseName` is `{planName}-evergreen` (or whose `phaseType` is `EVERGREEN` when the name is omitted) replaces the catalog amount on the recurring invoice item, and `GET /1.0/kb/subscriptions/{id}` returns the overrides that were sent. Other catalog phases are not modelled. `POST /1.0/kb/subscriptions` answers as Kill Bill 0.24.10 does when the catalog cannot serve the plan: with no catalog uploaded (start the emulator with `plans: []`) it returns 500 `java.lang.IllegalStateException` "No existing versions in the VersionedCatalog catalog for input date …", so a client that uploads its catalog on that error can recover, and a plan missing from an uploaded catalog returns 400 `SubscriptionBaseApiException` code 2021 "Could not find any plans named '…'".

## Account, subscription and invoice compatibility additions

The contracts below are **best guess, not oracle-verified**. They follow the official
[account API](https://apidocs.killbill.io/account),
[SubscriptionResource](https://github.com/killbill/killbill/blob/master/jaxrs/src/main/java/org/killbill/billing/jaxrs/resources/SubscriptionResource.java),
[InvoiceResource](https://github.com/killbill/killbill/blob/master/jaxrs/src/main/java/org/killbill/billing/jaxrs/resources/InvoiceResource.java),
[Shiro administrator configuration](https://github.com/killbill/killbill/blob/master/profiles/killbill/src/main/resources/shiro.ini), and
[external bus listener](https://github.com/killbill/killbill/blob/master/beatrix/src/main/java/org/killbill/billing/beatrix/extbus/BeatrixListener.java).
The live parity runner exits 2 because it requires an isolated tenant and is not enabled;
exact vendor errors, account-specific permissions, proration and billing transitions were not replayed.

- `GET /1.0/kb/security/permissions` requires only the configured Basic credentials and returns
  `["*:*"]`, modelling the default administrator. Missing or incorrect credentials return 401
  `UNAUTHORIZED`. Custom roles and user-specific permission inventories are not modelled.
- `PUT /1.0/kb/accounts/{accountId}` updates only the supplied `name` and `email` fields and
  returns 204. Null leaves a value unchanged unless `treatNullAsReset=true`. Changed immutable
  fields return 400 `INVALID_ACCOUNT`; other update fields return the emulator limitation
  `UNSUPPORTED_ACCOUNT_UPDATE`. Rejected updates leave the account unchanged.
- `POST /1.0/kb/subscriptions/{subscriptionId}/block` records a billing-only blocking state and
  returns 201. The latest effective state per `service` applies; any blocking service pauses
  billing. `requestedDate` optionally schedules a state. Subscription and bundle reads remain
  available. Resume uses another state for the same service with `isBlockBilling: false`.
  Entitlement or change blocking returns the explicit emulator limitation
  `UNSUPPORTED_BLOCKING_STATE`. The next clock advancement after resume generates at most one
  full overdue renewal; there is no multi-period catch-up or proration.
- `PUT /1.0/kb/subscriptions/{subscriptionId}/bcd` accepts `billCycleDayLocal` from 1 through 31
  and returns 204. Monthly plans only: from `effectiveFromDate` (today by default), the next
  eligible due date moves to that calendar day on or after its existing date; earlier due
  dates remain unchanged. Later renewals use calendar months, clamped to month-end. Retroactive
  changes and non-monthly plans return `UNSUPPORTED_BCD`; transition proration is not modelled.
  Only one BCD schedule change per subscription is modelled. A later request changing the day
  or effective date returns `UNSUPPORTED_BCD` without mutation; repeating the same pair is
  accepted. Multiple transitions require a new subscription fixture.
- `POST /1.0/kb/invoices/dryRun?accountId=...&targetDate=YYYY-MM-DD` previews the next due
  recurring charge per active, unblocked subscription without creating invoices, consuming IDs,
  emitting events, charging payments or advancing billing state. It supports `TARGET_DATE` only;
  other dry-run types/actions return an explicit error. A due charge returns 200 with invoice
  `items`; nothing due returns 204. Preview IDs are synthetic. Multi-cycle catch-up, tax and
  entitlement-change simulations are not modelled.
- `POST /1.0/kb/invoices/{invoiceId}` adjusts the specified `invoiceItemId` by a positive
  `amount`, or its remaining adjustable amount when omitted. It returns 201 and appends a
  negative `ITEM_ADJ` linked to the original item, reducing invoice amount and balance. Invalid
  items, amounts, accounts or currencies fail without changing the invoice. Exact error codes
  and paid-invoice credit accounting are emulator approximations.
- Successful and failed invoice purchases emit `INVOICE_PAYMENT_SUCCESS` and
  `INVOICE_PAYMENT_FAILED` alongside `PAYMENT_SUCCESS` and `PAYMENT_FAILED`, with `objectType: "INVOICE"`, `objectId` equal to the invoice ID, and the account ID. Pending payments emit only
  `PAYMENT_PENDING`. Events use both the in-process hook and registered tenant callbacks.
  `POST /1.0/kb/accounts/{accountId}/invoicePayments` pays full unpaid invoice balances up to
  `targetDate` (today by default), returning 201, or 204 when none are due. Custom `paymentAmount`
  and `pluginProperty` return `UNSUPPORTED_INVOICE_PAYMENT`. Successful admin retries also emit
  the invoice success event.

Unknown account, subscription and invoice IDs retain their existing 404 error envelopes;
tenant isolation applies to these operations.
