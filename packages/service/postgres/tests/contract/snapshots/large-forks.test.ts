import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { sequenceParity } from "../helpers.ts";

const values = Array.from({ length: 4200 }, (_, i) => `(${i},${i},'v${i}')`).join(",");
const create = "CREATE TABLE t(id INTEGER PRIMARY KEY, k INTEGER UNIQUE, value TEXT)";
sequenceParity(
  "large sparse row forks isolate updates, failed constraints, DDL and repeated savepoint rollback",
  [create, `INSERT INTO t VALUES ${values}`],
  [
    { sql: "BEGIN; UPDATE t SET k = k + 5000, value = 'changed' WHERE id = 31" },
    { sql: "SAVEPOINT nested; UPDATE t SET value = 'lost' WHERE id = 32" },
    { sql: "ROLLBACK TO nested; UPDATE t SET value = 'lost again' WHERE id = 33; ROLLBACK TO nested" },
    { sql: "SELECT * FROM t WHERE id BETWEEN 30 AND 34 ORDER BY id", query: true },
    { sql: "ALTER TABLE t ADD COLUMN extra INTEGER DEFAULT 7" },
    { sql: "ROLLBACK TO nested; RELEASE nested; COMMIT" },
    { sql: "SELECT * FROM t WHERE k >= 5030 AND k < 5040 ORDER BY id", query: true },
    { sql: "BEGIN; UPDATE t SET value = 'temporary' WHERE id = 35; ROLLBACK" },
    { sql: "SELECT * FROM t WHERE id >= 30 AND id <= 35 ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

test("large sparse forks keep native row arrays, xmin, history and snapshot bytes isolated", () => {
  const db = new Database();
  db.exec(create);
  db.exec(`INSERT INTO t VALUES ${values}`);
  const snapshot = db.snapshot();
  const bytes = snapshot.encode().slice();
  const left = snapshot.open();
  const right = snapshot.open();
  try {
    left.transaction(() => left.exec("UPDATE t SET value = 'left', k = 7000 WHERE id = 31"));
    right.transaction(() => right.exec("UPDATE t SET value = 'right', k = 8000 WHERE id = 31"));
    expect(left.query("SELECT value FROM t WHERE k = 7000")).toEqual([{ value: "left" }]);
    expect(right.query("SELECT value FROM t WHERE k = 8000")).toEqual([{ value: "right" }]);
    expect(snapshot.encode()).toEqual(bytes);
    const restored = Snapshot.decode(left.snapshot().encode()).open();
    const historical = snapshot.open();
    try {
      expect(restored.query("SELECT *, xmin FROM t ORDER BY id")).toEqual(
        left.query("SELECT *, xmin FROM t ORDER BY id"),
      );
      expect(historical.query("SELECT value FROM t WHERE id = 31")).toEqual([{ value: "v31" }]);
    } finally {
      restored.close();
      historical.close();
    }
    const table = left.state.findTable(["t"])!;
    const native = table.rows;
    expect(Array.isArray(native)).toBe(true);
    expect(table.rows).toBe(native);
    expect(native[31]).toBe(table.rowAt(31));
    expect(structuredClone(native)).toEqual(native);
    const branch = table.cloneForDml();
    native[31] = [31, 9000, "native mutation"];
    expect(table.rowAt(31)[2]).toBe("native mutation");
    expect(branch.rowAt(31)[2]).toBe("left");
    const replacement = native.slice();
    table.rows = replacement;
    expect(table.rows).toBe(replacement);
    expect(Object.keys(table)).toContain("rows");
  } finally {
    left.close();
    right.close();
    db.close();
  }
});
