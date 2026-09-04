/**
 * Full maintainer secrets doctor: Vault + GitHub + local env + OIDC checklist.
 * Prints linked obtain/populate instructions for anything missing.
 */
import {
  type CheckResult,
  ghAuthOk,
  ghSecretNames,
  loadManifest,
  loadVaultConfig,
  localEnvStatus,
  NPM_PACKAGE,
  NPM_PACKAGE_URL,
  NPM_TRUSTED_PUBLISHER_URL,
  npmViewVersion,
  printCheck,
  printObtain,
  printPopulate,
  vaultFieldPresent,
  vaultTokenOk,
  which,
} from "./lib.ts";

console.log("postgres-mem secrets doctor");
console.log("=========================");
console.log("Publish path: npm Trusted Publishing (OIDC) — no NPM_TOKEN.");
console.log("Values are never printed. See docs/SECRETS.md for the full runbook.");
console.log("");

const results: CheckResult[] = [];
const cfg = await loadVaultConfig();
const manifest = await loadManifest();

console.log(`Vault: ${process.env.VAULT_ADDR?.trim() || cfg.addr}`);
console.log(`Mount: ${cfg.mount}  project=${cfg.project}  config=${cfg.config}`);
console.log(`Repo:  ${manifest.repo}`);
console.log("");

const npmInfo = await npmViewVersion(NPM_PACKAGE);
if (npmInfo.error) {
  results.push({
    id: "npm:registry",
    status: "warn",
    message: `Could not query npm for ${NPM_PACKAGE}`,
    details: [npmInfo.error],
  });
} else if (npmInfo.missing) {
  results.push({
    id: "npm:registry",
    status: "fail",
    message: `${NPM_PACKAGE} is not on the npm registry yet`,
    details: [
      "Trusted Publisher can only be configured after the package exists.",
      "One-time seed from your npm login (no Automation token):",
      "  bun run npm:seed -- --dry-run",
      "  bun run npm:seed -- --yes",
      "Then: npm login if prompted, then enable Trusted Publisher.",
    ],
  });
} else {
  results.push({
    id: "npm:registry",
    status: "pass",
    message: `${NPM_PACKAGE}@${npmInfo.version} exists on npm`,
    details: [NPM_PACKAGE_URL, `Trusted Publisher: ${NPM_TRUSTED_PUBLISHER_URL}`],
  });
}

// --- Tooling ---
const hasVault = await which("vault");
const hasGh = await which("gh");

if (!hasVault) {
  results.push({
    id: "tool:vault",
    status: "fail",
    message: "vault CLI missing",
    details: ["https://developer.hashicorp.com/vault/docs/install"],
  });
} else {
  results.push({ id: "tool:vault", status: "pass", message: "vault CLI found" });
}

if (!hasGh) {
  results.push({
    id: "tool:gh",
    status: "fail",
    message: "gh CLI missing",
    details: ["https://cli.github.com/"],
  });
} else {
  results.push({ id: "tool:gh", status: "pass", message: "gh CLI found" });
}

// --- Vault ---
let vaultReady = false;
if (hasVault) {
  const auth = await vaultTokenOk(cfg);
  if (!auth.ok) {
    results.push({
      id: "vault-auth",
      status: "fail",
      message: "Vault not authenticated",
      details: [
        auth.error ?? "token lookup failed",
        `export VAULT_ADDR=${cfg.addr}`,
        "vault login",
        "https://developer.hashicorp.com/vault/docs/commands/login",
      ],
    });
  } else {
    vaultReady = true;
    results.push({ id: "vault-auth", status: "pass", message: "Vault authenticated" });
  }
}

if (vaultReady) {
  for (const entry of manifest.secrets) {
    const { present, error } = await vaultFieldPresent(cfg, entry.vault.path, entry.vault.key);
    if (present) {
      results.push({
        id: `vault:${entry.id}`,
        status: "pass",
        message: `${entry.vault.path}#${entry.vault.key} present`,
      });
    } else if (entry.required) {
      results.push({
        id: `vault:${entry.id}`,
        status: "fail",
        message: `Required Vault secret missing: ${entry.id}`,
        details: [error ?? "missing"],
      });
    } else {
      results.push({
        id: `vault:${entry.id}`,
        status: "warn",
        message: `Optional Vault secret missing: ${entry.id}`,
        details: [error ?? "missing"],
      });
    }
  }
} else {
  for (const entry of manifest.secrets) {
    results.push({
      id: `vault:${entry.id}`,
      status: "skip",
      message: `Skipped Vault check for ${entry.id} (CLI/auth unavailable)`,
    });
  }
}

// --- GitHub ---
let ghNames: Set<string> | null = null;
if (hasGh) {
  const auth = await ghAuthOk();
  if (!auth.ok) {
    results.push({
      id: "gh-auth",
      status: "fail",
      message: "gh not authenticated",
      details: [auth.error ?? "auth failed", "gh auth login"],
    });
  } else {
    results.push({ id: "gh-auth", status: "pass", message: "gh authenticated" });
    const listed = await ghSecretNames(manifest.repo);
    if (!listed.names) {
      results.push({
        id: "gh-secrets",
        status: "fail",
        message: "Cannot list repo secrets",
        details: [listed.error ?? "list failed", `https://github.com/${manifest.repo}/settings/secrets/actions`],
      });
    } else {
      ghNames = new Set(listed.names);
      results.push({
        id: "gh-secrets",
        status: "pass",
        message: `${ghNames.size} secret name(s) listed`,
      });
    }
  }
}

