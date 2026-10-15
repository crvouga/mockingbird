import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Collection, createRuntime } from "@crvouga/mockingbird-service"
import { Redis } from "ioredis"
import { Client } from "pg"
import type { MockingbirdConfig, ServeTarget } from "./src/cli.js"
import { type Fleet, type FleetOptions, type FleetTarget, startFleet } from "./src/fleet.js"
import { diffArchives, sealArchive, validateArchive } from "./src/fleet-archive.js"
import { FleetClient, renderConnections, writeConnections } from "./src/fleet-client.js"
import { filesystemRepository } from "./src/fleet-repository.js"
import { doctorFleet, rehearseFleet } from "./src/fleet-tools.js"

const fixture = (): ServeTarget => ({
  name: "fixture",
  defaultPort: 0,
  create(_v, common) {
    return createRuntime({
      name: "fixture",
      ...(common.adminControls ? { adminControls: common.adminControls } : {}),
      ...(common.seed ? { seed: common.seed } : {}),
      create(ctx) {
        const rows = new Collection<{ value: string; random: number }>(
          ctx.sqlite,
          ctx.namespace,
          "things",
        )
        return {
          reset: async () => {
            for (const row of rows.list()) rows.delete(row.id)
          },
          fetch: async (request) => {
            if (request.method === "POST") {
              const record = { value: await request.text(), random: ctx.rng.next() }
              rows.insert(String(rows.list().length + 1), record)
              return Response.json(record)
            }
            return Response.json(rows.list().map((row) => row.value))
          },
        }
      },
    })
  },
})
const load = async (name: string): Promise<FleetTarget> =>
  name === "fixture"
    ? fixture()
    : ((await import(`../../service/${name}/src/server.ts`)) as { serveTarget: FleetTarget })
        .serveTarget
const config: MockingbirdConfig = {
  services: {
    fixture: { port: 0, seed: "synthetic" },
    postgres: { protocol: "postgres", port: 0 },
    redis: { protocol: "redis", port: 0 },
  },
}
const start = (options: Partial<FleetOptions> = {}, cfg = config) =>
  startFleet(cfg, { load, ...options })
