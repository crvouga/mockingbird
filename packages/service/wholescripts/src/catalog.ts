/** MedPax-specific pricing and stock, present on products that can go into a MedPax pack. */
export type MedPaxDetails = {
  name: string
  genericName: string
  quantity: number
  wholesalePrice: number
  retailPrice: number
}

/** One `GET /api/Orders/ProductList` row, in the field names our consumers parse. */
export type Product = {
  productName: string
  sku: string
  medPaxSku: string
  categories: string
  retailPrice: number
  upc: string
  descriptionShort: string
  descriptionFull?: string
  brand: string
  productImage: string
  quantity: number
  countUnit: string
  wholesalePrice: number
  supplementFactsHTML: string
  defaultDosing: { time: string; qty: number }[]
  medPaxDetails?: MedPaxDetails | null
}

/** One `medPaxPills` row of `GET /api/Orders/PrivateLabelProductList`. */
export type MedPaxPill = {
  sku: string
  genericName: string
  privateLabelName: string
  quantity: number
}

/** One `privateLabelCartons` row of `GET /api/Orders/PrivateLabelProductList`. */
export type PrivateLabelCarton = {
  sku: string
  name: string
  cartonImage: string
  quantity: number
}

export type Catalog = {
  products: Product[]
  medPaxPills: MedPaxPill[]
  privateLabelCartons: PrivateLabelCarton[]
}

/** The MedPax box SKU the supplement scheduler orders every pack under (`acme_blend_sku` in its config). */
export const MEDPAX_BOX_SKU = "000000000200095263"

const product = (
  row: Omit<Product, "upc" | "productImage" | "supplementFactsHTML" | "brand"> &
    Partial<Pick<Product, "upc" | "productImage" | "supplementFactsHTML" | "brand">>,
): Product => ({
  upc: `1234567${row.sku.replace(/\D/g, "").padStart(5, "0")}`,
  productImage: `https://example.com/${row.sku.toLowerCase()}.jpg`,
  supplementFactsHTML: "<div>Facts</div>",
  brand: "Test Brand",
  ...row,
})

/**
 * The catalog every namespace starts with. The rows are the ones our consumers' own tests use
 * (the consumer app's `wholescripts-service.test.ts`: Test Product 1/2,
 * Vitamin D3, Vitamin D Complex, Calcium, Protein Powder, PL001, PLC001), with the fixture's
 * repeated `medPaxSku`s made unique, plus the scheduler's MedPax box and `medPaxDetails` rows the
 * scheduler's catalog sync reads. `Protein Powder` is out of stock (`instockonly` drops it).
 */
