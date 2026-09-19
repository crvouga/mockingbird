import { parity, parityTyped } from "../helpers.ts";

parity("date plus integer days", [], "SELECT date '2024-01-15' + 10 AS a, date '2024-01-15' - 20 AS b");
parity("date minus date is integer", [], "SELECT date '2024-03-01' - date '2024-01-01' AS v");
parityTyped("date difference type", [], "SELECT date '2024-03-01' - date '2024-01-01' AS v");
parity("date plus interval", [], "SELECT date '2024-01-15' + interval '1 month' AS v");
parityTyped("date plus interval is timestamp", [], "SELECT date '2024-01-15' + interval '1 day' AS v");
parity("timestamp plus interval", [], "SELECT timestamp '2024-01-15 10:00:00' + interval '90 minutes' AS v");
parity("timestamp minus interval", [], "SELECT timestamp '2024-01-15 10:00:00' - interval '1 day 1 hour' AS v");
parity(
  "timestamp difference is interval",
  [],
  "SELECT timestamp '2024-03-15 12:00:00' - timestamp '2024-01-15 10:30:00' AS v",
);
parity("month arithmetic clamps end of month", [], "SELECT date '2024-01-31' + interval '1 month' AS v");
parity("leap year february arithmetic", [], "SELECT date '2024-02-29' + interval '1 year' AS v");
parity("age of two timestamps", [], "SELECT age(timestamp '2024-03-15', timestamp '2022-01-10') AS v");
parity("age negative direction", [], "SELECT age(timestamp '2022-01-10', timestamp '2024-03-15') AS v");
parity(
  "date comparison operators",
  [],
  "SELECT date '2024-01-01' < date '2024-02-01' AS a, date '2024-01-01' = date '2024-01-01' AS b",
);
parity("timestamp date cross comparison", [], "SELECT timestamp '2024-01-15 00:00:00' = date '2024-01-15' AS v");
parity("time plus interval", [], "SELECT time '10:30:00' + interval '2 hours' AS v");
parity("time arithmetic wraps midnight", [], "SELECT time '23:00:00' + interval '2 hours' AS v");
parity(
  "order by date",
  ["CREATE TABLE t (d date)", "INSERT INTO t VALUES ('2024-03-01'), ('2023-12-31'), ('2024-01-15')"],
  "SELECT d FROM t ORDER BY d",
);
