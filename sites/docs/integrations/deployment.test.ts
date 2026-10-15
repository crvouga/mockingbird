import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  isSourceInput,
  localSourceManifest,
  type SourceFile,
  sourceManifest,
} from "../src/lib/deployment.ts"

test("Docker source identity matches Git blob identities without git metadata or runtime files", () => {
  const root = mkdtempSync(join(tmpdir(), "mockingbird-deployment-test-"))
  const sources = [
    ["sites/docs/src/pages/index.astro", "<h1>Docs</h1>\n"],
    ["packages/service/example/src/index.ts", "export const example = '🦜'\n"],
    ["scripts/health/docs.ts", "// health\n"],
    ["package.json", '{"name":"fixture"}\n'],
  ] as const
  const put = (path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  const blob = (value: string) =>
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(value)}\0${value}`)
      .digest("hex")
  try {
    for (const [path, value] of sources) put(path, value)
    const expected: SourceFile[] = sources.map(([path, value]) => ({ path, sha: blob(value) }))
    symlinkSync("index.astro", join(root, "sites/docs/src/pages/alias.astro"))
    expected.push({ path: "sites/docs/src/pages/alias.astro", sha: blob("index.astro") })
    const manifest = localSourceManifest(root)
    expect(manifest).toEqual(sourceManifest(expected.reverse()))
    expect(manifest.files).toBe(5)
    for (const path of [
      "sites/docs/dist/health.json",
      "sites/docs/.astro/types.d.ts",
      "packages/service/example/node_modules/helper.ts",
      "packages/service/example/dist/index.js",
      "packages/service/example/CHANGELOG.md",
      "packages/service/example/compat/gate-report.json",
      "packages/service/example/test-results/result.json",
      "packages/service/example/benchmarks/results/run.json",
      "sites/docs/.env.local",
      "scripts/debug.tmp.ts",
      "docs/trace.log",
      ".env.local",
    ]) {
      expect(isSourceInput(path)).toBe(false)
      put(path, "ignored")
    }
    expect(localSourceManifest(root)).toEqual(manifest)
    put(sources[0][0], "<h1>Changed docs</h1>\n")
    expect(localSourceManifest(root).fingerprint).not.toBe(manifest.fingerprint)
    expect(isSourceInput("packages/service/example/benchmarks/results/ci-baseline.json")).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
