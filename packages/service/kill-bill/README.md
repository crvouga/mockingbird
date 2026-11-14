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
console.log(account.accountId, account.currency) // a UUID, USD

await emulator.close()
```

The default credentials are Basic auth `admin:password` plus tenant headers `X-Killbill-ApiKey: bob` and `X-Killbill-ApiSecret: lazar`. Mutations also require `X-Killbill-CreatedBy`; optional reason and comment headers are recorded in the audit journal.

`POST /1.0/kb/tenants` creates another tenant with Basic auth and `X-Killbill-CreatedBy` only. Accounts created with that tenant's api key stay hidden from other tenants. `POST /1.0/kb/tenants/registerNotificationCallback?cb=` stores one push-notification URL for the tenant; invoice and payment events are POSTed there as Kill Bill notification JSON. As in Kill Bill 0.24.16 (measured with a callback against a real server), delivery happens after the request has answered, in order per account. As in Kill Bill 0.24.10 (issue #652), adding a tag sends `TAG_CREATION` (objectType TAG, the new `tagId`); creating a subscription sends `SUBSCRIPTION_CREATION`, `ENTITLEMENT_CREATION`, `ACCOUNT_CHANGE` when it sets the account BCD, a second `SUBSCRIPTION_CREATION` (billing), then `INVOICE_CREATION`; cancelling sends `SUBSCRIPTION_CANCEL`, `ENTITLEMENT_CANCEL` and a second `SUBSCRIPTION_CANCEL` ahead of any repair invoice's `INVOICE_CREATION` (sent at the request for every policy: best guess, not oracle-verified, for a stop still ahead). Removing a tag sends `TAG_DELETION`. `TENANT_CONFIG_CHANGE` is not sent. Callbacks go through the `webhooks.fetch` transport given to `createRuntime`, else the global `fetch`. Timing: an event raised while the bus is idle waits `notificationDelayMs` (2000 by default; Kill Bill's bus took 2–3 s), and one raised during or right after a delivery, such as a payment the callback makes, goes out at once (Kill Bill's bus polls again after delivering; ~70 ms measured). `GET /1.0/kb/test/queues` waits for pending deliveries. A delivery the callback refuses (non-2xx or no answer) is retried 15 minutes, 30 minutes, 2 hours, 12 hours and a day after each failed attempt, when the clock reaches it (a clock move or the next request), then dropped. The in-process `onEvent` hook still receives events during the request.

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
error envelope; exact live error text remains unverified. Invoice pagination returns invoices
without their components (amounts zero, no items), as Kill Bill 0.24.16 does.

## Live parity

`bun run parity -- [scenario…] [--out <dir>] [--allow-remote]` replays fixed request scenarios
(`scripts/scenarios.ts`) against a Kill Bill you run and a fresh emulator, each in a new tenant it
creates, and diffs the normalized transcripts (ids become placeholders and instants `<ts>`; dates,
amounts and states compare as they are). `KILL_BILL_URL` names that Kill Bill (for example
`http://127.0.0.1:8080`; `KILL_BILL_USERNAME`/`KILL_BILL_PASSWORD` default to `admin`/`password`);
without it the script exits 2. It writes, so it refuses a non-loopback URL without
`--allow-remote`.

The scenarios cover not-found answers, catalog errors, renewal invoicing
(`POST /1.0/kb/invoices`) and its target-date limits, account credit (committed and draft) and its
use, an adjustment of a paid item, seven cancellation shapes, an item-adjusted external refund
with its key lookup and audit logs, a future-dated subscription cancelled before it starts, an
entitlement pause and resume, a billing pause across two renewals, BCD changes under the test
clock (one, two stacked, and on an annual plan), plan changes on annual and semiannual plans
(immediate, on a requested day, at the period end, to the same plan, and with a cancellation
after it), and a renewal-day move (a billing hold, its release and a BCD change). Plan-change
scenarios use a second catalog whose rules leave changes and cancellations at END_OF_TERM and
every alignment at Kill Bill's defaults. All of them matched Kill Bill 0.24.16 (the version
Geviti runs in production) on 2026-11-06. Scenario `bundle-keys-tags-fields` (the catalog read back, a
`bundleExternalKey` and the bundle lookups by key, a second base subscription on the bundle,
subscription custom fields, a `WRITTEN_OFF` invoice tag and invoices by number) matched it on
2026-11-13.

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

