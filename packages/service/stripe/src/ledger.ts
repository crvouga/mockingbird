import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { resourceMissing } from "./errors.js"
import { requestScope, type Services, stringOf } from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { queryParams } from "./params.js"
import { renderBalanceTransaction } from "./render.js"
import { type BalanceTransactionRecord, seconds } from "./state.js"

/**
 * The account's balance ledger (`txn_`): one line per captured charge (with Stripe's
 * 2.9% + 30¢ fee) and per refund, plus the account and balance objects built from it.
 */
export const ledgerHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetBalanceTransactions: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const type = stringOf(params, "type")
    const source = stringOf(params, "source")
    const currency = stringOf(params, "currency")
    const now = seconds(scope.now)
    return jsonResponse(
      200,
      await paginate<BalanceTransactionRecord>(scope.account.ledger, params, {
        url: "/v1/balance_transactions",
        kind: "balance_transaction",
        where: (record) =>
          matchesCreated(record.created, params.created) &&
          (type === null || record.type === type) &&
          (source === null || record.source === source) &&
          (currency === null || record.currency === currency),
        render: (record) => renderBalanceTransaction(record, now),
      }),
    )
  },
  GetBalanceTransactionsId: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const id = context.params.id ?? ""
    const record = scope.account.ledger.get(id)
    if (!record) throw resourceMissing("balance transaction", id, "id")
    return jsonResponse(200, renderBalanceTransaction(record, seconds(scope.now)))
  },
  GetAccount: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const config = services.accounts.config(scope.account.account)
    const name = config?.displayName ?? null
    return jsonResponse(200, {
      id: scope.account.account,
      object: "account",
      business_profile: { name, support_email: null, url: null },
      business_type: null,
      charges_enabled: true,
      country: "US",
      created: 1_600_000_000,
      default_currency: "usd",
      details_submitted: true,
      email: null,
      metadata: {},
      payouts_enabled: true,
      type: "standard",
    })
  },
  GetBalance: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const now = seconds(scope.now)
    let available = 0
    let pending = 0
    for (const entry of scope.account.ledger.list()) {
      if (now >= entry.value.available_on) available += entry.value.net
      else pending += entry.value.net
    }
    return jsonResponse(200, {
      object: "balance",
      available: [{ amount: available, currency: "usd", source_types: { card: available } }],
      livemode: false,
      pending: [{ amount: pending, currency: "usd", source_types: { card: pending } }],
    })
  },
})
