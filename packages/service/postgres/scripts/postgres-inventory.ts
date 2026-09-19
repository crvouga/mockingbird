/**
 * Inventory oracle PostgreSQL (PGlite) builtins vs postgres-mem registries.
 * Run: bun run inventory
 *      bun run scripts/postgres-inventory.ts --write-register
 *
 * Fail-closed: every function in the oracle's pg_catalog and every operator in
 * pg_operator must either be implemented by the engine or carried as an
 * explicit entry in compat/unsupported-register.json. Silence is a gate
 * failure, and so are stale register entries (registered but implemented).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getAggregateFactories } from "../src/functions/aggregates.ts";
import { getScalarFunctions } from "../src/functions/scalar.ts";
import { getSrfFunctions } from "../src/functions/srf.ts";
import { WINDOW_FUNCTION_NAMES } from "../src/functions/window.ts";

const ROOT = join(import.meta.dir, "..");
const REGISTER_PATH = join(ROOT, "compat", "unsupported-register.json");

/** Binary operators evaluated by src/expressions/operators.ts (plus unary +,-,~,!!,@,|/,||/ handled there). */
export const SUPPORTED_OPERATORS = new Set([
  "=",
  "<>",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "||",
  "&",
  "|",
  "#",
  "<<",
  ">>",
  "~~",
  "~~*",
  "!~~",
  "!~~*",
  "~",
  "~*",
  "!~",
  "!~*",
  "@>",
  "<@",
  "&&",
  "->",
  "->>",
  "#>",
  "#>>",
  "?",
  "?|",
  "?&",
  "#-",
  "@@",
  "@",
  "|/",
  "||/",
  "!",
]);

export interface UnsupportedRegister {
  version: number;
  functions: Record<string, string>;
  operators: Record<string, string>;
}

export interface InventoryReport {
  referenceServerVersion: string;
  oracleFunctionCount: number;
  oracleOperatorCount: number;
  implementedFunctions: number;
  registeredUnsupportedFunctions: number;
  implementedOperators: string[];
  registeredUnsupportedOperators: string[];
  missingFunctions: string[];
  missingOperators: string[];
  staleRegisterFunctions: string[];
  staleRegisterOperators: string[];
  unknownRegisterFunctions: string[];
  unknownRegisterOperators: string[];
  memoryOnlyFunctions: string[];
}

export function listMemoryFunctionNames(): Set<string> {
  return new Set([
    ...getScalarFunctions().keys(),
    ...getAggregateFactories().keys(),
    ...getSrfFunctions().keys(),
    ...WINDOW_FUNCTION_NAMES,
  ]);
}

/** Reason bucket for an oracle function we intentionally do not implement. */
function registerReason(name: string): string {
  if (/(in|out|recv|send|typmodin|typmodout|analyze|subscript)$/.test(name) || /^(byteaout|anyin)/.test(name)) {
    return "type I/O / wire-protocol support function; not part of the SQL dialect surface";
  }
  if (/^(hash|uuid_hash|jsonb_hash|ts_.*_hash)/.test(name) || /_hash(_extended)?$/.test(name)) {
    return "internal hash support function for hash indexes/joins";
  }
  if (/(_cmp|_larger|_smaller|_ge|_gt|_le|_lt|_eq|_ne|_pl|_mi|_mul|_div|_um|_up|abs$)/.test(name)) {
    return "internal operator implementation function; the operator itself is the SQL surface";
  }
  if (/^pg_/.test(name)) {
    return "server administration / storage / replication introspection; NOT APPLICABLE to an in-memory engine";
  }
  if (
    /^(brin|gin|gist|spg|btree|amvalidate|bt|tsm_|dsynonym|dispell|dsimple|thesaurus|prsd|regconfig|regdictionary)/.test(
      name,
    )
  ) {
    return "index access method / text-search configuration internals";
  }
  if (/^(lo_|loread|lowrite)/.test(name)) {
    return "large-object API; NOT APPLICABLE (no on-disk storage)";
  }
  if (/^(current_setting_|set_config$|txid_|pg_snapshot)/.test(name)) {
    return "MVCC/txid surface; single-session engine documents this as unsupported";
  }
  return "not implemented in this milestone; calls fail loud with SQLSTATE 42883";
}

export function loadRegister(): UnsupportedRegister {
  if (!existsSync(REGISTER_PATH)) return { version: 1, functions: {}, operators: {} };
  return JSON.parse(readFileSync(REGISTER_PATH, "utf8")) as UnsupportedRegister;
}