The emulator targets deterministic adapter and lifecycle tests. It does not run Kill Bill plugins, tax engines, databases, notification workers, or production entitlement and dunning algorithms. Invoice payments with `externalPayment=true` are the exception: they are stored on the built-in `__EXTERNAL_PAYMENT__` method and are not sent to a gateway. `GET /1.0/kb/invoices/{invoiceId}/payments` returns those payments with `targetInvoiceId`. `POST /1.0/kb/invoices/{invoiceId}/payments`, external or through a payment method, stops at the invoice balance as Kill Bill 0.24.10 does: with nothing owed it records no payment and answers 204 (a retry with the same `paymentExternalKey` included), and an amount above the balance is refused with `PaymentApiException` 7199. An account tagged `AUTO_INVOICING_OFF` (`00000000-0000-0000-0000-000000000002`) is not invoiced: subscriptions start with `chargedThroughDate` null, `POST /1.0/kb/invoices` answers 201 and invoices nothing, and `DELETE /1.0/kb/accounts/{id}/tags?tagDef=` (204) of that tag bills what was held at once (parity scenario `auto-invoicing-off`). Automatic payment of a new invoice skips an account tagged `AUTO_PAY_OFF` (tag definition `00000000-0000-0000-0000-000000000001`) and otherwise pays only the balance still owed when it runs, so a payment a notification consumer records before auto-pay runs is not charged again. Auto-pay runs during the request, so a consumer paying on the delayed `INVOICE_CREATION` finds nothing owed (204), as with Kill Bill 0.24.16. `GET /1.0/kb/invoicePayments/{paymentId}` returns that payment plus `targetInvoiceId`. `POST /1.0/kb/invoicePayments/{paymentId}/refunds` adds a `REFUND` on the same payment (Kill Bill 0.24.10). `externalPayment=true` on that refund records a separate credit payment instead, and leaves the original `refundedAmount` unchanged. `GET /1.0/kb/test/queues` only reports whether due notifications and bus events, push notifications included, are still outstanding. A future-dated notification, including an end-of-term plan change whose effective date is still ahead of the clock, does not count. `GET /1.0/kb/accounts/{accountId}/overdue` uses a fixed Kill Bill 0.24.10 config: the synthetic clear state `__KILLBILL__CLEAR__OVERDUE_STATE__`, and state `OD1` once the earliest unpaid invoice (positive balance, not void) is at least one day old (`timeSinceEarliestUnpaidInvoiceEqualsOrExceeds`). Uploading a replacement overdue config is not modelled. A subscription `priceOverrides` entry whose `phaseName` is `{planName}-evergreen` (or whose `phaseType` is `EVERGREEN` when the name is omitted) replaces the catalog amount on the recurring invoice item, and `GET /1.0/kb/subscriptions/{id}` returns the overrides that were sent. Other catalog phases are not modelled. `POST /1.0/kb/subscriptions` answers as Kill Bill 0.24.10 does when the catalog cannot serve the plan: with no catalog uploaded (start the emulator with `plans: []`) it returns 500 `java.lang.IllegalStateException` "No existing versions in the VersionedCatalog catalog for input date …", so a client that uploads its catalog on that error can recover, and a plan missing from an uploaded catalog returns 400 `SubscriptionBaseApiException` code 2021 "Could not find any plans named '…'".

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
  subscription read `BLOCKED`. Each state adds `PAUSE_`/`RESUME_ENTITLEMENT` and `_BILLING`
  events to the subscription and its bundle `timeline`. `requestedDate` optionally schedules a
  state. Once a billing pause takes effect it credits the rest of the billed period (a
  `REPAIR_ADJ` invoice whose `CBA_ADJ` becomes account credit) and the paused renewals bill
  nothing; a resume bills from its own day to the next billing day, prorated, using that credit
  first (Kill Bill 0.24.16, parity scenario `billing-pause-resume`). A blocking state change
  re-runs invoicing at once, as Kill Bill does.
