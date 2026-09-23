/**
 * Log in to the self-hosted Vault/OpenBao instance using userpass auth.
 * The Vault CLI prompts securely for the password; it is never captured here.
 *   bun run vault:login
 *
 * The username defaults to `crvouga`; pass a different username as the first
 * argument when needed. Vault/OpenBao prompts securely for the password.
 */
import { loadVaultConfig, vaultEnv } from "./secrets/lib.ts"

const username = process.argv[2]?.trim() || "crvouga"

const cfg = await loadVaultConfig()
const proc = Bun.spawn(["vault", "login", "-method=userpass", `username=${username}`], {
  cwd: process.cwd(),
  env: { ...process.env, ...vaultEnv(cfg) },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

const exitCode = await proc.exited
if (exitCode !== 0) process.exit(exitCode)
console.log(`Vault login succeeded for ${username} at ${vaultEnv(cfg).VAULT_ADDR}`)
