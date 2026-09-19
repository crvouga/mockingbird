/**
 * Validate required secrets exist in Vault (presence only; values never printed).
 */
import {
  type CheckResult,
  loadManifest,
  loadVaultConfig,
  printCheck,
  printObtain,
  printPopulate,
  vaultFieldPresent,
  vaultTokenOk,
  which,
} from "./lib.ts";

const results: CheckResult[] = [];

if (!(await which("vault"))) {
  results.push({
    id: "vault-cli",
    status: "fail",
    message: "vault CLI not found on PATH",
    details: [
      "Install: https://developer.hashicorp.com/vault/docs/install",
      "Then: export VAULT_ADDR from .vault.yaml and vault login",
    ],
  });
  for (const r of results) printCheck(r);
  process.exit(1);
}

const cfg = await loadVaultConfig();
const manifest = await loadManifest();

const auth = await vaultTokenOk(cfg);
if (!auth.ok) {
  results.push({
    id: "vault-auth",
    status: "fail",
    message: "Not authenticated to Vault",
    details: [
      `VAULT_ADDR=${process.env.VAULT_ADDR?.trim() || cfg.addr}`,
      auth.error ?? "vault token lookup failed",
      "Fix: vault login  (or set VAULT_TOKEN)",
      "Docs: https://developer.hashicorp.com/vault/docs/commands/login",
    ],
  });
  for (const r of results) printCheck(r);
  process.exit(1);
}

results.push({
  id: "vault-auth",
  status: "pass",
  message: `Authenticated (VAULT_ADDR=${process.env.VAULT_ADDR?.trim() || cfg.addr})`,
});

for (const entry of manifest.secrets) {
  const { present, error } = await vaultFieldPresent(cfg, entry.vault.path, entry.vault.key);
  if (present) {
    results.push({
      id: `vault:${entry.id}`,
      status: "pass",
      message: `${cfg.mount}/${entry.vault.path}#${entry.vault.key} present`,
    });
    continue;
  }

  const details = [
    error ?? "missing",
    `Expected: vault kv get -mount=${cfg.mount} -field=${entry.vault.key} ${entry.vault.path}`,
  ];
  if (entry.required) {
    results.push({
      id: `vault:${entry.id}`,
      status: "fail",
      message: `${entry.description} missing in Vault`,
      details,
    });
    printCheck(results[results.length - 1]!);
    printObtain(entry);
    printPopulate(entry);
    continue;
  }

  results.push({
    id: `vault:${entry.id}`,
    status: "warn",
    message: `Optional ${entry.id} missing in Vault`,
    details,
  });
}

for (const r of results) {
  if (r.id.startsWith("vault:") && r.status === "fail") continue; // already printed with guidance
  printCheck(r);
}

const failed = results.some((r) => r.status === "fail");
process.exit(failed ? 1 : 0);
