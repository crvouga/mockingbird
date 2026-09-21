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

/** The MedPax box SKU Makor orders every pack under (`longeviti_blend_sku` in its config). */
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
 * (`geviti-emr-backend/tests/unit/services/wholescripts-service.test.ts`: Test Product 1/2,
 * Vitamin D3, Vitamin D Complex, Calcium, Protein Powder, PL001, PLC001), with the fixture's
 * repeated `medPaxSku`s made unique, plus the Makor MedPax box and `medPaxDetails` rows the
 * Makor catalog sync reads. `Protein Powder` is out of stock (`instockonly` drops it).
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
      productName: "Longeviti Blend MedPax Box",
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
