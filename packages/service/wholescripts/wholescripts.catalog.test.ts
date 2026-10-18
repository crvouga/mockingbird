import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CATALOG } from "./src/index.js"
import type { WholescriptsRuntime } from "./src/runtime.js"
import { loadCatalogFile, serveTarget } from "./src/server.js"
import {
  SchedulerWholescriptsAdapter,
  SchedulerWholescriptsClient,
  sampleSchedulerOrder,
} from "./test/consumer.js"

const API = "http://wholescripts.mock"
const CREDS = { username: "acme-dev", password: "s3cret" }
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }

const dir = mkdtempSync(join(tmpdir(), "wholescripts-catalog-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = (name: string, body: unknown): string => {
  const path = join(dir, name)
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body))
  return path
}

/** Rows a consumer synced from its own catalog (fake SKUs). */
const ACME = {
  products: [
    {
      sku: "ACME001",
      productName: "Acme Magnesium",
      wholesalePrice: 11.5,
      retailPrice: 20,
      quantity: 40,
    },
    // Restates a default SKU with a different price.
    {
      sku: "SKU001",
      productName: "Test Product 1",
      wholesalePrice: 5,
      retailPrice: 9,
      quantity: 100,
    },
  ],
  medPaxPills: [
    { sku: "ACMEPILL1", genericName: "Magnesium", privateLabelName: "Acme Mg", quantity: 30 },
  ],
}

const served = async (values: Record<string, string>) => {
  const runtime = (await serveTarget.create(values, COMMON)) as WholescriptsRuntime
  const send = (request: Request) => runtime.fetch(request)
  const client = new SchedulerWholescriptsClient(API, CREDS, send)
  const scheduler = new SchedulerWholescriptsAdapter(client)
  const order = (...items: string[]) => {
    const base = sampleSchedulerOrder()
    return {
      ...base,
      context: {
        ...base.context,
        fulfillment_items: items.map((product_id) => ({
          product_id,
          quantity: 1,
          fulfillment: "individual" as const,
        })),
      },
    }
  }
  const skus = async () => (await client.getProductList()).map((p) => p.sku)
  return { runtime, client, scheduler, order, skus }
}

