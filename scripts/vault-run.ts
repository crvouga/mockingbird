/**
 * Run a command with this repo's Vault secrets injected (`vault run`, config from .vault.yaml).
 *
 * Root turbo scripts go through here so local runs share the self-hosted Turborepo remote
 * cache (TURBO_API / TURBO_TOKEN / TURBO_TEAM / TURBO_CACHE live in Vault
 * `secret/personal/<config>`). Shared infra contract:
 * https://raw.githubusercontent.com/crvouga/workspace/main/INTEGRATING.md
 *
 * Runs the command as-is when the environment already carries the secrets (CI loads them via
 * GitHub OIDC; an outer `vault run`), or when the `vault` wrapper is not installed (turbo then
 * uses only its local cache). A `vault run` failure (e.g. expired login) is not swallowed.
 *
 *   bun scripts/vault-run.ts [--config prd] -- <command> [args...]
 */
import { $ } from "bun"

const argv = process.argv.slice(2)
const sep = argv.indexOf("--")
const flags = sep === -1 ? [] : argv.slice(0, sep)
const cmd = sep === -1 ? argv : argv.slice(sep + 1)
if (cmd.length === 0) {
  console.error("usage: bun scripts/vault-run.ts [--config <name>] -- <command> [args...]")
  process.exit(2)
}

const injected = process.env.TURBO_TOKEN?.trim() || process.env.CI === "true"
const hasVault = (await $`command -v vault`.quiet().nothrow()).exitCode === 0

let full = cmd
if (!injected && hasVault) {
  full = ["vault", "run", ...flags, "--", ...cmd]
} else if (!injected) {
  console.warn(
    "vault-run: `vault` not on PATH — running without Vault secrets (no Turborepo remote cache).\n" +
      "  Install once from a crvouga/workspace checkout: packages/vault-service/scripts/install-cli.sh\n" +
      "  then: bun run vault:login",
  )
}

const proc = Bun.spawn(full, { stdio: ["inherit", "inherit", "inherit"] })
const code = await proc.exited
if (code !== 0 && full[0] === "vault" && full[1] === "run") {
  console.error(
    "vault-run: if `vault run` itself failed (403 / expired token), run `bun run vault:login`; 503 means Vault is sealed — retry shortly.",
  )
}
process.exit(code)
