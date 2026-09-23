/**
 * Consumer smoke test: install every public package the way a downstream project would.
 *
 * Packs each public package exactly like `release:publish` (`bun pm pack`, workspace deps
 * pinned to one shared version), `npm install`s all tarballs into a fresh project outside
 * the monorepo, then:
 *   1. imports every `exports` subpath under Node (ESM),
 *   2. typechecks an import of every subpath with `moduleResolution: nodenext`,
 *   3. typechecks every ```ts example in every shipped README.md (the docs agents copy from),
 *   4. runs every `bin` with `--help`,
 *   5. boots every service that ships `./server` from one `mockingbird.json` through a
 *      single service's CLI (`serve --config`), and probes each one's `/health`.
 * Catches what per-package checks cannot: a published package depending on an unpublished
 * one, a runtime import missing from `dependencies`, a private helper left out of a
 * service bundle, files left out of the tarball.
 *
 *   bun run build && bun run release:smoke
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { discoverPackages, packedManifest, pinManifest, unresolvablePins } from "./lib.ts"

const SMOKE_VERSION = "0.0.0-smoke"
const keep = process.argv.includes("--keep")

// Hard limits. A check that cannot finish in time fails loudly; it never hangs a CI job.
const TOTAL_BUDGET_MS = 5 * 60_000
const SERVE_READY_MS = 45_000

/** Resolve after `ms`, for racing an unbounded wait. */
const after = (ms: number) =>
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))

const started = Date.now()
const watchdog = setTimeout(() => {
  console.error(
    `::error::consumer-smoke: exceeded its ${TOTAL_BUDGET_MS}ms budget — failing instead of hanging`,
  )
  process.exit(1)
}, TOTAL_BUDGET_MS)
watchdog.unref()

type Manifest = {
  name: string
  exports?: Record<string, unknown>
  version?: string
  bin?: string | Record<string, string>
}

const pkgs = discoverPackages().filter((p) => p.isPublic)
const work = mkdtempSync(join(tmpdir(), "mockingbird-consumer-"))
const tarballs = join(work, "tarballs")
const app = join(work, "app")
const originals = new Map<string, string>()
let exitCode = 0

