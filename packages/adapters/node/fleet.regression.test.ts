import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "@crvouga/mockingbird-service"
import type { ServeTarget } from "./src/cli.js"
import { type Fleet, type FleetTarget, startFleet } from "./src/fleet.js"

const target = (name = "fixture"): ServeTarget => ({
  name,
  defaultPort: 0,
  create(_values, common) {
    return createRuntime({
      name,
      ...(common.adminControls ? { adminControls: common.adminControls } : {}),
      ...(common.adminKey ? { adminKey: common.adminKey } : {}),
      ...(common.seed ? { seed: common.seed } : {}),
      create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
    })
  },
})
const call = (fleet: Fleet, path: string, body?: unknown) =>
  fleet.fetch(
    new Request(`http://fleet/__admin/fleet${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

test("invalid later controls and target resolution fail before any listener (#379, #368)", async () => {
  let listens = 0
  const load = async (name: string): Promise<FleetTarget> => ({
    ...target(name),
    listening: () => {
      listens++
    },
  })
  await expect(
    startFleet(
      { services: { first: { port: 0 }, second: { adminControls: { typo: true } as never } } },
      { load },
    ),
  ).rejects.toThrow("second")
  expect(listens).toBe(0)
  await expect(
    startFleet(
      { services: { first: { port: 0 }, missing: {} } },
      {
        load: async (name) => {
          if (name === "missing") throw new Error("install @crvouga/mockingbird-service-missing")
          return load(name)
        },
      },
    ),
  ).rejects.toThrow("install @crvouga/mockingbird-service-missing")
  expect(listens).toBe(0)
})

test("output destination collisions fail before startup, including symlinks (#382)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-paths-"))
  await symlink(dir, join(dir, "alias"))
  let loaded = 0
  try {
    await expect(
      startFleet(
        { services: { fixture: { port: 0 } } },
        {
          load: async () => {
            loaded++
            return target()
          },
          readyFile: join(dir, "ready.json"),
          connectionsFile: join(dir, "alias", "ready.json"),
        },
      ),
    ).rejects.toThrow("destinations")
    expect(loaded).toBe(0)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test("malformed paths and strict route documents are rejected without mutation (#363, #366)", async () => {
  const fleet = await startFleet(
    { services: { fixture: { port: 0 } } },
    { load: async () => target() },
  )
  try {
    for (const [path, body] of [
      ["/namespaces/%XX/reset", {}],
      ["/clock", { advence: "1h" }],
      ["/namespaces/default/snapshots", { label: {} }],
      ["/namespaces/default/snapshots", { label: "x".repeat(257) }],
    ] as const) {
      const response = await call(fleet, path, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { type: "mockingbird_admin" } })
    }
    const point = await (await call(fleet, "/namespaces/default/snapshots", {})).json()
    expect(
      (
        await call(fleet, `/namespaces/default/snapshots/${point.id}/restore`, {
          services: ["fixture"],
        })
      ).status,
    ).toBe(400)
  } finally {
    await fleet.close()
  }
})

test("aggregate clock boots consistently and empty controls preserve state (#362)", async () => {
  const fleet = await startFleet(
    {
      adminControls: { clock: { now: "2030-01-01T00:00:00Z", frozen: true } },
      services: { fixture: { port: 0 } },
    },
    { load: async () => target() },
  )
  try {
    const state = await (await call(fleet, "/clock")).json()
    expect(state.now).toBe(Date.parse("2030-01-01T00:00:00Z"))
    expect(state.frozen).toBe(true)
    await call(fleet, "/clock", {})
    expect(await (await call(fleet, "/clock")).json()).toEqual(state)
    expect((await call(fleet, "/clock", { advance: "1h" })).ok).toBe(true)
    expect((await (await call(fleet, "/clock")).json()).services.fixture.now).toBe(
      state.now + 3600000,
    )
  } finally {
    await fleet.close()
  }
})

test("stream bodies remain active until completion or cancellation (#369)", async () => {
  const child = target()
  child.create = (_v, common) =>
    createRuntime({
      name: "fixture",
      ...(common.adminControls ? { adminControls: common.adminControls } : {}),
      create: () => ({
        reset: async () => {},
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("open"))
              },
            }),
          ),
      }),
    })
  const fleet = await startFleet(
    { services: { fixture: { port: 0 } } },
    { load: async () => child },
  )
  const response = await fetch(`${fleet.manifest.services.fixture?.url}/stream`)
  try {
    expect((await call(fleet, "/namespaces/default/snapshots", {})).status).toBe(409)
    await response.body?.cancel()
    for (let i = 0; i < 100; i++) {
      if ((await (await call(fleet, "/metrics")).json()).services.fixture.activeRequests === 0)
        break
      await Bun.sleep(5)
    }
    expect((await call(fleet, "/namespaces/default/snapshots", {})).status).toBe(201)
  } finally {
    await response.body?.cancel()
    await fleet.close()
  }
})

test("incomplete rollback keeps only the affected namespace fenced (#370)", async () => {
  const child = target()
  child.create = (_v, common) => {
    const runtime = target().create({}, common) as ReturnType<typeof createRuntime>
    runtime.reset = async () => {
      throw new Error("failed mutation")
    }
    runtime.fleetRestore = () => {
      throw new Error("failed rollback")
    }
    return runtime
  }
  const fleet = await startFleet(
    { services: { fixture: { port: 0 } } },
    { load: async () => child },
  )
  try {
    expect(await (await call(fleet, "/namespaces/alpha/reset", {})).json()).toMatchObject({
      rolledBack: false,
    })
    const url = fleet.manifest.services.fixture?.url
    expect(
      (await fetch(`${url}/`, { headers: { "x-mockingbird-namespace": "alpha" } })).status,
    ).toBe(409)
    expect(
      (await fetch(`${url}/`, { headers: { "x-mockingbird-namespace": "beta" } })).status,
    ).toBe(200)
  } finally {
    await fleet.close()
  }
})

test("shutdown attempts every child, rejects failures, and preserves repeated results (#380)", async () => {
  const closed: string[] = []
  const fleet = await startFleet(
    { services: { bad: {}, good: {} } },
    {
      load: async (name) => ({
        name,
        protocol: "redis",
        defaultPort: 0,
        async start() {
          const clock = (await import("@crvouga/mockingbird-service")).createClock()
          return {
            protocol: "redis",
            url: "redis://127.0.0.1:1",
            namespaces: { endpoints: { default: "redis://127.0.0.1:1" } },
            ready: async () => true,
            close: async () => {
              closed.push(name)
              if (name === "bad") throw new Error("synthetic close failure")
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
        },
      }),
    },
  )
  await expect(fleet.close()).rejects.toThrow("bad")
  await expect(fleet.close()).rejects.toThrow("bad")
  expect(closed.sort()).toEqual(["bad", "good"])
})
