import { describe, expect, test } from "bun:test"
import { createApi } from "./src/api.js"
import { brandCatalogUrl, brandFor } from "./src/brand.js"
import type { AdminConfig } from "./src/model.js"

const config: AdminConfig = {
  service: "notes",
  adminPrefix: "/mock/admin/",
  adminKeyHeader: "x-mockingbird-admin-key",
  brandsUrl: "https://docs.example/brands.json",
  standardRoutes: [],
}

describe("admin transport", () => {
  test("all controls use the configured prefix, namespace, and admin credential", async () => {
    const requests: Request[] = []
    const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(new URL(String(input), "https://mock.local"), init)
      requests.push(request)
      return Response.json({ ok: true })
    }
    const api = createApi(config, transport as typeof fetch, "parallel-test", "test-only-admin-key")
    await api.get("/state/a%2Fb?limit=50")
    await api.send("PUT", "/state/notes/id%201", { value: { message: "<b>literal</b>" } })
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mock/admin/state/a%2Fb",
      "/mock/admin/state/notes/id%201",
    ])
    for (const request of requests) {
      expect(request.headers.get("x-mockingbird-namespace")).toBe("parallel-test")
      expect(request.headers.get(config.adminKeyHeader)).toBe("test-only-admin-key")
    }
    expect(requests[0]?.headers.has("content-type")).toBe(false)
    expect(await requests[1]?.json()).toEqual({ value: { message: "<b>literal</b>" } })
  })

  test("failed and non-JSON responses become useful errors; empty credentials are omitted", async () => {
    const transport = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has(config.adminKeyHeader)).toBe(false)
      return Response.json({ error: { message: "Admin key required" } }, { status: 401 })
    }
    await expect(
      createApi(config, transport as typeof fetch, "default", "").get("/state"),
    ).rejects.toThrow("Admin key required")
    const forbidden = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ error: "You cannot change your own role." }, { status: 409 })
    await expect(
      createApi(config, forbidden as typeof fetch, "default", "").get("/admin"),
    ).rejects.toThrow("You cannot change your own role.")
    const unavailable = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("proxy unavailable", { status: 502 })
    await expect(
      createApi(config, unavailable as typeof fetch, "default", "").get("/state"),
    ).rejects.toThrow("502")
  })
})

describe("brand metadata", () => {
  test("only local or same-origin catalog overrides are accepted", () => {
    const page = "http://127.0.0.1:4321/__admin/ui"
    expect(brandCatalogUrl(config.brandsUrl, page)).toBe(config.brandsUrl)
    expect(brandCatalogUrl(config.brandsUrl, `${page}?brands=/brands.json`)).toBe(
      "http://127.0.0.1:4321/brands.json",
    )
    expect(
      brandCatalogUrl(config.brandsUrl, `${page}?brands=https://evil.example/catalog.json`),
    ).toBe(config.brandsUrl)
    expect(brandCatalogUrl(config.brandsUrl, `${page}?brands=javascript:alert(1)`)).toBe(
      config.brandsUrl,
    )
  })
  test("hostile links are discarded and names remain plain React text", () => {
    expect(brandFor("notes", {})).toBe(null)
    const brand = brandFor("notes", {
      notes: {
        vendor: "<img src=x>",
        website: "javascript:alert(1)",
        logo: "data:text/html,hi",
        docs: "https://docs.example/notes",
      },
    })
    expect(brand?.vendor).toBe("<img src=x>")
    expect(brand?.website).toBeUndefined()
    expect(brand?.logo).toBeUndefined()
    expect(brand?.docs).toBe("https://docs.example/notes")
  })
  test("a relative catalog URL resolves against the page, so an emulator serves its own", () => {
    const page = "http://127.0.0.1:4310/mount/__admin/ui"
    expect(brandCatalogUrl("/mount/__admin/ui/brands.json", page)).toBe(
      "http://127.0.0.1:4310/mount/__admin/ui/brands.json",
    )
    expect(brandCatalogUrl("/mount/__admin/ui/brands.json", `${page}?brands=/b.json`)).toBe(
      "http://127.0.0.1:4310/b.json",
    )
  })
  test("an embedded raster or SVG logo is accepted as a base64 data URI, nothing else", () => {
    const png = "data:image/png;base64,iVBORw0KGgo="
    const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
    expect(brandFor("notes", { notes: { vendor: "Notes", logo: png } })?.logo).toBe(png)
    expect(brandFor("notes", { notes: { vendor: "Notes", logo: svg } })?.logo).toBe(svg)
    for (const logo of [
      "data:text/html;base64,PGgxPg==",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "data:image/png;base64,not base64!",
    ])
      expect(brandFor("notes", { notes: { vendor: "Notes", logo } })?.logo).toBeUndefined()
  })
})
