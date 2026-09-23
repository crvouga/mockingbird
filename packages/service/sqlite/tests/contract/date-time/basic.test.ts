import { parity } from "../helpers.ts";

parity(
  "date extracts and modifies fixed date",
  [],
  "SELECT date('2024-02-29') a,date('2024-01-31','+1 day') b,date('2024-06-15','start of month') c",
);
parity("time normalizes fixed timestamps", [], "SELECT time('2024-01-02 03:04:05') a,time('12:30:00','+90 minutes') b");
parity(
  "datetime applies deterministic modifiers",
  [],
  "SELECT datetime('2020-01-01 00:00:00','+1 day','+2 hours') a,datetime(0,'unixepoch') b",
);
parity(
  "strftime formats fixed timestamp fields",
  [],
  "SELECT strftime('%Y-%m-%d','1999-12-31 23:59:58') a,strftime('%H:%M:%S','1999-12-31 23:59:58') b",
);
