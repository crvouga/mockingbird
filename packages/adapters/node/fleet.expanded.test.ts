import { expect, test } from "bun:test"
import { Collection, createClock, createRuntime } from "@crvouga/mockingbird-service"
import { type FleetChild, type FleetTarget, startFleet } from "./src/fleet.js"
import { sealArchive } from "./src/fleet-archive.js"

const load = async (): Promise<FleetTarget> => ({
  name: "fixture",
  defaultPort: 0,
  create() {
    return createRuntime({
      name: "fixture",
      create(ctx) {
        const records = new Collection<{ value: string }>(ctx.sqlite, ctx.namespace, "things")
        return {
          reset: async () => {
            for (const row of records.list()) records.delete(row.id)
          },
          fetch: async (r) => {
            if (r.method === "POST")
              records.insert(String(records.list().length), { value: await r.text() })
            return Response.json(records.list().map((v) => v.value))
          },
        }
      },
    })
  },
})
const call = (
  fleet: Awaited<ReturnType<typeof startFleet>>,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
  method?: string,
) =>
  fleet.fetch(
    new Request(`${fleet.manifest.adminBase}${route}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )

test("named same-vendor instances have independent endpoints, selected operations and target-matched archives (#424)", async () => {
  const loaded: string[] = []
  const fleet = await startFleet(
    {
      services: {
        legacy: { target: "fixture", port: 0 },
        replacement: { target: "fixture", port: 0 },
      },
    },
    {
      load: async (name) => {
        loaded.push(name)
        return load()
      },
    },
  )
  try {
    expect(loaded).toEqual(["fixture", "fixture"])
    for (const name of ["legacy", "replacement"])
      await fetch(`${fleet.children.get(name)?.url}/things`, { method: "POST", body: name })
    await call(fleet, "/namespaces/default/reset", { services: ["legacy"] })
    expect(await (await fetch(`${fleet.children.get("legacy")?.url}/things`)).json()).toEqual([])
    expect(await (await fetch(`${fleet.children.get("replacement")?.url}/things`)).json()).toEqual([
      { value: "replacement" },
    ])
    const archive = await (await call(fleet, "/archives/export", {})).json()
    expect(archive.namespaces.default.services.legacy.target).toBe("fixture")
    archive.namespaces.default.services.legacy.target = "other"
    const { sha256: _sha, ...content } = archive
    expect((await call(fleet, "/archives/import", { archive: sealArchive(content) })).status).toBe(
      400,
    )
  } finally {
    await fleet.close()
  }
})

test("dependency preflight rejects cycles/unknown edges before listeners and stops dependants first (#418)", async () => {
  const events: string[] = []
  const loader = async (name: string): Promise<FleetTarget> => ({
    name,
    protocol: "redis",
    defaultPort: 0,
    async start() {
      events.push(`start:${name}`)
      const clock = createClock()
      const child: FleetChild = {
        protocol: "redis",
        url: "redis://127.0.0.1:1",
        namespaces: { endpoints: { default: "redis://127.0.0.1:1" } },
        ready: async () => true,
        close: async () => {
          events.push(`close:${name}`)
        },
        lock: () => () => {},
        diagnostics: () => ({
          activeRequests: 0,
          activeConnections: 0,
          blockedCommands: 0,
          pendingJobs: 0,
          pendingWebhooks: 0,
          unmatchedRequests: 0,
        }),
        checkpoint: async () => ({}),
        restore: async () => {},
        reset: async () => {},
        clock: () => clock,
      }
      return child
    },
  })
  await expect(
    startFleet({ services: { app: { dependsOn: ["missing"] } } }, { load: loader }),
  ).rejects.toThrow("missing")
  await expect(
    startFleet(
      { services: { app: { dependsOn: ["db"] }, db: { dependsOn: ["app"] } } },
      { load: loader },
    ),
  ).rejects.toThrow("cycle")
  expect(events).toEqual([])
  const fleet = await startFleet(
    { services: { app: { dependsOn: ["db"] }, db: {} } },
    { load: loader },
  )
  await fleet.close()
  expect(events).toEqual(["start:db", "start:app", "close:app", "close:db"])
})

test("explicit aggregate CORS allows unauthenticated preflight but retains mutation authorization (#425)", async () => {
  const fleet = await startFleet(
    { adminPrefix: "/_mock", adminKey: "synthetic-admin-only", services: { fixture: { port: 0 } } },
    {
      load,
      cors: {
        origins: ["https://console.example.test"],
        methods: ["GET", "POST"],
        headers: ["x-mockingbird-admin-key", "content-type"],
      },
    },
  )
  try {
    const headers = {
      origin: "https://console.example.test",
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-mockingbird-admin-key, content-type",
    }
    const allowed = await call(fleet, "/namespaces/default/reset", undefined, headers, "OPTIONS")
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get("access-control-allow-origin")).toBe(headers.origin)
    const denied = await call(
      fleet,
      "/namespaces/default/reset",
      undefined,
      { ...headers, origin: "https://unapproved.example.test" },
      "OPTIONS",
    )
    expect(denied.status).toBe(403)
    expect(denied.headers.has("access-control-allow-origin")).toBe(false)
    const mutation = await call(fleet, "/namespaces/default/reset", {}, { origin: headers.origin })
    expect(mutation.status).toBe(401)
    expect(mutation.headers.get("vary")).toContain("Origin")
    expect(
      (
        await call(
          fleet,
          "/namespaces/default/reset",
          {},
          { origin: headers.origin, "x-mockingbird-admin-key": "synthetic-admin-only" },
        )
      ).status,
    ).toBe(200)
  } finally {
    await fleet.close()
  }
})
