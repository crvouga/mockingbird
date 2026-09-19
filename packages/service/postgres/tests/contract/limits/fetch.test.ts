import { parity } from "../helpers.ts";

const t = [
  "CREATE TABLE t (id int, score int)",
  "INSERT INTO t VALUES (1, 10), (2, 20), (3, 20), (4, 30), (5, 30), (6, 40)",
];

parity("fetch first n rows only", t, "SELECT id FROM t ORDER BY id FETCH FIRST 3 ROWS ONLY");
parity("fetch first row only singular", t, "SELECT id FROM t ORDER BY id FETCH FIRST ROW ONLY");
parity("fetch next n rows only", t, "SELECT id FROM t ORDER BY id FETCH NEXT 2 ROWS ONLY");
parity("offset with fetch", t, "SELECT id FROM t ORDER BY id OFFSET 2 ROWS FETCH FIRST 2 ROWS ONLY");
parity("offset n rows keyword", t, "SELECT id FROM t ORDER BY id OFFSET 3 ROWS");
parity(
  "fetch first with ties includes tied rows",
  t,
  "SELECT score FROM t ORDER BY score FETCH FIRST 2 ROWS WITH TIES",
);
parity("fetch first with ties no tie at boundary", t, "SELECT score FROM t ORDER BY score FETCH FIRST 1 ROW WITH TIES");
parity("fetch with ties on desc", t, "SELECT score FROM t ORDER BY score DESC FETCH FIRST 3 ROWS WITH TIES");
parity(
  "with ties everything tied",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (7), (7), (7)"],
  "SELECT v FROM s ORDER BY v FETCH FIRST 1 ROW WITH TIES",
);
parity("fetch zero rows", t, "SELECT id FROM t ORDER BY id FETCH FIRST 0 ROWS ONLY");
parity("fetch larger than rowcount", t, "SELECT id FROM t ORDER BY id FETCH FIRST 99 ROWS ONLY");
parity("fetch first defaults to one", t, "SELECT id FROM t ORDER BY id FETCH FIRST ROWS ONLY");
