import type { Db } from "../ports/db.js"

export type LabTestRow = {
  id: string
  name: string
  description: string
  category: string
  price_cents: number
  catalog_test_id: string
}

export const insertLabTest = async (
  db: Db,
  test: {
    id: string
    name: string
    description: string
    category: string
    priceCents: number
    catalogTestId: string
  },
): Promise<void> => {
  await db.query(
    `INSERT INTO lab_tests (id, name, description, category, price_cents, catalog_test_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [test.id, test.name, test.description, test.category, test.priceCents, test.catalogTestId],
  )
}

export const listLabTests = async (db: Db): Promise<LabTestRow[]> =>
  db.query<LabTestRow>(`SELECT * FROM lab_tests ORDER BY name`)

export const findLabTestsByIds = async (db: Db, ids: readonly string[]): Promise<LabTestRow[]> => {
  if (ids.length === 0) return []
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ")
  return db.query<LabTestRow>(`SELECT * FROM lab_tests WHERE id IN (${placeholders})`, [...ids])
}
