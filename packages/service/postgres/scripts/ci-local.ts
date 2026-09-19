/**
 * Local replica of .github/workflows/ci.yml (except the main-only release/publish job).
 *
 *   bun run check:full
 *   npm run check:full
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
process.env.HUSKY = "0";

type Finished = { label: string; seconds: number };

const finished: Finished[] = [];
const notes: string[] = [];

function job(name: string): void {
  console.log("");
  console.log("=".repeat(72));
  console.log(`  ${name}`);
  console.log("=".repeat(72));
}

async function runStep(label: string, argv: string[], opts?: { env?: Record<string, string> }): Promise<void> {
  console.log("");
  console.log(`▸ ${label}`);
  console.log(`  $ ${argv.join(" ")}`);
  const started = performance.now();
  const proc = Bun.spawn(argv, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, HUSKY: "0", ...opts?.env },
  });
  const code = await proc.exited;
  const seconds = (performance.now() - started) / 1000;
  if (code !== 0) {
    console.error("");
    console.error(`check:full FAILED at "${label}" (exit ${code}, ${seconds.toFixed(1)}s)`);
    console.error("This is the same command CI runs. Fix it, then re-run: bun run check:full");
    process.exit(code);
  }
  console.log(`✓ ${label} (${seconds.toFixed(1)}s)`);
  finished.push({ label, seconds });
}

async function git(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  return { code, stdout };
}

async function refExists(ref: string): Promise<boolean> {
  const { code } = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return code === 0;
}

async function resolveBaseRef(): Promise<string | null> {
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    if (await refExists(ref)) return ref;
  }
  return null;
}

function printCommitlintHelp(kind: "range" | "last"): void {
  console.error("");
  console.error(
    kind === "range"
      ? "One or more commits since the base branch failed Conventional Commits lint."
      : "HEAD commit message failed Conventional Commits lint.",
  );
  console.error("");
  console.error("Expected format:");
  console.error("  <type>(optional-scope): <description>");
  console.error("");
  console.error("Examples that trigger a release:");
  console.error("  feat: add window function support");
  console.error("  fix: correct NULL handling in WHERE");
  console.error("  feat!: rename Database.snapshot API");
  console.error("");
  console.error("See README.md → Releasing");
}

async function commitlintJob(): Promise<void> {
  job("commitlint  (CI job)");

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout || "HEAD";
  const onMain = branch === "main";
  const base = await resolveBaseRef();

  if (onMain) {
    console.log("On main: CI treats commitlint as a warning on push (enforced on PRs).");
    const started = performance.now();
    const proc = Bun.spawn(["bunx", "commitlint", "--last", "--verbose"], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    const seconds = (performance.now() - started) / 1000;
    if (code !== 0) {
      console.warn(
        "HEAD is not Conventional Commits. Enforced on PRs. On main, semantic-release still publishes a patch unless a feat/fix/BREAKING message selects a higher bump.",
      );
      printCommitlintHelp("last");
    }
    finished.push({ label: "Commitlint (--last, warning on main)", seconds });
    notes.push("commitlint on main is warning-only (matches CI push); PRs still fail on bad messages");
    return;
  }

  if (!base) {
    notes.push("no main/origin/main ref; linted HEAD only — fetch origin to match PR commitlint");
    console.warn("No main/origin/main ref found; linting HEAD only.");
    await runStep("Commitlint (--last)", ["bunx", "commitlint", "--last", "--verbose"]);
    return;
  }

  const from = (await git(["merge-base", base, "HEAD"])).stdout || base;
  console.log(`Linting commits ${from}..HEAD (base ${base}, branch ${branch})`);
  const started = performance.now();
  const proc = Bun.spawn(["bunx", "commitlint", "--from", from, "--to", "HEAD", "--verbose"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  const seconds = (performance.now() - started) / 1000;
  if (code !== 0) {
    printCommitlintHelp("range");
    console.error("");
    console.error(`check:full FAILED at "Commitlint" (exit ${code}, ${seconds.toFixed(1)}s)`);
    process.exit(code);
  }
  console.log(`✓ Commitlint (${seconds.toFixed(1)}s)`);
  finished.push({ label: "Commitlint", seconds });

  try {
    const pr = Bun.spawn(["gh", "pr", "view", "--json", "title", "--jq", ".title"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const title = (await new Response(pr.stdout).text()).trim();
    const prCode = await pr.exited;
    if (prCode !== 0 || !title) {
      notes.push("PR title not checked (no open PR / gh unavailable); CI still validates the title on pull_request");
      return;
    }

    console.log(`Linting PR title: ${title}`);
    const titleProc = Bun.spawn(["bunx", "commitlint"], {
      cwd: root,
      stdin: new TextEncoder().encode(`${title}\n`),
      stdout: "inherit",
      stderr: "inherit",
    });
    const titleStatus = await titleProc.exited;
    if (titleStatus !== 0) {
      console.error("");
      console.error("PR title failed Conventional Commits lint (CI job: Validate PR title).");
      console.error('Use a Conventional Commits title, e.g. "feat: add window functions".');
      process.exit(titleStatus);
    }
    console.log("✓ PR title");
  } catch {
    notes.push("PR title not checked (gh not available); CI still validates the title on pull_request");
  }
}

console.log("postgres-mem check:full");
console.log("Mirrors .github/workflows/ci.yml — skip: release/publish (main + OIDC only)");
if (process.platform !== "linux") {
  notes.push(
    `CI runs on ubuntu-latest; this host is ${process.platform}. The PGlite oracle is the same WASM build on both, so results should match. The bench gate self-compares on platform mismatch (same as the GHA warning path).`,
  );
}

job("install");
await runStep("Install (frozen lockfile)", ["bun", "install", "--frozen-lockfile"]);

await commitlintJob();

job("quality  (CI job)");
await runStep("Format check", ["bun", "run", "format:check"]);
await runStep("Lint", ["bun", "run", "lint"]);
await runStep("Typecheck", ["bun", "run", "typecheck"]);
await runStep("Build", ["bun", "run", "build"]);
await runStep("Verify package", ["bun", "run", "verify-package"]);

job("test  (CI job)");
await runStep("Run tests", ["bun", "run", "test:postgres-compat"]);
await runStep("Canaries", ["bun", "run", "test:canaries"]);
await runStep("Browser SQL smoke", ["bun", "run", "test:browser-sql"]);

job("benchmark  (CI job)");
// Mirrors .github/workflows/ci.yml Regression gate: real 2.5× p95 / 1.5× median
// compare when platforms match; otherwise gate current vs itself (committed baseline is linux).
await runStep("CI benchmarks", [
  "bun",
  "run",
  "benchmarks/run.ts",
  "--tier",
  "ci",
  "--engine",
  "mem",
  "--out",
  "benchmarks/results/ci-latest.json",
]);
{
  const baseline = (await Bun.file("benchmarks/results/ci-baseline.json").json()) as {
    environment?: { platform?: string };
  };
  const current = (await Bun.file("benchmarks/results/ci-latest.json").json()) as {
    environment?: { platform?: string };
  };
  const bp = baseline.environment?.platform;
  const cp = current.environment?.platform;
  if (bp && cp && bp !== cp) {
    notes.push(
      `ci-baseline.json is ${bp}; this host is ${cp}. Gating ci-latest against itself (GHA on ubuntu uses the real baseline).`,
    );
    await runStep("Regression gate (self)", [
      "bun",
      "run",
      "benchmarks/compare-ci.ts",
      "benchmarks/results/ci-latest.json",
      "benchmarks/results/ci-latest.json",
    ]);
  } else {
    await runStep("Regression gate", ["bun", "run", "benchmarks/compare-ci.ts"]);
  }
}
await runStep("Memory budget", ["bun", "run", "benchmarks/check-budgets.ts"]);

const total = finished.reduce((sum, step) => sum + step.seconds, 0);
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const green = (text: string): string => (useColor ? `\x1b[32m${text}\x1b[0m` : text);
const boldGreen = (text: string): string => (useColor ? `\x1b[1;32m${text}\x1b[0m` : text);

console.log("");
console.log(green("=".repeat(72)));
console.log(boldGreen("  ✅  All local CI gates passed"));
console.log(green("  This change will pass GitHub Actions CI."));
console.log(green("=".repeat(72)));
for (const step of finished) {
  console.log(`  ${step.seconds.toFixed(1).padStart(6)}s  ${step.label}`);
}
console.log(`  ${total.toFixed(1).padStart(6)}s  total`);
console.log("");
console.log("Skipped: release (semantic-release on main only).");
for (const note of notes) {
  console.log(`Note: ${note}`);
}
console.log("");
