/**
 * Shared helpers for Vault / GitHub secrets tooling.
 * Never print secret values — only names, paths, and status.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

export const root = join(import.meta.dir, "../..");

export type VaultConfig = {
  addr: string;
  mount: string;
  project: string;
  config: string;
};

export type SecretObtain = {
  title: string;
  urls: string[];
  steps: string[];
};

export type SecretEntry = {
  id: string;
  description: string;
  required: boolean;
  vault: { path: string; key: string };
  github: { name: string | null; required: boolean };
  local_env: string[];
  obtain: SecretObtain;
  populate: { vault: string; github: string };
};

export type ChecklistEntry = {
  id: string;
  description: string;
  required: boolean;
  urls: string[];
  steps: string[];
};

export type SecretsManifest = {
  repo: string;
  secrets: SecretEntry[];
  checklists: ChecklistEntry[];
};

export type CheckStatus = "pass" | "fail" | "skip" | "warn";

export type CheckResult = {
  id: string;
  status: CheckStatus;
  message: string;
  details?: string[];
};

function parseYaml<T>(text: string): T {
  const parsed = Bun.YAML.parse(text);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Expected YAML object");
  }
  return parsed as T;
}

export async function loadVaultConfig(): Promise<VaultConfig> {
  const path = join(root, ".vault.yaml");
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}`);
  }
  const cfg = parseYaml<VaultConfig>(await Bun.file(path).text());
  for (const key of ["addr", "mount", "project", "config"] as const) {
    if (!cfg[key] || typeof cfg[key] !== "string") {
      throw new Error(`.vault.yaml missing string field: ${key}`);
    }
  }
  return cfg;
}

export async function loadManifest(): Promise<SecretsManifest> {
  const path = join(root, "secrets.manifest.yaml");
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}`);
  }
  const manifest = parseYaml<SecretsManifest>(await Bun.file(path).text());
  if (!manifest.repo || !Array.isArray(manifest.secrets)) {
    throw new Error("secrets.manifest.yaml must define repo and secrets[]");
  }
  if (!Array.isArray(manifest.checklists)) {
    manifest.checklists = [];
  }
  return manifest;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export async function which(bin: string): Promise<boolean> {
  const result = await $`command -v ${bin}`.quiet().nothrow();
  return result.exitCode === 0;
}

export type CmdResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function run(
  cmd: string[],
  opts?: { env?: Record<string, string | undefined>; stdin?: string },
): Promise<CmdResult> {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    env: { ...process.env, ...opts?.env },
    stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts?.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  };
}

export function vaultEnv(cfg: VaultConfig): Record<string, string> {
  return {
    VAULT_ADDR: process.env.VAULT_ADDR?.trim() || cfg.addr,
  };
}

/** Presence check: non-empty field without printing the value. */
export async function vaultFieldPresent(
  cfg: VaultConfig,
  path: string,
  key: string,
): Promise<{ present: boolean; error?: string }> {
  const env = vaultEnv(cfg);
  const result = await run(["vault", "kv", "get", `-mount=${cfg.mount}`, `-field=${key}`, path], { env });
  if (!result.ok) {
    const err = result.stderr || result.stdout || `exit ${result.exitCode}`;
    return { present: false, error: redactSecrets(err) };
  }
  if (!result.stdout.trim()) {
    return { present: false, error: `Field ${key} is empty at ${path}` };
  }
  return { present: true };
}

/** Read a Vault field for piping into gh secret set. Caller must not log the value. */
export async function vaultFieldValue(
  cfg: VaultConfig,
  path: string,
  key: string,
): Promise<{ value?: string; error?: string }> {
  const env = vaultEnv(cfg);
  const result = await run(["vault", "kv", "get", `-mount=${cfg.mount}`, `-field=${key}`, path], { env });
  if (!result.ok) {
    return {
      error: redactSecrets(result.stderr || result.stdout || `exit ${result.exitCode}`),
    };
  }
  const value = result.stdout;
  if (!value.trim()) {
    return { error: `Field ${key} is empty at ${path}` };
  }
  return { value };
}