try {
  const smokeVersions = new Map(pkgs.map((p) => [p.name, SMOKE_VERSION]))
  for (const pkg of pkgs) {
    const raw = readFileSync(pkg.manifestPath, "utf8")
    originals.set(pkg.manifestPath, raw)
    writeFileSync(pkg.manifestPath, pinManifest(raw, SMOKE_VERSION, smokeVersions))
  }

  const files: string[] = []
  for (const pkg of pkgs) {
    const packed = await $`bun pm pack --destination ${tarballs} --quiet`.cwd(pkg.dir).quiet()
    const tarball = packed.stdout.toString().trim().split("\n").pop()?.trim()
    if (!tarball) throw new Error(`bun pm pack produced no tarball for ${pkg.name}`)
    // The install below resolves every package name to a local tarball, which would
    // also satisfy a pin npm could never resolve (`workspace:*`, `0.0.0-development`).
    // So assert the packed manifest directly — this is what a consumer gets.
    const bad = unresolvablePins(await packedManifest(tarball))
    if (bad.length > 0) {
      throw new Error(
        `consumer-smoke: ${pkg.name} ships dependency pins no consumer could resolve:\n  ${bad.join("\n  ")}`,
      )
    }
    files.push(tarball)
  }

  // Restore before installing so a failure below never leaves pinned manifests behind.
  for (const [path, raw] of originals) writeFileSync(path, raw)
  originals.clear()

  const overrides = Object.fromEntries(
    pkgs.map((p, i) => [p.name, `file:${files[i] as string}`]),
  ) as Record<string, string>
  await $`mkdir -p ${app}`
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify(
      {
        name: "mockingbird-consumer-smoke",
        private: true,
        type: "module",
        dependencies: overrides,
        devDependencies: { typescript: "5.9.3", "@types/node": "22.20.1", "@types/bun": "1.4.0" },
        overrides,
      },
      null,
      2,
    ),
  )
  console.log(`consumer-smoke: npm install ${pkgs.length} tarballs into ${app}`)
  await $`npm install --no-audit --no-fund --loglevel=error`.cwd(app)

  const specifiers: string[] = []
  const bins: { pkg: string; bin: string }[] = []
  for (const pkg of pkgs) {
    const manifest = JSON.parse(
      readFileSync(join(app, "node_modules", pkg.name, "package.json"), "utf8"),
    ) as Manifest
    for (const subpath of Object.keys(manifest.exports ?? { ".": null })) {
      if (subpath.includes("*") || subpath === "./package.json") continue
      specifiers.push(subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`)
    }
    const binNames =
      typeof manifest.bin === "string"
        ? [pkg.name.split("/").pop() as string]
        : Object.keys(manifest.bin ?? {})
    for (const bin of binNames) bins.push({ pkg: pkg.name, bin })
  }

  const importAll = specifiers
    .map((s, i) => `import * as m${i} from ${JSON.stringify(s)}`)
    .join("\n")
  const touch = specifiers.map((_, i) => `m${i}`).join(", ")
  writeFileSync(
    join(app, "smoke.mjs"),
    `${importAll}\nconst mods = [${touch}]\nfor (const m of mods) if (Object.keys(m).length === 0) throw new Error("empty module")\nconsole.log("imported " + mods.length + " entry points")\n`,
  )
  writeFileSync(join(app, "smoke.ts"), `${importAll}\nexport const all = [${touch}]\n`)

  // Each README example becomes its own module, read from the installed tarball.
  mkdirSync(join(app, "examples"))
  let examples = 0
  for (const pkg of pkgs) {
    const readme = join(app, "node_modules", pkg.name, "README.md")
    if (!existsSync(readme)) continue
    const blocks = [
      ...readFileSync(readme, "utf8").matchAll(/^```(?:ts|typescript)\n([\s\S]*?)^```$/gm),
    ]
    blocks.forEach((block, i) => {
      const file = `${pkg.name.replace("@crvouga/", "")}.readme.${i + 1}.ts`
      writeFileSync(join(app, "examples", file), `${block[1]}\nexport {}\n`)
      examples++
    })
  }
  writeFileSync(
    join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node", "bun"],
        lib: ["ES2022", "DOM"],
      },
      include: ["smoke.ts", "examples/*.ts"],
    }),
  )

  console.log(`consumer-smoke: node import of ${specifiers.length} entry points`)
  await $`node smoke.mjs`.cwd(app)
  console.log(`consumer-smoke: tsc (nodenext) over entry points + ${examples} README examples`)
  // skipLibCheck is off so our shipped .d.ts are checked; third-party typings
  // (bun-types vs @types/node skew) are not ours to gate on.
  const tsc = await $`npx --no-install tsc -p tsconfig.json`.cwd(app).quiet().nothrow()
  const ours = tsc.stdout
    .toString()
    .split("\n")
    .filter((line) => /^(smoke\.ts|examples\/|node_modules\/@crvouga\/)/.test(line))
  if (ours.length > 0) {
    console.error(ours.join("\n"))
    throw new Error(
      `consumer-smoke: ${ours.length} type error(s) in published packages or their README examples (examples/<pkg>.readme.<n>.ts = nth \`\`\`ts block)`,
    )
  }
  for (const { pkg, bin } of bins) {
    console.log(`consumer-smoke: ${bin} --help (${pkg})`)
    await $`npx --no-install ${bin} --help`.cwd(app).quiet()
  }
  await serveConfigSmoke(
    app,
    pkgs.map((p) => p.name),
  )
  console.log(`consumer-smoke: OK (${pkgs.length} packages)`)
} catch (error) {
  console.error(
    `::error::consumer-smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  exitCode = 1
} finally {
  for (const [path, raw] of originals) writeFileSync(path, raw)
  if (keep) console.log(`consumer-smoke: kept ${work}`)
  else rmSync(work, { recursive: true, force: true })
}

clearTimeout(watchdog)
console.log(`consumer-smoke: finished in ${Math.round((Date.now() - started) / 1000)}s`)
// Exit explicitly: a socket or child left behind must not keep the process (and the CI
// step) alive after the work is done.
process.exit(exitCode)

/** `serve --config`: one CLI boots every installed service, each answering `/health`. */
async function serveConfigSmoke(app: string, names: string[]): Promise<void> {
  const manifests = new Map(
    names.map((name) => [
      name,
      JSON.parse(readFileSync(join(app, "node_modules", name, "package.json"), "utf8")) as Manifest,
    ]),
  )
  const servers = names.filter((name) => "./server" in (manifests.get(name)?.exports ?? {}))
  const services = servers.map((name) => name.replace("@crvouga/mockingbird-service-", ""))
  const [launcher] = servers
  if (launcher === undefined) return
  // Run the bin's entry with node directly: `npx` would spawn it as a grandchild, which
  // survives a kill of the wrapper and holds this process's stdout open forever.
  const bin = manifests.get(launcher)?.bin
  const entry = typeof bin === "string" ? bin : Object.values(bin ?? {})[0]
  if (entry === undefined) throw new Error(`${launcher} declares no bin to serve with`)
  writeFileSync(
    join(app, "mockingbird.json"),
    JSON.stringify({
      log: "off",
      services: Object.fromEntries(services.map((s) => [s, { port: 0 }])),
    }),
  )
  console.log(`consumer-smoke: ${services[0]} serve --config (${services.join(", ")})`)
  const proc = Bun.spawn(
    ["node", join(app, "node_modules", launcher, entry), "serve", "--config", "mockingbird.json"],
    { cwd: app, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  )
  const reader = proc.stdout.getReader()
  try {
    const urls = new Map<string, string>()
    const decoder = new TextDecoder()
    let buffered = ""
    const deadline = Date.now() + SERVE_READY_MS
    while (urls.size < services.length) {
      // Race the read: a server that never prints must not hang the suite.
      const next = await Promise.race([reader.read(), after(Math.max(0, deadline - Date.now()))])
      if (next === "timeout") {
        throw new Error(
          `serve --config: only [${[...urls.keys()].join(", ")}] came up within ${SERVE_READY_MS}ms\n${buffered}`,
        )
      }
      if (next.done) {
        const stderr = await Promise.race([new Response(proc.stderr).text(), after(2_000)])
        throw new Error(
          `serve --config exited early:\n${buffered}\n${stderr === "timeout" ? "" : stderr}`,
        )
      }
      buffered += decoder.decode(next.value)
      for (const match of buffered.matchAll(/^(\S+) mock listening on (\S+)$/gm)) {
        urls.set(match[1] as string, match[2] as string)
      }
    }
    for (const [service, url] of urls) {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) })
      const body = (await response.json()) as { status?: string; service?: string }
      if (response.status !== 200 || body.service !== service) {
        throw new Error(`${service} /health answered ${response.status} ${JSON.stringify(body)}`)
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    proc.kill()
    if ((await Promise.race([proc.exited, after(5_000)])) === "timeout") {
      proc.kill("SIGKILL")
      await Promise.race([proc.exited, after(5_000)])
    }
  }
}
