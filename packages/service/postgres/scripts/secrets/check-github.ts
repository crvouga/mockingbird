/**
 * Validate GitHub Actions repo secret *names* exist (values are write-only).
 */
import {
  type CheckResult,
  ghAuthOk,
  ghSecretNames,
  loadManifest,
  printCheck,
  printObtain,
  printPopulate,
  which,
} from "./lib.ts";

const results: CheckResult[] = [];

if (!(await which("gh"))) {
  results.push({
    id: "gh-cli",
    status: "fail",
    message: "gh CLI not found on PATH",
    details: ["Install: https://cli.github.com/", "Then: gh auth login"],
  });
  for (const r of results) printCheck(r);
  process.exit(1);
}

const auth = await ghAuthOk();
if (!auth.ok) {
  results.push({
    id: "gh-auth",
    status: "fail",
    message: "Not authenticated to GitHub CLI",
    details: [auth.error ?? "gh auth status failed", "Fix: gh auth login"],
  });
  for (const r of results) printCheck(r);
  process.exit(1);
}

results.push({ id: "gh-auth", status: "pass", message: "gh authenticated" });

const manifest = await loadManifest();
const listed = await ghSecretNames(manifest.repo);
if (!listed.names) {
  results.push({
    id: "gh-secrets-list",
    status: "fail",
    message: `Cannot list secrets for ${manifest.repo}`,
    details: [listed.error ?? "unknown error", `UI: https://github.com/${manifest.repo}/settings/secrets/actions`],
  });
  for (const r of results) printCheck(r);
  process.exit(1);
}

const names = new Set(listed.names);
results.push({
  id: "gh-secrets-list",
  status: "pass",
  message: `Listed ${names.size} secret name(s) on ${manifest.repo}`,
});

for (const entry of manifest.secrets) {
  const ghName = entry.github.name;
  if (!ghName) {
    results.push({
      id: `github:${entry.id}`,
      status: "skip",
      message: `${entry.id} is not a GitHub Actions repo secret (local/Vault only)`,
    });
    continue;
  }

  if (names.has(ghName)) {
    results.push({
      id: `github:${entry.id}`,
      status: "pass",
      message: `Repo secret ${ghName} exists (value not readable)`,
    });
    continue;
  }

  const details = [
    `Missing Actions secret: ${ghName}`,
    `UI: https://github.com/${manifest.repo}/settings/secrets/actions`,
    "Or sync from Vault: bun run secrets:sync -- --yes",
  ];

  if (entry.github.required) {
    results.push({
      id: `github:${entry.id}`,
      status: "fail",
      message: `Required GitHub secret ${ghName} not found`,
      details,
    });
    printCheck(results[results.length - 1]!);
    printObtain(entry);
    printPopulate(entry);
    continue;
  }

  results.push({
    id: `github:${entry.id}`,
    status: "warn",
    message: `Optional GitHub secret ${ghName} not found`,
    details,
  });
}

results.push({
  id: "github:GITHUB_TOKEN",
  status: "pass",
  message: "GITHUB_TOKEN is built into Actions (no repo secret needed)",
  details: [
    "Publish uses npm Trusted Publishing (OIDC) — do not set NPM_TOKEN",
    "Release job already sets permissions.contents/issues/pull-requests/id-token",
    `Workflow: https://github.com/${manifest.repo}/blob/main/.github/workflows/ci.yml`,
  ],
});

const requiredGh = manifest.secrets.filter((s) => s.github.name && s.github.required);
if (requiredGh.length === 0) {
  results.push({
    id: "github:no-required-secrets",
    status: "pass",
    message: "No required Actions secrets (Trusted Publishing + GITHUB_TOKEN)",
  });
}

for (const r of results) {
  if (r.id.startsWith("github:") && r.status === "fail") continue;
  printCheck(r);
}

const failed = results.some((r) => r.status === "fail");
process.exit(failed ? 1 : 0);
