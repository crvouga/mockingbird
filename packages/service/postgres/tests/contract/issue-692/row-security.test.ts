import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, sequenceParity } from "../helpers.ts";

// #692: row-level security — CREATE / ALTER / DROP POLICY, ENABLE / FORCE ROW LEVEL SECURITY,
// and policy enforcement for the current role under SET ROLE.

const q = (sql: string) => ({ sql, query: true });

const setup = [
  "CREATE TABLE r (id int PRIMARY KEY, owner text, v int)",
  "INSERT INTO r VALUES (1, 'alice', 10), (2, 'bob', 20), (3, 'alice', 30)",
  "CREATE ROLE alice",
  "CREATE ROLE bob",
  "GRANT SELECT, INSERT, UPDATE, DELETE ON r TO alice, bob",
  "ALTER TABLE r ENABLE ROW LEVEL SECURITY",
  "CREATE POLICY own ON r USING (owner = current_user) WITH CHECK (owner = current_user AND v < 100)",
];

sequenceParity(
  "a policy limits what each role sees and writes",
  setup,
  [
    { sql: "SET ROLE alice" },
    q("SELECT * FROM r ORDER BY id"),
    q("SELECT count(*) FROM r WHERE id = 2"),
    { sql: "INSERT INTO r VALUES (4, 'alice', 40)" },
    q("UPDATE r SET v = v + 1 RETURNING *"),
    { sql: "DELETE FROM r WHERE id = 2" },
    q("DELETE FROM r WHERE id = 3 RETURNING *"),
    { sql: "SET ROLE bob" },
    q("SELECT * FROM r ORDER BY id"),
    { sql: "RESET ROLE" },
    q("SELECT * FROM r ORDER BY id"),
  ],
  { compareFinalState: true },
);
errorParity(
  "WITH CHECK refuses another owner's row",
  [...setup, "SET ROLE alice"],
  "INSERT INTO r VALUES (5, 'bob', 50)",
);
errorParity("WITH CHECK refuses a value", [...setup, "SET ROLE alice"], "INSERT INTO r VALUES (6, 'alice', 500)");
errorParity(
  "UPDATE may not move a row out of the policy",
  [...setup, "SET ROLE alice"],
  "UPDATE r SET owner = 'bob' WHERE id = 1",
);

sequenceParity(
  "restrictive policies narrow permissive ones; command policies and roles",
  [
    ...setup,
    "CREATE POLICY rst ON r AS RESTRICTIVE FOR SELECT TO alice USING (v > 15)",
    "CREATE POLICY bob_reads ON r FOR SELECT TO bob USING (true)",
    "CREATE POLICY bob_inserts ON r FOR INSERT TO bob WITH CHECK (v >= 0)",
  ],
  [
    { sql: "SET ROLE alice" },
    q("SELECT * FROM r ORDER BY id"),
    { sql: "SET ROLE bob" },
    q("SELECT * FROM r ORDER BY id"),
    { sql: "INSERT INTO r VALUES (7, 'carol', 1)" },
    q("UPDATE r SET v = 0 WHERE owner = 'alice' RETURNING id"),
    { sql: "RESET ROLE" },
    q("SELECT * FROM r ORDER BY id"),
  ],
);
sequenceParity(
  "no policy for a role means no rows",
  [
    "CREATE TABLE s (a int)",
    "INSERT INTO s VALUES (1)",
    "CREATE ROLE carol",
    "GRANT ALL ON s TO carol",
    "ALTER TABLE s ENABLE ROW LEVEL SECURITY",
  ],
  [{ sql: "SET ROLE carol" }, q("SELECT count(*) FROM s"), q("UPDATE s SET a = 2 RETURNING a")],
);
errorParity(
  "and no inserts",
  [
    "CREATE TABLE s (a int)",
    "CREATE ROLE carol",
    "GRANT ALL ON s TO carol",
    "ALTER TABLE s ENABLE ROW LEVEL SECURITY",
    "SET ROLE carol",
  ],
  "INSERT INTO s VALUES (1)",
);
sequenceParity(
  "the owner and superusers bypass row security; FORCE binds the owner",
  [...setup, "CREATE ROLE boss", "ALTER TABLE r OWNER TO boss", "GRANT boss TO alice"],
  [
    q("SELECT count(*) FROM r"),
    { sql: "SET ROLE boss" },
    q("SELECT count(*) FROM r"),
    { sql: "RESET ROLE" },
    { sql: "ALTER TABLE r FORCE ROW LEVEL SECURITY" },
    { sql: "SET ROLE boss" },
    q("SELECT count(*) FROM r"),
    { sql: "RESET ROLE" },
    q("SELECT count(*) FROM r"),
    q("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'r'"),
    { sql: "ALTER TABLE r NO FORCE ROW LEVEL SECURITY" },
    { sql: "ALTER TABLE r DISABLE ROW LEVEL SECURITY" },
    q("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'r'"),
    { sql: "SET ROLE alice" },
    q("SELECT count(*) FROM r"),
  ],
);
errorParity(
  "row_security = off refuses a query policies would change",
  [...setup, "SET row_security = off", "SET ROLE bob"],
  "SELECT count(*) FROM r",
);

