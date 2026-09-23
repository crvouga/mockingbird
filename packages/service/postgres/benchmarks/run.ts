import { mkdir } from "node:fs/promises";
import path from "node:path";
import { memFactory } from "./compare/mem.ts";
import { renderHtmlReport } from "./harness/html-report.ts";
import { toJson } from "./harness/report.ts";
import { engineAllowed, printReport, runSuite } from "./harness/run-suite.ts";
import type { NamedFactory, SuiteTier } from "./harness/types.ts";
import { allSpecs } from "./workloads/index.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const tier = (arg("--tier") ?? "default") as SuiteTier;
if (!["ci", "default", "full"].includes(tier)) {
  console.error("unknown --tier; expected ci | default | full");
  process.exit(1);
}

const engineArg = arg("--engine") ?? "mem";
const grep = arg("--grep");
const out = arg("--out");

const factories: NamedFactory[] = [];

if (engineArg === "mem" || engineArg === "both") {
  factories.push(memFactory);
}

if (engineArg === "pglite" || engineArg === "both") {
  const { pgliteFactory } = await import("./compare/pglite.ts");
  factories.push(pgliteFactory);
}

if (factories.length === 0) {
  console.error("unknown --engine; expected mem | pglite | both");
  process.exit(1);
}

let specs = allSpecs();
if (grep) specs = specs.filter((spec) => spec.name.includes(grep));
specs = specs.filter((spec) => factories.some((factory) => engineAllowed(spec, factory.name)));

console.log(
  `Running ${specs.filter((s) => s.tiers.includes(tier)).length} specs  tier=${tier}  engines=${factories.map((f) => f.name).join(",")}`,
);

const report = await runSuite({
  factories,
  specs,
  tier,
  onResult: (result) => {
    const extra = result.extra?.snapshotBytes ? `  snap=${result.extra.snapshotBytes}B` : "";
    console.log(
      `  ${result.engine.padEnd(12)} ${result.name}  p95=${result.p95.toFixed(3)}ms  ops=${result.opsPerSec.toFixed(0)}${extra}`,
    );
  },
});

printReport(report);

const resultsDir = path.join(import.meta.dir, "results");
await mkdir(resultsDir, { recursive: true });
const outPath = out ?? path.join(resultsDir, `${tier}-${report.environment.runtime}.json`);
await Bun.write(outPath, toJson(report));
console.log(`Wrote ${outPath}`);
const htmlPath = outPath.replace(/\.json$/i, ".html");
await Bun.write(htmlPath, renderHtmlReport(report));
console.log(`Wrote ${htmlPath}`);

// PGlite's WASM boot leaks process.exitCode = 99; exit explicitly on success.
process.exit(0);
