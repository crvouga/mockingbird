import { hmac, type WebhookSigner } from "@crvouga/mockingbird-service"
import type {
  AddressDto,
  FulfillmentRecord,
  KitRecord,
  LineRecord,
  OrderRecord,
  ResultRecord,
  ShipmentRecord,
} from "./types.js"

/**
 * Gene by Gene's notification events and their PascalCase bodies, shaped key for key like the
 * signed samples our consumer recorded (`GXG/docs/webhook-events.json`) and the zod schemas it
 * parses them with (`GXG/shared/gxg-zod-schemas.ts`).
 */
export const GXG_EVENTS = {
  orderCreated: "GxG.Nucleus.Order.Created",
  kitNumbersGenerated: "GxG.Nucleus.Order.KitNumbersGenerated",
  orderShipped: "GxG.Nucleus.Order.Shipped",
  kitReceived: "GxG.Nucleus.Kit.Received",
  kitCompleted: "GxG.Nucleus.Kit.Completed",
  kitError: "GxG.Nucleus.Kit.Error",
  kitOrderLineCanceled: "GxG.Nucleus.Kit.KitOrderLine.Canceled",
} as const

export type GxgEventType = (typeof GXG_EVENTS)[keyof typeof GXG_EVENTS]

export type GxgWebhook = { type: GxgEventType; body: Record<string, unknown> }

/** `gxg-signature: sha512=<hex HMAC-SHA512(secret, rawBody)>` (`GXG/webhooks/gxg-webhook-signature.ts`). */
export const signGxgWebhookBody = async (secret: string, rawBody: string): Promise<string> =>
  `sha512=${await hmac("SHA-512", secret, rawBody, "hex")}`

/**
 * The GxG delivery headers: `gxg-signature` over the exact bytes, `gxg-eventtype`, and
 * `gxg-notificationid` (the message id, a uuid). The event type is not part of what a signer
 * sees, so the runtime hands in a lookup by message id.
 */
export const gxgSigner =
  (eventTypeOf: (messageId: string) => string | undefined): WebhookSigner =>
  async ({ messageId, body, secret }) => ({
    "gxg-eventtype": eventTypeOf(messageId) ?? "",
    "gxg-notificationid": messageId,
    ...(secret ? { "gxg-signature": await signGxgWebhookBody(secret, body) } : {}),
  })

/** Kit numbers are `null` on `Order.Created` for new-kit orders (they are minted afterwards). */
export const orderCreatedBody = (
  order: OrderRecord,
  lines: readonly LineRecord[],
): Record<string, unknown> => ({
  // Known receiver bug, kept on purpose: our extractor reads `OrderId`, GxG sends `OrderGuid`.
  OrderGuid: order.id,
  OrderType: order.orderType,
  OrderItems: lines.map((line) => ({
    Id: line.id,
    Product: line.productCode,
    Quantity: line.quantity,
    KitNumbers: order.orderType === 3 && line.kitNumbers.length > 0 ? [...line.kitNumbers] : null,
    PlacerOrderNumber: line.placerOrderNumber,
  })),
})

export const kitNumbersGeneratedBody = (
  order: OrderRecord,
  lines: readonly LineRecord[],
): Record<string, unknown> => ({
  OrderId: order.id,
  OrderDate: order.orderDate,
  OrderLines: lines.map((line) => ({
    Id: line.id,
    Kits: [],
    Quantity: line.quantity,
    ProductId: line.productId,
    KitNumbers: [...line.kitNumbers],
    ProductName: line.productName,
    BundleProductId: line.bundleProductId,
    BundleProductName: line.bundleProductName,
    PlacerOrderNumber: line.placerOrderNumber,
  })),
})

const pascalAddress = (address: AddressDto) => ({
  City: address.city ?? null,
  Email: address.email ?? null,
  Phone: address.phone ?? null,
  PostalCode: address.postalCode ?? null,
  CountryCode: address.countryCode ?? null,
  AddressLine1: address.addressLine1 ?? null,
  AddressLine2: address.addressLine2 ?? null,
  IsCommercial: address.isCommercial === true,
  RecipientName: address.recipientName ?? null,
  StateOrRegion: address.stateOrRegion ?? null,
})

export type ShippedEntry = {
  fulfillment: FulfillmentRecord
  line: LineRecord
  outbound: ShipmentRecord
  returns: ShipmentRecord[]
}

export const orderShippedBody = (
  order: OrderRecord,
  entries: readonly ShippedEntry[],
): Record<string, unknown> => ({
  Shipments: entries.map(({ fulfillment, line, outbound, returns }) => ({
    Id: outbound.id,
    Address: pascalAddress(outbound.address),
    OrderId: order.id,
    Quantity: fulfillment.quantity,
    OrderDate: order.orderDate,
    ProductId: line.productId,
    KitNumbers: [...line.kitNumbers],
    OrderLineId: line.id,
    ProductName: line.productName,
    CloseoutDate: fulfillment.closeoutDate,
    ReturnLabels: returns.map((shipment, index) => ({
      Id: shipment.id,
      KitNumber: line.kitNumbers[index] ?? line.kitNumbers[0] ?? null,
      TrackingNumber: shipment.trackingNumber,
    })),
    FulfillmentId: fulfillment.id,
    TrackingNumber: outbound.trackingNumber,
    BundleProductId: line.bundleProductId,
    IsInternational: fulfillment.isInternational,
    BundleProductName: line.bundleProductName,
    PlacerOrderNumber: line.placerOrderNumber,
    CourierServiceCode: outbound.courierServiceCode,
    CourierServiceName: outbound.courierServiceName,
  })),
})

export const kitReceivedBody = (kit: KitRecord): Record<string, unknown> => ({
  KitNumber: kit.kitNumber,
})

export const kitCompletedBody = (
  kit: KitRecord,
  line: LineRecord,
  results: readonly ResultRecord[],
): Record<string, unknown> => ({
  Results: results.map((result) => ({
    ResultDate: result.resultDate,
    ResultType: result.resultType,
    ResultPayload: result.resultPayload,
    ResultTypeName: result.resultTypeName,
  })),
  KitNumber: kit.kitNumber,
  ProductId: line.productId,
  OrderLineId: line.id,
  ProductCode: line.productCode,
  ProductType: line.productType,
  AlternateKitId: null,
  PlacerOrderNumber: line.placerOrderNumber,
  ProductDisplayName: line.productName,
})

export const kitErrorBody = (
  kit: KitRecord,
  line: LineRecord,
  errorCode: number,
  errorMessage: string,
): Record<string, unknown> => ({
  ErrorCode: errorCode,
  KitNumber: kit.kitNumber,
  OrderLineId: line.id,
  ProductCode: line.productCode,
  ErrorMessage: errorMessage,
  AlternateKitId: null,
  PlacerOrderNumber: line.placerOrderNumber,
})

export const kitOrderLineCanceledBody = (
  kit: KitRecord,
  line: LineRecord,
  canceledAt: string,
): Record<string, unknown> => ({
  OrderId: line.orderId,
  OrderLineId: line.id,
  KitNumber: kit.kitNumber,
  PlacerOrderNumber: line.placerOrderNumber,
  CancelCodeId: kit.cancelCodeId,
  CanceledAt: canceledAt,
})

/** The messages `Kit.Error` carries for the codes our consumer branches on. */
export const KIT_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  4: "10 Day Delay",
  19: "New collection requested",
}
