import { describe, expect, test } from "bun:test"
import {
  createDevResources,
  DEV_MESSAGES,
  DEV_STORAGE_KEYS,
  type DevServiceSpec,
  type DevStorage,
} from "./src/dev.js"
import {
  createDevProxy,
  type DevEnv,
  type DevProxyOptions,
  devProviders,
  NON_PROD_PATTERNS,
} from "./src/dev-proxy.js"

const ENV: DevEnv = {
  STRIPE_SECRET_KEY: "sk_test_StripeSecretFixture",
  RESEND_API_KEY: "re_resend-secret-fixture",
}

const ALLOW: DevProxyOptions["allow"] = {
  ...NON_PROD_PATTERNS,
  RESEND_API_KEY: /^re_[a-z-]+$/,
}

const memory = (): DevStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

/** An emulator's `/__admin/upstream`, with the core runtime's answers (409 without upstream). */
const fakeEmulator = (id: string, options: { upstream?: boolean; label?: string } = {}) => {
  let mode: "emulated" | "forward" = "emulated"
  const writes: string[] = []
  const admin = async (request: Request): Promise<Response> => {
    expect(new URL(request.url).pathname).toBe("/__admin/upstream")
    if (request.method === "GET")
      return Response.json(
        options.upstream === false ? { mode: "emulated" } : { mode, baseUrl: "https://x/" },
      )
    const body = (await request.json()) as { mode: "emulated" | "forward" }
    writes.push(body.mode)
    if (options.upstream === false)
      return body.mode === "forward"
        ? Response.json({ error: "an upstream fetch is required" }, { status: 409 })
        : Response.json({ error: "invalid upstream settings" }, { status: 400 })
    mode = body.mode
    return Response.json({ mode })
  }
  const spec: DevServiceSpec = {
    id,
    label: options.label ?? id[0]?.toUpperCase() + id.slice(1),
    category: "Category",
    admin,
  }
  return {
    spec,
    writes,
    get mode() {
      return mode
    },
    reload: () => {
      mode = "emulated"
    },
  }
}

/**
 * Dev resources whose fetch is an in-memory proxy (outgoing fetch: a stub vendor). The fetch adds
 * `Sec-Fetch-Site` the way a browser does for the page's own origin (`site`).
 */
const rig = (env: DevEnv = ENV, storage = memory(), allow = ALLOW, site = "same-origin") => {
  const vendor: Request[] = []
  const proxy = createDevProxy({
    providers: Object.values(devProviders),
    env,
    allow,
    basePath: "/__dev",
    fetch: async (request) => {
      vendor.push(request)
      return Response.json({ id: "vendor" })
    },
  })
  const seen: Request[] = []
  const dev = createDevResources({
    proxyUrl: "https://lab.example/__dev/",
    storage,
    fetch: async (request) => {
      seen.push(request.clone())
      const browser = new Request(request)
      browser.headers.set("sec-fetch-site", site)
      return proxy(browser)
    },
  })
  return { dev, storage, vendor, seen }
}

describe("upstream()", () => {
  test("points at the proxy, sends no key and drops authorization and cookies", async () => {
    const { dev, seen } = rig()
    const upstream = dev.upstream("stripe")
    expect(upstream.baseUrl).toBe("https://lab.example/__dev/stripe")
    const rewritten = upstream.rewriteAuth(
      new Request(`${upstream.baseUrl}/v1/customers`, {
        headers: {
          authorization: "Bearer sk_test_fake",
          cookie: "session=1",
          "stripe-version": "2024-06-20",
        },
      }),
    )
    expect(rewritten.headers.has("authorization")).toBe(false)
    expect(rewritten.headers.has("cookie")).toBe(false)
    expect(rewritten.headers.get("stripe-version")).toBe("2024-06-20")
    const response = await upstream.fetch(rewritten)
    expect(response.status).toBe(200)
    expect([...(seen[0]?.headers.keys() ?? [])].filter((name) => name.includes("key"))).toEqual([])
  })

  test("a cross-site page is refused by the proxy and nothing reaches the vendor", async () => {
    const { dev, vendor } = rig(ENV, memory(), ALLOW, "cross-site")
    const upstream = dev.upstream("stripe")
    const response = await upstream.fetch(new Request(`${upstream.baseUrl}/v1/customers`))
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("cross_origin")
    expect(vendor).toHaveLength(0)
  })

  test("a relative proxyUrl resolves against location.origin", () => {
    const location = (globalThis as { location?: unknown }).location
    Object.defineProperty(globalThis, "location", {
      value: { origin: "https://pr-7.preview.example" },
      configurable: true,
    })
    try {
      const dev = createDevResources({ proxyUrl: "/__dev", storage: memory() })
      expect(dev.upstream("resend").baseUrl).toBe("https://pr-7.preview.example/__dev/resend")
    } finally {
      Object.defineProperty(globalThis, "location", { value: location, configurable: true })
    }
  })

  test("a relative proxyUrl outside a page is rejected", () => {
    expect(() => createDevResources({ proxyUrl: "/__dev", storage: memory() })).toThrow("absolute")
  })

  test("without a proxyUrl the upstream refuses locally and never touches the network", async () => {
    let called = false
    const dev = createDevResources({
      storage: memory(),
      fetch: async () => {
        called = true
        return new Response()
      },
    })
    const upstream = dev.upstream("stripe")
    expect(new URL(upstream.baseUrl).protocol).toBe("https:")
    const response = await upstream.fetch(new Request(`${upstream.baseUrl}/v1/x`))
    expect(response.status).toBe(503)
    expect(called).toBe(false)
  })
})

