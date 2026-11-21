import { expect, test } from "bun:test"
import { Collection, createRuntime } from "@crvouga/mockingbird-service"
import { startFleet } from "../node/src/fleet.js"
import { FleetClient } from "../node/src/fleet-client.js"
import { createFleet } from "./src/in-process.js"

const runtime = () =>
  createRuntime({
    name: "fixture",
    adminControls: { clock: { now: 1000, frozen: true } },
    create: (context) => {
      const rows = new Collection<{ value: string }>(context.sqlite, context.namespace, "rows")
      return {
        fetch: async (request) => {
          if (request.method === "POST") rows.insert("row", { value: await request.text() })
          return Response.json(rows.list().map((row) => row.value))
        },
        reset: async () => {
          for (const row of rows.list()) rows.delete(row.id)
        },
      }
    },
  })

// Compare generated identities and transport locations by type, preserving all response keys.
const normalize = (value: unknown, key = ""): unknown => {
  if (["createdAt", "activityAt", "generation", "id", "startedAt", "pid", "offsetMs"].includes(key))
    return typeof value
  if (typeof value === "string") {
    if (key === "checkpoint") return value.replace(/^[^:]+:/, "id:")
    if (/^https?:\/\//.test(value)) return new URL(value).pathname
    return value
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item, key)]),
    )
  return value
}

test("unchanged FleetClient exercises Node-compatible basic control responses and state", async () => {
  const memory = createFleet({ services: { fixture: { version: "test", create: runtime } } })
  const node = await startFleet(
    { adminControls: { clock: { now: 1000, frozen: true } }, services: { fixture: { port: 0 } } },
    {
      load: async () => ({
        name: "fixture",
        packageVersion: "test",
        defaultPort: 0,
        create: runtime,
      }),
    },
  )
  const clients = [
    new FleetClient(node.manifest.adminBase),
    new FleetClient("http://fleet.internal/__admin/fleet", {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        memory.control(new Request(input, init))) as typeof fetch,
    }),
  ]
  const vendor = [
    (path: string, init?: RequestInit) =>
      fetch(`${node.manifest.services.fixture?.url}${path}`, init),
    (path: string, init?: RequestInit) =>
      memory.fetch("fixture", new Request(`http://fixture.fleet.internal${path}`, init)),
  ]
  const compare = async (run: (client: FleetClient, index: number) => Promise<unknown>) => {
    const results = await Promise.all(clients.map(run))
    expect(normalize(results[1])).toEqual(normalize(results[0]))
    return results
  }
  try {
    await compare((client) => client.namespaces())
    const created = await Promise.all(clients.map((client) => client.createNamespace("tenant")))
    // Manifest describes each transport's discovery addresses; creation contract is identical.
    expect(Object.keys(created[1] ?? {}).sort()).toEqual(Object.keys(created[0] ?? {}).sort())
    expect(normalize((created[1] as Record<string, unknown>).connections)).toEqual(
      normalize((created[0] as Record<string, unknown>).connections),
    )
    await compare((client) => client.namespaces())
    await compare((client) => client.request("clock", { namespace: "tenant" }))
    await compare((client) =>
      client.request("clock", { namespace: "tenant", body: { set: 2000, freeze: true } }),
    )
    await Promise.all(
      vendor.map((fetch) =>
        fetch("/rows", {
          method: "POST",
          headers: { "x-mockingbird-namespace": "tenant" },
          body: "saved",
        }).then((response) => response.text()),
      ),
    )
    const points = await Promise.all(
      clients.map((client) => client.snapshot("tenant", { label: "before mutation — fixture" })),
    )
    expect(normalize(points[1])).toEqual(normalize(points[0]))
    await compare((client) => client.request("namespaces/tenant/snapshots"))
    await compare((client, index) =>
      client.request(`namespaces/tenant/snapshots/${points[index]?.id}`),
    )
    await compare((client) => client.reset("tenant"))
    await compare((client) => client.request("namespaces/tenant/snapshots"))
    await compare((client, index) => client.restore("tenant", points[index]?.id as string))
    expect(
      await Promise.all(
        vendor.map((fetch) =>
          fetch("/rows", { headers: { "x-mockingbird-namespace": "tenant" } }).then((response) =>
            response.json(),
          ),
        ),
      ),
    ).toEqual([[{ value: "saved" }], [{ value: "saved" }]])
    await compare((client) =>
      client.request("clock", { namespace: "tenant", body: { advance: "2s" } }),
    )
    await compare((client) => client.request("clock", { namespace: "tenant", body: {} }))
    await compare((client) =>
      client.request("wait-until-idle", { namespace: "tenant", body: { services: ["fixture"] } }),
    )
    const archives = await Promise.all(clients.map((client) => client.exportArchive("tenant")))
    const restored = await Promise.all(
      clients.map((client, index) =>
        client.importArchive(
          archives[index] as Awaited<ReturnType<FleetClient["exportArchive"]>>,
          "tenant",
        ),
      ),
    )
    expect(Object.keys(restored[1] ?? {}).sort()).toEqual(Object.keys(restored[0] ?? {}).sort())
    expect(restored.map((result) => result.namespaces)).toEqual([["tenant"], ["tenant"]])
    expect(
      await Promise.all(
        vendor.map((fetch) =>
          fetch("/rows", { headers: { "x-mockingbird-namespace": "tenant" } }).then((response) =>
            response.json(),
          ),
        ),
      ),
    ).toEqual([[{ value: "saved" }], [{ value: "saved" }]])
    await compare((client, index) =>
      client.request(`namespaces/tenant/snapshots/${points[index]?.id}`, { method: "DELETE" }),
    )
    await compare((client) => client.request("namespaces/tenant/snapshots"))
    await compare((client) => client.deleteNamespace("tenant"))
    await compare((client) => client.request("namespaces/tenant/snapshots"))
  } finally {
    await node.close()
    await memory.dispose()
  }
})

test("failed controller reset restores every already-mutated participant atomically", async () => {
  let reject = true
  const memory = createFleet({
    services: {
      first: { version: "test", create: runtime },
      second: {
        version: "test",
        create: () => {
          const value = runtime()
          return {
            ...value,
            reset: async (namespace?: string) => {
              await value.reset(namespace)
              if (reject) throw new Error("reset fixture failure")
            },
          }
        },
      },
    },
  })
  for (const name of ["first", "second"])
    await (
      await memory.fetch(name, new Request("http://fixture/rows", { method: "POST", body: name }))
    ).text()
  const before = await memory.export()
  const response = await memory.control(
    new Request("http://fleet/__admin/fleet/namespaces/default/reset", {
      method: "POST",
      body: "{}",
    }),
  )
  expect(response.status).toBe(500)
  expect(await response.json()).toMatchObject({
    status: "failed",
    failedService: "second",
    rolledBack: true,
    rollback: { first: "restored", second: "restored" },
  })
  expect(await memory.export()).toEqual(before)
  reject = false
  expect(
    (
      await memory.control(
        new Request("http://fleet/__admin/fleet/namespaces/default/reset", {
          method: "POST",
          body: "{}",
        }),
      )
    ).ok,
  ).toBe(true)
  await memory.dispose()
})
