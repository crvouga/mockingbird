/**
 * Vendor the Gene by Gene Nucleus API v2 contract into this package's `openapi.yaml`.
 *
 * The source of truth is the Swagger document our consumer commits
 * (`apps/backend/src/modules/lab-provider/lab-providers/gene-by-gene/transport/spec/gxg-openapi.json`,
 * fetched from `https://demo-api.genebygene.com/swagger/v2/swagger.json`: 50 operations, OpenAPI
 * 3.0.1). This script keeps every path and schema, and layers on:
 *
 * - an `operationId` per operation (the upstream spec has none),
 * - `x-mockingbird` support/parity metadata (operations our consumer never calls are
 *   `supported: false` with a reason),
 * - resource / volatile annotations for the parity runner,
 * - the fields the live API returns but Swagger omits (observed in the consumer's recorded
 *   samples: `ProductDto.preassembly`, `OrderLineDto.placerOrderNumber` / `kitNumbers`, …),
 * - schemas for the 200 bodies Swagger leaves undeclared (`eventTypes`, `kitorderlines/kits`,
 *   `results/search`, `presignedUrl`),
 * - every status the mock can answer (401 without a body, 404/422 problem details, 429),
 * - the auth host's `POST /connect/token` and the mock's own `GET /__blob/{key}`.
 *
 *   bun scripts/vendor-openapi.ts <path/to/gxg-openapi.json>
 *   bun run generate
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ADDRESS_CORPUS,
  COURIER_SERVICES,
  INTERNATIONAL_SERVICES,
  MAX_ADDRESS_LINE,
  RETURN_COURIER,
} from "../src/shipping.js"

type Json = Record<string, unknown>

const source = process.argv[2]
if (source === undefined) {
  console.error("usage: bun scripts/vendor-openapi.ts <path to the vendor's gxg-openapi.json>")
  process.exit(2)
}
const spec = JSON.parse(await readFile(source, "utf8")) as Json
const paths = spec.paths as Record<string, Record<string, Json>>
const schemas = (spec.components as { schemas: Record<string, Json> }).schemas

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: unknown) => ({ "application/json": { schema } })
const ERROR = ".ErrorDto"
const PROBLEM = ".ProblemDetails"

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

type Overlay = {
  id: string
  /** Why the mock skips it (unsupported), or undefined when supported. */
  skip?: string
  /** Side effects on a real tenant: never run by default live parity. */
  unsafe?: string
  /** Extra statuses the mock answers, beyond Swagger's. */
  add?: Record<string, Json>
  /** Replace the 200 response schema (Swagger's is missing or wrong). */
  ok?: unknown
}

const NOT_CALLED = "Our consumer never calls this endpoint (GXG/transport/gxg-client.ts)."
// Staging answers a missing resource with ErrorDto (`"message": "Resource not found."`, null
// payload and errorType), not problem details (recorded in corpus/live-errors.json).
const notFound = { "404": { description: "Not Found", content: json(ref(ERROR)) } }
const conflict = {
  "409": { description: "Not in a cancellable state (some tenants)", content: json(ref(ERROR)) },
}

