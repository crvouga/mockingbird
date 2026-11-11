import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer as twilio } from "@crvouga/mockingbird-service-twilio/server"
import { createNotificationHarness } from "./src/index.js"
import { adminGateway, createServer, type NotificationServer } from "./src/server.js"

type Seen = {
  method: string
  url: string
  key: string | null
  namespace: string | null
  body: string
}

/** A stand-in for any emulator's admin API (one the harness reads no messages from). */
const emulator = (seen: Seen[]) => async (request: Request) => {
  const url = new URL(request.url)
  seen.push({
    method: request.method,
    url: `${url.pathname}${url.search}`,
    key: request.headers.get("x-mockingbird-admin-key"),
    namespace: request.headers.get("x-mockingbird-namespace"),
    body: request.method === "GET" ? "" : await request.text(),
  })
  if (url.pathname === "/__admin/health") return Response.json({ status: "ok", service: "ledger" })
  if (url.pathname === "/__admin/boom") throw new Error("socket closed")
  return Response.json({ ok: true }, { status: request.method === "POST" ? 201 : 200 })
}

const get = (
  harness: { fetch(request: Request): Promise<Response> },
  path: string,
  init?: RequestInit,
) => harness.fetch(new Request(`http://harness.test${path}`, init))

describe("admin gateway", () => {
  test("fronts every emulator's admin API, messaging or not", async () => {
    const seen: Seen[] = []
    const harness = createNotificationHarness({
      // One in-process, one by URL (over the harness's transport) under a name that is no id.
      services: { ledger: { fetch: emulator(seen) }, "Card Vault": "http://vault.test" },
      fetch: emulator(seen),
      admin: adminGateway(),
      pollIntervalMs: 0,
    })
    const info = (await (await get(harness, "/api/admin")).json()) as {
      admin: { adminPrefix: string; apis: { id: string; label: string; adminPrefix: string }[] }
      emulators: { name: string; target: string }[]
      fleet: unknown
    }
    expect(info.emulators.map((e) => e.name)).toEqual(["ledger", "Card Vault"])
    expect(info.fleet).toBeNull()
    expect(info.admin.adminPrefix).toBe("/admin/apis/ledger")
    expect(info.admin.apis.map((api) => [api.id, api.label, api.adminPrefix])).toEqual([
      ["ledger", "ledger", "/admin/apis/ledger"],
      ["card-vault", "Card Vault", "/admin/apis/card-vault"],
    ])

    const health = await get(harness, "/admin/apis/ledger/health")
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: "ok", service: "ledger" })

    // Writes pass through: only the harness's own routes are read-only.
    const reset = await get(harness, "/admin/apis/card-vault/reset?hard=1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mockingbird-namespace": "run-7" },
      body: JSON.stringify({ keep: ["plans"] }),
    })
    expect(reset.status).toBe(201)
    expect(seen.at(-1)).toEqual({
      method: "POST",
      url: "/__admin/reset?hard=1",
      key: null,
      namespace: "run-7",
      body: '{"keep":["plans"]}',
    })
    expect((await get(harness, "/api/notifications", { method: "POST" })).status).toBe(405)
    expect((await get(harness, "/admin/apis/nobody/health")).status).toBe(404)
    harness.close()
  })

  test("adds the harness's admin key unless the request brings its own", async () => {
    const seen: Seen[] = []
    const harness = createNotificationHarness({
      services: { ledger: { fetch: emulator(seen) }, vault: { fetch: emulator(seen) } },
      adminKey: "fleet-key",
      adminKeys: { vault: "vault-key" },
      admin: adminGateway(),
      pollIntervalMs: 0,
    })
    await get(harness, "/admin/apis/ledger/state")
    expect(seen.at(-1)?.key).toBe("fleet-key")
    await get(harness, "/admin/apis/vault/state")
    expect(seen.at(-1)?.key).toBe("vault-key")
    await get(harness, "/admin/apis/vault/state", {
      headers: { "x-mockingbird-admin-key": "typed-by-viewer" },
    })
    expect(seen.at(-1)?.key).toBe("typed-by-viewer")
    harness.close()
  })

  test("an unreachable emulator is a 502 that names it", async () => {
    const harness = createNotificationHarness({
      services: { ledger: { fetch: emulator([]) } },
      admin: adminGateway(),
      pollIntervalMs: 0,
    })
    const response = await get(harness, "/admin/apis/ledger/boom")
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("ledger is unreachable")
    expect(body.error.message).toContain("socket closed")
    harness.close()
  })

  test("serves the admin UI as an external script and as a page", async () => {
    const harness = createNotificationHarness({
      services: { ledger: { fetch: emulator([]) } },
      admin: adminGateway({ brandsUrl: "https://brands.test/brands.json" }),
      title: "Acme lab",
      pollIntervalMs: 0,
    })
    const script = await get(harness, "/admin/ui.js")
    expect(script.headers.get("content-type")).toStartWith("text/javascript")
    const source = await script.text()
    expect(source.length).toBeGreaterThan(100_000)
    // Booleans, so a failure does not print the megabyte it looked in.
    expect(source.includes("MockingbirdAdmin")).toBe(true)
    expect(source.trimStart().startsWith("<script")).toBe(false)
    // The page mounts it itself, with the config from /api/admin.
    expect(source.trimEnd().endsWith("</script>")).toBe(false)
    expect(source.includes('MockingbirdAdmin.mount(document.getElementById("admin-root")')).toBe(
      false,
    )
    expect((await get(harness, "/admin/ui.js", { method: "POST" })).status).toBe(405)

    const page = await get(harness, "/admin/ui")
    expect(page.headers.get("content-type")).toStartWith("text/html")
    expect((await page.text()).includes("Acme lab admin")).toBe(true)
    const info = (await (await get(harness, "/api/admin")).json()) as {
      admin: { brandsUrl: string }
    }
    expect(info.admin.brandsUrl).toBe("https://brands.test/brands.json")
    harness.close()
  })

  test("without a gateway the harness is the notifications UI alone", async () => {
    const harness = createNotificationHarness({
      services: { ledger: { fetch: emulator([]) } },
      pollIntervalMs: 0,
    })
    const info = (await (await get(harness, "/api/admin")).json()) as {
      admin: unknown
      emulators: unknown[]
    }
    expect(info.admin).toBeNull()
    expect(info.emulators).toHaveLength(1)
    expect((await get(harness, "/admin/ui.js")).status).toBe(404)
    expect((await get(harness, "/admin/apis/ledger/health")).status).toBe(404)
    harness.close()
  })

  test("with no emulators there is nothing to mount", async () => {
    const harness = createNotificationHarness({
      manifest: { services: {} },
      admin: adminGateway(),
      pollIntervalMs: 0,
    })
    const info = (await (await get(harness, "/api/admin")).json()) as { admin: unknown }
    expect(info.admin).toBeNull()
    expect((await get(harness, "/admin/apis/ledger/health")).status).toBe(404)
    harness.close()
  })
})

