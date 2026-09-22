/**
 * Bootstrap npm publishing credentials and retry a failed CI release.
 *
 * The token is read from a TTY without echo, validated with npm, written directly
 * to Vault over stdin, and then synced to GitHub by the existing secrets tooling.
 * It is never passed on the command line or printed.
 *
 *   bun run release:fix-ci                 # latest failed CI run on main
 *   bun run release:fix-ci -- 35698422509  # a specific run
 */
import {
  ghAuthOk,
  loadManifest,
  loadVaultConfig,
  redactSecrets,
  root,
  run,
  vaultEnv,
  vaultFieldValue,
  vaultTokenOk,
  which,
} from "../secrets/lib.ts"

const TOKEN_URL = "https://www.npmjs.com/settings/crvouga/tokens/granular-access-tokens/new"

async function inherited(cmd: string[], env?: Record<string, string | undefined>): Promise<void> {
  const code = await Bun.spawn(cmd, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  }).exited
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`)
}

async function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("A terminal is required to enter NPM_TOKEN securely")
  }

  process.stdout.write(label)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  return await new Promise<string>((resolve, reject) => {
    let value = ""
    const cleanup = () => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.off("data", onData)
    }
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup()
          process.stdout.write("\n")
          reject(new Error("Cancelled"))
          return
        }
        if (byte === 10 || byte === 13) {
          cleanup()
          process.stdout.write("\n")
          resolve(value)
          return
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1)
          continue
        }
        value += String.fromCharCode(byte)
      }
    }
    process.stdin.on("data", onData)
  })
}

async function ensureVaultAuth(): Promise<void> {
  const cfg = await loadVaultConfig()
  if ((await vaultTokenOk(cfg)).ok) return
  console.log("Vault login required.")
  await inherited(["bun", "run", "vault:login"])
  const retry = await vaultTokenOk(cfg)
  if (!retry.ok) throw new Error(`Vault authentication failed: ${retry.error}`)
}

async function ensureGitHubAuth(): Promise<void> {
  if ((await ghAuthOk()).ok) return
  console.log("GitHub CLI login required.")
  await inherited(["gh", "auth", "login"])
  const retry = await ghAuthOk()
  if (!retry.ok) throw new Error(`GitHub authentication failed: ${retry.error}`)
}

async function ensureNpmToken(): Promise<void> {
  const cfg = await loadVaultConfig()
  const manifest = await loadManifest()
  const entry = manifest.secrets.find(({ id }) => id === "npm_token")
  if (!entry) throw new Error("secrets.manifest.yaml has no npm_token entry")
  const { path, key } = entry.vault

  const existing = await vaultFieldValue(cfg, path, key)
  if (existing.value && (await npmAccepts(existing.value))) {
    console.log(`[PASS] ${key} at secret/${path} is valid`)
    return
  }
  if (existing.value) {
    console.log(`[WARN] ${key} at secret/${path} is no longer accepted by npm; replacing it`)
  }

  console.log("Create an npm granular access token:")
  console.log(`  ${TOKEN_URL}`)
  console.log("  Packages and scopes: read and write for @crvouga")
  console.log("  Enable bypass 2FA so GitHub Actions can bootstrap packages")
  const token = (await readSecret("Paste token (input hidden): ")).trim()
  if (!token) throw new Error("NPM_TOKEN cannot be empty")

  if (!(await npmAccepts(token))) throw new Error("npm rejected the token")

  const stored = await run(["vault", "kv", "patch", `-mount=${cfg.mount}`, path, `${key}=-`], {
    env: vaultEnv(cfg),
    stdin: token,
  })
  if (!stored.ok) {
    throw new Error(
      `Could not write secret/${path}#${key}: ${redactSecrets(stored.stderr || stored.stdout)}`,
    )
  }
  console.log(`[PASS] stored ${key} at secret/${path}`)
}

async function npmAccepts(token: string): Promise<boolean> {
  const response = await fetch("https://registry.npmjs.org/-/whoami", {
    headers: { authorization: `Bearer ${token}` },
  })
  return response.ok
}

async function failedRun(repo: string): Promise<string> {
  const requested = process.argv.slice(2).find((arg) => /^\d+$/.test(arg))
  if (requested) return requested
  const result = await run([
    "gh",
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    "CI",
    "--branch",
    "main",
    "--status",
    "failure",
    "--limit",
    "1",
    "--json",
    "databaseId",
    "--jq",
    ".[0].databaseId",
  ])
  if (!result.ok || !result.stdout.trim()) {
    throw new Error("No failed CI run found on main; pass a run ID explicitly")
  }
  return result.stdout.trim()
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: bun run release:fix-ci -- [run-id]")
    console.log("Defaults to the latest failed CI run on main.")
    return
  }

  for (const command of ["vault", "gh"]) {
    if (!(await which(command))) throw new Error(`${command} CLI is required but was not found`)
  }

  await ensureVaultAuth()
  await ensureGitHubAuth()
  await ensureNpmToken()

  console.log("Syncing Vault secrets to GitHub Actions...")
  await inherited(["bun", "scripts/secrets/sync-github.ts", "--yes"])

  const { repo } = await loadManifest()
  const runId = await failedRun(repo)
  console.log(`Rerunning failed jobs for ${repo} Actions run ${runId}...`)
  await inherited(["gh", "run", "rerun", runId, "--repo", repo, "--failed"])
  await inherited(["gh", "run", "watch", runId, "--repo", repo, "--exit-status"])
}

try {
  await main()
} catch (error) {
  console.error(
    `release:fix-ci: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
  )
  process.exit(1)
}