const OPERATIONS: Record<string, Overlay> = {
  "get /api/v2/attributes": { id: "ListAttributeDefinitions" },
  "get /api/v2/attributes/{entityType}": {
    id: "ListAttributeDefinitionsByEntityType",
    skip: NOT_CALLED,
  },
  "get /api/v2/attributes/groups": { id: "ListAttributeGroups", skip: NOT_CALLED },
  "get /api/v2/attributes/groups/{name}": { id: "GetAttributeGroup", skip: NOT_CALLED },
  "post /api/v2/ehr/order": {
    id: "CreateEhrOrder",
    skip: "HL7 ORM ordering path; our consumer orders through POST /api/v2/orders only.",
  },
  "get /api/v2/ehr/results": {
    id: "GetEhrResults",
    skip: "HL7 ORU results path; our consumer reads results through /api/v2/results.",
  },
  "get /api/v2/eventTypes": {
    id: "ListEventTypes",
    ok: { type: "array", items: ref("EventTypeDto") },
  },
  "get /api/v2/fulfillments": { id: "ListFulfillments" },
  "post /api/v2/fulfillments/actions/updateShipmentAddress": {
    id: "UpdateShipmentAddress",
    unsafe: "changes where a real kit ships",
    add: notFound,
  },
  "delete /api/v2/fulfillments/{id}": {
    id: "CancelFulfillment",
    unsafe: "cancels a real fulfillment",
    add: { ...notFound, ...conflict },
  },
  "post /api/v2/fulfillments/actions/getShippingOptions": {
    id: "GetShippingOptions",
    // The carrier's refusal (a postal code that is not a ZIP, a ZIP3 in another state) is a 500
    // ErrorDto on staging; a staging-only product on the production tenant is an empty 500.
    add: {
      "500": {
        description: "Internal Server Error: the carrier's refusal (ErrorDto), or an empty body",
        content: json(ref(ERROR)),
      },
    },
  },
  "get /api/v2/kitorderlines": { id: "ListKitOrderLines", add: notFound },
  "delete /api/v2/kitorderlines": {
    id: "CancelKitOrderLinesBulk",
    skip: "Our consumer cancels per kit (DELETE /api/v2/kits/{kitNumber}/orderLines), never in bulk.",
  },
  "get /api/v2/kitorderlines/kits": {
    id: "ListKitOrderLineKits",
    ok: ref("KitOrderLineKitsPaginatedList"),
  },
  "get /api/v2/kitorderlines/download": { id: "DownloadKitOrderLines", skip: NOT_CALLED },
  "get /api/v2/kits": { id: "ListKits" },
  "get /api/v2/kits/{kitNumber}": { id: "GetKit", add: notFound },
  "delete /api/v2/kits/{kitNumber}": { id: "DeleteKit", skip: NOT_CALLED },
  "delete /api/v2/kits/{kitNumber}/orderLines": {
    id: "CancelKitOrderLines",
    unsafe: "cancels a real kit",
    add: { ...notFound, ...conflict },
  },
  "patch /api/v2/kits/{kitNumber}/gender/{gender}": {
    id: "SetKitGender",
    skip: "Superseded by PATCH /api/v2/kits/{kitNumber}/attributes, which our consumer uses.",
  },
  "get /api/v2/kits/{kitNumber}/orders": { id: "ListKitOrders", skip: NOT_CALLED },
  "get /api/v2/kits/{kitNumber}/results": { id: "GetKitResults", add: notFound },
  "patch /api/v2/kits/{kitNumber}/attributes": {
    id: "SetKitAttributes",
    unsafe: "writes demographics onto a real kit",
    add: {
      ...notFound,
      "422": { description: "Unprocessable attribute values", content: json(ref(PROBLEM)) },
    },
  },
  "delete /api/v2/kits/{kitNumber}/attributes": { id: "ClearKitAttributes", skip: NOT_CALLED },
  "patch /api/v2/kits/{kitNumber}/attributes/{name}={value}": {
    id: "SetKitAttribute",
    skip: NOT_CALLED,
  },
  "delete /api/v2/kits/{kitNumber}/attribute/{attributeName}": {
    id: "DeleteKitAttribute",
    skip: NOT_CALLED,
  },
  "post /api/v2/kits/actions/uploadKitAttributesCSV": {
    id: "UploadKitAttributesCsv",
    skip: NOT_CALLED,
  },
  "post /api/v2/kits/actions/{kitNumber}/uploadDocuments/{documentType}": {
    id: "UploadKitDocument",
    skip: NOT_CALLED,
  },
  "get /api/v2/notificationSubscriptions": { id: "ListNotificationSubscriptions" },
  "post /api/v2/notificationSubscriptions": {
    id: "CreateNotificationSubscription",
    unsafe: "registers a live webhook on the shared tenant",
  },
  "get /api/v2/notificationSubscriptions/{id}": {
    id: "GetNotificationSubscription",
    add: notFound,
  },
  "patch /api/v2/notificationSubscriptions/{id}": {
    id: "UpdateNotificationSubscription",
    unsafe: "repoints a live webhook",
    add: notFound,
  },
  "delete /api/v2/notificationSubscriptions/{id}": {
    id: "DeleteNotificationSubscription",
    unsafe: "deletes a live webhook",
    add: notFound,
  },
  "post /api/v2/notificationSubscriptions/{id}/actions/resetSecret": {
    id: "ResetNotificationSubscriptionSecret",
    skip: "Our consumer rotates a secret by deleting and re-creating the subscription.",
  },
  "get /api/v2/notificationSubscriptions/user/{id}/tenant/{tenantId}": {
    id: "ListUserNotificationSubscriptions",
    skip: NOT_CALLED,
  },
  "get /api/v2/orderLines/{id}": { id: "GetOrderLine", add: notFound },
  "delete /api/v2/orderLines/{id}": {
    id: "CancelOrderLine",
    unsafe: "cancels a real order line",
    add: { ...notFound, ...conflict },
  },
  "get /api/v2/orderLines/{id}/kits": { id: "ListOrderLineKits", skip: NOT_CALLED },
  "get /api/v2/orders": { id: "ListOrders" },
  "post /api/v2/orders": { id: "CreateOrder", unsafe: "places a real order (and ships a kit)" },
  "get /api/v2/orders/{id}": { id: "GetOrder", add: notFound },
  "post /api/v2/orders/actions/createOrderForExistingKits": {
    id: "CreateOrderForExistingKits",
    unsafe: "places a real lab order",
  },
  "get /api/v2/products": { id: "ListProducts", add: notFound },
  "get /api/v2/results": { id: "ListResults" },
  "post /api/v2/results": {
    id: "AddKitResult",
    skip: "Lab-side result ingestion; the mock publishes results through POST /__admin/kits/:kitNumber/transition.",
  },
  "get /api/v2/results/search": {
    id: "SearchResults",
    ok: ref("ResultsSearchPaginatedList"),
  },
  "get /api/v2/results/csvDownloads": { id: "DownloadResultsCsv", skip: NOT_CALLED },
  "get /api/v2/results/results/{resultId}/url": { id: "GetResultUrl", skip: NOT_CALLED },
  "get /api/v2/results/results/presignedUrl": {
    id: "GetResultPresignedUrl",
    ok: ref("PresignedUrlDto"),
  },
}

