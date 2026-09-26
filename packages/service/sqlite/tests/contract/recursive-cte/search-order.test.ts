import { parity } from "../helpers.ts";

parity(
  "recursive CTE LIMIT caps the work queue",
  [],
  "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n LIMIT 5) SELECT x FROM n",
);

parity(
  "recursive CTE ORDER BY controls queue extraction order",
  [],
  "WITH RECURSIVE tree(x) AS (VALUES(1) UNION ALL SELECT x*2+d FROM tree,(SELECT 0 AS d UNION ALL SELECT 1) AS digits WHERE x<4 ORDER BY 1 DESC LIMIT 7) SELECT x FROM tree",
);
