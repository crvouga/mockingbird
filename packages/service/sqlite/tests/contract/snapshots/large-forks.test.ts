import { expect, test } from "bun:test";
import { ForkMap } from "@crvouga/mockingbird-core";
import { Database, Snapshot } from "../../../src/index.ts";
import { sequenceParity } from "../helpers.ts";

const values = Array.from({ length: 4200 }, (_, i) => `(${i}, ${i}, 'v${i}')`).join(",");
for (const withoutRowid of [false, true]) {
  const create = `CREATE TABLE t(id INTEGER PRIMARY KEY, k INTEGER UNIQUE, value TEXT)${withoutRowid ? " WITHOUT ROWID" : ""}`;
  sequenceParity(
    `large shared row/index pages preserve nested rollback and constraint failures (withoutRowid=${withoutRowid})`,
    [create, `INSERT INTO t VALUES ${values}`],
    [
      { sql: "BEGIN; UPDATE t SET k = k + 10000, value = 'changed' WHERE id BETWEEN 20 AND 80" },
      { sql: "SAVEPOINT nested; DELETE FROM t WHERE id BETWEEN 30 AND 40" },
      { sql: "INSERT INTO t VALUES (5000,5000,'new')" },
      { sql: "ROLLBACK TO nested; RELEASE nested" },
      { sql: "SELECT * FROM t WHERE id BETWEEN 25 AND 45 ORDER BY id", query: true },
      { sql: "UPDATE t SET k = 10020 WHERE id = 100" },
      { sql: "SELECT id FROM t WHERE k = 10020", query: true },
      { sql: "ROLLBACK" },
      { sql: "SELECT id FROM t WHERE k BETWEEN 20 AND 80 ORDER BY id", query: true },
    ],
    { compareFinalState: true },
  );

  test(`large row forks retain native Map access and deterministic snapshot branches (withoutRowid=${withoutRowid})`, () => {
    const db = new Database();
    db.exec(create);
    db.exec(`INSERT INTO t VALUES ${values}`);
    const snapshot = db.snapshot();
    const bytes = snapshot.encode().slice();
    const left = snapshot.open();
    const right = snapshot.open();
    try {
      left.exec("UPDATE t SET k = 10000, value = 'left' WHERE id = 31");
      right.exec("DELETE FROM t WHERE id = 31; INSERT INTO t VALUES (6000,6000,'right')");
      expect(left.query("SELECT value FROM t WHERE k = 10000")).toEqual([{ value: "left" }]);
      expect(right.query("SELECT value FROM t WHERE k = 31")).toEqual([]);
      expect(snapshot.encode()).toEqual(bytes);
      const historical = snapshot.open();
      const restored = Snapshot.decode(left.snapshot().encode()).open();
      try {
        expect(historical.query("SELECT value FROM t WHERE k = 31")).toEqual([{ value: "v31" }]);
        expect(restored.query("SELECT * FROM t ORDER BY id")).toEqual(left.query("SELECT * FROM t ORDER BY id"));
      } finally {
        historical.close();
        restored.close();
      }
      const table = left.state.getTable("t");
      expect(table.rowStore instanceof ForkMap).toBe(true);
      left.exec("ALTER TABLE t DROP COLUMN value");
      expect(right.query("SELECT value FROM t WHERE id = 32")).toEqual([{ value: "v32" }]);
      const beforeAlter = snapshot.open();
      try {
        expect(beforeAlter.query("SELECT value FROM t WHERE id = 32")).toEqual([{ value: "v32" }]);
      } finally {
        beforeAlter.close();
      }
      const current = left.state.getTable("t");
      // The SQL engine keeps structural sharing private. Existing introspection/mutation
      // retains native Map brand, stable identity, iteration, and structuredClone support.
      const native = current.rows;
      expect(native instanceof Map).toBe(true);
      expect(current.rows).toBe(native);
      expect(Map.prototype.get.call(native, 31)).toBe(current.get(31));
      expect(structuredClone(native)).toEqual(native);
      const cloned = current.clone();
      expect(current.rows).toBe(native);
      expect(cloned.rows).not.toBe(native);
      const clustered = current.clusteredRows;
      expect(clustered instanceof Map).toBe(true);
      expect(current.clusteredRows).toBe(clustered);
      expect(Object.keys(current)).toContain("rows");
      expect(Object.keys(current)).toContain("clusteredRows");
      const replacement = new Map(native);
      current.rows = replacement;
      expect(current.rows).toBe(replacement);
      replacement.delete(31);
      expect(current.get(31)).toBeUndefined();
      expect(cloned.get(31)).toBeDefined();
    } finally {
      left.close();
      right.close();
      db.close();
    }
  });
}
