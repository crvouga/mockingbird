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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const tier = (arg("--tier") ?? "default") as SuiteTier;
if (!["ci", "default", "full"].includes(tier)) {
  console.error("unknown --tier; expected ci | default | full");
  process.exit(1);
}

const engineArg = arg("--engine") ?? (tier === "full" || hasFlag("--compare") ? "both" : "mem");
const grep = arg("--grep");
const out = arg("--out");

const factories: NamedFactory[] = [];
const wantCompare = engineArg === "compare" || engineArg === "compare-js" || engineArg === "compare-sqlite";

if (
  engineArg === "mem" ||
  engineArg === "both" ||
  engineArg === "compare" ||
  engineArg === "compare-js" ||
  engineArg === "compare-sqlite"
) {
  factories.push(memFactory);
}

if (engineArg === "sqlite" || engineArg === "both" || engineArg === "compare" || engineArg === "compare-sqlite") {
  const { sqliteFactory } = await import("./compare/sqlite.ts");
  factories.push(sqliteFactory);
}

if (engineArg === "alasql" || engineArg === "compare" || engineArg === "compare-js") {
  const { tryLoadAlasqlFactory } = await import("./compare/alasql.ts");
  const alasqlFactory = await tryLoadAlasqlFactory();
  if (!alasqlFactory) {
    if (engineArg === "alasql") {
      console.error("alasql is not installed. Run: bun add -d alasql");
      process.exit(1);
    }
    console.warn("skipping alasql (not installed)");
  } else {
    factories.push(alasqlFactory);
  }
}

if (engineArg === "sqljs" || engineArg === "compare" || engineArg === "compare-sqlite") {
  const { tryLoadSqlJsFactory } = await import("./compare/sqljs.ts");
  const sqljsFactory = await tryLoadSqlJsFactory();
  if (!sqljsFactory) {
    if (engineArg === "sqljs") {
      console.error("sql.js is not installed. Run: bun add -d sql.js");
      process.exit(1);
    }
    console.warn("skipping sql.js");
  } else {
    factories.push(sqljsFactory);
  }
}

if (engineArg === "wa-sqlite" || engineArg === "compare" || engineArg === "compare-sqlite") {
  const { tryLoadWaSqliteFactory } = await import("./compare/wa-sqlite.ts");
  const waFactory = await tryLoadWaSqliteFactory();
  if (!waFactory) {
    if (engineArg === "wa-sqlite") {
      console.error("wa-sqlite is not installed. Run: bun add -d wa-sqlite");
      process.exit(1);
    }
    console.warn("skipping wa-sqlite");
  } else {
    factories.push(waFactory);
  }
}

if (factories.length === 0) {
  console.error(
    "unknown --engine; expected mem | sqlite | alasql | sqljs | wa-sqlite | compare | compare-js | compare-sqlite | both",
  );
  process.exit(1);
}

let specs = allSpecs();
if (grep) specs = specs.filter((spec) => spec.name.includes(grep));
// Compare-track specs only run under --engine compare|compare-js|compare-sqlite
// (or a single compare engine like alasql/sqljs/wa-sqlite).
if (!wantCompare && engineArg !== "alasql" && engineArg !== "sqljs" && engineArg !== "wa-sqlite") {
  specs = specs.filter((spec) => !spec.engines?.startsWith("compare"));
} else {
  specs = specs.filter((spec) => factories.some((factory) => engineAllowed(spec, factory.name)));
}

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
