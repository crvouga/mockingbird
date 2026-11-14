import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, DEFAULT_SETTINGS, SHOPIFY_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  createShopifyClient,
  ShopifyHttpError,
  ShopifyThrottledError,
  ShopifyUserError,
  verifyShopifyWebhook,
} from "./test/consumer.js"

const SHOP = "https://mockingbird-test.myshopify.com"
const TOKEN = "shpat_mockingbird_test"
const NOW = Date.UTC(2026, 0, 4, 12)
const RECEIVER = "https://receiver.example.test/webhooks/shopify"
const TEE_S = "gid://shopify/ProductVariant/41000000001"
const MUG = "gid://shopify/ProductVariant/41000000003"

type Delivery = { url: string; headers: Headers; body: string }

const harness = () => {
  const deliveries: Delivery[] = []
  const runtime = createRuntime({
    clock: createClock(() => NOW),
    webhooks: {
      fetch: async (request) => {
        deliveries.push({ url: request.url, headers: request.headers, body: await request.text() })
        return new Response("ok")
      },
    },
  })
  const fetchImpl = (input: string, init?: RequestInit) => runtime.fetch(new Request(input, init))
  const client = createShopifyClient({ shopUrl: SHOP, accessToken: TOKEN, fetchImpl })
  const admin = (path: string, body?: unknown) =>
    runtime.fetch(
      new Request(`${SHOP}/__admin${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
    )
  return { runtime, client, fetchImpl, admin, deliveries }
}

describe("Shopify acceptance (issue #763)", () => {
  test("1. the Admin GraphQL endpoint requires X-Shopify-Access-Token", async () => {
    const { fetchImpl, runtime } = harness()
    const anonymous = createShopifyClient({ shopUrl: SHOP, accessToken: "", fetchImpl })
    await expect(anonymous.graphql("{ shop { name } }")).rejects.toMatchObject({ status: 401 })
    const client = createShopifyClient({ shopUrl: SHOP, accessToken: TOKEN, fetchImpl })
    expect(await client.graphql<unknown>("{ shop { name myshopifyDomain } }")).toEqual({
      shop: { name: DEFAULT_SETTINGS.shopName, myshopifyDomain: DEFAULT_SETTINGS.shopDomain },
    })
    await runtime.fetch(
      new Request(`${SHOP}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessTokens: ["shpat_only_this_one"] }),
      }),
    )
    await expect(client.graphql("{ shop { name } }")).rejects.toBeInstanceOf(ShopifyHttpError)
  })

  test("2. productVariants finds a variant by SKU search", async () => {
    const { client } = harness()
    expect(await client.findVariantBySku("MB-TEE-S")).toEqual({
      id: TEE_S,
      sku: "MB-TEE-S",
      price: "25.00",
    })
    expect(await client.findVariantBySku("NO-SUCH-SKU")).toBeUndefined()
    const page = await client.graphql<{
      productVariants: {
        nodes: Array<{ sku: string }>
        pageInfo: { hasNextPage: boolean; endCursor: string }
      }
    }>("{ productVariants(first: 2) { nodes { sku } pageInfo { hasNextPage endCursor } } }")
    expect(page.productVariants.nodes.map((node) => node.sku)).toEqual(["MB-TEE-S", "MB-TEE-M"])
    expect(page.productVariants.pageInfo.hasNextPage).toBe(true)
    const next = await client.graphql<{ productVariants: { nodes: Array<{ sku: string }> } }>(
      "query($after: String) { productVariants(first: 2, after: $after) { nodes { sku } } }",
      { after: page.productVariants.pageInfo.endCursor },
    )
    expect(next.productVariants.nodes.map((node) => node.sku)).toEqual(["MB-MUG"])
  })

  test("3. orderCreate creates an unfulfilled order and reports invalid lines as userErrors", async () => {
    const { client } = harness()
    const order = await client.createOrder({
      email: "buyer@example.test",
      lines: [
        { variantId: TEE_S, quantity: 2 },
        { variantId: MUG, quantity: 1 },
      ],
    })
    expect(order).toEqual({
      id: "gid://shopify/Order/5000000001",
      name: "#1001",
      displayFulfillmentStatus: "UNFULFILLED",
    })
    const totals = await client.graphql<{
      order: {
        totalPriceSet: { shopMoney: { amount: string } }
        lineItems: { nodes: Array<{ sku: string; quantity: number }> }
      }
    }>(
      `query($id: ID!) { order(id: $id) { totalPriceSet { shopMoney { amount } } lineItems(first: 5) { nodes { sku quantity } } } }`,
      { id: order.id },
    )
    expect(totals.order.totalPriceSet.shopMoney.amount).toBe("62.50")
    expect(totals.order.lineItems.nodes).toEqual([
      { sku: "MB-TEE-S", quantity: 2 },
      { sku: "MB-MUG", quantity: 1 },
    ])
    const rejected = client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
    })
    await expect(rejected).rejects.toBeInstanceOf(ShopifyUserError)
    await expect(rejected).rejects.toMatchObject({
      userErrors: [{ field: ["order", "lineItems", "0", "variantId"], code: "NOT_FOUND" }],
    })
  })

  test("4. draftOrderCreate + draftOrderComplete produce a paid order once", async () => {
    const { client } = harness()
    const { draft, completed } = await client.createDraftAndComplete([
      { variantId: MUG, quantity: 3 },
    ])
    expect(draft.status).toBe("OPEN")
    expect(completed).toMatchObject({
      status: "COMPLETED",
      order: {
        id: "gid://shopify/Order/5000000001",
        name: "#1001",
        displayFinancialStatus: "PAID",
      },
    })
    const again = await client.graphql<{
      draftOrderComplete: { userErrors: Array<{ message: string }> }
    }>("mutation($id: ID!) { draftOrderComplete(id: $id) { userErrors { field message } } }", {
      id: draft.id,
    })
    expect(again.draftOrderComplete.userErrors).toHaveLength(1)
  })

  test("5. order(id) reports displayFulfillmentStatus and fulfillments { trackingInfo }", async () => {
    const { client, admin } = harness()
    const order = await client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: TEE_S, quantity: 1 }],
    })
    expect(await client.orderStatus(order.id)).toMatchObject({
      displayFulfillmentStatus: "UNFULFILLED",
      fulfillments: [],
    })
    const fulfilled = await admin("/orders/5000000001/fulfill", {
      trackingCompany: "UPS",
      trackingNumber: "1Z0000000000000001",
      trackingUrl: "https://tracking.example.test/1Z0000000000000001",
    })
    expect(fulfilled.status).toBe(200)
    expect(await client.orderStatus(order.id)).toEqual({
      id: order.id,
      displayFulfillmentStatus: "FULFILLED",
      cancelledAt: null,
      fulfillments: [
        {
          status: "SUCCESS",
          trackingInfo: [
            {
              company: "UPS",
              number: "1Z0000000000000001",
              url: "https://tracking.example.test/1Z0000000000000001",
            },
          ],
        },
      ],
    })
    expect(await client.orderStatus("gid://shopify/Order/9")).toBeNull()
    await expect(client.orderStatus("5000000001")).rejects.toThrow("Invalid global id")
  })

  test("6. metafieldsSet upserts metafields and validates types atomically", async () => {
    const { client } = harness()
    const order = await client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: TEE_S, quantity: 1 }],
    })
    const field = { ownerId: order.id, namespace: "custom", key: "external_ref" }
    expect(
      await client.setMetafields([{ ...field, type: "single_line_text_field", value: "ref-1" }]),
    ).toEqual([
      { namespace: "custom", key: "external_ref", type: "single_line_text_field", value: "ref-1" },
    ])
    await client.setMetafields([{ ...field, type: "single_line_text_field", value: "ref-2" }])
    const read = await client.graphql<{ order: { metafield: { value: string } } }>(
      `query($id: ID!) { order(id: $id) { metafield(namespace: "custom", key: "external_ref") { value } } }`,
      { id: order.id },
    )
    expect(read.order.metafield.value).toBe("ref-2")
    const invalid = client.setMetafields([
      {
        ownerId: order.id,
        namespace: "custom",
        key: "quantity",
        type: "number_integer",
        value: "7",
      },
      { ownerId: order.id, namespace: "custom", key: "count", type: "number_integer", value: "x" },
    ])
    await expect(invalid).rejects.toMatchObject({
      userErrors: [{ field: ["metafields", "1", "value"], code: "INVALID_VALUE", elementIndex: 1 }],
    })
    const quantity = await client.graphql<{ order: { metafield: null } }>(
      `query($id: ID!) { order(id: $id) { metafield(namespace: "custom", key: "quantity") { value } } }`,
      { id: order.id },
    )
    expect(quantity.order.metafield).toBeNull()
    await expect(
      client.setMetafields([
        {
          ownerId: "gid://shopify/Order/1",
          namespace: "custom",
          key: "x1",
          type: "boolean",
          value: "true",
        },
      ]),
    ).rejects.toMatchObject({ userErrors: [{ field: ["metafields", "0", "ownerId"] }] })
  })

  test("7. webhookSubscriptionCreate and webhookSubscriptions manage subscriptions", async () => {
    const { client } = harness()
    const created = await client.subscribe("ORDERS_FULFILLED", RECEIVER)
    expect(created).toEqual({
      id: "gid://shopify/WebhookSubscription/1100000001",
      topic: "ORDERS_FULFILLED",
      callbackUrl: RECEIVER,
    })
    await client.subscribe("ORDERS_CANCELLED", RECEIVER)
    await expect(client.subscribe("ORDERS_FULFILLED", RECEIVER)).rejects.toMatchObject({
      userErrors: [{ message: "Address for this topic has already been taken" }],
    })
    await expect(client.subscribe("ORDERS_FULFILLED", "not a url")).rejects.toBeInstanceOf(
      ShopifyUserError,
    )
    expect((await client.subscriptions()).map((sub) => sub.topic)).toEqual([
      "ORDERS_FULFILLED",
      "ORDERS_CANCELLED",
    ])
    const deleted = await client.graphql<{
      webhookSubscriptionDelete: { deletedWebhookSubscriptionId: string }
    }>(
      "mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { message } } }",
      {
        id: created.id,
      },
    )
    expect(deleted.webhookSubscriptionDelete.deletedWebhookSubscriptionId).toBe(created.id)
    expect((await client.subscriptions()).map((sub) => sub.topic)).toEqual(["ORDERS_CANCELLED"])
  })

  test("8. webhooks are signed with X-Shopify-Hmac-Sha256 for every requested topic", async () => {
    const { runtime, client, admin, deliveries } = harness()
    for (const topic of [
      "ORDERS_FULFILLED",
      "ORDERS_CANCELLED",
      "FULFILLMENTS_CREATE",
      "FULFILLMENTS_UPDATE",
    ]) {
      await client.subscribe(topic, RECEIVER)
    }
    const shipped = await client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: TEE_S, quantity: 1 }],
    })
    const cancelled = await client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: MUG, quantity: 1 }],
    })
    const fulfil = (await (
      await admin(`/orders/${encodeURIComponent(shipped.id)}/fulfill`, {
        trackingCompany: "USPS",
        trackingNumber: "9400100000000000000001",
      })
    ).json()) as { fulfillment: { id: number } }
    await admin(`/fulfillments/${fulfil.fulfillment.id}/update`, { displayStatus: "DELIVERED" })
    await admin("/orders/5000000002/cancel", { reason: "CUSTOMER" })
    await runtime.webhooks.idle()
    expect(deliveries.map((d) => d.headers.get("x-shopify-topic"))).toEqual([
      "fulfillments/create",
      "orders/fulfilled",
      "fulfillments/update",
      "orders/cancelled",
    ])
    for (const delivery of deliveries) {
      expect(delivery.url).toBe(RECEIVER)
      expect(
        verifyShopifyWebhook(
          delivery.body,
          delivery.headers.get("x-shopify-hmac-sha256"),
          DEFAULT_SETTINGS.apiSecret,
        ),
      ).toBe(true)
      // An independent HMAC over the exact bytes received.
      expect(delivery.headers.get("x-shopify-hmac-sha256")).toBe(
        createHmac("sha256", DEFAULT_SETTINGS.apiSecret).update(delivery.body).digest("base64"),
      )
      expect(delivery.headers.get("x-shopify-shop-domain")).toBe(DEFAULT_SETTINGS.shopDomain)
      expect(delivery.headers.get("x-shopify-api-version")).toBe("2026-10")
      expect(delivery.headers.get("x-shopify-webhook-id")).toBeTruthy()
    }
    expect(
      verifyShopifyWebhook(deliveries[0]?.body ?? "", "AAAA", DEFAULT_SETTINGS.apiSecret),
    ).toBe(false)
    const [created, fulfilledOrder, updated, cancelledOrder] = deliveries.map(
      (d) => JSON.parse(d.body) as Record<string, unknown>,
    )
    expect(created).toMatchObject({
      order_id: 5000000001,
      status: "success",
      tracking_company: "USPS",
      tracking_number: "9400100000000000000001",
    })
    expect(fulfilledOrder).toMatchObject({
      admin_graphql_api_id: shipped.id,
      fulfillment_status: "fulfilled",
    })
    expect(updated).toMatchObject({ shipment_status: "delivered" })
    expect(cancelledOrder).toMatchObject({
      admin_graphql_api_id: cancelled.id,
      cancel_reason: "customer",
      cancelled_at: "2026-01-04T12:00:00Z",
    })
  })

  test("9. admin controls mark an order fulfilled or cancelled", async () => {
    const { client, admin } = harness()
    const order = await client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: TEE_S, quantity: 1 }],
    })
    expect((await admin("/orders/5000000001/cancel", { reason: "INVENTORY" })).status).toBe(200)
    expect(await client.orderStatus(order.id)).toMatchObject({
      cancelledAt: "2026-01-04T12:00:00Z",
      displayFulfillmentStatus: "UNFULFILLED",
    })
    expect((await admin("/orders/5000000001/fulfill")).status).toBe(409)
    expect((await admin("/orders/5000000001/cancel")).status).toBe(409)
    expect((await admin("/orders/42/fulfill")).status).toBe(404)
    expect((await admin("/orders/5000000001/cancel", { reason: "BORED" })).status).toBe(400)
  })

  test("10. the next mutation can fail with userErrors or THROTTLED; queries are unaffected", async () => {
    const { client, admin } = harness()
    expect(
      (
        await admin("/fail-next-mutation", {
          kind: "userErrors",
          message: "Inventory is unavailable",
          field: ["order", "lineItems"],
          code: "INVALID",
        })
      ).status,
    ).toBe(201)
    expect(await client.findVariantBySku("MB-MUG")).toBeDefined()
    const failed = client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: MUG, quantity: 1 }],
    })
    await expect(failed).rejects.toMatchObject({
      userErrors: [
        { field: ["order", "lineItems"], message: "Inventory is unavailable", code: "INVALID" },
      ],
    })
    await admin("/fail-next-mutation", { kind: "throttled" })
    await expect(
      client.createOrder({ email: "buyer@example.test", lines: [{ variantId: MUG, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(ShopifyThrottledError)
    const order = await client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: MUG, quantity: 1 }],
    })
    // Neither failed mutation created anything.
    expect(order.name).toBe("#1001")
  })
})

