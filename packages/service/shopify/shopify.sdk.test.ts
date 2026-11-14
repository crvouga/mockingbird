import { describe, expect, test } from "bun:test"
import { createAdminApiClient } from "@shopify/admin-api-client"
import { createRuntime } from "./src/index.js"

/** Shopify's official Admin API client (2.0.1), its transport pointed at the emulator. */
const sdk = () => {
  const runtime = createRuntime()
  const client = createAdminApiClient({
    storeDomain: "mockingbird-test.myshopify.com",
    apiVersion: "2026-10",
    accessToken: "shpat_mockingbird_test",
    customFetchApi: (url, init) => runtime.fetch(new Request(url, init)),
  })
  return { runtime, client }
}

describe("@shopify/admin-api-client drop-in", () => {
  test("request() creates an order and reads its fulfilment status", async () => {
    const { client } = sdk()
    const created = await client.request(
      `mutation Create($order: OrderCreateOrderInput!) {
        orderCreate(order: $order) { order { id name displayFulfillmentStatus } userErrors { field message } }
      }`,
      {
        variables: {
          order: {
            email: "buyer@example.test",
            lineItems: [{ variantId: "gid://shopify/ProductVariant/41000000002", quantity: 1 }],
          },
        },
      },
    )
    expect(created.errors).toBeUndefined()
    expect(created.data.orderCreate).toEqual({
      order: {
        id: "gid://shopify/Order/5000000001",
        name: "#1001",
        displayFulfillmentStatus: "UNFULFILLED",
      },
      userErrors: [],
    })
    expect(created.extensions?.cost).toMatchObject({ requestedQueryCost: 10, actualQueryCost: 10 })
    const read = await client.request(
      `query Status($id: ID!) { order(id: $id) { displayFulfillmentStatus fulfillments { trackingInfo { number } } } }`,
      { variables: { id: "gid://shopify/Order/5000000001" } },
    )
    expect(read.data).toEqual({
      order: { displayFulfillmentStatus: "UNFULFILLED", fulfillments: [] },
    })
  })

  test("GraphQL validation errors and THROTTLED surface through the client's errors", async () => {
    const { runtime, client } = sdk()
    const invalid = await client.request("query { shop { notAField } }")
    expect(invalid.errors?.graphQLErrors?.[0]?.message).toContain("notAField")
    runtime.applyPreset("throttled", "default", { count: 1 })
    const throttled = await client.request("query { shop { name } }")
    expect(throttled.errors?.graphQLErrors?.[0]).toMatchObject({
      message: "Throttled",
      extensions: { code: "THROTTLED" },
    })
  })
})