export async function vaultTokenOk(cfg: VaultConfig): Promise<{ ok: boolean; error?: string }> {
  const result = await run(["vault", "token", "lookup"], { env: vaultEnv(cfg) });
  if (!result.ok) {
    return {
      ok: false,
      error: redactSecrets(result.stderr || result.stdout || "vault token lookup failed"),
    };
  }
  return { ok: true };
}

export async function ghSecretNames(repo: string): Promise<{ names?: string[]; error?: string }> {
  const result = await run(["gh", "secret", "list", "--repo", repo, "--json", "name"]);
  if (!result.ok) {
    return {
      error: redactSecrets(result.stderr || result.stdout || "gh secret list failed"),
    };
  }
  try {
    const rows = JSON.parse(result.stdout) as Array<{ name: string }>;
    return { names: rows.map((r) => r.name) };
  } catch {
    return { error: "Failed to parse gh secret list JSON" };
  }
}

export async function ghAuthOk(): Promise<{ ok: boolean; error?: string }> {
  const result = await run(["gh", "auth", "status"]);
  if (!result.ok) {
    return {
      ok: false,
      error: redactSecrets(result.stderr || result.stdout || "gh auth status failed"),
    };
  }
  return { ok: true };
}

/** Strip likely token-shaped substrings from error output. */
export function redactSecrets(text: string): string {
  return text
    .replace(/npm_[A-Za-z0-9]{20,}/g, "[REDACTED_NPM_TOKEN]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED_GH_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH_TOKEN]")
    .replace(/hvs\.[A-Za-z0-9_-]{20,}/g, "[REDACTED_VAULT_TOKEN]")
    .replace(/s\.[A-Za-z0-9]{20,}/g, "[REDACTED_VAULT_TOKEN]");
}

export function printCheck(result: CheckResult): void {
  const tag =
    result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : result.status === "warn" ? "WARN" : "SKIP";
  console.log(`[${tag}] ${result.id}: ${result.message}`);
  if (result.details?.length) {
    for (const line of result.details) {
      console.log(`       ${line}`);
    }
  }
}

export function printObtain(entry: SecretEntry | ChecklistEntry): void {
  if ("obtain" in entry) {
    console.log(`  ${entry.obtain.title}`);
    for (const url of entry.obtain.urls) {
      console.log(`    ${url}`);
    }
    for (const step of entry.obtain.steps) {
      console.log(`    - ${step}`);
    }
    return;
  }
  console.log(`  ${entry.description}`);
  for (const url of entry.urls) {
    console.log(`    ${url}`);
  }
  for (const step of entry.steps) {
    console.log(`    - ${step}`);
  }
}

export function printPopulate(entry: SecretEntry): void {
  console.log("  Populate Vault:");
  for (const line of entry.populate.vault.trim().split("\n")) {
    console.log(`    ${line}`);
  }
  console.log("  Populate GitHub / local:");
  for (const line of entry.populate.github.trim().split("\n")) {
    console.log(`    ${line}`);
  }
}

export const NPM_PACKAGE = "@crvouga/sqlite-mem";
export const NPM_SEED_VERSION = "0.1.0";
export const NPM_PACKAGE_URL = "https://www.npmjs.com/package/@crvouga/sqlite-mem";
export const NPM_TRUSTED_PUBLISHER_URL = "https://www.npmjs.com/package/@crvouga/sqlite-mem/access";

export async function npmViewVersion(name: string): Promise<{ version?: string; missing: boolean; error?: string }> {
  const result = await run(["npm", "view", name, "version", "--registry", "https://registry.npmjs.org"]);
  if (result.ok) {
    const version = result.stdout.trim();
    return { version, missing: false };
  }
  const text = `${result.stderr}\n${result.stdout}`;
  if (/\bE404\b/.test(text) || /404 Not Found/i.test(text) || /not in this registry/i.test(text)) {
    return { missing: true };
  }
  return { missing: false, error: redactSecrets(text.trim() || `npm view exit ${result.exitCode}`) };
}

export function localEnvStatus(names: string[]): { set: string[]; unset: string[] } {
  const set: string[] = [];
  const unset: string[] = [];
  for (const name of names) {
    if (process.env[name]?.trim()) {
      set.push(name);
    } else {
      unset.push(name);
    }
  }
  return { set, unset };
}
