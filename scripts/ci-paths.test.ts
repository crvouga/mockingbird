import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  assertShardIrrelevantUnread,
  HASH_ONLY_READERS,
  type RootInputs,
  shardIrrelevantReads,
  shardRootInputs,
} from "./ci-paths.ts"

const root = join(import.meta.dir, "..")

describe("SHARD_IRRELEVANT", () => {
  test("no shard task reads a path a pull request may skip the shards for", () => {
    expect(() => assertShardIrrelevantUnread()).not.toThrow()
  })

  test("without its hash-only exemption, the docs build reads the skipped scripts", () => {
    const reads = shardIrrelevantReads(
      ["scripts/pr-ready.ts", "scripts/worktree/sync.ts", "AGENTS.md"],
      shardRootInputs(),
      undefined,
      {},
    )
    expect(reads).toEqual([
      { file: "scripts/pr-ready.ts", task: "@crvouga/mockingbird-docs#build" },
      { file: "scripts/worktree/sync.ts", task: "@crvouga/mockingbird-docs#build" },
    ])
  })

  test("a task that declares a skipped path is reported, minus its exclusions", () => {
    const inputs: RootInputs[] = [
      { task: "pkg#test", include: ["scripts/worktree/**"], exclude: ["scripts/worktree/*.md"] },
    ]
    expect(
      shardIrrelevantReads(
        ["scripts/worktree/sync.ts", "scripts/worktree/README.md", "scripts/affected.ts"],
        inputs,
        ["scripts/worktree/**"],
        {},
      ),
    ).toEqual([{ file: "scripts/worktree/sync.ts", task: "pkg#test" }])
  })

  test("the docs build, exempt as hash-only, imports nothing from scripts/", () => {
    expect(Object.keys(HASH_ONLY_READERS)).toEqual(["@crvouga/mockingbird-docs#build"])
    const docs = join(root, "sites/docs")
    const sources: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx|js|mjs|astro)$/.test(name) && !name.endsWith(".test.ts")) {
          sources.push(path)
        }
      }
    }
    walk(join(docs, "src"))
    walk(join(docs, "integrations"))
    sources.push(join(docs, "astro.config.ts"))
    const importsScripts = sources.filter((path) =>
      /(?:from\s+|import\s*\(\s*|require\(\s*)["'][^"']*\/scripts\//.test(
        readFileSync(path, "utf8"),
      ),
    )
    expect(importsScripts.map((path) => path.slice(root.length + 1))).toEqual([])
  })
})
