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
error envelope; exact live error text remains unverified. Invoice pagination returns invoices without
their components (amounts zero, no items), as Kill Bill 0.24.16 does.

## Live parity

`KILL_BILL_URL=http://127.0.0.1:8080 bun scripts/parity.ts [scenario…] [--out dir]` replays fixed
request scenarios (`scripts/scenarios.ts`) against a Kill Bill you run and a fresh emulator, each in
a new tenant it creates, and diffs the normalized transcripts (ids become placeholders, instants
`<ts>`; dates, amounts and states compare as they are). It writes, so it refuses a non-loopback
`KILL_BILL_URL` without `--allow-remote`. The scenarios cover the catalog errors, renewal invoicing
(`POST /1.0/kb/invoices`), an item-adjusted external refund and its key lookup, an entitlement
pause and resume, three BCD changes under the test clock, and an annual BCD change. All of them
matched Kill Bill 0.24.16 (the version Geviti runs in production) on 2026-11-06.

## Controls

- `POST /__admin/payments/decline-next` and `/pending-next` select the next payment outcome.
- `POST /__admin/payments/:id/retry` succeeds the latest failed or pending transaction.
- `POST /__admin/catalog/plans` seeds a plan.
- `GET /__admin/billing` inspects billing state and audit entries. `GET /__admin/state` is the shared collection view.
- `GET /1.0/kb/test/clock` returns Kill Bill's clock JSON (`currentUtcTime`, `localDate`, `timeZone`). `PUT /1.0/kb/test/clock?requestedDate=...` advances recurring billing; `POST /1.0/kb/test/clock` with no `requestedDate` resets it to the system time.
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
- `POST /1.0/kb/subscriptions/{subscriptionId}/block` records a blocking state and returns 201
  (Kill Bill 0.24.16, parity scenario `block-entitlement`). The latest effective state per
  `service` applies; any blocking service pauses billing, and `isBlockEntitlement` makes the
  subscription read `BLOCKED`. Each state adds `PAUSE_`/`RESUME_ENTITLEMENT` and `_BILLING` events to
  the subscription and its bundle `timeline`. `requestedDate` optionally schedules a state. A
  subscription blocked on the billing date bills nothing; after a resume, the next clock
  advancement bills the periods then due, without proration for the paused days (not replayed).
- `PUT /1.0/kb/subscriptions/{subscriptionId}/bcd` accepts `billCycleDayLocal` from 1 through 31
  and returns 204 (Kill Bill 0.24.16, parity scenarios `bcd-*`). Monthly plans renew in calendar
  months on the billing day, clamped to month-end. From `effectiveFromDate` (today by default) the
  first period off the new day is a stub up to it, billed on the later of the effective date and
  the last new billing day on or before the stub: billed on a new billing day it is prorated over
  that new period (BCD 5 from 01-01 bills 02-01..02-05 on 01-05 at 4/31), otherwise over the month
  from its start (BCD 5 from 02-01 bills it on 02-01 at 4/28). The subscription reports the new day
  from the first new billing day on. An annual plan accepts the change and reads back unchanged.
  Retroactive changes return `UNSUPPORTED_BCD`. Only one BCD schedule change per subscription is modelled. A later request changing the day
  or effective date returns `UNSUPPORTED_BCD` without mutation; repeating the same pair is
  accepted. Multiple transitions require a new subscription fixture.
- `POST /1.0/kb/invoices/dryRun?accountId=...&targetDate=YYYY-MM-DD` previews the recurring
  periods due through `targetDate` per active, unblocked subscription without creating invoices,
  consuming IDs, emitting events, charging payments or advancing billing state. It supports
  `TARGET_DATE` only; other dry-run types/actions return an explicit error. A due charge returns
  200 with invoice `items`; nothing due returns 204. Preview IDs are synthetic. Tax and
  entitlement-change simulations are not modelled.
- `POST /1.0/kb/invoices?accountId=...&targetDate=YYYY-MM-DD` invoices every period of the
  account's active subscriptions that starts on or before `targetDate`, without moving the clock,
  pays it as automatic payment would, and returns 201 with the invoice `Location`. With nothing to
  invoice it returns Kill Bill 0.24.16's 404 with no entity (Tomcat's HTML page) (parity scenario
  `invoice-renewal`).
- `GET /1.0/kb/paymentTransactions?transactionExternalKey=...` returns the payment holding that
  transaction as `PaymentJson`, or 404 `PaymentApiException` 7020 "Payment … does not exist".
- An invoice-payment refund lowers the invoice's `refundAdj` by the refund. With `isAdjusted` it
  adds `ITEM_ADJ` items ("Invoice item adjustment", linked to the requested `adjustments`) that
  lower the amount and leave the balance; without it the refund reopens the balance. An unkeyed
  payment or transaction is keyed by its own id, except the credit payment of an external refund,
  which gets a generated key (Kill Bill 0.24.16, parity scenario `refund-adjusted`).
- Subscription, bundle, invoice, invoice item, payment and account reads carry the same fields as
  Kill Bill 0.24.16 production responses: subscriptions add `prices`, `events`, `billingPeriod`,
  `productName` and the other `SubscriptionJson` fields, report `startDate` as the creation instant,
  and key an unkeyed subscription and its bundle by their ids; the account invoice list carries
  amounts and items only with `includeInvoiceComponents=true`. `pendingChangePlan` is an emulator
  extra that Kill Bill does not return.
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
