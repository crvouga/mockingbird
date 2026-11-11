import type { CatalogPlan } from "./state.js"

export type BillingAlignment = NonNullable<CatalogPlan["billingAlignment"]>

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "i").exec(xml)?.[1]

/**
 * The `<billingAlignment>` rule of a catalog, as Kill Bill applies it: the first
 * `<billingAlignmentCase>` whose filters (product, productCategory, billingPeriod, priceList) all
 * match the plan wins; with no matching case (or no rule at all) the alignment is ACCOUNT, Kill
 * Bill's default (issue #643: a catalog without the rule bills to the account's bill-cycle day).
 */
export const withBillingAlignment = (
  xml: string,
  plans: CatalogPlan[],
  periodOf: (plan: CatalogPlan) => string,
): CatalogPlan[] => {
  const rule = /<billingAlignment>([\s\S]*?)<\/billingAlignment>/i.exec(xml)?.[1] ?? ""
  const cases = [...rule.matchAll(/<billingAlignmentCase>([\s\S]*?)<\/billingAlignmentCase>/gi)]
    .map((match) => match[1] ?? "")
    .map((body) => ({
      product: tag(body, "product"),
      productCategory: tag(body, "productCategory")?.toUpperCase(),
      billingPeriod: tag(body, "billingPeriod")?.toUpperCase(),
      priceList: tag(body, "priceList"),
      alignment: tag(body, "alignment")?.toUpperCase(),
    }))
  return plans.map((plan) => {
    const found = cases.find(
      (row) =>
        (row.product === undefined || row.product === (plan.product ?? plan.name)) &&
        (row.productCategory === undefined || row.productCategory === "BASE") &&
        (row.billingPeriod === undefined || row.billingPeriod === periodOf(plan)) &&
        (row.priceList === undefined || row.priceList === "DEFAULT"),
    )?.alignment
    const billingAlignment: BillingAlignment =
      found === "SUBSCRIPTION" || found === "BUNDLE" ? found : "ACCOUNT"
    return { ...plan, billingAlignment }
  })
}

/** The day of the month of a `YYYY-MM-DD…` date. */
export const dayOfMonth = (date: string) => Number(date.slice(8, 10))
