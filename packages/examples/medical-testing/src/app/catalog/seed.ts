import { insertLabTest } from "../db/labTestsRepo.js"
import type { Db } from "../ports/db.js"
import type { LabTestingClient } from "../ports/labTestingClient.js"

export type SeedLabTest = {
  name: string
  description: string
  category: string
  priceCents: number
}

export const CATALOG: readonly SeedLabTest[] = [
  {
    name: "Basic Metabolic Panel",
    description: "Glucose, electrolytes, and kidney function — 8 biomarkers.",
    category: "Popular",
    priceCents: 4900,
  },
  {
    name: "Complete Blood Count",
    description: "Red cells, white cells, platelets, and hemoglobin.",
    category: "Popular",
    priceCents: 3500,
  },
  {
    name: "Lipid Panel",
    description: "Total cholesterol, LDL, HDL, and triglycerides.",
    category: "Heart & Metabolic",
    priceCents: 3900,
  },
  {
    name: "HbA1c",
    description: "Average blood sugar over the past 2–3 months.",
    category: "Heart & Metabolic",
    priceCents: 4500,
  },
  {
    name: "Thyroid Panel",
    description: "TSH, free T3, and free T4.",
    category: "Hormones",
    priceCents: 6900,
  },
  {
    name: "Testosterone, Total",
    description: "A single marker of overall testosterone level.",
    category: "Hormones",
    priceCents: 5900,
  },
]

export const CATEGORY_ORDER = ["Popular", "Heart & Metabolic", "Hormones"] as const

/** Seeds the shop's catalog, pointing each row at a real provider-side catalog test id. */
export const seedCatalog = async (db: Db, labTesting: LabTestingClient): Promise<void> => {
  const catalog = await labTesting.listCatalog()
  if (catalog.length === 0) throw new Error("Lab testing provider returned an empty catalog")
  for (const [index, test] of CATALOG.entries()) {
    const entry = catalog[index % catalog.length]
    if (!entry) throw new Error("Lab testing provider catalog is empty")
    await insertLabTest(db, {
      id: crypto.randomUUID(),
      name: test.name,
      description: test.description,
      category: test.category,
      priceCents: test.priceCents,
      catalogTestId: entry.catalogTestId,
    })
  }
}