const call = (
  fleet: Fleet,
  path: string,
  body?: unknown,
  method?: string,
  headers: Record<string, string> = {},
) =>
  fleet.fetch(
    new Request(`${fleet.manifest.adminBase}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
const endpoint = (fleet: Fleet, service: string, namespace: string) =>
  fleet.children.get(service)?.connections?.[namespace] ?? ""
const pg = async (fleet: Fleet, namespace: string, sql: string) => {
  const client = new Client({ connectionString: endpoint(fleet, "postgres", namespace) })
  await client.connect()
  try {
    return await client.query(sql)
  } finally {
    await client.end()
  }
}
const kv = async <T>(fleet: Fleet, namespace: string, run: (client: Redis) => Promise<T>) => {
  const client = new Redis(endpoint(fleet, "redis", namespace), { retryStrategy: () => null })
  try {
    return await run(client)
  } finally {
    await client.quit()
  }
}
const http = (
  fleet: Fleet,
  namespace: string,
  body?: string,
  headers: Record<string, string> = {},
) =>
  fetch(`${fleet.manifest.services.fixture?.url}/things`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-mockingbird-namespace": namespace, ...headers },
    ...(body !== undefined ? { body } : {}),
  })

// These tests exercise the public control API and actual pg/RESP listeners, not opaque handles.
test("mixed namespaces provision, isolate wire state, release listeners, and update discovery (#358)", async () => {
  const fleet = await start()
  try {
    for (const ns of ["alpha", "beta"])
      expect((await call(fleet, `/namespaces/${ns}`, {})).status).toBe(201)
    await pg(fleet, "alpha", "CREATE TABLE things (id int); INSERT INTO things VALUES (7)")
    await pg(fleet, "beta", "CREATE TABLE things (id int); INSERT INTO things VALUES (9)")
    await kv(fleet, "alpha", (c) => c.set("synthetic", "alpha"))
    await kv(fleet, "beta", (c) => c.set("synthetic", "beta"))
    await http(fleet, "alpha", "alpha")
    await http(fleet, "beta", "beta")
    expect((await pg(fleet, "beta", "SELECT * FROM things")).rows).toEqual([{ id: 9 }])
    const old = endpoint(fleet, "redis", "alpha")
    expect((await call(fleet, "/namespaces/alpha", undefined, "DELETE")).status).toBe(200)
    expect(await kv(fleet, "beta", (c) => c.get("synthetic"))).toBe("beta")
    expect(fleet.children.get("redis")?.connections?.alpha).toBeUndefined()
    expect((await call(fleet, "/namespaces")).status).toBe(200)
    expect(old).not.toBe("")
  } finally {
    await fleet.close()
  }
})

test("portable archive restores mixed state, delayed jobs and next RNG into a fresh fleet (#357)", async () => {
  const first = await start()
  let second: Fleet | undefined
  try {
    for (const ns of ["alpha", "beta"]) {
      await call(first, `/namespaces/${ns}`, {})
      await pg(
        first,
        ns,
        `CREATE TABLE things (id int); INSERT INTO things VALUES (${ns === "alpha" ? 7 : 9})`,
      )
      await kv(first, ns, async (c) => {
        await c.set("synthetic", ns)
        await c.zadd("bull:synthetic:delayed", "2000000000000", "job-1")
      })
      await http(first, ns, ns)
    }
    const archive = await (await call(first, "/archives/export", { allNamespaces: true })).json()
    expect(validateArchive(archive).format).toBe("mockingbird.fleet/v1")
    const next = await (await http(first, "alpha", "next")).json()
    await first.close()
    second = await start()
    expect((await call(second, "/archives/import", { archive })).status).toBe(200)
    expect((await pg(second, "alpha", "SELECT * FROM things")).rows).toEqual([{ id: 7 }])
    expect(await kv(second, "beta", (c) => c.get("synthetic"))).toBe("beta")
    expect(await kv(second, "alpha", (c) => c.zrange("bull:synthetic:delayed", 0, -1))).toEqual([
      "job-1",
    ])
    expect(await (await http(second, "alpha", "next")).json()).toEqual(next)
    await kv(second, "beta", (c) => c.set("synthetic", "changed"))
    expect((await call(second, "/archives/import", { archive, namespace: "alpha" })).ok).toBe(true)
    expect(await kv(second, "beta", (c) => c.get("synthetic"))).toBe("changed")
    const corrupt = { ...archive, sha256: "bad" }
    expect((await call(second, "/archives/import", { archive: corrupt })).status).toBe(400)
    expect(await kv(second, "beta", (c) => c.get("synthetic"))).toBe("changed")
  } finally {
    await first.close()
    await second?.close()
  }
})

test("selection ignores unselected namespaces; unknown selected protocol scopes are 4xx (#364, #365)", async () => {
  const fleet = await start()
  try {
    expect(
      (await call(fleet, "/wait-until-idle?namespace=unknown", { services: ["fixture"] })).status,
    ).toBe(200)
    for (const [path, body] of [
      ["/metrics?namespace=unknown", undefined],
      ["/clock?namespace=unknown", undefined],
      ["/wait-until-idle?namespace=unknown", {}],
      ["/namespaces/unknown/reset", {}],
      ["/namespaces/unknown/snapshots", {}],
    ] as const) {
      const response = await call(fleet, path, body)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        error: { type: "mockingbird_admin" },
        services: ["postgres", "redis"],
      })
    }
  } finally {
    await fleet.close()
  }
})

test("protocol seeds reject malformed values before listeners start (#367)", async () => {
  for (const service of ["postgres", "redis"] as const)
    for (const seed of ["NaN", "synthetic", "Infinity", ""])
      await expect(
        start({}, { services: { [service]: { protocol: service, port: 0, seed } } }),
      ).rejects.toThrow("finite number")
})

test("checkpoint admission differs from idleness without executing delayed work (#400)", async () => {
  const fleet = await start()
  try {
    await kv(fleet, "default", (c) => c.zadd("bull:synthetic:delayed", "2000000000000", "job-1"))
    expect((await call(fleet, "/wait-until-idle", {})).status).toBe(409)
    expect((await call(fleet, "/can-checkpoint", {})).status).toBe(200)
    await kv(fleet, "default", (c) => c.lpush("bull:synthetic:active", "active-job"))
    expect((await call(fleet, "/can-checkpoint", {})).status).toBe(409)
    expect((await call(fleet, "/can-checkpoint", { services: ["fixture"] })).status).toBe(200)
    expect((await (await call(fleet, "/namespaces/default/snapshots")).json()).snapshots).toEqual(
      [],
    )
  } finally {
    await fleet.close()
  }
})

test("checkpoint CRUD and retention are bounded and namespace isolated (#371)", async () => {
  const fleet = await start({ retention: { maxCount: 2, ttlMs: 100000 } })
  try {
    await call(fleet, "/namespaces/alpha", {})
    const point = await (
      await call(fleet, "/namespaces/alpha/snapshots", { label: "synthetic baseline" })
    ).json()
    expect((await call(fleet, `/namespaces/default/snapshots/${point.id}`)).status).toBe(404)
    expect(
      await (await call(fleet, `/namespaces/alpha/snapshots/${point.id}`)).json(),
    ).toMatchObject({ label: "synthetic baseline", services: ["fixture", "postgres", "redis"] })
    await call(fleet, "/namespaces/default/snapshots", {})
    await call(fleet, "/namespaces/default/snapshots", {})
    expect((await call(fleet, `/namespaces/alpha/snapshots/${point.id}`)).status).toBe(404)
    const list = await (await call(fleet, "/namespaces/default/snapshots")).json()
    expect(list.snapshots).toHaveLength(2)
    expect(
      (
        await call(
          fleet,
          `/namespaces/default/snapshots/${list.snapshots[0].id}`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200)
    expect(
      (await (await call(fleet, "/namespaces/default/snapshots")).json()).snapshots,
    ).toHaveLength(1)
  } finally {
    await fleet.close()
  }
})

test("discovery, console and errors share authentication and accurate capabilities (#373, #374, #375)", async () => {
  const fleet = await start({}, { ...config, adminKey: "synthetic-admin-only" })
  try {
    expect((await call(fleet, "")).status).toBe(401)
    const data = await (
      await call(fleet, "", undefined, "GET", { "x-mockingbird-admin-key": "synthetic-admin-only" })
    ).json()
    expect(data).toMatchObject({
      version: 1,
      services: { postgres: { portable: true, provisioning: true } },
    })
    expect(data.routes).toContainEqual({ method: "POST", path: "/archives/import" })
    const ui = new URL("./ui", fleet.manifest.adminBase).href
    expect((await fleet.fetch(new Request(ui))).status).toBe(401)
    expect(
      await (
        await fleet.fetch(
          new Request(ui, { headers: { "x-mockingbird-admin-key": "synthetic-admin-only" } }),
        )
      ).text(),
    ).toContain("Mockingbird Fleet")
  } finally {
    await fleet.close()
  }
})

test("scoped credentials cannot enumerate, affect other namespaces, or survive revocation (#392)", async () => {
  const fleet = await start({}, { ...config, adminKey: "synthetic-admin-only" })
  const root = { "x-mockingbird-admin-key": "synthetic-admin-only" }
  try {
    await call(fleet, "/namespaces/alpha", {}, "POST", root)
    const token = await (
      await call(
        fleet,
        "/credentials",
        { namespaces: ["alpha"], actions: ["read", "reset"], ttlMs: 10000 },
        "POST",
        root,
      )
    ).json()
    const headers = { "x-mockingbird-admin-key": token.credential }
    expect((await call(fleet, "/metrics?namespace=alpha", undefined, "GET", headers)).status).toBe(
      200,
    )
    expect((await call(fleet, "/namespaces/alpha/reset", {}, "POST", headers)).status).toBe(200)
    expect((await call(fleet, "/namespaces/default/reset", {}, "POST", headers)).status).toBe(403)
    expect(
      (await call(fleet, "/namespaces?namespace=alpha", undefined, "GET", headers)).status,
    ).toBe(403)
    expect((await call(fleet, `/credentials/${token.id}`, undefined, "DELETE", root)).status).toBe(
      200,
    )
    expect((await call(fleet, "/metrics?namespace=alpha", undefined, "GET", headers)).status).toBe(
      401,
    )
  } finally {
    await fleet.close()
  }
})

test("idempotency handles simultaneous and lost-response retries without repeating reset (#387)", async () => {
  const fleet = await start()
  const headers = { "idempotency-key": "synthetic-retry" }
  try {
    await http(fleet, "default", "before")
    const [first, retry] = await Promise.all([
      call(fleet, "/namespaces/default/reset", {}, "POST", headers),
      call(fleet, "/namespaces/default/reset", {}, "POST", headers),
    ])
    expect(await first.json()).toEqual(await retry.json())
    expect(first.headers.get("x-mockingbird-operation-id")).toBe(
      retry.headers.get("x-mockingbird-operation-id"),
    )
    await http(fleet, "default", "after")
    expect((await call(fleet, "/namespaces/default/reset", {}, "POST", headers)).ok).toBe(true)
    expect(await (await http(fleet, "default")).json()).toHaveLength(1)
    expect(
      (await call(fleet, "/namespaces/default/reset", { services: ["fixture"] }, "POST", headers))
        .status,
    ).toBe(409)
  } finally {
    await fleet.close()
  }
})

test("successful reset/restore generations reject queued stale writes and never rewind (#388)", async () => {
  const fleet = await start()
  try {
    const first = await http(fleet, "default", "before"),
      old = first.headers.get("x-mockingbird-generation") as string
    const point = await (await call(fleet, "/namespaces/default/snapshots", {})).json()
    await call(fleet, `/namespaces/default/snapshots/${point.id}/restore`, {})
    expect(
      (await http(fleet, "default", "stale", { "x-mockingbird-generation": old })).status,
    ).toBe(409)
    const after = (await http(fleet, "default")).headers.get("x-mockingbird-generation")
    await call(fleet, `/namespaces/default/snapshots/${point.id}/restore`, {})
    expect((await http(fleet, "default")).headers.get("x-mockingbird-generation")).not.toBe(after)
  } finally {
    await fleet.close()
  }
})

test("wire writes are visible in scoped bounded protocol inspection (#397)", async () => {
  const fleet = await start()
  try {
    await call(fleet, "/namespaces/alpha", {})
    await pg(fleet, "alpha", "CREATE TABLE things (id int); INSERT INTO things VALUES (7)")
    await kv(fleet, "alpha", (c) => c.set("synthetic", "value"))
    expect(
      await (
        await call(fleet, "/inspect?namespace=alpha&service=postgres&collection=things&limit=1")
      ).json(),
    ).toMatchObject({ result: { records: [{ id: 7 }] } })
    expect(
      await (await call(fleet, "/inspect?namespace=alpha&service=redis")).json(),
    ).toMatchObject({ result: { keys: [{ key: "synthetic", type: "string" }] } })
    expect(
      await (await call(fleet, "/inspect?namespace=default&service=redis")).json(),
    ).toMatchObject({ result: { keys: [] } })
  } finally {
    await fleet.close()
  }
})

test("profiles apply atomically, reject unsupported controls and preserve other customers (#399)", async () => {
  const fleet = await start({ profiles: { outage: { fixture: { faults: [{ status: 503 }] } } } })
  try {
    await call(fleet, "/namespaces/alpha", {})
    expect((await call(fleet, "/profiles/apply?namespace=alpha", { name: "outage" })).ok).toBe(true)
    expect((await http(fleet, "alpha")).status).toBe(503)
    expect((await http(fleet, "default")).status).toBe(200)
    expect(
      (
        await call(fleet, "/profiles/apply?namespace=alpha", {
          profile: { fixture: { latency: 0 }, redis: { faults: [] } },
        })
      ).status,
    ).toBe(400)
    expect((await http(fleet, "alpha")).status).toBe(503)
    expect(
      (await call(fleet, "/profiles/baseline?namespace=alpha", { services: ["fixture"] })).ok,
    ).toBe(true)
    expect((await http(fleet, "alpha")).status).toBe(200)
  } finally {
    await fleet.close()
  }
})

test("reusable scenarios seed two isolated customers and refuse incompatible bundles (#385)", async () => {
  const fleet = await start({
    scenarios: {
      baseline: {
        format: "mockingbird.scenario/v1",
        version: 1,
        seed: "synthetic",
        services: {
          fixture: {
            protocol: "http",
            fixtures: [{ collection: "things", id: "1", value: { value: "seed", random: 0 } }],
          },
        },
      },
      incompatible: {
        format: "mockingbird.scenario/v1",
        version: 1,
        services: { absent: { protocol: "http" } },
      },
    },
  })
  try {
    for (const ns of ["alpha", "beta"]) {
      await call(fleet, `/namespaces/${ns}`, {})
      expect((await call(fleet, `/scenarios/baseline/apply?namespace=${ns}`, {})).ok).toBe(true)
      expect(await (await http(fleet, ns)).json()).toEqual([{ value: "seed", random: 0 }])
    }
    expect((await call(fleet, "/scenarios/incompatible/apply", {})).status).toBe(400)
  } finally {
    await fleet.close()
  }
})

test("default diagnostics are bounded metadata and exclude configured secrets and records (#402)", async () => {
  const fleet = await start(
    {},
    {
      ...config,
      adminKey: "synthetic-admin-only",
      services: {
        ...config.services,
        redis: { protocol: "redis", port: 0, password: "synthetic-redis-only" },
      },
    },
  )
  try {
    await http(fleet, "default", "synthetic-private-record")
    const text = await (
      await call(fleet, "/diagnostics", undefined, "GET", {
        "x-mockingbird-admin-key": "synthetic-admin-only",
      })
    ).text()
    for (const excluded of [
      "synthetic-admin-only",
      "synthetic-redis-only",
      "synthetic-private-record",
    ])
      expect(text).not.toContain(excluded)
    expect(JSON.parse(text)).toMatchObject({
      format: "mockingbird.diagnostics/v1",
      truncated: false,
    })
  } finally {
    await fleet.close()
  }
})

test("namespace quotas reserve concurrent creation and release capacity after deletion (#393)", async () => {
  const fleet = await start({ limits: { maxNamespaces: 2 } })
  try {
    const results = await Promise.all([
      call(fleet, "/namespaces/alpha", {}),
      call(fleet, "/namespaces/beta", {}),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([201, 429])
    const kept = (await (await call(fleet, "/namespaces")).json()).namespaces.find(
      (n: { namespace: string }) => n.namespace !== "default",
    ).namespace
    await call(fleet, `/namespaces/${kept}`, undefined, "DELETE")
    expect((await call(fleet, "/namespaces/gamma", {})).status).toBe(201)
  } finally {
    await fleet.close()
  }
})

test("independent namespace operations proceed while conflicts name the active operation (#377, #378, #384)", async () => {
  let release = () => {},
    entered = () => {}
  const gate = new Promise<void>((r) => {
      release = r
    }),
    started = new Promise<void>((r) => {
      entered = r
    })
  const hooks: string[] = []
  const fleet = await start({
    workload: {
      async prepare({ namespace }) {
        hooks.push(`prepare:${namespace}`)
        if (namespace === "alpha") {
          entered()
          await gate
        }
      },
      async verify({ namespace }) {
        hooks.push(`verify:${namespace}`)
      },
      async resume({ namespace }) {
        hooks.push(`resume:${namespace}`)
      },
    },
  })
  await call(fleet, "/namespaces/alpha", {})
  await call(fleet, "/namespaces/beta", {})
  const held = call(fleet, "/namespaces/alpha/reset", {})
  try {
    await started
    expect((await call(fleet, "/namespaces/beta/reset", {})).status).toBe(200)
    const conflict = await call(fleet, "/namespaces/alpha/reset", {})
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).operationId).toBeString()
    expect((await fetch(fleet.manifest.healthUrl)).status).toBe(503)
    expect((await fetch(fleet.manifest.healthUrl.replace(/\/health$/, "/live"))).status).toBe(200)
    release()
    expect((await held).ok).toBe(true)
    expect(hooks).toContain("resume:alpha")
    expect(hooks).toContain("resume:beta")
  } finally {
    release()
    await held
    await fleet.close()
  }
})

test("a failed resume keeps namespace fenced; unrelated workloads stay available (#384)", async () => {
  const fleet = await start({
    workload: {
      async resume({ namespace }) {
        if (namespace === "alpha") throw new Error("synthetic resume failed")
      },
    },
  })
  try {
    await call(fleet, "/namespaces/alpha", {})
    expect((await call(fleet, "/namespaces/alpha/reset", {})).status).toBe(500)
    expect((await http(fleet, "alpha")).status).toBe(409)
    expect((await http(fleet, "default")).status).toBe(200)
  } finally {
    await fleet.close()
  }
})

test("initializer uses private discovery and gates traffic and artifact publication (#401)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-initialize-"))
  let release = () => {},
    entered = () => {}
  const gate = new Promise<void>((r) => {
      release = r
    }),
    started = new Promise<void>((r) => {
      entered = r
    })
  let manifest: Fleet["manifest"] | undefined
  const boot = start({
    readyFile: join(dir, "ready.json"),
    async initialize(context) {
      manifest = context.manifest
      expect(
        (
          await fetch(`${context.manifest.services.fixture?.url}/things`, {
            method: "POST",
            body: "seed",
            headers: context.headers,
          })
        ).status,
      ).toBe(200)
      entered()
      await gate
    },
  })
  let fleet: Fleet | undefined
  try {
    await started
    expect(
      await readFile(join(dir, "ready.json"), "utf8").then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect((await fetch(`${manifest?.services.fixture?.url}/things`)).status).toBe(503)
    release()
    fleet = await boot
    expect(await (await http(fleet, "default")).json()).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, "ready.json"), "utf8")).state).toBe("ready")
  } finally {
    release()
    fleet ??= await boot
    await fleet.close()
    await rm(dir, { recursive: true, force: true })
  }
  await expect(
    start({
      initialize: async () => {
        throw new Error("synthetic seed failure")
      },
    }),
  ).rejects.toThrow("synthetic seed failure")
})

test("shutdown gate keeps status available until backup is acknowledged (#372)", async () => {
  let release = () => {},
    entered = () => {}
  const gate = new Promise<void>((r) => {
      release = r
    }),
    started = new Promise<void>((r) => {
      entered = r
    })
  const fleet = await start({
    async beforeClose({ capture }) {
      const archive = await capture(["default"])
      expect(validateArchive(archive)).toBeDefined()
      entered()
      await gate
    },
  })
  const closing = fleet.close()
  try {
    await started
    expect((await fetch(fleet.manifest.healthUrl.replace(/\/health$/, "/live"))).status).toBe(200)
    expect((await http(fleet, "default")).status).toBe(503)
  } finally {
    release()
    await closing
  }
})

test("scheduled backups use host time and preserve latest pointer on storage failure (#390, #391)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-backups-")),
    repository = filesystemRepository(dir)
  let rejectUpload = false
  let firstPublication: string | undefined
  const fleet = await start(
    {
      repository: {
        ...repository,
        async put(a) {
          if (rejectUpload) throw new Error("synthetic storage failure")
          return repository.put(a)
        },
        async publishLatest(id) {
          await repository.publishLatest(id)
          // Switch to failure before this successful run can release backupRunning.
          // A timer that already uploaded must not race the failure assertion.
          rejectUpload = true
          firstPublication = id
        },
      },
      backupPolicy: { intervalMs: 30, keep: 2 },
    },
    { ...config, adminControls: { clock: { now: 0, frozen: true } } },
  )
  try {
    for (let i = 0; i < 100 && !firstPublication; i++) await Bun.sleep(10)
    if (!firstPublication) throw new Error("scheduled backup did not publish a recovery point")
    expect(validateArchive(await repository.get(firstPublication))).toBeDefined()
    let status = await (await call(fleet, "/backups")).json()
    for (let i = 0; i < 100 && !status.lastFailure; i++) {
      await Bun.sleep(10)
      status = await (await call(fleet, "/backups")).json()
    }
    expect(status).toMatchObject({ lastFailure: "synthetic storage failure" })
    expect(await repository.latest()).toBe(firstPublication)
  } finally {
    await fleet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("idle expiry uses host time, protects pinned namespaces and previews busy clients (#394)", async () => {
  const fleet = await start(
    { expiry: { idleMs: 20, intervalMs: 100000 } },
    { ...config, adminControls: { clock: { now: 0, frozen: true } } },
  )
  try {
    for (const ns of ["alpha", "beta"]) await call(fleet, `/namespaces/${ns}`, {})
    await call(fleet, "/namespaces/beta/policy", { pinned: true })
    await Bun.sleep(25)
    const preview = await (await call(fleet, "/cleanup")).json()
    expect(preview.candidates).toContainEqual(
      expect.objectContaining({ namespace: "alpha", eligible: true }),
    )
    expect(preview.candidates).toContainEqual(
      expect.objectContaining({ namespace: "beta", eligible: false, pinned: true }),
    )
    await call(fleet, "/cleanup", {})
    expect(
      (await (await call(fleet, "/namespaces")).json()).namespaces.map(
        (n: { namespace: string }) => n.namespace,
      ),
    ).toEqual(["default", "beta"])
  } finally {
    await fleet.close()
  }
})

test("SSE replays selected namespace operations and signals a gap with resync (#386)", async () => {
  const fleet = await start()
  try {
    const mutation = await call(fleet, "/namespaces/default/reset", {})
    expect(mutation.headers.get("x-mockingbird-operation-id")).toBeString()
    const response = await call(fleet, "/events", undefined, "GET", {
      "last-event-id": "old-process:1",
    })
    const reader = response.body?.getReader()
    const first = new TextDecoder().decode((await reader?.read())?.value)
    expect(first).toContain("event: resync")
    const second = new TextDecoder().decode((await reader?.read())?.value)
    expect(second).toContain("event: lifecycle")
    expect(second).not.toContain('"namespace":"alpha"')
    await reader?.cancel()
  } finally {
    await fleet.close()
  }
})

test("semantic archive diff is bounded and read-only (#389)", () => {
  const base = {
    format: "mockingbird.fleet/v1" as const,
    createdAt: new Date().toISOString(),
    sourceId: "synthetic",
    namespaces: {
      alpha: {
        clock: { now: 0, frozen: true },
        services: {
          fixture: {
            protocol: "http" as const,
            version: 1 as const,
            state: { records: [{ collection: "things", id: "1", value: "before" }] },
          },
        },
      },
    },
  }
  const a = sealArchive(base),
    b = sealArchive({
      ...base,
      namespaces: {
        alpha: {
          ...base.namespaces.alpha,
          services: {
            fixture: {
              ...base.namespaces.alpha.services.fixture,
              state: { records: [{ collection: "things", id: "1", value: "after" }] },
            },
          },
        },
      },
    })
  const before = JSON.stringify(a)
  const diff = diffArchives(a, b)
  expect(diff.changes).toContainEqual(
    expect.objectContaining({ path: "/state/records/things/1/value", kind: "changed" }),
  )
  expect(JSON.stringify(diff)).not.toContain("before")
  expect(JSON.stringify(a)).toBe(before)
})

test("config renderer uses current namespace discovery, writes restricted output and refuses missing mappings (#398)", async () => {
  const fleet = await start(),
    dir = await mkdtemp(join(tmpdir(), "fleet-render-"))
  try {
    for (const ns of ["alpha", "beta"]) await call(fleet, `/namespaces/${ns}`, {})
    const privateManifest = () => ({
      version: 1 as const,
      services: Object.fromEntries(
        [...fleet.children].map(([name, c]) => [
          name,
          { url: c.connection ?? c.url, ...(c.connections ? { namespaces: c.connections } : {}) },
        ]),
      ),
    })
    const mapping = {
      DATABASE_URL: { service: "postgres" },
      REDIS_URL: { service: "redis" },
      VENDOR_URL: { service: "fixture" },
    }
    const alpha = renderConnections(fleet.manifest, privateManifest(), "alpha", mapping),
      beta = renderConnections(fleet.manifest, privateManifest(), "beta", mapping)
    expect(alpha.DATABASE_URL).not.toBe(beta.DATABASE_URL)
    await fetch(`${alpha.VENDOR_URL}/things`, { method: "POST", body: "alpha" })
    expect(await (await fetch(`${beta.VENDOR_URL}/things`)).json()).toEqual([])
    await writeConnections(join(dir, "app.env"), alpha, "dotenv")
    expect((await stat(join(dir, "app.env"))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(dir, "app.env"), "utf8")).toContain("DATABASE_URL=")
    expect(() => renderConnections(fleet.manifest, privateManifest(), "absent", mapping)).toThrow(
      "missing namespace",
    )
    const old = alpha.REDIS_URL
    await call(fleet, "/namespaces/alpha", undefined, "DELETE")
    await call(fleet, "/namespaces/alpha", {})
    expect(
      renderConnections(fleet.manifest, privateManifest(), "alpha", mapping).REDIS_URL,
    ).not.toBe(old)
  } finally {
    await fleet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("typed management client preserves prefixes, auth, selection and validation (#383)", async () => {
  const fleet = await start(
    {},
    { ...config, adminPrefix: "/_mock", adminKey: "synthetic-admin-only" },
  )
  const client = new FleetClient(fleet.manifest.adminBase, { adminKey: "synthetic-admin-only" })
  try {
    expect((await client.discover()).version).toBe(1)
    await client.createNamespace("alpha")
    const point = await client.snapshot("alpha", { label: "synthetic" })
    await client.restore("alpha", point.id)
    expect(validateArchive(await client.exportArchive("alpha"))).toBeDefined()
    await expect(new FleetClient(fleet.manifest.adminBase).namespaces()).rejects.toThrow("401")
  } finally {
    await fleet.close()
  }
})

test("doctor is read-only with actionable load errors and reachability failures (#395)", async () => {
  let starts = 0
  const result = await doctorFleet(
    { services: { fixture: { port: 0 } } },
    {
      load: async () => ({
        ...fixture(),
        listening: () => {
          starts++
        },
      }),
    },
    [{ url: "http://127.0.0.1:1", timeoutMs: 50 }],
  )
  expect(result.ok).toBe(false)
  expect(result.storageWritesPerformed).toBe(false)
  expect(starts).toBe(0)
  const missing = await doctorFleet(
    { services: { absent: {} } },
    {
      load: async () => {
        throw new Error("install @crvouga/mockingbird-service-absent")
      },
    },
  )
  expect(missing.findings[0]?.message).toContain("install @crvouga/mockingbird-service-absent")
})

test("restore rehearsal uses a distinct fleet and preserves source data and recovery pointer (#396)", async () => {
  const fleet = await start()
  try {
    await http(fleet, "default", "synthetic")
    const archive = await (await call(fleet, "/archives/export", {})).json()
    const result = await rehearseFleet(config, { load }, archive, [
      async (rehearsal) => {
        expect(rehearsal.manifest.id).not.toBe(fleet.manifest.id)
        expect(rehearsal.manifest.services.fixture?.url).not.toBe(
          fleet.manifest.services.fixture?.url,
        )
        expect(await (await http(rehearsal, "default")).json()).toHaveLength(1)
      },
    ])
    expect(result.ok).toBe(true)
    await expect(
      rehearseFleet(config, { load }, { ...archive, format: "incompatible" }),
    ).rejects.toThrow()
    expect(await (await http(fleet, "default")).json()).toHaveLength(1)
  } finally {
    await fleet.close()
  }
})

test("protocol initialization seeds private wire listeners while ordinary connections stay fenced (#401)", async () => {
  let sourceRedis = ""
  const fleet = await start({
    async initialize({ manifest, connections }) {
      const privateUrls = connections as Record<
        string,
        { url: string; namespaces: Record<string, string> }
      >
      sourceRedis = manifest.services.redis?.url ?? ""
      const client = new Redis(privateUrls.redis?.url ?? "", { retryStrategy: () => null })
      const sql = new Client({ connectionString: privateUrls.postgres?.url ?? "" })
      try {
        await client.set("synthetic-init", "seeded")
        await sql.connect()
        await sql.query("CREATE TABLE initialized (id int); INSERT INTO initialized VALUES (7)")
      } finally {
        await client.quit()
        await sql.end()
      }
      const publicClient = new Redis(sourceRedis, { retryStrategy: () => null })
      publicClient.on("error", () => {})
      try {
        await expect(publicClient.ping()).rejects.toThrow()
      } finally {
        publicClient.disconnect()
      }
    },
  })
  try {
    expect(await kv(fleet, "default", (c) => c.get("synthetic-init"))).toBe("seeded")
    expect((await pg(fleet, "default", "SELECT * FROM initialized")).rows).toEqual([{ id: 7 }])
  } finally {
    await fleet.close()
  }
})

test("protocol connection quotas reject extra clients and recover after release (#393)", async () => {
  const fleet = await start({ limits: { connections: 1 } })
  const first = new Redis(endpoint(fleet, "redis", "default"), { retryStrategy: () => null })
  try {
    expect(await first.ping()).toBe("PONG")
    const second = new Redis(endpoint(fleet, "redis", "default"), { retryStrategy: () => null })
    second.on("error", () => {})
    try {
      await expect(second.ping()).rejects.toThrow()
    } finally {
      second.disconnect()
    }
    await first.quit()
    for (
      let i = 0;
      i < 100 && (fleet.children.get("redis")?.diagnostics("default").activeConnections ?? 0) > 0;
      i++
    )
      await Bun.sleep(5)
    expect(await kv(fleet, "default", (c) => c.ping())).toBe("PONG")
  } finally {
    first.disconnect()
    await fleet.close()
  }
})

test("multi-namespace capture fences all traffic until the final child is captured (#357, #377)", async () => {
  const fleet = await start()
  await call(fleet, "/namespaces/alpha", {})
  const child = fleet.children.get("fixture") as NonNullable<ReturnType<typeof fleet.children.get>>
  const checkpoint = child.checkpoint.bind(child)
  let release = () => {},
    entered = () => {},
    count = 0
  const gate = new Promise<void>((r) => {
      release = r
    }),
    started = new Promise<void>((r) => {
      entered = r
    })
  child.checkpoint = async (ns) => {
    if (ns === "alpha" && ++count === 2) {
      entered()
      await gate
    }
    return checkpoint(ns)
  }
  const capture = call(fleet, "/archives/export", { allNamespaces: true })
  try {
    await started
    expect((await http(fleet, "default", "interleave")).status).toBe(409)
  } finally {
    release()
    expect((await capture).status).toBe(200)
    child.checkpoint = checkpoint
    await fleet.close()
  }
})

test("scenario application hooks seed the actual fenced engines using private access (#385)", async () => {
  const fleet = await start({
    scenarios: {
      mixed: {
        format: "mockingbird.scenario/v1",
        version: 1,
        seed: "synthetic",
        services: {
          fixture: { protocol: "http" },
          postgres: { protocol: "postgres" },
          redis: { protocol: "redis" },
        },
        async seedApplication({ manifest, connections, headers }) {
          const client = new Redis(connections.redis?.url ?? "", { retryStrategy: () => null })
          const sql = new Client({ connectionString: connections.postgres?.url ?? "" })
          try {
            await client.set("synthetic-scenario", "seeded")
            await sql.connect()
            await sql.query("CREATE TABLE scenario (id int); INSERT INTO scenario VALUES (7)")
            const response = await fetch(`${manifest.services.fixture?.url}/things`, {
              method: "POST",
              headers,
              body: "scenario",
            })
            expect(response.status).toBe(200)
            await response.text()
          } finally {
            await client.quit()
            await sql.end()
          }
        },
      },
    },
  })
  try {
    expect((await call(fleet, "/scenarios/mixed/apply", {})).status).toBe(200)
    expect(await kv(fleet, "default", (c) => c.get("synthetic-scenario"))).toBe("seeded")
    expect((await pg(fleet, "default", "SELECT * FROM scenario")).rows).toEqual([{ id: 7 }])
  } finally {
    await fleet.close()
  }
})

test("snapshot protocol diffs report changed table and Redis key identifiers (#389)", async () => {
  const fleet = await start()
  try {
    await pg(
      fleet,
      "default",
      "CREATE TABLE things (id int, value text); INSERT INTO things VALUES (1, 'before')",
    )
    await kv(fleet, "default", (c) => c.set("synthetic-diff", "before"))
    const left = await (await call(fleet, "/archives/export", {})).json()
    await pg(fleet, "default", "UPDATE things SET value = 'after' WHERE id = 1")
    await kv(fleet, "default", (c) => c.set("synthetic-diff", "after"))
    const right = await (await call(fleet, "/archives/export", {})).json()
    const diff = diffArchives(left, right)
    expect(
      diff.changes.some((c) => c.service === "postgres" && c.path.includes("/things/records/1")),
    ).toBe(true)
    expect(
      diff.changes.some((c) => c.service === "redis" && c.path.includes("synthetic-diff")),
    ).toBe(true)
  } finally {
    await fleet.close()
  }
})

test("namespace fork copies real mixed state and preserves the source (#404)", async () => {
  const fleet = await start()
  try {
    await call(fleet, "/namespaces/alpha", {})
    await pg(fleet, "alpha", "CREATE TABLE forked (id int); INSERT INTO forked VALUES (7)")
    await kv(fleet, "alpha", (c) => c.zadd("bull:synthetic:delayed", "2000000000000", "job-1"))
    await http(fleet, "alpha", "fork baseline")
    expect((await call(fleet, "/namespaces/alpha/fork", { destination: "beta" })).status).toBe(201)
    expect((await pg(fleet, "beta", "SELECT * FROM forked")).rows).toEqual([{ id: 7 }])
    expect(await kv(fleet, "beta", (c) => c.zrange("bull:synthetic:delayed", 0, -1))).toEqual([
      "job-1",
    ])
    await http(fleet, "beta", "independent")
    expect(await (await http(fleet, "alpha")).json()).toHaveLength(1)
    expect((await call(fleet, "/namespaces/alpha/fork", { destination: "beta" })).status).toBe(409)
    await call(fleet, "/namespaces/beta/reset", {})
    expect((await pg(fleet, "alpha", "SELECT * FROM forked")).rows).toEqual([{ id: 7 }])
  } finally {
    await fleet.close()
  }
})

test("run fixtures isolate concurrent callbacks and preserve both callback and cleanup failures (#413)", async () => {
  const { withFleetRun, FleetRunError } = await import("./src/fleet-runs.js")
  const fleet = await start({}, { ...config, adminKey: "synthetic-admin-only" })
  const client = new FleetClient(fleet.manifest.adminBase, { adminKey: "synthetic-admin-only" })
  try {
    const names = await Promise.all(
      [1, 2].map(() =>
        withFleetRun(client, {}, async (run) => {
          expect(JSON.stringify(run)).not.toContain("synthetic-admin-only")
          expect(run.generation).toBeString()
          return run.namespace
        }),
      ),
    )
    expect(names[0]).not.toBe(names[1])
    expect(
      (
        await (
          await call(fleet, "/namespaces", undefined, "GET", {
            "x-mockingbird-admin-key": "synthetic-admin-only",
          })
        ).json()
      ).namespaces,
    ).toHaveLength(1)
    let failed: unknown
    try {
      await withFleetRun(client, {}, async (run) => {
        run.registerCleanup(async () => {
          throw new Error("synthetic cleanup failure")
        })
        throw new Error("synthetic callback failure")
      })
    } catch (error) {
      failed = error
    }
    expect(failed).toBeInstanceOf(FleetRunError)
    expect((failed as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "synthetic callback failure",
      "synthetic cleanup failure",
    ])
    expect((failed as InstanceType<typeof FleetRunError>).evidence).toMatchObject({
      format: "mockingbird.diagnostics/v1",
    })
  } finally {
    await fleet.close()
  }
})

test("debug-preserved run descriptors have bounded fleet-owned expiry (#413)", async () => {
  const { withFleetRun, FleetRunError } = await import("./src/fleet-runs.js")
  const fleet = await start(),
    client = new FleetClient(fleet.manifest.adminBase)
  try {
    let failed: InstanceType<typeof FleetRunError> | undefined
    try {
      await withFleetRun(client, { preserveOnFailureMs: 60 }, async () => {
        throw new Error("synthetic preserve")
      })
    } catch (error) {
      failed = error as InstanceType<typeof FleetRunError>
    }
    expect(failed?.run?.expiresAt).toBeNumber()
    const ns = failed?.run?.namespace
    expect(
      (await (await call(fleet, "/namespaces")).json()).namespaces.some(
        (n: { namespace: string }) => n.namespace === ns,
      ),
    ).toBe(true)
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(10)
      if (
        !(await (await call(fleet, "/namespaces")).json()).namespaces.some(
          (n: { namespace: string }) => n.namespace === ns,
        )
      )
        break
    }
    expect(
      (await (await call(fleet, "/namespaces")).json()).namespaces.some(
        (n: { namespace: string }) => n.namespace === ns,
      ),
    ).toBe(false)
  } finally {
    await fleet.close()
  }
})

test("namespace pools lease uniquely, verify reset before reuse, and bound exhausted waits (#421)", async () => {
  const { NamespacePool } = await import("./src/fleet-runs.js")
  const fleet = await start(),
    client = new FleetClient(fleet.manifest.adminBase)
  const pool = new NamespacePool(client, { maxSize: 1, baselineVersion: "synthetic-v1" })
  try {
    const first = await pool.acquire()
    await http(fleet, first.namespace, "borrower data")
    await expect(pool.acquire({ timeoutMs: 10 })).rejects.toThrow("capacity exhausted")
    await pool.release(first)
    const next = await pool.acquire()
    expect(next.namespace).toBe(first.namespace)
    expect(next.leaseId).not.toBe(first.leaseId)
    expect(await (await http(fleet, next.namespace)).json()).toEqual([])
    expect(next.generation).not.toBe(first.generation)
    await pool.release(next)
    await pool.setBaseline("synthetic-v2")
    const fresh = await pool.acquire()
    expect(fresh.namespace).not.toBe(first.namespace)
    await pool.release(fresh)
  } finally {
    await pool.close()
    await fleet.close()
  }
})

test("redacted audit entries attribute denied and completed operations and survive restoring application state (#410)", async () => {
  const written: unknown[] = []
  const fleet = await start(
    {
      audit: {
        failurePolicy: "closed",
        write: async (event) => {
          written.push(event)
        },
      },
    },
    { ...config, adminKey: "synthetic-admin-only" },
  )
  const root = { "x-mockingbird-admin-key": "synthetic-admin-only" }
  try {
    expect(
      (
        await call(fleet, "/namespaces/default/reset", {}, "POST", {
          "x-mockingbird-admin-key": "synthetic-invalid-presented-key",
        })
      ).status,
    ).toBe(401)
    const snapshot = await (
      await call(fleet, "/namespaces/default/snapshots", {}, "POST", root)
    ).json()
    await call(fleet, `/namespaces/default/snapshots/${snapshot.id}/restore`, {}, "POST", root)
    const text = await (await call(fleet, "/audit", undefined, "GET", root)).text()
    expect(text).toContain('"stage":"denied"')
    expect(text).toContain('"stage":"terminal"')
    for (const secret of ["synthetic-admin-only", "synthetic-invalid-presented-key"])
      expect(text).not.toContain(secret)
    expect(written.length).toBeGreaterThanOrEqual(5)
    expect(JSON.parse(text).entries.some((entry: { durable: boolean }) => entry.durable)).toBe(true)
  } finally {
    await fleet.close()
  }
})

test("required audit failure prevents mutation and reports undurable evidence (#410)", async () => {
  const fleet = await start({
    audit: {
      failurePolicy: "closed",
      write: async () => {
        throw new Error("sink unavailable")
      },
    },
  })
  try {
    await http(fleet, "default", "keep")
    expect((await call(fleet, "/namespaces/default/reset", {})).ok).toBe(false)
    expect(await (await http(fleet, "default")).json()).toHaveLength(1)
    expect(await (await call(fleet, "/audit")).json()).toMatchObject({
      failurePolicy: "closed",
      entries: [expect.objectContaining({ durable: false })],
    })
  } finally {
    await fleet.close()
  }
})

test("telemetry correlates lifecycle events using host elapsed time without namespace labels or bodies (#411)", async () => {
  const events: unknown[] = []
  const fleet = await start(
    {
      telemetry: (event) => {
        events.push(event)
      },
      workload: {
        prepare: async () => {
          await Bun.sleep(5)
        },
      },
    },
    { ...config, adminControls: { clock: { now: 0, frozen: true } } },
  )
  try {
    const response = await call(fleet, "/namespaces/default/reset", {})
    expect(response.ok).toBe(true)
    const id = response.headers.get("x-mockingbird-operation-id")
    expect(events.every((event) => (event as { operationId: string }).operationId === id)).toBe(
      true,
    )
    const telemetry = await (await call(fleet, "/telemetry")).json()
    expect(telemetry.metrics.succeeded).toBe(1)
    expect(telemetry.metrics.durationsMs.max).toBeGreaterThanOrEqual(4)
    expect(telemetry.cardinality).toBe("aggregate-no-namespace-labels")
    expect(JSON.stringify(events)).not.toContain('"namespace":')
  } finally {
    await fleet.close()
  }
})

test("run assertion controls observe real unmatched vendor traffic after a namespace baseline (#416)", async () => {
  const fleet = await start({}, { services: { stripe: { port: 0 } } })
  try {
    const url = fleet.manifest.services.stripe?.url
    await fetch(`${url}/synthetic-missing`, {
      headers: { "x-mockingbird-namespace": "alpha", authorization: "Bearer sk_test_mockingbird" },
    })
    const baseline = await (await call(fleet, "/assertions/baseline?namespace=alpha", {})).json()
    expect((await call(fleet, `/assertions/${baseline.id}/check?namespace=alpha`, {})).status).toBe(
      200,
    )
    await fetch(`${url}/synthetic-missing`, {
      headers: { "x-mockingbird-namespace": "alpha", authorization: "Bearer sk_test_mockingbird" },
    })
    const failed = await (
      await call(fleet, `/assertions/${baseline.id}/check?namespace=alpha`, {})
    ).json()
    expect(failed.clean).toBe(false)
    expect(failed.failures[0]).toMatchObject({ kind: "unmatched", service: "stripe", status: 404 })
    const allowance = {
      kind: "unmatched",
      service: "stripe",
      pathFingerprint: failed.failures[0].pathFingerprint,
      status: 404,
      maxCount: 1,
    }
    expect(
      (
        await call(fleet, `/assertions/${baseline.id}/check?namespace=alpha`, {
          allowances: [allowance],
        })
      ).status,
    ).toBe(200)
    expect((await call(fleet, `/assertions/${baseline.id}/check?namespace=beta`, {})).ok).toBe(
      false,
    )
  } finally {
    await fleet.close()
  }
})

test("bounded HTTP/control traces replay from baseline only into a separate admitted synthetic fleet (#422)", async () => {
  const { replayFleetTrace } = await import("./src/fleet-observations.js")
  const source = await start(
    { trace: true },
    { services: { fixture: { port: 0, seed: "synthetic" } } },
  )
  const destination = await start({}, { services: { fixture: { port: 0, seed: "synthetic" } } })
  try {
    expect((await call(source, "/trace/start", { includeBodies: true })).status).toBe(200)
    await (await http(source, "default", "replayed")).json()
    await call(source, "/clock", { freeze: true, advance: 10 })
    await (await http(source, "default", "second")).json()
    const artifact = await (await call(source, "/trace/stop", {})).json()
    expect(artifact.events.map((event: { kind: string }) => event.kind)).toEqual([
      "http",
      "control",
      "http",
    ])
    const subject = {
      manifest: destination.manifest,
      connections: {
        version: 1 as const,
        services: { fixture: { url: destination.children.get("fixture")?.url ?? "" } },
      },
      client: new FleetClient(destination.manifest.adminBase),
      close: destination.close,
    }
    const result = await replayFleetTrace(artifact, subject)
    expect(result.matched).toBe(true)
    expect(result.complete).toBe(true)
    expect(await (await http(destination, "default")).json()).toEqual(
      await (await http(source, "default")).json(),
    )
    await expect(
      replayFleetTrace(artifact, { ...subject, manifest: source.manifest }),
    ).rejects.toThrow("separate")
  } finally {
    await source.close()
    await destination.close()
  }
})

test("event stepping advances the earliest Redis deadline and bounds workerless delayed-job cycles (#414)", async () => {
  const fleet = await start({}, { ...config, adminControls: { clock: { now: 0, frozen: true } } })
  try {
    await kv(fleet, "default", (c) => c.set("synthetic-expiry", "value", "PX", 10))
    const step = await (await call(fleet, "/time/step-next", { services: ["redis"] })).json()
    expect(step).toMatchObject({ status: "stepped", steps: [{ now: 10, processed: ["redis"] }] })
    expect(await kv(fleet, "default", (c) => c.get("synthetic-expiry"))).toBeNull()
    await kv(fleet, "default", (c) => c.zadd("bull:synthetic:delayed", String(20 * 4096), "job-1"))
    const response = await call(fleet, "/time/run-until", {
      services: ["redis"],
      maxEvents: 3,
      timeoutMs: 1000,
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      status: "budget-exhausted",
      steps: [{ now: 20 }, { now: 20 }, { now: 20 }],
    })
    expect((await call(fleet, "/time/step-next", { services: ["fixture"] })).status).toBe(400)
  } finally {
    await fleet.close()
  }
})

test("privileged traces cannot turn a control-only scoped credential into a snapshot reader (#392, #422)", async () => {
  const fleet = await start({ trace: true }, { ...config, adminKey: "synthetic-admin-only" })
  const root = { "x-mockingbird-admin-key": "synthetic-admin-only" }
  try {
    await call(fleet, "/namespaces/alpha", {}, "POST", root)
    const token = await (
      await call(
        fleet,
        "/credentials",
        { namespaces: ["alpha"], actions: ["control", "read"], ttlMs: 10000 },
        "POST",
        root,
      )
    ).json()
    const scoped = { "x-mockingbird-admin-key": token.credential }
    expect((await call(fleet, "/trace/start?namespace=alpha", {}, "POST", scoped)).status).toBe(403)
    expect((await call(fleet, "/trace?namespace=alpha", undefined, "GET", scoped)).status).toBe(403)
    expect((await call(fleet, "/trace/start?namespace=alpha", {}, "POST", root)).status).toBe(200)
    expect((await call(fleet, "/trace/stop?namespace=alpha", {}, "POST", root)).status).toBe(200)
  } finally {
    await fleet.close()
  }
})

test("environment-wide operations preserve one correlation id through every namespace's workload hooks (#411)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-correlation-")),
    prepared: { namespace: string; operationId: string }[] = []
  const fleet = await start(
    {
      repository: filesystemRepository(directory),
      workload: {
        prepare: async ({ namespace, operationId }) => {
          prepared.push({ namespace, operationId })
        },
      },
    },
    { services: { fixture: { port: 0 } } },
  )
  try {
    await call(fleet, "/namespaces/alpha", {})
    prepared.length = 0
    const result = await call(fleet, "/backups", { allNamespaces: true })
    expect(result.status).toBe(200)
    expect(prepared.map((entry) => entry.namespace).sort()).toEqual(["alpha", "default"])
    const operationId = result.headers.get("x-mockingbird-operation-id")
    if (!operationId) throw new Error("operation response omitted its correlation id")
    expect([...new Set(prepared.map((entry) => entry.operationId))]).toEqual([operationId])
  } finally {
    await fleet.close()
    await rm(directory, { recursive: true, force: true })
  }
})
