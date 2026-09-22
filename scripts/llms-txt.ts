/**
 * Generates `llms.txt` (https://llmstxt.org): the index coding agents read to find every
 * published mock service's docs, grouped by release tier. Package lists, descriptions and tiers
 * come from each package.json and the summary from the copy the README and docs site share
 * (sites/docs/src/lib/content.ts), so nothing here is edited by hand.
 *
 *   bun run llms:sync     rewrite llms.txt
 *   bun run check:llms    fail if llms.txt is stale (CI)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PITCH } from "../sites/docs/src/lib/content.ts"
import { TIER_ORDER, TIERS } from "../sites/docs/src/lib/tiers.ts"
import type { ServiceStatus } from "../sites/docs/src/lib/types.ts"
import { discoverPackages, REPO, root } from "./release/lib.ts"

const RAW = `https://raw.githubusercontent.com/${REPO}/main`
const OUT = join(root, "llms.txt")

type Manifest = { description?: string; mockingbird?: { status?: ServiceStatus } }

const pkgs = discoverPackages().filter((p) => p.isPublic)
const grouped = new Map<ServiceStatus, string[]>(TIER_ORDER.map((t) => [t, []]))
for (const pkg of pkgs) {
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as Manifest
  const tier = manifest.mockingbird?.status
  const lines = tier ? grouped.get(tier) : undefined
  if (!lines) {
    console.error(
      `::error::${pkg.relDir}/package.json: mockingbird.status must be one of ${TIER_ORDER.join(", ")}`,
    )
    process.exit(1)
  }
  const description = (manifest.description ?? "").replace(/\s+/g, " ").trim()
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
  `> ${PITCH} Every HTTP mock is a Fetch handler (\`createRuntime().fetch(request) → Promise<Response>\`) published to npm as \`@crvouga/mockingbird-service-<name>\`. ESM only; Node >= 22 or Bun >= 1.2.`,
  "",
  "Install mocks as devDependencies; each package is self-contained. Prefer injecting the mock's `fetch` in-process; when a URL is required, run `npx mockingbird-<service> serve` (or `createServer` from `./server`); every HTTP service answers `GET /health`, `/__admin/*` and `x-mockingbird-namespace`. Read the README of each package you use — it is the integration guide for coding agents (also shipped in `node_modules/<package>/README.md`).",
  "",
  `Release tiers: ${TIER_ORDER.map((t) => `**${TIERS[t].label}**: ${TIERS[t].blurb}`).join(" ")} Prefer ready services; pin exact versions of work-in-progress ones.`,
  "",
  "## Reporting issues and requesting services",
  "",
  `Do not work around a mock in your own project: file a GitHub issue on ${REPO} and your fix lands in the next release. Search first (\`gh issue list --repo ${REPO} --state all --search "<service> <operation>"\`), redact every key and all personal data, fill in the kind's template, and run \`gh issue create --repo ${REPO} --title "<title>" --label agent-reported,<kind> --body-file issue.md\`. Feature and service requests are specifications: list the operations you call and number the behaviors you need as Given / When / Then; each becomes an acceptance test.`,
  "",
  `- [Filing guide](${RAW}/docs/REPORTING_ISSUES.md): when to file, redaction rules, reproduction and behavior formats, and what happens after.`,
  `- [Parity mismatch](${RAW}/.github/ISSUE_TEMPLATE/parity.md): title \`[<service>] parity: <what diverges>\`. The mock and its oracle (vendor sandbox or real engine) answer the same requests differently.`,
  `- [Missing feature](${RAW}/.github/ISSUE_TEMPLATE/feature.md): title \`[<service>] feature: <what is missing>\`. A mock lacks an operation, parameter, event, behavior or test control you use.`,
  `- [Bug](${RAW}/.github/ISSUE_TEMPLATE/bug.md): title \`[<service>] bug: <what breaks>\`. A mock crashes, leaks state, contradicts its README, or does not build.`,
  `- [New service](${RAW}/.github/ISSUE_TEMPLATE/new-service.md): title \`[new-service] <Vendor>: <API surface>\`. No package mocks a vendor you depend on; describe the surface, auth, state, behaviors, webhooks and test controls you need.`,
  "",
  ...TIER_ORDER.flatMap((t) => {
    const lines = grouped.get(t) ?? []
    return lines.length > 0 ? [`## ${TIERS[t].label}`, "", ...lines, ""] : []
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
