import type {
  BalanceTransactionRecord,
  CustomerBalanceTransactionRecord,
  CustomerRecord,
  StripeState,
} from "./state.js"

export const postBalanceTransaction = async (
  state: StripeState,
  input: Omit<BalanceTransactionRecord, "id" | "net"> & { fee?: number },
) => {
  const id = await state.ids.next("txn_")
  const fee = input.fee ?? 0
  const record: BalanceTransactionRecord = {
    ...input,
    id,
    fee,
    net: input.amount - fee,
  }
  await state.balanceTransactions.insert(id, record)
  return record
}

export const recordCustomerBalance = async (
  state: StripeState,
  customer: CustomerRecord,
  amount: number,
  created: number,
  description: string | null,
) => {
  if (!customer.currency) return undefined
  const id = await state.ids.next("cbtxn_")
  const record: CustomerBalanceTransactionRecord = {
    id,
    amount,
    created,
    currency: customer.currency,
    customer: customer.id,
    description,
    ending_balance: customer.balance,
    metadata: {},
    type: "adjustment",
  }
  await state.customerBalanceTransactions.insert(id, record)
  return record
}
