import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, execParity, queryErrorParity, sequenceParity, setupBoth } from "../helpers.ts";

// #692: MERGE INTO ... USING ... ON ... WHEN [NOT] MATCHED [BY SOURCE | BY TARGET] ... [RETURNING].

const setup = ["CREATE TABLE c (a int PRIMARY KEY, b int)", "INSERT INTO c VALUES (1, 1), (3, 3)"];

execParity(
  "MERGE upsert from VALUES",
  setup,
  "MERGE INTO c USING (VALUES (1, 9), (2, 9)) AS s(a, b) ON c.a = s.a WHEN MATCHED THEN UPDATE SET b = s.b WHEN NOT MATCHED THEN INSERT VALUES (s.a, s.b)",
);
sequenceParity(
  "MERGE with every clause kind and conditions",
  setup,
  [
    {
      sql: "MERGE INTO c t USING (VALUES (1, 5), (4, 4)) s(a, b) ON t.a = s.a WHEN MATCHED AND s.b > 100 THEN DELETE WHEN MATCHED THEN UPDATE SET b = t.b + s.b WHEN NOT MATCHED BY SOURCE AND t.a = 3 THEN DELETE WHEN NOT MATCHED THEN INSERT (a) VALUES (s.a)",
    },
    { sql: "SELECT * FROM c ORDER BY a", query: true },
    {
      sql: "MERGE INTO c t USING (SELECT 1 AS a) s ON t.a = s.a WHEN MATCHED THEN DO NOTHING WHEN NOT MATCHED THEN INSERT DEFAULT VALUES",
    },
    {
      sql: "WITH src AS (SELECT 50 AS a) MERGE INTO c USING src ON c.a = src.a WHEN NOT MATCHED BY TARGET THEN INSERT VALUES (src.a, DEFAULT)",
    },
    { sql: "MERGE INTO c USING c AS s ON c.a = s.a + 1000 WHEN NOT MATCHED BY SOURCE THEN UPDATE SET b = -1" },
    { sql: "SELECT * FROM c ORDER BY a", query: true },
  ],
  { compareFinalState: true },
);

matrixBoth("MERGE RETURNING merge_action(), old / new and the source row", async (memory, postgres) => {
  await setupBoth(memory, postgres, setup);
  const sql =
    "MERGE INTO c t USING (VALUES (1, 5), (4, 4)) s(a, b) ON t.a = s.a WHEN MATCHED THEN UPDATE SET b = t.b + s.b WHEN NOT MATCHED BY SOURCE THEN DELETE WHEN NOT MATCHED THEN INSERT VALUES (s.a, s.b) RETURNING merge_action(), t.*, s.*, *, old.b AS old_b, new.b AS new_b";
  // the row order follows the join PostgreSQL plans, so compare as sets
  expectParity(await memory.query(sql), await postgres.query(sql), { unordered: true, ignoreWriteCounters: true });
});

queryErrorParity(
  "a target row matched twice",
  setup,
  "MERGE INTO c t USING (VALUES (1, 5), (1, 6)) s(a, b) ON t.a = s.a WHEN MATCHED THEN UPDATE SET b = s.b",
  "cardinality",
);
execParity(
  "a target row matched twice by DO NOTHING is fine",
  setup,
  "MERGE INTO c t USING (VALUES (1, 5), (1, 6)) s(a, b) ON t.a = s.a WHEN MATCHED THEN DO NOTHING",
);
sequenceParity("a failing MERGE leaves the table unchanged", setup, [
  { sql: "MERGE INTO c USING (SELECT 1 AS a) s ON true WHEN MATCHED THEN UPDATE SET a = 1000" },
  { sql: "SELECT * FROM c ORDER BY a", query: true },
]);
errorParity(
  "WHEN MATCHED cannot INSERT",
  setup,
  "MERGE INTO c t USING (SELECT 1 AS a) s ON t.a = s.a WHEN MATCHED THEN INSERT VALUES (1, 1)",
  "syntax",
);
errorParity(
  "WHEN NOT MATCHED cannot UPDATE",
  setup,
  "MERGE INTO c t USING (SELECT 1 AS a) s ON t.a = s.a WHEN NOT MATCHED THEN UPDATE SET b = 1",
  "syntax",
);
errorParity(
  "WHEN NOT MATCHED cannot read the target",
  setup,
  "MERGE INTO c t USING (SELECT 7 AS a) s ON t.a = s.a WHEN NOT MATCHED THEN INSERT VALUES (s.a, t.b)",
  "undefined_table",
);
errorParity(
  "MERGE into a missing table",
  [],
  "MERGE INTO nope USING (SELECT 1 AS a) s ON true WHEN MATCHED THEN DELETE",
  "undefined_table",
);
queryErrorParity("merge_action() outside MERGE", [], "SELECT merge_action()", "syntax");
errorParity(
  "MERGE inserting a duplicate key",
  setup,
  "MERGE INTO c USING (VALUES (7), (7)) s(a) ON c.a = s.a WHEN NOT MATCHED THEN INSERT VALUES (s.a, 0)",
  "constraint_unique",
);

