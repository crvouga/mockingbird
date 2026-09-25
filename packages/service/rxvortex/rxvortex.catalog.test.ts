import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listen } from "@crvouga/mockingbird-adapter-node"
import { type CatalogItem, createRuntime, DEFAULT_CATALOG } from "./src/index.js"
import { loadCatalogFile, serveTarget } from "./src/server.js"
import { RxVortexConsumer, samplePayload } from "./test/consumer.js"

const API = "http://rxvortex.mock"
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }

/** Rows a consumer synced from its own catalog (fake ids). */
const ACME_ROWS: CatalogItem[] = [
  {
    catalog_id: "a1c3e000-0000-4000-8000-000000000001",
    medication_name: "Acme Custom Cream",
    medication_strength: null,
    package_size: "30 grams",
    quantity: 30,
    quantity_units: "grams",
    medication_form: "Cream",
    route: "Topical",
    states: ["AZ", "CA"],
    status: "active",
  },
  {
    catalog_id: "a1c3e000-0000-4000-8000-000000000002",
    medication_name: "Acme Retired Capsule",
    medication_strength: "10 mg",
    package_size: "30 capsules",
    quantity: 30,
    quantity_units: "each",
    medication_form: "Capsule",
    route: "Oral",
    states: ["AZ"],
    status: "inactive",
  },
]
const [ACTIVE, INACTIVE] = ACME_ROWS as [CatalogItem, CatalogItem]
const UNKNOWN = "a1c3e000-0000-4000-8000-0000000000ff"

