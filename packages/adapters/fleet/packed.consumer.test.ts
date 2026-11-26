import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
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
  if (code) throw new Error(`${args[0]} failed (${code}): ${(err || out).slice(-2000)}`)
  return out
}

test("packed fleet composes an external TypeScript service with Postgres, Redis and Cognito", async () => {
  const work = await mkdtemp(join(tmpdir(), "mockingbird-neutral-consumer-"))
  try {
    const tarballs = new Map<string, string>()
    for (const name of [
      "sqlite",
      "ui",
      "preview",
      "runtime",
      "postgres",
      "redis",
      "cognito",
      "notifications",
      "fleet",
    ]) {
      const source =
        name === "fleet"
          ? import.meta.dir
          : name === "preview"
            ? resolve(import.meta.dir, "../preview")
            : ["notifications", "runtime", "ui"].includes(name)
              ? resolve(import.meta.dir, "../..", name)
              : resolve(import.meta.dir, "../../service", name)
      const stage = join(work, "pack", name)
      await mkdir(stage, { recursive: true })
      const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
      for (const file of manifest.files) {
        if (existsSync(join(source, file))) {
          await mkdir(resolve(stage, file, ".."), { recursive: true })
          await cp(join(source, file), join(stage, file), { recursive: true })
        }
      }
      manifest.version = "0.0.0-smoke"
      for (const [dependency, tarball] of tarballs) {
        if (manifest.dependencies?.[dependency])
          manifest.dependencies[dependency] = `file:${tarball}`
      }
      await writeFile(join(stage, "package.json"), JSON.stringify(manifest))
      const packed = JSON.parse(
        await run(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", work], stage),
      ) as { filename: string }[]
      const tarball = join(work, packed[0]?.filename ?? "missing")
      tarballs.set(manifest.name, tarball)
    }
    const app = join(work, "app")
    await mkdir(app)
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        imports: { "#mockingbird/jobs/server": "./jobs.js" },
      }),
    )
    await run(
      ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs.values()],
      app,
    )
    await cp(resolve(import.meta.dir, "../../runtime/examples/jobs.ts"), join(app, "jobs.ts"))
    await writeFile(
      join(app, "local.ts"),
      `
      import { createFleet } from '@crvouga/mockingbird-fleet/in-process';
      import { createRuntime, serveTarget } from './jobs.js';
      import { createRuntime as cognito } from '@crvouga/mockingbird-service-cognito';
      const local = createFleet({ services: {
        jobs: { version: serveTarget.packageVersion, create: () => createRuntime() },
        identity: { version: 'fixture', create: () => cognito() },
      } });
      try {
        const write = await local.fetch('jobs', new Request('https://jobs.example/jobs', {method: 'POST'}));
        if (write.status !== 201) throw new Error('in-process custom write failed');
        await write.text();
        const read = await local.fetch('identity', new Request('https://identity.example/__admin/health'));
        if (!read.ok) throw new Error('in-process built-in health failed');
        await read.text();
      } finally { await local.dispose(); }
    `,
    )
    await run(
      [
        resolve(import.meta.dir, "../../../node_modules/.bin/tsc"),
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        "--declaration",
        "jobs.ts",
        "local.ts",
      ],
      app,
    )
    await run(["node", "local.js"], app)
    await writeFile(
      join(app, "smoke.mjs"),
      `
      import { existsSync } from 'node:fs';
      import { createInstalledServiceLoader, FleetClient, startFleet } from '@crvouga/mockingbird-fleet';
      for (const name of ['mockingbird-service-stripe', 'mockingbird-adapter-node', 'mockingbird-core'])
        if (existsSync('node_modules/@crvouga/' + name)) throw new Error('unexpected private/billing dependency');
      const config = { services: { database: { target:'postgres', port:0 }, cache: { target:'redis', port:0 }, identity: { target:'cognito', port:0 }, queue: { target:'jobs', port:0 } } };
      const fleet = await startFleet(config, { load: createInstalledServiceLoader({ projectRoot: process.cwd(), services:['postgres','redis','cognito','jobs'] }) });
      try {
        const client = new FleetClient(fleet.manifest.adminBase);
        await client.createNamespace('synthetic');
        const discovery = await client.discover();
        if (Object.keys(discovery.manifest.services).sort().join(',') !== 'cache,database,identity,queue') throw new Error('instance discovery mismatch');
        const url = fleet.manifest.services.queue.url + '/jobs';
        const headers = { 'x-mockingbird-namespace': 'synthetic' };
        const enqueue = () => fetch(url, { method: 'POST', headers });
        if ((await enqueue()).status !== 201) throw new Error('custom POST failed');
        const archive = await client.exportArchive('synthetic');
        if ((await enqueue()).status !== 201) throw new Error('second POST failed');
        await client.importArchive(archive, 'synthetic');
        if ((await (await fetch(url, { headers })).json()).count !== 1) throw new Error('custom archive restore failed');
        if ((await (await fetch(url)).json()).count !== 0) throw new Error('custom namespace isolation failed');
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
      JSON.stringify({
        dashboard: { port: 0 },
        services: {
          cache: { target: "redis", port: 0 },
          identity: { target: "cognito", port: 0 },
          queue: { target: "jobs", port: 0 },
        },
      }),
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
        dashboard: string
      }
      expect((await fetch(manifest.healthUrl)).ok).toBe(true)
      // The dashboard runs from the installed packages alone, and fronts the fleet's emulators.
      const dashboard = manifest.dashboard.replace(/\/+$/, "")
      expect((await fetch(`${dashboard}/`)).ok).toBe(true)
      expect((await fetch(`${dashboard}/admin/apis/identity/health`)).ok).toBe(true)
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
