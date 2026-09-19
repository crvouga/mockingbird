import { errorParity, parity, parityTyped, sequenceParity } from "../helpers.ts";

parity("SELECT 1", [], "SELECT 1 AS v");
parity("SELECT literal text", [], "SELECT 'hello' AS v");
parity("SELECT NULL", [], "SELECT NULL AS v");
parity("SELECT arithmetic", [], "SELECT 1 + 2 * 3 AS v");
parity("SELECT float division", [], "SELECT 7.5 / 2 AS v");
parity("SELECT boolean", [], "SELECT true AS t, false AS f");
parity("SELECT string concat", [], "SELECT 'a' || 'b' || 'c' AS v");
parity("SELECT with parameter", [], "SELECT $1::int AS v", [42]);

parityTyped("typed integer literal", [], "SELECT 1 AS v");
parityTyped("typed numeric literal", [], "SELECT 1.5 AS v");
parityTyped("typed text", [], "SELECT 'x' AS v");

parity(
  "basic table roundtrip",
  ["CREATE TABLE t (id int, name text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  "SELECT * FROM t ORDER BY id",
);

sequenceParity(
  "insert update delete sequence",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)"],
  [
    { sql: "INSERT INTO t VALUES (1, 'x'), (2, 'y')" },
    { sql: "UPDATE t SET v = 'z' WHERE id = 1" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "DELETE FROM t WHERE id = 2" },
    { sql: "SELECT count(*) FROM t", query: true },
  ],
  { compareFinalState: true },
);

errorParity("undefined table", [], "SELECT * FROM missing_table", "undefined_table");
errorParity("division by zero", [], "SELECT 1/0", "division_by_zero");
errorParity(
  "unique violation",
  ["CREATE TABLE u (id int PRIMARY KEY)", "INSERT INTO u VALUES (1)"],
  "INSERT INTO u VALUES (1)",
  "constraint_unique",
);
