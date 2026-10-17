import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const run = async (args: string[], cwd: string) => {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code) throw new Error(`${args[0]} failed (${code}): ${err.slice(-2000)}`)
  return out
}

test("packed neutral package boots Postgres/Redis/Cognito outside monorepo without Stripe or private workspaces (#453)", async () => {
  const work = await mkdtemp(join(tmpdir(), "mockingbird-neutral-consumer-"))
  try {
    const tarballs: string[] = []
    let sqliteTarball = ""
    for (const name of ["sqlite", "postgres", "redis", "cognito", "fleet"]) {
      const source =
        name === "fleet" ? import.meta.dir : resolve(import.meta.dir, "../../service", name)
      const stage = join(work, "pack", name)
      await mkdir(stage, { recursive: true })
      await cp(join(source, "dist"), join(stage, "dist"), { recursive: true })
      await cp(join(source, "README.md"), join(stage, "README.md"))
      const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
      // Same manifest pinning as release:publish, with the packed local SQLite artifact.
      manifest.version = "0.0.0-smoke"
      if (manifest.dependencies?.["@crvouga/mockingbird-service-sqlite"])
        manifest.dependencies["@crvouga/mockingbird-service-sqlite"] = `file:${sqliteTarball}`
      await writeFile(join(stage, "package.json"), JSON.stringify(manifest))
      const packed = JSON.parse(
        await run(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", work], stage),
      ) as { filename: string }[]
      const tarball = join(work, packed[0]?.filename ?? "missing")
      tarballs.push(tarball)
      if (name === "sqlite") sqliteTarball = tarball
    }
    const app = join(work, "app")
    await mkdir(app)
    await writeFile(join(app, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], app)
    await writeFile(
      join(app, "smoke.mjs"),
      `
      import { existsSync } from 'node:fs';
      import { createInstalledServiceLoader, FleetClient, startFleet } from '@crvouga/mockingbird-fleet';
      for (const name of ['mockingbird-service-stripe', 'mockingbird-adapter-node', 'mockingbird-core'])
        if (existsSync('node_modules/@crvouga/' + name)) throw new Error('unexpected private/billing dependency');
      const config = { services: { database: { target:'postgres', port:0 }, cache: { target:'redis', port:0 }, identity: { target:'cognito', port:0 } } };
      const fleet = await startFleet(config, { load: createInstalledServiceLoader({ projectRoot: process.cwd(), services:['postgres','redis','cognito'] }) });
      try {
        const client = new FleetClient(fleet.manifest.adminBase);
        await client.createNamespace('synthetic');
        const discovery = await client.discover();
        if (Object.keys(discovery.manifest.services).sort().join(',') !== 'cache,database,identity') throw new Error('instance discovery mismatch');
        const archive = await client.exportArchive('synthetic');
        await client.importArchive(archive, 'synthetic');
        console.log('neutral consumer passed');
      } finally { await fleet.close(); }
    `,
    )
    expect(await run(["node", "smoke.mjs"], app)).toContain("neutral consumer passed")
    const help = await run(
      ["node", join(app, "node_modules/@crvouga/mockingbird-fleet/dist/cli.js"), "--help"],
      work,
    )
    expect(help).toContain("mockingbird-fleet")
    expect(help).toContain("fleet doctor")
    await writeFile(
      join(app, "mockingbird.json"),
      JSON.stringify({ services: { cache: { target: "redis", port: 0 } } }),
    )
    const report = JSON.parse(
      await run(
        [
          "node",
          join(app, "node_modules/@crvouga/mockingbird-fleet/dist/cli.js"),
          "fleet",
          "doctor",
          "--config",
          "mockingbird.json",
          "--json",
        ],
        app,
      ),
    )
    expect(report.ok).toBe(true)
    const serve = Bun.spawn(
      [
        "node",
        join(app, "node_modules/@crvouga/mockingbird-fleet/dist/cli.js"),
        "serve",
        "--config",
        join(app, "mockingbird.json"),
        "--project-root",
        app,
        "--ready-json",
      ],
      { cwd: work, stdout: "pipe", stderr: "pipe" },
    )
    const reader = serve.stdout.getReader()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("neutral CLI readiness timeout")), 10000)
        }),
      ])
      if (next.done) throw new Error("neutral CLI exited before readiness")
      const manifest = JSON.parse(new TextDecoder().decode(next.value).trim()) as {
        healthUrl: string
      }
      expect((await fetch(manifest.healthUrl)).ok).toBe(true)
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
      serve.kill("SIGTERM")
      expect(await serve.exited).toBe(0)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}, 120000)
