import { parity } from "../helpers.ts";

const scores = [
  "CREATE TABLE s (id int, grp text, score int)",
  "INSERT INTO s VALUES (1, 'a', 10), (2, 'a', 20), (3, 'a', 20), (4, 'b', 5), (5, 'b', 15), (6, 'b', 15), (7, 'b', 30)",
];

parity("row_number over order", scores, "SELECT id, row_number() OVER (ORDER BY id) AS rn FROM s ORDER BY id");
parity(
  "row_number partitioned",
  scores,
  "SELECT id, grp, row_number() OVER (PARTITION BY grp ORDER BY id) AS rn FROM s ORDER BY id",
);
parity("rank with ties", scores, "SELECT id, rank() OVER (ORDER BY score, id) AS r FROM s ORDER BY id");
parity(
  "rank gaps after ties",
  scores,
  "SELECT id, rank() OVER (PARTITION BY grp ORDER BY score) AS r FROM s ORDER BY id",
);
parity(
  "dense_rank no gaps",
  scores,
  "SELECT id, dense_rank() OVER (PARTITION BY grp ORDER BY score) AS dr FROM s ORDER BY id",
);
parity(
  "percent_rank",
  scores,
  "SELECT id, percent_rank() OVER (PARTITION BY grp ORDER BY score) AS pr FROM s ORDER BY id",
);
parity("cume_dist", scores, "SELECT id, cume_dist() OVER (PARTITION BY grp ORDER BY score) AS cd FROM s ORDER BY id");
parity("ntile buckets", scores, "SELECT id, ntile(3) OVER (ORDER BY id) AS bucket FROM s ORDER BY id");
parity(
  "ntile uneven buckets",
  scores,
  "SELECT id, ntile(2) OVER (PARTITION BY grp ORDER BY score, id) AS bucket FROM s ORDER BY id",
);
parity(
  "row_number desc ordering",
  scores,
  "SELECT id, row_number() OVER (ORDER BY score DESC, id DESC) AS rn FROM s ORDER BY id",
);
parity("rank over empty over clause", scores, "SELECT id, rank() OVER () AS r FROM s ORDER BY id");
parity(
  "multiple window functions in one select",
  scores,
  "SELECT id, row_number() OVER (ORDER BY id) AS rn, rank() OVER (ORDER BY score, id) AS r, dense_rank() OVER (ORDER BY score) AS dr FROM s ORDER BY id",
);
parity(
  "window with where filtering first",
  scores,
  "SELECT id, row_number() OVER (ORDER BY id) AS rn FROM s WHERE score > 10 ORDER BY id",
);
parity(
  "window function in subquery filtered outside",
  scores,
  "SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY grp ORDER BY score DESC, id) AS rn FROM s) x WHERE rn = 1 ORDER BY id",
);
