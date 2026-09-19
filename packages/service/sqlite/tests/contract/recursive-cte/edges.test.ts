import { parity } from "../helpers.ts";

parity(
  "recursive UNION deduplicates cycles",
  [],
  "WITH RECURSIVE cycle(x) AS (VALUES(1) UNION SELECT CASE x WHEN 1 THEN 2 ELSE 1 END FROM cycle) SELECT x FROM cycle ORDER BY x",
);

parity(
  "recursive CTE supports more than 1000 steps",
  [],
  "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1100) SELECT count(*) AS row_count,max(x) AS max_x FROM n",
);