const METHODS = ["get", "post", "put", "patch", "delete"]
for (const [path, item] of Object.entries(paths)) {
  for (const method of METHODS) {
    const operation = item[method] as Json | undefined
    if (!operation) continue
    const overlay = OPERATIONS[`${method} ${path}`]
    if (!overlay) throw new Error(`no overlay for ${method.toUpperCase()} ${path}`)
    operation.operationId = overlay.id
    const responses = operation.responses as Record<string, Json>
    if (overlay.skip) {
      operation["x-mockingbird"] = { supported: false, reason: overlay.skip }
      continue
    }
    operation["x-mockingbird"] = overlay.unsafe
      ? { parity: { safe: false, reason: `Unsafe against a real tenant: ${overlay.unsafe}.` } }
      : { parity: { safe: true } }
    if (overlay.ok !== undefined) {
      const ok = responses["200"] ?? { description: "Success" }
      responses["200"] = { ...ok, content: json(overlay.ok) }
    }
    // ASP.NET model binding answers 400 as ValidationProblemDetails; the handlers answer ErrorDto.
    responses["400"] = {
      description: responses["400"]?.description ?? "Bad Request",
      content: json({ anyOf: [ref(ERROR), ref(PROBLEM)] }),
    }
    responses["401"] = {
      description: "Unauthorized - missing, expired or revoked bearer token (empty body).",
    }
    responses["429"] = { description: "Too Many Requests", content: json(ref(ERROR)) }
    responses["500"] = {
      description:
        responses["500"]?.description ?? "Internal Server Error (often with an empty body).",
    }
    Object.assign(responses, overlay.add ?? {})
    // ASP.NET rejects an empty body with a 400 problem: the body is required.
    const requestBody = operation.requestBody as Json | undefined
    if (requestBody) requestBody.required = true
  }
}

// ---------------------------------------------------------------------------------------------
// Parameters: references to resources the walks create
// ---------------------------------------------------------------------------------------------

// Upstream bug: `{tenantId}` is in the path but not declared.
const userSubscriptions = paths["/api/v2/notificationSubscriptions/user/{id}/tenant/{tenantId}"]
  ?.get as Json
