/**
 * Apply each canary sabotage, run its probe tests, assert failure, restore.
 *
 *   bun run scripts/run-canaries.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANARIES } from "../tests/meta/canaries/defs.ts";

const ROOT = join(import.meta.dir, "..");

async function runProbe(probe: string[]): Promise<number> {
  const proc = Bun.spawn(["bun", "test", ...probe], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HUSKY: "0" },
  });
  await proc.exited;
  return proc.exitCode ?? 1;
}

function apply(file: string, find: string, replace: string): string {
  const path = join(ROOT, file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(find)) {
    throw new Error(`Canary find string not present in ${file}`);
  }
  const next = original.replace(find, replace);
  if (next === original) {
    throw new Error(`Canary replace was a no-op in ${file}`);
  }
  writeFileSync(path, next);
  return original;
}

function restore(file: string, original: string): void {
  writeFileSync(join(ROOT, file), original);
}

async function main(): Promise<void> {
  const survivors: string[] = [];
  const killed: string[] = [];

  for (const canary of CANARIES) {
    process.stdout.write(`canary ${canary.id}… `);
    let original: string | null = null;
    try {
      original = apply(canary.file, canary.find, canary.replace);
      const code = await runProbe(canary.probe);
      if (code === 0) {
        survivors.push(canary.id);
        console.log("SURVIVED (suite stayed green — proof hole)");
      } else {
        killed.push(canary.id);
        console.log("killed");
      }
    } catch (error) {
      survivors.push(canary.id);
      console.log(`ERROR ${(error as Error).message}`);
    } finally {
      if (original !== null) restore(canary.file, original);
    }
  }

  console.log("");
  console.log(`killed ${killed.length}/${CANARIES.length}`);
  if (survivors.length > 0) {
    console.error(`SURVIVORS (suite did not fail): ${survivors.join(", ")}`);
    process.exit(1);
  }
  console.log("All canaries killed — suite can detect these sabotages.");
}

await main();
