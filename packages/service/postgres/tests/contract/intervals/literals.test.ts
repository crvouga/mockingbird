import { parity, parityTyped, queryErrorParity } from "../helpers.ts";

parity(
  "interval single units",
  [],
  "SELECT interval '1 day' AS a, interval '3 hours' AS b, interval '90 seconds' AS c",
);
parity("interval combined units", [], "SELECT interval '1 year 2 months 3 days' AS v");
parity("interval time part", [], "SELECT interval '1 day 02:03:04' AS v");
parity("interval sql standard year-month", [], "SELECT interval '1-2' AS v");
parity("interval iso 8601 form", [], "SELECT interval 'P1Y2M3DT4H5M6S' AS v");
parity("interval iso 8601 weeks", [], "SELECT interval 'P2W' AS v");
parity("interval negative units", [], "SELECT interval '-1 day' AS a, interval '-2 hours -30 minutes' AS b");
parity("interval mixed signs output", [], "SELECT interval '1 day -2 hours' AS a, interval '-1 month 5 days' AS b");
parity("interval ago suffix", [], "SELECT interval '2 days 3 hours ago' AS v");
parity("interval fractional units", [], "SELECT interval '1.5 days' AS a, interval '2.5 hours' AS b");
parity("interval fractional months spill to days", [], "SELECT interval '1.5 months' AS v");
parity(
  "interval plural and abbreviated units",
  [],
  "SELECT interval '2 hrs' AS a, interval '3 mins' AS b, interval '10 secs' AS c",
);
parity("interval microseconds", [], "SELECT interval '1.234567 seconds' AS v");
parity("interval zero", [], "SELECT interval '0' AS v, interval '00:00:00' AS w");
parityTyped("interval type", [], "SELECT interval '1 day' AS v");
queryErrorParity("invalid interval text", [], "SELECT 'bogus'::interval", "data_exception");