userSubscriptions.parameters = [
  ...((userSubscriptions.parameters as Json[] | undefined) ?? []),
  { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
]

const MISSING_UUID = "00000000-0000-4000-8000-000000000000"
const parameter = (path: string, method: string, name: string, extension: Json) => {
  const list = (paths[path]?.[method]?.parameters ?? []) as Json[]
  const found = list.find((p) => p.name === name)
  if (!found) throw new Error(`no parameter ${name} on ${method} ${path}`)
  found.schema = { ...(found.schema as Json), ...extension }
}
const refTo = (type: string, missing = MISSING_UUID) => ({
  "x-mockingbird-resource-ref": { type, missing },
})
// Staging matches productCode with SQL LIKE (`a` and `%` list every product) against codes no
// response carries, so the walk cannot know a code; our consumer never filters by it.
parameter("/api/v2/products", "get", "productCode", {
  "x-mockingbird-unsupported": {
    reason: "Staging matches product codes with SQL LIKE, and no response carries a code.",
  },
})
// eventTypes' name is the same kind of LIKE (`ჷ` lists all 12); our consumer never filters.
parameter("/api/v2/eventTypes", "get", "name", {
  "x-mockingbird-unsupported": {
    reason:
      "Staging matches event-type names with SQL LIKE under a collation that ignores some characters.",
  },
})
// productType is a SQL LIKE too, under a collation that ignores some characters (`㏞` lists
// every product); our consumer never filters by it.
parameter("/api/v2/products", "get", "productType", {
  "x-mockingbird-unsupported": {
    reason:
      "Staging matches product types with SQL LIKE under a collation that ignores some characters.",
  },
})
parameter("/api/v2/orders/{id}", "get", "id", refTo("order"))
parameter("/api/v2/orderLines/{id}", "get", "id", refTo("orderLine"))
parameter("/api/v2/orderLines/{id}", "delete", "id", refTo("orderLine"))
parameter("/api/v2/fulfillments/{id}", "delete", "id", refTo("fulfillment"))
parameter("/api/v2/kits/{kitNumber}", "get", "kitNumber", refTo("kit", "WB000000"))
parameter("/api/v2/kits/{kitNumber}/results", "get", "kitNumber", refTo("kit", "WB000000"))
parameter("/api/v2/kits/{kitNumber}/orderLines", "delete", "kitNumber", refTo("kit", "WB000000"))
parameter("/api/v2/kits/{kitNumber}/attributes", "patch", "kitNumber", refTo("kit", "WB000000"))
for (const method of ["get", "patch", "delete"]) {
  parameter("/api/v2/notificationSubscriptions/{id}", method, "id", refTo("subscription"))
}
parameter("/api/v2/products", "get", "productId", refTo("product"))
parameter("/api/v2/fulfillments", "get", "orderId", refTo("order"))
parameter("/api/v2/kitorderlines", "get", "orderId", refTo("order"))
parameter("/api/v2/kitorderlines", "get", "kitNumbers", refTo("kit", "WB000000"))
parameter("/api/v2/results", "get", "kitNumber", refTo("kit", "WB000000"))

// ---------------------------------------------------------------------------------------------
// Schemas: fields the live API returns that Swagger omits, plus annotations
// ---------------------------------------------------------------------------------------------

const schemaNamed = (name: string): Json => {
  const schema = schemas[name]
  if (!schema) throw new Error(`no schema ${name}`)
  return schema
}
const props = (name: string) => {
  const schema = schemaNamed(name)
  if (!schema.properties) schema.properties = {}
  return schema.properties as Record<string, Json>
}
const annotate = (name: string, property: string, extension: Json) => {
  const all = props(name)
  const current = all[property]
  if (!current) throw new Error(`no property ${name}.${property}`)
  all[property] = { ...current, ...extension }
}
const identity = (type: string) => ({
  "x-mockingbird-resource": { type, identity: true },
  "x-mockingbird-volatile": { kind: "id" },
})
const volatile = (kind: string) => ({ "x-mockingbird-volatile": { kind } })

// Observed in docs/gxg-list-products-*.json.
props(".ProductDto").preassembly = { type: "boolean" }

// Mockingbird's schema walker does not follow cycles: break the two recursive schemas one
// level down with leaf copies (the live API nests exactly one level: component products carry
// `components: []`, and a kit-order-line's `orderLines` carry no further `orderLines`).
schemas[".ProductDto.Leaf"] = structuredClone(schemaNamed(".ProductDto"))
props(".ProductDto.Leaf").components = {
  type: "array",
  nullable: true,
  items: { type: "object", additionalProperties: true },
}
props(".ProductDto.Component").product = ref(".ProductDto.Leaf")
schemas[".KitOrderLineDto.Leaf"] = structuredClone(schemaNamed(".KitOrderLineDto"))
props(".KitOrderLineDto.Leaf").orderLines = {
  type: "array",
  nullable: true,
  items: { type: "object", additionalProperties: true },
}
props(".KitOrderLineDto").orderLines = {
  type: "array",
  nullable: true,
  items: ref(".KitOrderLineDto.Leaf"),
}
annotate(".ProductDto", "id", { "x-mockingbird-resource": { type: "product", identity: true } })

// Observed in docs/gxg-list-orders-prod.json (placerOrderNumber) and read by
// GXG/orders/gxg-order-kit-numbers.ts (kitNumbers).
Object.assign(props(".OrderLineDto"), {
  placerOrderNumber: { type: "string", nullable: true },
  kitNumbers: {
    type: "array",
    nullable: true,
    items: { type: "string", ...identity("kit") },
  },
})
annotate(".OrderDto", "id", identity("order"))
annotate(".OrderDto", "orderDate", volatile("timestamp"))
annotate(".OrderLineDto", "id", identity("orderLine"))
annotate(".OrderLineDto", "orderId", volatile("id"))
annotate(".FulfillmentDto", "id", identity("fulfillment"))
annotate(".FulfillmentDto", "orderLineId", volatile("id"))
annotate(".ShipmentDto", "id", identity("shipment"))
annotate(".ShipmentDto", "trackingNumber", volatile("opaque"))
annotate(".ShipmentDto", "reference1", volatile("opaque"))
annotate(".KitOrderLineDto", "kitNumber", volatile("id"))
annotate(".KitOrderLineDto", "orderId", volatile("id"))
annotate(".KitOrderLineDto", "orderLineId", volatile("id"))
annotate(".KitOrderLineDto", "orderDate", volatile("timestamp"))
annotate(".KitOrderLineDto", "kitReceivedDate", volatile("timestamp"))
annotate(".KitOrderLineDto", "kitEffectiveDate", volatile("timestamp"))
annotate(".KitDto", "kitNumber", volatile("id"))
annotate(".KitDto", "tenantId", volatile("account"))
annotate(".KitsOrdersDto", "kitNumber", volatile("id"))
annotate(".KitOrderDto", "id", volatile("id"))
annotate(".KitOrderDto", "orderDate", volatile("timestamp"))
annotate(".KitOrderLineStatusesDto", "orderLineId", volatile("id"))
annotate(".KitOrderLineStatusesDto", "orderId", volatile("id"))
annotate(".KitOrderLineStatusesDto", "orderDate", volatile("timestamp"))
annotate(".KitOrderLineStatusesDto", "fulfillmentId", volatile("id"))
annotate(".KitOrderLineStatusDto", "effectiveDate", volatile("timestamp"))
annotate(".KitResultsDto", "kitNumber", volatile("id"))
annotate(".KitOrderLineResultDto", "resultPayload", volatile("url"))
annotate(".KitOrderLineResultDto", "resultDate", volatile("timestamp"))
annotate(".KitOrderLineResultDto", "orderLineId", volatile("id"))
annotate(".KitOrderLineResultDto", "orderId", volatile("id"))
annotate(".KitOrderLineResultDto", "resultid", volatile("id"))
annotate(".ResultKitStatusDto", "resultPayload", volatile("url"))
annotate(".ResultKitStatusDto", "resultDate", volatile("timestamp"))
annotate(".ResultKitStatusDto", "orderLineId", volatile("id"))
annotate(".ResultKitStatusDto", "orderId", volatile("id"))
annotate(".ResultKitStatusDto", "kitNumber", volatile("id"))
annotate(".ResultKitStatusDto", "resultId", volatile("id"))
annotate(".ResultsStatusListDto", "resultPayload", volatile("url"))
annotate(".ResultsStatusListDto", "resultDate", volatile("timestamp"))
annotate(".NotificationSubscriptionDto", "id", identity("subscription"))
annotate(".NotificationSubscriptionDto", "tenantId", volatile("account"))
annotate(".NotificationSubscriptionDto", "secret", volatile("token"))
annotate("GetOrderLineItemByGuidResult", "id", volatile("id"))
annotate("GetOrderLineItemByGuidResult", "orderId", volatile("id"))
annotate("GetOrderLineItemByGuidResult", "orderDate", volatile("timestamp"))
annotate("GetOrderLineItemByGuidResult", "shippingDate", volatile("timestamp"))
annotate("GetOrderLineItemByGuidResult", "trackingNumber", volatile("opaque"))
annotate(".GetOrderLineItemByGuid.SiblingOrderLine", "id", volatile("id"))
annotate(
  ".GetAvailableShippingOptions.ShippingOptionDto",
  "estimatedShipDate",
  volatile("timestamp"),
)
annotate(
  ".GetAvailableShippingOptions.ShippingOptionDto",
  "estimatedDeliveryDate",
  volatile("timestamp"),
)
// `estimatedPrice` is not volatile: the mock's zone table is deterministic, so self-parity
// compares it. Live parity (scripts/parity.ts) compares code sets, never prices.
annotate("EditAddressCommand", "id", {
  "x-mockingbird-resource-ref": { type: "shipment", missing: MISSING_UUID },
})
// The shipment id is how the vendor finds what to edit; our consumer always sends it and the
// full address (the edit replaces, never merges).
schemaNamed("EditAddressCommand").required = ["id", "address"]

// The live API answers `null` for these object refs (docs/gxg-list-orders-prod.json).
for (const name of [".ShipmentDto", "EditAddressCommand"]) {
  props(name).courier = { ...ref(".CourierDto"), nullable: true }
  props(name).courierService = { ...ref(".CourierServiceDto"), nullable: true }
}
props(".KitOrderLineStatusesDto").fulfillment = { ...ref(".FulfillmentDto"), nullable: true }

// Request bodies: what our consumer always sends, and the fields it sends that Swagger omits.
const productRef = { "x-mockingbird-resource-ref": { type: "product", missing: MISSING_UUID } }
annotate(".GetAvailableShippingOptions.Query", "productId", productRef)
schemaNamed(".GetAvailableShippingOptions.Query").required = ["shippingAddress", "productId"]
annotate("CreateOrder_Item", "productId", productRef)
props("CreateOrder_Item").placerOrderNumber = {
  type: "string",
  nullable: true,
  description: "Our correlation id (`acme:<userId>:<nonce>`), echoed on order lines and webhooks.",
}
schemaNamed("CreateOrder_Item").required = ["productId"]
schemaNamed("CreateOrder").required = ["items"]
props("CreateOrder_Sample").kitNumber = { type: "string", nullable: true }
annotate("CreateOrderForExistingKits_Item", "productId", productRef)
props("CreateOrderForExistingKits_Item").samples = {
  type: "array",
  nullable: true,
  items: ref("CreateOrder_Sample"),
}
annotate("CreateOrderForExistingKits_Item", "kitNumbers", {
  items: {
    type: "string",
    "x-mockingbird-resource-ref": { type: "kit", missing: "WB000000" },
  },
})
schemaNamed("CreateOrderForExistingKits_Item").required = ["productId", "kitNumbers"]
schemaNamed("CreateOrderForExistingKits").required = ["items"]
schemaNamed("SetKitAttributeValues").required = ["attributes"]
schemaNamed("CreateNotificationSubscriptionCommand").required = ["endPoint", "events"]

// Constraints the vendor enforces (and our consumer always satisfies), so generated requests
// are meaningful: at least one item / event, positive quantities, the tenant's courier codes,
// http(s) endpoints (the 35-character address-line rule stays a handler error, as GxG answers
// it with its own "shipping address(es) not validated" message), and subscribable event names.
const SUBSCRIBABLE_EVENTS = [
  "GxG.Nucleus.Order.Created",
  "GxG.Nucleus.Order.KitNumbersGenerated",
  "GxG.Nucleus.Order.Shipped",
  "GxG.Nucleus.Kit.Received",
  "GxG.Nucleus.Kit.Completed",
  "GxG.Nucleus.Kit.Error",
]
annotate("CreateOrder", "items", { minItems: 1, maxItems: 2, nullable: false })
annotate("CreateOrder_Item", "quantity", { minimum: 1, maximum: 5 })
schemaNamed("CreateOrder_Shipment").required = ["address", "quantity", "courierServiceCode"]
annotate("CreateOrder_Shipment", "quantity", { minimum: 1, maximum: 3 })
// Generation hints that accept exactly what the vendor accepts. Each is `anyOf: [<the known
// values>, <the permissive schema>]`: validation passes any value the permissive branch takes
// (an unknown courier code is the handler's 400 "… not valid for shipping options", never a
// model-binding error; any AddressDto is judged by the handler's address checks), while the
// walks send the known values half the time, so they reach every address class.
const COURIER_CODES = [
  ...COURIER_SERVICES.map((s) => s.courierServiceCode),
  ...INTERNATIONAL_SERVICES.map((s) => s.courierServiceCode),
  RETURN_COURIER.courierServiceCode,
]
const courierCode = props("CreateOrder_Shipment").courierServiceCode as Json
props("CreateOrder_Shipment").courierServiceCode = {
  description: courierCode.description,
  anyOf: [
    { type: "string", enum: COURIER_CODES },
    { type: "string", nullable: true },
  ],
}
// Addresses the walks send besides random ones: quote-ok/place-ok, quote-ok/place-not-found
// (the production split), zone 8, and the structural refusals.
const corpusAddress = (row: (typeof ADDRESS_CORPUS)[number], isCommercial = false) => ({
  isCommercial,
  recipientName: "Mockingbird Test",
  addressLine1: row.addressLine1,
  addressLine2: null,
  city: row.city,
  stateOrRegion: row.stateOrRegion,
  postalCode: row.postalCode,
  countryCode: "US",
  email: "test@example.com",
  phone: "+15555550100",
})
// Interleaved (place-ok, place-not-found, …): fast-check's constantFrom favours early entries.
const placeOk = ADDRESS_CORPUS.filter((row) => row.kind === "quote-ok-place-ok")
const placeNotFound = ADDRESS_CORPUS.filter((row) => row.kind === "quote-ok-place-not-found")
const addressExamples = [
  ...placeOk.flatMap((row, i) => {
    const miss = placeNotFound[i % placeNotFound.length] as (typeof ADDRESS_CORPUS)[number]
    return [corpusAddress(row, i % 2 === 1), corpusAddress(miss, i % 2 === 0)]
  }),
  {
    ...corpusAddress(ADDRESS_CORPUS[0] as (typeof ADDRESS_CORPUS)[number]),
    addressLine1: "825 Fort Street",
    city: "Honolulu",
    stateOrRegion: "HI",
    postalCode: "96813",
  },
  {
    ...corpusAddress(ADDRESS_CORPUS[0] as (typeof ADDRESS_CORPUS)[number]),
    addressLine1: "x".repeat(MAX_ADDRESS_LINE + 1),
  },
  {
    ...corpusAddress(ADDRESS_CORPUS[0] as (typeof ADDRESS_CORPUS)[number]),
    addressLine1: "PO Box 100",
  },
]
const addressHint = {
  anyOf: [{ type: "object", enum: addressExamples }, ref(".AddressDto")],
}
props("CreateOrder_Shipment").address = addressHint
// A shipped place (one shipment, as our consumer sends) half the time; any list otherwise.
const shipments = props("CreateOrder_Item").shipments as Json
props("CreateOrder_Item").shipments = {
  description: shipments.description,
  anyOf: [
    { type: "array", minItems: 1, maxItems: 1, items: ref("CreateOrder_Shipment") },
    { type: "array", nullable: true, items: ref("CreateOrder_Shipment") },
  ],
}
props(".GetAvailableShippingOptions.Query").shippingAddress = addressHint
props("EditAddressCommand").address = addressHint
annotate("CreateOrderForExistingKits", "items", { minItems: 1, maxItems: 2, nullable: false })
annotate("CreateOrderForExistingKits_Item", "kitNumbers", {
  minItems: 1,
  maxItems: 2,
  nullable: false,
})
for (const name of [
  "CreateNotificationSubscriptionCommand",
  ".UpdateNotificationSubscription.Command",
]) {
  const create = name === "CreateNotificationSubscriptionCommand"
  annotate(name, "endPoint", { format: "uri", ...(create ? { nullable: false } : {}) })
  annotate(name, "events", {
    minItems: 1,
    // Any string binds; an unknown or unsubscribable name (`Kit.KitOrderLine.Canceled`) is the
    // handler's 400 ErrorDto "Valid event type is required.". Walks mostly send real names.
    items: { anyOf: [{ type: "string", enum: SUBSCRIBABLE_EVENTS }, { type: "string" }] },
    ...(create ? { nullable: false } : {}),
  })
  annotate(name, "type", { enum: ["webhook", "email", null] })
}

// ASP.NET validation problem details carry `errors` and `traceId` (additionalProperties: {}).
props(PROBLEM).errors = {
  type: "object",
  additionalProperties: { type: "array", items: { type: "string" } },
}
props(PROBLEM).traceId = { type: "string", ...volatile("id") }

// Bodies Swagger leaves undeclared.
const paginated = (item: unknown) => ({
  type: "object",
  required: ["offset", "pageSize", "totalCount", "items"],
  additionalProperties: false,
  properties: {
    offset: { type: "integer", format: "int32" },
    pageSize: { type: "integer", format: "int32" },
    totalCount: { type: "integer", format: "int32" },
    items: { type: "array", items: item },
  },
})
schemas.EventTypeDto = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    payloadStructure: { type: "string", nullable: true },
    subscriptionTypes: { type: "array", items: { type: "string" } },
  },
}
schemas.KitOrderLineKitsPaginatedList = paginated(ref(".KitOrderLineDto"))
schemas.ResultsSearchRow = {
  type: "object",
  additionalProperties: false,
  properties: {
    kitNumber: { type: "string", nullable: true, ...volatile("id") },
    orderId: { type: "string", format: "uuid", ...volatile("id") },
    orderLineId: { type: "string", format: "uuid", ...volatile("id") },
    firstName: { type: "string", nullable: true },
    lastName: { type: "string", nullable: true },
    dateOfBirth: { type: "string", nullable: true },
    resultId: { type: "string", format: "uuid", ...volatile("id") },
    resultType: { type: "string", nullable: true },
    resultTypeName: { type: "string", nullable: true },
    resultDate: { type: "string", format: "date-time", ...volatile("timestamp") },
    resultPayload: { type: "string", nullable: true, ...volatile("url") },
  },
}
schemas.ResultsSearchPaginatedList = paginated(ref("ResultsSearchRow"))
schemas.PresignedUrlDto = {
  type: "object",
  required: ["presignedUrl"],
  additionalProperties: false,
  properties: {
    presignedUrl: { type: "string", ...volatile("url") },
    resultId: { type: "string", format: "uuid", ...volatile("id") },
    kitNumber: { type: "string", nullable: true, ...volatile("id") },
    resultType: { type: "string", nullable: true },
    expiresAt: { type: "string", format: "date-time", ...volatile("timestamp") },
  },
}
schemas.TokenResponse = {
  type: "object",
  required: ["access_token", "expires_in", "token_type"],
  additionalProperties: false,
  properties: {
    access_token: { type: "string", ...volatile("token") },
    expires_in: { type: "integer" },
    token_type: { type: "string", enum: ["Bearer"] },
    scope: { type: "string" },
  },
}
schemas.OAuthError = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" }, error_description: { type: "string" } },
}

