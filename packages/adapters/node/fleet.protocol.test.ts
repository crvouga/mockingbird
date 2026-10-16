import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redis } from "ioredis"
import { Client } from "pg"
import { type Fleet, type ProtocolTarget, startFleet } from "./src/fleet.js"

const config = {
  services: {
    postgres: {
      protocol: "postgres" as const,
      port: 0,
      namespaces: { "worker-7": "fixture", other: "other" },
    },
    redis: { protocol: "redis" as const, port: 0, namespaces: { "worker-7": 0, other: 0 } },
  },
}
const start = () =>
  startFleet(config, {
    async load(name) {
      // Load source at runtime without checking each service under the adapter's tsconfig.
      const path = `../../service/${name}/src/server.ts`
      const module = (await import(path)) as { serveTarget: ProtocolTarget }
      return module.serveTarget
    },
  })

test("private protocol credentials are absent from readiness and aggregate health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockingbird-credentials-"))
  const connectionsFile = join(dir, "private.json")
  const readyFile = join(dir, "ready.json")
  const emitted: unknown[] = []
  const fleet = await startFleet(
    {
      adminKey: "fixture-admin-only",
      services: {
        postgres: { protocol: "postgres", port: 0, password: "fixture-postgres-only" },
        redis: { protocol: "redis", port: 0, password: "fixture-redis-only" },
      },
    },
    {
      async load(name) {
        const path = `../../service/${name}/src/server.ts`
        return ((await import(path)) as { serveTarget: ProtocolTarget }).serveTarget
      },
      readyFile,
      connectionsFile,
      onReady: (record) => emitted.push(record),
    },
  )
  try {
    const publicText =
      JSON.stringify(emitted) +
      (await readFile(readyFile, "utf8")) +
      (await (await fetch(fleet.manifest.healthUrl)).text())
    expect(publicText).not.toContain("fixture-admin-only")
    expect(publicText).not.toContain("fixture-postgres-only")
    expect(publicText).not.toContain("fixture-redis-only")
    expect((await stat(connectionsFile)).mode & 0o777).toBe(0o600)
    const privateText = await readFile(connectionsFile, "utf8")
    expect(privateText).toContain("fixture-postgres-only")
    expect(privateText).toContain("fixture-redis-only")
    const privateData = JSON.parse(privateText) as { services: Record<string, { url: string }> }
    expect(
      (await sql(privateData.services.postgres?.url as string, "SELECT 7 AS value")).rows,
    ).toEqual([{ value: 7 }])
    expect(await kv(privateData.services.redis?.url as string, (client) => client.ping())).toBe(
      "PONG",
    )
    expect((await control(fleet, "namespaces/default/reset")).status).toBe(401)
  } finally {
    await fleet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("Postgres fleet snapshots restore created and dropped databases, reset clears the catalog", async () => {
  const fleet = await start()
  const base = endpoint(fleet, "postgres", "worker-7")
  const databaseUrl = new URL(base)
  databaseUrl.pathname = "/extra"
  try {
    await sql(base, "CREATE DATABASE extra")
    await sql(databaseUrl.href, "CREATE TABLE things (value int); INSERT INTO things VALUES (7)")
    const snapshot = await control(fleet, "namespaces/worker-7/snapshots")
    expect(snapshot.status).toBe(201)
    const point = (await snapshot.json()) as { id: string }
    await sql(base, "DROP DATABASE extra")
    await sql(base, "CREATE DATABASE later")
    expect((await control(fleet, `namespaces/worker-7/snapshots/${point.id}/restore`)).ok).toBe(
      true,
    )
    expect((await sql(databaseUrl.href, "SELECT * FROM things")).rows).toEqual([{ value: 7 }])
    expect(
      (await sql(base, "SELECT datname FROM pg_database ORDER BY datname")).rows.map(
        (row) => row.datname,
      ),
    ).toEqual(["extra", "fixture"])
    expect((await control(fleet, "namespaces/worker-7/reset")).ok).toBe(true)
    expect(
      (await sql(base, "SELECT datname FROM pg_database ORDER BY datname")).rows.map(
        (row) => row.datname,
      ),
    ).toEqual(["fixture"])
  } finally {
    await fleet.close()
  }
})
const endpoint = (fleet: Fleet, service: string, ns = "default"): string => {
  const value = fleet.manifest.services[service]
  if (!value) throw new Error(`missing service ${service}`)
  return (value.namespaces.endpoints as Record<string, string>)[ns] as string
}
const control = (fleet: Fleet, path: string, body: unknown = {}) =>
  fleet.fetch(
    new Request(`http://fleet/__admin/fleet/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  )
async function sql(url: string, statements: string) {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await client.query(statements)
  } finally {
    await client.end()
  }
}
async function kv(url: string, run: (client: Redis) => Promise<unknown>) {
  const client = new Redis(url, { retryStrategy: () => null })
  try {
    return await run(client)
  } finally {
    await client.quit()
  }
}

test("Postgres and Redis bind actual protocol endpoints and close all connections", async () => {
  const fleet = await start()
  const pg = new Client({ connectionString: endpoint(fleet, "postgres") })
  const resp = new Redis(endpoint(fleet, "redis"), { retryStrategy: () => null })
  const pgErrors: Error[] = []
  pg.on("error", (error) => pgErrors.push(error))
  resp.on("error", () => {})
  const pgClosed = new Promise<void>((resolve) => pg.once("end", resolve))
  try {
    await pg.connect()
    expect((await pg.query("SELECT 7 AS value")).rows).toEqual([{ value: 7 }])
    expect(await resp.ping()).toBe("PONG")
    expect((await fetch(fleet.manifest.healthUrl)).ok).toBe(true)
    const blocked = resp.blpop("empty", 0).then(
      () => false,
      () => true,
    )

    await fleet.close()
    expect(await blocked).toBe(true)
    await pgClosed
    expect(pgErrors.map((error) => error.message)).toEqual(["Connection terminated unexpectedly"])
    expect(
      await fetch(fleet.manifest.healthUrl).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
  } finally {
    await fleet.close()
    resp.disconnect()
    await pg.end()
  }
})

test("protocol namespace snapshot/reset/restore and clocks leave the other namespace untouched", async () => {
  const fleet = await start()
  const pg = endpoint(fleet, "postgres", "worker-7")
  const resp = endpoint(fleet, "redis", "worker-7")
  try {
    await sql(pg, "CREATE TABLE things (value int); INSERT INTO things VALUES (7)")
    await sql(
      endpoint(fleet, "postgres", "other"),
      "CREATE TABLE things (value int); INSERT INTO things VALUES (9)",
    )
    await kv(resp, (client) => client.set("fixture", "seven", "PX", 1000))
    await kv(endpoint(fleet, "redis", "other"), (client) => client.set("fixture", "nine"))
    const frozen = await control(fleet, "clock?namespace=worker-7", {
      set: Date.now(),
      freeze: true,
    })
    expect(frozen.ok).toBe(true)
    const snapshotResponse = await control(fleet, "namespaces/worker-7/snapshots")
    expect(snapshotResponse.status).toBe(201)
    const point = (await snapshotResponse.json()) as { id: string }
    await sql(pg, "INSERT INTO things VALUES (8)")
    await control(fleet, "clock?namespace=worker-7", { advance: "1h" })
    expect(await kv(resp, (client) => client.get("fixture"))).toBeNull()
    expect((await control(fleet, `namespaces/worker-7/snapshots/${point.id}/restore`)).ok).toBe(
      true,
    )
    expect((await sql(pg, "SELECT * FROM things")).rows).toEqual([{ value: 7 }])
    expect(await kv(resp, (client) => client.get("fixture"))).toBe("seven")
    expect((await control(fleet, "namespaces/worker-7/reset")).ok).toBe(true)
    expect(await kv(resp, (client) => client.get("fixture"))).toBeNull()
    expect(
      (
        await sql(
          pg,
          "SELECT count(*) AS count FROM information_schema.tables WHERE table_name = 'things'",
        )
      ).rows[0]?.count,
    ).toBe("0")
    expect((await sql(endpoint(fleet, "postgres", "other"), "SELECT * FROM things")).rows).toEqual([
      { value: 9 },
    ])
    expect(await kv(endpoint(fleet, "redis", "other"), (client) => client.get("fixture"))).toBe(
      "nine",
    )
  } finally {
    await fleet.close()
  }
})

test("protocol controls report precise conflicts for live Postgres sessions and blocked Redis clients", async () => {
  const fleet = await start()
  const pg = new Client({ connectionString: endpoint(fleet, "postgres") })
  const resp = new Redis(endpoint(fleet, "redis"), { retryStrategy: () => null })
  try {
    await pg.connect()
    const blocked = resp.blpop("empty", 0).then(
      () => false,
      () => true,
    )
    // A second connection proves that the blocking command has reached the server.
    await kv(endpoint(fleet, "redis"), (client) => client.ping())
    const response = await control(fleet, "namespaces/default/reset")
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      services: {
        postgres: { activeConnections: 1 },
        redis: { blockedCommands: 1 },
      },
    })

    resp.disconnect()
    expect(await blocked).toBe(true)
    await pg.end()
    expect((await control(fleet, "namespaces/default/reset")).ok).toBe(true)
  } finally {
    resp.disconnect()
    await pg.end()
    await fleet.close()
  }
})

test("Postgres archive restores materialized indexes and deferred triggers in a fresh fleet (#431, #432)", async () => {
  const first = await start()
  const second = await start()
  try {
    const original = endpoint(first, "postgres", "worker-7")
    await sql(original, "CREATE TABLE entries(id int); INSERT INTO entries VALUES (1)")
    await sql(
      original,
      "CREATE MATERIALIZED VIEW saved_rows AS SELECT id FROM entries WITH NO DATA; CREATE UNIQUE INDEX saved_unique ON saved_rows(id)",
    )
    await sql(
      original,
      "CREATE FUNCTION check_entries() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM entries WHERE id < 0) THEN RAISE EXCEPTION 'invalid entries'; END IF; RETURN NEW; END $$",
    )
    await sql(
      original,
      "CREATE CONSTRAINT TRIGGER validate_entry AFTER INSERT OR UPDATE OR DELETE ON entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entries()",
    )
    const exported = await control(first, "archives/export", { allNamespaces: true })
    expect(exported.status).toBe(200)
    const archive = await exported.json()
    expect((await control(second, "archives/import", { archive })).status).toBe(200)
    const restored = endpoint(second, "postgres", "worker-7")
    await sql(restored, "REFRESH MATERIALIZED VIEW saved_rows")
    expect((await sql(restored, "SELECT * FROM saved_rows")).rows).toEqual([{ id: 1 }])
    expect(
      (await sql(restored, "SELECT indexname FROM pg_indexes WHERE tablename = 'saved_rows'")).rows,
    ).toEqual([{ indexname: "saved_unique" }])
    await sql(
      restored,
      "BEGIN; INSERT INTO entries VALUES (-1); UPDATE entries SET id = 2 WHERE id = -1; COMMIT",
    )
    await expect(
      sql(restored, "BEGIN; INSERT INTO entries VALUES (-2); COMMIT"),
    ).rejects.toMatchObject({ code: "P0001" })
    expect((await sql(restored, "SELECT * FROM entries ORDER BY id")).rows).toEqual([
      { id: 1 },
      { id: 2 },
    ])
    expect(
      (
        await sql(
          endpoint(second, "postgres", "other"),
          "SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'saved_unique'",
        )
      ).rows,
    ).toEqual([{ n: "0" }])
    expect((await sql(original, "SELECT * FROM entries")).rows).toEqual([{ id: 1 }])
  } finally {
    await first.close()
    await second.close()
  }
})
