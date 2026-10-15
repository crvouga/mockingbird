import { expect, test } from "bun:test"
import { serveTarget } from "../../service/stripe/src/server.js"
import { startFleet } from "./src/fleet.js"
import { createFleetIngress } from "./src/fleet-proxy.js"

test("fixed public ingress keeps Stripe hosted pages and namespace follow-ups behind an HTTPS prefix (#419)", async () => {
  const config = {
    adminKey: "synthetic-admin",
    services: {
      billing: {
        target: "stripe",
        port: 0,
        publicOrigin: "https://synthetic.example.test",
        publicPath: "/billing",
      },
    },
  }
  const fleet = await startFleet(config, { load: async () => serveTarget })
  try {
    expect(fleet.manifest.services.billing?.url).toBe("https://synthetic.example.test/billing")
    const ingress = createFleetIngress(config, {
      version: 1,
      services: { billing: { url: fleet.children.get("billing")?.url ?? "" } },
    })
    const session = await ingress(
      new Request("https://synthetic.example.test/billing/__admin/ns/alpha/v1/checkout/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer sk_test_mockingbird",
          forwarded: "host=attacker.example.test;proto=http",
          host: "attacker.example.test",
          "x-forwarded-host": "attacker.example.test",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          mode: "payment",
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": "1000",
          "line_items[0][price_data][product_data][name]": "Synthetic item",
          "line_items[0][quantity]": "1",
          success_url: "https://app.example.test/success",
        }),
      }),
    )
    expect(session.status).toBe(200)
    const created = (await session.json()) as { url: string; id: string }
    expect(created.url).toStartWith(
      "https://synthetic.example.test/billing/__admin/ns/alpha/c/pay/",
    )
    expect(created.url).not.toContain("127.0.0.1")
    const page = await ingress(new Request(created.url))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain(created.id)
    const follow = await ingress(
      new Request(
        `https://synthetic.example.test/billing/__admin/ns/alpha/v1/checkout/sessions/${created.id}`,
        { headers: { authorization: "Bearer sk_test_mockingbird" } },
      ),
    )
    expect(follow.status).toBe(200)
    const wrongNamespace = await ingress(
      new Request(
        `https://synthetic.example.test/billing/__admin/ns/beta/v1/checkout/sessions/${created.id}`,
        { headers: { authorization: "Bearer sk_test_mockingbird" } },
      ),
    )
    expect(wrongNamespace.status).toBe(404)
    expect(
      (
        await ingress(
          new Request("https://synthetic.example.test/billing/__admin/metrics", {
            headers: { "x-mockingbird-admin-key": "synthetic-admin" },
          }),
        )
      ).status,
    ).toBe(403)
    await expect(
      startFleet(
        { services: { s3: { publicOrigin: "https://synthetic.example.test" } } },
        { load: async () => serveTarget },
      ),
    ).rejects.toThrow("preserve signed targets")
  } finally {
    await fleet.close()
  }
})

test("reference ingress streams without buffering and propagates cancellation (#419)", async () => {
  let cancelled = false
  const abort = new AbortController()
  const transport = (async (request: Request) => {
    expect(request.url).toBe("http://127.0.0.1:9876/stream")
    expect(request.headers.has("forwarded")).toBe(false)
    expect(request.signal.aborted).toBe(false)
    request.signal.addEventListener("abort", () => {
      cancelled = true
    })
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("first"))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
  }) as typeof fetch
  const ingress = createFleetIngress(
    { services: { stripe: { publicOrigin: "https://example.test", publicPath: "/billing" } } },
    { version: 1, services: { stripe: { url: "http://127.0.0.1:9876" } } },
    transport,
  )
  const response = await ingress(
    new Request("https://example.test/billing/stream", { signal: abort.signal }),
  )
  const reader = response.body?.getReader()
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("first")
  await reader?.cancel()
  abort.abort()
  expect(cancelled).toBe(true)
})
