import { expect } from "bun:test";
import { matrixBoth } from "../../harness/index.ts";
import { setupBoth } from "../helpers.ts";

function names(result: { rows: Array<Record<string, unknown>> }): string[] {
  return result.rows.map((row) => String(row.name).toLowerCase());
}

matrixBoth("pragma_function_list columns match; name sets are not identical", (memory, sqlite) => {
  const actual = memory.query("SELECT name, type, narg FROM pragma_function_list ORDER BY name, type, narg");
  const oracle = sqlite.query("SELECT name, type, narg FROM pragma_function_list ORDER BY name, type, narg");
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.columns).toEqual(oracle.columns);

  const memNames = new Set(names(actual));
  const oracleNames = new Set(names(oracle));
  expect(memNames.has("abs")).toBe(true);
  expect(oracleNames.has("abs")).toBe(true);
  expect(memNames.has("generate_series")).toBe(true);
  expect(oracleNames.has("generate_series")).toBe(false);
});

matrixBoth("pragma_compile_options columns match and the option sets differ", (memory, sqlite) => {
  const actual = memory.query("PRAGMA compile_options");
  const oracle = sqlite.query("PRAGMA compile_options");
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.columns).toEqual(oracle.columns);
  expect(actual.rows.length).toBeGreaterThan(0);
  expect(oracle.rows.length).toBeGreaterThan(0);
  const memOpts = new Set(actual.rows.map((row) => String(row.compile_options)));
  const oraOpts = new Set(oracle.rows.map((row) => String(row.compile_options)));
  expect(memOpts.has("COMPILER=typescript")).toBe(true);
  expect(oraOpts.has("COMPILER=typescript")).toBe(false);
});

matrixBoth("pragma_compile_options TVF uses the same sqlite-mem option set as the statement form", (memory, sqlite) => {
  setupBoth(memory, sqlite, []);
  const statement = memory.query("PRAGMA compile_options");
  const tvf = memory.query("SELECT compile_options FROM pragma_compile_options ORDER BY 1");
  expect(statement.ok && tvf.ok).toBe(true);
  expect(statement.columns).toEqual(sqlite.query("PRAGMA compile_options").columns);
  expect(new Set(statement.rows.map((row) => String(row.compile_options)))).toEqual(
    new Set(tvf.rows.map((row) => String(row.compile_options))),
  );
});
