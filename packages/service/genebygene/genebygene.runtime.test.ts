import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createRuntime, GENEBYGENE_PRESETS, STAGING_PRODUCTS } from "./src/index.js"
import { createServer, DEFAULT_PORT, serveTarget } from "./src/server.js"
import { GxgAuthService, GxgClient, GxgHttpClient, placeOrder } from "./test/consumer.js"

const BUNDLE = "0d52219e-30a5-4a0d-b96d-0fe9a46d95e5"
const ADDRESS = {
  recipientName: "Ada Lovelace",
  addressLine1: "400 N 5th St",
  city: "Phoenix",
  stateOrRegion: "AZ",
  postalCode: "85004",
  countryCode: "US",
}

const consumer = (
  base: string,
  fetch: (r: Request) => Promise<Response>,
  clientId = "client",
  tokenBase = base,
) => {
  const auth = new GxgAuthService({
    tokenUrl: `${tokenBase}/connect/token`,
    clientId,
    clientSecret: "s",
    fetch,
  })
  return new GxgClient(new GxgHttpClient(base, auth, fetch))
}

describe("service contract", () => {
  test("/health answers without credentials and reports the corpus; vendor routes need a bearer", async () => {
    const runtime = createRuntime()
    const health = await runtime.fetch(new Request("http://mock.local/health"))
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: "ok",
      service: "genebygene",
      corpus: "gxg-staging-2026-06",
    })
    expect(health.headers.get("x-mockingbird")).toMatch(/^genebygene@.*; ns=default$/)
    const vendor = await runtime.fetch(new Request("http://mock.local/api/v2/products"))
    expect(vendor.status).toBe(401)
    expect(vendor.headers.get("www-authenticate")).toBe("Bearer")
    expect(await vendor.text()).toBe("")
  })

  test("the corpus is the recorded staging catalog, byte for byte", async () => {
    const client = consumer("http://mock.local", (r) => createRuntime().fetch(r))
    const runtime = createRuntime()
    const c = consumer("http://mock.local", (r) => runtime.fetch(r))
    const { data } = await c.http.request<unknown[]>("GET", "/api/v2/products")
    expect(data).toEqual(STAGING_PRODUCTS as unknown[])
    expect(await client.fetchProduct("49f9c987-ba0e-4801-a3b3-b446a2d4835a")).toMatchObject({
      name: "Standard Swab Domestic Kit with DHL Return Label",
      shippingQualified: true,
    })
  })

  test("namespaces isolate orders: by header, by /ns/ prefix (API and token URL), and by client id", async () => {
    const runtime = createRuntime()
    const fetch = (r: Request) => runtime.fetch(r)
    const a = consumer("http://mock.local/ns/a", fetch, "client-a", "http://mock.local/ns/a")
    const placed = await placeOrder(a, {
      productId: BUNDLE,
      placerOrderNumber: "p",
      address: ADDRESS,
    })
    expect(placed.ok).toBe(true)
    const orderId = placed.ok ? placed.orderId : ""
    expect(await a.fetchOrderFromVendor(orderId)).not.toBeNull()
    const b = consumer("http://mock.local/ns/b", fetch, "client-b", "http://mock.local/ns/b")
    expect(await b.fetchOrderFromVendor(orderId)).toBeNull()

    // By client id: the default-namespace token's client maps to "a".
    await runtime.fetch(
      new Request("http://mock.local/__admin/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "worker-a": "a" } }),
      }),
    )
    const mapped = consumer("http://mock.local", fetch, "worker-a")
    expect(await mapped.fetchOrderFromVendor(orderId)).not.toBeNull()
    expect(
      await consumer("http://mock.local", fetch, "other").fetchOrderFromVendor(orderId),
    ).toBeNull()

    await runtime.reset("a")
    expect(await a.fetchOrderFromVendor(orderId)).toBeNull()
  })

  test("every catalog preset is registered and listed", async () => {
    const runtime = createRuntime()
    const listed = (await (
      await runtime.fetch(new Request("http://mock.local/__admin/faults/presets"))
    ).json()) as {
      presets: { name: string }[]
    }
    for (const name of [
      "invalid_client",
      "rate_limited",
      "shipping_empty_500",
      "address_not_validated",
      "slow_orders",
    ]) {
      expect(GENEBYGENE_PRESETS[name]).toBeDefined()
      expect(listed.presets.map((p) => p.name)).toContain(name)
    }
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    const c = consumer("http://mock.local", (r) => runtime.fetch(r))
    const limited = await c.http.request("GET", "/api/v2/products")
    expect(limited.response.status).toBe(429)
    expect(limited.response.headers.get("retry-after")).toBe("1")
  })

  test("the journal records operation ids and ids, never bodies (no PHI)", async () => {
    const runtime = createRuntime()
    const c = consumer("http://mock.local", (r) => runtime.fetch(r))
    const placed = await placeOrder(c, {
      productId: BUNDLE,
      placerOrderNumber: "p",
      address: ADDRESS,
    })
    const journal = (await (
      await runtime.fetch(new Request("http://mock.local/__admin/requests?operationId=CreateOrder"))
    ).json()) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests[0]?.ids?.orderId).toBe(placed.ok ? placed.orderId : "")
    const all = await (
      await runtime.fetch(new Request("http://mock.local/__admin/requests"))
    ).text()
    expect(all).not.toContain("Lovelace")
    expect(all).not.toContain("5th St")
  })

  test("webhook signatures verify with an independent HMAC-SHA512 over the exact bytes", async () => {
    const received: { headers: Headers; body: string }[] = []
    const runtime = createRuntime({
      webhooks: {
        url: "http://backend.local/webhooks/gene-by-gene",
        secret: "kv-seeded-secret",
        fetch: async (request) => {
          received.push({ headers: request.headers, body: await request.text() })
          return new Response("{}")
        },
      },
    })
    const c = consumer("http://mock.local", (r) => runtime.fetch(r))
    await placeOrder(c, { productId: BUNDLE, placerOrderNumber: "p", address: ADDRESS })
    await runtime.webhooks.idle()
    expect(received).toHaveLength(2)
    for (const { headers, body } of received) {
      const expected = `sha512=${createHmac("sha512", "kv-seeded-secret").update(body).digest("hex")}`
      expect(headers.get("gxg-signature")).toBe(expected)
      expect(headers.get("gxg-notificationid")).toMatch(/^[0-9a-f-]{36}$/)
      expect(headers.get("gxg-eventtype")).toMatch(/^GxG\.Nucleus\./)
    }
    const deliveries = (await (
      await runtime.fetch(new Request("http://mock.local/__admin/webhooks"))
    ).json()) as {
      deliveries: { state: string }[]
    }
    expect(deliveries.deliveries.every((d) => d.state === "delivered")).toBe(true)
  })

  test("results go to the configured S3 with the shared putObject, and resultPayload names that bucket", async () => {
    const puts: { path: string; auth: string | null; bytes: number }[] = []
    const s3 = Bun.serve({
      port: 0,
      fetch: async (request) => {
        puts.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          bytes: (await request.arrayBuffer()).byteLength,
        })
        return new Response(null, { status: 200 })
      },
    })
    try {
      const runtime = createRuntime({
        resultsS3: { endpoint: `http://127.0.0.1:${s3.port}`, bucket: "geviti-gxg-results-dev" },
      })
      const c = consumer("http://mock.local", (r) => runtime.fetch(r))
      const placed = await placeOrder(c, {
        productId: BUNDLE,
        placerOrderNumber: "p",
        address: ADDRESS,
      })
      const kit = placed.ok ? (placed.kitNumbers[0] as string) : ""
      const done = await runtime.fetch(
        new Request(`http://mock.local/__admin/kits/${kit}/transition`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: "Completed" }),
        }),
      )
      expect(done.status).toBe(200)
      expect(puts.map((p) => p.path).sort()).toEqual(
        [
          `/geviti-gxg-results-dev/${kit}.csv`,
          `/geviti-gxg-results-dev/${kit}.json`,
          `/geviti-gxg-results-dev/${kit}.pdf`,
        ].sort(),
      )
      expect(puts.every((p) => p.auth?.startsWith("AWS4-HMAC-SHA256") && p.bytes > 0)).toBe(true)
      const results = await c.fetchResultsByKitNumber({ kitNumber: kit, offset: 0, pageSize: 10 })
      expect(results.items.map((r) => r.resultPayload)).toContain(
        `s3://geviti-gxg-results-dev/${kit}.json`,
      )
    } finally {
      s3.stop(true)
    }
  })

  test("serve flags build the runtime (results S3, webhook, kit numbers off, pinned client)", async () => {
    expect(DEFAULT_PORT).toBe(8788)
    const runtime = await serveTarget.create(
      {
        "no-kit-numbers": true,
        "client-id": "febc7057-2904-4747-a076-55467fcece6f",
        "client-secret": "secret",
      },
      { adminKey: undefined, seed: undefined, onLog: undefined },
    )
    const token = await runtime.fetch(
      new Request("http://mock.local/connect/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "wrong",
          client_secret: "x",
        }),
      }),
    )
    expect(token.status).toBe(400)
    expect(await token.json()).toEqual({ error: "invalid_client" })
    expect(() =>
      serveTarget.create(
        { "results-s3-endpoint": "http://127.0.0.1:4569" },
        { adminKey: undefined, seed: undefined, onLog: undefined },
      ),
    ).toThrow(/go together/)
  })
})

