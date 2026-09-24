/**
 * Tiny CLI over the secret source of truth: GitHub Actions repo secrets.
 * Values go to `gh secret set` over stdin; they are never printed or put on a command line.
 *
 *   bun run secrets                          # status: which secrets are set, per service
 *   bun run secrets status [service…]
 *   bun run secrets set NAME [NAME…]         # prompt without echo for each value
 *   echo -n "$VALUE" | bun run secrets set NAME
 *   bun run secrets set NAME --from-env      # take the value from .env.local (or the env)
 *   bun run secrets fill [service…]          # prompt for every missing parity key (Enter skips)
 *   bun run secrets rm NAME [NAME…] --yes
 *   bun run secrets push [--dry-run|--yes]   # .env.local → GitHub (secrets:push)
 *   bun run secrets doctor                   # full report (secrets:doctor)
 */
import { join } from "node:path"
import {
  ghAuthOk,
  ghSecretNames,
  hasFlag,
  isGitHubSecretEntry,
  loadManifest,
  PARITY_SECRET_PREFIX,
  parityRequirements,
  readEnvLocal,
  readSecret,
  redactSecrets,
  root,
  run,
  which,
} from "./lib.ts"

const USAGE = `Usage: bun run secrets <command>

  status [service…]           which secrets are set on GitHub and in .env.local (default)
  set NAME [NAME…]            prompt (hidden) for each value, store it as a repo secret
                              piped stdin sets a single NAME; --from-env reads .env.local
  fill [service…]             prompt for every parity key missing on GitHub (Enter skips)
  rm NAME [NAME…] --yes       delete repo secrets
  push [--dry-run|--yes]      upload every value set in .env.local
  doctor                      full report, including npm and Trusted Publishing

Source of truth: GitHub Actions repo secrets (docs/SECRETS.md). Values are never printed.`

/** Secrets the vendor ships under its own names (see .github/workflows/parity.yml). */
const EXTRA_PREFIXES = ["GENE_BY_GENE_"]

const [command = "status", ...rest] = process.argv.slice(2)
const flags = rest.filter((arg) => arg.startsWith("-"))
const args = rest.filter((arg) => !arg.startsWith("-"))

function fail(message: string): never {
  console.error(`secrets: ${redactSecrets(message)}`)
  process.exit(1)
}

function assertName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) fail(`${name} is not a valid secret name (A-Z, 0-9, _)`)
  if (name.startsWith("GITHUB_")) fail(`${name}: GitHub reserves the GITHUB_ prefix`)
}

async function repo(): Promise<string> {
  if (!(await which("gh"))) fail("gh CLI not found — https://cli.github.com/")
  const auth = await ghAuthOk()
  if (!auth.ok) fail(`gh is not authenticated (${auth.error}); run: gh auth login`)
  return (await loadManifest()).repo
}

async function remoteNames(repoName: string): Promise<Set<string>> {
  const listed = await ghSecretNames(repoName)
  if (!listed.names) fail(`cannot list ${repoName} secrets (needs write access): ${listed.error}`)
  return new Set(listed.names)
}

async function setSecret(repoName: string, name: string, value: string): Promise<boolean> {
  const result = await run(["gh", "secret", "set", name, "--repo", repoName], { stdin: value })
  if (!result.ok) {
    console.error(`[FAIL] ${name}: ${redactSecrets(result.stderr || result.stdout)}`)
    return false
  }
  console.log(`[PASS] set ${name} on ${repoName}`)
  return true
}

/** Known secrets grouped by where they come from: manifest, each parity service, extras. */
async function groups(remote: Set<string>): Promise<Array<{ group: string; names: string[] }>> {
  const manifest = await loadManifest()
  const out = [
    {
      group: "release",
      names: manifest.secrets.filter(isGitHubSecretEntry).map((entry) => entry.github.name),
    },
    ...parityRequirements().map(({ service, env }) => ({ group: service, names: env })),
  ]
  const known = new Set(out.flatMap(({ names }) => names))
  const extras = [...remote].filter(
    (name) =>
      !known.has(name) &&
      [PARITY_SECRET_PREFIX, ...EXTRA_PREFIXES].some((prefix) => name.startsWith(prefix)),
  )
  if (extras.length > 0) out.push({ group: "other", names: extras.sort() })
  return out
}