export const DEFAULT_CATALOG: Catalog = {
  products: [
    product({
      productName: "Test Product 1",
      sku: "SKU001",
      medPaxSku: "MP001",
      categories: "Supplements",
      retailPrice: 29.99,
      upc: "123456789001",
      descriptionShort: "Test product 1 description",
      productImage: "https://example.com/image1.jpg",
      quantity: 100,
      countUnit: "capsules",
      wholesalePrice: 19.99,
      defaultDosing: [{ time: "AM", qty: 1 }],
    }),
    product({
      productName: "Test Product 2",
      sku: "SKU002",
      medPaxSku: "MP002",
      categories: "Vitamins",
      retailPrice: 39.99,
      upc: "123456789002",
      descriptionShort: "Test product 2 description",
      productImage: "https://example.com/image2.jpg",
      quantity: 50,
      countUnit: "tablets",
      wholesalePrice: 29.99,
      defaultDosing: [{ time: "PM", qty: 2 }],
    }),
    product({
      productName: "Vitamin D3",
      sku: "VD001",
      medPaxSku: "MPVD001",
      categories: "Vitamins,Supplements",
      retailPrice: 19.99,
      descriptionShort: "Vitamin D3 supplement",
      quantity: 100,
      countUnit: "capsules",
      wholesalePrice: 14.99,
      defaultDosing: [{ time: "AM", qty: 1 }],
      medPaxDetails: {
        name: "Vitamin D3 5000 IU",
        genericName: "Cholecalciferol",
        quantity: 400,
        wholesalePrice: 0.12,
        retailPrice: 0.2,
      },
    }),
    product({
      productName: "Vitamin D Complex",
      sku: "VD002",
      medPaxSku: "MPVD002",
      categories: "Vitamins",
      retailPrice: 29.99,
      descriptionShort: "Vitamin D complex supplement",
      quantity: 50,
      countUnit: "tablets",
      wholesalePrice: 24.99,
      defaultDosing: [{ time: "PM", qty: 2 }],
    }),
    product({
      productName: "Calcium",
      sku: "CA001",
      medPaxSku: "MPCA001",
      categories: "Minerals",
      retailPrice: 19.99,
      descriptionShort: "Calcium supplement",
      quantity: 100,
      countUnit: "capsules",
      wholesalePrice: 14.99,
      defaultDosing: [{ time: "AM", qty: 1 }],
      medPaxDetails: {
        name: "Calcium Citrate",
        genericName: "Calcium citrate",
        quantity: 0,
        wholesalePrice: 0.1,
        retailPrice: 0.18,
      },
    }),
    product({
      productName: "Protein Powder",
      sku: "PP001",
      medPaxSku: "MPPP001",
      categories: "Supplements",
      retailPrice: 49.99,
      descriptionShort: "Protein powder",
      quantity: 0,
      countUnit: "grams",
      wholesalePrice: 34.99,
      defaultDosing: [{ time: "AM", qty: 1 }],
    }),
    product({
      productName: "Acme Longevity Blend MedPax Box",
      sku: MEDPAX_BOX_SKU,
      medPaxSku: "",
      categories: "MedPax",
      retailPrice: 0,
      descriptionShort: "30-day AM/PM MedPax carton",
      quantity: 1000,
      countUnit: "box",
      wholesalePrice: 0,
      defaultDosing: [],
    }),
  ],
  medPaxPills: [
    {
      sku: "PL001",
      genericName: "Generic Name 1",
      privateLabelName: "Private Label Product 1",
      quantity: 30,
    },
    {
      sku: "MP001",
      genericName: "Generic Pill 1",
      privateLabelName: "MedPax Pill 1",
      quantity: 30,
    },
    {
      sku: "MP002",
      genericName: "Generic Pill 2",
      privateLabelName: "MedPax Pill 2",
      quantity: 60,
    },
  ],
  privateLabelCartons: [
    {
      sku: "PLC001",
      name: "Private Label Carton 1",
      cartonImage: "https://example.com/carton1.jpg",
      quantity: 30,
    },
  ],
}

/** Every SKU a submit may reference: product SKUs, MedPax SKUs, pill and carton SKUs. */
export const orderableSkus = (catalog: Catalog): Set<string> => {
  const skus = new Set<string>()
  for (const p of catalog.products) {
    skus.add(p.sku)
    if (p.medPaxSku) skus.add(p.medPaxSku)
  }
  for (const pill of catalog.medPaxPills) skus.add(pill.sku)
  for (const carton of catalog.privateLabelCartons) skus.add(carton.sku)
  return skus
}

/** The wholesale unit price a SKU is billed at (0 for cartons and unknown SKUs). */
export const unitPrice = (catalog: Catalog, sku: string): number => {
  for (const p of catalog.products) {
    if (p.sku === sku) return p.wholesalePrice
    if (p.medPaxSku && p.medPaxSku === sku)
      return p.medPaxDetails?.wholesalePrice ?? p.wholesalePrice
  }
  return 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (row: Record<string, unknown>, key: string, where: string, fallback?: string) => {
  const value = row[key]
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== "string") throw new Error(`${where}.${key} must be a string`)
  return value
}

