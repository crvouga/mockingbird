/**
 * Generates `llms.txt` (https://llmstxt.org): the index coding agents read to find every
 * published mock service's docs. Package lists and descriptions come from each package.json,
 * so a new public package shows up here without hand edits.
 *
 *   bun run llms:sync     rewrite llms.txt
 *   bun run check:llms    fail if llms.txt is stale (CI)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { discoverPackages, REPO, root } from "./release/lib.ts"

const RAW = `https://raw.githubusercontent.com/${REPO}/main`
const OUT = join(root, "llms.txt")

type Manifest = { description?: string }

const GROUPS: Array<{ title: string; match: (name: string) => boolean }> = [
  {
    title: "SQL databases",
    match: (name) => /^@crvouga\/mockingbird-service-(?:postgres|sqlite)$/.test(name),
  },
  { title: "HTTP API mocks", match: () => true },
]

const pkgs = discoverPackages().filter((p) => p.isPublic)
const grouped = new Map<string, string[]>(GROUPS.map((g) => [g.title, []]))
for (const pkg of pkgs) {
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as Manifest
  const group = GROUPS.find((g) => g.match(pkg.name))
  if (!group) continue
  const description = (manifest.description ?? "").replace(/\s+/g, " ").trim()
  const lines = grouped.get(group.title) as string[]
  lines.push(`- [${pkg.name}](${RAW}/${pkg.relDir}/README.md): ${description}`)
  for (const extra of ["SUPPORT.md", "COMPATIBILITY.md"]) {
    if (existsSync(join(pkg.dir, extra))) {
      lines.push(`- [${pkg.name} ${extra}](${RAW}/${pkg.relDir}/${extra}): coverage matrix`)
    }
  }
}

const body = [
  "# mockingbird",
  "",
  "> Stateful, contract-checked mocks of third-party HTTP APIs (Stripe, Junction/Vital, GeneByGene, Medplum) and pure-TypeScript in-memory PostgreSQL/SQLite engines for test suites. Every HTTP mock is a Fetch handler (`mock.fetch(request) → Promise<Response>`) published to npm as `@crvouga/mockingbird-service-<name>`. ESM only; Node >= 22 or Bun >= 1.2.",
  "",
  "Install mocks as devDependencies; each package is self-contained. Prefer injecting `mock.fetch` in-process; when a URL is required, run `npx mockingbird-<service> serve` (or `createServer` from `./server`); every HTTP service answers `GET /health`, `/__admin/*` and `x-mockingbird-namespace`. Read the README of each package you use — it is the integration guide for coding agents (also shipped in `node_modules/<package>/README.md`).",
  "",
  ...GROUPS.flatMap((g) => {
    const lines = grouped.get(g.title) ?? []
    return lines.length > 0 ? [`## ${g.title}`, "", ...lines, ""] : []
  }),
].join("\n")

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : ""
  if (current !== body) {
    console.error("::error::llms.txt is stale — run: bun run llms:sync")
    process.exit(1)
  }
  console.log(`llms.txt: OK (${pkgs.length} packages)`)
} else {
  writeFileSync(OUT, body)
  console.log(`llms.txt: wrote ${pkgs.length} packages`)
}
