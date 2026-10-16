/**
 * Keeps every published service's agent-facing discovery surface complete and local to the
 * installed npm package.
 *
 *   bun run service:discovery        rewrite package manifests and DISCOVERY.md files
 *   bun run check:service-discovery  fail when either is stale
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { root } from "./release/lib.ts"

const servicesDir = join(root, "packages/service")
const check = process.argv.includes("--check")
const REPORTING = "https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md"

type Json = Record<string, unknown>
type Discovery = {
  guide: string
  behavior: string
  capabilities: string
  contract?: string
  types: string
  oracle: { kind: string; command: string; note: string }
  introspection: string[]
  reporting: string
}

const problems: string[] = []
let count = 0

for (const name of readdirSync(servicesDir).sort()) {
  const dir = join(servicesDir, name)
  const manifestPath = join(dir, "package.json")
  if (!existsSync(manifestPath)) continue
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as Json & {
    name?: string
    private?: boolean
    files?: string[]
    mockingbird?: Json & { layer?: string; parity?: string; parityTier?: string }
  }
  if (pkg.private || pkg.mockingbird?.layer !== "service" || !pkg.name) continue

  const http = existsSync(join(dir, "openapi.yaml"))
  const capabilities = existsSync(join(dir, "SUPPORT.md")) ? "SUPPORT.md" : "COMPATIBILITY.md"
  if (!existsSync(join(dir, capabilities))) {
    problems.push(`${relative(root, dir)}: missing SUPPORT.md or COMPATIBILITY.md`)
    continue
  }

  const discovery: Discovery = {
    guide: "DISCOVERY.md",
    behavior: "README.md",
    capabilities,
    ...(http ? { contract: "openapi.yaml" } : {}),
    types: "dist/index.d.ts",
    oracle: oracleFor(name),
    introspection: http
      ? [
          "GET /__admin/health",
          "GET /__admin",
          "GET /__admin/controls",
          "GET /__admin/state",
          "GET /__admin/requests",
          "GET /__admin/metrics",
          "GET /__admin/faults/presets",
          "GET /__admin/ui",
          ...(name === "junction"
            ? [
                "GET/PUT /__admin/lab-account-omission-policies",
                "GET/PUT /__admin/requisitions/:id",
              ]
            : []),
        ]
      : ["README.md public test controls", `${capabilities} compatibility and divergence evidence`],
    reporting: REPORTING,
  }

  pkg.files = [
    ...new Set([
      ...(pkg.files ?? []),
      "DISCOVERY.md",
      capabilities,
      ...(http ? ["openapi.yaml"] : []),
    ]),
  ]
  pkg.mockingbird = { ...pkg.mockingbird, discovery }

  sync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`)
  sync(
    join(dir, "DISCOVERY.md"),
    renderGuide(
      pkg.name,
      name,
      pkg.mockingbird.parity ?? "",
      pkg.mockingbird.parityTier,
      discovery,
    ),
  )
  count++
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  process.exit(1)
}
console.log(`service discovery: ${count} packages ${check ? "are current" : "updated"}`)

function sync(path: string, expected: string): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : ""
  if (current === expected) return
  if (check) problems.push(`${relative(root, path)} is stale; run \`bun run service:discovery\``)
  else writeFileSync(path, expected)
}

function oracleFor(name: string): Discovery["oracle"] {
  if (
    [
      "vercel",
      "google",
      "apple",
      "microsoft",
      "okta",
      "aws",
      "mongoatlas",
      "clerk",
      "linear",
    ].includes(name)
  )
    return {
      kind: "Pinned Emulate 0.12.1 package oracle",
      command: "bun run --cwd packages/parity/package-oracle parity",
      note: "Offline vendor API comparison, native runtime controls and route coverage. This is package evidence, not independent live vendor verification. See docs/EMULATE_COVERAGE.md for reviewed differences.",
    }
  if (name === "openai")
    return {
      kind: "Official documentation and local SDK oracle",
      command: "bun run parity:service -- openai",
      note: "Live billed inference is disabled by repository policy. The package parity runner exits 2; tests verify official SDKs locally.",
    }
  if (name === "postgres")
    return {
      kind: "PostgreSQL 18.3 via PGlite",
      command: "bun run --cwd packages/service/postgres test:postgres-compat",
      note: "Fail-closed differential contracts compare rows, types, errors, row counts and logical state.",
    }
  if (name === "sqlite")
    return {
      kind: "SQLite via bun:sqlite (version pinned in COMPATIBILITY.md)",
      command: "bun run --cwd packages/service/sqlite test:sqlite-compat",
      note: "Fail-closed differential contracts compare results, errors, counters and logical state.",
    }
  if (name === "redis")
    return {
      kind: "Redis or Valkey selected by REDIS_URL",
      command: "bun run --cwd packages/service/redis parity",
      note: "The repository also differentially exercises BullMQ with parity:bullmq.",
    }
  if (name === "medplum")
    return {
      kind: "Pinned self-hosted Medplum",
      command: "bun run parity:service -- medplum",
      note: "The harness boots its own oracle (or accepts --oracle-url), compares scenarios and random walks, and keeps an oracle recording.",
    }
  return {
    kind: "Live vendor API or sandbox",
    command: `bun run parity:service -- ${name}`,
    note: "Run from a Mockingbird checkout; credentials come only from .env.local or GitHub Actions secrets. Missing credentials exit 2.",
  }
}

/** The shared controls, in the one file an agent reads without leaving \`node_modules\`. */
function adminControlsSection(): string {
  const GUIDE = "https://mockingbird.chrisvouga.dev/docs/admin-controls"
  return `
## Admin controls

Every HTTP emulator takes the same controls, and each means the same thing at boot
(\`createRuntime({ adminControls })\`, \`serve --admin-controls\`), over \`/__admin\`, and in a request header:

| Control | Admin API | Request header | Interface |
| --- | --- | --- | --- |
| Isolate state by key | \`GET /__admin/namespaces\` | \`x-mockingbird-namespace: <key>\` | [Namespaces](${GUIDE}/namespaces) |
| Reset to boot | \`POST /__admin/reset\` | \`x-mockingbird-reset: true\` | [Reset](${GUIDE}/reset) |
| Snapshot and restore | \`POST /__admin/snapshots\`, \`POST /__admin/snapshots/<id>/restore\` | \`x-mockingbird-snapshot: <name>\`, \`x-mockingbird-restore: <name>\` | [Snapshot and restore](${GUIDE}/snapshot-and-restore) |
| Move the clock | \`POST /__admin/clock\` | \`x-mockingbird-time: <instant>\`, \`x-mockingbird-advance: <duration>\` | [Clock](${GUIDE}/clock) |
| Read or branch from old state | \`GET /__admin/timeline\` | \`x-mockingbird-at: <checkpoint>\`, \`x-mockingbird-branch: <name>\` | [Checkpoints and branches](${GUIDE}/checkpoints-and-branches) |
| Inject a fault | \`POST /__admin/faults\` | \`x-mockingbird-fault: <fault>\` | [Faults](${GUIDE}/faults) |
| Latency and timeouts | \`PUT /__admin/latency\` | \`x-mockingbird-delay: <duration>\`, \`x-mockingbird-timeout: <duration>\` | [Latency and timeouts](${GUIDE}/latency-and-timeouts) |
| Replay from a seed | \`PUT /__admin/controls\` | \`x-mockingbird-seed: <seed>\` | [Seed and determinism](${GUIDE}/seed-and-determinism) |
| See what happened | \`GET /__admin/requests\`, \`GET /__admin/state\` | | [Journal, metrics and state](${GUIDE}/journal-and-state) |

\`GET /__admin\` lists every route and header with a one-line summary, and \`GET /__admin/controls\`
is the namespace's current control document. The same seed and the same requests give the same
bytes. Setting controls as an emulator starts is [Boot](${GUIDE}/boot); every route and header is in
the [Reference](${GUIDE}/reference). The full guide: <${GUIDE}>.
`
}