parity(
  "pg_policies",
  [...setup, "CREATE POLICY rst ON r AS RESTRICTIVE FOR SELECT TO alice, bob USING (v > 15)"],
  "SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies ORDER BY policyname",
);
parity(
  "pg_policy",
  [...setup, "CREATE POLICY ins ON r FOR INSERT TO bob WITH CHECK (v > 0)"],
  "SELECT polname, polcmd, polpermissive, pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS chk, cardinality(polroles) AS nroles, polrelid = 'r'::regclass AS rel FROM pg_policy ORDER BY polname",
);
sequenceParity("ALTER POLICY and DROP POLICY", setup, [
  { sql: "ALTER POLICY own ON r RENAME TO mine" },
  { sql: "ALTER POLICY mine ON r TO bob USING (v > 0)" },
  q("SELECT policyname, roles, qual, with_check FROM pg_policies"),
  { sql: "SET ROLE alice" },
  q("SELECT count(*) FROM r"),
  { sql: "SET ROLE bob" },
  q("SELECT count(*) FROM r"),
  { sql: "RESET ROLE" },
  { sql: "DROP POLICY mine ON r" },
  { sql: "DROP POLICY IF EXISTS mine ON r" },
  q("SELECT count(*) FROM pg_policies"),
]);
errorParity("a policy name is unique per table", setup, "CREATE POLICY own ON r USING (true)", "duplicate_object");
errorParity(
  "SELECT policies have no WITH CHECK",
  setup,
  "CREATE POLICY p ON r FOR SELECT USING (true) WITH CHECK (true)",
  "syntax",
);
errorParity("INSERT policies have no USING", setup, "CREATE POLICY p ON r FOR INSERT USING (true)", "syntax");
errorParity("a policy on a missing table", [], "CREATE POLICY p ON nope USING (true)", "undefined_table");
errorParity("a policy for a missing role", setup, "CREATE POLICY p ON r TO nobody USING (true)", "undefined_object");
errorParity("DROP a missing policy", setup, "DROP POLICY nope ON r", "undefined_object");

test("policies roll back with their transaction and survive snapshots", () => {
  const db = new Database();
  for (const sql of setup) db.exec(sql);
  db.exec("BEGIN");
  db.exec("DROP POLICY own ON r");
  db.exec("ROLLBACK");
  const copy = Snapshot.decode(db.snapshot().encode()).open();
  copy.exec("SET ROLE alice");
  expect(copy.query("SELECT id FROM r ORDER BY id")).toEqual([{ id: 1 }, { id: 3 }]);
  expect(() => copy.exec("COPY r FROM STDIN")).toThrow();
});

test("row security filters joins, subqueries and index lookups too", () => {
  const db = new Database();
  for (const sql of setup) db.exec(sql);
  db.exec("SET ROLE alice");
  expect(db.query("SELECT id FROM r WHERE id = 2")).toEqual([]);
  expect(db.query("SELECT (SELECT count(*)::int FROM r) AS n")).toEqual([{ n: 2 }]);
  expect(db.query("SELECT a.id FROM r a JOIN r b ON a.id = b.id ORDER BY 1")).toEqual([{ id: 1 }, { id: 3 }]);
});
