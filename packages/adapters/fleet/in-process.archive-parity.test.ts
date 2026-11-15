import { expect, test } from "bun:test"
import { Collection, createRuntime } from "@crvouga/mockingbird-service"
import { startFleet } from "../node/src/fleet.js"
import { createFleet } from "./src/in-process.js"

const runtime = () =>
  createRuntime({
    name: "fixture",
    adminControls: { clock: { now: 1000, frozen: true } },
    create: (context) => {
      const rows = new Collection<{ text: string }>(context.sqlite, context.namespace, "rows")
      return {
        fetch: async (request: Request) => {
          if (request.method === "POST") rows.insert("one", { text: await request.text() })
          return Response.json(rows.list().map((row) => row.value))
        },
        reset: async () => {
          for (const row of rows.list()) rows.delete(row.id)
        },
      }
    },
  })
const config = { services: { fixture: { version: "test", create: runtime } } }

test("Node and listener-free hosts exchange the same participant archive and boot markers", async () => {
  const memory = createFleet(config)
  const node = await startFleet(
    { services: { fixture: { port: 0 } } },
    {
      load: async () => ({
        name: "fixture",
        packageVersion: "test",
        defaultPort: 0,
        create: runtime,
      }),
    },
  )
  const control = (path: string, body: unknown) =>
    fetch(`${node.manifest.adminBase}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  try {
    await (
      await memory.fetch(
        "fixture",
        new Request("http://mock/rows", { method: "POST", body: "from browser" }),
      )
    ).text()
    const imported = await control("archives/import", { archive: await memory.exportArchive() })
    expect(imported.status).toBe(200)
    expect(await imported.json()).toMatchObject({ status: "restored" })
    expect(await (await fetch(`${node.manifest.services.fixture?.url}/rows`)).json()).toEqual([
      { text: "from browser" },
    ])
    await (
      await fetch(`${node.manifest.services.fixture?.url}/rows`, {
        method: "POST",
        body: "from Node",
      })
    ).text()
    const nodeArchive = await (await control("archives/export", {})).json()
    await memory.import(nodeArchive)
    expect(await (await memory.fetch("fixture", new Request("http://mock/rows"))).json()).toEqual([
      { text: "from Node" },
    ])
    const cold = createFleet(config)
    expect(cold.status().fixture?.status).toBe("idle")
    expect((await control("archives/import", { archive: await cold.exportArchive() })).status).toBe(
      200,
    )
    expect(await (await fetch(`${node.manifest.services.fixture?.url}/rows`)).json()).toEqual([])
    expect(cold.status().fixture?.status).toBe("idle")
  } finally {
    await node.close()
    await memory.dispose()
  }
})

test("selected boot-state import preserves other namespaces", async () => {
  const memory = createFleet(config)
  const cold = createFleet(config)
  for (const namespace of ["default", "tenant"]) {
    await (
      await memory.fetch(
        "fixture",
        new Request("http://mock/rows", {
          method: "POST",
          headers: { "x-mockingbird-namespace": namespace },
          body: namespace,
        }),
      )
    ).text()
  }
  await memory.import(await cold.exportArchive())
  expect(await (await memory.fetch("fixture", new Request("http://mock/rows"))).json()).toEqual([])
  expect(
    await (
      await memory.fetch(
        "fixture",
        new Request("http://mock/rows", { headers: { "x-mockingbird-namespace": "tenant" } }),
      )
    ).json(),
  ).toEqual([{ text: "tenant" }])
  await memory.dispose()
  await cold.dispose()
})
