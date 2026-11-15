import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { sealArchive, validateArchive } from "@crvouga/mockingbird-core"
import { Database, Snapshot } from "@crvouga/mockingbird-service-postgres"
import { createRedis } from "@crvouga/mockingbird-service-redis"
import { createRuntime } from "@crvouga/mockingbird-service-twilio"
import { createMultiRuntime } from "../../service/oauth/src/multi.js"
import { canonical } from "../node/src/fleet-archive.js"
import {
  createFleet,
  mountedParticipant,
  postgresParticipant,
  redisParticipant,
} from "./src/in-process.js"

const config = () => ({
  services: {
    postgres: {
      version: "test",
      protocol: "postgres" as const,
      create: () => postgresParticipant({ create: () => new Database(), decode: Snapshot.decode }),
    },
    redis: {
      version: "test",
      protocol: "redis" as const,
      create: () => redisParticipant(() => createRedis()),
    },
    twilio: { version: "test", create: () => createRuntime() },
  },
})

test("native PostgreSQL and Redis join the same capture and fresh-runtime restore", async () => {
  const fleet = createFleet(config())
  await fleet.run("postgres", (runtime) =>
    runtime.value().exec("CREATE TABLE fixture (value integer); INSERT INTO fixture VALUES (7)"),
  )
  await fleet.run("redis", async (runtime) => {
    await runtime.value().client().call("SET", "fixture", "seven")
  })
  const archive = await fleet.export()
  const restored = createFleet(config())
  await restored.import(JSON.parse(JSON.stringify(archive)))
  expect(
    await restored.run("postgres", (runtime) =>
      runtime.value().prepare("SELECT value FROM fixture").all(),
    ),
  ).toEqual([{ value: 7 }])
  expect(
    await restored.run("redis", (runtime) => runtime.value().client().call("GET", "fixture")),
  ).toBe("seven")
  expect(restored.status().twilio?.status).toBe("idle")
  await fleet.dispose()
  await restored.dispose()
})

test("portable fleet envelope uses exactly the Node canonical hash and rejects corruption/version drift", async () => {
  const fleet = createFleet({
    services: {
      twilio: {
        version: "test",
        create: () => createRuntime({ adminControls: { clock: { frozen: true, now: 1000 } } }),
      },
    },
  })
  await fleet.run("twilio", (runtime) => runtime.instance())
  const archive = await fleet.exportArchive()
  const { sha256, ...content } = archive
  expect(sha256).toBe(createHash("sha256").update(canonical(content)).digest("hex"))
  expect(validateArchive(archive)).toEqual(archive)
  const restored = createFleet({
    services: { twilio: { version: "test", create: () => createRuntime() } },
  })
  await restored.import(archive)
  expect((await restored.export()).services).toEqual((await fleet.export()).services)
  await expect(restored.import({ ...archive, sha256: "wrong" })).rejects.toThrow("corrupt")
  const changed = structuredClone(content)
  const changedService = changed.namespaces.default?.services.twilio
  if (!changedService) throw new Error("missing saved service")
  changedService.packageVersion = "other"
  await expect(restored.import(sealArchive(changed))).rejects.toThrow("twilio")
})

test("wait-until-idle returns busy for an open stream and idle after cancellation", async () => {
  const base = createRuntime()
  const fleet = createFleet({
    services: {
      twilio: {
        version: "test",
        create: () => ({ ...base, fetch: async () => new Response(new ReadableStream()) }),
      },
    },
  })
  const response = await fleet.fetch("twilio", new Request("http://mock/stream"))
  const idle = () =>
    fleet.control(new Request("http://mock/__admin/fleet/wait-until-idle", { method: "POST" }))
  expect((await idle()).status).toBe(409)
  await response.body?.cancel()
  expect((await idle()).status).toBe(200)
})

test("dashboard reuses aggregate admin gateway and notifications on the same fleet", async () => {
  const fleet = createFleet({
    services: { twilio: { version: "test", create: () => createRuntime() } },
  })
  const dashboard = await fleet.dashboard()
  const page = await dashboard.fetch(new Request("http://mock/"))
  expect(await page.text()).toContain('data-default-tab="emulators"')
  const admin = await dashboard.fetch(new Request("http://mock/api/admin"))
  expect((await admin.json()).emulators).toEqual([expect.objectContaining({ name: "twilio" })])
  const health = await dashboard.fetch(new Request("http://mock/admin/apis/twilio/health"))
  expect(health.status).toBe(200)
  await health.text()
  expect(await dashboard.list()).toEqual([])
  await fleet.dispose()
})

test("mounted OAuth providers round-trip their independent namespace state together", async () => {
  const options = {
    services: {
      oauth: {
        version: "test",
        create: () =>
          mountedParticipant(
            createMultiRuntime({
              adminControls: { clock: { frozen: true, now: 1000 } },
              mounts: [
                { path: "/google", provider: "google" },
                { path: "/apple", provider: "apple" },
              ],
            }),
          ),
      },
    },
  }
  const fleet = createFleet(options)
  await fleet.run("oauth", (runtime) => {
    const google = runtime.value().mounted.mounts.get("/google")
    if (!google) throw new Error("missing mount")
    return google
      .fetch(
        new Request("http://mock/__admin/state/fixture", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "row", value: { value: 7 } }),
        }),
      )
      .then((response) => response.text())
  })
  const archive = await fleet.export()
  const restored = createFleet(options)
  await restored.import(archive)
  expect((await restored.export()).services).toEqual(archive.services)
  const bad = structuredClone(archive)
  const saved = bad.services.oauth?.state?.default as { mounts: Record<string, unknown> }
  delete saved.mounts["/apple"]
  await expect(restored.import(bad)).rejects.toThrow("mounted runtime compatibility mismatch")
  expect((await restored.export()).services).toEqual(archive.services)
})

test("fleet clock controls move native database time and Redis TTL time together", async () => {
  const fleet = createFleet(config())
  const response = await fleet.control(
    new Request("http://fleet/__admin/fleet/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ services: ["postgres", "redis"], set: 2000000000000, freeze: true }),
    }),
  )
  expect(response.status).toBe(200)
  const now = await fleet.run(
    "postgres",
    (runtime) => runtime.value().query("SELECT now() AS now")[0]?.now,
  )
  expect(new Date(String(now)).getTime()).toBe(2000000000000)
  expect(await fleet.run("redis", (runtime) => runtime.value().clock.now())).toBe(2000000000000)
  const archive = await fleet.export()
  const restored = createFleet(config())
  await restored.import(archive)
  expect(await restored.run("redis", (runtime) => runtime.value().clock.now())).toBe(2000000000000)
  await fleet.dispose()
  await restored.dispose()
})
