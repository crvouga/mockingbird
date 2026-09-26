/**
 * Bootstrap npm publishing credentials and start a fresh CI release on main.
 *
 * The token is read from a TTY without echo, validated with npm, and written to the
 * NPM_TOKEN GitHub Actions repo secret over stdin (`gh secret set`). The release job reads it
 * from there. It is never passed on the command line or printed.
 *
 *   bun run release:bootstrap            # store NPM_TOKEN only if the repo secret is missing
 *   bun run release:bootstrap -- --replace
 */
import {
  ghAuthOk,
  ghSecretNames,
  loadManifest,
  readSecret,
  redactSecrets,
  root,
  run,
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

async function ensureGitHubAuth(): Promise<void> {
  if ((await ghAuthOk()).ok) return
  console.log("GitHub CLI login required.")
  await inherited(["gh", "auth", "login"])
  const retry = await ghAuthOk()
  if (!retry.ok) throw new Error(`GitHub authentication failed: ${retry.error}`)
}

async function ensureNpmToken(replace: boolean): Promise<void> {
  const manifest = await loadManifest()
  const entry = manifest.secrets.find(({ id }) => id === "npm_token")
  const key = entry?.github.name
  if (!key) throw new Error("secrets.manifest.yaml has no npm_token GitHub secret")

  const listed = await ghSecretNames(manifest.repo)
  if (!listed.names) throw new Error(`Cannot list ${manifest.repo} secrets: ${listed.error}`)
  if (listed.names.includes(key) && !replace) {
    console.log(`[PASS] ${key} repo secret exists (pass --replace to rotate it)`)
    return
  }

  console.log("Create an npm granular access token:")
  console.log(`  ${TOKEN_URL}`)
  console.log("  Packages and scopes: read and write for @crvouga")
  console.log("  Enable bypass 2FA so GitHub Actions can bootstrap packages")
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Missing ${key} repo secret; create the token at ${TOKEN_URL}, then run this command in a terminal`,
    )
  }
  const token = (await readSecret("Paste token (input hidden): ")).trim()
  if (!token) throw new Error("NPM_TOKEN cannot be empty")

  if (!(await npmAccepts(token))) throw new Error("npm rejected the token")

  const stored = await run(["gh", "secret", "set", key, "--repo", manifest.repo], {
    stdin: token,
  })
  if (!stored.ok) {
    throw new Error(`Could not set ${key}: ${redactSecrets(stored.stderr || stored.stdout)}`)
  }
  console.log(`[PASS] stored ${key} as a ${manifest.repo} repo secret`)
}

async function npmAccepts(token: string): Promise<boolean> {
  const response = await fetch("https://registry.npmjs.org/-/whoami", {
    headers: { authorization: `Bearer ${token}` },
  })
  return response.ok
}

async function dispatchedRun(repo: string, after: number): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await run([
      "gh",
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      "ci.yml",
      "--event",
      "workflow_dispatch",
      "--branch",
      "main",
      "--limit",
      "5",
      "--json",
      "databaseId,createdAt",
    ])
    if (!result.ok) throw new Error(`Could not find dispatched CI run: ${result.stderr}`)
    const runs = JSON.parse(result.stdout) as Array<{ databaseId: number; createdAt: string }>
    const fresh = runs.find((entry) => Date.parse(entry.createdAt) >= after - 2000)
    if (fresh) return String(fresh.databaseId)
    await Bun.sleep(2000)
  }
  throw new Error("CI was dispatched, but its new run did not appear within one minute")
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: bun run release:bootstrap [-- --replace]")
    console.log("Stores NPM_TOKEN as a GitHub Actions repo secret, then runs current CI on main.")
    return
  }

  if (!(await which("gh"))) throw new Error("gh CLI is required but was not found")

  await ensureGitHubAuth()
  await ensureNpmToken(process.argv.includes("--replace"))

  const { repo } = await loadManifest()
  const dispatchedAt = Date.now()
  console.log(`Starting current CI on ${repo}/main...`)
  await inherited(["gh", "workflow", "run", "ci.yml", "--repo", repo, "--ref", "main"])
  const runId = await dispatchedRun(repo, dispatchedAt)
  await inherited(["gh", "run", "watch", runId, "--repo", repo, "--exit-status"])
}

try {
  await main()
} catch (error) {
  console.error(
    `release:bootstrap: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
  )
  process.exit(1)
}