// ---------------------------------------------------------------------------------------------
// Paths the Swagger document does not carry
// ---------------------------------------------------------------------------------------------

paths["/connect/token"] = {
  post: {
    tags: ["Auth"],
    summary:
      "OAuth2 client-credentials token (served by the auth host, staging-auth.genebygene.com)",
    operationId: "PostConnectToken",
    security: [],
    "x-mockingbird": { parity: { safe: true } },
    requestBody: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            required: ["grant_type", "client_id", "client_secret"],
            properties: {
              grant_type: { type: "string", enum: ["client_credentials"] },
              client_id: { type: "string", minLength: 1 },
              client_secret: { type: "string", minLength: 1 },
              scope: { type: "string" },
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "Access token", content: json(ref("TokenResponse")) },
      "400": {
        description: "invalid_client / invalid_request / unsupported_grant_type",
        content: json(ref("OAuthError")),
      },
      "401": { description: "Blocked client", content: json(ref("OAuthError")) },
      "403": { description: "Forbidden client", content: json(ref("OAuthError")) },
      "429": { description: "Too Many Requests", content: json(ref(ERROR)) },
      "500": { description: "Internal Server Error" },
    },
  },
}
paths["/__blob/{key}"] = {
  get: {
    tags: ["Mockingbird"],
    summary:
      "Result bytes behind a presignedUrl (the mock's stand-in for the S3 presigned GET; not a GxG endpoint)",
    operationId: "GetResultBlob",
    security: [],
    "x-mockingbird": {
      parity: {
        enabled: false,
        reason: "Mock-only route; the real presigned URL points at S3, not the API host.",
      },
    },
    parameters: [
      { name: "key", in: "path", required: true, schema: { type: "string" } },
      { name: "X-Amz-Expires", in: "query", schema: { type: "string" } },
      { name: "X-Amz-Date", in: "query", schema: { type: "string" } },
      { name: "X-Amz-Signature", in: "query", schema: { type: "string" } },
    ],
    responses: {
      "200": {
        description: "The result object",
        content: {
          "application/json": { schema: {} },
          "application/pdf": { schema: { type: "string", format: "binary" } },
          "text/csv": { schema: { type: "string" } },
        },
      },
      "403": {
        description: "S3 AccessDenied (bad signature or expired)",
        content: { "application/xml": { schema: { type: "string" } } },
      },
      "404": {
        description: "S3 NoSuchKey",
        content: { "application/xml": { schema: { type: "string" } } },
      },
    },
  },
}

