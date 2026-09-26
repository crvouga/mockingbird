/**
 * Generate DIVERGENCES.md from compat/divergences.json so docs cannot drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const src = JSON.parse(readFileSync(join(ROOT, "compat/divergences.json"), "utf8")) as {
  version: number;
  entries: Array<{
    id: string;
    scope: string;
    predicate: string;
    specifiedBehavior: string;
    pinnedBy: string[];
  }>;
};

const lines: string[] = [
  "# Divergences",
  "",
  "> Auto-generated from [`compat/divergences.json`](compat/divergences.json). Do not edit by hand — run `bun run divergences`.",
  "",
  `Generated: ${new Date().toISOString().slice(0, 10)} · ${src.entries.length} entries`,
  "",
  "| ID | Scope | Predicate | Pinned by |",
  "| --- | --- | --- | --- |",
];

for (const e of src.entries) {
  lines.push(
    `| \`${e.id}\` | ${e.scope} | ${e.predicate.replace(/\|/g, "\\|")} | ${e.pinnedBy.map((p) => `\`${p}\``).join(", ")} |`,
  );
}

lines.push("", "## Specified behavior", "");
for (const e of src.entries) {
  lines.push(`### \`${e.id}\``, "", e.specifiedBehavior, "");
}

writeFileSync(join(ROOT, "DIVERGENCES.md"), `${lines.join("\n")}\n`);
console.log(`Wrote DIVERGENCES.md (${src.entries.length} entries)`);
