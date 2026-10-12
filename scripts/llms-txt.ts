/**
 * Generates `llms.txt` (https://llmstxt.org): the index coding agents read to find every
 * published emulator service's docs. Package lists, descriptions and parity come from each
 * package.json and the summary from the copy the README and docs site share
 * (sites/docs/src/lib/content.ts), so nothing here is edited by hand.
 *
 *   bun run llms:sync     rewrite llms.txt
 *   bun run check:llms    fail if llms.txt is stale (CI)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ADMIN_CONTROLS, GUIDE_CHILDREN, IDENTITY, PITCH } from "../sites/docs/src/lib/content.ts"
import { guideInfo } from "../sites/docs/src/lib/guides.ts"
import { discoverPackages, REPO, root } from "./release/lib.ts"

const RAW = `https://raw.githubusercontent.com/${REPO}/main`
const OUT = join(root, "llms.txt")

type Manifest = {
  description?: string
  mockingbird?: { layer?: string; parity?: unknown }
}

const pkgs = discoverPackages()
  .filter((p) => p.isPublic)
  .sort((a, b) => a.name.localeCompare(b.name))
const serviceLines: string[] = []
for (const pkg of pkgs) {
  const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as Manifest
  const parity = manifest.mockingbird?.parity
  if (
    manifest.mockingbird?.layer !== "service" ||
    typeof parity !== "string" ||
    parity.trim() === "" ||
    parity.length > 80
  ) {
    console.error(
      `::error::${pkg.relDir}/package.json: a published service needs mockingbird.parity, a short statement of the vendor surface it keeps in step`,
    )
    process.exit(1)
  }
  const description = (manifest.description ?? "").replace(/\s+/g, " ").trim()
  serviceLines.push(
    `- [${pkg.name}](${RAW}/${pkg.relDir}/README.md): ${description} Parity: ${parity}.`,
  )
  for (const extra of ["DISCOVERY.md", "SUPPORT.md", "COMPATIBILITY.md"]) {
    if (existsSync(join(pkg.dir, extra))) {
      serviceLines.push(`- [${pkg.name} ${extra}](${RAW}/${pkg.relDir}/${extra}): coverage matrix`)
    }
  }
}

const body = [
  "# mockingbird",
  "",
  `> ${IDENTITY.tagline} ${PITCH} Every HTTP emulator is a Fetch handler (\`createRuntime().fetch(request) → Promise<Response>\`) published to npm as \`@crvouga/mockingbird-service-<name>\`. Every emulator is isomorphic and runs in Node >= 22, Bun >= 1.2, browsers, and Workers.`,
  "",
  "Install emulators as devDependencies; each package is self-contained. Prefer injecting the emulator's `fetch` in-process; when a URL is required, run `npx mockingbird-<service> serve` (or `createServer` from `./server`); every HTTP service answers `GET /__admin/health`, `/__admin/*` (including `GET /__admin/state` and `GET /__admin/ui`) and `x-mockingbird-namespace`. All internal paths use the configurable `adminPrefix` (CLI `--admin-prefix`, env `MOCKINGBIRD_ADMIN_PREFIX`), including namespace URLs `/__admin/ns/<name>/…`; there are no unprefixed health or namespace aliases. Read the README of each package you use — it is the integration guide for coding agents (also shipped in `node_modules/<package>/README.md`).",
  "",
  `The sentence above is the product's identity. The rules for the mark, the colors, and where that sentence has to appear: [Design](${RAW}/docs/DESIGN.md).`,
  "",
  "Each service declares its own parity: a short statement of the vendor surface it keeps in step. Read that statement, and the package README, before you depend on an emulator.",
  "",
  "## Admin controls",
  "",
  "Every HTTP emulator takes the same controls, and each means the same thing at boot (`createRuntime({ adminControls })`, `serve --admin-controls`), over `/__admin`, and in a request header: isolate state by key (`x-mockingbird-namespace`), reset to boot (`POST /__admin/reset`), snapshot and restore (`POST /__admin/snapshots`), move the clock (`POST /__admin/clock`, `x-mockingbird-time`), inject faults (`POST /__admin/faults`, `x-mockingbird-fault`), and add latency or timeouts (`PUT /__admin/latency`, `x-mockingbird-delay`, `x-mockingbird-timeout`). The same seed and the same requests give the same bytes. `GET /__admin` on a running emulator lists every route and header.",
  "",
  `- [Admin controls](${RAW}/docs/ADMIN_CONTROLS.md): where each control is, the three ways to set one, and what holds for all of them.`,
  ...GUIDE_CHILDREN.ADMIN_CONTROLS.map((name) => {
    const path = `${ADMIN_CONTROLS.pages}/${name}.md`
    const page = guideInfo({ file: name, markdown: readFileSync(join(root, path), "utf8") })
    return `- [${page.title}](${RAW}/${path}): ${page.summary}`
  }),
  "",
  "## Reporting issues and requesting services",
  "",
  `Do not work around an emulator in your own project: file a GitHub issue on ${REPO} and your fix lands in the next release. Search first (\`gh issue list --repo ${REPO} --state all --search "<service> <operation>"\`), redact every key and all personal data, fill in the kind's template, and run \`gh issue create --repo ${REPO} --title "<title>" --label agent-reported,<kind> --body-file issue.md\`. Feature and service requests are specifications: list the operations you call and number the behaviors you need as Given / When / Then; each becomes an acceptance test.`,
  "",
  `- [Filing guide](${RAW}/docs/REPORTING_ISSUES.md): when to file, redaction rules, reproduction and behavior formats, and what happens after.`,
  `- [Parity mismatch](${RAW}/.github/ISSUE_TEMPLATE/parity.md): title \`[<service>] parity: <what diverges>\`. The emulator and its oracle (vendor sandbox or real engine) answer the same requests differently.`,
  `- [Missing feature](${RAW}/.github/ISSUE_TEMPLATE/feature.md): title \`[<service>] feature: <what is missing>\`. An emulator lacks an operation, parameter, event, behavior or test control you use.`,
  `- [Bug](${RAW}/.github/ISSUE_TEMPLATE/bug.md): title \`[<service>] bug: <what breaks>\`. An emulator crashes, leaks state, contradicts its README, or does not build.`,
  `- [New service](${RAW}/.github/ISSUE_TEMPLATE/new-service.md): title \`[new-service] <Vendor>: <API surface>\`. No package emulates a vendor you depend on; describe the surface, auth, state, behaviors, webhooks and test controls you need.`,
  "",
  "## Services",
  "",
  ...serviceLines,
  "",
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
