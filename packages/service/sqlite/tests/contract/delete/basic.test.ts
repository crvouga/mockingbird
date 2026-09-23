import { parity, sequenceParity } from "../helpers.ts";

const data = ["CREATE TABLE t(id INTEGER, value TEXT)", "INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d')"];

sequenceParity("delete selected rows", data, [
  { sql: "DELETE FROM t WHERE id%2=0" },
  { sql: "SELECT * FROM t ORDER BY id", query: true },
]);
parity("delete matching no rows", [...data, "DELETE FROM t WHERE id=99"], "SELECT * FROM t ORDER BY id");
parity("delete all rows without WHERE", [...data, "DELETE FROM t"], "SELECT count(*) AS n FROM t");
parity(
  "delete predicate observes NULL",
  [...data, "INSERT INTO t VALUES (NULL,'n')", "DELETE FROM t WHERE id IS NULL"],
  "SELECT * FROM t ORDER BY id",
);
