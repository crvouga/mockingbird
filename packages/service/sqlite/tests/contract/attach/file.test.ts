import { Database as BunDatabase } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matrixBoth } from "../../harness/index.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("ATTACH of a file path stores the filename and opens an empty in-memory schema", (memory, sqlite) => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-mem-attach-"));
  const path = join(dir, "other.sqlite");
  try {
    const seed = new BunDatabase(path);
    seed.exec("CREATE TABLE t(x INTEGER)");
    seed.exec("INSERT INTO t VALUES (7)");
    seed.close();

    const attach = `ATTACH '${path.replaceAll("'", "''")}' AS other`;
    expect(memory.exec(attach).ok).toBe(true);
    expect(sqlite.exec(attach).ok).toBe(true);

    const memList = memory.query("SELECT name, file FROM pragma_database_list WHERE name = 'other'");
    const oraList = sqlite.query("SELECT name, file FROM pragma_database_list WHERE name = 'other'");
    expect(memList.ok && oraList.ok).toBe(true);
    expect(memList.rows[0]?.name).toBe("other");
    expect(String(memList.rows[0]?.file)).toBe(path);
    expect(String(oraList.rows[0]?.file)).toContain("other.sqlite");

    const memTable = memory.query("SELECT x FROM other.t");
    const oraTable = sqlite.query("SELECT x FROM other.t");
    expect(memTable.ok).toBe(false);
    expect(oraTable.ok).toBe(true);
    expect(oraTable.values).toEqual([[7]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

matrixBoth("ATTACH :memory: still matches oracle", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "ATTACH ':memory:' AS other",
    "CREATE TABLE other.t(x INTEGER)",
    "INSERT INTO other.t VALUES (1)",
  ]);
  const actual = memory.query("SELECT x FROM other.t");
  const oracle = sqlite.query("SELECT x FROM other.t");
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.values).toEqual(oracle.values);
});