function renderGuide(
  packageName: string,
  service: string,
  parity: string,
  tier: string | undefined,
  discovery: Discovery,
): string {
  const artifactRows = [
    [
      "Behaviour and integration",
      discovery.behavior,
      "Routes, state transitions, auth, webhooks, controls, presets and deliberate omissions.",
    ],
    [
      "Exact capabilities",
      discovery.capabilities,
      "Supported, unsupported and parity-covered operations or commands, including reasons for gaps.",
    ],
    ...(discovery.contract
      ? [
          [
            "Wire contract",
            discovery.contract,
            "Machine-readable paths, methods, schemas, responses and parity annotations.",
          ],
        ]
      : []),
    [
      "Public API",
      discovery.types,
      "The installed package's exact TypeScript exports and signatures.",
    ],
    [
      "Package metadata",
      "package.json",
      "Runtime/entry-point claims, vendor links, parity scope/tier and `mockingbird.discovery`.",
    ],
  ]
  return `# ${packageName} discovery

This is the installed-package index for coding agents and tooling. All relative links resolve
inside \`node_modules/${packageName}/\`; no repository checkout is needed to discover the emulator's
supported surface or documented behavior.

## Capability and behavior sources

| Question | Authoritative file | What it contains |
| --- | --- | --- |
${artifactRows.map(([label, file, description]) => `| ${label} | [\`${file}\`](${file}) | ${description} |`).join("\n")}

Read these together: the contract/capability matrix says *what* is available, while the README
defines stateful behavior, lifecycle rules, test controls, and intentional oracle differences.
If prose and an executable surface disagree, report a parity mismatch instead of adding a
consumer-side workaround.

## Parity and oracle

- Declared parity surface: **${parity}**.
${tier ? `- Parity tier: **${tier}** (the repository controls when live checks run).\n` : ""}- Oracle: **${discovery.oracle.kind}**.
- Repository command: \`${discovery.oracle.command}\`.
- Evidence model: ${discovery.oracle.note}

The npm package contains evidence summaries and the exact contract, not credentials or the
repository-only parity harness. Self-parity/property and acceptance tests run in the Mockingbird
repository; live parity is an additional oracle check, not a substitute for the packaged matrix.

## Runtime introspection

${discovery.introspection.map((item) => `- \`${item}\``).join("\n")}

For HTTP services, use \`x-mockingbird-namespace\` (or the documented credential/path carrier) so
parallel tests do not share state. Admin state, journal, metrics and fault-preset endpoints are
designed for assertions and diagnosis by consuming test suites.
${discovery.contract ? adminControlsSection() : ""}
## Report a mismatch or missing capability

Follow the [agent reporting contract](${discovery.reporting}). Include package version,
operation/command, a minimal redacted request, actual emulator result, expected oracle result or vendor
documentation, and whether the mismatch appears in the matrix. Never include keys, tokens,
customer data, prompts, PHI, card data, or unredacted recordings.

Service key: \`${service}\`.
`
}
