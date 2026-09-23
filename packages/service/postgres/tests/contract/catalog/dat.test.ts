import { expect } from "bun:test";
import { DAT_SECTION } from "../../../compat/sections/dat.ts";
import { runCatalog } from "./run.ts";

runCatalog(DAT_SECTION, [
  {
    id: "DAT-lit-01",
    kind: "parity",
    sql: "SELECT date '2024-01-15' AS a, '2024-01-15'::date AS b, '20240115'::date AS c, '2024-02-29'::date AS leap",
  },
  {
    id: "DAT-lit-02",
    kind: "parity",
    sql:
      "SELECT timestamp '2024-01-15 10:30:00' AS a, timestamp '2024-01-15 10:30:00.123456' AS b, " +
      "'2024-01-15T10:30:00'::timestamp AS c, '2024-01-15 10:30'::timestamp AS d",
  },
  {
    id: "DAT-lit-03",
    kind: "parity",
    sql: "SELECT time '10:30:00' AS a, time '23:59:59.999' AS b, '00:00'::time AS c",
  },
  {
    id: "DAT-lit-04",
    kind: "parity",
    sql:
      "SELECT timestamptz '2024-01-15 10:30:00+00' AS a, '2024-01-15 10:30:00+05'::timestamptz AS b, " +
      "('2024-06-15 12:00:00+02'::timestamptz)::text AS c",
  },
  {
    id: "DAT-lit-05",
    kind: "parity",
    sql:
      "SELECT 'epoch'::timestamp AS e, 'infinity'::date::text AS a, '-infinity'::date::text AS b, " +
      "'infinity'::timestamp::text AS c, 'infinity'::date > '2024-01-01'::date AS gt",
  },
  {
    id: "DAT-cast-01",
    kind: "parity",
    sql:
      "SELECT (timestamp '2024-01-15 10:30:45')::date AS d, (timestamp '2024-01-15 10:30:45')::time AS t, " +
      "(date '2024-01-15')::timestamp AS ts",
  },
  {
    id: "DAT-ex-01",
    kind: "parity",
    sql:
      "SELECT extract(year FROM date '2024-03-15') AS y, extract(month FROM date '2024-03-15') AS mo, " +
      "extract(day FROM date '2024-03-15') AS d, extract(hour FROM timestamp '2024-03-15 13:45:30.5') AS h, " +
      "extract(minute FROM timestamp '2024-03-15 13:45:30.5') AS mi, extract(second FROM timestamp '2024-03-15 13:45:30.5') AS s",
  },
  {
    id: "DAT-ex-02",
    kind: "parity",
    sql:
      "SELECT extract(dow FROM date '2024-03-17') AS dow, extract(isodow FROM date '2024-03-17') AS isodow, " +
      "extract(doy FROM date '2024-03-15') AS doy, extract(week FROM date '2024-03-15') AS week",
  },
  {
    id: "DAT-ex-03",
    kind: "parity",
    sql:
      "SELECT extract(quarter FROM date '2024-03-31') AS q1, extract(quarter FROM date '2024-04-01') AS q2, " +
      "extract(century FROM date '2024-01-01') AS c, extract(decade FROM date '2024-01-01') AS d, " +
      "extract(millennium FROM date '2024-01-01') AS m",
  },
  {
    id: "DAT-ex-04",
    kind: "parity",
    sql: "SELECT extract(isoyear FROM date '2024-01-01') AS a, extract(isoyear FROM date '2022-01-01') AS b",
  },
  {
    id: "DAT-ex-05",
    kind: "parity",
    sql:
      "SELECT extract(epoch FROM timestamp '2024-01-15 00:00:00') AS ts, extract(epoch FROM date '1970-01-02') AS d, " +
      "extract(epoch FROM interval '1 day 1 hour') AS iv",
  },
  {
    id: "DAT-ex-06",
    kind: "parity",
    typed: true,
    sql: "SELECT extract(year FROM date '2024-03-15') AS ex, date_part('day', date '2024-03-15') AS dp",
  },
  {
    id: "DAT-ex-07",
    kind: "parity",
    sql:
      "SELECT extract(hour FROM interval '27 hours 30 minutes') AS h, extract(day FROM interval '35 days 27 hours') AS d, " +
      "extract(month FROM interval '1 year 14 months') AS mo, extract(second FROM interval '1 minute 30.5 seconds') AS s, " +
      "extract(hour FROM interval '-3 hours') AS neg",
  },
  {
    id: "DAT-trunc-01",
    kind: "parity",
    sql:
      "SELECT date_trunc('day', timestamp '2024-03-15 13:45:30') AS d, date_trunc('hour', timestamp '2024-03-15 13:45:30') AS h, " +
      "date_trunc('minute', timestamp '2024-03-15 13:45:30') AS mi",
  },
  {
    id: "DAT-trunc-02",
    kind: "parity",
    sql:
      "SELECT date_trunc('month', timestamp '2024-03-15 13:45:30') AS mo, date_trunc('year', timestamp '2024-03-15 13:45:30') AS y, " +
      "date_trunc('week', timestamp '2024-03-15 13:45:30') AS w, date_trunc('quarter', timestamp '2024-03-15 13:45:30') AS q, " +
      "date_trunc('decade', timestamp '2024-03-15 13:45:30') AS dec, date_trunc('century', timestamp '2024-03-15 13:45:30') AS c",
  },
  { id: "DAT-trunc-03", kind: "parity", sql: "SELECT date_trunc('hour', interval '1 day 2:34:56') AS v" },
  {
    id: "DAT-age-01",
    kind: "parity",
    sql:
      "SELECT age(timestamp '2024-03-15', timestamp '2022-01-10') AS fwd, " +
      "age(timestamp '2022-01-10', timestamp '2024-03-15') AS back",
  },
  {
    id: "DAT-arith-01",
    kind: "parity",
    sql: "SELECT date '2024-01-15' + 10 AS a, date '2024-01-15' - 20 AS b, date '2024-03-01' - date '2024-01-01' AS diff",
  },
  {
    id: "DAT-arith-02",
    kind: "parity",
    typed: true,
    sql: "SELECT date '2024-03-01' - date '2024-01-01' AS dd, date '2024-01-15' + interval '1 day' AS di",
  },
  {
    id: "DAT-arith-03",
    kind: "parity",
    sql:
      "SELECT timestamp '2024-01-15 10:00:00' + interval '90 minutes' AS a, " +
      "timestamp '2024-01-15 10:00:00' - interval '1 day 1 hour' AS b",
  },
  {
    id: "DAT-arith-04",
    kind: "parity",
    sql:
      "SELECT timestamp '2024-03-15 12:00:00' - timestamp '2024-01-15 10:30:00' AS fwd, " +
      "timestamp '2024-01-01' - timestamp '2024-03-15 06:30:00' AS back",
  },
  {
    id: "DAT-arith-05",
    kind: "parity",
    sql: "SELECT date '2024-01-31' + interval '1 month' AS clamp, date '2024-02-29' + interval '1 year' AS leap",
  },
  {
    id: "DAT-arith-06",
    kind: "parity",
    sql: "SELECT time '23:00:00' + interval '2 hours' AS wrap, time '10:30:00' + interval '2 hours' AS plain",
  },
  {
    id: "DAT-iv-01",
    kind: "parity",
    sql:
      "SELECT interval '1 day' AS a, interval '3 hours' AS b, interval '90 seconds' AS c, " +
      "interval '2 hrs' AS d, interval '3 mins' AS e, interval '1 year 2 months 3 days' AS f, interval '1 day 02:03:04' AS g",
  },
  {
    id: "DAT-iv-02",
    kind: "parity",
    sql: "SELECT interval '1-2' AS a, interval 'P1Y2M3DT4H5M6S' AS b, interval 'P2W' AS c",
  },
  {
    id: "DAT-iv-03",
    kind: "parity",
    sql:
      "SELECT interval '1 day -2 hours' AS a, interval '-1 month 5 days' AS b, interval '2 days 3 hours ago' AS c, " +
      "interval '-2 hours -30 minutes' AS d",
  },
  {
    id: "DAT-iv-04",
    kind: "parity",
    sql: "SELECT interval '1.5 days' AS a, interval '2.5 hours' AS b, interval '1.5 months' AS c, interval '1.234567 seconds' AS d",
  },
  {
    id: "DAT-iv-05",
    kind: "parity",
    sql:
      "SELECT interval '1 day' + interval '3 hours' AS a, interval '1 month' + interval '40 days' AS b, " +
      "interval '1 hour' - interval '90 minutes' AS c, - interval '1 day 2 hours' AS d",
  },
  {
    id: "DAT-iv-06",
    kind: "parity",
    sql:
      "SELECT interval '1 day 3 hours' * 2 AS a, interval '1 hour' * 1.5 AS b, interval '1 day' / 2 AS c, " +
      "interval '1 month' / 2 AS d",
  },
  {
    id: "DAT-iv-07",
    kind: "parity",
    sql:
      "SELECT interval '1 day' = interval '24 hours' AS a, interval '25 hours' > interval '1 day' AS b, " +
      "interval '1 month' = interval '30 days' AS c",
  },
  {
    id: "DAT-just-01",
    kind: "parity",
    sql:
      "SELECT justify_hours(interval '27 hours') AS a, justify_hours(interval '100 hours') AS b, " +
      "justify_days(interval '35 days') AS c, justify_days(interval '400 days') AS d",
  },
  {
    id: "DAT-just-02",
    kind: "parity",
    sql:
      "SELECT justify_interval(interval '1 month -1 hour') AS a, justify_interval(interval '35 days 27 hours') AS b, " +
      "justify_hours(interval '-27 hours') AS c, justify_interval(interval '1 month -35 days') AS d",
  },
  { id: "DAT-mk-01", kind: "parity", sql: "SELECT make_date(2024, 3, 15) AS d, make_time(13, 30, 45.5) AS t" },
  {
    id: "DAT-mk-02",
    kind: "parity",
    sql: "SELECT make_timestamp(2024, 3, 15, 13, 30, 45.5) AS ts, make_timestamptz(2024, 3, 15, 13, 30, 0, 'UTC') AS tstz",
  },
  {
    id: "DAT-mk-03",
    kind: "parity",
    sql:
      "SELECT make_interval(1, 2, 0, 3) AS a, make_interval(0, 0, 0, 0, 4, 5, 6.5) AS b, " +
      "make_interval(days => 10, hours => 2) AS c, make_interval(weeks => 3) AS d",
  },
  {
    id: "DAT-fmt-01",
    kind: "parity",
    sql:
      "SELECT to_char(date '2024-03-15', 'YYYY-MM-DD') AS iso, to_char(date '2024-03-15', 'Month Day') AS names, " +
      "to_char(date '2024-03-15', 'Mon Dy') AS abbrev, to_char(timestamp '2024-03-15 13:05:09', 'HH24:MI:SS') AS t24, " +
      "to_char(timestamp '2024-03-15 13:05:09', 'HH12:MI AM') AS t12, to_char(date '2024-08-15', 'YYYY \"Q\"Q') AS quarter",
  },
  {
    id: "DAT-fmt-02",
    kind: "parity",
    sql: "SELECT to_char(interval '15 hours 2 minutes 12 seconds', 'HH24:MI:SS') AS v",
  },
  { id: "DAT-fmt-03", kind: "parity", sql: "SELECT to_date('15 Mar 2024', 'DD Mon YYYY') AS v" },
  {
    id: "DAT-ovl-01",
    kind: "parity",
    sql:
      "SELECT (date '2024-01-01', date '2024-01-31') OVERLAPS (date '2024-01-15', date '2024-02-15') AS yes, " +
      "(date '2024-01-01', date '2024-01-10') OVERLAPS (date '2024-01-10', date '2024-01-20') AS touch",
  },
  {
    id: "DAT-fin-01",
    kind: "parity",
    sql:
      "SELECT isfinite(date '2024-01-01') AS d, isfinite('infinity'::date) AS di, " +
      "isfinite(timestamp '2024-01-01') AS ts, isfinite('infinity'::timestamp) AS tsi, isfinite(interval '1 day') AS iv",
  },
  {
    id: "DAT-edge-01",
    kind: "parity",
    sql:
      "SELECT make_date(1, 1, 1) AS y1, '0001-01-01'::date AS lit, extract(year FROM '0001-01-01'::date) AS ex, " +
      "'1999-12-31'::date AS c1, '2000-01-01'::date AS c2",
  },
  {
    id: "DAT-ord-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (d date, iv interval)",
      "INSERT INTO t VALUES ('2024-03-01', '2 hours'), ('2023-12-31', '1 day'), ('2024-01-15', '-1 hour')",
    ],
    sql: "SELECT d, iv FROM t ORDER BY d",
  },
  {
    id: "DAT-now-01",
    kind: "divergence",
    fn: (db) => {
      expect(db.query("SELECT now()::text AS v")).toEqual([{ v: "2000-01-01 00:00:00+00" }]);
      expect(db.query("SELECT current_date::text AS v")).toEqual([{ v: "2000-01-01" }]);
      expect(db.query("SELECT current_timestamp::text AS v")).toEqual([{ v: "2000-01-01 00:00:00+00" }]);
      expect(db.query("SELECT localtimestamp::text AS v")).toEqual([{ v: "2000-01-01 00:00:00" }]);
    },
  },
  {
    id: "DAT-err-01",
    kind: "error",
    sql: "SELECT '2024-13-01'::date",
    query: true,
    messageTier: "A",
  },
  {
    id: "DAT-err-02",
    kind: "error",
    sql: "SELECT 'notadate'::date",
    query: true,
    messageTier: "A",
  },
  {
    id: "DAT-err-03",
    kind: "error",
    sql: "SELECT '25:00:00'::time",
    query: true,
    messageTier: "A",
  },
  {
    id: "DAT-err-04",
    kind: "error",
    sql: "SELECT 'bogus'::interval",
    query: true,
    messageTier: "A",
  },
]);
