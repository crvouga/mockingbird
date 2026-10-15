import { expect, test } from "bun:test"
import { createRuntime, createWebhookHub, signers } from "./src/index.js"

const runtime = (hub: ReturnType<typeof createWebhookHub>) =>
  createRuntime({
    name: "synthetic",
    webhooks: hub,
    create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
  })

test("pending delivery is counted once and only in its namespace (#361)", async () => {
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const started = new Promise<void>((r) => {
    entered = r
  })
  const hub = createWebhookHub({
    signer: signers.none(),
    endpoints: [{ url: "http://receiver.example.test/synthetic" }],
    fetch: async () => {
      entered()
      await gate
      return new Response("ok")
    },
  })
  const app = runtime(hub)
  hub.publish({ namespace: "beta", type: "synthetic", body: {} })
  try {
    await started
    expect(hub.pending("alpha")).toBe(0)
    expect(hub.pending("beta")).toBe(1)
    expect(() => app.snapshots.create({ namespace: "alpha", name: "base" })).not.toThrow()
    await app.reset("alpha")
    expect(hub.pending("beta")).toBe(1)
  } finally {
    release()
    await hub.idle()
  }
})

test("portable webhook restore restores endpoints/history in this and a fresh runtime (#360)", async () => {
  const hub = createWebhookHub({ signer: signers.none() })
  const app = runtime(hub)
  hub.setEndpoints("alpha", [{ url: "http://receiver.example.test/first" }])
  app.snapshots.create({ namespace: "alpha", name: "base" })
  const doc = JSON.parse(JSON.stringify(app.snapshots.export("base", "alpha")))
  hub.setEndpoints("alpha", [{ url: "http://receiver.example.test/second" }])
  for (const current of [app, runtime(createWebhookHub({ signer: signers.none() }))]) {
    current.snapshots.import(doc, { name: "copy", namespace: "alpha" })
    current.snapshots.restore("copy", "alpha")
    expect(current.webhooks?.endpoints("alpha").map((e) => e.url)).toEqual([
      "http://receiver.example.test/first",
    ])
    const empty = { ...doc, webhooks: { ...doc.webhooks, endpoints: [] } }
    current.snapshots.import(empty, { name: "empty", namespace: "alpha" })
    current.snapshots.restore("empty", "alpha")
    expect(current.webhooks?.endpoints("alpha")).toEqual([])
  }
})
