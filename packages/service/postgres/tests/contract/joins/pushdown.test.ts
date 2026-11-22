import { errorParity, parity } from "../helpers.ts";

// #897: conjuncts that read one side of a join (plus outer columns, parameters or constants) filter
// that side before rows are paired. Every shape below must answer exactly what PostgreSQL does,
// in particular across the null-extended side of outer joins.

const setup = [
  "CREATE TABLE l (id int, k text, v int)",
  "CREATE TABLE r (id int, k text, w int)",
  "INSERT INTO l VALUES (1, 'a', 10), (2, 'b', NULL), (3, NULL, 30), (4, 'd', 40)",
  "INSERT INTO r VALUES (1, 'a', 100), (2, 'x', 200), (2, 'b', NULL), (5, 'e', 500), (NULL, 'a', 600)",
];

parity(
  "inner join: single-side ON conjuncts with a non-equi pairing",
  setup,
  "SELECT l.id, r.id AS rid FROM l JOIN r ON r.w > 150 AND l.v >= 30 AND l.id < coalesce(r.id, 9) ORDER BY 1, 2 NULLS LAST",
);
parity(
  "left join: right-only ON conjunct keeps unmatched left rows",
  setup,
  "SELECT l.id, r.w FROM l LEFT JOIN r ON r.w > 150 AND l.id <= r.id ORDER BY 1, 2 NULLS LAST",
);
parity(
  "left join: left-only ON conjunct never removes left rows",
  setup,
  "SELECT l.id, r.id AS rid FROM l LEFT JOIN r ON l.v > 15 AND l.id < r.w ORDER BY 1, 2 NULLS LAST",
);
parity(
  "left join: WHERE on the null-extended side is applied after the join",
  setup,
  "SELECT l.id, r.w FROM l LEFT JOIN r ON l.id < r.id AND r.w > 400 WHERE r.w IS NULL ORDER BY 1",
);
parity(
  "left join: WHERE on the preserved side",
  setup,
  "SELECT l.id, r.w FROM l LEFT JOIN r ON l.id < r.id WHERE l.k IS NOT NULL AND l.v IS NULL ORDER BY 1, 2 NULLS LAST",
);
parity(
  "right join: left-only ON conjunct and right-only WHERE",
  setup,
  "SELECT l.id, r.id AS rid, r.w FROM l RIGHT JOIN r ON l.v > 15 AND l.id < r.w WHERE r.w <> 200 ORDER BY 3, 1 NULLS LAST",
);
parity(
  "right join: WHERE on the null-extended left side",
  setup,
  "SELECT l.id, r.w FROM l RIGHT JOIN r ON l.id > r.id AND l.v > 0 WHERE l.id IS NULL ORDER BY 2",
);
parity(
  "full join with single-side ON conjuncts",
  setup,
  "SELECT l.id, r.id AS rid FROM l FULL JOIN r ON l.id = r.id AND r.w > 150 AND l.v IS NOT NULL ORDER BY 1 NULLS LAST, 2 NULLS LAST",
);
parity(
  "cross join and comma list filtered by single-item WHERE conjuncts",
  setup,
  "SELECT l.id, r.id AS rid FROM l CROSS JOIN r, (VALUES (1), (2)) AS t(n) WHERE l.k = 'a' AND r.w >= 500 AND t.n = 2 ORDER BY 1, 2 NULLS LAST",
);
parity(
  "nested joins with NULL keys and three-valued predicates",
  setup,
  `SELECT a.id, b.id AS bid, c.id AS cid FROM l a JOIN r b ON b.k = 'a' AND a.v < b.w
     LEFT JOIN l c ON c.k IS NULL AND c.v < b.w WHERE NOT (a.k = 'zz') ORDER BY 1, 2 NULLS LAST, 3 NULLS LAST`,
);
parity(
  "correlated EXISTS over a join whose ON reads the outer row",
  setup,
  `SELECT l.id, EXISTS (SELECT 1 FROM r JOIN l l2 ON l2.id = l.id AND l2.k IS NOT NULL
     WHERE r.k = l2.k AND r.w > 0) AS e FROM l ORDER BY 1`,
);
parity(
  "correlated EXISTS over a join with no outer rows",
  setup,
  `SELECT l.id, EXISTS (SELECT 1 FROM r JOIN l l2 ON l2.id = l.id WHERE r.k = l2.k) AS e
     FROM l WHERE l.id > 100`,
);
parity(
  "unqualified columns that resolve in one side only",
  setup,
  "SELECT l.id, rid2 FROM l JOIN (SELECT id AS rid2, w FROM r) r ON w > 150 AND l.id < rid2 ORDER BY 1, 2",
);
errorParity(
  "a failing single-side conjunct still fails",
  setup,
  "SELECT l.id FROM l JOIN r ON (r.k)::int > 0 AND l.id < r.id",
);
errorParity(
  "a broken EXISTS in the select list fails even with no outer rows",
  setup,
  "SELECT l.id, EXISTS (SELECT 1 FROM r JOIN nope ON true WHERE r.id = l.id) FROM l WHERE false",
);
errorParity(
  "a mistyped EXISTS WHERE fails even with no outer rows",
  setup,
  "SELECT l.id, EXISTS (SELECT 1 FROM r WHERE r.k) FROM l WHERE false",
);