describe("served over HTTP", () => {
  test("our consumer places, the kit completes, a Bun sink receives signed webhooks, and the presigned URL downloads", async () => {
    const received: { event: string | null; verified: boolean }[] = []
    let secret = ""
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = await request.text()
        const expected = `sha512=${createHmac("sha512", secret).update(body).digest("hex")}`
        received.push({
          event: request.headers.get("gxg-eventtype"),
          verified: request.headers.get("gxg-signature") === expected,
        })
        return new Response("{}", { status: 200 })
      },
    })
    const server = await createServer()
    try {
      const c = consumer(server.url, (r) => fetch(r))
      secret = (
        await c.createNotificationSubscription(
          `http://127.0.0.1:${sink.port}/webhooks/gene-by-gene`,
          [
            "GxG.Nucleus.Order.Created",
            "GxG.Nucleus.Order.KitNumbersGenerated",
            "GxG.Nucleus.Kit.Completed",
          ],
        )
      ).secret
      const placed = await placeOrder(c, {
        productId: BUNDLE,
        placerOrderNumber: "p",
        address: ADDRESS,
      })
      expect(placed.ok).toBe(true)
      const kit = placed.ok ? (placed.kitNumbers[0] as string) : ""
      const done = await fetch(`${server.url}/__admin/kits/${kit}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "Completed", fixture: "ancestry" }),
      })
      expect(done.status).toBe(200)
      const deadline = Date.now() + 3_000
      while (received.length < 4 && Date.now() < deadline) await Bun.sleep(25)
      const events = [
        "GxG.Nucleus.Order.Created",
        "GxG.Nucleus.Order.KitNumbersGenerated",
        "GxG.Nucleus.Kit.Completed",
        "GxG.Nucleus.Kit.Completed",
      ]
      // The hub publishes in order but posts each delivery concurrently, so events emitted
      // back to back can reach the sink in either order: check order where it is published.
      expect(server.runtime.webhooks.messages().map((m) => m.type)).toEqual(events)
      expect(received.map((r) => r.event).sort()).toEqual([...events].sort())
      expect(received.every((r) => r.verified)).toBe(true)
      const { presignedUrl } = await c.fetchResultPresignedUrl({
        kitNumber: kit,
        resultType: "nutrigenomics_comprehensive_report_json",
      })
      expect(presignedUrl.startsWith(`${server.url}/__blob/`)).toBe(true)
      const blob = await fetch(presignedUrl)
      expect(blob.status).toBe(200)
      expect(((await blob.json()) as { ancestry?: unknown }).ancestry).toBeDefined()
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