const dir = mkdtempSync(join(tmpdir(), "rxvortex-catalog-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const catalogFile = (name: string, contents: unknown) => {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(contents))
  return path
}

type Runtime = ReturnType<typeof createRuntime>
const admin = (
  runtime: Runtime,
  path: string,
  init: { method?: string; body?: unknown; ns?: string } = {},
) =>
  runtime.fetch(
    new Request(`${API}/__admin${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(init.ns ? { "x-mockingbird-namespace": init.ns } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
const consumerFor = (runtime: Runtime, ns?: string) =>
  new RxVortexConsumer(ns ? `${API}/ns/${ns}` : API, { clientId: "acme", clientSecret: "s" }, (r) =>
    runtime.fetch(r),
  )
const catalogIds = async (runtime: Runtime, ns?: string) => {
  const token = await consumerFor(runtime, ns).getAccessToken()
  const response = await runtime.fetch(
    new Request(`${ns ? `${API}/ns/${ns}` : API}/api/v1/preset-catalog-items`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: CatalogItem[] }).data
}

describe("loading a consumer's preset catalog (#133)", () => {
  test("B1: serve --catalog rows.json accepts its ids over HTTP", async () => {
    const path = catalogFile("rows.json", ACME_ROWS)
    const runtime = await serveTarget.create({ catalog: path }, COMMON)
    const server = await listen(runtime, { port: 0 })
    try {
      const consumer = new RxVortexConsumer(
        server.url,
        { clientId: "acme", clientSecret: "s" },
        (r) => fetch(r),
      )
      const placed = await consumer.submit("pay_b1", samplePayload("pay_b1", ACTIVE.catalog_id))
      expect(placed.success).toBe(true)
      expect(typeof placed.pharmacyOrderId).toBe("string")
    } finally {
      ;(runtime as Runtime).stop()
      await server.close()
    }
  })

  test("B1: --catalog also loads a recorded {data: [...]} response, and defaults missing fields", () => {
    const path = catalogFile("recorded.json", {
      data: [{ catalog_id: ACTIVE.catalog_id, medication_name: ACTIVE.medication_name }],
    })
    expect(loadCatalogFile(path)).toEqual([
      {
        catalog_id: ACTIVE.catalog_id,
        medication_name: ACTIVE.medication_name,
        medication_strength: null,
        package_size: null,
        quantity: null,
        quantity_units: null,
        medication_form: null,
        route: null,
        states: [],
        status: "active",
      },
    ])
    expect(() => loadCatalogFile(join(dir, "missing.json"))).toThrow("not found")
    expect(() => loadCatalogFile(catalogFile("bad.json", { rows: [] }))).toThrow("{data: [...]}")
    expect(() => loadCatalogFile(catalogFile("bad-row.json", [{ medication_name: "x" }]))).toThrow(
      "catalog_id",
    )
    expect(() => serveTarget.create({ "unknown-presets": "maybe" }, COMMON)).toThrow(
      "--unknown-presets",
    )
  })

  test("B2: PUT /__admin/catalog merges into one namespace only", async () => {
    const runtime = createRuntime()
    const put = await admin(runtime, "/catalog", {
      method: "PUT",
      ns: "w1",
      body: { items: [ACTIVE], mode: "merge" },
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ count: DEFAULT_CATALOG.length + 1 })

    const w1 = await consumerFor(runtime, "w1").submit(
      "pay_w1",
      samplePayload("pay_w1", ACTIVE.catalog_id),
    )
    expect(w1.success).toBe(true)

    const w2 = consumerFor(runtime, "w2")
    const token = await w2.getAccessToken()
    const response = await runtime.fetch(
      new Request(`${API}/ns/w2/api/v1/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(samplePayload("pay_w2", ACTIVE.catalog_id)),
      }),
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      message: "The given data was invalid.",
      errors: {
        "medication_requests.0.preset_catalog_id": [
          `The selected preset catalog id ${ACTIVE.catalog_id} is invalid.`,
        ],
      },
    })
  })

  test("B2: replace (the default mode) drops every other row; bad bodies are 400", async () => {
    const runtime = createRuntime()
    const put = await admin(runtime, "/catalog", { method: "PUT", body: { items: ACME_ROWS } })
    expect(await put.json()).toEqual({ count: 2 })
    const listed = (await (await admin(runtime, "/catalog")).json()) as { data: CatalogItem[] }
    expect(listed.data).toEqual(ACME_ROWS)
    for (const body of [
      [],
      { items: "nope" },
      { items: ACME_ROWS, mode: "upsert" },
      { items: [{ catalog_id: "x", medication_name: "y", status: "retired" }] },
    ]) {
      expect((await admin(runtime, "/catalog", { method: "PUT", body })).status).toBe(400)
    }
    expect(
      ((await (await admin(runtime, "/catalog")).json()) as { data: unknown[] }).data,
    ).toHaveLength(2)
  })

  test("B3: an inactive loaded row is still 422, in either unknownPresets mode", async () => {
    const runtime = createRuntime({ catalog: ACME_ROWS })
    for (const unknownPresets of ["reject", "accept"]) {
      await admin(runtime, "/settings", { method: "PUT", body: { unknownPresets } })
      const result = await consumerFor(runtime).submit(
        `pay_b3_${unknownPresets}`,
        samplePayload(`pay_b3_${unknownPresets}`, INACTIVE.catalog_id),
      )
      expect(result.success).toBe(false)
    }
  })

  test("B4: unknownPresets accept adds an unknown UUID as an active row; reject is the default", async () => {
    const runtime = createRuntime()
    expect(
      ((await (await admin(runtime, "/settings")).json()) as { unknownPresets: string })
        .unknownPresets,
    ).toBe("reject")
    expect(
      (await consumerFor(runtime).submit("pay_b4a", samplePayload("pay_b4a", UNKNOWN))).success,
    ).toBe(false)

    const set = await admin(runtime, "/settings", {
      method: "PUT",
      body: { unknownPresets: "accept" },
    })
    expect(set.status).toBe(200)
    expect(
      (await admin(runtime, "/settings", { method: "PUT", body: { unknownPresets: "yes" } }))
        .status,
    ).toBe(400)

    const placed = await consumerFor(runtime).submit("pay_b4b", samplePayload("pay_b4b", UNKNOWN))
    expect(placed.success).toBe(true)
    const row = (await catalogIds(runtime)).find((item) => item.catalog_id === UNKNOWN)
    expect(row).toMatchObject({
      catalog_id: UNKNOWN,
      medication_name: "Testosterone Cypionate",
      status: "active",
    })
    // An id that is not a UUID is still refused.
    expect(
      (await consumerFor(runtime).submit("pay_b4c", samplePayload("pay_b4c", "not-a-uuid")))
        .success,
    ).toBe(false)
  })

  test("B5: GET /api/v1/preset-catalog-items returns the loaded rows in {data: [...]}", async () => {
    const runtime = createRuntime()
    await admin(runtime, "/catalog", { method: "PUT", ns: "w1", body: { items: ACME_ROWS } })
    expect(await catalogIds(runtime, "w1")).toEqual(ACME_ROWS)
    expect(await catalogIds(runtime, "w2")).toEqual([...DEFAULT_CATALOG])
  })

  test("B6: POST /__admin/reset restores the --catalog default, not the synthesised one", async () => {
    const runtime = await serveTarget.create(
      { catalog: catalogFile("reset.json", { data: ACME_ROWS }) },
      COMMON,
    )
    try {
      const rx = runtime as Runtime
      const [, other] = DEFAULT_CATALOG as [CatalogItem, CatalogItem]
      await admin(rx, "/catalog", { method: "PUT", body: { items: [other] } })
      expect(await catalogIds(rx)).toEqual([other])
      expect((await admin(rx, "/reset", { body: {} })).status).toBeLessThan(300)
      expect(await catalogIds(rx)).toEqual(ACME_ROWS)
    } finally {
      ;(runtime as Runtime).stop()
    }
  })
})

