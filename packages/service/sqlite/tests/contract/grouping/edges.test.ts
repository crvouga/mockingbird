import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE t(category TEXT,v INTEGER)",
  "INSERT INTO t VALUES ('a',1),('a',2),('b',5),('b',NULL),('c',1)",
];
parity(
  "GROUP BY positional expression uses first result column",
  data,
  "SELECT category,count(*) n FROM t GROUP BY 1 ORDER BY 1",
);
parity(
  "GROUP BY positional computed expression",
  data,
  "SELECT v/2 bucket,count(*) n FROM t WHERE v IS NOT NULL GROUP BY 1 ORDER BY 1",
);
parity(
  "HAVING can use aggregate absent from SELECT",
  data,
  "SELECT category FROM t GROUP BY category HAVING sum(v)>2 ORDER BY category",
);
parity(
  "HAVING combines grouping key and hidden aggregate",
  data,
  "SELECT category FROM t GROUP BY category HAVING category<>'c' AND count(*)>1 ORDER BY category",
);
parity("HAVING without GROUP BY filters the aggregate group", data, "SELECT count(*) n FROM t HAVING sum(v)>0");
