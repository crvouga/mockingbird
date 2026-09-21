import { supportedOperationIds } from "./generated/openapi.js"

/** Browser surfaces (hosted page, Stripe.js stand-in) that only the mock serves. */
const BROWSER_OPS: readonly string[] = [
  "GetCheckoutPage",
  "PostCheckoutPage",
  "GetStripeJs",
  "PostThreeDSecureAuthenticate",
]

/**
 * The Stripe surface the QA suites exercise: every operation the vendored contract marks
 * supported (the unsupported ones answer a Stripe-shaped error by design and are listed with
 * reasons in SUPPORT.md). Derived from the document so the list can never drift from the contract.
 */
export const QA_SURFACE_OPS: readonly string[] = supportedOperationIds.filter(
  (id) => !BROWSER_OPS.includes(id),
)

/**
 * Operations whose answer depends on the whole real account rather than on what a walk created
 * (its profile, lifetime balance, lingering test clocks, configured webhook endpoints). Offline
 * walks cover them; live walks leave them out.
 */
export const ACCOUNT_GLOBAL_OPS: readonly string[] = [
  "GetAccount",
  "GetBalance",
  "GetBalanceTransactions",
  "GetTestHelpersTestClocks",
  "GetWebhookEndpoints",
]

/** Pinned values the suites use, so offline walks exercise realistic shapes. */
export const QA_METADATA = {
  intent: "e2e-test",
  source: "e2e-test",
  userId: "1001",
} as const

export const QA_AMOUNTS = [1000, 15000, 17999] as const

export const QA_CUSTOMER = {
  email: "qa+e2e@test.example.com",
  name: "Ada Lovelace",
  phone: "+15555550123",
} as const

/** Test payment methods and card tokens the suites attach by id. */
export const QA_TEST_PAYMENT_METHODS = [
  "pm_card_visa",
  "pm_card_mastercard",
  "pm_card_authenticationRequired",
] as const

export const QA_TEST_CARD_TOKENS = [
  "tok_visa",
  "tok_mastercard",
  "tok_chargeDeclinedInsufficientFunds",
  "tok_chargeDeclinedExpiredCard",
  "tok_chargeCustomerFail",
] as const

/** Search queries the suites issue, covering every metadata key their handlers read. */
export const QA_SEARCH_QUERIES = [
  "metadata['userId']:'1001'",
  "metadata['paymentId']:'1001'",
  "metadata['billingInvoiceId']:'inv_1001'",
  "email:'qa+e2e@test.example.com'",
] as const

/** Coupon / promotion-code fixture values used by the shop and coupon flows. */
export const QA_COUPON_CODES = ["QA10", "QA-FREE-BLOODWORK"] as const
