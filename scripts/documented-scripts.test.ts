/**
 * Every `bun run <script>` the guides and agent commands tell a reader to type must be a root
 * package.json script, or the reader gets `Script not found`.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const scripts = new Set(
  Object.keys(
    (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: object }).scripts,
  ),
)

const markdown = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f))

const files = ["AGENTS.md", ...markdown("docs"), ...markdown(".agents/commands")]

describe("documented root scripts", () => {
  for (const file of files) {
    test(file, () => {
      const text = readFileSync(join(root, file), "utf8")
      const missing = [...text.matchAll(/\bbun run ([a-z][\w:.-]*)/g)]
        .map((m) => m[1] as string)
        .filter((name) => !scripts.has(name))
      expect(missing).toEqual([])
    })
  }
})
