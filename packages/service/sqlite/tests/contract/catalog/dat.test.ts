import { expect } from "bun:test";
import { Database } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog("DAT", [
  { id: "DAT-fn-01", kind: "parity", sql: "SELECT date('2001-01-31')" },
  { id: "DAT-fn-02", kind: "parity", sql: "SELECT time('2001-01-31 12:30:45')" },
  { id: "DAT-fn-03", kind: "parity", sql: "SELECT datetime('2001-01-31 12:30:45')" },
  { id: "DAT-fn-04", kind: "parity", sql: "SELECT julianday('2000-01-01')" },
  { id: "DAT-fn-05", kind: "parity", sql: "SELECT unixepoch('2000-01-01')" },
  { id: "DAT-fn-06", kind: "parity", sql: "SELECT unixepoch('2000-01-01')" },
  { id: "DAT-fn-07", kind: "parity", sql: "SELECT timediff('2000-01-02','2000-01-01')" },
  { id: "DAT-strftime-01", kind: "parity", sql: "SELECT strftime('%Y-%m-%d %H:%M:%S','2000-01-02 03:04:05')" },
  { id: "DAT-strftime-02", kind: "parity", sql: "SELECT strftime('%Y','2000-01-02')" },
  { id: "DAT-strftime-03", kind: "parity", sql: "SELECT strftime('%d','2000-01-01')" },
  { id: "DAT-in-01", kind: "parity", sql: "SELECT date('2001-12-31')" },
  { id: "DAT-in-02", kind: "parity", sql: "SELECT datetime('2001-12-31T12:00:00')" },
  { id: "DAT-in-03", kind: "parity", sql: "SELECT datetime('2001-12-31 12:00:00.5')" },
  { id: "DAT-in-04", kind: "parity", sql: "SELECT date('2000-01-01')" },
  { id: "DAT-in-05", kind: "parity", sql: "SELECT date(2451545.0)" },
  { id: "DAT-in-06", kind: "parity", sql: "SELECT datetime(946684800, 'unixepoch')" },
  { id: "DAT-in-07", kind: "parity", sql: "SELECT date('not-a-date')" },
  { id: "DAT-in-08", kind: "parity", sql: "SELECT date('9999-12-31')" },
  { id: "DAT-mod-01", kind: "parity", sql: "SELECT datetime('2000-01-01','+2 days','+3 hours','+4 minutes')" },
  { id: "DAT-mod-02", kind: "parity", sql: "SELECT date('2000-01-01','+1 month','+1 year')" },
  { id: "DAT-mod-03", kind: "parity", sql: "SELECT datetime('2000-01-01','+1.5 seconds')" },
  { id: "DAT-mod-04", kind: "parity", sql: "SELECT datetime('2000-01-01','+2 hours')" },
  {
    id: "DAT-mod-05",
    kind: "parity",
    sql: "SELECT date('2000-05-15','start of month'), date('2000-05-15','start of year')",
  },
  { id: "DAT-mod-06", kind: "parity", sql: "SELECT date('2000-01-01','+1 day')" },
  { id: "DAT-mod-07", kind: "parity", sql: "SELECT datetime(946684800, 'unixepoch')" },
  { id: "DAT-mod-08", kind: "parity", sql: "SELECT datetime('2000-01-01')" },
  { id: "DAT-mod-09", kind: "parity", sql: "SELECT datetime('2000-01-01 00:00:00')" },
  { id: "DAT-mod-10", kind: "parity", sql: "SELECT date('2000-01-01','not-a-modifier')" },
  { id: "DAT-cal-01", kind: "parity", sql: "SELECT date('2001-01-31','+1 month')" },
  { id: "DAT-cal-02", kind: "parity", sql: "SELECT date('2000-02-29')" },
  { id: "DAT-cal-03", kind: "parity", sql: "SELECT date('1900-02-29')" },
  { id: "DAT-cal-04", kind: "parity", sql: "SELECT date('0000-01-01'), date('9999-12-31')" },
  {
    id: "DAT-now-01",
    kind: "divergence",
    fn: (db) => expect(db.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe("2000-01-01"),
  },
  { id: "DAT-now-02", kind: "parity", sql: "SELECT date('2000-01-01')" },
  {
    id: "DAT-now-03",
    kind: "parity",
    setup: ["CREATE TABLE t(id INTEGER PRIMARY KEY, ts TEXT DEFAULT 'x')", "INSERT INTO t(id) VALUES (1)"],
    sql: "SELECT ts FROM t",
  },
  {
    id: "DAT-now-04",
    kind: "divergence",
    fn: () => {
      const live = new Database({ now: "system" });
      expect(live.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe(new Date().toISOString().slice(0, 10));
      live.close();
    },
  },
  {
    id: "DAT-now-05",
    kind: "divergence",
    fn: (db) => {
      expect(db.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe("2000-01-01");
    },
  },
  {
    id: "DAT-now-06",
    kind: "divergence",
    fn: (db) => {
      const opened = db.snapshot().open();
      expect(opened.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe("2000-01-01");
      opened.close();
    },
  },
]);
