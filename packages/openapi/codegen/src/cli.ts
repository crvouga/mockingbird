#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { generate, loadSpec } from "./index.js"

const OUTPUTS = { module: "src/generated/openapi.ts", support: "SUPPORT.md" } as const

const readOptional = async (path: string) => {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

const main = async () => {
  const args = new Set(process.argv.slice(2))
  const cwd = process.cwd()
  const specPath = resolve(cwd, "openapi.yaml")
  const yamlText = await readFile(specPath, "utf8")

  if (args.has("--validate")) {
    loadSpec(yamlText)
    console.log(`openapi.yaml ok`)
    return
  }

  const files = generate(yamlText)
  const targets: Array<[string, string]> = [
    [resolve(cwd, OUTPUTS.module), files.module],
    [resolve(cwd, OUTPUTS.support), files.support],
  ]

  if (args.has("--check")) {
    const stale: string[] = []
    for (const [path, content] of targets) {
      if ((await readOptional(path)) !== content) stale.push(path.slice(cwd.length + 1))
    }
    if (stale.length > 0) {
      console.error(
        `generated files are out of date, run \`bun run generate\`:\n${stale.map((s) => `  - ${s}`).join("\n")}`,
      )
      process.exit(1)
    }
    console.log("generated files are up to date")
    return
  }

  for (const [path, content] of targets) {
    await mkdir(dirname(path), { recursive: true })
    if ((await readOptional(path)) !== content) await writeFile(path, content)
  }
  console.log(`generated ${targets.map(([path]) => path.slice(cwd.length + 1)).join(", ")}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
