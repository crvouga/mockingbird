/**
 * Fail-closed PostgreSQL compatibility gate.
 * Run: bun run scripts/postgres-compat-gate.ts
 * Or:  bun run test:postgres-compat
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_ORACLE_VERSIONS } from "../tests/harness/oracle-versions.ts";
import { buildInventoryReport } from "./postgres-inventory.ts";
import { printScenarioSummary, validateScenarioCatalog } from "./postgres-scenarios.ts";

const ROOT = join(import.meta.dir, "..");
const COMPAT = join(ROOT, "compat");

interface CoverageFile {
  counts: {
    total: number;
    notApplicable: number;
    sqlBehavior: number;
    verified: number;
    partiallyVerified: number;
    unsupported: number;
    unknown: number;
  };
  coverage: Record<string, { status: string; evidence: string[]; notes: string }>;
}

async function main(): Promise<void> {
  const failures: string[] = [];

  const requirementsPath = join(COMPAT, "requirements.json");
  const coveragePath = join(COMPAT, "coverage.json");
  if (!existsSync(requirementsPath) || !existsSync(coveragePath)) {
    failures.push(
      "compat/requirements.json or compat/coverage.json missing — run bun run scripts/postgres-requirements.ts",
    );
  } else {
    const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as CoverageFile;
    if (coverage.counts.total < 150 || coverage.counts.sqlBehavior < 1) {
      failures.push(
        `compat coverage is empty or incomplete (total=${coverage.counts.total}, sqlBehavior=${coverage.counts.sqlBehavior})`,
      );
    }
    if (coverage.counts.unknown > 0) {
      failures.push(`${coverage.counts.unknown} SQL_BEHAVIOR requirements still unknown`);
    }
    for (const [id, entry] of Object.entries(coverage.coverage)) {
      if (!["VERIFIED", "PARTIALLY_VERIFIED", "UNSUPPORTED", "NOT_APPLICABLE"].includes(entry.status)) {
        failures.push(`Requirement ${id} has invalid status ${entry.status}`);
      }
    }
  }

  const scenarios = validateScenarioCatalog();
  printScenarioSummary(scenarios);
  for (const failure of scenarios.failures) failures.push(failure);

  const inventory = await buildInventoryReport();
  console.log(`oracle PGlite PostgreSQL ${inventory.referenceServerVersion} (bun ${Bun.version})`);
  if (!(SUPPORTED_ORACLE_VERSIONS as readonly string[]).includes(inventory.referenceServerVersion)) {
    failures.push(
      `Unexpected oracle version ${inventory.referenceServerVersion} (allowed: ${SUPPORTED_ORACLE_VERSIONS.join(", ")})`,
    );
  }
  if (inventory.missingFunctions.length > 0) {
    failures.push(
      `${inventory.missingFunctions.length} oracle functions neither implemented nor registered: ` +
        `${inventory.missingFunctions.slice(0, 20).join(", ")}${inventory.missingFunctions.length > 20 ? "…" : ""}`,
    );
  }
  if (inventory.missingOperators.length > 0) {
    failures.push(`Oracle operators neither implemented nor registered: ${inventory.missingOperators.join(", ")}`);
  }
  if (inventory.staleRegisterFunctions.length > 0) {
    failures.push(
      `Stale register (implemented but still registered): ${inventory.staleRegisterFunctions.slice(0, 20).join(", ")}`,
    );
  }
  if (inventory.staleRegisterOperators.length > 0) {
    failures.push(`Stale operator register entries: ${inventory.staleRegisterOperators.join(", ")}`);
  }
  if (inventory.unknownRegisterFunctions.length > 0) {
    failures.push(`Register entries not in the oracle: ${inventory.unknownRegisterFunctions.slice(0, 20).join(", ")}`);
  }
  if (inventory.unknownRegisterOperators.length > 0) {
    failures.push(`Operator register entries not in the oracle: ${inventory.unknownRegisterOperators.join(", ")}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    referenceServerVersion: inventory.referenceServerVersion,
    inventory: {
      oracleFunctionCount: inventory.oracleFunctionCount,
      oracleOperatorCount: inventory.oracleOperatorCount,
      implementedFunctions: inventory.implementedFunctions,
      registeredUnsupportedFunctions: inventory.registeredUnsupportedFunctions,
      implementedOperators: inventory.implementedOperators,
      registeredUnsupportedOperators: inventory.registeredUnsupportedOperators.length,
      memoryOnlyFunctions: inventory.memoryOnlyFunctions,
    },
    scenarios: scenarios.stats,
    failures,
    ok: failures.length === 0,
  };
  writeFileSync(join(COMPAT, "gate-report.json"), JSON.stringify(report, null, 2));

  if (failures.length > 0) {
    console.error("postgres-compat gate FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("postgres-compat gate OK");
  console.log(`  oracle ${inventory.referenceServerVersion}`);
  console.log(
    `  functions implemented ${inventory.implementedFunctions}/${inventory.oracleFunctionCount} (register ${inventory.registeredUnsupportedFunctions})`,
  );
  console.log(
    `  operators implemented ${inventory.implementedOperators.length}/${inventory.oracleOperatorCount} (register ${inventory.registeredUnsupportedOperators.length})`,
  );
  console.log(`  scenarios mapped ${scenarios.stats.mapped}/${scenarios.stats.total} smoke ${scenarios.stats.smoke}`);
  // PGlite's WASM teardown sets a nonzero exit code (99); exit explicitly.
  process.exit(0);
}

await main();
