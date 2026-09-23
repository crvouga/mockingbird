# Stripe API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **142**
- supported by the mock: **142**
- parity enabled: **142**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `GetAccount` | `GET /v1/account` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetBalance` | `GET /v1/balance` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetBalanceTransactions` | `GET /v1/balance_transactions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetBalanceTransactionsId` | `GET /v1/balance_transactions/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostBillingPortalSessions` | `POST /v1/billing_portal/sessions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCharges` | `GET /v1/charges` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostCharges` | `POST /v1/charges` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetChargesCharge` | `GET /v1/charges/{charge}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostChargesCharge` | `POST /v1/charges/{charge}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostChargesChargeCapture` | `POST /v1/charges/{charge}/capture` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetChargesChargeRefunds` | `GET /v1/charges/{charge}/refunds` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostChargesChargeRefunds` | `POST /v1/charges/{charge}/refunds` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetChargesChargeRefundsRefund` | `GET /v1/charges/{charge}/refunds/{refund}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostChargesChargeRefundsRefund` | `POST /v1/charges/{charge}/refunds/{refund}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetChargesSearch` | `GET /v1/charges/search` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCheckoutSessions` | `GET /v1/checkout/sessions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostCheckoutSessions` | `POST /v1/checkout/sessions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCheckoutSessionsSession` | `GET /v1/checkout/sessions/{session}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostCheckoutSessionsSession` | `POST /v1/checkout/sessions/{session}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostCheckoutSessionsSessionExpire` | `POST /v1/checkout/sessions/{session}/expire` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCheckoutSessionsSessionLineItems` | `GET /v1/checkout/sessions/{session}/line_items` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostConfirmationTokens` | `POST /v1/confirmation_tokens` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetConfirmationTokensConfirmationToken` | `GET /v1/confirmation_tokens/{confirmation_token}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCoupons` | `GET /v1/coupons` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostCoupons` | `POST /v1/coupons` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCouponsCoupon` | `GET /v1/coupons/{coupon}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostCouponsCoupon` | `POST /v1/coupons/{coupon}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteCouponsCoupon` | `DELETE /v1/coupons/{coupon}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostCustomerSessions` | `POST /v1/customer_sessions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCustomers` | `GET /v1/customers` | ✅ supported | ✅ |  |
| `PostCustomers` | `POST /v1/customers` | ✅ supported | ✅ |  |
| `GetCustomersCustomer` | `GET /v1/customers/{customer}` | ✅ supported | ✅ |  |
| `PostCustomersCustomer` | `POST /v1/customers/{customer}` | ✅ supported | ✅ |  |
| `DeleteCustomersCustomer` | `DELETE /v1/customers/{customer}` | ✅ supported | ✅ |  |
| `GetCustomersCustomerBalanceTransactions` | `GET /v1/customers/{customer}/balance_transactions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostCustomersCustomerBalanceTransactions` | `POST /v1/customers/{customer}/balance_transactions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCustomersCustomerBalanceTransactionsTransaction` | `GET /v1/customers/{customer}/balance_transactions/{transaction}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCustomersCustomerPaymentMethods` | `GET /v1/customers/{customer}/payment_methods` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCustomersSearch` | `GET /v1/customers/search` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetDisputes` | `GET /v1/disputes` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetDisputesDispute` | `GET /v1/disputes/{dispute}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetElementsSessions` | `GET /v1/elements/sessions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostElementsSessions` | `POST /v1/elements/sessions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostEphemeralKeys` | `POST /v1/ephemeral_keys` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteEphemeralKeysKey` | `DELETE /v1/ephemeral_keys/{key}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetEvents` | `GET /v1/events` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetEventsId` | `GET /v1/events/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoiceitems` | `GET /v1/invoiceitems` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoiceitems` | `POST /v1/invoiceitems` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoiceitemsInvoiceitem` | `GET /v1/invoiceitems/{invoiceitem}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoiceitemsInvoiceitem` | `POST /v1/invoiceitems/{invoiceitem}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteInvoiceitemsInvoiceitem` | `DELETE /v1/invoiceitems/{invoiceitem}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoices` | `GET /v1/invoices` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoices` | `POST /v1/invoices` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoicesInvoice` | `GET /v1/invoices/{invoice}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoicesInvoice` | `POST /v1/invoices/{invoice}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteInvoicesInvoice` | `DELETE /v1/invoices/{invoice}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoicesInvoiceFinalize` | `POST /v1/invoices/{invoice}/finalize` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoicesInvoiceLines` | `GET /v1/invoices/{invoice}/lines` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoicesInvoicePay` | `POST /v1/invoices/{invoice}/pay` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoicesInvoiceSend` | `POST /v1/invoices/{invoice}/send` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoicesInvoiceVoid` | `POST /v1/invoices/{invoice}/void` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostInvoicesCreatePreview` | `POST /v1/invoices/create_preview` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvoicesSearch` | `GET /v1/invoices/search` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetMandatesMandate` | `GET /v1/mandates/{mandate}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentIntents` | `GET /v1/payment_intents` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentIntents` | `POST /v1/payment_intents` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentIntentsIntent` | `GET /v1/payment_intents/{intent}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentIntentsIntent` | `POST /v1/payment_intents/{intent}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentIntentsIntentCancel` | `POST /v1/payment_intents/{intent}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentIntentsIntentCapture` | `POST /v1/payment_intents/{intent}/capture` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentIntentsIntentConfirm` | `POST /v1/payment_intents/{intent}/confirm` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentIntentsSearch` | `GET /v1/payment_intents/search` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentLinks` | `GET /v1/payment_links` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentLinks` | `POST /v1/payment_links` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentLinksPaymentLink` | `GET /v1/payment_links/{payment_link}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentLinksPaymentLink` | `POST /v1/payment_links/{payment_link}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentLinksPaymentLinkLineItems` | `GET /v1/payment_links/{payment_link}/line_items` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentMethods` | `GET /v1/payment_methods` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentMethods` | `POST /v1/payment_methods` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPaymentMethodsPaymentMethod` | `GET /v1/payment_methods/{payment_method}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentMethodsPaymentMethod` | `POST /v1/payment_methods/{payment_method}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentMethodsPaymentMethodAttach` | `POST /v1/payment_methods/{payment_method}/attach` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPaymentMethodsPaymentMethodDetach` | `POST /v1/payment_methods/{payment_method}/detach` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPayouts` | `GET /v1/payouts` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPayouts` | `POST /v1/payouts` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPayoutsPayout` | `GET /v1/payouts/{payout}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPayoutsPayout` | `POST /v1/payouts/{payout}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPayoutsPayoutCancel` | `POST /v1/payouts/{payout}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPrices` | `GET /v1/prices` | ✅ supported | ✅ |  |
| `PostPrices` | `POST /v1/prices` | ✅ supported | ✅ |  |
| `GetPricesPrice` | `GET /v1/prices/{price}` | ✅ supported | ✅ |  |
| `PostPricesPrice` | `POST /v1/prices/{price}` | ✅ supported | ✅ |  |
| `GetPricesSearch` | `GET /v1/prices/search` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetProducts` | `GET /v1/products` | ✅ supported | ✅ |  |
| `PostProducts` | `POST /v1/products` | ✅ supported | ✅ |  |
| `GetProductsId` | `GET /v1/products/{id}` | ✅ supported | ✅ |  |
| `PostProductsId` | `POST /v1/products/{id}` | ✅ supported | ✅ |  |
| `DeleteProductsId` | `DELETE /v1/products/{id}` | ✅ supported | ✅ |  |
| `GetProductsSearch` | `GET /v1/products/search` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPromotionCodes` | `GET /v1/promotion_codes` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPromotionCodes` | `POST /v1/promotion_codes` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPromotionCodesPromotionCode` | `GET /v1/promotion_codes/{promotion_code}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostPromotionCodesPromotionCode` | `POST /v1/promotion_codes/{promotion_code}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRefunds` | `GET /v1/refunds` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostRefunds` | `POST /v1/refunds` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRefundsRefund` | `GET /v1/refunds/{refund}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostRefundsRefund` | `POST /v1/refunds/{refund}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostRefundsRefundCancel` | `POST /v1/refunds/{refund}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSetupIntents` | `GET /v1/setup_intents` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSetupIntents` | `POST /v1/setup_intents` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSetupIntentsIntent` | `GET /v1/setup_intents/{intent}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSetupIntentsIntent` | `POST /v1/setup_intents/{intent}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSetupIntentsIntentCancel` | `POST /v1/setup_intents/{intent}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSetupIntentsIntentConfirm` | `POST /v1/setup_intents/{intent}/confirm` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSources` | `POST /v1/sources` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSourcesSource` | `GET /v1/sources/{source}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSourcesSource` | `POST /v1/sources/{source}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionItems` | `GET /v1/subscription_items` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSubscriptionItems` | `POST /v1/subscription_items` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionItemsItem` | `GET /v1/subscription_items/{item}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSubscriptionItemsItem` | `POST /v1/subscription_items/{item}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteSubscriptionItemsItem` | `DELETE /v1/subscription_items/{item}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptions` | `GET /v1/subscriptions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSubscriptions` | `POST /v1/subscriptions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionsSubscriptionExposedId` | `GET /v1/subscriptions/{subscription_exposed_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSubscriptionsSubscriptionExposedId` | `POST /v1/subscriptions/{subscription_exposed_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteSubscriptionsSubscriptionExposedId` | `DELETE /v1/subscriptions/{subscription_exposed_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostSubscriptionsSubscriptionResume` | `POST /v1/subscriptions/{subscription}/resume` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSubscriptionsSearch` | `GET /v1/subscriptions/search` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetTaxRates` | `GET /v1/tax_rates` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostTaxRates` | `POST /v1/tax_rates` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetTaxRatesTaxRate` | `GET /v1/tax_rates/{tax_rate}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostTaxRatesTaxRate` | `POST /v1/tax_rates/{tax_rate}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostTestHelpersConfirmationTokens` | `POST /v1/test_helpers/confirmation_tokens` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostTokens` | `POST /v1/tokens` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetTokensToken` | `GET /v1/tokens/{token}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetWebhookEndpoints` | `GET /v1/webhook_endpoints` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostWebhookEndpoints` | `POST /v1/webhook_endpoints` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetWebhookEndpointsWebhookEndpoint` | `GET /v1/webhook_endpoints/{webhook_endpoint}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PostWebhookEndpointsWebhookEndpoint` | `POST /v1/webhook_endpoints/{webhook_endpoint}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteWebhookEndpointsWebhookEndpoint` | `DELETE /v1/webhook_endpoints/{webhook_endpoint}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
