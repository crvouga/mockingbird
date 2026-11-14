import { buildSchema, type GraphQLSchema } from "graphql"

/**
 * The subset of the Shopify Admin GraphQL schema a fulfilment backend touches: orders (created
 * directly or through a draft order), their fulfilment status and tracking, product variants,
 * metafields and webhook subscriptions. Type, field, argument, enum and input names are
 * Shopify's own, so documents written against the real API validate and execute unchanged; a
 * field outside this subset fails validation exactly as a typo would.
 */
export const SHOPIFY_SDL = /* GraphQL */ `
  scalar DateTime
  scalar Decimal
  scalar Money
  scalar URL
  scalar UnsignedInt64

  enum CurrencyCode {
    USD
    CAD
    EUR
    GBP
    AUD
  }

  enum OrderDisplayFinancialStatus {
    PENDING
    AUTHORIZED
    PARTIALLY_PAID
    PAID
    PARTIALLY_REFUNDED
    REFUNDED
    VOIDED
    EXPIRED
  }

  enum OrderDisplayFulfillmentStatus {
    UNFULFILLED
    PARTIALLY_FULFILLED
    FULFILLED
    RESTOCKED
    PENDING_FULFILLMENT
    OPEN
    IN_PROGRESS
    ON_HOLD
    SCHEDULED
    REQUEST_DECLINED
  }

  enum OrderCancelReason {
    CUSTOMER
    DECLINED
    FRAUD
    INVENTORY
    STAFF
    OTHER
  }

  enum OrderCreateFinancialStatus {
    AUTHORIZED
    EXPIRED
    PAID
    PARTIALLY_PAID
    PARTIALLY_REFUNDED
    PENDING
    REFUNDED
    VOIDED
  }

  enum FulfillmentStatus {
    SUCCESS
    CANCELLED
    ERROR
    FAILURE
    OPEN
    PENDING
  }

  enum FulfillmentDisplayStatus {
    ATTEMPTED_DELIVERY
    CANCELED
    CONFIRMED
    DELIVERED
    FAILURE
    FULFILLED
    IN_TRANSIT
    LABEL_PRINTED
    LABEL_PURCHASED
    MARKED_AS_FULFILLED
    OUT_FOR_DELIVERY
    READY_FOR_PICKUP
    SUBMITTED
  }

  enum DraftOrderStatus {
    OPEN
    INVOICE_SENT
    COMPLETED
  }

  enum ProductStatus {
    ACTIVE
    ARCHIVED
    DRAFT
  }

  enum MetafieldOwnerType {
    ORDER
    DRAFTORDER
    PRODUCT
    PRODUCTVARIANT
  }

  enum WebhookSubscriptionTopic {
    ORDERS_CREATE
    ORDERS_FULFILLED
    ORDERS_CANCELLED
    FULFILLMENTS_CREATE
    FULFILLMENTS_UPDATE
  }

  enum WebhookSubscriptionFormat {
    JSON
    XML
  }

  enum OrderCreateUserErrorCode {
    BLANK
    INVALID
    NOT_FOUND
    PRESENT
  }

  enum MetafieldsSetUserErrorCode {
    BLANK
    INVALID_TYPE
    INVALID_VALUE
    LESS_THAN_OR_EQUAL_TO
    APP_NOT_AUTHORIZED
    INVALID
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type UserError {
    field: [String!]
    message: String!
  }

  type OrderCreateUserError {
    field: [String!]
    message: String!
    code: OrderCreateUserErrorCode
  }

  type MetafieldsSetUserError {
    field: [String!]
    message: String!
    code: MetafieldsSetUserErrorCode
    elementIndex: Int
  }

  type MoneyV2 {
    amount: Decimal!
    currencyCode: CurrencyCode!
  }

  type MoneyBag {
    shopMoney: MoneyV2!
    presentmentMoney: MoneyV2!
  }

  type MailingAddress {
    address1: String
    address2: String
    city: String
    company: String
    countryCodeV2: String
    firstName: String
    lastName: String
    name: String
    phone: String
    provinceCode: String
    zip: String
  }

  type Shop {
    id: ID!
    name: String!
    myshopifyDomain: String!
    currencyCode: CurrencyCode!
  }

  type Metafield {
    id: ID!
    legacyResourceId: UnsignedInt64!
    namespace: String!
    key: String!
    value: String!
    type: String!
    ownerType: MetafieldOwnerType!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type MetafieldEdge {
    cursor: String!
    node: Metafield!
  }

  type MetafieldConnection {
    edges: [MetafieldEdge!]!
    nodes: [Metafield!]!
    pageInfo: PageInfo!
  }

  type Product {
    id: ID!
    legacyResourceId: UnsignedInt64!
    title: String!
    handle: String!
    status: ProductStatus!
    vendor: String!
    metafield(namespace: String, key: String!): Metafield
    metafields(first: Int, after: String, namespace: String): MetafieldConnection!
  }

  type ProductVariant {
    id: ID!
    legacyResourceId: UnsignedInt64!
    title: String!
    displayName: String!
    sku: String
    barcode: String
    price: Money!
    inventoryQuantity: Int
    availableForSale: Boolean!
    product: Product!
    createdAt: DateTime!
    updatedAt: DateTime!
    metafield(namespace: String, key: String!): Metafield
    metafields(first: Int, after: String, namespace: String): MetafieldConnection!
  }

  type ProductVariantEdge {
    cursor: String!
    node: ProductVariant!
  }

  type ProductVariantConnection {
    edges: [ProductVariantEdge!]!
    nodes: [ProductVariant!]!
    pageInfo: PageInfo!
  }

  type LineItem {
    id: ID!
    name: String!
    title: String!
    quantity: Int!
    sku: String
    requiresShipping: Boolean!
    variant: ProductVariant
    originalUnitPriceSet: MoneyBag!
  }

  type LineItemEdge {
    cursor: String!
    node: LineItem!
  }

  type LineItemConnection {
    edges: [LineItemEdge!]!
    nodes: [LineItem!]!
    pageInfo: PageInfo!
  }

  type FulfillmentTrackingInfo {
    company: String
    number: String
    url: URL
  }

  type Fulfillment {
    id: ID!
    legacyResourceId: UnsignedInt64!
    name: String!
    status: FulfillmentStatus!
    displayStatus: FulfillmentDisplayStatus
    trackingInfo(first: Int): [FulfillmentTrackingInfo!]!
    createdAt: DateTime!
    updatedAt: DateTime!
    deliveredAt: DateTime
  }

  type Order {
    id: ID!
    legacyResourceId: UnsignedInt64!
    name: String!
    email: String
    phone: String
    note: String
    tags: [String!]!
    test: Boolean!
    sourceName: String
    currencyCode: CurrencyCode!
    createdAt: DateTime!
    updatedAt: DateTime!
    processedAt: DateTime!
    cancelledAt: DateTime
    cancelReason: OrderCancelReason
    closed: Boolean!
    displayFinancialStatus: OrderDisplayFinancialStatus
    displayFulfillmentStatus: OrderDisplayFulfillmentStatus!
    subtotalPriceSet: MoneyBag
    totalPriceSet: MoneyBag!
    shippingAddress: MailingAddress
    lineItems(first: Int, after: String): LineItemConnection!
    fulfillments(first: Int): [Fulfillment!]!
    metafield(namespace: String, key: String!): Metafield
    metafields(first: Int, after: String, namespace: String): MetafieldConnection!
  }

  type DraftOrderLineItem {
    id: ID!
    name: String!
    title: String!
    quantity: Int!
    sku: String
    requiresShipping: Boolean!
    variant: ProductVariant
    originalUnitPriceSet: MoneyBag!
  }

  type DraftOrderLineItemEdge {
    cursor: String!
    node: DraftOrderLineItem!
  }

  type DraftOrderLineItemConnection {
    edges: [DraftOrderLineItemEdge!]!
    nodes: [DraftOrderLineItem!]!
    pageInfo: PageInfo!
  }

  type DraftOrder {
    id: ID!
    legacyResourceId: UnsignedInt64!
    name: String!
    status: DraftOrderStatus!
    email: String
    note2: String
    tags: [String!]!
    currencyCode: CurrencyCode!
    createdAt: DateTime!
    updatedAt: DateTime!
    completedAt: DateTime
    totalPriceSet: MoneyBag!
    subtotalPriceSet: MoneyBag!
    order: Order
    lineItems(first: Int, after: String): DraftOrderLineItemConnection!
    metafield(namespace: String, key: String!): Metafield
    metafields(first: Int, after: String, namespace: String): MetafieldConnection!
  }

  type WebhookSubscription {
    id: ID!
    legacyResourceId: UnsignedInt64!
    topic: WebhookSubscriptionTopic!
    format: WebhookSubscriptionFormat!
    callbackUrl: URL!
    uri: String!
    includeFields: [String!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type WebhookSubscriptionEdge {
    cursor: String!
    node: WebhookSubscription!
  }

  type WebhookSubscriptionConnection {
    edges: [WebhookSubscriptionEdge!]!
    nodes: [WebhookSubscription!]!
    pageInfo: PageInfo!
  }

  input MoneyInput {
    amount: Decimal!
    currencyCode: CurrencyCode!
  }

  input MoneyBagInput {
    shopMoney: MoneyInput!
    presentmentMoney: MoneyInput
  }

  input MailingAddressInput {
    address1: String
    address2: String
    city: String
    company: String
    countryCode: String
    firstName: String
    lastName: String
    phone: String
    provinceCode: String
    zip: String
  }

  input MetafieldInput {
    namespace: String
    key: String!
    value: String!
    type: String
  }

  input OrderCreateLineItemInput {
    variantId: ID
    quantity: Int!
    title: String
    sku: String
    priceSet: MoneyBagInput
    requiresShipping: Boolean
  }

  input OrderCreateOrderInput {
    email: String
    phone: String
    note: String
    tags: [String!]
    currency: CurrencyCode
    financialStatus: OrderCreateFinancialStatus
    sourceName: String
    test: Boolean
    processedAt: DateTime
    lineItems: [OrderCreateLineItemInput!]
    shippingAddress: MailingAddressInput
    billingAddress: MailingAddressInput
    metafields: [MetafieldInput!]
  }

  input OrderCreateOptionsInput {
    sendReceipt: Boolean
    sendFulfillmentReceipt: Boolean
  }

  input DraftOrderLineItemInput {
    variantId: ID
    quantity: Int!
    title: String
    sku: String
    originalUnitPrice: Money
    requiresShipping: Boolean
  }

  input DraftOrderInput {
    email: String
    phone: String
    note: String
    tags: [String!]
    presentmentCurrencyCode: CurrencyCode
    lineItems: [DraftOrderLineItemInput!]
    shippingAddress: MailingAddressInput
    billingAddress: MailingAddressInput
    metafields: [MetafieldInput!]
  }

  input MetafieldsSetInput {
    ownerId: ID!
    namespace: String
    key: String!
    value: String!
    type: String
  }

  input WebhookSubscriptionInput {
    callbackUrl: URL
    uri: String
    format: WebhookSubscriptionFormat
    includeFields: [String!]
  }

  type OrderCreatePayload {
    order: Order
    userErrors: [OrderCreateUserError!]!
  }

  type DraftOrderCreatePayload {
    draftOrder: DraftOrder
    userErrors: [UserError!]!
  }

  type DraftOrderCompletePayload {
    draftOrder: DraftOrder
    userErrors: [UserError!]!
  }

  type MetafieldsSetPayload {
    metafields: [Metafield!]
    userErrors: [MetafieldsSetUserError!]!
  }

  type WebhookSubscriptionCreatePayload {
    webhookSubscription: WebhookSubscription
    userErrors: [UserError!]!
  }

  type WebhookSubscriptionDeletePayload {
    deletedWebhookSubscriptionId: ID
    userErrors: [UserError!]!
  }

  type Query {
    shop: Shop!
    order(id: ID!): Order
    draftOrder(id: ID!): DraftOrder
    productVariant(id: ID!): ProductVariant
    productVariants(
      first: Int
      after: String
      last: Int
      before: String
      query: String
      reverse: Boolean
    ): ProductVariantConnection!
    webhookSubscription(id: ID!): WebhookSubscription
    webhookSubscriptions(
      first: Int
      after: String
      last: Int
      before: String
      topics: [WebhookSubscriptionTopic!]
      callbackUrl: URL
      reverse: Boolean
    ): WebhookSubscriptionConnection!
  }

  type Mutation {
    orderCreate(order: OrderCreateOrderInput!, options: OrderCreateOptionsInput): OrderCreatePayload
    draftOrderCreate(input: DraftOrderInput!): DraftOrderCreatePayload
    draftOrderComplete(id: ID!, paymentPending: Boolean, sourceName: String): DraftOrderCompletePayload
    metafieldsSet(metafields: [MetafieldsSetInput!]!): MetafieldsSetPayload
    webhookSubscriptionCreate(
      topic: WebhookSubscriptionTopic!
      webhookSubscription: WebhookSubscriptionInput!
    ): WebhookSubscriptionCreatePayload
    webhookSubscriptionDelete(id: ID!): WebhookSubscriptionDeletePayload
  }
`

let cached: GraphQLSchema | undefined

/** The executable schema built from {@link SHOPIFY_SDL}, built once per process. */
export const shopifySchema = (): GraphQLSchema => {
  cached ??= buildSchema(SHOPIFY_SDL)
  return cached
}