async function queryOracle(): Promise<{ version: string; functions: Set<string>; operators: Set<string> }> {
  const db = new PGlite();
  await db.waitReady;
  // PGlite's WASM boot leaks process.exitCode = 99 (electric-sql/pglite#975)
  process.exitCode = 0;
  const version = (await db.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]!.v;
  const fns = await db.query<{ n: string }>(
    "SELECT DISTINCT p.proname AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'pg_catalog' ORDER BY 1",
  );
  const ops = await db.query<{ n: string }>("SELECT DISTINCT oprname AS n FROM pg_operator ORDER BY 1");
  await db.close();
  return {
    version,
    functions: new Set(fns.rows.map((r) => r.n.toLowerCase())),
    operators: new Set(ops.rows.map((r) => r.n)),
  };
}

export async function buildInventoryReport(): Promise<InventoryReport> {
  const oracle = await queryOracle();
  const memFns = listMemoryFunctionNames();
  const register = loadRegister();
  const regFns = new Set(Object.keys(register.functions));
  const regOps = new Set(Object.keys(register.operators));

  const missingFunctions = [...oracle.functions].filter((n) => !memFns.has(n) && !regFns.has(n)).sort();
  const missingOperators = [...oracle.operators].filter((n) => !SUPPORTED_OPERATORS.has(n) && !regOps.has(n)).sort();
  const staleRegisterFunctions = [...regFns].filter((n) => memFns.has(n)).sort();
  const staleRegisterOperators = [...regOps].filter((n) => SUPPORTED_OPERATORS.has(n)).sort();
  const unknownRegisterFunctions = [...regFns].filter((n) => !oracle.functions.has(n)).sort();
  const unknownRegisterOperators = [...regOps].filter((n) => !oracle.operators.has(n)).sort();

  return {
    referenceServerVersion: oracle.version,
    oracleFunctionCount: oracle.functions.size,
    oracleOperatorCount: oracle.operators.size,
    implementedFunctions: [...oracle.functions].filter((n) => memFns.has(n)).length,
    registeredUnsupportedFunctions: regFns.size,
    implementedOperators: [...oracle.operators].filter((n) => SUPPORTED_OPERATORS.has(n)).sort(),
    registeredUnsupportedOperators: [...regOps].sort(),
    missingFunctions,
    missingOperators,
    staleRegisterFunctions,
    staleRegisterOperators,
    unknownRegisterFunctions,
    unknownRegisterOperators,
    memoryOnlyFunctions: [...memFns].filter((n) => !oracle.functions.has(n)).sort(),
  };
}

async function writeRegister(): Promise<void> {
  const oracle = await queryOracle();
  const memFns = listMemoryFunctionNames();
  const existing = loadRegister();

  const functions: Record<string, string> = {};
  for (const name of [...oracle.functions].sort()) {
    if (memFns.has(name)) continue;
    functions[name] = existing.functions[name] ?? registerReason(name);
  }
  const operators: Record<string, string> = {};
  for (const name of [...oracle.operators].sort()) {
    if (SUPPORTED_OPERATORS.has(name)) continue;
    operators[name] = existing.operators[name] ?? "operator not implemented; expressions using it fail loud with 42883";
  }

  writeFileSync(REGISTER_PATH, `${JSON.stringify({ version: 1, functions, operators }, null, 2)}\n`);
  console.log(
    `Wrote ${REGISTER_PATH}: ${Object.keys(functions).length} functions, ${Object.keys(operators).length} operators`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--write-register")) {
    await writeRegister();
    // PGlite's WASM teardown sets a nonzero exit code (99); exit explicitly.
    process.exit(0);
  }
  const report = await buildInventoryReport();
  console.log(
    JSON.stringify(
      {
        ...report,
        missingFunctions: report.missingFunctions.slice(0, 50),
        memoryOnlyFunctions: report.memoryOnlyFunctions.slice(0, 50),
      },
      null,
      2,
    ),
  );
  const gaps =
    report.missingFunctions.length +
    report.missingOperators.length +
    report.staleRegisterFunctions.length +
    report.staleRegisterOperators.length +
    report.unknownRegisterFunctions.length +
    report.unknownRegisterOperators.length;
  if (gaps > 0) {
    console.error(
      `Inventory gaps: missing fns ${report.missingFunctions.length}, missing ops ${report.missingOperators.length}, ` +
        `stale register fns ${report.staleRegisterFunctions.length}, stale ops ${report.staleRegisterOperators.length}, ` +
        `unknown register fns ${report.unknownRegisterFunctions.length}, unknown ops ${report.unknownRegisterOperators.length}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) await main();
