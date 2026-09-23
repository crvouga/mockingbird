import { parity } from "../helpers.ts";

parity(
  "recursive counter to ten",
  [],
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 10) SELECT n FROM c ORDER BY n",
);
parity(
  "recursive sum of series",
  [],
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 100) SELECT sum(n) AS total FROM c",
);
parity(
  "recursive with step expression",
  [],
  "WITH RECURSIVE c(n) AS (SELECT 0 UNION ALL SELECT n + 5 FROM c WHERE n < 25) SELECT n FROM c ORDER BY n",
);
parity(
  "recursive doubling",
  [],
  "WITH RECURSIVE p(n) AS (SELECT 1 UNION ALL SELECT n * 2 FROM p WHERE n < 100) SELECT n FROM p ORDER BY n",
);
parity(
  "recursive text accumulation",
  [],
  "WITH RECURSIVE w(s, n) AS (SELECT 'x'::text, 1 UNION ALL SELECT s || 'x', n + 1 FROM w WHERE n < 5) SELECT s, n FROM w ORDER BY n",
);
parity("recursive keyword with non-recursive body", [], "WITH RECURSIVE s AS (SELECT 42 AS v) SELECT v FROM s");
parity(
  "recursive fibonacci pairs",
  [],
  "WITH RECURSIVE fib(a, b) AS (SELECT 0, 1 UNION ALL SELECT b, a + b FROM fib WHERE b < 100) SELECT a FROM fib ORDER BY a",
);
parity(
  "recursive base from table",
  ["CREATE TABLE seeds (n int)", "INSERT INTO seeds VALUES (1), (100)"],
  "WITH RECURSIVE c(n) AS (SELECT n FROM seeds UNION ALL SELECT n + 1 FROM c WHERE n % 100 < 3) SELECT n FROM c ORDER BY n",
);
parity(
  "recursive empty base case",
  ["CREATE TABLE seeds (n int)"],
  "WITH RECURSIVE c(n) AS (SELECT n FROM seeds UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT n FROM c ORDER BY n",
);
parity(
  "recursive joined with outer table",
  ["CREATE TABLE labels (n int, name text)", "INSERT INTO labels VALUES (1, 'one'), (3, 'three')"],
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 4) SELECT c.n, l.name FROM c LEFT JOIN labels l ON l.n = c.n ORDER BY c.n",
);
