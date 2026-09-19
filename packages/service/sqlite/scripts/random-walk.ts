/**
 * Soak CLI for the random-walk DST.
 *
 * Usage:
 *   bun run scripts/random-walk.ts -- --seed 123 --depth 200 --runs 20
 *   bun run test:walk:soak -- --depth 100 --runs 5
 *   bun run scripts/random-walk.ts -- --seed 123 --path 0:1 --depth 40
 */
import * as fc from "fast-check";
import { decisionVectorArb, runWalkOrMinimize } from "../tests/fuzz/walk/index.ts";

function usage(): never {
  console.error("Usage: bun run scripts/random-walk.ts [--seed N] [--depth N] [--runs N] [--path PATH]");
  process.exit(2);
}

function parseArgs(argv: string[]): { seed?: number; depth: number; runs: number; path?: string } {
  let seed: number | undefined;
  let depth = Number(process.env.SQLITE_MEM_WALK_STEPS ?? "200");
  let runs = Number(process.env.SQLITE_MEM_FUZZ_RUNS ?? "20");
  let path: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--seed") {
      seed = Number(argv[++i]);
      if (!Number.isFinite(seed)) usage();
      continue;
    }
    if (arg === "--depth") {
      depth = Number(argv[++i]);
      if (!Number.isFinite(depth) || depth < 1) usage();
      continue;
    }
    if (arg === "--runs") {
      runs = Number(argv[++i]);
      if (!Number.isFinite(runs) || runs < 1) usage();
      continue;
    }
    if (arg === "--path") {
      path = argv[++i];
      if (!path) usage();
      continue;
    }
    usage();
  }

  if (!Number.isFinite(depth) || depth < 1) depth = 200;
  if (!Number.isFinite(runs) || runs < 1) runs = 20;
  return { seed, depth: Math.floor(depth), runs: Math.floor(runs), path };
}

const args = parseArgs(process.argv.slice(2).filter((a) => a !== "--"));
const seed = args.seed ?? 0x5a17e_0e1 | 0;

console.log(`[random-walk] seed=${seed} depth=${args.depth} runs=${args.runs}${args.path ? ` path=${args.path}` : ""}`);

const details = fc.check(
  fc.property(decisionVectorArb(args.depth), (ints) => {
    runWalkOrMinimize(ints, { depth: args.depth, label: "soak" });
  }),
  {
    seed,
    numRuns: args.path ? 1 : args.runs,
    verbose: 1,
    endOnFailure: true,
    ...(args.path ? { path: args.path } : {}),
  },
);

if (details.failed) {
  console.error(`[random-walk] FAILED seed=${details.seed} path=${details.counterexamplePath}`);
  console.error(
    `Replay: SQLITE_MEM_FUZZ_SEED=${details.seed} SQLITE_MEM_WALK_STEPS=${args.depth}` +
      (details.counterexamplePath ? ` SQLITE_MEM_FUZZ_PATH='${details.counterexamplePath}'` : "") +
      ` bun test tests/fuzz/random-walk.test.ts`,
  );
  if (details.errorInstance instanceof Error) {
    console.error(details.errorInstance.message);
  }
  process.exit(1);
}

console.log(`[random-walk] all ${details.numRuns} run(s) passed`);