describe("Shopify runtime contract", () => {
  test("the throttled preset, namespaces by header and token, and a journal without bodies", async () => {
    const { runtime, client, fetchImpl } = harness()
    expect(Object.keys(SHOPIFY_PRESETS)).toEqual(
      expect.arrayContaining(["throttled", "invalid_access_token", "server_error"]),
    )
    runtime.applyPreset("throttled", "default", { count: 1 })
    const raw = await fetchImpl(`${SHOP}/admin/api/2026-10/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": TOKEN },
      body: JSON.stringify({ query: "{ shop { name } }" }),
    })
    expect(raw.status).toBe(200)
    expect(await raw.json()).toMatchObject({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: { cost: { actualQueryCost: null, throttleStatus: { maximumAvailable: 2000 } } },
    })
    await client.createOrder({
      email: "buyer@example.test",
      lines: [{ variantId: MUG, quantity: 1 }],
    })
    const other = createShopifyClient({
      shopUrl: SHOP,
      accessToken: TOKEN,
      fetchImpl: (input, init) =>
        runtime.fetch(
          new Request(input, {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string>),
              "x-mockingbird-namespace": "b",
            },
          }),
        ),
    })
    expect(await other.orderStatus("gid://shopify/Order/5000000001")).toBeNull()
    await runtime.fetch(
      new Request(`${SHOP}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { shpat_tenant_c: "c" } }),
      }),
    )
    const tenant = createShopifyClient({ shopUrl: SHOP, accessToken: "shpat_tenant_c", fetchImpl })
    expect(await tenant.orderStatus("gid://shopify/Order/5000000001")).toBeNull()
    expect(runtime.instance("c").state.orders.count()).toBe(0)
    const journal = await (await runtime.fetch(new Request(`${SHOP}/__admin/requests`))).text()
    expect(journal).not.toContain("buyer@example.test")
  })

  test("served over HTTP: plain fetch, and a webhook to a Bun.serve receiver", async () => {
    const received: Array<{ topic: string | null; valid: boolean }> = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = await request.text()
        received.push({
          topic: request.headers.get("x-shopify-topic"),
          valid: verifyShopifyWebhook(
            body,
            request.headers.get("x-shopify-hmac-sha256"),
            "shpss_receiver",
          ),
        })
        return new Response("ok")
      },
    })
    const server = await createServer({ settings: { apiSecret: "shpss_receiver" } })
    try {
      expect((await fetch(`${server.url}/__admin/health`)).headers.get("x-mockingbird")).toMatch(
        /^shopify@/,
      )
      const client = createShopifyClient({
        shopUrl: server.url,
        accessToken: TOKEN,
        fetchImpl: fetch,
      })
      await client.subscribe("ORDERS_FULFILLED", `http://127.0.0.1:${sink.port}/webhooks`)
      const order = await client.createOrder({
        email: "buyer@example.test",
        lines: [{ variantId: TEE_S, quantity: 1 }],
      })
      await fetch(`${server.url}/__admin/orders/${encodeURIComponent(order.id)}/fulfill`, {
        method: "POST",
      })
      await server.runtime.webhooks.idle()
      expect(received).toEqual([{ topic: "orders/fulfilled", valid: true }])
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
