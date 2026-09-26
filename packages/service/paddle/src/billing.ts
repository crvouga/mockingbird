import type {
  Interval,
  LineItem,
  PreviewDetails,
  PreviewLineItem,
  PriceRecord,
  ProductRecord,
  TimePeriod,
  Totals,
  TransactionDetails,
  TransactionTotals,
} from "./entities.js"

/** Amounts are strings of minor units; the mock never charges tax or discounts (see README). */
const money = (n: number) => String(Math.max(0, Math.round(n)))

const ZERO = "0"

export const addPeriod = (iso: string, period: TimePeriod): string => {
  const date = new Date(iso)
  const n = period.frequency
  switch (period.interval as Interval) {
    case "day":
      date.setUTCDate(date.getUTCDate() + n)
      break
    case "week":
      date.setUTCDate(date.getUTCDate() + 7 * n)
      break
    case "month": {
      const day = date.getUTCDate()
      date.setUTCDate(1)
      date.setUTCMonth(date.getUTCMonth() + n)
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
      date.setUTCDate(Math.min(day, last))
      break
    }
    case "year":
      date.setUTCFullYear(date.getUTCFullYear() + n)
      break
  }
  return date.toISOString()
}

export const samePeriod = (a: TimePeriod | null, b: TimePeriod | null) =>
  a !== null && b !== null && a.interval === b.interval && a.frequency === b.frequency

/** The price a country pays: the matching override, else the base unit price. */
export const unitAmount = (price: PriceRecord, countryCode: string | null): number => {
  const override = countryCode
    ? price.unit_price_overrides.find((o) => o.country_codes.includes(countryCode))
    : undefined
  return Number((override ?? price).unit_price.amount)
}

const totalsOf = (amount: number): Totals => ({
  subtotal: money(amount),
  discount: ZERO,
  tax: ZERO,
  total: money(amount),
})

export type Priced = {
  price: PriceRecord
  product: ProductRecord
  quantity: number
  /** `include_in_totals: false` preview items are listed but not summed. */
  counted?: boolean
}

export const previewLineItem = (item: Priced, countryCode: string | null): PreviewLineItem => {
  const unit = unitAmount(item.price, countryCode)
  return {
    price_id: item.price.id,
    quantity: item.quantity,
    proration: null,
    tax_rate: ZERO,
    unit_totals: totalsOf(unit),
    totals: totalsOf(unit * item.quantity),
    product: item.product,
  }
}

export const transactionTotals = (
  lines: { totals: Totals }[],
  currencyCode: string,
): TransactionTotals => {
  const subtotal = lines.reduce((sum, line) => sum + Number(line.totals.subtotal), 0)
  return {
    subtotal: money(subtotal),
    discount: ZERO,
    tax: ZERO,
    total: money(subtotal),
    credit: ZERO,
    credit_to_balance: ZERO,
    balance: ZERO,
    grand_total: money(subtotal),
    grand_total_tax: ZERO,
    fee: null,
    earnings: null,
    currency_code: currencyCode,
  }
}

export const previewDetails = (
  items: Priced[],
  currencyCode: string,
  countryCode: string | null,
): PreviewDetails => {
  const lines = items.map((item) => previewLineItem(item, countryCode))
  const counted = lines.filter((_, i) => items[i]?.counted !== false)
  const totals = transactionTotals(counted, currencyCode)
  return {
    tax_rates_used: [
      {
        tax_rate: ZERO,
        totals: {
          subtotal: totals.subtotal,
          discount: ZERO,
          tax: ZERO,
          total: totals.total,
        },
      },
    ],
    totals,
    line_items: lines,
  }
}

export const transactionDetails = (lines: LineItem[], currencyCode: string): TransactionDetails => {
  const totals = transactionTotals(lines, currencyCode)
  return {
    tax_rates_used: [
      {
        tax_rate: ZERO,
        totals: { subtotal: totals.subtotal, discount: ZERO, tax: ZERO, total: totals.total },
      },
    ],
    totals,
    adjusted_totals: {
      subtotal: totals.subtotal,
      tax: ZERO,
      total: totals.total,
      grand_total: totals.grand_total,
      grand_total_tax: ZERO,
      fee: null,
      earnings: null,
      currency_code: currencyCode,
      retained_fee: ZERO,
    },
    payout_totals: null,
    adjusted_payout_totals: null,
    line_items: lines,
  }
}
