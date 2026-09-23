/// <reference types="bun" />
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readExamples } from "./examples.ts"

test("service example metadata validates ids, source files and directory confinement", () => {
  const dir = mkdtempSync(join(tmpdir(), "service-examples-"))
  try {
    mkdirSync(join(dir, "examples"))
    writeFileSync(join(dir, "examples/demo.ts"), "export function mount() {}")
    writeFileSync(join(dir, "outside.ts"), "private")
    symlinkSync(join(dir, "outside.ts"), join(dir, "examples/link.ts"))
    const example = { id: "demo", title: "Demo", description: "Try it", entry: "examples/demo.ts" }
    expect(readExamples(undefined, dir)).toEqual([])
    expect(readExamples([example], dir)[0]?.sources).toEqual([example.entry])
    expect(() => readExamples([example, example], dir)).toThrow("unique")
    expect(() => readExamples([{ ...example, entry: "examples/missing.ts" }], dir)).toThrow(
      "Missing",
    )
    for (const entry of ["examples/../outside.ts", "examples/link.ts"])
      expect(() => readExamples([{ ...example, entry }], dir)).toThrow("escapes")
    expect(() => readExamples([{ ...example, sources: ["outside.ts"] }], dir)).toThrow("inside")
    expect(() => readExamples([{ ...example, title: "" }], dir)).toThrow("title")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
