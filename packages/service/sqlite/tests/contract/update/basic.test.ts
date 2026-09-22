import { parity, sequenceParity } from "../helpers.ts";

const data = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY, value INTEGER, label TEXT)",
  "INSERT INTO t VALUES (1,10,'a'),(2,20,'b'),(3,30,'c')",
];

sequenceParity("update selected rows", data, [
  { sql: "UPDATE t SET value=value+5 WHERE id>=2" },
  { sql: "SELECT * FROM t ORDER BY id", query: true },
]);
parity(
  "update can assign multiple columns",
  [...data, "UPDATE t SET value=99,label='changed' WHERE id=1"],
  "SELECT * FROM t ORDER BY id",
);
parity(
  "update expression uses old row values",
  [...data, "UPDATE t SET value=value*2,label=label||value"],
  "SELECT * FROM t ORDER BY id",
);
parity(
  "update matching no rows leaves data unchanged",
  [...data, "UPDATE t SET value=0 WHERE id=99"],
  "SELECT * FROM t ORDER BY id",
);
