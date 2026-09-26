import { parity } from "../helpers.ts";

const data = ["CREATE TABLE counters(key TEXT PRIMARY KEY,value INTEGER)", "INSERT INTO counters VALUES ('a',1)"];

parity(
  "upsert DO UPDATE changes conflicting row",
  [...data, "INSERT INTO counters VALUES ('a',5) ON CONFLICT(key) DO UPDATE SET value=excluded.value"],
  "SELECT * FROM counters",
);
parity(
  "upsert update can reference current and excluded values",
  [...data, "INSERT INTO counters VALUES ('a',5) ON CONFLICT(key) DO UPDATE SET value=counters.value+excluded.value"],
  "SELECT * FROM counters",
);
parity(
  "upsert DO NOTHING preserves conflicting row",
  [...data, "INSERT INTO counters VALUES ('a',9) ON CONFLICT(key) DO NOTHING"],
  "SELECT * FROM counters",
);
parity(
  "upsert inserts when no conflict occurs",
  [...data, "INSERT INTO counters VALUES ('b',2) ON CONFLICT(key) DO UPDATE SET value=excluded.value"],
  "SELECT * FROM counters ORDER BY key",
);
