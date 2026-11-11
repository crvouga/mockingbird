import type { CatalogPlan } from "./state.js"

type Input = Record<string, unknown>

/** The entries of a refund's `adjustments` list that name an invoice item. */
export const refundAdjustments = (adjustments: unknown): Input[] =>
  Array.isArray(adjustments)
    ? adjustments
        .filter((entry): entry is Input => !!entry && typeof entry === "object")
        .filter((entry) => typeof entry.invoiceItemId === "string")
    : []

/** A CatalogApiException Kill Bill answers for a plan it cannot find. */
export type CatalogMiss = { code: number; message: string }

/**
 * The plan a subscription change asks for, by `planName` or by `productName` + `billingPeriod`
 * (+ `priceList`), or the CatalogApiException Kill Bill 0.24.10 answers when the catalog has none
 * (#651): 2021 no plan by that name, 2030 no such product, 2020 no plan for that product and
 * billing period. The emulator keeps a single price list, so `priceList` only appears in the
 * message (best guess, not oracle-verified: a plan of another price list matches too).
 */
export const resolvePlanSpec = (
  body: Input,
  plans: CatalogPlan[],
  periodOf: (plan: CatalogPlan) => string,
): { plan: CatalogPlan } | { miss: CatalogMiss } | undefined => {
  if (typeof body.planName === "string" && body.planName) {
    const plan = plans.find((row) => row.name === body.planName)
    return plan
      ? { plan }
      : { miss: { code: 2021, message: `Could not find any plans named '${body.planName}'` } }
  }
  if (typeof body.productName !== "string" || !body.productName) return undefined
  const product = body.productName
  const products = plans.filter((row) => (row.product ?? row.name) === product)
  if (products.length === 0)
    return { miss: { code: 2030, message: `Could not find any product named '${product}'` } }
  const period = typeof body.billingPeriod === "string" ? body.billingPeriod : undefined
  const plan = products.find((row) => period === undefined || periodOf(row) === period)
  if (plan) return { plan }
  const priceList = typeof body.priceList === "string" ? body.priceList : "DEFAULT"
  return {
    miss: {
      code: 2020,
      message: `Could not find a plan matching spec: (plan: 'undefined', product: '${product}', billing period: '${period}', pricelist '${priceList}')`,
    },
  }
}
