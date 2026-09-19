/**
 * Loud preflight checks before semantic-release runs on main.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
let failed = false;

function error(title: string, details: string[]): void {
  failed = true;
  console.error(`::error::${title}`);
  console.error("");
  console.error(`ERROR: ${title}`);
  console.error("=".repeat(72));
  for (const line of details) {
    console.error(line);
  }
  console.error("=".repeat(72));
  console.error("");
}

const npmToken = process.env.NPM_TOKEN?.trim() ?? "";
const inActions = process.env.GITHUB_ACTIONS === "true";
const oidcReady = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);

if (inActions && !npmToken && !oidcReady) {
  error("No npm publish credentials — cannot publish to npm", [
    "semantic-release needs Trusted Publishing (OIDC) for https://registry.npmjs.org",
    "",
    "Configure npm Trusted Publishing (do not create an Automation token):",
    "  1. https://www.npmjs.com/package/@crvouga/sqlite-mem → Settings → Trusted Publisher",
    "  2. Add GitHub Actions publisher:",
    "       Organization/user: crvouga",
    "       Repository: sqlite-mem",
    "       Workflow filename: ci.yml",
    "       Environment: (leave empty unless you use one)",
    "  3. Re-run this workflow (id-token: write is already set on the release job)",
    "",
    "Docs: https://docs.npmjs.com/trusted-publishers",
    "Maintainer checklist: bun run secrets:doctor  →  docs/SECRETS.md",
    "Without this, publish fails with a cryptic npm 401.",
  ]);
}

if (inActions && !npmToken && oidcReady) {
  console.log(
    "release-preflight: NPM_TOKEN unset; using GitHub OIDC (npm Trusted Publishing must be configured for @crvouga/sqlite-mem).",
  );
}

for (const rel of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
  if (!existsSync(join(root, rel))) {
    error(`Missing ${rel} before release`, [
      "The release job must build and verify the package first.",
      "Run locally: bun run build && bun run verify-package",
    ]);
  }
}

const pkg = await Bun.file(join(root, "package.json")).json();
if (pkg.private === true) {
  error('package.json has "private": true', [
    "npm will refuse to publish a private package.",
    'Remove "private" from package.json.',
  ]);
}

if (failed) {
  console.error("release-preflight FAILED — refusing to run semantic-release.");
  process.exit(1);
}

console.log("release-preflight: OK");
console.log("  - build artifacts present");
if (oidcReady) {
  console.log("  - OIDC token endpoint available (Trusted Publishing)");
  if (npmToken) {
    console.log("  - note: NPM_TOKEN is also set but Trusted Publishing is preferred; token not required");
  }
} else if (npmToken) {
  console.log("  - NPM_TOKEN is set (legacy); prefer Trusted Publishing — see docs/SECRETS.md");
} else {
  console.log("  - no npm credentials in this shell (local dry-run / configure Trusted Publishing for CI)");
}
