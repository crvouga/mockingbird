import { describe, expect, test } from "bun:test"
import { ADMIN_BRANDS_URL, renderAdminDocument } from "./src/admin-ui.js"
import {
  ADMIN_KEY_HEADER,
  Collection,
  createRuntime,
  NAMESPACE_HEADER,
  STANDARD_ADMIN_ROUTES,
} from "./src/index.js"

const call = (
  runtime: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  )

const notes = () =>
  createRuntime({
    name: "notes",
    state: [
      {
        name: "events",
        label: "Events",
        description: "Audit rows",
        meta: { vendor: "notes" },
        fields: [{ name: "kind", kind: "string", optional: false }],
      },
    ],
    create: (context) => {
      const records = new Collection<{ text: string }>(context.sqlite, context.namespace, "notes")
      return {
        records,
        fetch: async () => new Response("ok"),
        reset: async () => {
          records.list().forEach((row) => {
            records.delete(row.id)
          })
        },
      }
    },
  })

describe("state", () => {
  test("declarations and live collections are one view", () => {
    const runtime = notes()
    const view = runtime.state()
    expect(view.namespace).toBe("default")
    expect(view.storageNamespace).toBe("notes")
    expect(view.collections.map((collection) => collection.name)).toEqual(["events", "notes"])
    const events = view.collections[0]
    expect(events).toMatchObject({
      source: "declared",
      count: 0,
      label: "Events",
      description: "Audit rows",
      meta: { vendor: "notes" },
    })
    expect(events?.fields[0]).toMatchObject({ name: "kind", kind: "string" })
    expect(view.collections[1]).toMatchObject({ source: "inferred", count: 0, label: "Notes" })
  })

  test("creates, reads, merges, replaces, and deletes a record", async () => {
    const runtime = notes()
    const before = runtime.timeline().head()?.id
    const created = await call(runtime, "POST", "/__admin/state/notes", {
      body: { id: "n1", value: { text: "hello", extra: 1 } },
    })
    expect(created.status).toBe(201)
    const record = (await created.json()) as { id: string; seq: number; value: { text: string } }
    expect(record).toMatchObject({ id: "n1", value: { text: "hello", extra: 1 } })
    expect(runtime.timeline().head()?.id).not.toBe(before)

    const duplicate = await call(runtime, "POST", "/__admin/state/notes", {
      body: { id: "n1", value: { text: "again" } },
    })
    expect(duplicate.status).toBe(409)

    const patched = await call(runtime, "PATCH", "/__admin/state/notes/n1", {
      body: { value: { text: "edited" } },
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ value: { text: "edited", extra: 1 } })

    const replaced = await call(runtime, "PUT", "/__admin/state/notes/n1", {
      body: { value: { text: "replaced" } },
    })
    expect(await replaced.json()).toMatchObject({ value: { text: "replaced" } })

    const page = await call(runtime, "GET", "/__admin/state/notes")
    const listed = (await page.json()) as { records: { id: string }[]; count: number }
    expect(listed.count).toBe(1)
    expect(listed.records.map((row) => row.id)).toEqual(["n1"])

    const mixed = runtime.state().collections.find((collection) => collection.name === "notes")
    expect(mixed?.source).toBe("inferred")
    expect(mixed?.fields.some((field) => field.name === "text" && field.kind === "string")).toBe(
      true,
    )

    const removed = await call(runtime, "DELETE", "/__admin/state/notes/n1")
    expect(removed.status).toBe(200)
    expect((await call(runtime, "GET", "/__admin/state/notes/n1")).status).toBe(404)
  })

  test("a write in one namespace stays there", async () => {
    const runtime = notes()
    const headers = { [NAMESPACE_HEADER]: "alpha" }
    expect(
      (
        await call(runtime, "POST", "/__admin/state/notes", {
          headers,
          body: { id: "n1", value: { text: "alpha" } },
        })
      ).status,
    ).toBe(201)
    const other = await call(runtime, "GET", "/__admin/state/notes", {
      headers: { [NAMESPACE_HEADER]: "beta" },
    })
    expect(((await other.json()) as { count: number }).count).toBe(0)
    const home = await call(runtime, "GET", "/__admin/state/notes", { headers })
    expect(((await home.json()) as { count: number }).count).toBe(1)
    expect(runtime.state("alpha").collections.find((c) => c.name === "notes")?.count).toBe(1)
  })

  test("rejects a collection name or a body the admin API cannot store", async () => {
    const runtime = notes()
    expect((await call(runtime, "GET", "/__admin/state/bad name")).status).toBe(400)
    expect(
      (await call(runtime, "POST", "/__admin/state/notes", { body: { value: undefined } })).status,
    ).toBe(400)
  })

  test("a service route cannot replace the shared state handler", async () => {
    const runtime = createRuntime({
      name: "notes",
      create: () => ({
        fetch: async () => new Response("ok"),
        reset: async () => {},
      }),
      admin: () => ({
        "GET /state": () => new Response("replaced", { status: 200 }),
        "GET /vendor": () => Response.json({ ok: true }),
      }),
    })
    const state = await call(runtime, "GET", "/__admin/state")
    expect(state.headers.get("content-type")).toContain("application/json")
    expect(await state.json()).toMatchObject({ collections: [] })
    expect(await (await call(runtime, "GET", "/__admin/vendor")).json()).toEqual({ ok: true })
    const listed = ((await (await call(runtime, "GET", "/__admin")).json()) as { routes: string[] })
      .routes
    for (const route of STANDARD_ADMIN_ROUTES) expect(listed).toContain(route)
    expect(listed).toContain("GET /vendor")
  })
})

