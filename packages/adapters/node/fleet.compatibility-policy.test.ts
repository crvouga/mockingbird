import { expect, test } from "bun:test"
import { Collection, createRuntime } from "@crvouga/mockingbird-service"
import type { ServeTarget } from "./src/cli.js"
import { startFleet } from "./src/fleet.js"
import {
  assertArchiveCompatibility,
  migrateApplicationArchive,
  sealArchive,
  validateArchive,
} from "./src/fleet-archive.js"
import { FleetClient } from "./src/fleet-client.js"
import { archiveCompatibility, migrateArchive } from "./src/fleet-migrations.js"
import { rehearseFleet } from "./src/fleet-tools.js"

const fixture: ServeTarget = {
  name: "fixture",
  defaultPort: 0,
  create() {
    return createRuntime({
      name: "fixture",
      create(ctx) {
        const rows = new Collection<{ value: string }>(ctx.sqlite, ctx.namespace, "rows")
        return {
          reset: async () => {
            for (const row of rows.list()) rows.delete(row.id)
          },
          fetch: async (request) => {
            if (request.method === "POST") rows.insert("row", { value: await request.text() })
            return Response.json(rows.list().map((row) => row.value))
          },
        }
      },
    })
  },
}
const config = { services: { fixture: { port: 0 } } }
const load = async () => fixture

test("application tags survive codec migration and require explicit immutable application migration (#458)", async () => {
  const archive = sealArchive({
    format: "mockingbird.fleet/v1",
    createdAt: new Date(0).toISOString(),
    sourceId: "fixture",
    compatibility: { schema: "one" },
    namespaces: {
      alpha: {
        clock: { now: 0, frozen: true },
        services: { fixture: { protocol: "http", version: 1, state: {} } },
      },
    },
  })
  const before = JSON.stringify(archive)
  expect(assertArchiveCompatibility(archive, { tags: { schema: "one" } })).toBe(archive)
  expect(() => assertArchiveCompatibility(archive, { tags: { schema: "two" } })).toThrow(
    "compatibility mismatch",
  )
  expect(() => validateArchive({ ...archive, compatibility: { schema: "forged" } })).toThrow(
    "corrupt",
  )
  const { sha256: _sha, compatibility: _tags, ...legacyContent } = archive
  const legacy = sealArchive(legacyContent)
  expect(() => assertArchiveCompatibility(legacy, { tags: { schema: "one" } })).toThrow(
    "compatibility mismatch",
  )
  expect(assertArchiveCompatibility(legacy, { tags: { schema: "one" }, missing: "allow" })).toBe(
    legacy,
  )
  const codecs = { sourceFormats: [], transformations: [] }
  expect(archiveCompatibility(archive, codecs).compatible).toBe(true)
  expect(archiveCompatibility(archive, codecs, { tags: { schema: "two" } }).compatible).toBe(false)
  expect((await migrateArchive(archive, codecs)).compatibility).toEqual({ schema: "one" })
  const migrated = await migrateApplicationArchive(archive, {
    from: { tags: { schema: "one" } },
    to: { schema: "two" },
    transform: (copy) => {
      const section = copy.namespaces.alpha?.services.fixture
      if (section) section.state = { migrated: true }
      return copy
    },
  })
  expect(migrated.namespaces.alpha?.services.fixture?.state).toEqual({ migrated: true })
  expect(migrated.compatibility).toEqual({ schema: "two" })
  expect(migrated.sha256).not.toBe(archive.sha256)
  expect(JSON.stringify(archive)).toBe(before)
  expect(() =>
    validateArchive(sealArchive({ ...legacyContent, compatibility: { schema: "x".repeat(257) } })),
  ).toThrow("compatibility tags")
})

test("whole-environment/namespace imports and rehearsal reject application mismatch before state mutation (#458)", async () => {
  const source = await startFleet(config, { load, archiveCompatibility: { tags: { seed: "one" } } })
  const target = await startFleet(config, { load, archiveCompatibility: { tags: { seed: "two" } } })
  try {
    await fetch(`${source.children.get("fixture")?.url}/rows`, { method: "POST", body: "source" })
    await fetch(`${target.children.get("fixture")?.url}/rows`, { method: "POST", body: "target" })
    const sourceClient = new FleetClient(source.manifest.adminBase)
    const targetClient = new FleetClient(target.manifest.adminBase)
    const archive = await sourceClient.exportArchive()
    expect(archive.compatibility).toEqual({ seed: "one" })
    for (const namespace of [undefined, "default"]) {
      await expect(targetClient.importArchive(archive, namespace)).rejects.toMatchObject({
        status: 400,
      })
      expect(await (await fetch(`${target.children.get("fixture")?.url}/rows`)).json()).toEqual([
        { value: "target" },
      ])
    }
    await expect(
      rehearseFleet(config, { load, archiveCompatibility: { tags: { seed: "two" } } }, archive),
    ).rejects.toThrow("compatibility mismatch")
    const approved = await migrateApplicationArchive(archive, {
      from: { tags: { seed: "one" } },
      to: { seed: "two" },
      transform: (copy) => copy,
    })
    await targetClient.importArchive(approved)
    expect(await (await fetch(`${target.children.get("fixture")?.url}/rows`)).json()).toEqual([
      { value: "source" },
    ])
  } finally {
    await target.close()
    await source.close()
  }
})

test("repository journal recovery checks application tags before resuming the application (#458)", async () => {
  const source = await startFleet(config, {
    load,
    archiveCompatibility: { tags: { schema: "old" } },
  })
  let archive: Awaited<ReturnType<FleetClient["exportArchive"]>>
  try {
    archive = await new FleetClient(source.manifest.adminBase).exportArchive()
  } finally {
    await source.close()
  }
  let resumed = false,
    resolved = false
  await expect(
    startFleet(config, {
      load,
      archiveCompatibility: { tags: { schema: "new" } },
      initialize: async () => {
        resumed = true
      },
      repository: {
        get: async () => archive,
        put: async () => archive.sha256,
        list: async () => [archive.sha256],
        delete: async () => {},
        latest: async () => archive.sha256,
        publishLatest: async () => {},
        publicationMetadata: async () => ({
          id: archive.sha256,
          generation: 1,
          verifiedAt: archive.createdAt,
        }),
      },
      journal: {
        load: async () => [
          {
            version: 1,
            revision: 1,
            operationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            controller: "previous",
            namespace: "default",
            scope: ["default"],
            action: "restore",
            phase: "publishing",
            timestamp: archive.createdAt,
            requestFingerprint: "fixture",
            after: archive.sha256,
            writerGeneration: 1,
          },
        ],
        write: async () => {
          resolved = true
        },
      },
    }),
  ).rejects.toThrow("compatibility mismatch")
  expect(resumed).toBe(false)
  expect(resolved).toBe(false)
})