- `PUT /1.0/kb/subscriptions/{subscriptionId}/bcd` accepts `billCycleDayLocal` from 1 through 31
  and returns 204 (Kill Bill 0.24.16, parity scenarios `bcd-*`). Monthly plans renew in calendar
  months on the billing day, clamped to month-end. From `effectiveFromDate` (today by default) the
  first period off the new day is a stub up to it, billed on the later of the effective date and
  the last new billing day on or before the stub: billed on a new billing day it is prorated over
  that new period (BCD 5 from 01-01 bills 02-01..02-05 on 01-05 at 4/31), otherwise over the month
  from its start (BCD 5 from 02-01 bills it on 02-01 at 4/28). The subscription reports the new day
  from the first new billing day on. Semiannual and annual plans follow the same rules over their
  longer periods. Changes stack, each taking over from its own effective date (a later change with
  the same date replaces it; parity scenario `bcd-twice`), and a `billCycleDayLocal` sent when the
  subscription is created is its BCD from the start. A billing hold from the period end, released
  on a later day with the BCD moved to that day, renews a full period from it (parity scenario
  `move-renewal-day-annual`). Retroactive changes return `UNSUPPORTED_BCD`.
- Account bill-cycle day (Kill Bill 0.24.10, issues #643–#645): month-based plans follow the
  catalog's `<billingAlignment>` rule (the first matching `billingAlignmentCase`), ACCOUNT when the
  catalog has none. With ACCOUNT alignment an account created with `billCycleDayLocal` keeps it;
  one without (0) takes the start day of its first subscription and sends `ACCOUNT_CHANGE`. A
  later subscription started on another day, sent without a subscription-level
  `billCycleDayLocal`, reports the account's day at once and bills a stub to the next one (an
  annual $1,500 plan started 2026-11-05 on BCD 20 bills 61.64 for 11-05..11-20, then full years
  from 11-20); a subscription-level `billCycleDayLocal` overrides it. `entitlementDate` (or
  `billingDate` alone) in the past starts both entitlement and billing on that day: the first
  period is that day plus one period. Best guesses, not oracle-verified: a stub on a monthly or
  other sub-annual plan is prorated over the period that ends on the account's day; the account
  BCD is recorded when the subscription is created, also for a future start; the first
  subscription's own `billCycleDayLocal` does not become the account's; and an `entitlementDate`
  that differs from `billingDate` starts billing on the `entitlementDate`.
- `PUT /1.0/kb/subscriptions/{subscriptionId}` changes the plan (Kill Bill 0.24.16, parity
  scenarios `change-*`). With `billingPolicy=IMMEDIATE` (the default) the change takes effect today;
  with only a `requestedDate`, on that day; with `billingPolicy=END_OF_TERM`, on the
  charged-through date, when the renewal bills the new plan. Taking effect, it bills one invoice:
  the new plan from that day to its next billing day, the period now falling in that day's month
  (an annual plan changed on 04-11 bills 04-11..next 04-01 at 355/365), and a `REPAIR_ADJ` for the
  unused share of the old plan's billed period, then pays the difference as automatic payment
  would. `priceOverrides` sent with the change replace the subscription's. Each change is a
  `CHANGE` event from the request on (dated the request instant when immediate), `prices` lists
  every plan the subscription has had or is changing to, and events report the plan in effect
  when they happen. Cancelling drops a change scheduled on or after the cancellation;
  `undoChangePlan` and `DELETE …/changePlan` drop any change not yet in effect. The catalog's own
  change-policy rules are not read: no policy and no date means `IMMEDIATE`. The new plan is named
  by `planName` or by `productName` + `billingPeriod` (+ `priceList`); a plan the catalog lacks is
  400 `CatalogApiException` as in Kill Bill 0.24.10 (issue #651): 2021 "Could not find any plans
  named '…'", 2030 "Could not find any product named '…'", 2020 "Could not find a plan matching
  spec: (plan: 'undefined', product: '…', billing period: '…', pricelist '…')". The emulator
  keeps one price list, so `priceList` is only echoed in that message (best guess, not
  oracle-verified: a plan of another price list matches). A body with neither name is still 400
  `INVALID_PLAN`.
- `POST /1.0/kb/invoices/dryRun?accountId=...&targetDate=YYYY-MM-DD` previews the recurring
  periods due through `targetDate` per active, unblocked subscription without creating invoices,
  consuming IDs, emitting events, charging payments or advancing billing state. It supports
  `TARGET_DATE` and `UPCOMING_INVOICE` (see below); other dry-run types/actions return an
  explicit error. A due charge returns
  200 with invoice `items`; nothing due returns 204. Preview IDs are synthetic. Tax and
  entitlement-change simulations are not modelled.
- `POST /1.0/kb/invoices?accountId=...&targetDate=YYYY-MM-DD` invoices every period of the
  account's active subscriptions that starts on or before `targetDate`, without moving the clock,
  pays it as automatic payment would, and returns 201 with the invoice `Location`. A pending
  subscription whose start is on or before `targetDate` is billed too. With nothing to invoice it
  returns Kill Bill 0.24.16's 404 with no entity (Tomcat's HTML page). A target 37 months or more
  after today is 400 `InvoiceApiException` 4005, and more than 15 items for one subscription in a
  day (previews included) is 400 code 4 "SAFETY BOUND TRIGGERED …" (parity scenarios
  `invoice-renewal`, `invoice-target-dates`).
