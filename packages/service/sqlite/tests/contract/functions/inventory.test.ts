import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { listMemoryFunctionNames } from "../../../scripts/sqlite-inventory.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";

const OPTIONAL_ORACLE_FUNCTIONS = /^(?:geopoly_|percentile(?:_|$)|median$)/;

function coreOracleFunctionNames(): Set<string> {
  const db = new BunDatabase(":memory:");
  try {
    const names = new Set(
      (db.prepare("select name from pragma_function_list()").all() as Array<{ name: string }>).map((row) =>
        row.name.toLowerCase(),
      ),
    );
    names.add("->");
    names.add("->>");
    return new Set([...names].filter((name) => !OPTIONAL_ORACLE_FUNCTIONS.test(name)));
  } finally {
    db.close();
  }
}

/**
 * Scope-3: every core oracle-exposed SQL function name must be present in sqlite-mem.
 * Bun enables optional SQLite extensions differently across platforms, so those
 * functions are not part of the portable oracle contract.
 */
describe("function inventory vs oracle", () => {
  test("oracle SQL surface is a subset of sqlite-mem registries", () => {
    const names = coreOracleFunctionNames();
    const mem = listMemoryFunctionNames();
    const missing = [...names].filter((n) => !mem.has(n)).sort();
    expect(missing).toEqual([]);
  });

  test("JSON surface from oracle is implemented", () => {
    const names = coreOracleFunctionNames();
    const mem = listMemoryFunctionNames();
    const jsonOracle = [...names].filter((n) => n.includes("json") || n === "->" || n === "->>").sort();
    const missingJson = jsonOracle.filter((n) => !mem.has(n));
    expect(missingJson).toEqual([]);
  });

  test("representative Scope-3 builtins are present", () => {
    const mem = listMemoryFunctionNames();
    for (const name of [
      "sin",
      "cos",
      "pow",
      "sqrt",
      "instr",
      "concat",
      "unicode",
      "unixepoch",
      "ntile",
      "uuid",
      "json_array_insert",
      "jsonb_array_insert",
      "load_extension",
    ]) {
      expect(mem.has(name)).toBe(true);
    }
  });

  test("load_extension is registered but not authorized", () => {
    const db = new InMemoryAdapter();
    try {
      const result = db.query("SELECT load_extension('x')");
      expect(result.ok).toBe(false);
    } finally {
      db.close();
    }
  });
});
