/**
 * The staging catalog, recorded: `GET /api/v2/products` against GxG staging as committed by our
 * consumer in `GXG/docs/gxg-list-products-dev.json` (answered byte for byte, in order). Product
 * codes are not in `ProductDto`; they come from the recorded webhook samples
 * (`GXG/docs/webhook-events.json`, `Order.Created` `OrderItems[].Product`).
 */
import type { ProductDto } from "./types.js"

export const CORPUS_VERSION = "gxg-staging-2026-06"

export const STAGING_PRODUCTS: readonly ProductDto[] = [
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
        name: "Standard Swab Domestic Kit with DHL Return Label",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "49f9c987-ba0e-4801-a3b3-b446a2d4835a",
          name: "Standard Swab Domestic Kit with DHL Return Label",
          description:
            "Standard Collection Kit With Vial & Swab & 6” x 9” Poly Mailer & Kit Instructions & Barcode & DHL Domestic Return Label",
          price: 5.5,
          productType: "Materials",
          isInsurable: false,
          shippingQualified: true,
          maxOrderingQuantity: 2000,
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
          price: 8,
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
          id: "56915a43-f03e-4219-b0af-d12d2ebe1a82",
          name: "Fulfillment Fee",
          description: "Fulfillment Fee",
          price: 6,
          productType: "Materials",
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
    id: "16c26d93-f4f4-4ea1-8f2e-9991d0ef938a",
    name: "B2B Comprehensive Wellness JSON Report and Raw Data Bundle",
    description: null,
    price: 0,
    productType: "Bundle",
    isInsurable: false,
    shippingQualified: null,
    maxOrderingQuantity: null,
    preassembly: false,
    components: [
      {
        name: "B2B Comprehensive Wellness JSON Report",
        quantity: 1,
        productType: "Digital Product",
        product: {
          id: "8dee4da8-5103-4209-bb91-b8beba6ee7e5",
          name: "B2B Comprehensive Wellness JSON Report",
          description: null,
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
        name: "Nutrigenomics Raw Data",
        quantity: 1,
        productType: "Digital Product",
        product: {
          id: "6780b983-d346-47bf-a93f-88a9d0a346b6",
          name: "Nutrigenomics Raw Data",
          description: null,
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
        name: "NT Custom Agena SNP Panel",
        quantity: 1,
        productType: "Lab Services",
        product: {
          id: "a7c9c265-6d31-4391-8e93-342d9617fef5",
          name: "NT Custom Agena SNP Panel",
          description: null,
          price: 0,
          productType: "Lab Services",
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
    id: "0d52219e-30a5-4a0d-b96d-0fe9a46d95e5",
    name: "Standard Swab Domestic Kit - DHL Return - Comprehensive Wellness JSON Report and Raw Data Bundle",
    description: null,
    price: 19.5,
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
          description: null,
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
        name: "DHL Domestic Parcel Return Label Fee",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "04b17b3d-7976-4b27-acb8-bb677fd9846d",
          name: "DHL Domestic Parcel Return Label Fee",
          description: "DHL Domestic Return Label Fee (Parcel Light)",
          price: 8,
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
          description: null,
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
        name: "Fulfillment Fee",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "56915a43-f03e-4219-b0af-d12d2ebe1a82",
          name: "Fulfillment Fee",
          description: "Fulfillment Fee",
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
        name: "Standard Swab Domestic Kit with DHL Return Label",
        quantity: 1,
        productType: "Materials",
        product: {
          id: "49f9c987-ba0e-4801-a3b3-b446a2d4835a",
          name: "Standard Swab Domestic Kit with DHL Return Label",
          description:
            "Standard Collection Kit With Vial & Swab & 6” x 9” Poly Mailer & Kit Instructions & Barcode & DHL Domestic Return Label",
          price: 5.5,
          productType: "Materials",
          isInsurable: false,
          shippingQualified: true,
          maxOrderingQuantity: 2000,
          preassembly: false,
          components: [],
        },
      },
    ],
  },
]

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
 * `GET /api/v2/eventTypes`. Swagger declares no body; the names are the events our consumer
 * subscribes to (`GXG/webhooks/gxg-webhook-events.ts`). `Kit.KitOrderLine.Canceled` is not
 * subscribable: the vendor answers 400 "Valid event type is required." when it is in `events[]`.
 */
export const EVENT_TYPES = [
  {
    id: 1,
    name: "GxG.Nucleus.Order.Created",
    description: "An order was created.",
    isSubscribable: true,
  },
  {
    id: 2,
    name: "GxG.Nucleus.Order.KitNumbersGenerated",
    description: "Kit numbers were generated for an order.",
    isSubscribable: true,
  },
  {
    id: 3,
    name: "GxG.Nucleus.Order.Shipped",
    description: "An order shipped and tracking numbers are available.",
    isSubscribable: true,
  },
  {
    id: 4,
    name: "GxG.Nucleus.Kit.Received",
    description: "A kit arrived at the lab.",
    isSubscribable: true,
  },
  {
    id: 5,
    name: "GxG.Nucleus.Kit.Completed",
    description: "Kit results were published.",
    isSubscribable: true,
  },
  {
    id: 6,
    name: "GxG.Nucleus.Kit.Error",
    description: "A kit has an error (delay, new collection needed, ...).",
    isSubscribable: true,
  },
  {
    id: 7,
    name: "GxG.Nucleus.Kit.KitOrderLine.Canceled",
    description: "A kit order line was canceled.",
    isSubscribable: false,
  },
] as const

/** `GET /api/v2/attributes`: the kit demographics attributes (`GXG/patients/gxg-kit-attributes.ts`). */
export const ATTRIBUTE_DEFINITIONS = [
  ["firstname", "First Name", 1],
  ["lastname", "Last Name", 1],
  ["dateofbirth", "Date of Birth", 3],
  ["gender", "Gender", 1],
  ["race", "Race", 1],
  ["ethnicity", "Ethnicity", 1],
  ["email", "Email", 1],
  ["phone", "Phone", 1],
].map(([name, displayName, attributeTypeId], index) => ({
  id: index + 1,
  name: name as string,
  alternateName: null,
  displayName: displayName as string,
  description: null,
  attributeTypeId: attributeTypeId as number,
  attributeTypeDescription: attributeTypeId === 3 ? "Date" : "Text",
  data: null,
  isReadOnly: false,
  allowsMultipleValues: false,
  sendToPipeLine: true,
  entityTypeId: 1,
}))

/** Courier services `getShippingOptions` offers for a domestic address, cheapest first. */
export const SHIPPING_OPTIONS = [
  {
    courierName: "DHL",
    courierServiceCode: "DHL_PARCEL_EXPEDITED",
    courierServiceDisplayName: "DHL - DHL Expedited",
    estimatedPrice: 14.91,
    transitDays: 4,
    attributes: {},
  },
  {
    courierName: "FedEx",
    courierServiceCode: "FEDEX_GROUND",
    courierServiceDisplayName: "FedEx - FedEx Ground",
    estimatedPrice: 17.35,
    transitDays: 5,
    attributes: {},
  },
  {
    courierName: "FedEx",
    courierServiceCode: "FEDEX_2_DAY_ONE_RATE",
    courierServiceDisplayName: "FedEx - FedEx 2Day One Rate",
    estimatedPrice: 24.5,
    transitDays: 2,
    attributes: { OneRate: "true" },
  },
] as const

/** Codes `POST /api/v2/orders` accepts besides {@link SHIPPING_OPTIONS} (our nonprod default). */
export const EXTRA_COURIER_CODES: Readonly<Record<string, string>> = {
  DHL_DOMESTIC_RETURN: "DHL - DHL Domestic Return",
}

/** Where return labels send kits: the Gene by Gene lab. */
export const LAB_RETURN_ADDRESS = {
  isCommercial: true,
  recipientName: "Gene by Gene",
  addressLine1: "1445 N Loop W",
  addressLine2: "Ste 820",
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

/** The tenant (Geviti) id the vendor reports on kits and subscriptions. */
export const TENANT_ID = "5c1f5d0e-7b1a-4c52-9a4e-2f0b6f3d1a77"
