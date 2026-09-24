/**
 * Shared helpers for GitHub Secrets / .env tooling.
 * Never print secret values — only names, paths, and status.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"

export const root = join(import.meta.dir, "../..")

export const ENV_LOCAL_PATH = join(root, ".env.local")
export const ENV_EXAMPLE_PATH = join(root, ".env.example")

export type SecretObtain = {
  title: string
  urls: string[]
  steps: string[]
}

export type SecretEntry = {
  id: string
  description: string
  required: boolean
  github: { name: string | null; required: boolean }
  local_env: string[]
  obtain: SecretObtain
  populate: { github: string; env_local: string }
}

export type ChecklistEntry = {
  id: string
  description: string
  required: boolean
  urls: string[]
  steps: string[]
}

export type SecretsManifest = {
  repo: string
  secrets: SecretEntry[]
  checklists: ChecklistEntry[]
}

export type CheckStatus = "pass" | "fail" | "skip" | "warn"

export type GitHubSecretEntry = SecretEntry & {
  github: { name: string; required: boolean }
}

export function isGitHubSecretEntry(entry: SecretEntry): entry is GitHubSecretEntry {
  return entry.github.name !== null
}

export type CheckResult = {
  id: string
  status: CheckStatus
  message: string
  details?: string[]
}

function parseYaml<T>(text: string): T {
  const parsed = Bun.YAML.parse(text)
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Expected YAML object")
  }
  return parsed as T
}

export async function loadManifest(): Promise<SecretsManifest> {
  const path = join(root, "secrets.manifest.yaml")
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}`)
  }
  const manifest = parseYaml<SecretsManifest>(await Bun.file(path).text())
  if (!manifest.repo || !Array.isArray(manifest.secrets)) {
    throw new Error("secrets.manifest.yaml must define repo and secrets[]")
  }
  if (!Array.isArray(manifest.checklists)) {
    manifest.checklists = []
  }
  return manifest
}

/** Prefix shared by every live-parity credential, locally and as a GitHub Actions secret. */
export const PARITY_SECRET_PREFIX = "MOCKINGBIRD_"

export type ParityRequirement = { service: string; env: string[] }

/**
 * Every service with a live-parity script, and the env vars its `loadCredentials({ fields })`
 * call requires. Read from source so the list never drifts from what the scripts load.
 */
export function parityRequirements(): ParityRequirement[] {
  const servicesDir = join(root, "packages/service")
  const out: ParityRequirement[] = []
  for (const service of readdirSync(servicesDir).sort()) {
    const path = join(servicesDir, service, "scripts/parity.ts")
    if (!existsSync(path)) continue
    const source = readFileSync(path, "utf8")
    const env = new Set<string>()
    for (const block of source.matchAll(/fields:\s*\{([^}]*)\}/g)) {
      for (const name of (block[1] ?? "").matchAll(/:\s*"([A-Z0-9_]+)"/g)) {
        if (name[1]?.startsWith(PARITY_SECRET_PREFIX)) env.add(name[1])
      }
    }
    if (env.size > 0) out.push({ service, env: [...env] })
  }
  return out
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag)
}

export async function which(bin: string): Promise<boolean> {
  const result = await $`command -v ${bin}`.quiet().nothrow()
  return result.exitCode === 0
}

export type CmdResult = {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

export async function run(
  cmd: string[],
  opts?: { env?: Record<string, string | undefined>; stdin?: string },
): Promise<CmdResult> {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    env: { ...process.env, ...opts?.env },
    stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (opts?.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin)
    proc.stdin.end()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  }
}

export async function ghSecretNames(repo: string): Promise<{ names?: string[]; error?: string }> {
  const result = await run(["gh", "secret", "list", "--repo", repo, "--json", "name"])
  if (!result.ok) {
    return {
      error: redactSecrets(result.stderr || result.stdout || "gh secret list failed"),
    }
  }
  try {
    const rows = JSON.parse(result.stdout) as Array<{ name: string }>
    return { names: rows.map((r) => r.name) }
  } catch {
    return { error: "Failed to parse gh secret list JSON" }
  }
}

