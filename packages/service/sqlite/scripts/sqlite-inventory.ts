/**
 * Inventory oracle SQLite (bun:sqlite) builtins vs sqlite-mem registries.
 * Run: bun run inventory
 *
 * Under Scope-3, any oracle-exposed SQL name missing from memory is a failure
 * when invoked via the compat gate (this script still prints the report).
 */
import { Database as BunDatabase } from "bun:sqlite";
import { aggregateFunctions } from "../src/functions/aggregate.ts";
import { dateTimeFunctions } from "../src/functions/datetime.ts";
import { ftsAuxFunctions, rtreeAuxFunctions } from "../src/functions/extensions.ts";
import { jsonAggregateFunctions, jsonScalarFunctions } from "../src/functions/json.ts";
import { mathFunctions } from "../src/functions/math.ts";
import { getScalarFunctions } from "../src/functions/scalar.ts";
import { listTableValuedFunctions } from "../src/functions/table-valued.ts";
import { PRAGMA_TVF_NAMES } from "../src/executor/pragma-engine.ts";
import { windowFunctions } from "../src/functions/window.ts";

const OPERATOR_FUNCS = ["->", "->>", "like", "glob", "match", "regexp"] as const;
const MEMORY_MODULES = [
  "fts3",
  "fts3tokenize",
  "fts4",
  "fts4aux",
  "fts5",
  "fts5vocab",
  "rtree",
  "rtree_i32",
  "dbstat",
  "bytecode",
  "tables_used",
  "json_each",
  "json_tree",
];

export function listMemoryFunctionNames(): Set<string> {
  return new Set([
    ...Object.keys(getScalarFunctions()),
    ...Object.keys(dateTimeFunctions),
    ...Object.keys(jsonScalarFunctions),
    ...Object.keys(mathFunctions),
    ...Object.keys(ftsAuxFunctions),
    ...Object.keys(rtreeAuxFunctions),
    ...Object.keys(aggregateFunctions),
    ...Object.keys(jsonAggregateFunctions),
    ...Object.keys(windowFunctions),
    ...listTableValuedFunctions(),
    ...OPERATOR_FUNCS,
  ]);
}

export function buildInventoryReport() {
  const db = new BunDatabase(":memory:");
  const version = String(db.prepare("select sqlite_version()").get()?.["sqlite_version()"] ?? "?");
  const compileOptions = db
    .prepare("pragma compile_options")
    .all()
    .map((r) => String((r as { compile_options: string }).compile_options));
  const functions = db
    .prepare("select name, type, narg from pragma_function_list() order by name, type, narg")
    .all() as Array<{ name: string; type: string; narg: number }>;
  const modules = db
    .prepare("select name from pragma_module_list() order by name")
    .all()
    .map((r) => String((r as { name: string }).name));

  const memNames = listMemoryFunctionNames();
  const oracleNames = new Set<string>();
  for (const f of functions) oracleNames.add(f.name.toLowerCase());
  for (const op of OPERATOR_FUNCS) oracleNames.add(op);

  const missing: string[] = [];
  const present: string[] = [];
  for (const name of [...oracleNames].sort()) {
    if (memNames.has(name)) present.push(name);
    else missing.push(name);
  }
  // Recompute cleanly
  const missingClean = [...oracleNames].filter((n) => !memNames.has(n)).sort();
  const presentClean = [...oracleNames].filter((n) => memNames.has(n)).sort();

  const tvfs = new Set(listTableValuedFunctions());
  const missingModules = modules.filter((m) => {
    if (MEMORY_MODULES.includes(m)) return false;
    if (tvfs.has(m)) return false;
    return true;
  });
  for (const base of PRAGMA_TVF_NAMES) {
    const name = `pragma_${base}`;
    if (!tvfs.has(name)) missingModules.push(name);
  }

  const extra = [...memNames].filter((n) => !oracleNames.has(n)).sort();

  return {
    referenceSqliteVersion: version,
    compileOptions,
    oracleFunctionCount: functions.length,
    oracleModules: modules,
    memoryModules: MEMORY_MODULES,
    implementedOracleFunctions: presentClean,
    missingOracleFunctions: missingClean,
    missingOracleModules: missingModules,
    memoryOnlyFunctions: extra,
    jsonOracleFunctions: [...oracleNames].filter((n) => n.includes("json") || n === "->" || n === "->>").sort(),
    jsonImplemented: [...presentClean].filter((n) => n.includes("json") || n === "->" || n === "->>").sort(),
  };
}

function main(): void {
  const report = buildInventoryReport();
  console.log(JSON.stringify(report, null, 2));
  if (report.missingOracleFunctions.length > 0 || report.missingOracleModules.length > 0) {
    console.error(
      `Inventory gaps: ${report.missingOracleFunctions.length} functions, ${report.missingOracleModules.length} modules`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
