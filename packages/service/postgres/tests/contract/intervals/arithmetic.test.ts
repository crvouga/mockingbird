import { parity, parityTyped } from "../helpers.ts";

parity("interval addition", [], "SELECT interval '1 day' + interval '3 hours' AS v");
parity("interval addition across units", [], "SELECT interval '1 month' + interval '40 days' AS v");
parity("interval subtraction", [], "SELECT interval '1 day' - interval '3 hours' AS v");
parity("interval subtraction goes negative", [], "SELECT interval '1 hour' - interval '90 minutes' AS v");
parity("interval negation", [], "SELECT - interval '1 day 2 hours' AS v");
parity("interval multiplication by integer", [], "SELECT interval '1 day 3 hours' * 2 AS v");
parity("interval multiplication by fraction", [], "SELECT interval '1 hour' * 1.5 AS v");
parity("interval division", [], "SELECT interval '1 day' / 2 AS v, interval '3 hours' / 3 AS w");
parity("interval division producing remainder", [], "SELECT interval '1 month' / 2 AS v");
parity(
  "interval comparison",
  [],
  "SELECT interval '1 day' = interval '24 hours' AS a, interval '25 hours' > interval '1 day' AS b",
);
parity("interval equality across units", [], "SELECT interval '1 month' = interval '30 days' AS v");
parityTyped("interval arithmetic type", [], "SELECT interval '1 day' + interval '1 hour' AS v");
parity(
  "order by interval",
  ["CREATE TABLE t (v interval)", "INSERT INTO t VALUES ('2 hours'), ('1 day'), ('30 minutes'), ('-1 hour')"],
  "SELECT v FROM t ORDER BY v",
);
parity(
  "sum of intervals",
  ["CREATE TABLE t (v interval)", "INSERT INTO t VALUES ('1 hour'), ('30 minutes')"],
  "SELECT sum(v) AS v FROM t",
);
