import { expect, test } from "bun:test"
import { createRuntime } from "@crvouga/mockingbird-service"
import type { ServeTarget } from "./src/cli.js"
import { startFleet } from "./src/fleet.js"

const target: ServeTarget = {
  name: "fixture",
  defaultPort: 0,
  supportsUpstream: true,
  create: (_values, common) =>
    createRuntime({
      name: "fixture",
      ...(common.upstream ? { upstream: common.upstream } : {}),
      create: () => ({ fetch: async () => new Response("emulated"), reset: async () => {} }),
    }),
}
const config = {
  services: {
    alias: { target: "fixture", port: 0, upstream: { baseUrl: "https://vendor.example" } },
  },
}

test("declarative fleet upstream requires injected transport and retains service switching", async () => {
  await expect(startFleet(config, { load: async () => target })).rejects.toThrow(
    "host-injected fetch",
  )
  let sent = 0
  const fleet = await startFleet(config, {
    load: async () => target,
    upstreams: {
      alias: {
        fetch: () => {
          sent++
          return new Response("real-response", { status: 201 })
        },
      },
    },
  })
  try {
    const service = fleet.manifest.services.alias?.url
    expect(await (await fetch(`${service}/send`)).text()).toBe("emulated")
    expect(sent).toBe(0)
    const control = `${fleet.manifest.adminBase}/services/alias/upstream`
    const changed = await fetch(control, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "forward" }),
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ mode: "forward" })
    const response = await fetch(`${service}/send`)
    expect(response.status).toBe(201)
    expect(await response.text()).toBe("real-response")
    expect(sent).toBe(1)
    expect((await (await fetch(control)).json()).mode).toBe("forward")
  } finally {
    await fleet.close()
  }
})

test("unsupported targets refuse forwarding before a listener starts", async () => {
  const { supportsUpstream: _unsupported, ...unsupported } = target
  await expect(
    startFleet(config, {
      load: async () => unsupported,
      upstreams: { alias: { fetch: () => new Response() } },
    }),
  ).rejects.toThrow("not supported")
})