sequenceParity(
  "MERGE fires the statement triggers of every action it names, in PostgreSQL's order",
  [
    ...setup,
    "CREATE TABLE log (what text)",
    "CREATE FUNCTION trace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO log VALUES (TG_WHEN || ' ' || TG_OP); RETURN NULL; END $$",
    "CREATE TRIGGER s BEFORE INSERT OR UPDATE OR DELETE ON c FOR EACH STATEMENT EXECUTE FUNCTION trace()",
    "CREATE TRIGGER s2 AFTER INSERT OR UPDATE OR DELETE ON c FOR EACH STATEMENT EXECUTE FUNCTION trace()",
  ],
  [
    {
      sql: "MERGE INTO c USING (VALUES (1), (2)) s(a) ON c.a = s.a WHEN MATCHED THEN UPDATE SET b = 10 WHEN NOT MATCHED THEN INSERT VALUES (s.a, 0) WHEN NOT MATCHED BY SOURCE THEN DELETE",
    },
    { sql: "SELECT string_agg(what, '; ') AS fired FROM log", query: true },
  ],
);

test("MERGE fires row triggers and reports the row count", () => {
  const db = new Database();
  db.exec(`CREATE TABLE c (a int PRIMARY KEY, b int);
    CREATE TABLE log (what text);
    CREATE FUNCTION trace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO log VALUES (TG_OP || ' ' || COALESCE(NEW.a, OLD.a)); RETURN COALESCE(NEW, OLD); END $$;
    CREATE TRIGGER t BEFORE INSERT OR UPDATE OR DELETE ON c FOR EACH ROW EXECUTE FUNCTION trace();
    INSERT INTO c VALUES (1, 1), (2, 2);
    DELETE FROM log;`);
  const result = db
    .prepare(
      "MERGE INTO c USING (VALUES (1), (3)) s(a) ON c.a = s.a WHEN MATCHED THEN UPDATE SET b = 10 WHEN NOT MATCHED THEN INSERT VALUES (s.a, 0) WHEN NOT MATCHED BY SOURCE THEN DELETE",
    )
    .run();
  expect(result.rowCount).toBe(3);
  expect(db.query("SELECT what FROM log ORDER BY what")).toEqual([
    { what: "DELETE 2" },
    { what: "INSERT 3" },
    { what: "UPDATE 1" },
  ]);
  expect(db.query("SELECT * FROM c ORDER BY a")).toEqual([
    { a: 1, b: 10 },
    { a: 3, b: 0 },
  ]);
  db.close();
});

// #692: MERGE inside WITH runs (more in tests/contract/issue-692/tablesample-merge-cte.test.ts)
test("MERGE in a WITH query", () => {
  const db = new Database();
  db.exec("CREATE TABLE c (a int)");
  expect(
    db.query(
      "WITH m AS (MERGE INTO c USING (SELECT 1 AS a) s ON true WHEN NOT MATCHED THEN INSERT VALUES (1) RETURNING *) SELECT * FROM m",
    ),
  ).toEqual([{ a: 1 }]);
  db.close();
});
