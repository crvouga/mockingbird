# Kill Bill Billing API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **55**
- supported by the emulator: **55**
- parity enabled: **55**

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
| `CloseAccount` | `DELETE /1.0/kb/accounts/{accountId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `AddAccountBlockingState` | `POST /1.0/kb/accounts/{accountId}/block` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetAccountBundles` | `GET /1.0/kb/accounts/{accountId}/bundles` | ✅ supported | ✅ |  |
| `GetBundlesByKey` | `GET /1.0/kb/bundles` | ✅ supported | ✅ |  |
| `GetAccountCustomFields` | `GET /1.0/kb/accounts/{accountId}/customFields` | ✅ supported | ✅ |  |
| `ModifyAccountCustomFields` | `PUT /1.0/kb/accounts/{accountId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateAccountCustomFields` | `POST /1.0/kb/accounts/{accountId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteAccountCustomFields` | `DELETE /1.0/kb/accounts/{accountId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionCustomFields` | `GET /1.0/kb/subscriptions/{subscriptionId}/customFields` | ✅ supported | ✅ |  |
| `ModifySubscriptionCustomFields` | `PUT /1.0/kb/subscriptions/{subscriptionId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateSubscriptionCustomFields` | `POST /1.0/kb/subscriptions/{subscriptionId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteSubscriptionCustomFields` | `DELETE /1.0/kb/subscriptions/{subscriptionId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoiceCustomFields` | `GET /1.0/kb/invoices/{invoiceId}/customFields` | ✅ supported | ✅ |  |
| `ModifyInvoiceCustomFields` | `PUT /1.0/kb/invoices/{invoiceId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateInvoiceCustomFields` | `POST /1.0/kb/invoices/{invoiceId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteInvoiceCustomFields` | `DELETE /1.0/kb/invoices/{invoiceId}/customFields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetAccountTags` | `GET /1.0/kb/accounts/{accountId}/tags` | ✅ supported | ✅ |  |
| `CreateAccountTags` | `POST /1.0/kb/accounts/{accountId}/tags` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteAccountTags` | `DELETE /1.0/kb/accounts/{accountId}/tags` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionTags` | `GET /1.0/kb/subscriptions/{subscriptionId}/tags` | ✅ supported | ✅ |  |
| `CreateSubscriptionTags` | `POST /1.0/kb/subscriptions/{subscriptionId}/tags` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteSubscriptionTags` | `DELETE /1.0/kb/subscriptions/{subscriptionId}/tags` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoiceTags` | `GET /1.0/kb/invoices/{invoiceId}/tags` | ✅ supported | ✅ |  |
| `CreateInvoiceTags` | `POST /1.0/kb/invoices/{invoiceId}/tags` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteInvoiceTags` | `DELETE /1.0/kb/invoices/{invoiceId}/tags` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoiceByNumber` | `GET /1.0/kb/invoices/byNumber/{invoiceNumber}` | ✅ supported | ✅ |  |
| `GetCatalogJson` | `GET /1.0/kb/catalog` | ✅ supported | ✅ |  |
| `AddSubscriptionBlockingState` | `POST /1.0/kb/subscriptions/{subscriptionId}/block` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; see README for contract and limits |
| `UpdateSubscriptionBCD` | `PUT /1.0/kb/subscriptions/{subscriptionId}/bcd` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; see README for contract and limits |
| `GenerateDryRunInvoice` | `POST /1.0/kb/invoices/dryRun` | ✅ supported | ✅ | Best guess, not oracle-verified; see README for contract and limits |
| `AdjustInvoiceItem` | `POST /1.0/kb/invoices/{invoiceId}` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; see README for contract and limits |
| `PayAccountInvoices` | `POST /1.0/kb/accounts/{accountId}/invoicePayments` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess, not oracle-verified; full balances only; paymentAmount and pluginProperty explicitly unsupported |
| `ChangeSubscriptionPlan` | `PUT /1.0/kb/subscriptions/{subscriptionId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `RefundInvoicePayment` | `POST /1.0/kb/invoicePayments/{paymentId}/refunds` | ✅ supported | ⚠️ unsafe (opt-in) |  |
