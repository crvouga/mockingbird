/**
 * The two recorded catalogs, answered byte for byte and in order by `GET /api/v2/products`:
 *
 * - {@link PRODUCTION_PRODUCTS}: `GET /api/v2/products` against GxG production, as our consumer
 *   committed it (`GXG/docs/gxg-list-products-prod.json`). The deluxe bundle our consumer places
 *   (`789af544-…`) and its kit component (`b1949749-…`, `preassembly: true`) live here.
 * - {@link STAGING_PRODUCTS}: the same call against staging, as live parity recorded it
 *   (`corpus/live-catalogs.json`; `GXG/docs/gxg-list-products-dev.json` had drifted).
 *
 * `PUT /__admin/settings {"catalog": "production" | "staging" | "both"}` picks which one a
 * namespace answers (default `both`: production rows, then the staging rows production lacks).
 * Product codes are not in `ProductDto`; they come from the recorded webhook samples
 * (`GXG/docs/webhook-events.json`, `Order.Created` `OrderItems[].Product`).
 */
import liveCatalogs from "./corpus/live-catalogs.json" with { type: "json" }
import type { AttributeDefinitionDto, EventTypeDto, ProductDto } from "./types.js"

export const CORPUS_VERSION = "gxg-2026-06"

export const PRODUCTION_PRODUCTS: readonly ProductDto[] = [
  {
    id: "6780b983-d346-47bf-a93f-88a9d0a346b6",
    name: "Nutrigenomics Raw Data",
    description: "NT - Nutrigenomics Wellness Raw Data",
    price: 0,
    productType: "Digital Product",
    isInsurable: false,
    shippingQualified: null,
    maxOrderingQuantity: null,
    preassembly: false,
    components: [],
  },
  {
    id: "8dee4da8-5103-4209-bb91-b8beba6ee7e5",
    name: "B2B Comprehensive Wellness JSON Report",
    description: null,
    price: 189,
    productType: "Digital Product",
    isInsurable: false,
    shippingQualified: null,
    maxOrderingQuantity: null,
    preassembly: false,
    components: [],
  },
  {
    id: "9b0e0491-c27b-4d85-9872-643d4126e571",
    name: "B2B Comprehensive Wellness JSON Report Bundle",
    description: null,
    price: 189,
    productType: "Bundle",
    isInsurable: false,
    shippingQualified: null,
    maxOrderingQuantity: null,
    preassembly: false,
    components: [
      {
        name: "NT Custom Agena SNP Panel",
        quantity: 1,
        productType: "Lab Services",
        product: {
          id: "a7c9c265-6d31-4391-8e93-342d9617fef5",
          name: "NT Custom Agena SNP Panel",
          description: "NT Custom Agena SNP Panel Lab Service",
          price: 0,
          productType: "Lab Services",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
      {
        name: "B2B Comprehensive Wellness JSON Report",
        quantity: 1,
        productType: "Digital Product",
        product: {
          id: "8dee4da8-5103-4209-bb91-b8beba6ee7e5",
          name: "B2B Comprehensive Wellness JSON Report",
          description: null,
          price: 189,
          productType: "Digital Product",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
    ],
  },
  {
    id: "789af544-270c-40ff-9677-c492a87262cd",
    name: "Deluxe Swab Domestic Kit - DHL Return - Comprehensive Wellness JSON Report and Raw Data Bundle",
    description:
      "Standard Swab Domestic Kit - DHL Return - B2B Comprehensive Wellness Report Bundle -  Lab Service and Digital Product - JSON and Raw Data Bundle",
    price: 205.5,
    productType: "Bundle",
    isInsurable: false,
    shippingQualified: null,
    maxOrderingQuantity: null,
    preassembly: false,
    components: [
      {
        name: "NT Custom Agena SNP Panel",
        quantity: 1,
        productType: "Lab Services",
        product: {
          id: "a7c9c265-6d31-4391-8e93-342d9617fef5",
          name: "NT Custom Agena SNP Panel",
          description: "NT Custom Agena SNP Panel Lab Service",
          price: 0,
          productType: "Lab Services",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
      {
        name: "DHL Domestic Parcel Return Label Fee",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "04b17b3d-7976-4b27-acb8-bb677fd9846d",
          name: "DHL Domestic Parcel Return Label Fee",
          description: "DHL Domestic Return Label Fee (Parcel Light)",
          price: 6,
          productType: "Materials",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
      {
        name: "Deluxe Swab Domestic Kit with DHL Return Label",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "b1949749-19b0-4f72-a5c5-8f2414656607",
          name: "Deluxe Swab Domestic Kit with DHL Return Label",
          description: "Deluxe Kit with 2 Buccal Swabs & 2 Vials & DHL Return Label",
          price: 5,
          productType: "Materials",
          isInsurable: false,
          shippingQualified: true,
          maxOrderingQuantity: 500,
          preassembly: true,
          components: [],
        },
      },
      {
        name: "Fulfillment Fee",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "b269bcdc-f373-45e2-bbc6-3aa05e664f52",
          name: "Fulfillment Fee",
          description:
            "Logistics services that may include kit assembly, shipment preparation, inventory maintenance and build level management.",
          price: 5.5,
          productType: "Materials",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
      {
        name: "Nutrigenomics Raw Data",
        quantity: 1,
        productType: "Digital Product",
        product: {
          id: "6780b983-d346-47bf-a93f-88a9d0a346b6",
          name: "Nutrigenomics Raw Data",
          description: "NT - Nutrigenomics Wellness Raw Data",
          price: 0,
          productType: "Digital Product",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
      {
        name: "B2B Comprehensive Wellness JSON Report",
        quantity: 1,
        productType: "Digital Product",
        product: {
          id: "8dee4da8-5103-4209-bb91-b8beba6ee7e5",
          name: "B2B Comprehensive Wellness JSON Report",
          description: null,
          price: 189,
          productType: "Digital Product",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
    ],
  },
  {
    id: "a5190f53-01c8-4966-aead-adbf20f0dbf6",
    name: "Standard Swab Domestic Kit - DHL Return - Collection Bundle",
    description: "Standard Swab Domestic Kit - DHL Return - Collection Bundle",
    price: 19.5,
    productType: "Bundle",
    isInsurable: false,
    shippingQualified: null,
    maxOrderingQuantity: null,
    preassembly: false,
    components: [
      {
        name: "DHL Domestic Parcel Return Label Fee",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "04b17b3d-7976-4b27-acb8-bb677fd9846d",
          name: "DHL Domestic Parcel Return Label Fee",
          description: "DHL Domestic Return Label Fee (Parcel Light)",
          price: 6,
          productType: "Materials",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
      {
        name: "Fulfillment Fee",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "b269bcdc-f373-45e2-bbc6-3aa05e664f52",
          name: "Fulfillment Fee",
          description:
            "Logistics services that may include kit assembly, shipment preparation, inventory maintenance and build level management.",
          price: 5.5,
          productType: "Materials",
          isInsurable: false,
          shippingQualified: null,
          maxOrderingQuantity: null,
          preassembly: false,
          components: [],
        },
      },
      {
        name: "Standard Swab Domestic Kit with DHL Return Label",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "49f9c987-ba0e-4801-a3b3-b446a2d4835a",
          name: "Standard Swab Domestic Kit with DHL Return Label",
          description:
            "Standard Collection Kit With Vial & Swab & 6” x 9” Poly Mailer & Kit Instructions & Barcode & DHL Domestic Return Label",
          price: 8,
          productType: "Materials",
          isInsurable: false,
          shippingQualified: true,
          maxOrderingQuantity: 2000,
          preassembly: true,
          components: [],
        },
      },
    ],
  },
]

/** Staging's catalog as live parity recorded it (`live-catalogs.json`): the walk compares it byte for byte. */
export const STAGING_PRODUCTS: readonly ProductDto[] = liveCatalogs.stagingProducts as ProductDto[]

/** `OrderItems[].Product` / `ProductCode` as the webhooks report them, by product id. */
export const PRODUCT_CODES: Readonly<Record<string, string>> = {
  "a7c9c265-6d31-4391-8e93-342d9617fef5": "nt_custom_agena_panel",
  "56915a43-f03e-4219-b0af-d12d2ebe1a82": "fulfillment_fee",
  "49f9c987-ba0e-4801-a3b3-b446a2d4835a": "standard_swab_domestic_kit_dhl_return",
  "04b17b3d-7976-4b27-acb8-bb677fd9846d": "return_label_dhl_sm_parcel_fee",
  "8dee4da8-5103-4209-bb91-b8beba6ee7e5": "ngx_report_comprehensive_json",
  "6780b983-d346-47bf-a93f-88a9d0a346b6": "ngx_raw_data",
  "0d52219e-30a5-4a0d-b96d-0fe9a46d95e5": "standard_swab_dhl_return_wellness_bundle",
  "a5190f53-01c8-4966-aead-adbf20f0dbf6": "standard_swab_dhl_return_collection_bundle",
  "16c26d93-f4f4-4ea1-8f2e-9991d0ef938a": "b2b_wellness_json_raw_data_bundle",
}

/**
 * `GET /api/v2/eventTypes` and `GET /api/v2/attributes`, as live parity recorded them
 * (`live-catalogs.json`). Swagger declares neither body.
 */
export const EVENT_TYPES: readonly EventTypeDto[] = liveCatalogs.eventTypes

/**
 * What `POST /api/v2/notificationSubscriptions` accepts in `events[]`: the listed event types.
 * `Kit.KitOrderLine.Canceled` is sent but not listed, so the vendor answers 400 "Valid event type
 * is required." when it is subscribed to.
 */
export const SUBSCRIBABLE_EVENTS: ReadonlySet<string> = new Set(EVENT_TYPES.map((e) => e.name))

export const ATTRIBUTE_DEFINITIONS: readonly AttributeDefinitionDto[] = liveCatalogs.attributes

/** The definition for an attribute name, matched without case (`firstname` is `firstName`). */
export const attributeDefinition = (name: string): AttributeDefinitionDto | undefined =>
  ATTRIBUTE_DEFINITIONS.find((d) => d.name.toLowerCase() === name.toLowerCase())

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

/** The tenant (the consumer app's account) id the vendor reports on kits and subscriptions. */
export const TENANT_ID = "5c1f5d0e-7b1a-4c52-9a4e-2f0b6f3d1a77"

export type Catalog = "production" | "staging" | "both"
export const CATALOGS: readonly Catalog[] = ["production", "staging", "both"]

/** The rows `GET /api/v2/products` answers for a namespace's `catalog` setting. */
export const catalogProducts = (catalog: Catalog): readonly ProductDto[] => {
  if (catalog === "production") return PRODUCTION_PRODUCTS
  if (catalog === "staging") return STAGING_PRODUCTS
  const ids = new Set(PRODUCTION_PRODUCTS.map((p) => p.id))
  return [...PRODUCTION_PRODUCTS, ...STAGING_PRODUCTS.filter((p) => !ids.has(p.id))]
}

/**
 * Staging-only product ids. Quoting one against the production tenant is an empty HTTP 500
 * (observed for the staging standard bundle `0d52219e-…`), not a 400.
 */
export const STAGING_ONLY_IDS: ReadonlySet<string> = new Set(
  STAGING_PRODUCTS.filter((p) => !PRODUCTION_PRODUCTS.some((q) => q.id === p.id)).map((p) => p.id),
)

/** The production bundle our consumer places (Deluxe swab, DHL return, wellness JSON + raw data). */
export const DELUXE_BUNDLE_ID = "789af544-270c-40ff-9677-c492a87262cd"
