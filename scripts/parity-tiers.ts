/**
 * How often each service's live parity runs: the one place that reads and validates it.
 *
 * A live parity run spends a vendor's rate limit and, sometimes, its sandbox. So each service that
 * has a `parity` script declares a tier in its package.json, next to the rest of its
 * `mockingbird` metadata:
 *
 *   "mockingbird": { …, "parityTier": "cold" }
 *
 *   hot   every merge to main that changes the service (ci.yml → parity.yml)
 *   warm  on a schedule (parity.yml's `schedule:`)
 *   cold  only when someone dispatches it: `bun run parity:remote -- <service>`
 *
 * After a merge a hot service runs only when something in its dependency graph changed (see
 * scripts/affected.ts and ci-plan.ts); `parityInputs` lists files outside that graph it also reads.
 *
 * A service with no `parityTier` is cold. Promoting a service is changing that one value: every
 * workflow selects by tier through this file, so none of them names a service.
 *
 *   bun scripts/parity-tiers.ts list                    each parity service and its tier
 *   bun scripts/parity-tiers.ts resolve <selector…>     the services a selector names, one line
 *   bun scripts/parity-tiers.ts --check                 fail on an unknown tier (CI)
 *
 * A selector is service names, `--all`, or `--tier=<hot|warm|cold>` (exactly that tier). `resolve`
 * also writes `services=<names>` to $GITHUB_OUTPUT, empty when the selector matches nothing.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const TIERS = ["hot", "warm", "cold"] as const
export type Tier = (typeof TIERS)[number]

/** What a service with no declared `parityTier` gets. */
export const DEFAULT_TIER: Tier = "cold"

const root = join(import.meta.dir, "..")
const servicesDir = join(root, "packages/service")

export interface ParityService {
  name: string
  /** The declared tier, or DEFAULT_TIER when there is none. */
  tier: Tier
  /** The value in package.json when it is not a tier (so `--check` can name it), else undefined. */
  invalid?: string
  /**
   * Repo-root-relative globs, beyond the service's own package and its workspace dependencies,
   * whose change can change its parity result (`mockingbird.parityInputs`).
   */
  inputs: string[]
}

const isTier = (value: unknown): value is Tier => TIERS.includes(value as Tier)

/** Every service package with a `parity` script, sorted by name. */
export function parityServices(): ParityService[] {
  const found: ParityService[] = []
  for (const name of readdirSync(servicesDir).sort()) {
    const manifest = join(servicesDir, name, "package.json")
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      scripts?: Record<string, string>
      mockingbird?: { parityTier?: unknown; parityInputs?: string[] }
    }
    const inputs = pkg.mockingbird?.parityInputs ?? []
    if (typeof pkg.scripts?.parity !== "string") continue
    const declared = pkg.mockingbird?.parityTier
    if (declared === undefined || isTier(declared)) {
      found.push({ name, tier: declared ?? DEFAULT_TIER, inputs })
    } else {
      found.push({ name, tier: DEFAULT_TIER, invalid: JSON.stringify(declared), inputs })
    }
  }
  return found
}

export const servicesInTier = (tier: Tier): string[] =>
  parityServices()
    .filter((s) => s.tier === tier)
    .map((s) => s.name)

/**
 * Names for a selector: service names, `--all`, or `--tier=<tier>` (or `--tier <tier>`), in any mix.
 * Throws on an unknown tier or a name with no parity script.
 */
export function resolveSelector(tokens: string[]): string[] {
  const all = parityServices()
  const known = new Set(all.map((s) => s.name))
  const picked = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token === "--all") {
      for (const s of all) picked.add(s.name)
    } else if (token === "--tier" || token.startsWith("--tier=")) {
      const tier = token === "--tier" ? tokens[++i] : token.slice("--tier=".length)
      if (!isTier(tier)) throw new Error(`unknown tier ${JSON.stringify(tier)}; one of ${TIERS}`)
      for (const s of all) if (s.tier === tier) picked.add(s.name)
    } else if (known.has(token)) {
      picked.add(token)
    } else {
      throw new Error(`no parity script for: ${token}`)
    }
  }
  return [...picked]
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2).filter((a) => a !== "--")
  if (command === "--check") {
    const bad = parityServices().filter((s) => s.invalid)
    for (const s of bad) {
      console.error(
        `${s.name}: mockingbird.parityTier is ${s.invalid}; expected one of ${TIERS.join(", ")}`,
      )
    }
    if (bad.length > 0) process.exit(1)
  } else if (command === "list") {
    for (const s of parityServices()) console.log(`${s.tier.padEnd(5)} ${s.name}`)
  } else if (command === "resolve") {
    let names: string[]
    try {
      names = resolveSelector(rest)
    } catch (error) {
      console.error((error as Error).message)
      process.exit(2)
    }
    console.log(names.join(" "))
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `services=${names.join(" ")}\n`)
    }
  } else {
    console.error("usage: bun scripts/parity-tiers.ts list | resolve <selector…> | --check")
    process.exit(2)
  }
}
