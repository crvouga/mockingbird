import { parity } from "../helpers.ts";

parity("ordinary comparisons with NULL are unknown", [], "SELECT NULL= NULL AS eq,NULL<>NULL AS ne,1=NULL AS one");
parity("IS and IS NOT compare NULL values", [], "SELECT NULL IS NULL AS a,NULL IS NOT NULL AS b,1 IS NOT NULL AS c");
parity(
  "IS NULL filters rows",
  ["CREATE TABLE t(id INTEGER,v INTEGER)", "INSERT INTO t VALUES (1,NULL),(2,0),(3,NULL)"],
  "SELECT id FROM t WHERE v IS NULL ORDER BY id",
);
parity("arithmetic propagates NULL", [], "SELECT NULL+1 AS a,4*NULL AS b,NULL/2 AS c,-NULL AS d");
parity(
  "three-valued boolean logic follows SQLite",
  [],
  "SELECT NULL AND 0 AS a,NULL AND 1 AS b,NULL OR 0 AS c,NULL OR 1 AS d,NOT NULL AS e",
);
