/**
 * Run property-based fuzz tests with N independent random seeds.
 * Fails fast on the first failing seed and prints a replay command.
 *
 * Usage:
 *   bun run test:pbt:random -- 50
 *   bun run scripts/pbt-random.ts 50
 */
import { spawnSync } from "node:child_process";

const SEED_ENV = "POSTGRES_MEM_FUZZ_SEED";
const REPLAY_CMD = "bun test tests/fuzz";

function parseTrialCount(argv: string[]): number {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const raw = positional[0];
  if (raw === undefined || raw === "") {
    console.error("Usage: bun run scripts/pbt-random.ts <N>");
    console.error("  N — natural number of random-seed trials (fail fast on first failure)");
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Invalid trial count: ${raw} (expected a natural number >= 1)`);
    process.exit(2);
  }
  return n;
}

function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! | 0;
}

/** Bun may exit 0 on `--bail` across multiple files; detect failures from output too. */
function runFuzzSuite(seed: number): number {
  const result = spawnSync("bun", ["test", "tests/fuzz", "--bail"], {
    encoding: "utf8",
    env: {
      ...process.env,
      [SEED_ENV]: String(seed),
      POSTGRES_MEM_FUZZ_PATH: "",
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const outputFailed = /\(fail\)|Bailed out after \d+ failure/.test(combined);
  const summaryFailed = /\n\s+[1-9]\d* fail\n/.test(combined);
  if (outputFailed || summaryFailed) return result.status === 0 ? 1 : (result.status ?? 1);
  return result.status ?? 1;
}

const trials = parseTrialCount(process.argv.slice(2));

for (let i = 1; i <= trials; i++) {
  const seed = randomSeed();
  console.log(`[pbt-random] ${i}/${trials} seed=${seed}`);

  const exitCode = runFuzzSuite(seed);

  if (exitCode !== 0) {
    console.error("");
    console.error(`FAILED seed=${seed}  trial=${i}/${trials}`);
    console.error(`Replay: ${SEED_ENV}=${seed} ${REPLAY_CMD}`);
    process.exit(exitCode);
  }
}

console.log(`[pbt-random] all ${trials} trial(s) passed`);
