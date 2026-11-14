/**
 * A port of the fulfilment backend's Shopify client described in issue #763: raw `fetch`
 * against the Admin GraphQL endpoint, `userErrors` and `THROTTLED` turned into typed errors,
 * and the webhook receiver's `X-Shopify-Hmac-Sha256` check (base64 HMAC-SHA256 of the raw body,
 * compared in constant time).
 */
import { createHmac, timingSafeEqual } from "node:crypto"

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type ShopifyClientOptions = {
  shopUrl: string
  accessToken: string
  apiVersion?: string
  fetchImpl: Fetch
}

export class ShopifyUserError extends Error {
  constructor(
    readonly userErrors: Array<{ field: string[] | null; message: string; code?: string }>,
  ) {
    super(userErrors.map((error) => error.message).join("; "))
  }
}

export class ShopifyThrottledError extends Error {
  constructor(readonly currentlyAvailable: number | undefined) {
    super("Shopify throttled the request")
  }
}

export class ShopifyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type GraphqlBody<T> = {
  data?: T | null
  errors?: Array<{ message: string; extensions?: { code?: string } }>
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number } } }
}

export const createShopifyClient = (options: ShopifyClientOptions) => {
  const url = `${options.shopUrl}/admin/api/${options.apiVersion ?? "2026-10"}/graphql.json`

  const graphql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const response = await options.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": options.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new ShopifyHttpError(response.status, `Shopify ${response.status}: ${text}`)
    }
    const body = (await response.json()) as GraphqlBody<T>
    if (body.errors?.some((error) => error.extensions?.code === "THROTTLED")) {
      throw new ShopifyThrottledError(body.extensions?.cost?.throttleStatus?.currentlyAvailable)
    }
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "))
    return body.data as T
  }

  const payload = <T extends { userErrors: ShopifyUserError["userErrors"] }>(result: T): T => {
    if (result.userErrors.length > 0) throw new ShopifyUserError(result.userErrors)
    return result
  }

  return {
    graphql,

    async findVariantBySku(sku: string) {
      const data = await graphql<{
        productVariants: { nodes: Array<{ id: string; sku: string; price: string }> }
      }>(
        `query FindVariant($query: String!) {
          productVariants(first: 1, query: $query) { nodes { id sku price } }
        }`,
        { query: `sku:${sku}` },
      )
      return data.productVariants.nodes[0]
    },

    async createOrder(input: {
      email: string
      lines: Array<{ variantId: string; quantity: number }>
      tags?: string[]
    }) {
      const data = await graphql<{
        orderCreate: {
          order: { id: string; name: string; displayFulfillmentStatus: string } | null
          userErrors: ShopifyUserError["userErrors"]
        }
      }>(
        `mutation CreateOrder($order: OrderCreateOrderInput!) {
          orderCreate(order: $order) {
            order { id name displayFulfillmentStatus }
            userErrors { field message code }
          }
        }`,
        {
          order: {
            email: input.email,
            tags: input.tags ?? ["merch"],
            lineItems: input.lines,
            shippingAddress: {
              firstName: "Test",
              lastName: "Buyer",
              address1: "1 Example Way",
              city: "Springfield",
              provinceCode: "OR",
              countryCode: "US",
              zip: "97000",
            },
          },
        },
      )
      return payload(data.orderCreate).order as NonNullable<typeof data.orderCreate.order>
    },

    async createDraftAndComplete(lines: Array<{ variantId: string; quantity: number }>) {
      const created = await graphql<{
        draftOrderCreate: {
          draftOrder: { id: string; name: string; status: string } | null
          userErrors: ShopifyUserError["userErrors"]
        }
      }>(
        `mutation Draft($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) { draftOrder { id name status } userErrors { field message } }
        }`,
        { input: { email: "buyer@example.test", lineItems: lines } },
      )
      const draft = payload(created.draftOrderCreate).draftOrder as { id: string; status: string }
      const completed = await graphql<{
        draftOrderComplete: {
          draftOrder: {
            id: string
            status: string
            order: { id: string; name: string; displayFinancialStatus: string } | null
          } | null
          userErrors: ShopifyUserError["userErrors"]
        }
      }>(
        `mutation Complete($id: ID!) {
          draftOrderComplete(id: $id) {
            draftOrder { id status order { id name displayFinancialStatus } }
            userErrors { field message }
          }
        }`,
        { id: draft.id },
      )
      return { draft, completed: payload(completed.draftOrderComplete).draftOrder }
    },

    async orderStatus(id: string) {
      const data = await graphql<{
        order: {
          id: string
          displayFulfillmentStatus: string
          cancelledAt: string | null
          fulfillments: Array<{
            status: string
            trackingInfo: Array<{
              company: string | null
              number: string | null
              url: string | null
            }>
          }>
        } | null
      }>(
        `query OrderStatus($id: ID!) {
          order(id: $id) {
            id
            displayFulfillmentStatus
            cancelledAt
            fulfillments(first: 10) { status trackingInfo(first: 5) { company number url } }
          }
        }`,
        { id },
      )
      return data.order
    },

    async setMetafields(
      metafields: Array<{
        ownerId: string
        namespace: string
        key: string
        type: string
        value: string
      }>,
    ) {
      const data = await graphql<{
        metafieldsSet: {
          metafields: Array<{ key: string; namespace: string; value: string; type: string }> | null
          userErrors: Array<{
            field: string[] | null
            message: string
            code: string
            elementIndex: number | null
          }>
        }
      }>(
        `mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key namespace value type }
            userErrors { field message code elementIndex }
          }
        }`,
        { metafields },
      )
      return payload(data.metafieldsSet).metafields ?? []
    },

    async subscribe(topic: string, callbackUrl: string) {
      const data = await graphql<{
        webhookSubscriptionCreate: {
          webhookSubscription: { id: string; topic: string; callbackUrl: string } | null
          userErrors: ShopifyUserError["userErrors"]
        }
      }>(
        `mutation Subscribe($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
            webhookSubscription { id topic callbackUrl }
            userErrors { field message }
          }
        }`,
        { topic, sub: { callbackUrl, format: "JSON" } },
      )
      return payload(data.webhookSubscriptionCreate).webhookSubscription as {
        id: string
        topic: string
        callbackUrl: string
      }
    },

    async subscriptions() {
      const data = await graphql<{
        webhookSubscriptions: { nodes: Array<{ id: string; topic: string; callbackUrl: string }> }
      }>(`query { webhookSubscriptions(first: 50) { nodes { id topic callbackUrl } } }`)
      return data.webhookSubscriptions.nodes
    },
  }
}

/** The receiver's check: base64 HMAC-SHA256 of the raw body under the app secret. */
export const verifyShopifyWebhook = (rawBody: string, header: string | null, secret: string) => {
  if (!header) return false
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest()
  const given = Buffer.from(header, "base64")
  return given.length === expected.length && timingSafeEqual(given, expected)
}
