/**
 * One-time local publish so the package exists on npm and Trusted Publisher
 * can be configured. Does not use NPM_TOKEN / provenance (those are CI-only).
 *
 * npm does not email a publish OTP. Use an authenticator app or the browser
 * window (`--auth-type=web`). Optional: --otp=123456 (6-digit TOTP only).
 *
 *   bun run npm:seed -- --dry-run
 *   bun run npm:seed -- --yes
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  hasFlag,
  NPM_PACKAGE,
  NPM_PACKAGE_URL,
  NPM_SEED_VERSION,
  NPM_TRUSTED_PUBLISHER_URL,
  npmViewVersion,
  redactSecrets,
  root,
  run,
} from "./secrets/lib.ts";

const NPM_2FA_URL = "https://www.npmjs.com/settings/~/account";
const argv = process.argv.slice(2);
const dryRun = hasFlag(argv, "--dry-run");
const yes = hasFlag(argv, "--yes");

function otpFromArgv(args: string[]): string | undefined {
  const eq = args.find((a) => a.startsWith("--otp="));
  if (eq) {
    return eq.slice("--otp=".length).trim();
  }
  const i = args.indexOf("--otp");
  if (i >= 0) {
    return args[i + 1]?.trim();
  }
  return process.env.NPM_OTP?.trim() || undefined;
}

type NpmProfile = {
  name?: string;
  tfa?: { pending?: boolean; mode?: string } | false | null;
  "two-factor auth"?: string | boolean;
};

async function npmProfile(): Promise<NpmProfile | null> {
  const result = await run(["npm", "profile", "get", "--json"]);
  if (!result.ok) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as NpmProfile;
  } catch {
    return null;
  }
}

function tfaMode(profile: NpmProfile | null): string | null {
  if (!profile) {
    return null;
  }
  const labeled = profile["two-factor auth"];
  if (typeof labeled === "string" && labeled && labeled !== "disabled") {
    return labeled;
  }
  if (profile.tfa && typeof profile.tfa === "object" && profile.tfa.mode) {
    return profile.tfa.mode;
  }
  return null;
}

function print2faHelp(): void {
  console.error("");
  console.error("npm does not email a publish code to crvouga@gmail.com (or any inbox).");
  console.error("Publishing requires account 2FA via authenticator app or a browser window.");
  console.error("");
  console.error("1. Enable 2FA on your npm account (authenticator, not email):");
  console.error(`     ${NPM_2FA_URL}`);
  console.error("     or: npm profile enable-2fa auth-and-writes");
  console.error("2. Re-login so the CLI can open a browser challenge:");
  console.error("     npm logout");
  console.error("     npm login --auth-type=web");
  console.error("3. Re-run (a browser tab should open — do not pass a made-up OTP):");
  console.error("     bun run npm:seed -- --yes");
  console.error("");
  console.error("Optional: 6-digit code from the authenticator app (not email):");
  console.error("     bun run npm:seed -- --yes --otp=123456");
}

function nextSteps(): void {
  console.log("");
  console.log("Next: enable Trusted Publisher (do not create a granular token):");
  console.log(`  ${NPM_TRUSTED_PUBLISHER_URL}`);
  console.log("  GitHub Actions → org/user: crvouga  repo: postgres-mem  workflow: ci.yml");
  console.log("");
  console.log("Then (if the baseline git tag is missing):");
  console.log(`  git tag v${NPM_SEED_VERSION}`);
  console.log(`  git push origin v${NPM_SEED_VERSION}`);
  console.log("");
  console.log("Docs: docs/SECRETS.md");
}

const existing = await npmViewVersion(NPM_PACKAGE);
if (existing.error) {
  console.error("FAIL: could not query the npm registry:", existing.error);
  process.exit(1);
}
if (!existing.missing) {
  console.log(`${NPM_PACKAGE}@${existing.version} already exists on npm.`);
  console.log(`  ${NPM_PACKAGE_URL}`);
  nextSteps();
  process.exit(0);
}

console.log(`${NPM_PACKAGE} is not on the npm registry yet.`);
console.log("Trusted Publishing can only be enabled after a first local publish.");
console.log(`This seed publishes ${NPM_PACKAGE}@${NPM_SEED_VERSION} from your npm login session.`);
console.log("(No Automation token. Provenance is left for later CI/OIDC releases.)");
console.log("");

if (!dryRun && !yes) {
  console.error("Refusing to publish without --yes (or use --dry-run).");
  console.error("Usage: bun run npm:seed -- --yes");
  console.error("       bun run npm:seed -- --dry-run");
  process.exit(2);
}

if (process.env.NPM_TOKEN?.trim() || process.env.NODE_AUTH_TOKEN?.trim()) {
  console.error("FAIL: NPM_TOKEN / NODE_AUTH_TOKEN is set.");
  console.error("Unset them so this seed uses `npm login` (interactive), not a CI token:");
  console.error("  unset NPM_TOKEN NODE_AUTH_TOKEN");
  process.exit(1);
}

const whoami = await run(["npm", "whoami"]);
if (!whoami.ok) {
  console.error("FAIL: not logged in to npm.");
  console.error("  npm login --auth-type=web");
  console.error("Then re-run: bun run npm:seed -- --yes");
  process.exit(1);
}
console.log(`npm user: ${whoami.stdout.trim()}`);

const profile = await npmProfile();
const tfa = tfaMode(profile);
if (tfa) {
  console.log(`npm 2FA: ${tfa}`);
} else {
  console.log("npm 2FA: not detected on this profile");
  if (!dryRun) {
    console.error("FAIL: npm requires 2FA to publish. It will not email a code.");
    print2faHelp();
    process.exit(1);
  }
}

console.log("");
console.log("Building and verifying package…");
const build = await $`bun run build`.cwd(root);
if (build.exitCode !== 0) {
  process.exit(build.exitCode ?? 1);
}
const verify = await $`bun run verify-package`.cwd(root);
if (verify.exitCode !== 0) {
  process.exit(verify.exitCode ?? 1);
}

const work = mkdtempSync(join(tmpdir(), "postgres-mem-seed-"));
const packDir = join(work, "pack");
mkdirSync(packDir, { recursive: true });

try {
  console.log("Packing (ignore-scripts)…");
  const pack = await $`npm pack --ignore-scripts --pack-destination ${packDir}`.cwd(root).nothrow();
  if (pack.exitCode !== 0) {
    console.error(redactSecrets(pack.stderr.toString() || pack.stdout.toString()));
    console.error("FAIL: npm pack failed");
    process.exit(1);
  }

  const tarballs = Array.from(new Bun.Glob("*.tgz").scanSync({ cwd: packDir }));
  if (tarballs.length !== 1) {
    console.error(`FAIL: expected one tarball, found ${tarballs.length}`);
    process.exit(1);
  }
  const tarball = join(packDir, tarballs[0]!);

  const extract = join(work, "extract");
  mkdirSync(extract);
  const tar = await $`tar -xzf ${tarball} -C ${extract}`.nothrow();
  if (tar.exitCode !== 0) {
    console.error("FAIL: could not extract npm pack tarball");
    process.exit(1);
  }

  const pkgDir = join(extract, "package");
  const pkgPath = join(pkgDir, "package.json");
  const pkg = await Bun.file(pkgPath).json();
  pkg.version = NPM_SEED_VERSION;
  pkg.publishConfig = { ...(pkg.publishConfig ?? {}), access: "public", provenance: false };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const publishArgs = [
    "npm",
    "publish",
    "--access",
    "public",
    "--ignore-scripts",
    "--no-provenance",
    "--auth-type=web",
  ];
  if (dryRun) {
    publishArgs.push("--dry-run");
  } else {
    const otp = otpFromArgv(argv);
    if (otp) {
      if (!/^\d{6}$/.test(otp)) {
        console.error("FAIL: --otp must be the 6-digit code from your authenticator app.");
        console.error("npm does not email this code.");
        process.exit(1);
      }
      publishArgs.push("--otp", otp);
    }
  }

  console.log("");
  if (dryRun) {
    console.log(`Dry-run: would publish ${NPM_PACKAGE}@${NPM_SEED_VERSION}`);
  } else if (otpFromArgv(argv)) {
    console.log(`Publishing ${NPM_PACKAGE}@${NPM_SEED_VERSION} with authenticator TOTP…`);
  } else {
    console.log(`Publishing ${NPM_PACKAGE}@${NPM_SEED_VERSION}…`);
    console.log("Expect a browser window for npm 2FA (not an email).");
  }

  const env = { ...process.env };
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;

  const proc = Bun.spawn(publishArgs, {
    cwd: pkgDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("");
    console.error("FAIL: npm publish failed. See the npm error above.");
    console.error(`This repo publishes as ${NPM_PACKAGE} (--access public).`);
    print2faHelp();
    process.exit(code);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (dryRun) {
  console.log("npm:seed dry-run OK (nothing published)");
  process.exit(0);
}

console.log("");
console.log(`npm:seed OK — ${NPM_PACKAGE}@${NPM_SEED_VERSION} is on the registry.`);
console.log(`  ${NPM_PACKAGE_URL}`);
nextSteps();
process.exit(0);
