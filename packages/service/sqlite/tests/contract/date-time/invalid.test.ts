import { parity } from "../helpers.ts";

parity("date of invalid month yields null-ish", [], "SELECT date('2001-13-15') AS value");
parity("datetime of invalid day yields null-ish", [], "SELECT datetime('2001-02-30') AS value");
parity("date with out-of-range hour modifier", [], "SELECT datetime('2001-05-15','+99 hours') AS value");
parity("date with large day offset", [], "SELECT date('2001-05-15','+400 days') AS value");
parity("unixepoch of invalid date", [], "SELECT unixepoch('not-a-date') AS value");
parity("strftime on invalid date", [], "SELECT strftime('%Y-%m-%d','2001-02-30') AS value");
parity("datetime julian day edge", [], "SELECT datetime(2451545.0) AS value");
parity("time with fractional invalid", [], "SELECT time('25:00:00') AS value");
