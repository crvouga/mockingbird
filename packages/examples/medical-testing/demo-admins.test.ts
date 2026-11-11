import { describe, expect, test } from "bun:test"
import { buildDemo } from "./src/composition/build.js"

describe("live demo admins", () => {
  test("every service and data source serves the shared admin UI", async () => {
    const demo = await buildDemo({ html: "", js: "" })
    expect(demo.admins.map((admin) => admin.label)).toEqual([
      "Google",
      "Apple",
      "Stripe",
      "Junction",
      "Twilio",
      "Resend",
      "FCM",
      "Postgres",
    ])

    for (const admin of demo.admins) {
      const health = await admin.fetch(new Request("https://mock.local/__admin/health"))
      expect(health.status).toBe(200)
      expect(((await health.json()) as { adminUi?: string }).adminUi).toBe("/__admin/ui")
      const ui = await admin.fetch(new Request("https://mock.local/__admin/ui"))
      expect(ui.status).toBe(200)
      expect(ui.headers.get("content-type")).toContain("text/html")
      expect(await ui.text()).toContain("data-mockingbird-admin")
    }

    const combinedUi = await demo.admin.fetch(new Request("https://mock.local/__admin/ui"))
    expect(combinedUi.status).toBe(200)
    const combinedHtml = await combinedUi.text()
    expect(combinedHtml).toContain('"id":"google"')
    expect(combinedHtml).toContain('"id":"postgres"')
    const composedState = await demo.admin.fetch(
      new Request("https://mock.local/__admin/apis/junction/state"),
    )
    expect(composedState.status).toBe(200)
    expect(
      ((await composedState.json()) as { collections: { count: number }[] }).collections.some(
        (collection) => collection.count > 0,
      ),
    ).toBe(true)

    const tables = await demo.db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
    expect(tables.map((row) => row.table_name)).toEqual([
      "audit_events",
      "lab_tests",
      "order_events",
      "order_items",
      "orders",
      "users",
    ])
    const tests = await demo.db.query("SELECT * FROM lab_tests ORDER BY 1 LIMIT 50")
    expect(tests.length).toBeGreaterThan(0)

    for (const id of ["junction", "postgres"]) {
      const admin = demo.admins.find((item) => item.id === id)
      if (!admin) throw new Error(`Missing ${id} admin`)
      const response = await admin.fetch(new Request("https://mock.local/__admin/state"))
      expect(response.status).toBe(200)
      const state = (await response.json()) as {
        collections: { name: string; count: number }[]
      }
      expect(state.collections.some((collection) => collection.count > 0)).toBe(true)
      expect(state.collections.reduce((total, collection) => total + collection.count, 0)).toBe(
        id === "junction" ? 33 : 24,
      )
    }
  })

  test("Postgres admin browses, changes, and restores the application's live database", async () => {
    const demo = await buildDemo({ html: "", js: "" })
    const postgres = demo.admins.find((admin) => admin.id === "postgres")
    if (!postgres) throw new Error("Missing Postgres admin")
    const request = (path: string, body?: unknown) =>
      postgres.fetch(
        new Request(`https://mock.local/__admin${path}`, {
          ...(body === undefined
            ? {}
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        }),
      )
    const tables = await request("/sql/tables")
    expect(await tables.json()).toMatchObject({
      tables: expect.arrayContaining([
        expect.objectContaining({ schema: "public", name: "lab_tests" }),
      ]),
    })
    const page = await request("/sql/tables/public/lab_tests?limit=50")
    const listed = (await page.json()) as { rows: { id: string; name: string }[]; total: number }
    expect(listed.total).toBeGreaterThan(0)
    const first = listed.rows[0]
    if (!first) throw new Error("Expected a seeded lab test")
    const checkpoint = (await (await request("/checkpoints", {})).json()) as { id: string }
    const changed = await request("/sql/query", {
      sql: `UPDATE lab_tests SET name = 'Admin edited test' WHERE id = '${first.id.replaceAll("'", "''")}'`,
    })
    expect(changed.status).toBe(200)
    const catalog = async () =>
      (await (await demo.app.request("/api/tests")).json()) as {
        tests: { id: string; name: string }[]
      }
    expect((await catalog()).tests.find((test) => test.id === first.id)?.name).toBe(
      "Admin edited test",
    )
    const restored = await request("/branches/main/checkout", { checkpoint: checkpoint.id })
    expect(restored.status).toBe(200)
    expect((await catalog()).tests.find((test) => test.id === first.id)?.name).toBe(first.name)
    const ui = await (await request("/ui")).text()
    expect(ui).toContain('data-admin-ui-library="antd"')
    expect(ui).toContain("data-mockingbird-admin")
  })
})
