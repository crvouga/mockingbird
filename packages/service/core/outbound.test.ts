import { expect, test } from "bun:test"
import { ownedTransport } from "./src/outbound.js"
import { createWebhookHub, signers } from "./src/webhooks.js"

test("owned outbound allowlists check redirect targets before a second send (#426)", async () => {
  const sent: string[] = [], rejections: unknown[] = []
  const transport = ownedTransport({ mode: "allowlist", origins: ["http://receiver.example.test"], onReject: (event) => rejections.push(event) })
  const send: typeof fetch = (async (request: Request) => { sent.push(request.url); return new Response(null, { status: 307, headers: { location: "https://unapproved.example.test/private" } }) }) as typeof fetch
  await expect(transport(new Request("http://receiver.example.test/hook", { method: "POST", body: "synthetic-private-body" }), "alpha", send)).rejects.toThrow("destination not allowed")
  expect(sent).toEqual(["http://receiver.example.test/hook"])
  expect(JSON.stringify(rejections)).not.toContain("private")
  expect(JSON.stringify(rejections)).not.toContain("http")
})

test("offline policy sends nothing; denied beta delivery leaves allowed signed alpha work usable (#426)", async () => {
  let sends = 0
  const send: typeof fetch = (async (request: Request) => { sends++; expect(request.headers.get("x-synthetic-signature")).toBe("synthetic-signing-value"); return new Response("ok") }) as typeof fetch
  await expect(ownedTransport({ mode: "offline" })(new Request("http://receiver.example.test/hook"), "beta", send)).rejects.toThrow("disabled")
  expect(sends).toBe(0)
  const hub = createWebhookHub({ signer: signers.header("x-synthetic-signature"), fetch: send, retryDelaysMs: [0] })
  hub.setTransportPolicy(ownedTransport({ mode: "allowlist", origins: ["http://receiver.example.test"] }))
  hub.setEndpoints("alpha", [{ url: "http://receiver.example.test/hook", secret: "synthetic-signing-value" }])
  hub.setEndpoints("beta", [{ url: "https://unapproved.example.test/hook" }])
  hub.publish({ namespace: "beta", type: "synthetic", body: {} }); hub.publish({ namespace: "alpha", type: "synthetic", body: {} })
  await hub.idle()
  expect(sends).toBe(1)
  expect(hub.deliveries("beta")[0]?.state).toBe("failed")
  expect(hub.deliveries("alpha")[0]?.state).toBe("delivered")
})
