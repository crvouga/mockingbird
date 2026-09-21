# Stripe API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **115**
- supported by the mock: **111**
- parity enabled: **106**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `PostThreeDSecureAuthenticate` | `POST /c/3ds/{intent}/authenticate` | ✅ supported | ❌ disabled | the 3-D Secure challenge the Stripe.js stand-in completes has no public API |
| `GetCheckoutPage` | `GET /c/pay/{session}` | ✅ supported | ❌ disabled | the hosted Checkout page is HTML served by the mock in place of checkout.stripe.com |
| `PostCheckoutPage` | `POST /c/pay/{session}` | ✅ supported | ❌ disabled | the hosted Checkout page form post is served by the mock in place of checkout.stripe.com |
| `GetAccount` | `GET /v1/account` | ✅ supported | ✅ |  |
| `GetBalance` | `GET /v1/balance` | ✅ supported | ✅ |  |
| `GetBalanceTransactions` | `GET /v1/balance_transactions` | ✅ supported | ✅ |  |
| `GetBalanceTransactionsId` | `GET /v1/balance_transactions/{id}` | ✅ supported | ✅ |  |
| `GetCharges` | `GET /v1/charges` | ✅ supported | ✅ |  |
| `PostCharges` | `POST /v1/charges` | ❌ unsupported | — | charges are always created through PaymentIntents |
| `GetChargesCharge` | `GET /v1/charges/{charge}` | ✅ supported | ✅ |  |
| `PostChargesCharge` | `POST /v1/charges/{charge}` | ❌ unsupported | — | charges are only read in the e2e path |
| `GetCheckoutSessions` | `GET /v1/checkout/sessions` | ✅ supported | ✅ |  |
| `PostCheckoutSessions` | `POST /v1/checkout/sessions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCheckoutSessionsSession` | `GET /v1/checkout/sessions/{session}` | ✅ supported | ✅ |  |
| `PostCheckoutSessionsSession` | `POST /v1/checkout/sessions/{session}` | ❌ unsupported | — | sessions complete through their payment intent, never by update |
| `PostCheckoutSessionsSessionExpire` | `POST /v1/checkout/sessions/{session}/expire` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCheckoutSessionsSessionLineItems` | `GET /v1/checkout/sessions/{session}/line_items` | ✅ supported | ✅ |  |
| `GetCoupons` | `GET /v1/coupons` | ✅ supported | ✅ |  |
| `PostCoupons` | `POST /v1/coupons` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCouponsCoupon` | `GET /v1/coupons/{coupon}` | ✅ supported | ✅ |  |
| `PostCouponsCoupon` | `POST /v1/coupons/{coupon}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteCouponsCoupon` | `DELETE /v1/coupons/{coupon}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCustomers` | `GET /v1/customers` | ✅ supported | ✅ |  |
| `PostCustomers` | `POST /v1/customers` | ✅ supported | ✅ |  |
| `GetCustomersCustomer` | `GET /v1/customers/{customer}` | ✅ supported | ✅ |  |
| `PostCustomersCustomer` | `POST /v1/customers/{customer}` | ✅ supported | ✅ |  |
| `DeleteCustomersCustomer` | `DELETE /v1/customers/{customer}` | ✅ supported | ✅ |  |
| `GetCustomersCustomerBalanceTransactions` | `GET /v1/customers/{customer}/balance_transactions` | ✅ supported | ✅ |  |
| `PostCustomersCustomerBalanceTransactions` | `POST /v1/customers/{customer}/balance_transactions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCustomersSearch` | `GET /v1/customers/search` | ✅ supported | ✅ |  |
| `GetDisputes` | `GET /v1/disputes` | ✅ supported | ✅ |  |
| `GetDisputesDispute` | `GET /v1/disputes/{dispute}` | ✅ supported | ✅ |  |
| `PostDisputesDispute` | `POST /v1/disputes/{dispute}` | ❌ unsupported | — | the mock never creates or mutates disputes |
| `GetEvents` | `GET /v1/events` | ✅ supported | ✅ |  |
| `GetEventsId` | `GET /v1/events/{id}` | ✅ supported | ✅ |  |
| `GetInvoiceitems` | `GET /v1/invoiceitems` | ✅ supported | ✅ |  |
| `PostInvoiceitems` | `POST /v1/invoiceitems` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoiceitemsInvoiceitem` | `GET /v1/invoiceitems/{invoiceitem}` | ✅ supported | ✅ |  |
| `PostInvoiceitemsInvoiceitem` | `POST /v1/invoiceitems/{invoiceitem}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteInvoiceitemsInvoiceitem` | `DELETE /v1/invoiceitems/{invoiceitem}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoices` | `GET /v1/invoices` | ✅ supported | ✅ |  |
| `PostInvoices` | `POST /v1/invoices` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoicesInvoice` | `GET /v1/invoices/{invoice}` | ✅ supported | ✅ |  |
| `PostInvoicesInvoice` | `POST /v1/invoices/{invoice}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteInvoicesInvoice` | `DELETE /v1/invoices/{invoice}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoicesInvoiceFinalize` | `POST /v1/invoices/{invoice}/finalize` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoicesInvoiceLines` | `GET /v1/invoices/{invoice}/lines` | ✅ supported | ✅ |  |
| `PostInvoicesInvoicePay` | `POST /v1/invoices/{invoice}/pay` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoicesInvoiceVoid` | `POST /v1/invoices/{invoice}/void` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoicesUpcoming` | `GET /v1/invoices/upcoming` | ✅ supported | ❌ disabled | route is absent from the pinned upstream spec (2026-08-26.dahlia previews invoices instead); the e2e SDK still calls it |
| `GetPaymentIntents` | `GET /v1/payment_intents` | ✅ supported | ✅ |  |
| `PostPaymentIntents` | `POST /v1/payment_intents` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentIntentsIntent` | `GET /v1/payment_intents/{intent}` | ✅ supported | ✅ |  |
| `PostPaymentIntentsIntent` | `POST /v1/payment_intents/{intent}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentIntentsIntentCancel` | `POST /v1/payment_intents/{intent}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentIntentsIntentCapture` | `POST /v1/payment_intents/{intent}/capture` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentIntentsIntentConfirm` | `POST /v1/payment_intents/{intent}/confirm` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentIntentsSearch` | `GET /v1/payment_intents/search` | ✅ supported | ✅ |  |
| `GetPaymentMethods` | `GET /v1/payment_methods` | ✅ supported | ✅ |  |
| `PostPaymentMethods` | `POST /v1/payment_methods` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentMethodsPaymentMethod` | `GET /v1/payment_methods/{payment_method}` | ✅ supported | ✅ |  |
| `PostPaymentMethodsPaymentMethod` | `POST /v1/payment_methods/{payment_method}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentMethodsPaymentMethodAttach` | `POST /v1/payment_methods/{payment_method}/attach` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentMethodsPaymentMethodDetach` | `POST /v1/payment_methods/{payment_method}/detach` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPrices` | `GET /v1/prices` | ✅ supported | ✅ |  |
| `PostPrices` | `POST /v1/prices` | ✅ supported | ✅ |  |
| `GetPricesPrice` | `GET /v1/prices/{price}` | ✅ supported | ✅ |  |
| `PostPricesPrice` | `POST /v1/prices/{price}` | ✅ supported | ✅ |  |
| `GetProducts` | `GET /v1/products` | ✅ supported | ✅ |  |
| `PostProducts` | `POST /v1/products` | ✅ supported | ✅ |  |
| `GetProductsId` | `GET /v1/products/{id}` | ✅ supported | ✅ |  |
| `PostProductsId` | `POST /v1/products/{id}` | ✅ supported | ✅ |  |
| `DeleteProductsId` | `DELETE /v1/products/{id}` | ✅ supported | ✅ |  |
| `GetProductsSearch` | `GET /v1/products/search` | ✅ supported | ✅ |  |
| `GetPromotionCodes` | `GET /v1/promotion_codes` | ✅ supported | ✅ |  |
| `PostPromotionCodes` | `POST /v1/promotion_codes` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPromotionCodesPromotionCode` | `GET /v1/promotion_codes/{promotion_code}` | ✅ supported | ✅ |  |
| `PostPromotionCodesPromotionCode` | `POST /v1/promotion_codes/{promotion_code}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRefunds` | `GET /v1/refunds` | ✅ supported | ✅ |  |
| `PostRefunds` | `POST /v1/refunds` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRefundsRefund` | `GET /v1/refunds/{refund}` | ✅ supported | ✅ |  |
| `PostRefundsRefund` | `POST /v1/refunds/{refund}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSetupIntents` | `GET /v1/setup_intents` | ✅ supported | ✅ |  |
| `PostSetupIntents` | `POST /v1/setup_intents` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSetupIntentsIntent` | `GET /v1/setup_intents/{intent}` | ✅ supported | ✅ |  |
| `PostSetupIntentsIntent` | `POST /v1/setup_intents/{intent}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSetupIntentsIntentCancel` | `POST /v1/setup_intents/{intent}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSetupIntentsIntentConfirm` | `POST /v1/setup_intents/{intent}/confirm` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionItems` | `GET /v1/subscription_items` | ✅ supported | ✅ |  |
| `PostSubscriptionItems` | `POST /v1/subscription_items` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionItemsItem` | `GET /v1/subscription_items/{item}` | ✅ supported | ✅ |  |
| `PostSubscriptionItemsItem` | `POST /v1/subscription_items/{item}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteSubscriptionItemsItem` | `DELETE /v1/subscription_items/{item}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionSchedules` | `GET /v1/subscription_schedules` | ✅ supported | ✅ |  |
| `PostSubscriptionSchedules` | `POST /v1/subscription_schedules` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionSchedulesSchedule` | `GET /v1/subscription_schedules/{schedule}` | ✅ supported | ✅ |  |
| `PostSubscriptionSchedulesSchedule` | `POST /v1/subscription_schedules/{schedule}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSubscriptionSchedulesScheduleCancel` | `POST /v1/subscription_schedules/{schedule}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSubscriptionSchedulesScheduleRelease` | `POST /v1/subscription_schedules/{schedule}/release` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptions` | `GET /v1/subscriptions` | ✅ supported | ✅ |  |
| `PostSubscriptions` | `POST /v1/subscriptions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionsSubscriptionExposedId` | `GET /v1/subscriptions/{subscription_exposed_id}` | ✅ supported | ✅ |  |
| `PostSubscriptionsSubscriptionExposedId` | `POST /v1/subscriptions/{subscription_exposed_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteSubscriptionsSubscriptionExposedId` | `DELETE /v1/subscriptions/{subscription_exposed_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetTestHelpersTestClocks` | `GET /v1/test_helpers/test_clocks` | ✅ supported | ✅ |  |
| `PostTestHelpersTestClocks` | `POST /v1/test_helpers/test_clocks` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetTestHelpersTestClocksTestClock` | `GET /v1/test_helpers/test_clocks/{test_clock}` | ✅ supported | ✅ |  |
| `DeleteTestHelpersTestClocksTestClock` | `DELETE /v1/test_helpers/test_clocks/{test_clock}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostTestHelpersTestClocksTestClockAdvance` | `POST /v1/test_helpers/test_clocks/{test_clock}/advance` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetWebhookEndpoints` | `GET /v1/webhook_endpoints` | ✅ supported | ✅ |  |
| `PostWebhookEndpoints` | `POST /v1/webhook_endpoints` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetWebhookEndpointsWebhookEndpoint` | `GET /v1/webhook_endpoints/{webhook_endpoint}` | ✅ supported | ✅ |  |
| `PostWebhookEndpointsWebhookEndpoint` | `POST /v1/webhook_endpoints/{webhook_endpoint}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteWebhookEndpointsWebhookEndpoint` | `DELETE /v1/webhook_endpoints/{webhook_endpoint}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetStripeJs` | `GET /v3` | ✅ supported | ❌ disabled | the Stripe.js stand-in is JavaScript served by the mock in place of js.stripe.com/v3 |
