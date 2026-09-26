# Paddle Billing API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **48**
- supported by the mock: **37**
- parity enabled: **37**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListCustomers` | `GET /customers` | ✅ supported | ✅ |  |
| `CreateCustomer` | `POST /customers` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCustomer` | `GET /customers/{customer_id}` | ✅ supported | ✅ |  |
| `UpdateCustomer` | `PATCH /customers/{customer_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCustomerCreditBalances` | `GET /customers/{customer_id}/credit-balances` | ✅ supported | ✅ |  |
| `CreateCustomerAuthToken` | `POST /customers/{customer_id}/auth-token` | ✅ supported | ✅ |  |
| `ListAddresses` | `GET /customers/{customer_id}/addresses` | ✅ supported | ✅ |  |
| `CreateAddress` | `POST /customers/{customer_id}/addresses` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetAddress` | `GET /customers/{customer_id}/addresses/{address_id}` | ✅ supported | ✅ |  |
| `UpdateAddress` | `PATCH /customers/{customer_id}/addresses/{address_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListBusinesses` | `GET /customers/{customer_id}/businesses` | ✅ supported | ✅ |  |
| `CreateBusiness` | `POST /customers/{customer_id}/businesses` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetBusiness` | `GET /customers/{customer_id}/businesses/{business_id}` | ✅ supported | ✅ |  |
| `UpdateBusiness` | `PATCH /customers/{customer_id}/businesses/{business_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListProducts` | `GET /products` | ✅ supported | ✅ |  |
| `CreateProduct` | `POST /products` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetProduct` | `GET /products/{product_id}` | ✅ supported | ✅ |  |
| `UpdateProduct` | `PATCH /products/{product_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListPrices` | `GET /prices` | ✅ supported | ✅ |  |
| `CreatePrice` | `POST /prices` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPrice` | `GET /prices/{price_id}` | ✅ supported | ✅ |  |
| `UpdatePrice` | `PATCH /prices/{price_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListTransactions` | `GET /transactions` | ✅ supported | ✅ |  |
| `CreateTransaction` | `POST /transactions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PreviewTransaction` | `POST /transactions/preview` | ✅ supported | ✅ |  |
| `GetTransaction` | `GET /transactions/{transaction_id}` | ✅ supported | ✅ |  |
| `UpdateTransaction` | `PATCH /transactions/{transaction_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetTransactionInvoice` | `GET /transactions/{transaction_id}/invoice` | ✅ supported | ✅ |  |
| `ReviseTransaction` | `POST /transactions/{transaction_id}/revise` | ❌ unsupported | — | Invoice revision (customer, business and address corrections on billed transactions) is not modelled. |
| `ListSubscriptions` | `GET /subscriptions` | ✅ supported | ✅ |  |
| `GetSubscription` | `GET /subscriptions/{subscription_id}` | ✅ supported | ✅ |  |
| `UpdateSubscription` | `PATCH /subscriptions/{subscription_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PreviewSubscriptionUpdate` | `PATCH /subscriptions/{subscription_id}/preview` | ❌ unsupported | — | Update previews (proration credit/charge summaries) are not modelled; apply the update instead. |
| `ActivateSubscription` | `POST /subscriptions/{subscription_id}/activate` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PauseSubscription` | `POST /subscriptions/{subscription_id}/pause` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ResumeSubscription` | `POST /subscriptions/{subscription_id}/resume` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CancelSubscription` | `POST /subscriptions/{subscription_id}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateSubscriptionCharge` | `POST /subscriptions/{subscription_id}/charge` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PreviewSubscriptionCharge` | `POST /subscriptions/{subscription_id}/charge/preview` | ❌ unsupported | — | One-time charge previews are not modelled; create the charge instead. |
| `GetSubscriptionPaymentMethodChangeTransaction` | `GET /subscriptions/{subscription_id}/update-payment-method-transaction` | ❌ unsupported | — | Payment method changes go through the hosted checkout, which the mock does not serve. |
| `ListEvents` | `GET /events` | ✅ supported | ✅ |  |
| `ListNotificationSettings` | `GET /notification-settings` | ❌ unsupported | — | Notification destinations are configured on the mock (`--webhook-url`, `PUT /__admin/webhook-endpoints`), not through the API. |
| `CreateNotificationSetting` | `POST /notification-settings` | ❌ unsupported | — | Notification destinations are configured on the mock (`--webhook-url`, `PUT /__admin/webhook-endpoints`), not through the API. |
| `ListDiscounts` | `GET /discounts` | ❌ unsupported | — | Discounts are not modelled; totals carry a zero discount. |
| `CreateDiscount` | `POST /discounts` | ❌ unsupported | — | Discounts are not modelled; totals carry a zero discount. |
| `ListAdjustments` | `GET /adjustments` | ❌ unsupported | — | Refunds and credits (adjustments) are not modelled. |
| `CreateAdjustment` | `POST /adjustments` | ❌ unsupported | — | Refunds and credits (adjustments) are not modelled. |
| `CreateCustomerPortalSession` | `POST /customers/{customer_id}/portal-sessions` | ❌ unsupported | — | The hosted customer portal is not served; `management_urls` on a subscription point at placeholder links. |
