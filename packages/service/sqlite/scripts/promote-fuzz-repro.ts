/**
 * Promote a minimized SQL script into tests/corpus/regressions/.
 *
 * Usage:
 *   bun run scripts/promote-fuzz-repro.ts --slug my-bug --from path/to/repro.sql
 *   bun run scripts/promote-fuzz-repro.ts --slug my-bug --stdin < repro.sql
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const slug = (arg("--slug") ?? "repro").replace(/[^a-zA-Z0-9_-]+/g, "-");
const from = arg("--from");
const destDir = join(import.meta.dir, "../tests/corpus/regressions");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, `${slug}.sql`);

let body: string;
if (from) {
  body = readFileSync(from, "utf8");
} else if (process.argv.includes("--stdin")) {
  body = await Bun.stdin.text();
} else {
  console.error("Provide --from <file> or --stdin");
  process.exit(1);
}

if (!body.trim().endsWith(";")) {
  body = `${body.trim()}\n`;
}
writeFileSync(dest, body.endsWith("\n") ? body : `${body}\n`, "utf8");
console.log(`promoted ${from ?? "stdin"} → ${dest}`);
console.log(`Replay: bun test tests/fuzz/corpus.test.ts`);

// Keep a copy under tests/dst/repros for local archaeology.
const mirrorDir = join(import.meta.dir, "../tests/dst/repros");
mkdirSync(mirrorDir, { recursive: true });
copyFileSync(dest, join(mirrorDir, basename(dest)));
