import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

type Manifest = {
  name?: string
  bin?: Record<string, string>
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  repository?: { url?: string }
  mockingbird?: { layer?: string }
}

const manifests = (): Array<{ path: string; manifest: Manifest }> => {
  const out: Array<{ path: string; manifest: Manifest }> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (entry !== "package.json") continue
      out.push({ path, manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest })
    }
  }
  walk(root)
  return out
}

test("workspace packages use Mockingbird names, bins, and repository URLs", () => {
  const packages = manifests()
  const rootManifest = packages.find((pkg) => pkg.path === join(root, "package.json"))
  expect(rootManifest?.manifest.name).toBe("mockingbird-monorepo")

  const names = packages.flatMap((pkg) => (pkg.manifest.name ? [pkg.manifest.name] : []))
  expect(names).toContain("@crvouga/mockingbird-docs")
  expect(names).toContain("@crvouga/mockingbird-sqlite")
  expect(names).toContain("@crvouga/mockingbird-service")
  expect(names).toContain("@crvouga/mockingbird-service-stripe")

  for (const { path, manifest } of packages) {
    if (path === join(root, "package.json")) continue
    expect(manifest.name ?? "").toMatch(/^@crvouga\/mockingbird(?:-[a-z0-9]+)*$/)
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    }
    const bannedScopes = ["emulates", "emulators"].map((scope) => `@${scope}/`)
    for (const dep of Object.keys(deps)) {
      for (const scope of bannedScopes) expect(dep.startsWith(scope)).toBe(false)
    }
    for (const bin of Object.keys(manifest.bin ?? {})) {
      expect(bin.startsWith("mockingbird-")).toBe(true)
    }
    const repo = manifest.repository?.url
    if (repo) expect(repo).toContain("github.com/crvouga/mockingbird")
  }

  for (const entry of readdirSync(join(root, "packages/service"))) {
    const manifestPath = join(root, "packages/service", entry, "package.json")
    try {
      if (!statSync(manifestPath).isFile()) continue
    } catch {
      continue
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
    const expected =
      entry === "core" ? "@crvouga/mockingbird-service" : `@crvouga/mockingbird-service-${entry}`
    expect(manifest.name).toBe(expected)
  }
})

const source = (path: string) => readFileSync(join(root, path), "utf8")

test("shipped headers, admin errors, config, env, and docker names are Mockingbird", () => {
  // Every control header is named once, in CONTROL_HEADERS; the constants point at it.
  const headers = source("packages/service/core/src/controls.ts")
  expect(headers).toContain('namespace: "x-mockingbird-namespace"')
  expect(headers).toContain('adminKey: "x-mockingbird-admin-key"')
  expect(
    [...headers.matchAll(/: "(x-[a-z-]+)",/g)].every(([, name]) =>
      name?.startsWith("x-mockingbird-"),
    ),
  ).toBe(true)
  const control = source("packages/service/core/src/control.ts")
  expect(control).toContain("export const NAMESPACE_HEADER = CONTROL_HEADERS.namespace")
  expect(control).toContain("export const ADMIN_KEY_HEADER = CONTROL_HEADERS.adminKey")
  expect(control).toContain('type: "mockingbird_admin"')
  expect(control).toContain("expected a JSON object")

  const runtime = source("packages/service/core/src/runtime.ts")
  expect(runtime).toContain('export const MOCKINGBIRD_HEADER = "x-mockingbird"')

  const cli = source("packages/adapters/node/src/cli.ts")
  expect(cli).toContain("mockingbird.json")
  expect(cli).toContain("MOCKINGBIRD_ADMIN_PREFIX")
  expect(cli).toContain("MOCKINGBIRD_ADMIN_KEY")
  const fleet =
    source("packages/adapters/node/src/fleet.ts") +
    source("packages/adapters/node/src/fleet-management.ts")
  expect(fleet).toContain("process.env.MOCKINGBIRD_ADMIN_KEY")
  expect(fleet).toContain("x-mockingbird-admin-key")
  const stateDir = source("packages/service/github/oracle/run.mjs")
  expect(stateDir).toContain(".mockingbird/github-oracle")

  const creation = source("packages/service/docker/src/creation.ts")
  expect(creation).toContain(["`mockingbird_", "{id.slice(0, 12)}`"].join("$"))
})

test("core sqlite tables are mockingbird_* and legacy names rename back", () => {
  const schema = source("packages/sqlite/src/schema.ts")
  expect(schema).toContain("CREATE TABLE IF NOT EXISTS mockingbird_records")
  expect(schema).toContain("CREATE TABLE IF NOT EXISTS mockingbird_sequences")
  for (const prefix of ["emulates", "emulators"] as const) {
    expect(schema).toContain(`["${prefix}_records", "mockingbird_records"]`)
    expect(schema).toContain(`["${prefix}_sequences", "mockingbird_sequences"]`)
  }
})
