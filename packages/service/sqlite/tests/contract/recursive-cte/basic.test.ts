import { parity } from "../helpers.ts";

parity(
  "recursive CTE generates integer sequence",
  [],
  "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5) SELECT x FROM n",
);
parity(
  "recursive CTE computes factorials",
  [],
  "WITH RECURSIVE f(n,v) AS (VALUES(1,1) UNION ALL SELECT n+1,v*(n+1) FROM f WHERE n<5) SELECT * FROM f",
);
parity(
  "recursive CTE walks parent chain",
  ["CREATE TABLE nodes(id INTEGER,parent INTEGER)", "INSERT INTO nodes VALUES (1,NULL),(2,1),(3,2),(4,2)"],
  "WITH RECURSIVE tree(id) AS (VALUES(1) UNION ALL SELECT nodes.id FROM nodes JOIN tree ON nodes.parent=tree.id) SELECT id FROM tree ORDER BY id",
);
parity(
  "recursive CTE supports two recursive columns",
  [],
  "WITH RECURSIVE fib(n,a,b) AS (VALUES(0,0,1) UNION ALL SELECT n+1,b,a+b FROM fib WHERE n<6) SELECT n,a FROM fib",
);