describe("serve --catalog merges a consumer's rows onto the default catalog", () => {
  test("B1: the file's SKUs are listed beside every default row and can be ordered", async () => {
    const { skus, scheduler, order, runtime } = await served({ catalog: file("acme.json", ACME) })
    const listed = await skus()
    for (const row of DEFAULT_CATALOG.products) expect(listed).toContain(row.sku)
    expect(listed).toContain("ACME001")
    // A SKU the default does not know is rejected by a plain mock, accepted once loaded.
    const placed = await scheduler.placeOrder(order("ACME001"))
    expect(placed.vendor_order_id).toBeTruthy()
    const status = await scheduler.getOrderStatus(placed.vendor_order_id)
    expect(status.metadata).toMatchObject({ sub_total: 11.5 })
    expect(runtime.instance().orders()).toHaveLength(1)
    const plain = await served({})
    await expect(plain.scheduler.placeOrder(plain.order("ACME001"))).rejects.toThrow("Invalid SKU")
  })

  test("B2: a SKU the default already has is replaced in place, not duplicated", async () => {
    const { client } = await served({ catalog: file("acme-b2.json", ACME) })
    const rows = await client.getProductList()
    const index = DEFAULT_CATALOG.products.findIndex((p) => p.sku === "SKU001")
    expect(rows.filter((p) => p.sku === "SKU001")).toHaveLength(1)
    expect(rows[index]?.sku).toBe("SKU001")
    expect(rows[index]?.wholesalePrice).toBe(5)
    expect(rows).toHaveLength(DEFAULT_CATALOG.products.length + 1)
  })

  test("B3: the MedPax pills and cartons merge the same way, and a list the file omits is kept", async () => {
    const { runtime } = await served({ catalog: file("acme-b3.json", ACME) })
    const catalog = runtime.instance().state.catalog()
    expect(catalog.medPaxPills.map((p) => p.sku)).toEqual([
      ...DEFAULT_CATALOG.medPaxPills.map((p) => p.sku),
      "ACMEPILL1",
    ])
    expect(catalog.privateLabelCartons).toEqual(DEFAULT_CATALOG.privateLabelCartons)
  })

  test("B4: the loaded catalog survives a reset, where PUT /__admin/catalog does not", async () => {
    const { runtime, skus } = await served({ catalog: file("acme-b4.json", ACME) })
    await runtime.fetch(
      new Request(`${API}/__admin/catalog`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ products: [], medPaxPills: [], privateLabelCartons: [] }),
      }),
    )
    expect(await skus()).toEqual([])
    await runtime.reset()
    expect(await skus()).toContain("ACME001")
    expect(await skus()).toContain("SKU002")
  })

  test("B5: a bare array is a list of products", async () => {
    const { skus } = await served({ catalog: file("bare.json", [ACME.products[0]]) })
    const listed = await skus()
    expect(listed).toContain("ACME001")
    expect(listed).toContain("SKU002")
  })

  test("B6: --catalog-mode replace makes the file the whole catalog", async () => {
    const path = file("acme-b6.json", ACME)
    const { skus, scheduler, order, runtime } = await served({
      catalog: path,
      "catalog-mode": "replace",
    })
    expect(await skus()).toEqual(["ACME001", "SKU001"])
    expect(runtime.instance().state.catalog().privateLabelCartons).toEqual([])
    await expect(scheduler.placeOrder(order("SKU002"))).rejects.toThrow("Invalid SKU")
    // `merge` spelled out is the default.
    const merged = await served({ catalog: path, "catalog-mode": "merge" })
    expect(await merged.skus()).toContain("SKU002")
  })

  test("B7: rows fill what they leave out, and keep what they say", () => {
    const catalog = loadCatalogFile(
      file("sparse.json", {
        products: [{ sku: "S1", productName: "Sparse", medPaxDetails: { name: "N", quantity: 3 } }],
      }),
      "replace",
    )
    expect(catalog.products[0]).toMatchObject({
      sku: "S1",
      productName: "Sparse",
      medPaxSku: "",
      retailPrice: 0,
      wholesalePrice: 0,
      quantity: 0,
      defaultDosing: [],
      medPaxDetails: { name: "N", genericName: "", quantity: 3, wholesalePrice: 0, retailPrice: 0 },
    })
  })

  test("B8: a catalog that cannot be used stops the command and names the problem", () => {
    const create = (values: Record<string, string>) => () => serveTarget.create(values, COMMON)
    expect(create({ catalog: join(dir, "missing.json") })).toThrow("wholescripts catalog not found")
    expect(create({ catalog: file("bad-json.json", "{") })).toThrow("wholescripts catalog")
    expect(create({ catalog: file("no-sku.json", { products: [{ productName: "x" }] }) })).toThrow(
      "products[0].sku must be a string",
    )
    expect(
      create({
        catalog: file("bad-price.json", {
          products: [{ sku: "a", productName: "x", retailPrice: "9" }],
        }),
      }),
    ).toThrow("products[0].retailPrice must be a number")
    expect(create({ catalog: file("unknown.json", { items: [] }) })).toThrow('unknown key "items"')
    expect(create({ catalog: file("object.json", 3) })).toThrow("expected {products?")
    expect(create({ catalog: file("ok.json", ACME), "catalog-mode": "union" })).toThrow(
      '--catalog-mode must be "merge" or "replace"',
    )
    expect(create({ "catalog-mode": "replace" })).toThrow("--catalog-mode needs --catalog")
  })

  test("B9: the flags are declared, so a fleet entry can set them under options", () => {
    expect(Object.keys(serveTarget.options ?? {})).toEqual(
      expect.arrayContaining(["catalog", "catalog-mode"]),
    )
  })
})
