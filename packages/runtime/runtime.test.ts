import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RUNTIME_SUBPATHS } from "./src/index.js"

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as {
  exports: Record<string, { types: string; default: string }>
}

describe("@crvouga/mockingbird-runtime", () => {
  test("RUNTIME_SUBPATHS lists every exported subpath", () => {
    expect(Object.keys(manifest.exports)).toEqual([
      ".",
      ...RUNTIME_SUBPATHS.map((subpath) => `./${subpath}`),
    ])
  })

  test("every subpath re-exports the workspace helper of the same name", () => {
    for (const subpath of RUNTIME_SUBPATHS) {
      expect(manifest.exports[`./${subpath}`]).toEqual({
        types: `./dist/${subpath}.d.ts`,
        default: `./dist/${subpath}.js`,
      })
      const source = readFileSync(join(import.meta.dir, "src", `${subpath}.ts`), "utf8")
      expect(source).toBe(`export * from "@crvouga/mockingbird-${subpath}"\n`)
    }
  })
})