export async function ghAuthOk(): Promise<{ ok: boolean; error?: string }> {
  const result = await run(["gh", "auth", "status"])
  if (!result.ok) {
    return {
      ok: false,
      error: redactSecrets(result.stderr || result.stdout || "gh auth status failed"),
    }
  }
  return { ok: true }
}

/** Strip likely token-shaped substrings from error output. */
export function redactSecrets(text: string): string {
  return text
    .replace(/npm_[A-Za-z0-9]{20,}/g, "[REDACTED_NPM_TOKEN]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED_GH_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH_TOKEN]")
}

export function printCheck(result: CheckResult): void {
  const tag =
    result.status === "pass"
      ? "PASS"
      : result.status === "fail"
        ? "FAIL"
        : result.status === "warn"
          ? "WARN"
          : "SKIP"
  console.log(`[${tag}] ${result.id}: ${result.message}`)
  if (result.details?.length) {
    for (const line of result.details) {
      console.log(`       ${line}`)
    }
  }
}

export function printObtain(entry: SecretEntry | ChecklistEntry): void {
  if ("obtain" in entry) {
    console.log(`  ${entry.obtain.title}`)
    for (const url of entry.obtain.urls) {
      console.log(`    ${url}`)
    }
    for (const step of entry.obtain.steps) {
      console.log(`    - ${step}`)
    }
    return
  }
  console.log(`  ${entry.description}`)
  for (const url of entry.urls) {
    console.log(`    ${url}`)
  }
  for (const step of entry.steps) {
    console.log(`    - ${step}`)
  }
}

export function printPopulate(entry: SecretEntry): void {
  console.log("  Populate .env.local:")
  for (const line of entry.populate.env_local.trim().split("\n")) {
    console.log(`    ${line}`)
  }
  console.log("  Populate GitHub Actions secret:")
  for (const line of entry.populate.github.trim().split("\n")) {
    console.log(`    ${line}`)
  }
}

export function localEnvStatus(names: string[]): { set: string[]; unset: string[] } {
  const set: string[] = []
  const unset: string[] = []
  for (const name of names) {
    if (process.env[name]?.trim()) {
      set.push(name)
    } else {
      unset.push(name)
    }
  }
  return { set, unset }
}

/** Parse a dotenv-format file. Minimal: `KEY=value` lines, `#` comments, blank lines skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** Read `.env.local`; returns `{}` if the file does not exist. Values only in memory. */
export async function readEnvLocal(): Promise<Record<string, string>> {
  if (!existsSync(ENV_LOCAL_PATH)) return {}
  return parseEnvFile(await Bun.file(ENV_LOCAL_PATH).text())
}

/**
 * Merge `updates` into `.env.local`, preserving existing lines/comments/order and appending
 * any new keys at the end. Creates the file if it does not exist. Never logs values.
 */
export async function upsertEnvLocal(updates: Record<string, string>): Promise<void> {
  const existing = existsSync(ENV_LOCAL_PATH) ? await Bun.file(ENV_LOCAL_PATH).text() : ""
  const lines = existing.length > 0 ? existing.split("\n") : []
  const remaining = new Map(Object.entries(updates))

  const nextLines = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return line
    const eq = trimmed.indexOf("=")
    if (eq === -1) return line
    const key = trimmed.slice(0, eq).trim()
    if (!remaining.has(key)) return line
    const value = remaining.get(key) as string
    remaining.delete(key)
    return `${key}=${value}`
  })

  if (nextLines.length > 0 && nextLines.at(-1) !== "") nextLines.push("")
  for (const [key, value] of remaining) {
    nextLines.push(`${key}=${value}`)
  }

  await Bun.write(ENV_LOCAL_PATH, nextLines.join("\n"))
}
