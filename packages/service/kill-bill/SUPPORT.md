# Kill Bill Billing API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **28**
- supported by the emulator: **28**
- parity enabled: **28**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `PaginateAccounts` | `GET /1.0/kb/accounts/pagination` | ✅ supported | ✅ |  |
| `PaginateInvoices` | `GET /1.0/kb/invoices/pagination` | ✅ supported | ✅ |  |
| `GetTenantByApiKey` | `GET /1.0/kb/tenants` | ✅ supported | ✅ |  |
| `CreateTenant` | `POST /1.0/kb/tenants` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetNotificationCallbacks` | `GET /1.0/kb/tenants/registerNotificationCallback` | ✅ supported | ✅ |  |
| `RegisterNotificationCallback` | `POST /1.0/kb/tenants/registerNotificationCallback` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteNotificationCallbacks` | `DELETE /1.0/kb/tenants/registerNotificationCallback` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `WaitForQueues` | `GET /1.0/kb/test/queues` | ✅ supported | ✅ |  |
| `ReadResource` | `GET /1.0/kb/{resource}` | ✅ supported | ✅ |  |
| `CreateResource` | `POST /1.0/kb/{resource}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetResource` | `GET /1.0/kb/{resource}/{id}` | ✅ supported | ✅ |  |
| `UpdateResource` | `PUT /1.0/kb/{resource}/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteResource` | `DELETE /1.0/kb/{resource}/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UndoChangeSubscriptionPlan` | `PUT /1.0/kb/subscriptions/{subscriptionId}/undoChangePlan` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `VoidInvoice` | `PUT /1.0/kb/invoices/{invoiceId}/voidInvoice` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateFutureInvoice` | `POST /1.0/kb/invoices` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CommitInvoice` | `PUT /1.0/kb/invoices/{invoiceId}/commitInvoice` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentByTransactionExternalKey` | `GET /1.0/kb/paymentTransactions` | ✅ supported | ✅ |  |
| `GetAccountOverdue` | `GET /1.0/kb/accounts/{accountId}/overdue` | ✅ supported | ✅ |  |
| `GetUserPermissions` | `GET /1.0/kb/security/permissions` | ✅ supported | ✅ | Best guess, not oracle-verified; see README for contract and limits |
| `UpdateAccount` | `PUT /1.0/kb/accounts/{accountId}` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; see README for contract and limits |
| `AddSubscriptionBlockingState` | `POST /1.0/kb/subscriptions/{subscriptionId}/block` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; see README for contract and limits |
| `UpdateSubscriptionBCD` | `PUT /1.0/kb/subscriptions/{subscriptionId}/bcd` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; see README for contract and limits |
| `GenerateDryRunInvoice` | `POST /1.0/kb/invoices/dryRun` | ✅ supported | ✅ | Best guess, not oracle-verified; see README for contract and limits |
| `AdjustInvoiceItem` | `POST /1.0/kb/invoices/{invoiceId}` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; see README for contract and limits |
| `PayAccountInvoices` | `POST /1.0/kb/accounts/{accountId}/invoicePayments` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; full balances only; paymentAmount and pluginProperty explicitly unsupported |
| `ChangeSubscriptionPlan` | `PUT /1.0/kb/subscriptions/{subscriptionId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `RefundInvoicePayment` | `POST /1.0/kb/invoicePayments/{paymentId}/refunds` | ✅ supported | ⚠️ unsafe (opt-in) |  |
