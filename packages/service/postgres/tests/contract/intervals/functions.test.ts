import { parity, parityTyped } from "../helpers.ts";

parity("extract hours from interval", [], "SELECT extract(hour FROM interval '27 hours 30 minutes') AS v");
parity("extract days from interval", [], "SELECT extract(day FROM interval '35 days 27 hours') AS v");
parity(
  "extract months and years from interval",
  [],
  "SELECT extract(month FROM interval '1 year 14 months') AS a, extract(year FROM interval '1 year 14 months') AS b",
);
parity("extract seconds from interval", [], "SELECT extract(second FROM interval '1 minute 30.5 seconds') AS v");
parity("extract epoch from interval", [], "SELECT extract(epoch FROM interval '1 day 1 hour') AS v");
parity("extract from negative interval", [], "SELECT extract(hour FROM interval '-3 hours') AS v");
parityTyped("extract interval field type", [], "SELECT extract(day FROM interval '3 days') AS v");
parity("make_interval years months days", [], "SELECT make_interval(1, 2, 0, 3) AS v");
parity("make_interval time parts", [], "SELECT make_interval(0, 0, 0, 0, 4, 5, 6.5) AS v");
parity("make_interval named notation", [], "SELECT make_interval(days => 10, hours => 2) AS v");
parity("make_interval weeks", [], "SELECT make_interval(weeks => 3) AS v");
parity("date_trunc on interval", [], "SELECT date_trunc('hour', interval '1 day 2:34:56') AS v");
parity("isfinite interval", [], "SELECT isfinite(interval '1 day') AS v");
parity("interval to text cast", [], "SELECT (interval '1 day 2 hours')::text AS v");
