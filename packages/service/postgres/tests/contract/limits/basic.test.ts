import { parity } from "../helpers.ts";

const t = ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10)"];

parity("limit smaller than rowcount", t, "SELECT id FROM t ORDER BY id LIMIT 3");
parity("limit equal to rowcount", t, "SELECT id FROM t ORDER BY id LIMIT 10");
parity("limit larger than rowcount", t, "SELECT id FROM t ORDER BY id LIMIT 100");
parity("limit zero", t, "SELECT id FROM t ORDER BY id LIMIT 0");
parity("offset only", t, "SELECT id FROM t ORDER BY id OFFSET 7");
parity("offset zero", t, "SELECT id FROM t ORDER BY id OFFSET 0");
parity("offset beyond rowcount", t, "SELECT id FROM t ORDER BY id OFFSET 50");
parity("limit with offset", t, "SELECT id FROM t ORDER BY id LIMIT 3 OFFSET 4");
parity("offset before limit keyword order", t, "SELECT id FROM t ORDER BY id OFFSET 4 LIMIT 3");
parity("limit all", t, "SELECT id FROM t ORDER BY id LIMIT ALL");
parity("limit all with offset", t, "SELECT id FROM t ORDER BY id LIMIT ALL OFFSET 8");
parity("limit null means no limit", t, "SELECT id FROM t ORDER BY id LIMIT NULL");
parity("limit expression", t, "SELECT id FROM t ORDER BY id LIMIT 2 + 1");
parity("limit on desc order", t, "SELECT id FROM t ORDER BY id DESC LIMIT 2");
parity("limit without order by row count only", t, "SELECT count(*) AS n FROM (SELECT id FROM t LIMIT 4) s");
parity("limit in subquery", t, "SELECT max(id) AS mx FROM (SELECT id FROM t ORDER BY id LIMIT 5) s");
parity("limit param", t, "SELECT id FROM t ORDER BY id LIMIT $1", [2]);