const count = (row: Record<string, unknown>, key: string, where: string) => {
  const value = row[key] ?? 0
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${where}.${key} must be a number`)
  return value
}

const list = (value: unknown, where: string): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  return value.map((row, index) => {
    if (!isRecord(row)) throw new Error(`${where}[${index}] must be an object`)
    return row
  })
}

/**
 * Check a catalog document and fill the fields a row may leave out. The document is
 * `{products?, medPaxPills?, privateLabelCartons?}` (or a bare array of products); a row needs
 * its `sku` (and a product its `productName`), and every other string defaults to `""`,
 * every number to `0`, and `defaultDosing` to none. Throws a message naming the bad field.
 */
export const parseCatalogDocument = (input: unknown): Partial<Catalog> => {
  const document = Array.isArray(input) ? { products: input } : input
  if (!isRecord(document))
    throw new Error("expected {products?, medPaxPills?, privateLabelCartons?}")
  for (const key of Object.keys(document))
    if (!["products", "medPaxPills", "privateLabelCartons"].includes(key))
      throw new Error(`unknown key ${JSON.stringify(key)}`)
  const out: Partial<Catalog> = {}
  if (document.products !== undefined)
    out.products = list(document.products, "products").map((row, index): Product => {
      const where = `products[${index}]`
      const sku = text(row, "sku", where)
      if (!sku) throw new Error(`${where}.sku must not be empty`)
      const base = {
        productName: text(row, "productName", where),
        sku,
        medPaxSku: text(row, "medPaxSku", where, ""),
        categories: text(row, "categories", where, ""),
        retailPrice: count(row, "retailPrice", where),
        upc: text(row, "upc", where, ""),
        descriptionShort: text(row, "descriptionShort", where, ""),
        brand: text(row, "brand", where, ""),
        productImage: text(row, "productImage", where, ""),
        quantity: count(row, "quantity", where),
        countUnit: text(row, "countUnit", where, ""),
        wholesalePrice: count(row, "wholesalePrice", where),
        supplementFactsHTML: text(row, "supplementFactsHTML", where, ""),
        defaultDosing: Array.isArray(row.defaultDosing)
          ? (row.defaultDosing as Product["defaultDosing"])
          : [],
      }
      return {
        ...base,
        ...(row.descriptionFull !== undefined
          ? { descriptionFull: text(row, "descriptionFull", where) }
          : {}),
        ...(row.medPaxDetails !== undefined
          ? {
              medPaxDetails:
                row.medPaxDetails === null
                  ? null
                  : (() => {
                      const details = row.medPaxDetails
                      if (!isRecord(details))
                        throw new Error(`${where}.medPaxDetails must be an object`)
                      const at = `${where}.medPaxDetails`
                      return {
                        name: text(details, "name", at, ""),
                        genericName: text(details, "genericName", at, ""),
                        quantity: count(details, "quantity", at),
                        wholesalePrice: count(details, "wholesalePrice", at),
                        retailPrice: count(details, "retailPrice", at),
                      }
                    })(),
            }
          : {}),
      }
    })
  if (document.medPaxPills !== undefined)
    out.medPaxPills = list(document.medPaxPills, "medPaxPills").map((row, index) => {
      const where = `medPaxPills[${index}]`
      const sku = text(row, "sku", where)
      if (!sku) throw new Error(`${where}.sku must not be empty`)
      return {
        sku,
        genericName: text(row, "genericName", where, ""),
        privateLabelName: text(row, "privateLabelName", where, ""),
        quantity: count(row, "quantity", where),
      }
    })
  if (document.privateLabelCartons !== undefined)
    out.privateLabelCartons = list(document.privateLabelCartons, "privateLabelCartons").map(
      (row, index) => {
        const where = `privateLabelCartons[${index}]`
        const sku = text(row, "sku", where)
        if (!sku) throw new Error(`${where}.sku must not be empty`)
        return {
          sku,
          name: text(row, "name", where, ""),
          cartonImage: text(row, "cartonImage", where, ""),
          quantity: count(row, "quantity", where),
        }
      },
    )
  return out
}

const mergeRows = <T extends { sku: string }>(
  base: readonly T[],
  extra: readonly T[] = [],
): T[] => {
  const replacements = new Map(extra.map((row) => [row.sku, row]))
  const kept = base.map((row) => replacements.get(row.sku) ?? row)
  const present = new Set(base.map((row) => row.sku))
  const added = new Map<string, T>()
  for (const row of extra) if (!present.has(row.sku)) added.set(row.sku, row)
  return [...kept, ...added.values()]
}

/**
 * Lay `extra` onto `base`: a row with a SKU `base` already has replaces it in place, any other
 * is appended, and a list `extra` leaves out is kept as it is.
 */
export const mergeCatalog = (base: Catalog, extra: Partial<Catalog>): Catalog => ({
  products: mergeRows(base.products, extra.products),
  medPaxPills: mergeRows(base.medPaxPills, extra.medPaxPills),
  privateLabelCartons: mergeRows(base.privateLabelCartons, extra.privateLabelCartons),
})