describe("admin ui", () => {
  test("health links the shell, and the shell does not need the admin key", async () => {
    const runtime = createRuntime({
      name: "notes",
      adminKey: "secret",
      create: () => ({
        fetch: async () => new Response("ok"),
        reset: async () => {},
      }),
      adminUi: {
        panels: [
          {
            id: "extra",
            title: "Extra",
            description: "A bespoke view",
            html: "<p>panel</p>",
            script: "root.dataset.mounted = 'yes'",
          },
        ],
      },
    })
    const health = (await (await call(runtime, "GET", "/__admin/health")).json()) as {
      adminUi: string
    }
    expect(health.adminUi).toBe("/__admin/ui")

    const shell = await call(runtime, "GET", "/__admin/ui")
    expect(shell.status).toBe(200)
    expect(shell.headers.get("content-type")).toContain("text/html")
    const html = await shell.text()
    expect(html).toContain("notes admin")
    expect(html).toContain('name="viewport"')
    expect(html).toContain("prefers-color-scheme")
    expect(html).toContain("data-mockingbird-admin")
    expect(html).toContain(ADMIN_BRANDS_URL)
    expect(html.includes('data-admin-ui-library="antd"')).toBe(true)
    expect(html).not.toContain("https://stripe.com")
    expect((await call(runtime, "GET", "/__admin/ui/")).status).toBe(200)

    const locked = await call(runtime, "GET", "/__admin/state")
    expect(locked.status).toBe(401)
    const manifestLocked = await call(runtime, "GET", "/__admin/ui/manifest")
    expect(manifestLocked.status).toBe(401)

    const headers = { [ADMIN_KEY_HEADER]: "secret" }
    const manifest = await call(runtime, "GET", "/__admin/ui/manifest", { headers })
    expect(manifest.status).toBe(200)
    expect(await manifest.json()).toMatchObject({
      service: "notes",
      standardRoutes: STANDARD_ADMIN_ROUTES,
      panels: [{ id: "extra", title: "Extra", html: "<p>panel</p>" }],
    })
    expect((await call(runtime, "GET", "/__admin/state", { headers })).status).toBe(200)
  })

  test("render can wrap the shared document", async () => {
    const runtime = createRuntime({
      name: "notes",
      create: () => ({
        fetch: async () => new Response("ok"),
        reset: async () => {},
      }),
      adminUi: {
        render: ({ service, defaultHtml }) =>
          `<!-- ${service} -->${defaultHtml()}<!-- end ${service} -->`,
      },
    })
    const html = await (await call(runtime, "GET", "/__admin/ui")).text()
    expect(html.startsWith("<!-- notes -->")).toBe(true)
    expect(html).toContain("<!DOCTYPE html>")
    expect(html.endsWith("<!-- end notes -->")).toBe(true)
  })

  test("the shared document contains the bundled component UI and escapes configuration", () => {
    const html = renderAdminDocument("stripe")
    expect(html).toContain('data-admin-ui-library="antd"')
    expect(html).toContain('id="admin-root"')
    expect(html).toContain("MockingbirdAdmin.mount(")
    expect(html).toContain(ADMIN_BRANDS_URL)
    expect(html).not.toContain("https://stripe.com")
    expect(html).not.toContain("https://docs.stripe.com")
    // All runtime dependencies are bundled; the document works with an in-process fetch.
    expect(html).not.toMatch(/<script[^>]+src=/)
    const hostile = renderAdminDocument('</script><script>alert("x")</script>')
    expect(hostile).not.toContain('</script><script>alert("x")')
    expect(hostile).toContain("\\u003c/script>")
    expect(hostile.match(/<\/script>/g)?.length).toBe(1)
  })

  test("an extension is listed on the manifest and a reserved id is rejected", async () => {
    const runtime = createRuntime({
      name: "notes",
      create: () => ({
        fetch: async () => new Response("ok"),
        reset: async () => {},
      }),
      adminUi: {
        extensions: [
          { kind: "sql", description: "Browse tables and run queries." },
          {
            kind: "route",
            id: "move",
            title: "Move",
            route: "POST /items/:id/state",
            body: { state: "Done" },
          },
        ],
      },
    })
    const manifest = (await (await call(runtime, "GET", "/__admin/ui/manifest")).json()) as {
      extensions: {
        kind: string
        id: string
        title: string
        description?: string
        route?: string
        body?: unknown
      }[]
    }
    expect(manifest.extensions).toEqual([
      {
        kind: "sql",
        id: "sql",
        title: "SQL",
        description: "Browse tables and run queries.",
      },
      {
        kind: "route",
        id: "move",
        title: "Move",
        route: "POST /items/:id/state",
        body: { state: "Done" },
      },
    ])
    expect(() =>
      createRuntime({
        name: "notes",
        create: () => ({
          fetch: async () => new Response("ok"),
          reset: async () => {},
        }),
        adminUi: { extensions: [{ kind: "sql", id: "state" }] },
      }),
    ).toThrow(/reserved/)
    expect(() =>
      createRuntime({
        name: "notes",
        create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
        adminUi: {
          extensions: [
            { kind: "route", id: "bad-route", title: "Bad", route: "https://example.test/" },
          ],
        },
      }),
    ).toThrow(/method and route path/)
  })

  test("every view the admin shell's menu owns is reserved", () => {
    // Keep in sync with coreNav in packages/admin-ui/src/browser.tsx.
    const shellViews = [
      "overview",
      "manual",
      "state",
      "clock",
      "latency",
      "faults",
      "snapshots",
      "journal",
      "checkpoints",
      "routes",
    ]
    for (const id of shellViews) {
      expect(() =>
        createRuntime({
          name: "notes",
          create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
          adminUi: { panels: [{ id, title: "Mine", html: "" }] },
        }),
      ).toThrow(`admin panel id ${id} is reserved by the admin shell`)
    }
  })

  test("a panel id the shell cannot mount is rejected up front", () => {
    expect(() =>
      createRuntime({
        name: "notes",
        create: () => ({
          fetch: async () => new Response("ok"),
          reset: async () => {},
        }),
        adminUi: { panels: [{ id: "Not Ok", title: "X", html: "" }] },
      }),
    ).toThrow(/admin panel id/)
  })
})
