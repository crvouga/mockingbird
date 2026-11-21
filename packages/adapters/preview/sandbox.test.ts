import { describe, expect, test } from "bun:test"
import {
  createSandbox,
  SANDBOX_MESSAGES,
  SANDBOX_STORAGE_KEYS,
  type SandboxServiceSpec,
  type SandboxStorage,
} from "./src/sandbox.js"
import {
  createSandboxProxy,
  SANDBOX_KEY_HEADER,
  type SandboxEnv,
  sandboxProviders,
} from "./src/sandbox-proxy.js"

const ACCESS = "viewer-access-key-fixture"
const ENV: SandboxEnv = {
  SANDBOX_PROXY_TOKEN: ACCESS,
  STRIPE_SECRET_KEY: "sk_test_stripe-secret-fixture",
  RESEND_API_KEY: "re_resend-secret-fixture",
}

const memory = (): SandboxStorage & { values: Map<string, string> } => {
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
  const spec: SandboxServiceSpec = {
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

/** A sandbox whose fetch is an in-memory proxy (outgoing fetch: a stub vendor). */
const rig = (env: SandboxEnv = ENV, storage = memory()) => {
  const vendor: Request[] = []
  const proxy = createSandboxProxy({
    providers: Object.values(sandboxProviders),
    env,
    basePath: "/__sandbox",
    fetch: async (request) => {
      vendor.push(request)
      return Response.json({ id: "vendor" })
    },
  })
  const seen: Request[] = []
  const sandbox = createSandbox({
    proxyUrl: "https://lab.example/__sandbox/",
    storage,
    fetch: async (request) => {
      seen.push(request.clone())
      return proxy(request)
    },
  })
  return { sandbox, storage, vendor, seen }
}

describe("upstream()", () => {
  test("points at the proxy, attaches the stored key and drops authorization", async () => {
    const { sandbox, storage, seen } = rig()
    storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, ACCESS)
    const upstream = sandbox.upstream("stripe")
    expect(upstream.baseUrl).toBe("https://lab.example/__sandbox/stripe")
    const rewritten = upstream.rewriteAuth(
      new Request(`${upstream.baseUrl}/v1/customers`, {
        headers: { authorization: "Bearer sk_test_fake", "stripe-version": "2024-06-20" },
      }),
    )
    expect(rewritten.headers.has("authorization")).toBe(false)
    expect(rewritten.headers.get("stripe-version")).toBe("2024-06-20")
    const response = await upstream.fetch(rewritten)
    expect(response.status).toBe(200)
    expect(seen[0]?.headers.get(SANDBOX_KEY_HEADER)).toBe(ACCESS)
  })

  test("without a stored key no key header is sent (the proxy answers 401)", async () => {
    const { sandbox, seen } = rig()
    const upstream = sandbox.upstream("stripe")
    const response = await upstream.fetch(
      new Request(`${upstream.baseUrl}/v1/customers`, {
        headers: { [SANDBOX_KEY_HEADER]: "smuggled" },
      }),
    )
    expect(response.status).toBe(401)
    expect(seen[0]?.headers.has(SANDBOX_KEY_HEADER)).toBe(false)
  })

  test("a relative proxyUrl resolves against location.origin", () => {
    const location = (globalThis as { location?: unknown }).location
    Object.defineProperty(globalThis, "location", {
      value: { origin: "https://pr-7.preview.example" },
      configurable: true,
    })
    try {
      const sandbox = createSandbox({ proxyUrl: "/__sandbox", storage: memory() })
      expect(sandbox.upstream("resend").baseUrl).toBe(
        "https://pr-7.preview.example/__sandbox/resend",
      )
    } finally {
      Object.defineProperty(globalThis, "location", { value: location, configurable: true })
    }
  })

  test("a relative proxyUrl outside a page is rejected", () => {
    expect(() => createSandbox({ proxyUrl: "/__sandbox", storage: memory() })).toThrow("absolute")
  })

  test("without a proxyUrl the upstream refuses locally and never touches the network", async () => {
    let called = false
    const sandbox = createSandbox({
      storage: memory(),
      fetch: async () => {
        called = true
        return new Response()
      },
    })
    const upstream = sandbox.upstream("stripe")
    expect(new URL(upstream.baseUrl).protocol).toBe("https:")
    const response = await upstream.fetch(new Request(`${upstream.baseUrl}/v1/x`))
    expect(response.status).toBe(503)
    expect(called).toBe(false)
  })
})

describe("controls()", () => {
  test("list reports modes, categories and per-service availability once access is granted", async () => {
    const { sandbox } = rig({ ...ENV, STRIPE_SECRET_KEY: "sk_live_live-key-fixture" })
    const stripe = fakeEmulator("stripe")
    const resend = fakeEmulator("resend")
    const twilio = fakeEmulator("twilio")
    const local = fakeEmulator("keycloak", { upstream: false })
    local.spec.unsupported = "Runs in this browser"
    const unknown = fakeEmulator("mystery")
    const controls = sandbox.controls([
      stripe.spec,
      resend.spec,
      twilio.spec,
      local.spec,
      unknown.spec,
    ])
    expect(controls.hasAccessKey()).toBe(false)
    await controls.setAccessKey(` ${ACCESS} `)
    expect(controls.hasAccessKey()).toBe(true)
    const { sandbox: status, services } = await controls.list()
    expect(status).toEqual({
      state: "ready",
      message: SANDBOX_MESSAGES.ready,
      endpoint: "https://lab.example/__sandbox",
    })
    const byId = Object.fromEntries(services.map((service) => [service.id, service]))
    expect(byId.resend).toEqual({
      id: "resend",
      label: "Resend",
      category: "Category",
      mode: "emulated",
    })
    expect(byId.stripe?.unavailable).toContain("refuses live keys")
    expect(byId.twilio?.unavailable).toBe(
      "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN on the proxy",
    )
    expect(byId.keycloak?.unavailable).toBe("Runs in this browser")
    expect(byId.mystery?.unavailable).toBe("The sandbox proxy does not offer Mystery")
  })

  test("reason precedence: unsupported > none > unreachable > off > locked > missing > error", async () => {
    const stripe = fakeEmulator("stripe")
    const unsupported = { ...stripe.spec, unsupported: "Not forwardable" }
    const reasonFor = async (
      sandbox: ReturnType<typeof createSandbox>,
      spec: SandboxServiceSpec,
    ) => {
      const { sandbox: status, services } = await sandbox.controls([spec]).list()
      return { state: status.state, reason: services[0]?.unavailable }
    }

    const none = createSandbox({ storage: memory() })
    expect(await reasonFor(none, unsupported)).toEqual({ state: "none", reason: "Not forwardable" })
    expect(await reasonFor(none, stripe.spec)).toEqual({
      state: "none",
      reason: SANDBOX_MESSAGES.none,
    })

    const down = createSandbox({
      proxyUrl: "https://down.example",
      storage: memory(),
      fetch: async () => {
        throw new TypeError("fetch failed")
      },
    })
    const unreachable = await reasonFor(down, stripe.spec)
    expect(unreachable.state).toBe("unreachable")
    expect(unreachable.reason).toContain("https://down.example")
    const notJson = createSandbox({
      proxyUrl: "https://html.example",
      storage: memory(),
      fetch: async () => new Response("<html>", { status: 200 }),
    })
    expect((await reasonFor(notJson, stripe.spec)).state).toBe("unreachable")

    const off = rig({ ...ENV, SANDBOX_PROXY_TOKEN: undefined })
    expect(await reasonFor(off.sandbox, stripe.spec)).toEqual({
      state: "off",
      reason: SANDBOX_MESSAGES.off,
    })
    expect(await reasonFor(off.sandbox, unsupported)).toEqual({
      state: "off",
      reason: "Not forwardable",
    })

    const locked = rig()
    expect(await reasonFor(locked.sandbox, stripe.spec)).toEqual({
      state: "locked",
      reason: SANDBOX_MESSAGES.locked,
    })
    locked.storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, "wrong-key")
    expect((await reasonFor(locked.sandbox, stripe.spec)).state).toBe("locked")

    const missing = rig({ ...ENV, STRIPE_SECRET_KEY: undefined })
    missing.storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, ACCESS)
    expect(await reasonFor(missing.sandbox, stripe.spec)).toEqual({
      state: "ready",
      reason: "Missing STRIPE_SECRET_KEY on the proxy",
    })

    const live = rig({ ...ENV, STRIPE_SECRET_KEY: "sk_live_fixture" })
    live.storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, ACCESS)
    const error = await reasonFor(live.sandbox, stripe.spec)
    expect(error.reason).toContain("not a test-mode key")
    expect(error.reason).not.toContain("sk_live_fixture")

    const ready = rig()
    ready.storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, ACCESS)
    expect(await reasonFor(ready.sandbox, stripe.spec)).toEqual({
      state: "ready",
      reason: undefined,
    })
  })

  test("setMode switches the emulator through /__admin/upstream and persists the choice", async () => {
    const { sandbox, storage } = rig()
    storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, ACCESS)
    const resend = fakeEmulator("resend")
    const controls = sandbox.controls([resend.spec])
    await controls.setMode("resend", "sandbox")
    expect(resend.writes).toEqual(["forward"])
    expect(resend.mode).toBe("forward")
    expect(JSON.parse(storage.getItem(SANDBOX_STORAGE_KEYS.modes) ?? "")).toEqual({
      resend: "sandbox",
    })
    expect((await controls.list()).services[0]?.mode).toBe("sandbox")
    await controls.setMode("resend", "emulated")
    expect(resend.writes).toEqual(["forward", "emulated"])
    expect(JSON.parse(storage.getItem(SANDBOX_STORAGE_KEYS.modes) ?? "")).toEqual({})
    expect((await controls.list()).services[0]?.mode).toBe("emulated")
  })

  test("setMode refuses with a human message when sandbox is unavailable, without touching the emulator", async () => {
    const { sandbox, storage } = rig()
    const stripe = fakeEmulator("stripe")
    const local = fakeEmulator("keycloak", { upstream: false })
    local.spec.unsupported = "Runs in this browser"
    const controls = sandbox.controls([stripe.spec, local.spec])
    await expect(controls.setMode("stripe", "sandbox")).rejects.toThrow(SANDBOX_MESSAGES.locked)
    await expect(controls.setMode("keycloak", "sandbox")).rejects.toThrow("Runs in this browser")
    await expect(controls.setMode("nope", "sandbox")).rejects.toThrow("Unknown service nope")
    expect(stripe.writes).toEqual([])
    expect(storage.getItem(SANDBOX_STORAGE_KEYS.modes)).toBeNull()
    // Switching back to emulated is always allowed, even for an emulator without upstream.
    await controls.setMode("keycloak", "emulated")
    const none = createSandbox({ storage: memory() }).controls([stripe.spec])
    await expect(none.setMode("stripe", "sandbox")).rejects.toThrow(SANDBOX_MESSAGES.none)
  })

  test("an emulator that refuses forwarding surfaces its error", async () => {
    const { sandbox, storage } = rig()
    storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, ACCESS)
    const stripe = fakeEmulator("stripe", { upstream: false })
    await expect(sandbox.controls([stripe.spec]).setMode("stripe", "sandbox")).rejects.toThrow(
      "an upstream fetch is required",
    )
    expect(storage.getItem(SANDBOX_STORAGE_KEYS.modes)).toBeNull()
  })

  test("after a reload the first list re-applies stored sandbox modes that are still available", async () => {
    const storage = memory()
    const first = rig(ENV, storage)
    storage.setItem(SANDBOX_STORAGE_KEYS.accessKey, ACCESS)
    const resend = fakeEmulator("resend")
    const stripe = fakeEmulator("stripe")
    const before = first.sandbox.controls([resend.spec, stripe.spec])
    await before.setMode("resend", "sandbox")
    await before.setMode("stripe", "sandbox")

    // Reload: emulators boot emulated, Stripe's key is no longer configured on the proxy.
    resend.reload()
    stripe.reload()
    resend.writes.length = 0
    stripe.writes.length = 0
    const second = rig({ ...ENV, STRIPE_SECRET_KEY: undefined }, storage)
    const after = second.sandbox.controls([resend.spec, stripe.spec])
    const listed = await after.list()
    expect(resend.writes).toEqual(["forward"])
    expect(stripe.writes).toEqual([])
    expect(listed.services.map((service) => [service.id, service.mode])).toEqual([
      ["resend", "sandbox"],
      ["stripe", "emulated"],
    ])
    // Only the first list re-applies.
    resend.reload()
    await after.list()
    expect(resend.writes).toEqual(["forward"])
    // The stored choice is kept, so it returns when the proxy is configured again.
    expect(JSON.parse(storage.getItem(SANDBOX_STORAGE_KEYS.modes) ?? "")).toEqual({
      resend: "sandbox",
      stripe: "sandbox",
    })
  })

  test("setAccessKey(null) forgets the key; blank keys are not stored", async () => {
    const { sandbox, storage } = rig()
    const controls = sandbox.controls([])
    await controls.setAccessKey(ACCESS)
    expect(storage.getItem(SANDBOX_STORAGE_KEYS.accessKey)).toBe(ACCESS)
    expect((await controls.list()).sandbox.state).toBe("ready")
    await controls.setAccessKey(null)
    expect(controls.hasAccessKey()).toBe(false)
    expect((await controls.list()).sandbox.state).toBe("locked")
    await controls.setAccessKey("   ")
    expect(controls.hasAccessKey()).toBe(false)
  })

  test("a throwing storage never breaks the controls", async () => {
    const broken: SandboxStorage = {
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
    const { sandbox } = rig(ENV, broken as ReturnType<typeof memory>)
    const controls = sandbox.controls([fakeEmulator("resend").spec])
    await controls.setAccessKey(ACCESS)
    expect(controls.hasAccessKey()).toBe(true)
    await controls.setMode("resend", "sandbox")
    expect((await controls.list()).services[0]?.mode).toBe("sandbox")
  })
})
