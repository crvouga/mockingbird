/**
 * Sync Vault secret fields → GitHub Actions repo secrets.
 * Requires --yes. Never prints secret values.
 */
import {
  ghAuthOk,
  hasFlag,
  loadManifest,
  loadVaultConfig,
  run,
  vaultEnv,
  vaultFieldValue,
  vaultTokenOk,
  which,
} from "./lib.ts";

const argv = process.argv.slice(2);
const dryRun = hasFlag(argv, "--dry-run");
const yes = hasFlag(argv, "--yes");

if (!dryRun && !yes) {
  console.error("Refusing to write GitHub secrets without --yes (or use --dry-run).");
  console.error("Usage: bun run secrets:sync -- --yes");
  console.error("       bun run secrets:sync -- --dry-run");
  process.exit(2);
}

if (!(await which("vault"))) {
  console.error("FAIL: vault CLI not found. https://developer.hashicorp.com/vault/docs/install");
  process.exit(1);
}
if (!(await which("gh"))) {
  console.error("FAIL: gh CLI not found. https://cli.github.com/");
  process.exit(1);
}

const cfg = await loadVaultConfig();
const manifest = await loadManifest();

const vaultAuth = await vaultTokenOk(cfg);
if (!vaultAuth.ok) {
  console.error("FAIL: Vault auth:", vaultAuth.error);
  console.error("Fix: export VAULT_ADDR from .vault.yaml && vault login");
  process.exit(1);
}

const ghAuth = await ghAuthOk();
if (!ghAuth.ok) {
  console.error("FAIL: GitHub auth:", ghAuth.error);
  console.error("Fix: gh auth login");
  process.exit(1);
}

const syncable = manifest.secrets.filter((s) => s.github.name);
if (syncable.length === 0) {
  console.log("No secrets mapped to GitHub Actions (Trusted Publishing + built-in GITHUB_TOKEN).");
  console.log("Nothing to sync. See docs/SECRETS.md");
  process.exit(0);
}

let failed = false;

for (const entry of syncable) {
  const ghName = entry.github.name!;
  const label = `${entry.vault.path}#${entry.vault.key} → ${ghName}`;

  if (dryRun) {
    const probe = await vaultFieldValue(cfg, entry.vault.path, entry.vault.key);
    if (probe.error || !probe.value) {
      console.error(`[FAIL] dry-run ${label}: ${probe.error ?? "empty"}`);
      failed = true;
      continue;
    }
    const len = probe.value.length;
    console.log(`[DRY] would set ${ghName} on ${manifest.repo} (vault field length=${len})`);
    continue;
  }

  const { value, error } = await vaultFieldValue(cfg, entry.vault.path, entry.vault.key);
  if (error || value === undefined) {
    console.error(`[FAIL] ${label}: ${error ?? "empty"}`);
    failed = true;
    continue;
  }

  const result = await run(["gh", "secret", "set", ghName, "--repo", manifest.repo], {
    env: vaultEnv(cfg),
    stdin: value,
  });
  // Drop reference to value ASAP
  // (value goes out of scope after this iteration)

  if (!result.ok) {
    console.error(`[FAIL] gh secret set ${ghName}: ${result.stderr || result.stdout}`);
    failed = true;
    continue;
  }

  console.log(`[PASS] set GitHub secret ${ghName} on ${manifest.repo} from Vault`);
}

if (failed) {
  console.error("");
  console.error("Sync incomplete. See docs/SECRETS.md or bun run secrets:doctor");
  process.exit(1);
}

console.log("secrets:sync OK");
process.exit(0);
