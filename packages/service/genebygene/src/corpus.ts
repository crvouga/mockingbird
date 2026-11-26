import type { AttributeDefinitionDto, EventTypeDto, ProductDto } from "./types.js"

export const CORPUS_VERSION = "synthetic-v1"

function product(
  number: number,
  name: string,
  productType: string,
  extra: Partial<ProductDto> = {},
): ProductDto {
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    name,
    productType,
    description: null,
    price: number,
    isInsurable: false,
    shippingQualified: null,
    maxOrderingQuantity: null,
    preassembly: false,
    components: [],
    ...extra,
  }
}

const lab = product(1, "Example lab", "Lab Services")
const report = product(2, "Example report", "Digital Product")
const data = product(3, "Example data", "Digital Product")
const label = product(4, "Example shipping label", "Materials")
const handling = product(5, "Example handling", "Service")
const kit = product(7, "Example collection kit", "Materials", {
  shippingQualified: true,
  preassembly: true,
})
const deluxeKit = product(8, "Example boxed kit", "Materials", {
  shippingQualified: true,
  preassembly: true,
  price: 5,
  maxOrderingQuantity: 500,
})

function bundle(number: number, name: string, parts: ProductDto[]) {
  return product(number, name, "Bundle", {
    components: parts.map((product) => ({
      name: product.name,
      productType: product.productType,
      quantity: 1,
      product,
    })),
  })
}

const deluxe = bundle(10, "Example boxed panel", [lab, label, deluxeKit, handling, data, report])
const collection = bundle(11, "Example collection", [kit, label, handling])
export const DELUXE_BUNDLE_ID = deluxe.id
export const PRODUCTION_PRODUCTS = [
  data,
  report,
  bundle(9, "Example analysis", [lab, report]),
  deluxe,
  collection,
]
export const STAGING_PRODUCTS = [
  collection,
  bundle(12, "Example digital panel", [report, data, lab]),
  bundle(13, "Example shipped panel", [lab, report, label, data, handling, kit]),
]
export const PRODUCT_CODES: Readonly<Record<string, string>> = { [lab.id]: "example_lab" }

export const EVENT_TYPES: readonly EventTypeDto[] = [
  "GxG.Nucleus.Order.Created",
  "GxG.Nucleus.Kit.Error",
  "GxG.Nucleus.Kit.Completed",
  "GxG.Nucleus.Kit.Received",
  "GxG.Nucleus.Order.Shipped",
  "GxG.Nucleus.Observation.ResultsAvailable",
  "GxG.Nucleus.Order.KitNumbersGenerated",
  "GxG.Nucleus.Kit.StatusChanged",
  "GxG.Nucleus.Kit.ReadyForPgxPipeline",
  "GxG.Nucleus.ShipmentTracking.Updated",
  "GxG.Nucleus.Kit.ReadyForPrsPipeline",
  "GxG.Nucleus.Kit.ReadyForMonogenicPipeline",
].map((name) => ({ name, payloadStructure: null, subscriptionTypes: ["Webhook", "Email"] }))

export const ATTRIBUTE_DEFINITIONS: readonly AttributeDefinitionDto[] = [
  "firstName",
  "lastName",
  "dateOfBirth",
  "gender",
  "race",
  "ethnicity",
].map((name, i) => ({
  id: i + 1,
  name,
  alternateName: null,
  displayName: name,
  description: null,
  attributeTypeId: 1,
  attributeTypeDescription: "String",
  data: null,
  isReadOnly: false,
  allowsMultipleValues: false,
  sendToPipeLine: null,
  entityTypeId: 3,
}))

/** Where return labels send kits: the Gene by Gene lab. */
export const LAB_RETURN_ADDRESS = {
  isCommercial: true,
  recipientName: "Gene by Gene",
  addressLine1: "1445 N Loop W",
  addressLine2: null,
  addressLine3: null,
  city: "Houston",
  stateOrRegion: "TX",
  postalCode: "77008",
  countryCode: "US",
  email: null,
  phone: null,
  shippingInstruction: null,
  referenceId: null,
} as const

export const TENANT_ID = "00000000-0000-4000-8000-000000000014"
export type Catalog = "production" | "staging" | "both"
export const CATALOGS: readonly Catalog[] = ["production", "staging", "both"]

export type GeneByGeneCorpus = {
  productionProducts: readonly ProductDto[]
  stagingProducts: readonly ProductDto[]
  productCodes?: Readonly<Record<string, string>>
  reportProductId?: string
  rawDataProductId?: string
  defaultProductId?: string
  attributes?: readonly AttributeDefinitionDto[]
  eventTypes?: readonly EventTypeDto[]
  tenantId?: string
}

export const DEFAULT_CORPUS: GeneByGeneCorpus = {
  productionProducts: PRODUCTION_PRODUCTS,
  stagingProducts: STAGING_PRODUCTS,
  productCodes: PRODUCT_CODES,
  defaultProductId: DELUXE_BUNDLE_ID,
  reportProductId: report.id,
  rawDataProductId: data.id,
}

export const catalogProducts = (
  catalog: Catalog,
  corpus = DEFAULT_CORPUS,
): readonly ProductDto[] => {
  if (catalog === "production") return corpus.productionProducts
  if (catalog === "staging") return corpus.stagingProducts
  const ids = new Set(corpus.productionProducts.map((p) => p.id))
  return [...corpus.productionProducts, ...corpus.stagingProducts.filter((p) => !ids.has(p.id))]
}