function pick<T extends { group: string }>(all: T[], wanted: string[]): T[] {
  if (wanted.length === 0) return all
  const unknown = wanted.filter((name) => !all.some(({ group }) => group === name))
  if (unknown.length > 0)
    fail(`unknown service(s): ${unknown.join(", ")}. Known: ${all.map((g) => g.group).join(", ")}`)
  return all.filter(({ group }) => wanted.includes(group))
}

async function status(): Promise<void> {
  const repoName = await repo()
  const remote = await remoteNames(repoName)
  const local = await readEnvLocal()
  const isLocal = (name: string) => Boolean(local[name]?.trim() || process.env[name]?.trim())
  console.log(`${repoName} — github = repo secret, local = .env.local / env`)
  for (const { group, names } of pick(await groups(remote), args)) {
    console.log(`\n${group}`)
    for (const name of names) {
      const github = remote.has(name) ? "set" : "missing"
      const env = isLocal(name) ? "set" : "-"
      console.log(`  ${name.padEnd(48)} github: ${github.padEnd(8)} local: ${env}`)
    }
  }
}

async function set(): Promise<void> {
  if (args.length === 0) fail("set needs at least one NAME")
  for (const name of args) assertName(name)
  const repoName = await repo()
  let ok = true

  if (hasFlag(flags, "--from-env")) {
    const local = await readEnvLocal()
    for (const name of args) {
      const value = local[name]?.trim() ? local[name] : process.env[name]
      if (!value?.trim()) {
        console.error(`[FAIL] ${name}: not set in .env.local or the environment`)
        ok = false
        continue
      }
      ok = (await setSecret(repoName, name, value)) && ok
    }
  } else if (!process.stdin.isTTY) {
    if (args.length !== 1) fail("piped stdin can only set one NAME")
    const value = (await Bun.stdin.text()).replace(/\r?\n$/, "")
    if (!value) fail("stdin was empty")
    ok = await setSecret(repoName, args[0] as string, value)
  } else {
    for (const name of args) {
      const value = await readSecret(`${name} (hidden): `)
      if (!value) {
        console.log(`[SKIP] ${name}: empty`)
        continue
      }
      ok = (await setSecret(repoName, name, value)) && ok
    }
  }
  if (!ok) process.exit(1)
}

async function fill(): Promise<void> {
  if (!process.stdin.isTTY) fail("fill prompts for values; run it in a terminal")
  const repoName = await repo()
  const remote = await remoteNames(repoName)
  const missing = pick(await groups(remote), args).flatMap(({ group, names }) =>
    names.filter((name) => !remote.has(name)).map((name) => ({ group, name })),
  )
  if (missing.length === 0) {
    console.log("Nothing missing.")
    return
  }
  console.log(`${missing.length} secret(s) missing on ${repoName}. Enter skips one.`)
  let ok = true
  for (const { group, name } of missing) {
    const value = await readSecret(`[${group}] ${name}: `)
    if (!value) continue
    ok = (await setSecret(repoName, name, value)) && ok
  }
  if (!ok) process.exit(1)
}

async function rm(): Promise<void> {
  if (args.length === 0) fail("rm needs at least one NAME")
  if (!hasFlag(flags, "--yes")) fail(`refusing to delete ${args.join(", ")} without --yes`)
  for (const name of args) assertName(name)
  const repoName = await repo()
  let ok = true
  for (const name of args) {
    const result = await run(["gh", "secret", "delete", name, "--repo", repoName])
    if (result.ok) console.log(`[PASS] deleted ${name} from ${repoName}`)
    else {
      console.error(`[FAIL] ${name}: ${redactSecrets(result.stderr || result.stdout)}`)
      ok = false
    }
  }
  if (!ok) process.exit(1)
}

async function delegate(script: string): Promise<void> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, script), ...rest], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  })
  process.exit(await proc.exited)
}

const commands: Record<string, () => Promise<void>> = {
  status,
  ls: status,
  set,
  fill,
  rm,
  push: () => delegate("push-env.ts"),
  doctor: () => delegate("doctor.ts"),
}

if (command === "help" || command === "--help" || command === "-h") {
  console.log(USAGE)
} else if (commands[command]) {
  try {
    await commands[command]()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
} else {
  console.error(USAGE)
  process.exit(2)
}