- `GET /1.0/kb/paymentTransactions?transactionExternalKey=...` returns the payment holding that
  transaction as `PaymentJson`, or 404 `PaymentApiException` 7020 "Payment … does not exist".
- A refund lowers the invoice's `refundAdj` by the refund, through `invoicePayments` or
  `payments`. With `isAdjusted` it
  adds `ITEM_ADJ` items ("Invoice item adjustment", linked to the requested `adjustments`) that
  lower the amount and leave the balance; without it the refund reopens the balance. An unkeyed
  payment or transaction is keyed by its own id, except the credit payment of an external refund,
  which gets a generated key (Kill Bill 0.24.16, parity scenario `refund-adjusted`). As in Kill
  Bill 0.24.10 (issue #648): an external refund (`externalPayment=true`) may exceed the payment (a
  150 CREDIT of a 100 payment is accepted); an external `isAdjusted` refund with no `adjustments`
  list records only the CREDIT payment and leaves the invoice (amount, balance, `refundAdj`) alone;
  a non-external `isAdjusted` refund without the list is 400 `PaymentApiException` 7199 "Missing
  invoice item adjustements during payment refund" and records nothing (the "Plugin exception "
  message prefix is a best guess from the plugin's other 7199 answer). Rows one request writes
  (the CREDIT transaction and its `ITEM_ADJ`) share the INSERT `userToken` under `audit=FULL`.
  An adjusted external refund sends `PAYMENT_SUCCESS`, `INVOICE_ADJUSTMENT` and
  `INVOICE_PAYMENT_SUCCESS` (objectType INVOICE, the invoice id) (issue #652). Best guesses, not
  oracle-verified: a non-external adjusted refund sends `PAYMENT_REFUND` then
  `INVOICE_ADJUSTMENT`, and `POST /1.0/kb/invoices/{invoiceId}` (item adjustment) sends
  `INVOICE_ADJUSTMENT`.
- `POST /1.0/kb/credits` adds, per credit, a `CREDIT_ADJ` (−amount, the given description) and a
  `CBA_ADJ` (+amount, "Adjustment (account credit)") on a new invoice, `COMMITTED` with
  `autoCommit=true` and `DRAFT` otherwise, and answers 200 with the `CREDIT_ADJ` items (amounts
  positive). `PUT /1.0/kb/invoices/{invoiceId}/commitInvoice` commits a `DRAFT` and returns 204
  (parity scenario `account-credit-draft`). The account's `accountCBA` is the `creditAdj` of its
  committed invoices and its `accountBalance` the open balance minus that credit. A new invoice uses
  the credit first ("Adjustment (use of account credit)"), and new credit pays the account's open
  invoices at once, oldest first, keeping only the rest (parity scenario
  `credit-pays-open-invoice`; Kill Bill 0.24.10, issues #646–#647). A fully covered invoice has
  balance 0 and is not paid, so it sends `INVOICE_CREATION` and no `PAYMENT_*` event. An existing
  invoice that new credit pays (a credit or a repair) sends `INVOICE_ADJUSTMENT` (best guess, not
  oracle-verified).
- `DELETE /1.0/kb/subscriptions/{id}`: entitlement stops at the period end with
  `entitlementPolicy=END_OF_TERM`, now with `IMMEDIATE`, else on `requestedDate` (a day or an
  instant) or now; billing stops at the period end with `billingPolicy=END_OF_TERM` and by default,
  now with `IMMEDIATE`, or on `requestedDate` with `useRequestedDateForBilling=true`. The
  subscription reads `CANCELLED` from the entitlement stop, carries `STOP_ENTITLEMENT` and
  `STOP_BILLING` events, and bills nothing from the billing stop. Billing that stops inside a
  billed period credits its unused share of what the item is still worth after its item
  adjustments ("Adjustment (subscription change)"; parity scenario `cancel-after-item-adjust`): a
  `REPAIR_ADJ` invoice (linked to the repaired `RECURRING` item) whose `CBA_ADJ` becomes account
  credit and first pays what the account's open invoices still owe (Kill Bill 0.24.10, issue
  #647: a $100 invoice $40 paid by credit ends at balance 0 and the $40 comes back). A requested instant before the subscription started is `EntitlementApiException` 1001.
- An unknown account, subscription or invoice id is 404 `ObjectDoesNotExist` ("Object id=…
  type=ACCOUNT doesn't exist!"); an unknown account external key is 404 `AccountApiException`
  3003. Kill Bill answers a malformed (non-UUID) id with Tomcat's 404 page; the emulator answers
  every unknown id, malformed or not, with `ObjectDoesNotExist`.
- `audit=FULL` (or `MINIMAL`) on a read adds each invoice, invoice item, payment and transaction's
  audit rows: `INSERT` (and `UPDATE` for payments and transactions) with the writing request's
  `X-Killbill-CreatedBy`, `-Comment`, `-Reason`, and its `X-Request-Id` as `userToken` (generated
  from the instance's seeded ids when absent). A billing run writes as `SubscriptionBaseTransition`.
  Without `audit` every object carries `auditLogs: []`.
- A catalog XML upload with an `effectiveDate` the tenant already uploaded is 400
  `CatalogApiException` 2080 "Invalid catalog for tenant : <record id>"; earlier and later dates
  load.
- Subscription, bundle, invoice, invoice item, payment and account reads carry the same fields as
  Kill Bill 0.24.16 production responses: subscriptions add `prices`, `events`, `billingPeriod`,
  `productName` and the other `SubscriptionJson` fields, report `startDate` as the creation instant,
  key an unkeyed account, subscription and bundle by their ids, list an account's invoices by
  invoice number, report `chargedThroughDate` null until
  the first invoice, and read `PENDING` until a later start (also when cancelled before it). The
  account invoice list carries amounts and items only with `includeInvoiceComponents=true`.
- `POST /1.0/kb/invoices/{invoiceId}` adjusts the specified `invoiceItemId` by a positive
  `amount`, or its remaining adjustable amount when omitted. It returns 201 and appends a
  negative `ITEM_ADJ` linked to the original item, reducing the invoice amount. What it takes
  beyond the open balance becomes account credit: a `CBA_ADJ` ("Adjustment (account credit)")
  that keeps the balance at 0 and raises `creditAdj` (Kill Bill 0.24.16, parity scenario
  `item-adjust-paid`). Invalid items, amounts, accounts or currencies fail without changing the
  invoice; their exact error codes are emulator approximations.
- Successful and failed invoice purchases emit `INVOICE_PAYMENT_SUCCESS` and
  `INVOICE_PAYMENT_FAILED` alongside `PAYMENT_SUCCESS` and `PAYMENT_FAILED`, with `objectType: "INVOICE"`, `objectId` equal to the invoice ID, and the account ID. Pending payments emit only
  `PAYMENT_PENDING`. Events use both the in-process hook and registered tenant callbacks.
  `POST /1.0/kb/accounts/{accountId}/invoicePayments` pays full unpaid invoice balances up to
  `targetDate` (today by default), returning 201, or 204 when none are due. Custom `paymentAmount`
  and `pluginProperty` return `UNSUPPORTED_INVOICE_PAYMENT`. Successful admin retries also emit
  the invoice success event.

Unknown account, subscription and invoice IDs retain their existing 404 error envelopes;
tenant isolation applies to these operations.

## Bundles, custom fields, tags, account close, trials and notification metaData

Measured against Kill Bill 0.24.16 (the `killbill/killbill:0.24.16` image with a push-notification
callback and the test clock) on 2026-11-13, issues #737–#742, unless a line says best guess.

- Object ids (accounts, subscriptions, bundles, invoices and their items, payments, transactions,
  payment attempts, payment methods, tags, custom fields, tenants, request ids) are version-4-shaped
  UUIDs, as Kill Bill's are. They come from the namespace's id sequence, so the same requests mint
  the same ids, and a runtime `idBase` mints a different, unrelated run. Dry-run preview ids are
  UUIDs derived from the request and consume none.
- `POST /1.0/kb/subscriptions` keys the bundle by `bundleExternalKey` (its own id when absent) and
  the subscription by `externalKey` (its own id when absent). A bundle with that key and an active
  base subscription refuses another base subscription (400 `SubscriptionBaseApiException` 1015
  "Subscription bundle … already has a base subscription") and takes an `ADD_ON` plan its base
  product lists under `<available>` (else 1019 "Can't create AddOn … for BasePlan … (Not
  available)"); once its base is cancelled, the key opens a new bundle and both bundles keep it.
  Adding an add-on to an existing bundle is a best guess (the probe only saw 1019). An `ADD_ON` plan
  without a keyed bundle still opens its own bundle (not modelled further).
- `GET /1.0/kb/accounts/{id}/bundles?externalKey=` returns only that key's bundles (`[]` when none),
  `bundlesFilter=` only the listed bundle ids, and `GET /1.0/kb/bundles?externalKey=` the tenant's
  bundles with the key, or 404 `SubscriptionApiException` 1084 "Could not find a bundle matching key …".
- Custom fields on accounts, subscriptions and invoices: `POST …/customFields [{name, value}]` (201,
  Location the list), `GET` (`CustomFieldJson` list), `PUT [{customFieldId, value}]` and
  `DELETE ?customField=` (204). Each field sends `CUSTOM_FIELD_CREATION` / `_DELETION` (objectType
  CUSTOM_FIELD). Tags on accounts, subscriptions and invoices: `POST …/tags [tagDefinitionId]` (201),
  `GET` (`TagJson` with `objectType` and the built-in `tagDefinitionName`), `DELETE ?tagDef=` (204).
  An invoice tagged `WRITTEN_OFF` (`00000000-0000-0000-0000-000000000004`) reads balance 0, owes
  nothing to the account balance, overdue or account payments, and owes again once untagged.
- `GET /1.0/kb/invoices/byNumber/{n}` returns the invoice, or 400 `InvoiceApiException` 4018 "No
  invoice could be found for number n.".
- `DELETE /1.0/kb/accounts/{id}` closes the account and answers 204; it stays readable. With
  `cancelAllSubscriptions=true` each subscription's entitlement stops now and billing at the end of
  the billed period; with `writeOffUnpaidInvoices=true` each unpaid invoice is tagged `WRITTEN_OFF`
  (and sends `INVOICE_ADJUSTMENT`); the account is tagged `AUTO_INVOICING_OFF` and gets the
  `account-service` `CLOSE_ACCOUNT` blocking state (`isBlockChange`). `itemAdjustUnpaidInvoices=true`
  is the emulator limitation 400 `UNSUPPORTED_ACCOUNT_CLOSE`. Kill Bill also lists `CLOSE_ACCOUNT` as
  a `SERVICE_STATE_CHANGE` among the subscription's events; the emulator does not.
- `POST /1.0/kb/accounts/{id}/block` adds an account blocking state (201, Location
  `/1.0/kb/accounts/{id}/block?blockingStateTypes=ACCOUNT`) that applies to every subscription of the
  account, as a subscription blocking state does (a billing pause credits the rest of the billed
  period). A subscription blocking state answers Location
  `/1.0/kb/accounts/{accountId}/block?blockingStateTypes=SUBSCRIPTION`. Both send `BLOCKING_STATE`
  (objectType ACCOUNT or SUBSCRIPTION).
- An account whose overdue state changes (to `OD1` or back to clear; the fixed config above) sends
  `OVERDUE_CHANGE` (metaData null) then `BLOCKING_STATE` from `overdue-service`. The emulator
  evaluates it after every request. Kill Bill with no overdue config uploaded has only a clear state
  and sends neither.
- A plan whose `<initialPhases>` holds a `TRIAL` phase with a fixed price (or none, meaning 0)
  starts in phase `TRIAL`: one `FIXED` item (`{plan}-trial`) from the start to the trial end, the
  account's bill-cycle day taken from the trial end, `chargedThroughDate` the trial end, `prices`
  listing the TRIAL and EVERGREEN phases and a `PHASE` event at the trial end. On that day it moves
  to `EVERGREEN`, sends `SUBSCRIPTION_PHASE`, then bills the evergreen price. A trial with a
  recurring charge, and other initial phase types, are not modelled. Best guess, not
  oracle-verified: on an account that already has a bill-cycle day, the stub to it bills on the
  trial's last day.
- `POST /1.0/kb/invoices/dryRun` with `dryRunType: UPCOMING_INVOICE` previews the next invoice: the
  periods due on the earliest next billing day of the account's unblocked subscriptions (the trial
  end during a trial), as `targetDate`; `targetDate` in the query is ignored, and nothing due is 204.
- `GET /1.0/kb/catalog` reads back the tenant's uploaded catalog: its `<catalogName>`, its
  `<effectiveDate>` ("2024-01-01T00:00:00.000+00:00"), its currencies, the plans it defined grouped
  under their products (products and plans ordered by name, as Kill Bill lists them) with the product `<category>` as `type` and
  `<available>` add-ons, each plan's own `billingPeriod` name (`QUARTERLY`, not `NINETY_DAYS`), and a
  `TRIAL` phase. Several uploads are merged into one version named and dated after the latest.
  Subscriptions report the plan's `billingPeriod` and `productCategory`.
- Notification `metaData` is Kill Bill's JSON string: subscription events carry
  `{"actionType","bundleExternalKey","subscriptionChangeUndo":false}` (`SUBSCRIPTION_CREATION` and
  `SUBSCRIPTION_CANCEL` once `REQUESTED` and once `EFFECTIVE`; `SUBSCRIPTION_CHANGE` `REQUESTED` on
  the request and `EFFECTIVE` when the plan changes; `SUBSCRIPTION_PHASE` `EFFECTIVE`;
  `SUBSCRIPTION_UNCANCEL` `REQUESTED`, a best guess), `PAYMENT_*` the transaction
  (`paymentTransactionId`, `amount` with two decimals, `currency`, `status`, `transactionType`,
  `effectiveDate`), `INVOICE_PAYMENT_*` the payment attempt (`invoicePaymentType: "ATTEMPT"`,
  `paymentCookieId` the transaction id), `TAG_*` the `tagDefinitionName`, and `BLOCKING_STATE` the
  blockable, service, state and `transitionedTo…` flags. The others (`ACCOUNT_*`, `ENTITLEMENT_*`,
  `INVOICE_CREATION`, `INVOICE_ADJUSTMENT`, `INVOICE_VOID`, `CUSTOM_FIELD_*`, `OVERDUE_CHANGE`) carry
  null. An external refund's `INVOICE_PAYMENT_SUCCESS` carries null (not measured). The in-process
  `onEvent` hook receives the same `metaData`.
