import { parity } from "../helpers.ts";

parity("union deduplicates", [], "SELECT 1 AS v UNION SELECT 1 UNION SELECT 2 ORDER BY v");
parity("union all keeps duplicates", [], "SELECT 1 AS v UNION ALL SELECT 1 UNION ALL SELECT 2 ORDER BY v");
parity(
  "union of two tables",
  [
    "CREATE TABLE a (v int)",
    "CREATE TABLE b (v int)",
    "INSERT INTO a VALUES (1), (2), (3)",
    "INSERT INTO b VALUES (2), (3), (4)",
  ],
  "SELECT v FROM a UNION SELECT v FROM b ORDER BY v",
);
parity(
  "union all of two tables",
  [
    "CREATE TABLE a (v int)",
    "CREATE TABLE b (v int)",
    "INSERT INTO a VALUES (1), (2)",
    "INSERT INTO b VALUES (2), (3)",
  ],
  "SELECT v FROM a UNION ALL SELECT v FROM b ORDER BY v",
);
parity(
  "intersect",
  [
    "CREATE TABLE a (v int)",
    "CREATE TABLE b (v int)",
    "INSERT INTO a VALUES (1), (2), (2), (3)",
    "INSERT INTO b VALUES (2), (2), (3), (4)",
  ],
  "SELECT v FROM a INTERSECT SELECT v FROM b ORDER BY v",
);
parity(
  "intersect all keeps common multiplicity",
  [
    "CREATE TABLE a (v int)",
    "CREATE TABLE b (v int)",
    "INSERT INTO a VALUES (1), (2), (2), (2)",
    "INSERT INTO b VALUES (2), (2), (3)",
  ],
  "SELECT v FROM a INTERSECT ALL SELECT v FROM b ORDER BY v",
);
parity(
  "except",
  [
    "CREATE TABLE a (v int)",
    "CREATE TABLE b (v int)",
    "INSERT INTO a VALUES (1), (2), (2), (3)",
    "INSERT INTO b VALUES (2), (4)",
  ],
  "SELECT v FROM a EXCEPT SELECT v FROM b ORDER BY v",
);
parity(
  "except all subtracts multiplicity",
  [
    "CREATE TABLE a (v int)",
    "CREATE TABLE b (v int)",
    "INSERT INTO a VALUES (1), (2), (2), (2)",
    "INSERT INTO b VALUES (2)",
  ],
  "SELECT v FROM a EXCEPT ALL SELECT v FROM b ORDER BY v",
);
parity("union with null branches", [], "SELECT NULL::int AS v UNION SELECT 1 ORDER BY v NULLS LAST");
parity("union dedupes nulls", [], "SELECT NULL::int AS v UNION SELECT NULL::int ORDER BY v");
parity("multi-column union", [], "SELECT 1 AS a, 'x' AS b UNION SELECT 2, 'y' UNION SELECT 1, 'x' ORDER BY a, b");
parity(
  "column names come from first branch",
  [],
  "SELECT 1 AS first_name UNION ALL SELECT 2 AS ignored ORDER BY first_name",
);
parity(
  "union of values lists",
  [],
  "SELECT * FROM (VALUES (1), (2)) a(v) UNION SELECT * FROM (VALUES (2), (3)) b(v) ORDER BY v",
);
parity(
  "empty branches union",
  ["CREATE TABLE a (v int)", "CREATE TABLE b (v int)"],
  "SELECT v FROM a UNION SELECT v FROM b",
);