const info = spec.info as Json
info.title = "Nucleus API v2.0 (Gene by Gene), vendored for Mockingbird"
info.description = [
  "Gene by Gene's Nucleus API v2, vendored from the Swagger document our consumer commits",
  "(`GXG/transport/spec/gxg-openapi.json`, source https://demo-api.genebygene.com/swagger/v2/swagger.json)",
  "by `scripts/vendor-openapi.ts`, with operationIds, Mockingbird annotations, the fields the live",
  "API returns but Swagger omits, the auth host's `/connect/token`, and the mock's `/__blob/{key}`.",
].join("\n")
info["x-mockingbird-upstream"] = {
  swagger: "https://demo-api.genebygene.com/swagger/v2/swagger.json",
  docs: "https://api.genebygene.com/assets/GxG%20API%20Services%20Developer%20Guide%202022.pdf",
  stagingApi: "https://staging-api.genebygene.com",
  stagingAuth: "https://staging-auth.genebygene.com/connect/token",
}
spec.servers = [{ url: "https://staging-api.genebygene.com" }]

const yaml = Bun.YAML.stringify(spec, null, 2)
  .split("\n")
  .map((line) => line.trimEnd())
  .join("\n")
const header = [
  "# Generated by scripts/vendor-openapi.ts from the consumer's committed Swagger document;",
  "# edit the overlay in that script, not this file, then `bun run generate`.",
  "",
].join("\n")
await writeFile(join(import.meta.dir, "..", "openapi.yaml"), `${header}${yaml}\n`)
console.log(`wrote openapi.yaml from ${source}`)
