import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("portable in-process filenames are comments, while real process access still fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "portability-"))
  try {
    mkdirSync(join(directory, "dist"))
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "fixture",
        mockingbird: { runtime: "portable" },
        exports: { ".": "./dist/in-process.js" },
      }),
    )
    const path = join(directory, "dist/in-process.js")
    const comments = "// src/in-process.ts\n//# sourceMappingURL=in-process.js.map\n"
    const run = () =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, "portability.ts")], { cwd: directory })
    writeFileSync(path, `${comments}export const value = 1\n`)
    expect(run().exitCode).toBe(0)
    writeFileSync(path, `${comments}export const value = process.platform\n`)
    const rejected = run()
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr.toString()).toContain("uses process.")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