describe("the consumer's verified request table replays against the mock", () => {
  test("token, submit (with and without prescriber address), status, recovery, 404, catalog, cancel", async () => {
    const runtime = createRuntime({ catalog: ACME_ROWS })
    const consumer = consumerFor(runtime)

    // POST /api/v1/generate-access-token
    expect(typeof (await consumer.getAccessToken())).toBe("string")

    // POST /api/v1/orders, full payload, prescriber.address present
    const full = samplePayload("pay_t1", ACTIVE.catalog_id)
    const withAddress = {
      ...full,
      prescriber: {
        ...full.prescriber,
        address: {
          line1: "2 Clinic Way",
          line2: "",
          city: "Phoenix",
          state: "AZ",
          postal_code: "85004",
          country: "US",
        },
      },
    }
    const placed = await consumer.submit("pay_t1", withAddress)
    expect(placed.success).toBe(true)
    const trackingId = placed.pharmacyOrderId as string
    expect(trackingId).toMatch(/^RXV-/)

    // same, prescriber.address omitted
    expect(
      (await consumer.submit("pay_t2", samplePayload("pay_t2", ACTIVE.catalog_id))).success,
    ).toBe(true)

    // GET /api/v1/orders/{order_tracking_id}
    const token = await consumer.getAccessToken()
    const raw = await runtime.fetch(
      new Request(`${API}/api/v1/orders/${trackingId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    expect(await raw.json()).toMatchObject({
      rxstatus: "Created",
      delivered_date: null,
      cancellable: true,
      trackingnumber: null,
    })

    // GET /api/v1/orders/{sender_order_id}: the orphan-recovery lookup
    expect(await consumer.recover("pay_t1")).toBe(trackingId)

    // GET /api/v1/orders/<unknown> → 404, which the adapter reads as null
    expect(await consumer.status("pay_unknown")).toBeNull()

    // GET /api/v1/preset-catalog-items
    expect(await catalogIds(runtime)).toEqual(ACME_ROWS)

    // DELETE /api/v1/orders/{id} while cancellable
    expect(await consumer.cancel(trackingId)).toEqual({ success: true })
    expect((await consumer.status(trackingId))?.fulfillmentStatus).toBe("cancelled")
  })
})