describe("controls()", () => {
  test("list reports modes, categories and per-service availability once access is granted", async () => {
    const { dev } = rig({ ...ENV, STRIPE_SECRET_KEY: "sk_live_live-key-fixture" })
    const stripe = fakeEmulator("stripe")
    const resend = fakeEmulator("resend")
    const twilio = fakeEmulator("twilio")
    const local = fakeEmulator("keycloak", { upstream: false })
    local.spec.unsupported = "Runs in this browser"
    const unknown = fakeEmulator("mystery")
    const controls = dev.controls([stripe.spec, resend.spec, twilio.spec, local.spec, unknown.spec])
    const { dev: status, services } = await controls.list()
    expect(status).toEqual({
      state: "ready",
      message: DEV_MESSAGES.ready,
      endpoint: "https://lab.example/__dev",
    })
    const byId = Object.fromEntries(services.map((service) => [service.id, service]))
    expect(byId.resend).toEqual({
      id: "resend",
      label: "Resend",
      category: "Category",
      mode: "emulated",
    })
    expect(byId.stripe?.unavailable).toBe("STRIPE_SECRET_KEY is a production credential")
    expect(byId.twilio?.unavailable).toBe(
      "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN on the proxy",
    )
    expect(byId.keycloak?.unavailable).toBe("Runs in this browser")
    expect(byId.mystery?.unavailable).toBe("The dev proxy does not offer Mystery")
  })

  test("reason precedence: unsupported > none > unreachable > missing > blocked", async () => {
    const stripe = fakeEmulator("stripe")
    const unsupported = { ...stripe.spec, unsupported: "Not forwardable" }
    const reasonFor = async (dev: ReturnType<typeof createDevResources>, spec: DevServiceSpec) => {
      const { dev: status, services } = await dev.controls([spec]).list()
      return { state: status.state, reason: services[0]?.unavailable }
    }

    const none = createDevResources({ storage: memory() })
    expect(await reasonFor(none, unsupported)).toEqual({ state: "none", reason: "Not forwardable" })
    expect(await reasonFor(none, stripe.spec)).toEqual({
      state: "none",
      reason: DEV_MESSAGES.none,
    })

    const down = createDevResources({
      proxyUrl: "https://down.example",
      storage: memory(),
      fetch: async () => {
        throw new TypeError("fetch failed")
      },
    })
    const unreachable = await reasonFor(down, stripe.spec)
    expect(unreachable.state).toBe("unreachable")
    expect(unreachable.reason).toContain("https://down.example")
    const notJson = createDevResources({
      proxyUrl: "https://html.example",
      storage: memory(),
      fetch: async () => new Response("<html>", { status: 200 }),
    })
    expect((await reasonFor(notJson, stripe.spec)).state).toBe("unreachable")

    const refused = rig(ENV, memory(), ALLOW, "cross-site")
    expect(await reasonFor(refused.dev, stripe.spec)).toEqual({
      state: "unreachable",
      reason:
        "The dev proxy at https://lab.example/__dev refused the request: The dev proxy only answers same-origin browser requests",
    })
    expect(await reasonFor(refused.dev, unsupported)).toEqual({
      state: "unreachable",
      reason: "Not forwardable",
    })

    const missing = rig({ ...ENV, STRIPE_SECRET_KEY: undefined })
    expect(await reasonFor(missing.dev, stripe.spec)).toEqual({
      state: "ready",
      reason: "Missing STRIPE_SECRET_KEY on the proxy",
    })

    const live = rig({ ...ENV, STRIPE_SECRET_KEY: "sk_live_fixture" })
    const error = await reasonFor(live.dev, stripe.spec)
    expect(error.reason).toBe("STRIPE_SECRET_KEY is a production credential")
    expect(error.reason).not.toContain("sk_live_fixture")

    const ready = rig()
    expect(await reasonFor(ready.dev, stripe.spec)).toEqual({
      state: "ready",
      reason: undefined,
    })
  })

  test("a provider the proxy blocks shows the proxy's reason, never a value", async () => {
    const { RESEND_API_KEY: _resend, ...allow } = ALLOW
    const { dev } = rig(ENV, memory(), allow)
    const resend = fakeEmulator("resend")
    const controls = dev.controls([resend.spec])
    const { services } = await controls.list()
    expect(services[0]?.unavailable).toBe("No allow-list pattern for RESEND_API_KEY")
    await expect(controls.setMode("resend", "dev")).rejects.toThrow("No allow-list pattern")
    expect(resend.writes).toEqual([])
  })

  test("status sentences and storage keys use the dev wording", () => {
    expect(DEV_MESSAGES).toEqual({
      none: "No dev proxy is configured for this preview",
      ready:
        "Dev resources are available: switch a service to send its requests to its dev resource",
    })
    expect(DEV_STORAGE_KEYS).toEqual({
      modes: "mockingbird.dev.modes",
    })
  })

  test("setMode switches the emulator through /__admin/upstream and persists the choice", async () => {
    const { dev, storage } = rig()
    const resend = fakeEmulator("resend")
    const controls = dev.controls([resend.spec])
    await controls.setMode("resend", "dev")
    expect(resend.writes).toEqual(["forward"])
    expect(resend.mode).toBe("forward")
    expect(JSON.parse(storage.getItem(DEV_STORAGE_KEYS.modes) ?? "")).toEqual({
      resend: "dev",
    })
    expect((await controls.list()).services[0]?.mode).toBe("dev")
    await controls.setMode("resend", "emulated")
    expect(resend.writes).toEqual(["forward", "emulated"])
    expect(JSON.parse(storage.getItem(DEV_STORAGE_KEYS.modes) ?? "")).toEqual({})
    expect((await controls.list()).services[0]?.mode).toBe("emulated")
  })

  test("setMode refuses with a human message when dev is unavailable, without touching the emulator", async () => {
    const { dev, storage } = rig(ENV, memory(), ALLOW, "cross-site")
    const stripe = fakeEmulator("stripe")
    const local = fakeEmulator("keycloak", { upstream: false })
    local.spec.unsupported = "Runs in this browser"
    const controls = dev.controls([stripe.spec, local.spec])
    await expect(controls.setMode("stripe", "dev")).rejects.toThrow("refused the request")
    await expect(controls.setMode("keycloak", "dev")).rejects.toThrow("Runs in this browser")
    await expect(controls.setMode("nope", "dev")).rejects.toThrow("Unknown service nope")
    expect(stripe.writes).toEqual([])
    expect(storage.getItem(DEV_STORAGE_KEYS.modes)).toBeNull()
    // Switching back to emulated is always allowed, even for an emulator without upstream.
    await controls.setMode("keycloak", "emulated")
    const none = createDevResources({ storage: memory() }).controls([stripe.spec])
    await expect(none.setMode("stripe", "dev")).rejects.toThrow(DEV_MESSAGES.none)
  })

  test("an emulator that refuses forwarding surfaces its error", async () => {
    const { dev, storage } = rig()
    const stripe = fakeEmulator("stripe", { upstream: false })
    await expect(dev.controls([stripe.spec]).setMode("stripe", "dev")).rejects.toThrow(
      "an upstream fetch is required",
    )
    expect(storage.getItem(DEV_STORAGE_KEYS.modes)).toBeNull()
  })

  test("after a reload the first list re-applies stored dev modes that are still available", async () => {
    const storage = memory()
    const first = rig(ENV, storage)
    const resend = fakeEmulator("resend")
    const stripe = fakeEmulator("stripe")
    const before = first.dev.controls([resend.spec, stripe.spec])
    await before.setMode("resend", "dev")
    await before.setMode("stripe", "dev")

    // Reload: emulators boot emulated, Stripe's key is no longer configured on the proxy.
    resend.reload()
    stripe.reload()
    resend.writes.length = 0
    stripe.writes.length = 0
    const second = rig({ ...ENV, STRIPE_SECRET_KEY: undefined }, storage)
    const after = second.dev.controls([resend.spec, stripe.spec])
    const listed = await after.list()
    expect(resend.writes).toEqual(["forward"])
    expect(stripe.writes).toEqual([])
    expect(listed.services.map((service) => [service.id, service.mode])).toEqual([
      ["resend", "dev"],
      ["stripe", "emulated"],
    ])
    // Only the first list re-applies.
    resend.reload()
    await after.list()
    expect(resend.writes).toEqual(["forward"])
    // The stored choice is kept, so it returns when the proxy is configured again.
    expect(JSON.parse(storage.getItem(DEV_STORAGE_KEYS.modes) ?? "")).toEqual({
      resend: "dev",
      stripe: "dev",
    })
  })

  test("a throwing storage never breaks the controls", async () => {
    const broken: DevStorage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
    }
    const { dev } = rig(ENV, broken as ReturnType<typeof memory>)
    const controls = dev.controls([fakeEmulator("resend").spec])
    await controls.setMode("resend", "dev")
    expect((await controls.list()).services[0]?.mode).toBe("dev")
  })
})