describe("createServer", () => {
  let emulatorServer: { url: string; close(): Promise<void> }
  let server: NotificationServer
  beforeAll(async () => {
    emulatorServer = await twilio()
    server = await createServer({
      services: { twilio: emulatorServer.url },
      defaultTab: "emulators",
      pollIntervalMs: 0,
    })
  })
  afterAll(async () => {
    await server.close()
    await emulatorServer.close()
  })

  test("turns the gateway on and proxies a real emulator over HTTP", async () => {
    const info = (await (await fetch(`${server.url}/api/admin`)).json()) as {
      admin: { apis: { id: string; service: string }[] }
    }
    expect(info.admin.apis).toMatchObject([{ id: "twilio", service: "twilio" }])
    const health = await fetch(`${server.url}/admin/apis/twilio/health`)
    expect(health.status).toBe(200)
    expect(((await health.json()) as { service: string }).service).toBe("twilio")
    const manifest = await fetch(`${server.url}/admin/apis/twilio/ui/manifest`)
    expect(manifest.status).toBe(200)
    const reset = await fetch(`${server.url}/admin/apis/twilio/reset`, { method: "POST" })
    expect(reset.status).toBeLessThan(300)
  })

  test("the page names the tab to open and loads no inline script", async () => {
    const html = await (await fetch(`${server.url}/`)).text()
    expect(html).toContain('data-default-tab="emulators"')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
  })

  test("admin: false keeps the page to notifications", async () => {
    const plain = await createServer({
      services: { twilio: emulatorServer.url },
      admin: false,
      pollIntervalMs: 0,
    })
    const info = (await (await fetch(`${plain.url}/api/admin`)).json()) as { admin: unknown }
    expect(info.admin).toBeNull()
    await plain.close()
  })
})