for (const entry of manifest.secrets) {
  const ghName = entry.github.name;
  if (!ghName) {
    results.push({
      id: `github:${entry.id}`,
      status: "skip",
      message: `${entry.id} not mapped to Actions secrets`,
    });
    continue;
  }
  if (!ghNames) {
    results.push({
      id: `github:${entry.id}`,
      status: "skip",
      message: `Skipped GitHub check for ${ghName}`,
    });
    continue;
  }
  if (ghNames.has(ghName)) {
    results.push({
      id: `github:${entry.id}`,
      status: "pass",
      message: `Actions secret ${ghName} exists`,
    });
  } else if (entry.github.required) {
    results.push({
      id: `github:${entry.id}`,
      status: "fail",
      message: `Required Actions secret missing: ${ghName}`,
      details: [`https://github.com/${manifest.repo}/settings/secrets/actions`, "bun run secrets:sync -- --yes"],
    });
  } else {
    results.push({
      id: `github:${entry.id}`,
      status: "warn",
      message: `Optional Actions secret missing: ${ghName}`,
    });
  }
}

results.push({
  id: "github:GITHUB_TOKEN",
  status: "pass",
  message: "Actions GITHUB_TOKEN is automatic (no repo secret)",
});

// --- Local env ---
console.log("--- Checks ---");
for (const r of results) {
  printCheck(r);
}

console.log("");
console.log("--- Local environment (for release:dry-run) ---");
for (const entry of manifest.secrets) {
  const { set, unset } = localEnvStatus(entry.local_env);
  if (set.length > 0) {
    printCheck({
      id: `local:${entry.id}`,
      status: "pass",
      message: `set: ${set.join(", ")}`,
    });
  } else if (entry.required) {
    printCheck({
      id: `local:${entry.id}`,
      status: "warn",
      message: `none of ${entry.local_env.join(" / ")} set in this shell`,
      details: [
        "CI does not need local env. For dry-run:",
        `  export ${entry.local_env[0]}="$(vault kv get -mount=${cfg.mount} -field=${entry.vault.key} ${entry.vault.path})"`,
      ],
    });
  } else {
    printCheck({
      id: `local:${entry.id}`,
      status: "skip",
      message: `optional unset (${unset.join(", ")})`,
    });
  }
}

console.log("");
console.log("--- External checklists (manual) ---");
for (const item of manifest.checklists) {
  const status = item.required ? "warn" : "skip";
  printCheck({
    id: `checklist:${item.id}`,
    status,
    message: item.required ? `${item.description} — confirm in npm UI (not auto-verified)` : item.description,
  });
  printObtain(item);
}

console.log("");
console.log("--- Publish path ---");
printCheck({
  id: "publish:oidc",
  status: "pass",
  message: "CI publish uses Trusted Publishing + id-token (no NPM_TOKEN repo secret)",
  details: ["https://docs.npmjs.com/trusted-publishers", "Do not create a Granular Access Token for CI/CD"],
});

// Guidance for failures
const failedEntries = results.filter((r) => r.status === "fail");
const requiredChecklists = manifest.checklists.filter((c) => c.required);
if (failedEntries.length > 0 || requiredChecklists.length > 0) {
  console.log("");
  console.log("--- How to fix ---");
  if (requiredChecklists.length > 0) {
    console.log("");
    console.log("# Trusted Publishing (required for CI publish)");
    if (results.some((r) => r.id === "npm:registry" && r.status === "fail")) {
      console.log("  Seed the package first (one-time local publish):");
      console.log("    bun run npm:seed -- --yes");
      console.log("  Then configure Trusted Publisher:");
    }
    for (const item of requiredChecklists) {
      printObtain(item);
    }
  }
  for (const entry of manifest.secrets) {
    const vaultFail = failedEntries.some((r) => r.id === `vault:${entry.id}`);
    const ghFail = failedEntries.some((r) => r.id === `github:${entry.id}`);
    if (!vaultFail && !ghFail) continue;
    console.log("");
    console.log(`# ${entry.id} — ${entry.description}`);
    printObtain(entry);
    printPopulate(entry);
  }
  const syncable = manifest.secrets.some((s) => s.github.name);
  if (syncable && failedEntries.some((r) => r.id.startsWith("github:"))) {
    console.log("");
    console.log("After populating Vault, sync to GitHub:");
    console.log("  bun run secrets:sync -- --yes");
  }
  console.log("");
  console.log("Full runbook: docs/SECRETS.md");
}

const hardFail = results.some((r) => r.status === "fail");
console.log("");
console.log(hardFail ? "secrets:doctor FAILED" : "secrets:doctor OK (confirm Trusted Publishing in npm UI)");
process.exit(hardFail ? 1 : 0);
