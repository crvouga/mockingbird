import { parity } from "../helpers.ts";

const table = ["CREATE TABLE t(a TEXT,b TEXT,value INTEGER,UNIQUE(a,b))", "INSERT INTO t VALUES ('x','y',1)"];
parity(
  "composite conflict target updates matching tuple",
  [...table, "INSERT INTO t VALUES ('x','y',9) ON CONFLICT(a,b) DO UPDATE SET value=excluded.value"],
  "SELECT * FROM t",
);
parity(
  "composite conflict target inserts a different tuple",
  [...table, "INSERT INTO t VALUES ('x','z',9) ON CONFLICT(a,b) DO UPDATE SET value=excluded.value"],
  "SELECT * FROM t ORDER BY b",
);
parity(
  "excluded values update multiple columns",
  [...table, "INSERT INTO t VALUES ('x','y',4) ON CONFLICT(a,b) DO UPDATE SET value=excluded.value+1,b=excluded.b"],
  "SELECT * FROM t",
);
parity(
  "DO UPDATE combines current and excluded values",
  [...table, "INSERT INTO t VALUES ('x','y',4) ON CONFLICT(a,b) DO UPDATE SET value=t.value+excluded.value"],
  "SELECT * FROM t",
);
parity(
  "composite DO NOTHING preserves conflicting row",
  [...table, "INSERT INTO t VALUES ('x','y',8) ON CONFLICT(a,b) DO NOTHING"],
  "SELECT * FROM t",
);
